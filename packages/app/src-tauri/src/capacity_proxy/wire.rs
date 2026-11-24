//! Share-an-agent control items on the team relay (plan 3.4): request, grant, decline, revoke, return, ack.
//!
//! Each item rides in a `Payload::Capacity` envelope: sealed with the team key and signed by the sending device like
//! every team message (`team::secure`), and inside that sealed again with HPKE to ONE device, the same pattern as
//! key grants. Only that device can read it; every other device of the team ignores it.
//!
//! Opening runs these checks, in order, and anything that fails is dropped:
//! 1. the item is addressed to this device;
//! 2. it opens with this device's key (the HPKE info binds team, msg id, sender and receiver);
//! 3. the inner item names the same msg id, member and device as the signed envelope;
//! 4. it is not dated more than 10 minutes in the future;
//! 5. its msg id was not seen before (`Guard`).
//!
//! The kind-specific rules (a grant must match an open request, a grant id is accepted once, a revoke only from the
//! device that issued the grant) are in `rules`, applied by the service against its own records.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::gate::Limits;
use crate::secure_core::crypto::{b64, hpke_open, hpke_seal, unb64, KemSecret};
use crate::team::secure::{CapacityIn, Payload, Session};

pub const VERSION: u32 = 1;
/// Items dated further ahead than this are refused (clock skew).
pub const MAX_FUTURE_MS: u64 = 10 * 60_000;
/// How long a msg id is remembered (the relay keeps envelopes for 7 days).
pub const REMEMBER_MS: u64 = 8 * 24 * 3_600_000;
pub const MAX_REASON: usize = 280;
/// The most offers one answer carries (the rest are dropped), and the longest offer name.
pub const MAX_OFFERS: usize = 20;
/// Largest sealed item accepted (a relay envelope is at most 24 KiB).
const MAX_ITEM_BYTES: usize = 16 * 1024;

pub use pm_core::capacity_proxy::NodeHint;

/// What a lender offers ONE asker: words and numbers only (no token, no path, no email). The asker picks one and names its
/// `profile_id` in its request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub profile_id: String,
    pub name: String,
    pub agent_id: String,
    pub max_secs: u64,
    pub default_secs: u64,
    pub asks_first: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Body {
    /// "Lend me this agent": sent by the borrower to the lender's device(s).
    Request {
        request_id: String,
        agent_id: String,
        mode: String,
        duration_ms: u64,
        reason: String,
        device_name: String,
        /// The borrower's lend node id (hex): the only node the lender's link will let in for this grant.
        node_hint: String,
        /// The lender's profile the borrower picked from an `Offers` answer. None: the lender chooses (an older borrower).
        #[serde(default)]
        profile_id: Option<String>,
        /// Pass a task "run it through my lent usage": the id of the task whose sender promised this lend (`team::direct`).
        /// The lender answers yes by itself only for a request that matches that promise. An older lender ignores it.
        #[serde(default)]
        offer_ref: Option<String>,
    },
    /// "Yes": sent by the lender to the device that asked.
    Grant {
        request_id: String,
        grant_id: String,
        agent_id: String,
        mode: String,
        duration_ms: u64,
        not_after_ms: u64,
        #[serde(default)]
        limits: Limits,
        node: NodeHint,
        /// 32 random bytes, base64url: the key of the link handshake HMAC.
        link_secret: String,
        #[serde(default)]
        device_name: String,
        /// The lender's name for the profile this lend comes from (words only, cut and cleaned by the borrower). An older
        /// lender sends none; an older borrower ignores it.
        #[serde(default)]
        profile_name: String,
    },
    Decline { request_id: String },
    /// The lender took it back (only from the device that issued the grant).
    Revoke { grant_id: String, #[serde(default)] reason: String },
    /// The borrower gave it back (only from the device the grant was for).
    /// `reason` is only ever `NOT_HELD` (the answer to a `Check`); empty for a normal give-back.
    Return { grant_id: String, #[serde(default)] reason: String },
    /// The lender asks "do you still hold this grant?" (Lending tab opened, or every few minutes). A borrower that holds it says
    /// nothing; one that does not answers `Return` with the reason `NOT_HELD`. An older build drops it as a bad item.
    Check { grant_id: String },
    /// "Use my own agents": the lender keeps a lend rolling while its far chat lives. The new end is `not_after_ms` on the
    /// lender's clock (read like a `Grant`'s). Taken only from the device that issued the grant; an older build drops it.
    Extend { grant_id: String, not_after_ms: u64 },
    Ack { of: String },
    /// Team page ping: "are you there?" The answer is a `Pong` with the same nonce, so the sender can time the round
    /// trip through the relay. Answered whether or not Lend is on (`ping`); an older build drops it as a bad item.
    Ping { nonce: String },
    Pong { nonce: String },
    /// "What can I borrow from you?": answered with `Offers` carrying the same nonce, listing only what THIS asker may use.
    /// An older build drops it as a bad item (the asker times out and falls back to asking for an agent).
    OffersAsk { nonce: String },
    Offers { nonce: String, offers: Vec<Offer> },
    /// The lender's limit numbers for the account behind a grant (percent, reset times and the plan name; nothing else),
    /// sent only when the profile's "Show usage in the usage bar" is on. An older build drops it as a bad item.
    Usage {
        grant_id: String,
        #[serde(default)]
        plan: Option<String>,
        #[serde(default)]
        windows: Vec<WireWindow>,
    },
}

/// One limit window as sent to a borrower.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireWindow {
    pub name: String,
    /// Whole percent used.
    pub used_percent: u32,
    #[serde(default)]
    pub minutes: Option<u64>,
    #[serde(default)]
    pub resets_at_ms: Option<u64>,
}

/// The most windows kept from another PC.
pub const MAX_WIRE_WINDOWS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub v: u32,
    pub msg_id: String,
    pub team: String,
    pub from_member: String,
    pub from_device: String,
    pub to: String,
    pub sent_ms: u64,
    pub body: Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireReject {
    /// For another device of the team: not an error, just not mine.
    NotForMe,
    Undecryptable,
    BadItem,
    Impersonation,
    Future,
    Replay,
    UnknownDevice,
}

impl WireReject {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotForMe => "for another device",
            Self::Undecryptable => "could not open",
            Self::BadItem => "bad item",
            Self::Impersonation => "names someone other than its sender",
            Self::Future => "dated in the future",
            Self::Replay => "already seen",
            Self::UnknownDevice => "the device is not on the team",
        }
    }
}

fn info(team: &str, msg_id: &str, from_device: &str, to: &str) -> Vec<u8> {
    format!("pm-capacity-v1\n{team}\n{msg_id}\n{from_device}\n{to}").into_bytes()
}

pub fn new_msg_id(now_ms: u64) -> String {
    crate::team::event::new_event_id(now_ms)
}

/// Seals `body` to device `to` of the team. Returns the payload and its msg id.
pub fn seal(session: &Session, to: &str, body: Body, now_ms: u64) -> Result<(Payload, String), String> {
    let (_, device) = session.roster.device(to).ok_or("That device is not on the team.")?;
    let from_device = session.my_device()?;
    let msg_id = new_msg_id(now_ms);
    let item = Item {
        v: VERSION,
        msg_id: msg_id.clone(),
        team: session.team().to_string(),
        from_member: session.my_member()?,
        from_device: from_device.clone(),
        to: to.to_string(),
        sent_ms: now_ms,
        body,
    };
    let plain = serde_json::to_vec(&item).map_err(|e| e.to_string())?;
    let (enc, ct) = hpke_seal(&device.kem, &info(session.team(), &msg_id, &from_device, to), &plain).map_err(|e| e.to_string())?;
    Ok((Payload::Capacity { msg_id: msg_id.clone(), to: to.to_string(), enc: b64(&enc), ct: b64(&ct) }, msg_id))
}

/// Opens an item that passed the envelope checks (`CapacityIn`): steps 1-4 of the module doc. Step 5 is `Guard`.
pub fn open(session: &Session, kem: &KemSecret, cin: &CapacityIn, now_ms: u64) -> Result<Item, WireReject> {
    let me = session.my_device().map_err(|_| WireReject::Undecryptable)?;
    if cin.to != me {
        return Err(WireReject::NotForMe);
    }
    if session.roster.device(&cin.device).is_none() {
        return Err(WireReject::UnknownDevice);
    }
    let enc = unb64(&cin.enc).ok_or(WireReject::BadItem)?;
    let ct = unb64(&cin.ct).ok_or(WireReject::BadItem)?;
    if ct.len() > MAX_ITEM_BYTES {
        return Err(WireReject::BadItem);
    }
    let plain = hpke_open(kem, &enc, &info(session.team(), &cin.msg_id, &cin.device, &me), &ct).map_err(|_| WireReject::Undecryptable)?;
    let item: Item = serde_json::from_slice(&plain).map_err(|_| WireReject::BadItem)?;
    if item.v != VERSION {
        return Err(WireReject::BadItem);
    }
    if item.msg_id != cin.msg_id || item.from_device != cin.device || item.from_member != cin.member || item.to != me || item.team != session.team() {
        return Err(WireReject::Impersonation);
    }
    if item.sent_ms > now_ms.saturating_add(MAX_FUTURE_MS) {
        return Err(WireReject::Future);
    }
    if let Body::Request { reason, .. } = &item.body {
        if reason.chars().count() > MAX_REASON {
            return Err(WireReject::BadItem);
        }
    }
    if let Body::Offers { offers, .. } = &item.body {
        if offers.len() > MAX_OFFERS * 4 {
            return Err(WireReject::BadItem);
        }
    }
    Ok(item)
}

/// Replay memory: msg ids (until they could no longer be delivered) and grant ids accepted once.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guard {
    #[serde(default)]
    pub seen: BTreeMap<String, u64>,
    #[serde(default)]
    pub grants: BTreeSet<String>,
}

impl Guard {
    /// Records `msg_id`; `Err(Replay)` when it was seen before.
    pub fn fresh(&mut self, msg_id: &str, now_ms: u64) -> Result<(), WireReject> {
        self.seen.retain(|_, until| *until > now_ms);
        if self.seen.contains_key(msg_id) {
            return Err(WireReject::Replay);
        }
        self.seen.insert(msg_id.to_string(), now_ms + REMEMBER_MS);
        Ok(())
    }

    /// Records a grant id; false when it was accepted before.
    pub fn accept_grant(&mut self, grant_id: &str) -> bool {
        self.grants.insert(grant_id.to_string())
    }
}

/// The kind-specific rules, as pure checks over what the service knows.
pub mod rules {
    /// A grant answers one of MY open requests, and comes from the member (and device, when I named one) I asked.
    pub fn grant_matches(open: bool, asked_member: &str, asked_devices: &[String], from_member: &str, from_device: &str) -> bool {
        open && asked_member == from_member && asked_devices.iter().any(|d| d == from_device)
    }

    /// A revoke is taken only from the device that issued the grant.
    pub fn revoke_allowed(lender_device: &str, from_device: &str) -> bool {
        lender_device == from_device
    }

    /// A return is taken only from the device the grant was for.
    pub fn return_allowed(borrower_device: &str, from_device: &str) -> bool {
        borrower_device == from_device
    }
}
