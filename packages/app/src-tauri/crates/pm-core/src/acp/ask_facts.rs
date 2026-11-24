//! What a permission question says about the tool call: the command it would run and the files it names. Read from the
//! request itself (raw input, locations, diffs), so a rule (`agent_rules`) can judge a question the chat has not mapped
//! yet. Kept in the wait for the rules only: it is never serialised, shown or saved.

use super::types::ToolCallUpdate;
use serde_json::Value;

/// Above the length the risk rules read in full (4000), so a longer command is seen as too long to check, never silently cut to a safe-looking start.
const MAX_COMMAND_CHARS: usize = 8000;
const MAX_PATHS: usize = 20;

/// The command text of a tool call (`command` or `cmd`, a string or a list of words).
pub fn command_of(call: &ToolCallUpdate) -> Option<String> {
    command_in(call.raw_input.as_ref()?)
}

/// The same, from a raw input alone (what the chat kept of the tool call that came before the question).
pub fn command_in(input: &Value) -> Option<String> {
    let value = input.get("command").or_else(|| input.get("cmd"))?;
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(words) => words.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => return None,
    };
    let text: String = text.trim().chars().take(MAX_COMMAND_CHARS).collect();
    (!text.is_empty()).then_some(text)
}

/// The longest title read as a command.
const TITLE_COMMAND_MAX: usize = 2000;

/// Some agents (Agy) put the command only in the question's title (`dir`, `Run command: dir`, or a whole script) and send no
/// `rawInput`: for a command question the title then is the command text. A title that was cut (too long, or ending in an
/// ellipsis) is not the whole command, so it is none. The risk rules judge the text like any other.
pub fn title_command(kind: Option<&str>, title: &str) -> Option<String> {
    if kind != Some("execute") {
        return None;
    }
    let title = title.trim();
    let title = ["Run command:", "Run command", "Running command:"].iter().find_map(|p| title.strip_prefix(p)).unwrap_or(title).trim();
    if title.is_empty() || title.chars().count() > TITLE_COMMAND_MAX || title.ends_with('…') || title.ends_with("...") {
        return None;
    }
    Some(title.to_string())
}

/// The files a tool call names: its locations, the paths of its diffs and the usual path keys of its input.
pub fn paths_of(call: &ToolCallUpdate) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |path: &str| {
        let path = path.trim();
        if !path.is_empty() && out.len() < MAX_PATHS && !out.iter().any(|known| known == path) {
            out.push(path.to_string());
        }
    };
    for location in call.locations.iter().flatten() {
        if let Some(path) = location.get("path").and_then(Value::as_str) {
            add(path);
        }
    }
    for block in call.content.iter().flatten() {
        if block.get("type").and_then(Value::as_str) == Some("diff") {
            if let Some(path) = block.get("path").and_then(Value::as_str) {
                add(path);
            }
        }
    }
    if let Some(input) = &call.raw_input {
        for path in crate::session_chat::detail::paths_from_input(input) {
            add(&path);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(raw: Value, locations: Option<Vec<Value>>, content: Option<Vec<Value>>) -> ToolCallUpdate {
        ToolCallUpdate { tool_call_id: "t".into(), title: None, kind: None, status: None, content, locations, raw_input: Some(raw), raw_output: None }
    }

    #[test]
    fn the_command_is_read_from_a_string_or_a_list_of_words() {
        assert_eq!(command_of(&call(json!({"command": "ls -la"}), None, None)).as_deref(), Some("ls -la"));
        assert_eq!(command_of(&call(json!({"command": ["git", "status"]}), None, None)).as_deref(), Some("git status"));
        assert_eq!(command_of(&call(json!({"cmd": "  "}), None, None)), None);
        assert_eq!(command_of(&call(json!({"other": 1}), None, None)), None);
    }

    #[test]
    fn paths_come_from_locations_diffs_and_input_without_repeats() {
        let found = paths_of(&call(
            json!({"file_path": "src/a.rs"}),
            Some(vec![json!({"path": "src/a.rs"}), json!({"path": "src/b.rs"})]),
            Some(vec![json!({"type": "diff", "path": "src/c.rs", "newText": "x"})]),
        ));
        assert_eq!(found, ["src/a.rs", "src/b.rs", "src/c.rs"]);
    }
}
