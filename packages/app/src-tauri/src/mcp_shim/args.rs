//! Argument extraction and URL-encoding helpers shared by the tool dispatchers.

use super::*;

pub(crate) fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing required string argument: {key}"))
}

/// Names a caller may use for the work to do. The first one that holds text fills in `task`.
const TASK_ALIASES: [&str; 3] = ["prompt", "message", "instructions"];

/// Makes sure `body.task` holds the work to do: a call that names it `prompt`, `message` or `instructions` is read as `task`
/// (the alias is dropped), and a call with none gets one short, plain sentence (the host adds the schema itself when it
/// had not loaded it, so this stays small).
pub(crate) fn normalize_task(body: &mut Value, tool: &str) -> Result<(), String> {
    let has_task = body.get("task").and_then(Value::as_str).is_some_and(|task| !task.trim().is_empty());
    let Some(map) = body.as_object_mut() else {
        return Err(format!("{tool} needs `task`: the work to do."));
    };
    if has_task {
        return Ok(());
    }
    for alias in TASK_ALIASES {
        let text = map.get(alias).and_then(Value::as_str).filter(|text| !text.trim().is_empty()).map(str::to_owned);
        if let Some(text) = text {
            map.remove(alias);
            map.insert("task".into(), Value::String(text));
            return Ok(());
        }
    }
    Err(format!("{tool} needs `task`: the work to do."))
}

pub(crate) fn optional_number(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

pub(crate) fn assert_worker_pane(pane_id: &str) -> Result<String, String> {
    if pane_id.starts_with("potato-workspace-orchestrator-") {
        return Err(format!("refusing to target orchestrator pane: {pane_id}"));
    }
    Ok(pane_id.to_string())
}

pub(crate) fn encode_path_segment(input: &str) -> String {
    input
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
