//! "Device activity": one line per remote action, on both sides.
//!
//! - The far side's line is the record of truth: `Desk-PC started an agent here` (`Dir::In`, written by the serving
//!   side for what a device did on this PC).
//! - The sender keeps the mirror line: `Started an agent on Mac mini` (`Dir::Out`).
//!
//! A line is only a time, a device, a direction and a **kind** (a word from a closed list). It never holds a prompt, a
//! message, a path, a file name, a pane title or a token: the kind is worked out from the method and the shape of the
//! route, and the body is never read. The page words each kind itself (so the log is the same in every language).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::route::PrefsStore;

/// The most lines kept (oldest go first).
const KEEP: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    /// A device did it on this PC.
    In,
    /// This PC did it on a device.
    Out,
}

/// What happened, as a closed list the page has words for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Connected,
    Started,
    Typed,
    Messaged,
    Answered,
    Stopped,
    Changed,
    Refused,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Connected => "connected",
            Kind::Started => "started",
            Kind::Typed => "typed",
            Kind::Messaged => "messaged",
            Kind::Answered => "answered",
            Kind::Stopped => "stopped",
            Kind::Changed => "changed",
            Kind::Refused => "refused",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Kind::Connected, Kind::Started, Kind::Typed, Kind::Messaged, Kind::Answered, Kind::Stopped, Kind::Changed, Kind::Refused]
            .into_iter()
            .find(|k| k.as_str() == text)
    }
}

/// What a request is, from its method and the shape of its path only. `None`: a read (not logged).
pub fn classify(method: &str, target: &str) -> Option<Kind> {
    if method == "GET" {
        return None;
    }
    let path = target.split('?').next().unwrap_or("");
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    Some(match (method, segs.as_slice()) {
        ("DELETE", _) => Kind::Stopped,
        ("POST", ["panes"]) | ("POST", ["phone", "chats"]) | ("POST", ["acp", "sessions"]) | ("POST", ["chats"]) => Kind::Started,
        (_, [_, _, "input" | "keys" | "type" | "paste"]) | (_, ["panes", _, "terminal"]) => Kind::Typed,
        (_, [.., "messages" | "send"]) => Kind::Messaged,
        (_, [.., "answer" | "permission" | "approve" | "allow" | "deny" | "respond"]) => Kind::Answered,
        (_, [.., "cancel" | "stop" | "interrupt" | "kill" | "close"]) => Kind::Stopped,
        _ => Kind::Changed,
    })
}

#[derive(Debug, Clone)]
struct Entry {
    at: u64,
    node: String,
    name: String,
    dir: Dir,
    kind: Kind,
}

pub struct ActivityLog {
    entries: Mutex<VecDeque<Entry>>,
    store: Arc<dyn PrefsStore>,
}

impl ActivityLog {
    pub fn new(store: Arc<dyn PrefsStore>) -> Arc<Self> {
        let log = Self { entries: Mutex::new(VecDeque::new()), store };
        log.load();
        Arc::new(log)
    }

    fn load(&self) {
        let Some(text) = self.store.load() else { return };
        let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(&text) else { return };
        let mut out = VecDeque::new();
        for r in rows.iter().rev().take(KEEP).rev() {
            let (Some(at), Some(node), Some(kind)) = (r["at"].as_u64(), r["node"].as_str(), r["kind"].as_str().and_then(Kind::parse)) else { continue };
            let dir = if r["dir"] == "out" { Dir::Out } else { Dir::In };
            out.push_back(Entry { at, node: node.chars().take(64).collect(), name: r["name"].as_str().unwrap_or("").chars().take(60).collect(), dir, kind });
        }
        *self.entries.lock().unwrap_or_else(|p| p.into_inner()) = out;
    }

    fn rows(entries: &VecDeque<Entry>) -> Vec<Value> {
        entries
            .iter()
            .map(|e| json!({ "at": e.at, "node": e.node, "name": e.name, "dir": if e.dir == Dir::In { "in" } else { "out" }, "kind": e.kind.as_str() }))
            .collect()
    }

    pub fn record(&self, now: u64, node: &str, name: &str, dir: Dir, kind: Kind) {
        let text = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            if entries.len() >= KEEP {
                entries.pop_front();
            }
            entries.push_back(Entry { at: now, node: node.to_string(), name: name.to_string(), dir, kind });
            Value::Array(Self::rows(&entries)).to_string()
        };
        // Best effort: a log that cannot be saved is still shown until the app closes.
        let _ = self.store.save(&text);
    }

    /// Newest first. `node`: only that device's lines.
    pub fn list(&self, node: Option<&str>) -> Vec<Value> {
        let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let mut rows = Self::rows(&entries);
        rows.reverse();
        match node {
            Some(n) => rows.into_iter().filter(|r| r["node"] == n).collect(),
            None => rows,
        }
    }

    /// A device was removed: its lines go with it.
    pub fn forget(&self, node: &str) {
        let text = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            entries.retain(|e| e.node != node);
            Value::Array(Self::rows(&entries)).to_string()
        };
        let _ = self.store.save(&text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_link::route::MemoryPrefs;

    #[test]
    fn a_request_is_named_by_its_shape_and_a_read_is_not_logged() {
        assert_eq!(classify("GET", "/panes"), None);
        assert_eq!(classify("POST", "/panes"), Some(Kind::Started));
        assert_eq!(classify("POST", "/phone/chats"), Some(Kind::Started));
        assert_eq!(classify("POST", "/panes/p1/input"), Some(Kind::Typed));
        assert_eq!(classify("POST", "/panes/p1/messages"), Some(Kind::Messaged));
        assert_eq!(classify("POST", "/attention/a1/answer"), Some(Kind::Answered));
        assert_eq!(classify("POST", "/acp/sessions/p1/cancel"), Some(Kind::Stopped));
        assert_eq!(classify("DELETE", "/panes/p1"), Some(Kind::Stopped));
        assert_eq!(classify("PATCH", "/panes/p1"), Some(Kind::Changed));
    }

    #[test]
    fn the_log_keeps_the_newest_lines_and_survives_a_restart() {
        let store = MemoryPrefs::new();
        let log = ActivityLog::new(store.clone());
        for i in 0..(KEEP as u64 + 20) {
            log.record(i, "aa", "Desk-PC", Dir::In, Kind::Typed);
        }
        let rows = log.list(None);
        assert_eq!(rows.len(), KEEP);
        assert_eq!(rows[0]["at"], KEEP as u64 + 19, "newest first");
        let again = ActivityLog::new(store);
        assert_eq!(again.list(None).len(), KEEP);
        again.record(1, "bb", "Mac", Dir::Out, Kind::Started);
        assert_eq!(again.list(Some("bb")).len(), 1);
        again.forget("bb");
        assert!(again.list(Some("bb")).is_empty());
    }

    #[test]
    fn a_line_holds_only_words_from_the_closed_list() {
        let log = ActivityLog::new(MemoryPrefs::new());
        log.record(5, "aa", "Desk-PC", Dir::Out, Kind::Messaged);
        let row = &log.list(None)[0];
        let keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
        for k in ["at", "node", "name", "dir", "kind"] {
            assert!(keys.contains(&k));
        }
        assert_eq!(keys.len(), 5, "nothing else is kept: {row}");
    }
}
