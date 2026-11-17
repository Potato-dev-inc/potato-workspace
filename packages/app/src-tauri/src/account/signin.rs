//! The sign-in this app started, and the one link that may finish it.
//!
//! The app makes a random `verifier` and `state`, keeps both in memory for ten minutes and opens the system browser.
//! The server sends the browser back with `potato-workspace://signin?ticket=..&state=..&acct=..`. A link is untrusted
//! text from outside: it is accepted only while a sign-in this app started is pending and its `state` matches. A
//! stolen ticket is useless without the verifier, which never leaves this process.

use crate::keys::crypto::{b64, random_bytes};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

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

/// Why a link that looks like a sign-in link was refused (a reason only, never a value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Not a `potato-workspace://signin` link at all.
    NotSignIn,
    TooLong,
    /// A path, fragment, unknown or repeated key, or a missing value.
    Shape,
    /// A value with odd characters or the wrong length.
    Value,
}

impl Refused {
    pub fn why(self) -> &'static str {
        match self {
            Refused::NotSignIn => "not a sign-in link",
            Refused::TooLong => "too long",
            Refused::Shape => "unexpected shape (path, fragment, key or missing value)",
            Refused::Value => "a value has odd characters or the wrong length",
        }
    }
}

/// `%XX` decoding of one value. `None` for a broken escape or a result that is not UTF-8. A `+` stays a `+`.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A sign-in link in its fixed form, or why not. The canonical forms the browser, the OS and the `url` crate may
/// hand over are all read: any letter case in the scheme and host, a `/` before the `?` (and after the last
/// value), and `%XX` in the values. Everything else is refused: other paths, extra or repeated keys, a fragment,
/// odd characters, an over-long link.
pub fn check_link(url: &str) -> Result<SignInLink, Refused> {
    let url = url.trim().trim_matches('"').trim();
    if url.len() > 512 {
        return Err(Refused::TooLong);
    }
    const HEAD: &str = "potato-workspace://signin";
    let head = url.get(..HEAD.len()).ok_or(Refused::NotSignIn)?;
    if !head.eq_ignore_ascii_case(HEAD) {
        return Err(Refused::NotSignIn);
    }
    let rest = &url[HEAD.len()..];
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let query = rest.strip_prefix('?').ok_or(Refused::Shape)?;
    let query = query.strip_suffix('/').unwrap_or(query);
    let (mut ticket, mut state, mut account) = (None, None, None);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or(Refused::Shape)?;
        let slot = match key {
            "ticket" => &mut ticket,
            "state" => &mut state,
            "acct" => &mut account,
            _ => return Err(Refused::Shape),
        };
        if slot.is_some() {
            return Err(Refused::Shape);
        }
        *slot = Some(percent_decode(value).ok_or(Refused::Value)?);
    }
    let (Some(ticket), Some(state), Some(account)) = (ticket, state, account) else {
        return Err(Refused::Shape);
    };
    if !token_ok(&ticket, 16, 128) || !token_ok(&state, 16, 128) || !uuid_ok(&account) {
        return Err(Refused::Value);
    }
    Ok(SignInLink { ticket, state, account })
}

/// What a link looks like, for the debug log: the part before `?` (scheme, host, path), whether it was quoted,
/// and the query keys with the length of each value. Never a value. Only for links that start like ours.
pub fn link_shape(url: &str) -> Option<String> {
    let raw = url.trim();
    let quoted = raw.starts_with('"');
    let inner = raw.trim_matches('"');
    if !inner.to_ascii_lowercase().starts_with("potato-workspace://signin") {
        return None;
    }
    let (head, query) = inner.split_once('?').unwrap_or((inner, ""));
    let keys: Vec<String> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => format!("{}:{}", k.chars().take(12).collect::<String>(), v.len()),
            None => format!("{}:-", p.chars().take(12).collect::<String>()),
        })
        .collect();
    Some(format!(
        "head={head} slash_before_query={} quoted={quoted} old_1_1_8_prefix_matches={} has_fragment={} total_len={} query=[{}]",
        head.ends_with('/'),
        raw.get(.."potato-workspace://signin?".len()).is_some_and(|h| h.eq_ignore_ascii_case("potato-workspace://signin?")),
        inner.contains('#'),
        inner.len(),
        keys.join(",")
    ))
}

/// A sign-in link, or `None` for everything else.
#[cfg(test)]
pub fn parse_link(url: &str) -> Option<SignInLink> {
    check_link(url).ok()
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
