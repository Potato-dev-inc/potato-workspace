//! The sign-in this app started, and the one link that may finish it.
//!
//! The app makes a random `verifier` and `state`, keeps both in memory for ten minutes and opens the system browser.
//! The server sends the browser back with `potato-workspace://signin?ticket=..&state=..&acct=..`. A link is untrusted
//! text from outside: it is accepted only while a sign-in this app started is pending and its `state` matches. A
//! stolen ticket is useless without the verifier, which never leaves this process.

use crate::keys::crypto::{b64, random_bytes};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

const PREFIX: &str = "potato-workspace://signin?";
/// How long a started sign-in waits for its link.
pub const PENDING_SECS: u64 = 600;

/// What this app remembers about the sign-in it started. Never shown to the window, never logged.
#[derive(Clone)]
pub struct Pending {
    verifier: String,
    state: String,
    started: u64,
}

impl Pending {
    pub fn new(now: u64) -> Self {
        Self { verifier: b64(&random_bytes::<32>()), state: b64(&random_bytes::<24>()), started: now }
    }
    /// The PKCE challenge the server binds the ticket to (base64url SHA-256 of the verifier).
    pub fn challenge(&self) -> String {
        b64(&Sha256::digest(self.verifier.as_bytes()))
    }
    pub fn verifier(&self) -> &str {
        &self.verifier
    }
    pub fn state(&self) -> &str {
        &self.state
    }
    pub fn expired(&self, now: u64) -> bool {
        now.saturating_sub(self.started) > PENDING_SECS
    }
    /// The page the system browser opens.
    pub fn start_url(&self, base: &str) -> String {
        format!("{}/v1/auth/start?challenge={}&state={}&return=app", base.trim_end_matches('/'), self.challenge(), self.state)
    }
}

/// The three values of a well-formed sign-in link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInLink {
    pub ticket: String,
    pub state: String,
    pub account: String,
}

fn token_ok(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn uuid_ok(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok() && s.len() == 36
}

/// A sign-in link in its one fixed form, or `None` for everything else (other paths, extra or repeated keys,
/// a fragment, odd characters, an over-long link). Cheap and strict, like the invite link parser.
pub fn parse_link(url: &str) -> Option<SignInLink> {
    let url = url.trim();
    if url.len() > 512 || url.len() <= PREFIX.len() {
        return None;
    }
    let head = url.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let (mut ticket, mut state, mut account) = (None, None, None);
    for pair in url[PREFIX.len()..].split('&') {
        let (key, value) = pair.split_once('=')?;
        let slot = match key {
            "ticket" => &mut ticket,
            "state" => &mut state,
            "acct" => &mut account,
            _ => return None,
        };
        if slot.is_some() {
            return None;
        }
        *slot = Some(value.to_string());
    }
    let (ticket, state, account) = (ticket?, state?, account?);
    if !token_ok(&ticket, 16, 128) || !token_ok(&state, 16, 128) || !uuid_ok(&account) {
        return None;
    }
    Some(SignInLink { ticket, state, account })
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The sign-in this app is waiting for (at most one).
#[derive(Default)]
pub struct PendingSignIn(Mutex<Option<Pending>>);

impl PendingSignIn {
    pub fn start(&self, now: u64) -> Pending {
        let pending = Pending::new(now);
        *self.0.lock() = Some(pending.clone());
        pending
    }
    pub fn cancel(&self) {
        *self.0.lock() = None;
    }
    pub fn is_waiting(&self, now: u64) -> bool {
        self.0.lock().as_ref().is_some_and(|p| !p.expired(now))
    }
    /// Takes the pending sign-in when `link` belongs to it. A link with another state, or one that arrives with
    /// nothing pending, changes nothing: a web page cannot cancel a sign-in by sending a wrong link.
    pub fn accept(&self, link: &SignInLink, now: u64) -> Option<Pending> {
        let mut slot = self.0.lock();
        let pending = slot.as_ref()?;
        if pending.expired(now) {
            *slot = None;
            return None;
        }
        if !same(pending.state(), &link.state) {
            return None;
        }
        slot.take()
    }
}
