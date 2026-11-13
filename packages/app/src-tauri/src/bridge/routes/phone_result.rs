//! `GET /panes/{id}/result[?patch=1]`: what the agent's last finished turn did, for the phone's result card (phone compose, P10).
//!
//! The answer is built from data the PC already keeps: the turn summary (`turn_summary`: the plain sentence, files and
//! lines, the checks of a run-backed agent) and the checkpoint diff of that turn (`checkpoints`: the file list and, with
//! `patch=1`, the unified diff). Nothing is computed by a model. Every text is redacted before it leaves (`redact`).
//!
//! It is a read of the agent's work, so it needs `watch` (`route_need`); under `/panes/{id}` the agent's own remote rule
//! applies first. A pane with no finished turn answers `{ "available": false }` and the phone shows only what it can read
//! from the chat. Not an MCP tool.

use serde_json::{json, Value};

use super::{Ctx, RouteResult};
use crate::bridge::http::query_param;
use crate::checkpoints::FileChange;
use crate::turn_summary::TurnSummary;

/// The diff is cut at this many bytes (the phone shows "cut" when it was).
const MAX_PATCH_BYTES: usize = 60_000;
/// The file list is cut at this many files (the count in `summary.files` stays exact).
const MAX_FILES: usize = 60;

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("GET", ["panes", pane_id, "result"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(read(cx, pane_id)),
        _ => None,
    }
}

fn read(cx: &Ctx, pane_id: &str) -> RouteResult {
    if !cx.registry.lock().panes.contains_key(pane_id) {
        return Err((404, json!({ "error": crate::pty::registry::unknown_pane_message(pane_id), "code": "UNKNOWN_PANE" })));
    }
    let summary = crate::turn_summary::tracker().summaries(pane_id).into_iter().last();
    let rt = crate::checkpoints::live();
    let changes = summary.as_ref().and_then(|s| rt.turn_changes(pane_id, s.started_at_ms).ok().flatten());
    let patch = if query_param(cx.query, "patch").is_some_and(|v| v == "1") && summary.is_some() {
        rt.last_turn_patch(pane_id, MAX_PATCH_BYTES).ok().flatten().map(|p| (p.patch, p.truncated))
    } else {
        None
    };
    Ok((200, build(summary, changes, patch)))
}

/// The answer body. `patch` is the diff text and whether it was cut.
pub fn build(summary: Option<TurnSummary>, changes: Option<Vec<FileChange>>, patch: Option<(String, bool)>) -> Value {
    let Some(summary) = summary else {
        return json!({ "available": false });
    };
    let tests = summary.receipt.as_ref().and_then(crate::turn_summary::model::receipt_part);
    let summary = crate::redact::scrub(summary).into_inner();
    let files = changes.map(|list| {
        list.into_iter()
            .take(MAX_FILES)
            .map(|c| json!({ "path": crate::redact::text(&c.path).into_inner(), "status": c.status, "added": c.added, "deleted": c.deleted, "binary": c.binary }))
            .collect::<Vec<_>>()
    });
    let mut body = json!({
        "available": true,
        "turn": summary.turn,
        "sentence": summary.sentence,
        "agent": summary.agent,
        "endedAtMs": summary.ended_at_ms,
        "durationMs": summary.duration_ms,
        "files": summary.files,
        "tests": tests.map(|line| crate::redact::text(&line).into_inner()),
        "failed": summary.end.kind == "error",
        "changes": files,
    });
    if let Some((text, cut)) = patch {
        body["patch"] = json!(crate::redact::text(&text).into_inner());
        body["patchCut"] = json!(cut);
    }
    body
}

#[cfg(test)]
#[path = "phone_result_tests.rs"]
mod tests;
