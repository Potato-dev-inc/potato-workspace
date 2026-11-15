//! Pass a task: the items two teammates' PCs send each other over the team relay.
//!
//! The same pattern as the lend wire (`capacity_proxy::wire`): an item rides in a `Payload::Direct`, sealed with the
//! team key and signed by the sending device like every team message, and inside that sealed again with HPKE to ONE
//! device. Opening runs these checks, in order, and anything that fails is dropped:
//! 1. the item is addressed to this device;
//! 2. it opens with this device's key (the HPKE info binds team, msg id, sender and receiver);
//! 3. the inner item names the same msg id, member and device as the signed envelope;
//! 4. it is not dated more than 10 minutes in the future;
//! 5. every text field is inside its limit (a longer one is a bad item, never cut and kept);
//! 6. its msg id was not seen before (`Guard`).
//!
//! A teammate's text is data. [`clean_text`] drops control characters; nothing here runs anything.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::secure_core::crypto::{b64, hpke_open, hpke_seal, unb64, KemSecret};
use crate::team::secure::{CapacityIn, Payload, Session};

pub const VERSION: u32 = 1;
/// Items dated further ahead than this are refused (clock skew).
pub const MAX_FUTURE_MS: u64 = 10 * 60_000;
/// How long a msg id is remembered (the relay keeps envelopes for 7 days).
pub const REMEMBER_MS: u64 = 8 * 24 * 3_600_000;
pub const MAX_TITLE_CHARS: usize = 120;
/// The task text and the chat summary are limited in bytes, so every item fits one relay envelope (24 KiB, sealed twice).
pub const MAX_TEXT_BYTES: usize = 8_000;
pub const MAX_SUMMARY_BYTES: usize = 2_000;
pub const MAX_NOTE_CHARS: usize = 280;
pub const MAX_NAME_CHARS: usize = 80;
/// Largest sealed item accepted.
const MAX_ITEM_BYTES: usize = 16 * 1024;
/// One piece of a repo hand-over. 8 KiB of bytes becomes about 20 KiB on the wire after two layers of base64.
pub const CHUNK_BYTES: usize = 8 * 1024;
/// The largest bundle the relay path carries. A bigger repo needs the direct PC link (not built yet).
pub const BUNDLE_CAP_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_CHUNKS: u32 = (BUNDLE_CAP_BYTES as usize / CHUNK_BYTES + 1) as u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum History {
    /// One commit with the branch's files as they are (the default: smaller, and no old history leaves the PC).
    #[default]
    Latest,
    /// The branch with its whole history.
    Full,
}

/// A copy of a repo that goes with a task. Words and numbers only: the bytes follow in `Chunk` items after the receiver says yes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOffer {
    /// The folder's name (display only).
    pub name: String,
    /// The branch it was made from (display, and the name the receiver gives its branch).
    pub branch: String,
    /// The ref inside the bundle: `refs/heads/<branch>` or `refs/potato-handover/<id>`.
    pub git_ref: String,
    pub history: History,
    pub bytes: u64,
    /// SHA-256 of the whole bundle, hex.
    pub sha256: String,
    pub chunks: u32,
}

/// "Run it through my lent usage": the sender promises one lend of this profile. Words and numbers only. A login can
/// never be here: the lend itself is the existing proxy (`capacity_proxy`), and the sign-in never leaves the sender's PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LendOffer {
    pub profile_id: String,
    pub profile_name: String,
    pub agent_id: String,
    pub secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyState {
    Seen,
    Accepted,
    Declined,
    Started,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Body {
    /// "Please do this": sent by the person passing the task.
    Task {
        id: String,
        title: String,
        text: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        repo: Option<RepoOffer>,
        #[serde(default)]
        lend: Option<LendOffer>,
    },
    /// What the receiver did with it. `want_repo`: send the repo's bytes now (only with `Accepted`). `note`: the words
    /// the person wrote for `Done`.
    Reply {
        id: String,
        state: ReplyState,
        #[serde(default)]
        want_repo: bool,
        #[serde(default)]
        note: String,
    },
    /// The sender took the task back (or another PC of the receiver answered first).
    Withdrawn { id: String },
    /// One piece of the repo bundle, in order, base64.
    Chunk { id: String, idx: u32, data: String },
}

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
    format!("pm-direct-v1\n{team}\n{msg_id}\n{from_device}\n{to}").into_bytes()
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
    if plain.len() > MAX_ITEM_BYTES {
        return Err("That is too big to send.".into());
    }
    let (enc, ct) = hpke_seal(&device.kem, &info(session.team(), &msg_id, &from_device, to), &plain).map_err(|e| e.to_string())?;
    Ok((Payload::Direct { msg_id: msg_id.clone(), to: to.to_string(), enc: b64(&enc), ct: b64(&ct) }, msg_id))
}

/// Opens an item that passed the envelope checks: steps 1-5 of the module doc. Step 6 is `Guard`.
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
    check_limits(&item.body)?;
    Ok(item)
}

/// A field over its limit makes the whole item bad (it is not cut and kept): a sender of this build never goes over.
fn check_limits(body: &Body) -> Result<(), WireReject> {
    let bad = |yes: bool| if yes { Err(WireReject::BadItem) } else { Ok(()) };
    match body {
        Body::Task { id, title, text, summary, repo, lend } => {
            bad(!valid_id(id) || title.chars().count() > MAX_TITLE_CHARS || text.len() > MAX_TEXT_BYTES || summary.len() > MAX_SUMMARY_BYTES)?;
            if let Some(r) = repo {
                bad(r.chunks == 0 || r.chunks > MAX_CHUNKS || r.bytes == 0 || r.bytes > BUNDLE_CAP_BYTES || !valid_hex(&r.sha256) || !valid_ref(&r.git_ref) || !valid_branch_text(&r.branch) || r.name.chars().count() > MAX_NAME_CHARS)?;
            }
            if let Some(l) = lend {
                bad(l.profile_id.is_empty() || l.profile_id.len() > 64 || l.profile_name.chars().count() > MAX_NAME_CHARS || l.agent_id.len() > 64 || l.secs == 0)?;
            }
            Ok(())
        }
        Body::Reply { id, note, .. } => bad(!valid_id(id) || note.chars().count() > MAX_NOTE_CHARS),
        Body::Withdrawn { id } => bad(!valid_id(id)),
        Body::Chunk { id, idx, data } => bad(!valid_id(id) || *idx >= MAX_CHUNKS || data.len() > CHUNK_BYTES * 4 / 3 + 8),
    }
}

/// A task id: short, plain, safe as a file name.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The ref inside a bundle: `refs/heads/<branch>` or `refs/potato-handover/<id>`, plain characters only.
pub fn valid_ref(r: &str) -> bool {
    let rest = r.strip_prefix("refs/heads/").or_else(|| r.strip_prefix("refs/potato-handover/"));
    match rest {
        Some(rest) => valid_branch_text(rest),
        None => false,
    }
}

/// A branch name as a teammate sends it: plain characters, no `..`, no option-looking start.
pub fn valid_branch_text(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 100
        && !b.starts_with('-')
        && !b.starts_with('/')
        && !b.ends_with('/')
        && !b.ends_with(".lock")
        && !b.contains("..")
        && !b.contains("//")
        && b.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
}

/// Text from another PC, as plain text: control characters dropped (a newline and a tab stay), trimmed. Never longer than
/// `max_chars`.
pub fn clean_text(raw: &str, max_chars: usize) -> String {
    let kept: String = raw.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    kept.trim().chars().take(max_chars).collect()
}

/// One line of text from another PC (a title, a name): control characters become spaces, runs of spaces become one.
pub fn clean_line(raw: &str, max_chars: usize) -> String {
    let spaced: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max_chars).collect()
}

/// Replay memory: msg ids, until they could no longer be delivered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guard {
    #[serde(default)]
    pub seen: BTreeMap<String, u64>,
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
}
