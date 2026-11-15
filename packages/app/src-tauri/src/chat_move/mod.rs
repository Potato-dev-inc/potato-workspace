//! Move a chat to another device (Devices phase 5, `DEVICES-RUNTIMES-1115.md` section 2.9).
//!
//! Two ways, both started from the chat's menu (`Move to...`):
//!
//! - **Take the conversation.** The history goes along as text; the new agent reads it first. Works between any two
//!   agents. The text is the chat's own Markdown export (`session_chat::export_md`), so it is already redacted.
//! - **Take the conversation and the work.** Also the project state, done with git (`work.rs`): the work is saved to a
//!   branch `potato/move-<id>` without touching the working folder, a git bundle crosses the link, and the far device
//!   checks the branch out. Only for a git folder and the same agent type on the far side.
//!
//! This file is the book of moves: which chats are moving (locked), and which have moved (read-only, with a note).
//! Nothing here sends anything; the window drives the far device through the ordinary link (`devices_request`).
//! Sign-ins never move: nothing here reads or sends one.
//!
//! The book is kept in a small file in the app's data folder (`moved-chats.json`): device name, time and the far chat's
//! id, never any chat text.

pub mod work;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// Shown when a reply is still running.
pub const REPLY_RUNNING: &str = "Wait for the reply to finish, or stop it.";
/// Shown when a message is sent to a chat that is moving.
pub const MOVING_NOW: &str = "This chat is moving to another device. Wait a moment.";
/// Shown when a chat that already moved is moved again, or written to.
pub const ALREADY_MOVED: &str = "This chat has moved to another device. Open it there to carry on.";
/// The most history text that goes along (characters). Longer: the start and the end are kept.
pub const HISTORY_MAX_CHARS: usize = 400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Moved {
    /// The far device's node id (hex), to open the chat there.
    pub node: String,
    /// The far device's name when the chat moved (the person's own name for it).
    pub device: String,
    /// The chat's id on the far device.
    pub far_pane: String,
    /// Unix seconds.
    pub at: u64,
    /// `history` or `work`.
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    None,
    Moving { mode: String },
    Moved(Moved),
}

#[derive(Debug, Clone)]
enum Entry {
    Moving(String),
    Moved(Moved),
}

/// Which chats are moving and which have moved. Moving lives in memory only (a restart unlocks the chat); moved is kept.
pub struct Book {
    file: Option<PathBuf>,
    map: Mutex<HashMap<String, Entry>>,
}

impl Book {
    pub fn new(file: Option<PathBuf>) -> Self {
        let mut map = HashMap::new();
        if let Some(path) = &file {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(saved) = serde_json::from_str::<HashMap<String, Moved>>(&text) {
                    map.extend(saved.into_iter().map(|(pane, m)| (pane, Entry::Moved(m))));
                }
            }
        }
        Self { file, map: Mutex::new(map) }
    }

    fn save(&self, map: &HashMap<String, Entry>) {
        let Some(path) = &self.file else { return };
        let moved: HashMap<&String, &Moved> = map.iter().filter_map(|(k, v)| if let Entry::Moved(m) = v { Some((k, m)) } else { None }).collect();
        if let Ok(text) = serde_json::to_string(&moved) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, text);
        }
    }

    /// Locks the chat for a move. `running`: a reply is still going. Refusals are plain words for the person.
    pub fn begin(&self, pane: &str, running: bool, mode: &str) -> Result<(), String> {
        if !matches!(mode, "history" | "work") {
            return Err("That is not a way to move a chat.".into());
        }
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        match map.get(pane) {
            Some(Entry::Moved(_)) => return Err(ALREADY_MOVED.into()),
            Some(Entry::Moving(_)) => return Err(MOVING_NOW.into()),
            None => {}
        }
        if running {
            return Err(REPLY_RUNNING.into());
        }
        map.insert(pane.to_string(), Entry::Moving(mode.to_string()));
        Ok(())
    }

    /// The move did not happen: the chat is open again.
    pub fn abort(&self, pane: &str) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(map.get(pane), Some(Entry::Moving(_))) {
            map.remove(pane);
        }
    }

    /// The move worked: the chat stays, read-only, with the note.
    pub fn finish(&self, pane: &str, moved: Moved) -> Result<(), String> {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if !matches!(map.get(pane), Some(Entry::Moving(_))) {
            return Err("That chat is not moving.".into());
        }
        map.insert(pane.to_string(), Entry::Moved(moved));
        self.save(&map);
        Ok(())
    }

    pub fn status(&self, pane: &str) -> Status {
        match self.map.lock().unwrap_or_else(|p| p.into_inner()).get(pane) {
            None => Status::None,
            Some(Entry::Moving(mode)) => Status::Moving { mode: mode.clone() },
            Some(Entry::Moved(m)) => Status::Moved(m.clone()),
        }
    }

    /// Why a message to this chat is refused (a chat that is moving, or has moved), or `None`.
    pub fn send_refusal(&self, pane: &str) -> Option<String> {
        match self.map.lock().unwrap_or_else(|p| p.into_inner()).get(pane) {
            None => None,
            Some(Entry::Moving(_)) => Some(MOVING_NOW.into()),
            Some(Entry::Moved(_)) => Some(ALREADY_MOVED.into()),
        }
    }
}

/// The app's one book.
pub fn book() -> &'static Book {
    static BOOK: OnceLock<Book> = OnceLock::new();
    BOOK.get_or_init(|| Book::new(Some(crate::app_paths::app_data_dir().join("moved-chats.json"))))
}

/// The history as it goes to the new agent: a short instruction, then the conversation. Too long: the start and the
/// end are kept and the middle is said to be left out.
pub fn history_message(markdown: &str, from_agent: &str, from_device: &str) -> String {
    let body = clip_middle(markdown.trim(), HISTORY_MAX_CHARS);
    format!(
        "This conversation was moved to you from {from_agent} on {from_device}. Read it first. It is the history so far. Do not repeat it back. Carry on from the end, and answer questions about it from what it says.\n\n--- conversation so far ---\n{body}\n--- end of the conversation so far ---\n\nReply with one short line saying you have read it and are ready."
    )
}

fn clip_middle(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let head = max / 4;
    let tail = max - head;
    let start: String = chars[..head].iter().collect();
    let end: String = chars[chars.len() - tail..].iter().collect();
    format!("{start}\n\n[... the middle of the conversation was left out because it is long ...]\n\n{end}")
}
