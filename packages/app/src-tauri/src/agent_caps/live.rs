//! Turns what a live chat shows into `SeenFact`s. Pure and small: `acp/session.rs` owns one `TurnSeen` per session,
//! feeds it every update and permission question of the turn, and records what comes out (`record_seen`).
//! Each kind of fact comes out once per turn, so a busy turn writes the store a few times, not once per tool call.

use std::collections::{HashMap, HashSet};

use super::SeenFact;
use crate::acp::types::{SessionUpdate, ToolStatus};

#[derive(Debug, Default)]
pub struct TurnSeen {
    kinds: HashMap<String, String>,
    asked: HashSet<String>,
    sent: HashSet<(u8, bool)>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl TurnSeen {
    /// A new turn starts.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The agent asked permission for this tool call.
    pub fn asked(&mut self, tool_call_id: &str) {
        self.asked.insert(tool_call_id.to_string());
    }

    /// Facts this update shows that were not reported yet in this turn.
    pub fn on_update(&mut self, update: &SessionUpdate) -> Vec<SeenFact> {
        let mut out = Vec::new();
        let mut push = |me: &mut Self, key: (u8, bool), fact: SeenFact| {
            if me.sent.insert(key) {
                out.push(fact);
            }
        };
        match update {
            SessionUpdate::ToolCall(call) => {
                self.kinds.insert(call.tool_call_id.clone(), call.kind.clone());
                push(self, (0, false), SeenFact::ToolCall { at: now() });
                if call.status == ToolStatus::Completed {
                    let fact = self.done(&call.tool_call_id, &call.kind);
                    if let Some((key, fact)) = fact {
                        push(self, key, fact);
                    }
                }
            }
            SessionUpdate::ToolCallUpdate(change) => {
                if let Some(kind) = &change.kind {
                    self.kinds.insert(change.tool_call_id.clone(), kind.clone());
                }
                if change.status == Some(ToolStatus::Completed) {
                    let kind = self.kinds.get(&change.tool_call_id).cloned().unwrap_or_default();
                    if let Some((key, fact)) = self.done(&change.tool_call_id, &kind) {
                        push(self, key, fact);
                    }
                }
            }
            SessionUpdate::UsageUpdate(_) => push(self, (5, false), SeenFact::Usage { at: now() }),
            _ => {}
        }
        out
    }

    /// A tool call finished: a file change or a command, and whether the agent asked first.
    fn done(&self, tool_call_id: &str, kind: &str) -> Option<((u8, bool), SeenFact)> {
        let asked = self.asked.contains(tool_call_id);
        match kind {
            "edit" | "delete" | "move" => Some(((1, asked), SeenFact::EditDone { at: now(), asked })),
            "execute" => Some(((2, asked), SeenFact::ShellDone { at: now(), asked })),
            _ => None,
        }
    }
}
