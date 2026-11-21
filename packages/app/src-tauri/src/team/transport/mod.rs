//! How team messages travel. Each transport hides its own wire behind one trait, so the rest of
//! `team/` never knows which one is in use:
//! - [`folder::FolderTransport`]: a shared folder (demo, tests, a synced or network folder);
//! - [`relay::RelayTransport`]: a relay server (`relay/` at the top of the repository) over
//!   WebSocket, with a long-poll fallback;
//! - later, iroh peers (v2).
//!
//! A transport carries **sealed, signed envelopes** and two signed state slots, never plain
//! events: `secure::Session` seals before `send` and opens (checking signatures) after
//! `subscribe`, so a transport is only a pipe and cannot make a card by itself.
//!
//! Contract every transport keeps:
//! - **Outbound only from this app's point of view.** A transport may open connections or watch
//!   files; it never adds a route to the bridge and never listens for callers (plan §8.3). Team
//!   traffic never uses the bridge or device pairing.
//! - `send` returns once the envelope is handed off durably (written, or accepted by the relay).
//! - `subscribe` yields envelopes in no promised order, possibly more than once (the session's
//!   replay guard drops repeats). They are UNTRUSTED until `Session::open` accepts them.
//! - Our own envelopes may come back on `subscribe`; the session recognises them.

pub mod folder;
pub mod relay;

use pm_relay_protocol::{Envelope, JoinBox, SignedAcl, SignedBlob, TeamRegistration};
use std::sync::mpsc::Receiver;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError(pub String);

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What the relay link is doing right now, for the Team page. Words only: no address beyond the host, no raw error text.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDetail {
    /// The relay's host name (never a user name, path or query), when there is one.
    pub host: Option<String>,
    /// `socket` (opening the live connection), `poll` (asking for news), `waiting` (before the next try), `idle`.
    pub step: &'static str,
    /// A try is going on this second (the only time the page may spin).
    pub attempting: bool,
    /// Why the last try failed: `dns`, `refused`, `timeout`, `tls`, `refused_by_relay` (403), `unknown_team` (404), `relay_gone` (404 with nothing there), `signature` (401),
    /// `busy` (429, 507), `down` (5xx), `unreadable`, `other`. None when it did not fail.
    pub problem: Option<&'static str>,
    /// Seconds until the next try, while waiting.
    pub retry_in_s: Option<u64>,
}

/// How the relay's own answers start (`relay.rs relay_error` writes them from the HTTP status, so a status and its kind cannot drift apart).
/// 404 with Cloudflare's "no Worker here" (error code 1042), or a 404 on the health path: the address has no relay any more.
pub const RELAY_GONE: &str = "The relay this team was saved on is gone.";
pub const UNKNOWN_TEAM: &str = "The relay doesn't know this team.";
pub const BAD_SIGNATURE: &str = "The relay refused this computer's signature";
pub const SLOW_DOWN: &str = "The relay asks to slow down.";
pub const MAILBOX_FULL: &str = "The team's mailbox on the relay is full.";
pub const TROUBLE: &str = "The relay is having trouble";

/// A plain kind for a failed relay call (see [`LinkDetail::problem`]). The relay's answers are told apart by the status they were
/// made from; only a failure to connect at all is read from the connection error's words.
pub fn problem_kind(error: &TransportError) -> &'static str {
    let text = error.0.to_lowercase();
    if error.is_denied() {
        // 403: the relay knows the team, and this device is not on its access list.
        "refused_by_relay"
    } else if error.0.starts_with(RELAY_GONE) {
        // 404 from Cloudflare (nothing is deployed at this address) or from the health path: no retry can ever fix it.
        "relay_gone"
    } else if error.0.starts_with(UNKNOWN_TEAM) {
        // 404: this relay has no such team (it was reset or re-deployed, or the saved address is another relay).
        "unknown_team"
    } else if error.0.starts_with(BAD_SIGNATURE) {
        // 401: the signed request was not accepted (this computer's clock is minutes off, or its key changed).
        "signature"
    } else if error.0.starts_with(SLOW_DOWN) || error.0.starts_with(MAILBOX_FULL) {
        "busy"
    } else if error.0.starts_with(TROUBLE) {
        "down"
    } else if text.contains("dns") || text.contains("resolve") || text.contains("lookup") || text.contains("no such host") {
        "dns"
    } else if text.contains("timed out") || text.contains("timeout") {
        "timeout"
    } else if text.contains("tls") || text.contains("certificate") || text.contains("handshake") {
        "tls"
    } else if text.contains("refused") || text.contains("connection failed") || text.contains("unreachable") || text.contains("can't reach") {
        "refused"
    } else if text.contains("unreadable") {
        "unreadable"
    } else {
        "other"
    }
}

/// How a refusal by the relay's access list starts ([`TransportError::is_denied`]).
pub const DENIED: &str = "The relay doesn't let this computer in";

impl TransportError {
    pub fn new(text: impl Into<String>) -> Self {
        Self(text.into())
    }

    /// The relay refused this device: it is not (or no longer) on the team's access list.
    pub fn is_denied(&self) -> bool {
        self.0.starts_with(DENIED)
    }
}

/// One envelope as a transport received it (not checked yet).
#[derive(Debug, Clone)]
pub struct Inbound {
    pub envelope: Envelope,
    pub received_at_ms: u64,
    /// The relay's mailbox position after this envelope (0 for the folder).
    pub cursor: u64,
    /// The relay's counter went back (a restored or replaced relay): `cursor` replaces the saved
    /// cursor even though it is lower. Envelopes seen before are dropped by the replay guard.
    pub reset: bool,
}


/// The error text of [`TeamTransport::publish_invite_link`] when the relay is an older deploy.
pub const UPDATE_WORKER: &str = "update-worker";

/// What an invite link keeps on the Worker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InviteLinkRequest {
    /// Opaque to the Worker: the invite link and its code, as JSON text.
    pub payload: String,
    pub team_name: String,
    pub inviter: String,
    /// How long it should live; the Worker caps it at 24 hours.
    pub ttl_ms: u64,
}

/// A link the Worker made: where the page is, and when it stops working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteLinkMade {
    pub url: String,
    pub expires_at_ms: u64,
}

pub trait TeamTransport: Send + Sync {
    /// Short name for logs and Settings: `folder` or `relay`.
    fn kind(&self) -> &'static str;
    /// Hand one sealed envelope to the team.
    fn send(&self, envelope: &Envelope) -> Result<(), TransportError>;
    /// Start receiving envelopes after mailbox position `after`. The channel closes when the
    /// transport stops.
    fn subscribe(&self, after: u64) -> Result<Receiver<Inbound>, TransportError>;
    /// Write a signed state slot (`roster`, `keys`). The admin's app only.
    fn put_state(&self, blob: &SignedBlob) -> Result<(), TransportError>;
    /// Read a state slot. `Ok(None)` when there is none yet.
    fn get_state(&self, slot: &str) -> Result<Option<SignedBlob>, TransportError>;
    /// Post a sealed join request (anyone with an invite link).
    fn post_join(&self, join: &JoinBox) -> Result<(), TransportError>;
    /// Join requests waiting for the admin.
    fn joins(&self) -> Result<Vec<JoinBox>, TransportError>;
    /// Relay only: make the team known to the relay.
    fn register(&self, _registration: &TeamRegistration) -> Result<(), TransportError> {
        Ok(())
    }
    /// Relay only: which devices may use the mailbox.
    fn set_acl(&self, _acl: &SignedAcl) -> Result<(), TransportError> {
        Ok(())
    }
    /// Relay only: leave an invite on the Potato Worker and get a one-time link for it (`/join/<code>`).
    /// `Ok(None)` when this transport has no such thing (a shared folder). An error with
    /// [`UPDATE_WORKER`] means the relay is an older deploy that cannot do it.
    fn publish_invite_link(&self, _request: &InviteLinkRequest) -> Result<Option<InviteLinkMade>, TransportError> {
        Ok(None)
    }
    /// How messages arrive right now, for Settings ("live", "polling", "connecting" before the first connect or poll finishes, "denied" when the
    /// relay turned this device away, "offline" when it cannot be reached).
    fn status(&self) -> &'static str {
        "live"
    }
    /// What the link is doing now (see [`LinkDetail`]). A shared folder has nothing to say.
    fn detail(&self) -> Option<LinkDetail> {
        None
    }
    /// The transport was refused as not (or no longer) allowed in: the app should look at the team
    /// list at once instead of waiting for its next scheduled look (a removed member finds out
    /// within seconds, not a minute).
    fn lost_access(&self) -> bool {
        false
    }
    /// Stop every subscription and watcher. Idempotent.
    fn stop(&self);
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
