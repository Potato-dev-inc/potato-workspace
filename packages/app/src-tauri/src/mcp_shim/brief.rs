//! `detail: "brief"` and `max_result_chars` on the tools that return runs.
//!
//! The default stays `full` (every field, as before). `brief` keeps what a caller reads next: the
//! handle, status, result, `verified` with its reason, the non-default `guarantees`, warnings, the
//! model that ran and what to call next. It leaves out nulls, empty lists, the ids and the receipt
//! the other fields already say. A long `result` is cut at `max_result_chars` (default 12000 in
//! brief) with `result_truncated: true` and a `more` handle to read the rest.

use super::*;

pub(crate) const DEFAULT_BRIEF_RESULT_CHARS: usize = 12_000;

/// What the caller asked for on a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Shape {
    pub brief: bool,
    pub max_result_chars: Option<usize>,
}

/// Removes and parses `detail` / `max_result_chars` from the arguments of the tools that return runs.
pub(crate) fn take_shape(tool: &str, args: &mut Value) -> Result<Option<Shape>, String> {
    if !matches!(tool, "run_agent" | "wait_agents" | "followup_task" | "inspect_agent") {
        return Ok(None);
    }
    let Some(object) = args.as_object_mut() else { return Ok(None) };
    let detail = object.remove("detail");
    let max = object.remove("max_result_chars");
    let brief = match detail.as_ref().map(|v| v.as_str().unwrap_or_default()) {
        None | Some("full") => false,
        Some("brief") => true,
        Some(other) => return Err(format!("invalid detail {other:?}: expected brief or full")),
    };
    let max_result_chars = match max {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64() {
            Some(n) if (200..=1_000_000).contains(&n) => Some(n as usize),
            _ => return Err("invalid max_result_chars: expected a whole number from 200 to 1000000".into()),
        },
    };
    Ok(Some(Shape { brief, max_result_chars }))
}

/// Applies `shape` to a tool result (one run, or a list of runs under `agents`).
pub(crate) fn apply(value: &mut Value, shape: Shape) {
    let cap = shape.max_result_chars.or(shape.brief.then_some(DEFAULT_BRIEF_RESULT_CHARS));
    let Some(object) = value.as_object_mut() else { return };
    if let Some(agents) = object.get_mut("agents").and_then(Value::as_array_mut) {
        for run in agents.iter_mut() {
            shape_run(run, shape.brief, cap);
        }
    } else if object.contains_key("handle") {
        shape_run(value, shape.brief, cap);
    }
}

fn shape_run(run: &mut Value, brief: bool, cap: Option<usize>) {
    cut_result(run, cap);
    if brief {
        *run = brief_run(run);
    }
}

/// Cuts `result` to `cap` characters and says where the rest is.
fn cut_result(run: &mut Value, cap: Option<usize>) {
    let Some(cap) = cap else { return };
    let Some(object) = run.as_object_mut() else { return };
    let Some(text) = object.get("result").and_then(Value::as_str) else { return };
    let total = text.chars().count();
    if total <= cap {
        return;
    }
    let kept: String = text.chars().take(cap).collect();
    let handle = object.get("handle").cloned().unwrap_or(Value::Null);
    object.insert("result".into(), Value::String(kept));
    object.insert("result_truncated".into(), Value::Bool(true));
    object.insert("result_chars".into(), json!(total));
    object.insert("more".into(), json!({ "tool": "agent_transcript", "args": { "handle": handle } }));
}

fn brief_run(run: &Value) -> Value {
    let get = |key: &str| run.get(key).cloned().unwrap_or(Value::Null);
    let receipt = run.get("receipt");
    let structured = receipt.and_then(|r| r.get("structured_result"));
    let mut out = serde_json::Map::new();
    for key in ["handle", "name", "next_cursor", "status", "stage", "result", "result_truncated", "result_chars", "more"] {
        out.insert(key.into(), get(key));
    }
    out.insert("summary".into(), structured.and_then(|s| s.get("summary")).cloned().unwrap_or(Value::Null));
    out.insert("verified_reason".into(), get("verified_reason"));
    // `verified` is shown even when null: a caller must see that nothing was verified.
    out.insert("verified".into(), get("verified"));
    out.insert("guarantees".into(), non_default_guarantees(run.get("guarantees")));
    for key in ["warnings", "error", "prompt", "lane_used", "lane_reason", "lane_fallback", "adjusted", "next", "watch_command", "pane_id"] {
        out.insert(key.into(), get(key));
    }
    let model = run
        .get("resolved_model")
        .filter(|m| !m.is_null())
        .or_else(|| run.get("model").filter(|m| !m.is_null()))
        .cloned()
        .unwrap_or(Value::Null);
    out.insert("model".into(), model);
    out.insert("timing".into(), receipt.and_then(|r| r.get("timing")).cloned().unwrap_or(Value::Null));
    if out.get("next").map_or(true, Value::is_null) {
        let next = match run.get("status").and_then(Value::as_str) {
            Some("running") => json!(["wait_agents"]),
            Some("needs_input") => json!(["answer_prompt"]),
            Some("completed") | Some("failed") | Some("interrupted") => json!(["followup_task", "close_agent"]),
            _ => Value::Null,
        };
        out.insert("next".into(), next);
    }
    if out.get("result_truncated") == Some(&json!(false)) {
        out.remove("result_truncated");
    }
    let mut brief = Value::Object(out);
    // `verified` stays even when null.
    let verified = get("verified");
    strip_empty(&mut brief);
    if let Some(map) = brief.as_object_mut() {
        map.insert("verified".into(), verified);
    }
    brief
}

/// Only the parts of `guarantees` that say something: read-only when asked, a worktree, checks that
/// exist, a model that was asked for.
fn non_default_guarantees(guarantees: Option<&Value>) -> Value {
    let Some(g) = guarantees.and_then(Value::as_object) else { return Value::Null };
    let mut out = serde_json::Map::new();
    if let Some(read_only) = g.get("read_only").filter(|r| r.get("requested") == Some(&json!(true))) {
        out.insert("read_only".into(), read_only.clone());
    }
    if let Some(isolation) = g.get("isolation").filter(|i| i.get("mode") != Some(&json!("project_folder"))) {
        out.insert("isolation".into(), isolation.clone());
    }
    if let Some(checks) = g.get("checks").filter(|c| c.get("state") != Some(&json!("none"))) {
        out.insert("checks".into(), checks.clone());
    }
    if let Some(model) = g.get("model").filter(|m| m.get("asked").is_some_and(|a| !a.is_null())) {
        out.insert("model".into(), model.clone());
    }
    Value::Object(out)
}

/// Drops nulls, empty strings, empty lists and empty objects, all the way down.
pub(crate) fn strip_empty(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for child in object.values_mut() {
                strip_empty(child);
            }
            object.retain(|_, child| !is_empty(child));
        }
        Value::Array(items) => {
            for child in items.iter_mut() {
                strip_empty(child);
            }
        }
        _ => {}
    }
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(object) => object.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
#[path = "brief_tests.rs"]
mod tests;
