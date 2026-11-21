//! `RelayTransport`: the team's mailbox on a relay server (`relay/server`, the protocol in
//! `relay/protocol`), self-hosted or PM-hosted.
//!
//! - **Outbound only.** This app opens connections to the relay; the relay never calls this app,
//!   and nothing here touches the bridge or device pairing.
//! - **Opaque to the relay.** Only sealed envelopes and signed slots travel; the relay sees the
//!   team id, the sending device, sizes and times (`pm_relay_protocol` docs).
//! - **Every request is signed** by this device's key (`x-pm-auth`); the relay admits only devices
//!   on the team's access list, which only the root key can change.
//! - **Receiving:** a WebSocket (`/ws?after=`); when it can't connect, long-polling
//!   (`/envelopes?after=&wait=`) for a while, then the WebSocket is tried again.

use super::{now_ms, problem_kind, Inbound, LinkDetail, TeamTransport, TransportError};
use crate::team::crypto::SigningKey;
use parking_lot::Mutex;
use pm_relay_protocol::{auth_header, Batch, Delivered, Envelope, JoinBox, Resync, SignedAcl, SignedBlob, TeamRegistration, AUTH_HEADER};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Long-poll wait asked of the relay (seconds).
const POLL_WAIT_S: u64 = 20;
/// After the WebSocket fails, poll for this long before trying it again.
const POLL_BEFORE_WS_RETRY: Duration = Duration::from_secs(60);
/// How often an open WebSocket says "ping". Cloudflare closes a connection that has been silent for a while,
/// and a relay on Cloudflare answers the text "ping" with "pong" without waking its Durable Object, so this
/// keeps an idle connection open for almost nothing. The reader ignores the "pong".
const WS_PING_EVERY: Duration = Duration::from_secs(45);
/// Pause after a failed request.
const BACKOFF: Duration = Duration::from_secs(3);
/// Pause after "this relay is gone".
const GONE_BACKOFF: Duration = Duration::from_secs(60);

const MODE_OFFLINE: u8 = 0;
const MODE_LIVE: u8 = 1;
const MODE_POLLING: u8 = 2;
/// The relay answered "not on this team": the access list no longer has this device.
const MODE_DENIED: u8 = 3;
/// Nothing has been tried yet: the first WebSocket connect or poll has not finished.
const MODE_CONNECTING: u8 = 4;

pub struct RelayTransport {
    /// `https://relay.example.com` (or `http://127.0.0.1:8787`), no trailing slash.
    base: String,
    /// The path part of `base` (`""` or `/pm`), signed into every request.
    prefix: String,
    /// Scheme and host of `base`.
    origin: String,
    team: String,
    device: SigningKey,
    agent: ureq::Agent,
    stops: Mutex<Vec<Arc<AtomicBool>>>,
    mode: Arc<AtomicU8>,
    /// What the reader is doing now, for the Team page.
    live: Arc<Mutex<Live>>,
    /// Test switch: never try the WebSocket (exercise the poll fallback).
    poll_only: bool,
}

/// The reader's current step and the last failure (kind only).
#[derive(Default)]
struct Live {
    step: &'static str,
    attempting: bool,
    problem: Option<&'static str>,
    retry_at: Option<std::time::Instant>,
}

impl Live {
    fn trying(&mut self, step: &'static str) {
        self.step = step;
        self.attempting = true;
        self.retry_at = None;
    }
    fn ok(&mut self) {
        self.attempting = false;
        self.problem = None;
        self.retry_at = None;
    }
    fn failed(&mut self, error: &TransportError, retry_in: Duration) {
        self.step = "waiting";
        self.attempting = false;
        self.problem = Some(problem_kind(error));
        self.retry_at = Some(std::time::Instant::now() + retry_in);
    }
}

/// `base` with a scheme the relay speaks, or why not.
///
/// The address part must be a plain `host[:port]`: no user name or password (`http://127.0.0.1:x@evil.com`
/// would otherwise pass the loopback check while the HTTP client connects to `evil.com`, and
/// credentials would be saved in `team.json` and repeated in error messages), no backslash, no
/// percent-escapes, no query or fragment. With those gone, this check and the HTTP client's URL
/// parser read the same host.
pub fn normalize_relay_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/').to_string();
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err("The relay address starts with https:// (or http:// on this computer).".into());
    };
    if url.contains(['?', '#']) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That relay address has extra parts. Use just https://host or https://host/path.".into());
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.contains(['@', '\\', '%']) {
        return Err("A relay address can't carry a user name, a password or escaped characters.".into());
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        let (inside, after) = v6.split_once(']').ok_or("That relay address has no host.")?;
        if !(after.is_empty() || after.strip_prefix(':').is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))) {
            return Err("That relay address has a bad port.".into());
        }
        inside.parse::<std::net::Ipv6Addr>().map_err(|_| "That relay address has a bad IPv6 host.")?;
        inside
    } else {
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        if port.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
            return Err("That relay address has a bad port.".into());
        }
        host
    };
    if host.is_empty() {
        return Err("That relay address has no host.".into());
    }
    // Plain http only on this machine: a relay elsewhere must use TLS.
    let loopback = host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if scheme == "http" && !loopback {
        return Err("Use https:// for a relay on another computer.".into());
    }
    Ok(url)
}

/// The mode after a failed poll: the relay turning this device away is not the same as it being unreachable.
fn mode_after_error(error: &TransportError) -> u8 {
    if error.is_denied() {
        MODE_DENIED
    } else {
        MODE_OFFLINE
    }
}

impl RelayTransport {
    pub fn new(base: &str, team: &str, device: SigningKey) -> Result<Self, String> {
        let base = normalize_relay_url(base)?;
        let after_scheme = base.split_once("://").map(|(_, r)| r).unwrap_or("");
        let prefix = after_scheme.find('/').map(|at| after_scheme[at..].to_string()).unwrap_or_default();
        let origin = base[..base.len() - prefix.len()].to_string();
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout(Duration::from_secs(POLL_WAIT_S + 15))
            .build();
        Ok(Self {
            base,
            prefix,
            origin,
            team: team.to_string(),
            device,
            agent,
            stops: Mutex::new(Vec::new()),
            mode: Arc::new(AtomicU8::new(MODE_CONNECTING)),
            live: Arc::new(Mutex::new(Live::default())),
            poll_only: false,
        })
    }

    /// Tests: skip the WebSocket and long-poll only.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn poll_only(mut self) -> Self {
        self.poll_only = true;
        self
    }

    fn team_path(&self, rest: &str) -> String {
        format!("{}/v1/teams/{}{}", self.prefix, self.team, rest)
    }

    fn call(&self, method: &str, path: &str, body: &[u8], signed: bool) -> Result<(u16, Vec<u8>), TransportError> {
        let url = format!("{}{}", self.origin, path);
        let mut req = self.agent.request(method, &url).set("x-pm-relay", pm_relay_protocol::PROTOCOL);
        if signed {
            req = req.set(AUTH_HEADER, &auth_header(&self.device, method, path, now_ms(), body));
        }
        if !body.is_empty() {
            req = req.set("content-type", "application/json");
        }
        let result = if body.is_empty() && method == "GET" { req.call() } else { req.send_bytes(body) };
        let response = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                // Nothing answers the health path at this address: there is no relay here (a Potato relay always answers it).
                if code == 404 && path.ends_with("/v1/health") {
                    return Err(TransportError::new(super::RELAY_GONE));
                }
                return Err(TransportError(relay_error(code, &text)));
            }
            Err(e) => return Err(TransportError(format!("Can't reach the relay: {e}"))),
        };
        let status = response.status();
        let mut bytes = Vec::new();
        use std::io::Read;
        response
            .into_reader()
            .take(pm_relay_protocol::MAX_STATE_BYTES as u64 * 4)
            .read_to_end(&mut bytes)
            .map_err(|e| TransportError(e.to_string()))?;
        Ok((status, bytes))
    }

    fn fetch_batch(&self, after: u64, wait_s: u64) -> Result<Batch, TransportError> {
        let path = self.team_path(&format!("/envelopes?after={after}&wait={wait_s}"));
        let (_, bytes) = self.call("GET", &path, b"", true)?;
        serde_json::from_slice(&bytes).map_err(|_| TransportError::new("The relay sent something unreadable."))
    }

    fn spawn_reader(&self, after: u64, tx: Sender<Inbound>, stop: Arc<AtomicBool>) -> Result<(), TransportError> {
        let me = ReaderCtx {
            base: self.base.clone(),
            ws_path: self.team_path("/ws"),
            device: self.device.clone(),
            mode: self.mode.clone(),
            live: self.live.clone(),
            poll_only: self.poll_only,
            cursor: Arc::new(AtomicU64::new(after)),
            pending_reset: AtomicBool::new(false),
        };
        let poller = RelayTransport {
            base: self.base.clone(),
            prefix: self.prefix.clone(),
            origin: self.origin.clone(),
            team: self.team.clone(),
            device: self.device.clone(),
            agent: self.agent.clone(),
            stops: Mutex::new(Vec::new()),
            mode: self.mode.clone(),
            live: self.live.clone(),
            poll_only: self.poll_only,
        };
        std::thread::Builder::new()
            .name("team-relay".into())
            .spawn(move || me.run(&poller, &tx, &stop))
            .map(|_| ())
            .map_err(|e| TransportError(format!("could not start the relay reader: {e}")))
    }
}

/// Ask an address whether it is a Potato relay (its `/v1/health`), before anything is moved to it. Returns the address to save.
pub fn check_health(raw: &str) -> Result<String, String> {
    let base = normalize_relay_url(raw)?;
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(10)).build();
    match agent.get(&format!("{base}/v1/health")).set("x-pm-relay", pm_relay_protocol::PROTOCOL).call() {
        Ok(r) => {
            use std::io::Read;
            let mut bytes = Vec::new();
            let _ = r.into_reader().take(65_536).read_to_end(&mut bytes);
            let ok = serde_json::from_slice::<serde_json::Value>(&bytes).ok().and_then(|v| v.get("ok").and_then(|o| o.as_bool()));
            if ok == Some(true) { Ok(base) } else { Err("That address answered, but it is not a Potato relay.".into()) }
        }
        Err(ureq::Error::Status(404, _)) => Err(super::RELAY_GONE.into()),
        Err(ureq::Error::Status(code, r)) => Err(relay_error(code, &r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("Can't reach the relay: {e}")),
    }
}

fn relay_error(code: u16, body: &str) -> String {
    // What the relay says is untrusted: short, and without control characters, before it reaches a log or an error sentence.
    let said = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.chars().filter(|c| !c.is_control()).take(200).collect::<String>()));
    match code {
        // Cloudflare's reply when no Worker is deployed at the address any more.
        // Asked with `Accept-Encoding: gzip` (as this app does), Cloudflare sends its HTML "Page not found" page instead of the plain code.
        404 if body.contains("error code: 1042") || (body.contains("workers.cloudflare.com") && body.contains("There is nothing here yet")) => super::RELAY_GONE.into(),
        403 => format!("{} yet{}.", super::DENIED, said.as_deref().map(|s| format!(" ({s})")).unwrap_or_default()),
        401 => format!("{}{}.", super::BAD_SIGNATURE, said.as_deref().map(|s| format!(" ({s})")).unwrap_or_default()),
        // Only the relay's own "unknown team" is a relay that lost the team. Any other 404 is a server that is not a relay at all.
        404 if said.as_deref() == Some("unknown team") => super::UNKNOWN_TEAM.into(),
        404 => "That address answered 404. It may not be a Potato relay (unreadable).".into(),
        409 => "The relay already has a newer copy.".into(),
        413 => "That's too large for the relay.".into(),
        507 => format!("{} Try again later.", super::MAILBOX_FULL),
        429 => format!("{} Try again in a minute.", super::SLOW_DOWN),
        500..=599 => format!("{} (HTTP {code}).", super::TROUBLE),
        _ => format!("The relay said {code}{}.", said.map(|s| format!(": {s}")).unwrap_or_default()),
    }
}

struct ReaderCtx {
    base: String,
    ws_path: String,
    device: SigningKey,
    mode: Arc<AtomicU8>,
    live: Arc<Mutex<Live>>,
    poll_only: bool,
    cursor: Arc<AtomicU64>,
    /// The relay said our cursor was past its counter; the next delivered envelope tells the
    /// service to take its (lower) position as the saved cursor.
    pending_reset: AtomicBool,
}

impl ReaderCtx {
    fn deliver(&self, item: Delivered, tx: &Sender<Inbound>) -> bool {
        let reset = self.pending_reset.swap(false, Ordering::SeqCst);
        if reset || item.seq > self.cursor.load(Ordering::SeqCst) {
            self.cursor.store(item.seq, Ordering::SeqCst);
        }
        tx.send(Inbound { envelope: item.envelope, received_at_ms: now_ms(), cursor: item.seq, reset }).is_ok()
    }

    /// The relay's counter is behind our cursor (a restored or replaced relay database): start
    /// again from what it has. Envelopes already seen are dropped by the session's replay guard.
    fn resync(&self, head: u64) {
        tracing::info!(head, cursor = self.cursor.load(Ordering::SeqCst), "team: the relay's mailbox counter went back; reading it again");
        self.cursor.store(0, Ordering::SeqCst);
        self.pending_reset.store(true, Ordering::SeqCst);
    }

    fn run(&self, poller: &RelayTransport, tx: &Sender<Inbound>, stop: &AtomicBool) {
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if !self.poll_only {
                match self.websocket(tx, stop) {
                    WsEnd::Stopped => break,
                    WsEnd::ReceiverGone => break,
                    WsEnd::Failed(why) => {
                        tracing::debug!(%why, "team: relay WebSocket unavailable, polling");
                        // A dropped live connection is not "live" any more while the poll below finds out.
                        let _ = self.mode.compare_exchange(MODE_LIVE, MODE_CONNECTING, Ordering::SeqCst, Ordering::SeqCst);
                    }
                }
            }
            // Long-poll until it is time to try the WebSocket again.
            let until = std::time::Instant::now() + POLL_BEFORE_WS_RETRY;
            while self.poll_only || std::time::Instant::now() < until {
                if stop.load(Ordering::SeqCst) {
                    self.mode.store(MODE_OFFLINE, Ordering::SeqCst);
                    return;
                }
                self.live.lock().trying("poll");
                match poller.fetch_batch(self.cursor.load(Ordering::SeqCst), POLL_WAIT_S) {
                    Ok(batch) => {
                        self.mode.store(MODE_POLLING, Ordering::SeqCst);
                        self.live.lock().ok();
                        if batch.reset {
                            self.resync(batch.head.unwrap_or(0));
                        }
                        for item in batch.items {
                            if stop.load(Ordering::SeqCst) || !self.deliver(item, tx) {
                                return;
                            }
                        }
                        if batch.reset || batch.next > self.cursor.load(Ordering::SeqCst) {
                            self.cursor.store(batch.next, Ordering::SeqCst);
                        }
                    }
                    Err(error) => {
                        self.mode.store(mode_after_error(&error), Ordering::SeqCst);
                        tracing::debug!(%error, "team: relay poll failed");
                        // A relay that is gone never comes back by itself: ask rarely, and let the page show it once.
                        let wait = if problem_kind(&error) == "relay_gone" { GONE_BACKOFF } else { BACKOFF };
                        self.live.lock().failed(&error, wait);
                        let until = std::time::Instant::now() + wait;
                        while std::time::Instant::now() < until && !stop.load(Ordering::SeqCst) {
                            std::thread::sleep(Duration::from_millis(500).min(wait));
                        }
                    }
                }
            }
        }
        self.mode.store(MODE_OFFLINE, Ordering::SeqCst);
    }

    fn websocket(&self, tx: &Sender<Inbound>, stop: &AtomicBool) -> WsEnd {
        use tungstenite::client::IntoClientRequest;
        use tungstenite::http::HeaderValue;
        self.live.lock().trying("socket");
        let path = format!("{}?after={}", self.ws_path, self.cursor.load(Ordering::SeqCst));
        let host_part = self.base.split_once("://").map(|(_, r)| r.split('/').next().unwrap_or("")).unwrap_or("");
        let scheme = if self.base.starts_with("https://") { "wss" } else { "ws" };
        let url = format!("{scheme}://{host_part}{path}");
        let mut request = match url.into_client_request() {
            Ok(r) => r,
            Err(e) => return WsEnd::Failed(e.to_string()),
        };
        let header = auth_header(&self.device, "GET", &path, now_ms(), b"");
        match HeaderValue::from_str(&header) {
            Ok(v) => {
                request.headers_mut().insert(AUTH_HEADER, v);
            }
            Err(e) => return WsEnd::Failed(e.to_string()),
        }
        let (mut socket, _) = match tungstenite::connect(request) {
            Ok(pair) => pair,
            Err(e) => return WsEnd::Failed(e.to_string()),
        };
        set_read_timeout(socket.get_ref(), Duration::from_millis(800));
        self.mode.store(MODE_LIVE, Ordering::SeqCst);
        self.live.lock().ok();
        let mut last_ping = std::time::Instant::now();
        loop {
            if stop.load(Ordering::SeqCst) {
                let _ = socket.close(None);
                return WsEnd::Stopped;
            }
            if last_ping.elapsed() >= WS_PING_EVERY {
                last_ping = std::time::Instant::now();
                if let Err(e) = socket.send(tungstenite::Message::Text("ping".into())) {
                    return WsEnd::Failed(e.to_string());
                }
            }
            match socket.read() {
                Ok(tungstenite::Message::Text(text)) => {
                    if let Ok(item) = serde_json::from_str::<Delivered>(&text) {
                        if !self.deliver(item, tx) {
                            return WsEnd::ReceiverGone;
                        }
                    } else if let Ok(Resync { reset: true, head }) = serde_json::from_str::<Resync>(&text) {
                        self.resync(head);
                    }
                }
                Ok(tungstenite::Message::Close(_)) => return WsEnd::Failed("closed by the relay".into()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => return WsEnd::Failed(e.to_string()),
            }
        }
    }
}

enum WsEnd {
    Stopped,
    ReceiverGone,
    Failed(String),
}

fn set_read_timeout(stream: &tungstenite::stream::MaybeTlsStream<std::net::TcpStream>, timeout: Duration) {
    use tungstenite::stream::MaybeTlsStream;
    match stream {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(Some(timeout));
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.get_ref().set_read_timeout(Some(timeout));
        }
        _ => {}
    }
}

impl TeamTransport for RelayTransport {
    fn kind(&self) -> &'static str {
        "relay"
    }

    fn send(&self, envelope: &Envelope) -> Result<(), TransportError> {
        let body = serde_json::to_vec(envelope).map_err(|e| TransportError(e.to_string()))?;
        self.call("POST", &self.team_path("/envelopes"), &body, true).map(|_| ())
    }

    fn subscribe(&self, after: u64) -> Result<Receiver<Inbound>, TransportError> {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        self.stops.lock().push(stop.clone());
        self.spawn_reader(after, tx, stop)?;
        Ok(rx)
    }

    fn put_state(&self, blob: &SignedBlob) -> Result<(), TransportError> {
        let body = serde_json::to_vec(blob).map_err(|e| TransportError(e.to_string()))?;
        self.call("PUT", &self.team_path(&format!("/state/{}", blob.slot)), &body, true).map(|_| ())
    }

    fn get_state(&self, slot: &str) -> Result<Option<SignedBlob>, TransportError> {
        match self.call("GET", &self.team_path(&format!("/state/{slot}")), b"", true) {
            Ok((204, _)) => Ok(None),
            Ok((_, bytes)) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| TransportError::new("The relay sent an unreadable team list.")),
            Err(e) => Err(e),
        }
    }

    fn post_join(&self, join: &JoinBox) -> Result<(), TransportError> {
        let body = serde_json::to_vec(join).map_err(|e| TransportError(e.to_string()))?;
        self.call("POST", &self.team_path("/joins"), &body, false).map(|_| ())
    }

    fn joins(&self) -> Result<Vec<JoinBox>, TransportError> {
        let (_, bytes) = self.call("GET", &self.team_path("/joins"), b"", true)?;
        serde_json::from_slice(&bytes).map_err(|_| TransportError::new("The relay sent unreadable join requests."))
    }

    fn register(&self, registration: &TeamRegistration) -> Result<(), TransportError> {
        let body = serde_json::to_vec(registration).map_err(|e| TransportError(e.to_string()))?;
        match self.call("POST", &format!("{}/v1/teams", self.prefix), &body, false) {
            Ok(_) => Ok(()),
            // Already registered by me earlier: fine (the ACL update below is what counts).
            Err(e) if e.0.contains("newer copy") => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn set_acl(&self, acl: &SignedAcl) -> Result<(), TransportError> {
        let body = serde_json::to_vec(acl).map_err(|e| TransportError(e.to_string()))?;
        self.call("PUT", &self.team_path("/acl"), &body, false).map(|_| ())
    }

    fn publish_invite_link(&self, request: &super::InviteLinkRequest) -> Result<Option<super::InviteLinkMade>, TransportError> {
        // Ask what this relay can do first: an older deploy has no invite links ("Update your Worker").
        let (_, health) = self.call("GET", &format!("{}/v1/health", self.prefix), b"", false)?;
        let has_invites = serde_json::from_slice::<serde_json::Value>(&health)
            .ok()
            .and_then(|v| v.get("features").and_then(|f| f.as_array()).map(|a| a.iter().any(|x| x.as_str() == Some("invites"))))
            .unwrap_or(false);
        if !has_invites {
            return Err(TransportError::new(super::UPDATE_WORKER));
        }
        let body = serde_json::to_vec(request).map_err(|e| TransportError(e.to_string()))?;
        let (_, bytes) = self.call("POST", &self.team_path("/invite-links"), &body, true)?;
        let answer: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| TransportError::new("The relay sent an unreadable invite link."))?;
        let code = answer.get("code").and_then(|c| c.as_str()).filter(|c| c.len() == 16 && c.bytes().all(|b| b.is_ascii_alphanumeric()));
        let expires = answer.get("expires_at_ms").and_then(|v| v.as_u64());
        match (code, expires) {
            // The page is at the Worker's root (`/join/<code>`), whatever path the relay lives under.
            (Some(code), Some(expires_at_ms)) => Ok(Some(super::InviteLinkMade { url: format!("{}/join/{}", self.origin, code), expires_at_ms })),
            _ => Err(TransportError::new("The relay sent an unreadable invite link.")),
        }
    }

    fn status(&self) -> &'static str {
        match self.mode.load(Ordering::SeqCst) {
            MODE_LIVE => "live",
            MODE_POLLING => "polling",
            MODE_CONNECTING => "connecting",
            MODE_DENIED => "denied",
            _ => "offline",
        }
    }

    fn detail(&self) -> Option<LinkDetail> {
        let live = self.live.lock();
        let host = self.origin.split_once("://").map(|(_, h)| h.to_string());
        let retry_in_s = live.retry_at.map(|at| at.saturating_duration_since(std::time::Instant::now()).as_secs() + 1);
        Some(LinkDetail { host, step: if live.step.is_empty() { "idle" } else { live.step }, attempting: live.attempting, problem: live.problem, retry_in_s })
    }

    fn lost_access(&self) -> bool {
        self.mode.load(Ordering::SeqCst) == MODE_DENIED
    }

    fn stop(&self) {
        for stop in self.stops.lock().drain(..) {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

impl Drop for RelayTransport {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_addresses_need_tls_off_this_computer() {
        assert_eq!(normalize_relay_url("https://relay.example.com/").unwrap(), "https://relay.example.com");
        assert!(normalize_relay_url("http://127.0.0.1:8787").is_ok());
        assert!(normalize_relay_url("http://localhost:8787").is_ok());
        assert!(normalize_relay_url("http://relay.example.com").is_err());
        assert!(normalize_relay_url("ftp://x").is_err());
        assert!(normalize_relay_url("https://").is_err());
    }

    fn transport() -> RelayTransport {
        RelayTransport::new("https://relay.example.com", "team-x", crate::team::crypto::new_signing_key()).unwrap()
    }

    #[test]
    fn status_is_connecting_before_the_first_attempt_finishes() {
        assert_eq!(transport().status(), "connecting");
    }

    #[test]
    fn status_tells_denied_from_offline() {
        let t = transport();
        t.mode.store(mode_after_error(&TransportError::new(format!("{}: not on the list", super::super::DENIED))), Ordering::SeqCst);
        assert_eq!(t.status(), "denied");
        assert!(t.lost_access());
        t.mode.store(mode_after_error(&TransportError::new("timed out")), Ordering::SeqCst);
        assert_eq!(t.status(), "offline");
        assert!(!t.lost_access());
        t.mode.store(MODE_LIVE, Ordering::SeqCst);
        assert_eq!(t.status(), "live");
    }

    #[test]
    fn detail_names_the_host_and_the_kind_of_failure_only() {
        let t = transport();
        let d = t.detail().unwrap();
        assert_eq!(d.host.as_deref(), Some("relay.example.com"));
        assert_eq!((d.step, d.attempting, d.problem), ("idle", false, None));
        t.live.lock().trying("poll");
        assert!(t.detail().unwrap().attempting);
        t.live.lock().failed(&TransportError::new("Can't reach the relay: Connection Failed: dns error: no such host"), Duration::from_secs(3));
        let d = t.detail().unwrap();
        assert_eq!((d.step, d.attempting, d.problem), ("waiting", false, Some("dns")));
        assert!(d.retry_in_s.unwrap() >= 1);
        t.live.lock().ok();
        assert_eq!(t.detail().unwrap().problem, None);
    }

    #[test]
    fn problem_kinds_are_plain() {
        let k = |s: &str| problem_kind(&TransportError::new(s));
        assert_eq!(k("Can't reach the relay: timed out reading response"), "timeout");
        assert_eq!(k("Can't reach the relay: Connection Failed: Connect error: tcp connect error: connection refused"), "refused");
        assert_eq!(k("Can't reach the relay: Connection Failed: dns error: no such host"), "dns");
        assert_eq!(k("The relay sent something unreadable."), "unreadable");
    }

    /// Every status the app tells apart gets its own kind, made from the status and not from guessing at words.
    #[test]
    fn each_relay_status_has_its_own_kind() {
        let kind = |code: u16, body: &str| problem_kind(&TransportError::new(relay_error(code, body)));
        assert_eq!(kind(403, r#"{"error":"device not on this team"}"#), "refused_by_relay");
        assert_eq!(kind(404, r#"{"error":"unknown team"}"#), "unknown_team", "a relay that lost the team");
        assert_eq!(kind(404, r#"{"error":"not found"}"#), "unreadable", "a server that is not a relay");
        assert_eq!(kind(404, "<html>not found</html>"), "unreadable");
        assert_eq!(kind(404, "error code: 1042"), "relay_gone", "Cloudflare: no Worker at this address");
        assert_eq!(kind(404, "error code: 1042
"), "relay_gone");
        assert_eq!(kind(500, "error code: 1042"), "down");
        assert_eq!(kind(401, r#"{"error":"stale request"}"#), "signature", "a wrong clock or key is not the access list");
        assert_eq!(kind(429, ""), "busy");
        assert_eq!(kind(507, ""), "busy");
        assert_eq!(kind(502, ""), "down");
        assert_eq!(kind(530, ""), "down");
        assert_eq!(kind(418, ""), "other");
    }

    /// One canned HTTP answer on loopback; returns the address.
    fn answer_once(status: &str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let head = format!("HTTP/1.1 {status}
content-length: {}
connection: close

", body.len());
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = c.read(&mut buf);
                let _ = c.write_all(format!("{head}{body}").as_bytes());
            }
        });
        format!("http://{addr}")
    }

    /// What Cloudflare really answers for a deleted Worker, as an HTTP client that accepts gzip sees it (kept short; the real page is 20 KB of artwork).
    const CLOUDFLARE_NO_WORKER_HTML: &str = "<!DOCTYPE html>
<html class=\"no-js\" lang=\"en-US\">
  <head>
    <meta charSet=\"utf-8\"/>
    <title>Page not found</title>
    <link rel=\"icon\" type=\"image/png\" href=\"https://workers.cloudflare.com/favicon.ico\" sizes=\"48x48\"/>
  </head>
  <body>
    <h1>There is nothing here yet</h1>
    <p>If you expect something to be here, it may take some time.<br/>Please check back again later.</p>
  </body>
</html>
";

    /// The real dead address answers a client that accepts gzip (as the app's does) with an HTML page, not with "error code: 1042".
    #[test]
    fn the_real_dead_relay_replies_are_read_as_gone_through_the_polling_call() {
        for (ctype, body) in [("text/html; charset=UTF-8", CLOUDFLARE_NO_WORKER_HTML), ("text/plain; charset=UTF-8", "error code: 1042
")] {
            let url = answer_once_typed("404 Not Found", ctype, body);
            let t = RelayTransport::new(&url, "abc", crate::team::crypto::new_signing_key()).unwrap();
            let e = t.fetch_batch(0, 1).unwrap_err();
            assert_eq!(problem_kind(&e), "relay_gone", "{ctype}: {}", e.0);
        }
        // An ordinary web server's 404 page is still "not a relay", not "gone".
        let url = answer_once_typed("404 Not Found", "text/html", "<html><title>Page not found</title>nothing</html>");
        let t = RelayTransport::new(&url, "abc", crate::team::crypto::new_signing_key()).unwrap();
        assert_eq!(problem_kind(&t.fetch_batch(0, 1).unwrap_err()), "unreadable");
    }

    /// Like `answer_once`, with a content type.
    fn answer_once_typed(status: &str, ctype: &str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let head = format!("HTTP/1.1 {status}
content-type: {ctype}
content-length: {}
connection: close

", body.len());
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf);
                let _ = c.write_all(format!("{head}{body}").as_bytes());
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn health_check_tells_a_gone_relay_from_a_working_one() {
        let gone = check_health(&answer_once("404 Not Found", "error code: 1042")).unwrap_err();
        assert_eq!(problem_kind(&TransportError::new(gone)), "relay_gone");
        let other = check_health(&answer_once("200 OK", "<html>hi</html>")).unwrap_err();
        assert!(other.contains("not a Potato relay"), "{other}");
        let url = answer_once("200 OK", r#"{"ok":true,"features":["team"]}"#);
        assert_eq!(check_health(&url).unwrap(), url);
    }

    #[test]
    fn what_the_relay_says_is_cut_short_and_has_no_control_characters() {
        let body = format!(r#"{{"error":"{}[31m{}"}}"#, "a".repeat(300), "b");
        let text = relay_error(418, &body);
        assert!(!text.chars().any(|c| c.is_control()), "{text:?}");
        assert!(text.chars().count() < 260, "{}", text.chars().count());
    }
}
