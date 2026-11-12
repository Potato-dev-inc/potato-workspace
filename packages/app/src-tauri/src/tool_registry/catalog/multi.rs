//! Catalog entries: more than one agent at once (`run_agents`) and a second opinion by another agent
//! (`review_agent`, and the `review_by` field of `run_agent`). Kept apart from `agents.rs` so the big
//! `run_agent` entry stays untouched; [`add_review_by`] writes the one extra field into it.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::{json, Value};

/// The `review_by` object, shared by `run_agent` and `review_agent`'s own fields.
fn review_by_schema() -> Value {
    json!({
        "type":"object",
        "description":"After the run ends with changes, a different agent reviews the diff read-only; verdict and up to 10 findings come back as `review`. The same agent is refused unless allow_same.",
        "properties":{
            "agent_type":{"type":"string"},
            "model":{"type":"string"},
            "allow_same":{"type":"boolean","default":false,"description":"Let the author's own agent review."}
        },
        "additionalProperties":false
    })
}

/// Adds `review_by` to the `run_agent` input schema.
pub(super) fn add_review_by(all: &mut [ToolDefinition]) {
    if let Some(run) = all.iter_mut().find(|tool| tool.name == "run_agent") {
        if let Some(properties) = run.input_schema.get_mut("properties").and_then(Value::as_object_mut) {
            properties.insert("review_by".into(), review_by_schema());
        }
    }
}

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "review_agent",
            description: "Ask a different installed agent for a read-only second opinion on what a finished run changed. Returns {review:{by, verdict:pass|concerns|fail|unknown, findings:[{file,line,note}] (max 10), handle}}; review.skipped when nothing changed. Same agent refused (SAME_AGENT_REVIEWER) unless allow_same. Still running after wait_ms: review.state running plus the handle for wait_agents.",
            input_schema: object_schema(json!({"handle":{"type":"string","description":"The run to review (from run_agent)."},"project_path":{"type":"string"},"agent_type":agent_type_schema(),"model":{"type":"string"},"allow_same":{"type":"boolean","default":false},"wait_ms":{"type":"integer","minimum":0,"maximum":290000,"default":120000}}), vec!["handle"]),
            output_schema: Some(json!({"type":"object","properties":{"handle":{"type":"string"},"review":{"type":"object"}},"required":["review"]})),
            safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/review",
        },
        ToolDefinition {
            name: "run_agents",
            description: "Start several helpers in one call and collect them together. tasks[] are run_agent arguments (defaults{} fills shared ones); until: all (default), any, first_success. Returns one size-capped result with a handle per task; a task that cannot start comes back with its own error. At most \"Most helpers at once\" (Settings > Agents, default 8) run together; the rest queue. Still running at wait_ms: handles for wait_agents.",
            input_schema: object_schema(json!({
                "tasks":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","properties":{"task":{"type":"string"},"name":{"type":"string"},"agent_type":agent_type_schema(),"project_path":{"type":"string"},"model":{"type":"string"},"read_only":{"type":"boolean"},"isolation":{"type":"string","enum":["none","worktree"]},"review_by":review_by_schema()},"required":["task"],"additionalProperties":true}},
                "defaults":{"type":"object","description":"run_agent arguments every task starts from; a task's own value wins.","additionalProperties":true},
                "until":{"type":"string","enum":["all","any","first_success"],"default":"all"},
                "wait_ms":{"type":"integer","minimum":0,"maximum":3600000,"default":120000},
                "cancel_rest":{"type":"boolean","default":false,"description":"With until any or first_success: stop the helpers still running once the batch is decided."},
                "idempotency_key":{"type":"string"}
            }), vec!["tasks"]),
            output_schema: Some(json!({"type":"object","properties":{"runs":{"type":"array","items":{"type":"object"}},"reason":{"type":"string"},"waited_ms":{"type":"integer"},"limit":{"type":"integer"},"queued":{"type":"integer"}},"required":["runs","reason"]})),
            safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/batch",
        },
    ]
}
