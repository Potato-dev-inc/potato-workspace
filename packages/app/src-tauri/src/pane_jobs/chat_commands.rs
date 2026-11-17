//! Commands a chat (ACP) agent runs with its own shell tool, read from the chat's tool calls.
//!
//! The process scan (`pane_jobs`) finds a command only while its process lives and only with a process id; the
//! chat knows the command's words, when it started and how it ended, even for a command that was too short to
//! catch. This is the pure part: items in, calls out. `commands` joins the two sources.

use crate::session_chat::ChatItem;
use serde_json::Value;

/// One command tool call of a chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCall {
    pub call_id: String,
    /// The command line as the agent wrote it, secrets masked.
    pub command: String,
    pub started_ms: u64,
    /// When the result came (or the turn ended under it).
    pub ended_ms: Option<u64>,
    /// `Some(true)`: it worked. `Some(false)`: it failed. `None`: still running, or the turn ended under it.
    pub ok: Option<bool>,
    /// The turn ended before the command did (the person stopped the agent): it is not running any more.
    pub cut_short: bool,
}

pub fn parse_at(at: &Option<String>) -> Option<u64> {
    let text = at.as_deref()?;
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|t| t.timestamp_millis().max(0) as u64)
}

fn command_of(input: &Option<Value>, summary: &str) -> String {
    let raw = input
        .as_ref()
        .and_then(|v| v.get("command").or_else(|| v.get("cmd")))
        .and_then(|c| match c {
            Value::String(s) => Some(s.clone()),
            Value::Array(parts) => Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
            _ => None,
        })
        .unwrap_or_else(|| summary.trim().trim_matches('`').to_string());
    let one_line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::redact::text(&one_line).into_inner()
}

/// Whether a tool call runs a shell command: the agent's own command tool (kind `execute`, shown as `run`), or any tool that
/// takes a `command` line (Claude's PowerShell and Bash arrive as kind `other`). A tool of another server (`mcp__...`, such as
/// our own `start_terminal`, which has a `command` too) is never one: the app hosts those.
fn runs_a_command(name: &str, summary: &str, input: &Option<Value>) -> bool {
    if name == "run" {
        return true;
    }
    if summary.starts_with("mcp__") {
        return false;
    }
    input.as_ref().and_then(|v| v.get("command").or_else(|| v.get("cmd"))).is_some_and(|c| c.is_string() || c.is_array())
}

/// The command calls among `items` (oldest first), each matched with its result. A turn that ended before the
/// result arrived leaves the call "cut short".
pub fn calls_of(items: &[ChatItem]) -> Vec<ChatCall> {
    let mut calls: Vec<ChatCall> = Vec::new();
    for item in items {
        match item {
            ChatItem::ToolCall { call_id, at, name, summary, detail, .. } if runs_a_command(name, summary, &detail.input) => {
                if let Some(started_ms) = parse_at(at) {
                    calls.push(ChatCall { call_id: call_id.clone(), command: command_of(&detail.input, summary), started_ms, ended_ms: None, ok: None, cut_short: false });
                }
            }
            ChatItem::ToolResult { call_id, at, ok, .. } => {
                if let Some(call) = calls.iter_mut().rev().find(|c| &c.call_id == call_id) {
                    call.ended_ms = parse_at(at);
                    call.ok = Some(*ok);
                }
            }
            ChatItem::TurnEnd { at, .. } => {
                let ended = parse_at(at);
                for call in calls.iter_mut().filter(|c| c.ended_ms.is_none() && !c.cut_short) {
                    call.cut_short = true;
                    call.ended_ms = ended;
                }
            }
            _ => {}
        }
    }
    calls
}

impl ChatCall {
    pub fn is_running(&self) -> bool {
        self.ended_ms.is_none() && !self.cut_short
    }

    pub fn ran_ms(&self, now: u64) -> u64 {
        self.ended_ms.unwrap_or(now).saturating_sub(self.started_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_chat::detail::ToolDetail;
    use crate::session_chat::model::TurnOutcome;
    use serde_json::json;

    fn call(id: &str, secs: u32, command: &str) -> ChatItem {
        ChatItem::ToolCall {
            id: format!("t:{id}"),
            at: Some(format!("2026-11-16T10:00:{secs:02}.000Z")),
            call_id: id.into(),
            name: "run".into(),
            summary: command.into(),
            detail: ToolDetail { input: Some(json!({ "command": command })), ..Default::default() },
        }
    }

    fn result(id: &str, secs: u32, ok: bool) -> ChatItem {
        ChatItem::ToolResult { id: format!("r:{id}"), at: Some(format!("2026-11-16T10:00:{secs:02}.000Z")), call_id: id.into(), ok, output: String::new() }
    }

    #[test]
    fn a_call_without_a_result_is_running_and_one_with_a_result_is_not() {
        let calls = calls_of(&[call("a", 1, "npm test"), call("b", 2, "npm run build"), result("a", 9, true)]);
        assert_eq!(calls.len(), 2);
        assert!(!calls[0].is_running() && calls[0].ok == Some(true) && calls[0].ran_ms(0) == 8_000);
        assert!(calls[1].is_running());
    }

    #[test]
    fn a_turn_that_ends_leaves_the_open_call_cut_short() {
        let end = ChatItem::TurnEnd { id: "end:1".into(), at: Some("2026-11-16T10:00:30.000Z".into()), outcome: TurnOutcome::Interrupted, duration_ms: None };
        let calls = calls_of(&[call("a", 1, "npm run dev"), end]);
        assert!(!calls[0].is_running() && calls[0].cut_short && calls[0].ok.is_none());
    }

    #[test]
    fn a_shell_tool_that_arrives_as_kind_other_is_a_command_and_an_mcp_tool_with_a_command_field_is_not() {
        let power = ChatItem::ToolCall {
            id: "t:p".into(),
            at: Some("2026-11-16T10:00:01.000Z".into()),
            call_id: "p".into(),
            name: "other".into(),
            summary: "PowerShell".into(),
            detail: ToolDetail { input: Some(json!({ "command": "npm test", "timeout": 120000 })), ..Default::default() },
        };
        let ours = ChatItem::ToolCall {
            id: "t:s".into(),
            at: Some("2026-11-16T10:00:02.000Z".into()),
            call_id: "s".into(),
            name: "other".into(),
            summary: "mcp__potato-workspace__start_terminal".into(),
            detail: ToolDetail { input: Some(json!({ "command": ["node", "server.js"] })), ..Default::default() },
        };
        let calls = calls_of(&[power, ours]);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].command, "npm test");
    }

    #[test]
    fn other_tools_are_not_commands_and_secrets_are_masked() {
        let secret = ["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].concat();
        let read = ChatItem::ToolCall { id: "t:r".into(), at: Some("2026-11-16T10:00:01.000Z".into()), call_id: "r".into(), name: "read".into(), summary: "a.txt".into(), detail: ToolDetail::default() };
        let calls = calls_of(&[read, call("a", 2, &format!("curl -H 'x: {secret}' localhost"))]);
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].command.contains("abcdefghijklmnopqrstuvwxyz"), "{}", calls[0].command);
    }
}
