// The full row of one session in `GET /pclink/sessions`: everything this PC's own sidebar draws a chat from, so another PC's sidebar can
// draw the same row with the same code (what the chat is called, whose helper it is, whether it is the front of a workflow, a standby's
// own chat, a chat on a separate copy). Names and ids only: a path never travels, and no prompt text beyond the row's own title.
//
// The workflow mark (which chat is a workflow's front, its crew's slug and name) is made in this PC's window and kept in its browser
// storage. The window mirrors it here (`crew_marks_sync`, window only: no PC-link route reaches it) so the PC that owns the chat is the
// one that says it. Held in memory; the window pushes it again at every start and whenever a crew starts.
use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

pub(super) const MAX_MARKS: usize = 200;
const SHORT: usize = 80;

pub(super) struct Mark {
    slug: String,
    role: String,
    front: bool,
    name: Option<String>,
}

pub(super) static MARKS: Lazy<Mutex<HashMap<String, Mark>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn clip(text: &str, max: usize) -> String {
    super::meta::sanitize_name(text).unwrap_or_default().chars().take(max).collect()
}

/// Replaces the marks with what the window holds: `{ "<pane id>": { slug, role, front?, name? } }`. Anything else in it is ignored.
pub fn set_marks(value: &Value) {
    let mut next = HashMap::new();
    if let Some(map) = value.as_object() {
        for (pane, m) in map.iter().take(MAX_MARKS) {
            let (Some(slug), Some(role)) = (m.get("slug").and_then(Value::as_str), m.get("role").and_then(Value::as_str)) else { continue };
            next.insert(
                clip(pane, 200),
                Mark { slug: clip(slug, SHORT), role: clip(role, SHORT), front: m.get("front").and_then(Value::as_bool) == Some(true), name: m.get("name").and_then(Value::as_str).map(|n| clip(n, SHORT)).filter(|n| !n.is_empty()) },
            );
        }
    }
    *MARKS.lock().unwrap_or_else(|e| e.into_inner()) = next;
}

/// Adds the fields that make the row the one the local sidebar builds: `helper_of`, `started_as`, `standby_seat`, `lane`, `copy`, `workflow`.
/// `project` and `folder` are those of the real project when the chat works on a separate copy (the copy sits under its project, like here).
pub fn extend(row: &mut Value, info: &crate::pty::PaneInfo, project_id: impl Fn(&str) -> String, folder_name: impl Fn(&str) -> String) {
    if let Some(parent) = info.parent_pane_id.as_deref().filter(|s| !s.is_empty()) {
        row["helper_of"] = json!(clip(parent, 200));
    }
    if let Some(kind) = info.started_as.as_deref().filter(|k| matches!(*k, "minion" | "spin_off")) {
        row["started_as"] = json!(kind);
    }
    if info.standby_seat.as_deref().is_some_and(|s| !s.is_empty()) {
        row["standby"] = json!(true);
    }
    if info.lane.is_some() {
        row["lane"] = json!(info.lane.as_deref().map(|l| clip(l, 20)));
    }
    if let Some(origin) = crate::worktrees::origin_of_cwd(&info.cwd) {
        row["copy"] = json!(true);
        row["project"] = json!(project_id(&origin));
        row["folder"] = json!(clip(&folder_name(&origin), 120));
    }
    if let Some(m) = MARKS.lock().unwrap_or_else(|e| e.into_inner()).get(&info.id) {
        let mut wf = json!({ "slug": m.slug, "role": m.role, "front": m.front });
        if let Some(name) = &m.name {
            wf["name"] = json!(name);
        }
        row["workflow"] = wf;
    }
}
