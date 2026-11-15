//! What a permission question says about the tool call: the command it would run and the files it names. Read from the
//! request itself (raw input, locations, diffs), so a rule (`agent_rules`) can judge a question the chat has not mapped
//! yet. Kept in the wait for the rules only: it is never serialised, shown or saved.

use super::types::ToolCallUpdate;
use serde_json::Value;

const MAX_COMMAND_CHARS: usize = 2000;
const MAX_PATHS: usize = 20;

/// The command text of a tool call (`command` or `cmd`, a string or a list of words).
pub fn command_of(call: &ToolCallUpdate) -> Option<String> {
    let input = call.raw_input.as_ref()?;
    let value = input.get("command").or_else(|| input.get("cmd"))?;
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(words) => words.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => return None,
    };
    let text: String = text.trim().chars().take(MAX_COMMAND_CHARS).collect();
    (!text.is_empty()).then_some(text)
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
