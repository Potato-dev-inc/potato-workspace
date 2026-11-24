//! "Your draft follows you": the half-written message of a chat, kept by the PC in MEMORY so the phone and the desktop
//! can hand it to each other. Last writer wins. Nothing is written to disk, nothing is logged, and only the words are
//! kept (never an attachment). A draft is the person's own typing, so it is not redacted; it only leaves the PC for a
//! paired phone that may read this agent (`GET /panes/{id}/draft` meets the agent's remote rule like the chat does).
//!
//! The composer on each side loads it only when its own box is empty and never overwrites what is being typed.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// A longer draft is cut here (the message box takes at most this many characters, `pane_outbox`).
pub const MAX_CHARS: usize = 8000;
/// At most this many chats keep a draft; the one written longest ago goes first.
pub const MAX_DRAFTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub text: String,
    /// When it was written (ms since 1970).
    pub at: u64,
}

#[derive(Default)]
pub struct Drafts {
    by_pane: Mutex<HashMap<String, Draft>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Drafts {
    /// The draft of this chat, or `None` when there is none.
    pub fn get(&self, pane_id: &str) -> Option<Draft> {
        lock(&self.by_pane).get(pane_id).cloned()
    }

    /// Keeps `text` as the draft of this chat (it replaces the earlier one). Blank text drops the draft. Returns what is
    /// kept now.
    pub fn set(&self, pane_id: &str, text: &str, now_ms: u64) -> Option<Draft> {
        let mut map = lock(&self.by_pane);
        if text.trim().is_empty() {
            map.remove(pane_id);
            return None;
        }
        let kept: String = text.chars().take(MAX_CHARS).collect();
        let draft = Draft { text: kept, at: now_ms };
        map.insert(pane_id.to_string(), draft.clone());
        while map.len() > MAX_DRAFTS {
            let Some(oldest) = map.iter().min_by_key(|(_, d)| d.at).map(|(k, _)| k.clone()) else { break };
            map.remove(&oldest);
        }
        Some(draft)
    }

    /// The chat is gone: so is its draft.
    #[cfg(any(test, feature = "test-util"))]
    pub fn forget(&self, pane_id: &str) {
        lock(&self.by_pane).remove(pane_id);
    }
}

/// The drafts of this run of the app.
pub fn app_drafts() -> &'static Drafts {
    static DRAFTS: OnceLock<Drafts> = OnceLock::new();
    DRAFTS.get_or_init(Drafts::default)
}

/// The answer of the read and write routes: `{ text, at }` (empty text and `at: 0` when there is no draft).
pub fn answer(draft: Option<Draft>) -> serde_json::Value {
    match draft {
        Some(d) => serde_json::json!({ "text": d.text, "at": d.at }),
        None => serde_json::json!({ "text": "", "at": 0 }),
    }
}

#[cfg(test)]
#[path = "draft_tests.rs"]
mod tests;
