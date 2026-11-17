//! Two read-only routes for the phone's home: what finished today and which standby helpers are ready.
//!
//! - `GET /phone/done?since=<ms>`: one row per chat whose last turn ended since `since` (the phone sends its local
//!   midnight), newest first, at most 30. Built from the turn summaries the PC already keeps (the desktop Inbox's "Done
//!   today"). A turn that waits for an answer is not here (it is in "Needs you"). Texts are redacted.
//! - `GET /phone/helpers`: the standby helpers with their state (the desktop's `standby_helpers_get`), with the project
//!   as its folder name only.
//!
//! Team activity needs no route of its own: the phone reads `GET /team/cards` (`team::phone`) and builds the rows.
//! - `GET /phone/tasks`: the background tasks the person put in the sidebar on the PC (`task_sidebar`), so the phone's drawer shows
//!   them in the same place (nested under their agent, or on their own).
//! All three routes are reads, so they need `watch` (`route_need`, written out). Not MCP tools.

use serde_json::{json, Value};

use super::{Ctx, RouteResult};
use crate::bridge::http::query_param;
use crate::turn_summary::TurnSummary;

/// The most rows one answer carries.
const MAX_ROWS: usize = 30;

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("GET", ["phone", "done"]) => {
            let now = crate::event_log::now_ms().max(0) as u64;
            let since = query_param(cx.query, "since").and_then(|v| v.parse::<u64>().ok()).unwrap_or_else(|| now.saturating_sub(86_400_000));
            Some(Ok((200, done_body(crate::turn_summary::tracker().since(since), since, now))))
        }
        ("GET", ["phone", "helpers"]) => Some(Ok((200, helpers_body(crate::standby::helpers::view())))),
        ("GET", ["phone", "tasks"]) => {
            let reg = cx.registry.lock();
            Some(Ok((200, tasks_body(&crate::task_sidebar::file().snapshot(), |id| reg.panes.get(id).map(|p| p.info().status)))))
        }
        _ => None,
    }
}

/// The "Done today" rows: newest first, one per chat (its last finished turn), none waiting for an answer.
pub fn done_body(summaries: Vec<TurnSummary>, since: u64, now: u64) -> Value {
    let mut rows: Vec<TurnSummary> = summaries.into_iter().filter(|s| s.ended_at_ms >= since && s.ended_at_ms <= now + 60_000 && s.end.kind != "waiting_input").collect();
    rows.sort_by(|a, b| b.ended_at_ms.cmp(&a.ended_at_ms));
    let mut seen = std::collections::BTreeSet::new();
    rows.retain(|s| seen.insert(s.pane_id.clone()));
    rows.truncate(MAX_ROWS);
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|s| {
            let s = crate::redact::scrub(s).into_inner();
            let files = s.files.as_ref().map(|f| json!({ "count": f.count, "added": f.added, "deleted": f.deleted })).unwrap_or(json!({ "count": 0, "added": 0, "deleted": 0 }));
            let checks = s.receipt.as_ref().map(|r| crate::redact::text(r.checks.trim()).into_inner()).filter(|c| !c.is_empty() && c != "none configured");
            json!({
                "paneId": s.pane_id,
                "agent": s.agent_id.clone().unwrap_or_else(|| s.agent.clone()),
                "endedAtMs": s.ended_at_ms,
                "files": files,
                "checks": checks,
                "sentence": s.sentence,
            })
        })
        .collect();
    json!({ "now": now, "since": since, "rows": rows })
}

/// The standby helpers, with the folder's name only (the full path stays on the PC).
pub fn helpers_body(view: crate::standby::helpers::HelpersView) -> Value {
    let helpers: Vec<Value> = view
        .helpers
        .into_iter()
        .map(|h| {
            let folder = std::path::Path::new(&h.project).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            json!({ "id": h.id, "name": h.name, "agent": h.agent, "model": h.model, "folder": folder, "state": h.state, "note": h.note })
        })
        .collect();
    json!({ "helpers": helpers, "max": view.max })
}

/// The tasks the person put in the sidebar on the PC (`task_sidebar`), as the phone's drawer shows them: nested under their agent
/// (`under`) or on their own, with the tag (`minion` or `command`), the name and the state. Rows of a pane that is gone are left out.
/// `status_of(pane)`: the pane's status, `None` when it is not open.
pub fn tasks_body(store: &crate::task_sidebar::Store, status_of: impl Fn(&str) -> Option<String>) -> Value {
    let rows: Vec<Value> = store
        .rows
        .iter()
        .filter_map(|row| {
            let status = match row.kind.as_str() {
                "minion" => status_of(row.task_id.strip_prefix("minion:").unwrap_or(&row.task_id))?,
                _ => status_of(&row.owner).map(|_| "running".to_string())?,
            };
            let under = row.under.clone().filter(|u| status_of(u).is_some());
            Some(json!({ "taskId": row.task_id, "kind": row.kind, "owner": row.owner, "under": under, "name": crate::redact::text(&row.name).into_inner(), "status": status }))
        })
        .collect();
    json!({ "rows": rows })
}

#[cfg(test)]
#[path = "phone_home_tests.rs"]
mod tests;
