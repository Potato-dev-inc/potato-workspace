//! Closed chats: the conversations a person closed, which stay on disk until the 200-record cap. They can be listed,
//! brought back (the same way a restart brings a chat back: nothing runs until it is used), or deleted for good.
//!
//! Deleting removes our own record and our own journal files (`acp/journals/<id>.jsonl` and `.prev.jsonl`) and nothing
//! else; the agent's own session files are never touched. Nothing here names an agent: the label comes from the registry.

use std::io::{BufRead, BufReader};

use serde::Serialize;
use serde_json::Value;

use super::conversations::{ConversationError, Conversations};
use super::record::LastState;

/// How many characters of the first message are kept as the title.
const TITLE_CHARS: usize = 80;

/// A closed conversation as the "Closed chats" list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClosedChat {
    pub id: String,
    pub agent: String,
    /// The agent's name for people (from the registry; the id if the agent is gone).
    pub label: String,
    pub cwd: String,
    /// When it was last used (milliseconds since 1970).
    pub updated_ms: u64,
    /// The first thing the person said, if the journal has it.
    pub title: Option<String>,
}

/// The first message of the person in a journal file: one line at a time, so a big file is not read whole.
fn first_user_message(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(item) = value.get("item") else { continue };
        if item.get("kind").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = item.get("text").and_then(Value::as_str).unwrap_or("");
        let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if one_line.is_empty() {
            continue;
        }
        return Some(if one_line.chars().count() > TITLE_CHARS { format!("{}…", one_line.chars().take(TITLE_CHARS).collect::<String>().trim_end()) } else { one_line });
    }
    None
}

impl Conversations {
    /// Every closed conversation, the most recently used first.
    pub fn closed_list(&self) -> Vec<ClosedChat> {
        let mut records: Vec<_> = self.0.records.lock().iter().filter(|r| r.last_known_state == LastState::Closed).cloned().collect();
        records.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
        records
            .into_iter()
            .map(|r| ClosedChat {
                label: self.0.agents.config(&r.agent).map(|c| c.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| r.agent.clone()),
                title: first_user_message(&self.journal_path(&r.id)),
                id: r.id,
                agent: r.agent,
                cwd: r.cwd,
                updated_ms: r.updated_ms,
            })
            .collect()
    }

    /// Brings a closed conversation back as a live one, the way a restart does (nothing is started). The caller then
    /// makes its chat pane (`chat::restore_panes`). Refused for a conversation that is not closed. If the agent is gone
    /// or off, the conversation stays closed and the error says so.
    pub fn reopen_closed(&self, id: &str) -> Result<(), ConversationError> {
        let record = self.record(id).ok_or(ConversationError::Unknown)?;
        if record.last_known_state != LastState::Closed {
            return Err(ConversationError::Unknown);
        }
        self.restore_one(&record, true)?;
        self.update(id, |r| {
            r.last_known_state = LastState::Live;
            r.terminal_pane = None;
        });
        Ok(())
    }

    /// Deletes a closed conversation for good: its record and its journal files. Refused for any other state.
    pub fn delete_closed(&self, id: &str) -> Result<(), ConversationError> {
        let removed = self.remove_closed(|r| r.id == id);
        if removed == 0 {
            return Err(ConversationError::Unknown);
        }
        Ok(())
    }

    /// Deletes every closed conversation. Returns how many.
    pub fn delete_all_closed(&self) -> usize {
        self.remove_closed(|_| true)
    }

    fn remove_closed(&self, pick: impl Fn(&super::record::ConversationRecord) -> bool) -> usize {
        let gone: Vec<_> = {
            let mut records = self.0.records.lock();
            let (gone, kept): (Vec<_>, Vec<_>) = records.drain(..).partition(|r| r.last_known_state == LastState::Closed && pick(r));
            *records = kept;
            gone
        };
        if gone.is_empty() {
            return 0;
        }
        for r in &gone {
            self.0.supervisor.remove(&r.id);
            self.0.writers.forget(&r.id);
        }
        self.0.store.drop_journals(&gone);
        self.save();
        gone.len()
    }
}
