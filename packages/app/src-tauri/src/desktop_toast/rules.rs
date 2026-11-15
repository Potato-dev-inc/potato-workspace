//! The pure part of the PC toast: which buttons, the words, the links the buttons carry and the one-time
//! grants behind them. No I/O here, so every rule is tested without a window.
//!
//! A button on a toast is a link (`potato-workspace://toast/<act>/<nonce>`): Windows hands it to the app
//! through the protocol handler, which also works from the Action Center and when the app was closed. A
//! link is untrusted text (any web page can open one), so it carries no answer: only a random nonce that
//! this app issued for exactly one button of one toast. A nonce works once, for a few minutes, and the
//! whole toast's other buttons die with it.

use crate::push::hub::{buttons_for, Buttons, Candidate};
use crate::push::triggers::{copy_for_view, Kind, View, Words};
use std::collections::{HashMap, VecDeque};

/// The start of every toast link.
pub const LINK_PREFIX: &str = "potato-workspace://toast/";
/// How long a button works.
pub const GRANT_TTL_MS: u64 = 10 * 60_000;
const MAX_GRANTS: usize = 128;
const MAX_SPENT: usize = 256;
const NONCE_LEN: usize = 32;
const MAX_LINK_CHARS: usize = 80;

pub const MSG_ANSWERED: &str = "This question was already answered.";
pub const MSG_EXPIRED: &str = "This question is out of date. Open the app to see it.";
pub const MSG_CHANGED: &str = "This question changed. Open the app to see it.";
pub const MSG_FAILED: &str = "Could not send your answer. Open the app.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Act {
    Allow,
    Deny,
    Yes,
    No,
    Open,
}

impl Act {
    pub fn word(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Yes => "yes",
            Self::No => "no",
            Self::Open => "open",
        }
    }

    /// The text on the button.
    pub fn label(self) -> &'static str {
        match self {
            Self::Allow => "Allow",
            Self::Deny => "Deny",
            Self::Yes => "Yes",
            Self::No => "No",
            Self::Open => "Open",
        }
    }

    fn parse(word: &str) -> Option<Self> {
        [Self::Allow, Self::Deny, Self::Yes, Self::No, Self::Open].into_iter().find(|a| a.word() == word)
    }
}

/// `potato-workspace://toast/<act>/<nonce>`.
pub fn link(act: Act, nonce: &str) -> String {
    format!("{LINK_PREFIX}{}/{nonce}", act.word())
}

/// True when the text starts like a toast link (the scheme may come in any case).
pub fn is_toast_link(url: &str) -> bool {
    url.trim().get(..LINK_PREFIX.len()).is_some_and(|head| head.eq_ignore_ascii_case(LINK_PREFIX))
}

/// A toast link read strictly: a known act and a 32-character lower-case hex nonce, nothing else (no query,
/// no fragment, no extra path). The OS may add a closing slash and change the case of the scheme.
pub fn parse_link(url: &str) -> Option<(Act, String)> {
    let url = url.trim();
    if url.len() > MAX_LINK_CHARS || !is_toast_link(url) {
        return None;
    }
    let rest = url[LINK_PREFIX.len()..].strip_suffix('/').unwrap_or(&url[LINK_PREFIX.len()..]);
    let (act, nonce) = rest.split_once('/')?;
    let act = Act::parse(act)?;
    let ok = nonce.len() == NONCE_LEN && nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    ok.then(|| (act, nonce.to_string()))
}

/// A fresh nonce: 128 random bits, as 32 hex characters.
pub fn new_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// --- which buttons -------------------------------------------------------------------------------

/// The buttons this candidate gets on the PC: the phone's rule (`push::hub::buttons_for`), and on top of it
/// the card must be known with what it showed, because the answer is checked against it.
pub fn buttons(candidate: &Candidate) -> Vec<Act> {
    let item = candidate.item.as_ref();
    match buttons_for(candidate) {
        Buttons::AllowDeny if item.is_some_and(|i| !i.fingerprint.is_empty()) => vec![Act::Allow, Act::Deny],
        Buttons::YesNo if item.is_some_and(|i| i.yes_no.is_some()) => vec![Act::Yes, Act::No],
        _ => vec![Act::Open],
    }
}

/// Only things that need the person get a toast; a finished run does not.
pub fn wants_toast(kind: Kind) -> bool {
    crate::notify_levels::level_wants(crate::notify_levels::BellLevel::Needs, kind)
}

// --- the words -----------------------------------------------------------------------------------

/// The title and up to two lines under it. The words are the phone's fullest version, redacted the same way.
pub fn words(candidate: &Candidate) -> Words {
    let full = copy_for_view(candidate.kind, &candidate.agent_label, candidate.heading.as_deref(), candidate.prompt.as_ref(), candidate.detail.as_deref(), View::Full);
    Words { title: crate::redact::text(&full.title).to_string(), body: crate::redact::text(&full.body).to_string() }
}

/// What a toast shows: a title, then the body's first line, then the rest of the body on one line.
pub fn lines(words: &Words) -> (String, Vec<String>) {
    let mut rest = words.body.split('\n').map(str::trim).filter(|l| !l.is_empty());
    let mut lines = Vec::new();
    if let Some(first) = rest.next() {
        lines.push(first.to_string());
    }
    let tail: Vec<&str> = rest.collect();
    if !tail.is_empty() {
        lines.push(tail.join(" \u{b7} "));
    }
    (words.title.trim().to_string(), lines)
}

pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// One toast, ready to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    /// A new toast with the same tag replaces the older one (one per pane or question).
    pub tag: String,
    pub title: String,
    pub lines: Vec<String>,
    /// The buttons, each with the link it opens.
    pub buttons: Vec<(Act, String)>,
    /// What clicking the toast itself opens.
    pub open_link: String,
}

/// The toast's XML (ToastGeneric). Every link is a protocol activation: the app need not be running.
pub fn toast_xml(spec: &Spec) -> String {
    let mut xml = format!("<toast launch=\"{}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\">", xml_escape(&spec.open_link));
    xml.push_str(&format!("<text>{}</text>", xml_escape(&spec.title)));
    for line in spec.lines.iter().take(2) {
        xml.push_str(&format!("<text>{}</text>", xml_escape(line)));
    }
    xml.push_str("</binding></visual><actions>");
    for (act, link) in &spec.buttons {
        xml.push_str(&format!("<action content=\"{}\" arguments=\"{}\" activationType=\"protocol\"/>", xml_escape(act.label()), xml_escape(link)));
    }
    xml.push_str("</actions></toast>");
    xml
}

/// A short message toast: no buttons, no link (the answer to a tap).
pub fn note_xml(text: &str) -> String {
    format!("<toast><visual><binding template=\"ToastGeneric\"><text>Potato Workspace</text><text>{}</text></binding></visual></toast>", xml_escape(text))
}

// --- grants --------------------------------------------------------------------------------------

/// What one button may do, once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub act: Act,
    /// The buttons of one toast share a group: using one ends them all.
    pub group: String,
    pub item_id: String,
    pub pane_id: Option<String>,
    pub prompt_id: String,
    pub occurrence: u32,
    pub fingerprint: String,
    /// The choice id to answer with (`allow_once`, `deny`, or the question's own yes / no id). `None` for Open.
    pub choice: Option<String>,
    pub expires_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Redeem {
    /// Not a button this app issued (or for another act): nothing happens.
    Unknown,
    /// Used before (this button or another button of the same toast).
    Spent,
    Expired,
    Granted(Grant),
}

#[derive(Default)]
pub struct Grants {
    map: HashMap<String, Grant>,
    spent: VecDeque<String>,
}

impl Grants {
    pub fn add(&mut self, nonce: String, grant: Grant, now_ms: u64) {
        self.map.retain(|_, g| g.expires_ms > now_ms);
        while self.map.len() >= MAX_GRANTS {
            let Some(oldest) = self.map.iter().min_by_key(|(_, g)| g.expires_ms).map(|(k, _)| k.clone()) else { break };
            self.map.remove(&oldest);
        }
        self.map.insert(nonce, grant);
    }

    /// Redeem a button. Whatever the result, the toast's other buttons stop working with it.
    pub fn redeem(&mut self, nonce: &str, act: Act, now_ms: u64) -> Redeem {
        if self.spent.iter().any(|s| s == nonce) {
            return Redeem::Spent;
        }
        match self.map.get(nonce) {
            None => return Redeem::Unknown,
            Some(g) if g.act != act => return Redeem::Unknown,
            Some(_) => {}
        }
        let grant = self.map.get(nonce).cloned().expect("checked above");
        self.end_group(&grant.group);
        if grant.expires_ms <= now_ms {
            return Redeem::Expired;
        }
        // The siblings are spent too: a second tap on Deny after Allow is "already answered".
        Redeem::Granted(grant)
    }

    fn end_group(&mut self, group: &str) {
        let gone: Vec<String> = self.map.iter().filter(|(_, g)| g.group == group).map(|(k, _)| k.clone()).collect();
        for nonce in gone {
            self.map.remove(&nonce);
            self.spent.push_back(nonce);
        }
        while self.spent.len() > MAX_SPENT {
            self.spent.pop_front();
        }
    }

    /// The pane stopped asking: its buttons stop working (a tap says "already answered").
    pub fn drop_pane(&mut self, pane_id: &str) {
        // A toast that only opens the app (an error) stays good: opening is never wrong.
        let groups: Vec<String> =
            self.map.values().filter(|g| g.pane_id.as_deref() == Some(pane_id) && g.act != Act::Open).map(|g| g.group.clone()).collect();
        for group in groups {
            self.end_group(&group);
        }
    }

    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        self.map.len()
    }
}

// --- not twice -----------------------------------------------------------------------------------

/// The same thing is not toasted twice: one memory per key (pane or question) of what was last shown.
#[derive(Default)]
pub struct Shown {
    last: HashMap<String, (String, u64)>,
}

impl Shown {
    /// True when `what` (the card or prompt id) is new for `key`, or the last toast for it is older than a
    /// grant. Remembers it when true.
    pub fn admit(&mut self, key: &str, what: &str, now_ms: u64) -> bool {
        if let Some((seen, at)) = self.last.get(key) {
            if seen == what && now_ms.saturating_sub(*at) < GRANT_TTL_MS {
                return false;
            }
        }
        if self.last.len() >= 512 {
            self.last.retain(|_, (_, at)| now_ms.saturating_sub(*at) < GRANT_TTL_MS);
        }
        self.last.insert(key.to_string(), (what.to_string(), now_ms));
        true
    }

    /// The pane left the state the toast was about: the same prompt asked again toasts again.
    pub fn forget(&mut self, key: &str) {
        self.last.remove(key);
    }
}
