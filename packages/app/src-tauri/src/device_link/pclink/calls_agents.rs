//! P2.1: what the New agent page reads, for a paired PC. Each row of `calls.rs`'s `// ---- P2.1 agents/projects ----` block runs the
//! same inner function the Tauri command runs (`agents_list`, `agent_lane_get`, `agent_default_models_in`, `agent_rules_effective`),
//! so the far page lists the same agents with the same words as this PC's own. One difference by design: `project_recent` answers
//! from the folders this PC knows by opaque id (a path never travels), and gives each as `remote:<id>`, the handle the page keeps
//! in place of a folder and `POST /pclink/agents/start` takes back.

use serde_json::{json, Value};

use super::app_services::{bad, known_projects, not_ready, project_id, resolve_project, Reply};
use super::calls::text_arg;
use crate::bridge::link_app_handles;

/// The prefix of a far project handle (`lib/runtime/remoteNewAgent.ts::REMOTE_PROJECT_PREFIX` says the same).
pub const OPAQUE_PREFIX: &str = "remote:";

/// The reply for one of this block's commands, or `None` when `cmd` is not one of them.
pub(super) fn run(cmd: &str, args: &Value) -> Option<Reply> {
    Some(match cmd {
        "agents_list" => (200, agents()),
        "agent_lane_get" => (200, crate::commands::agent_lane_get()),
        "agent_default_models" => default_models(),
        "agent_rules_effective" => rules(args),
        "project_recent" => recent(),
        _ => return None,
    })
}

/// `agents_list` as this PC's page reads it, without what only this PC's own screens need: a user-defined agent's `definition` and
/// the install hints can carry command lines and paths, and another PC (maybe another account's, at Watch) has no use for them.
fn agents() -> Value {
    let mut list = crate::commands::agents_list();
    for row in list.get_mut("agents").and_then(Value::as_array_mut).into_iter().flatten() {
        for key in ["definition", "install_hint", "install_fallback"] {
            if row.get(key).is_some() {
                row[key] = Value::Null;
            }
        }
    }
    list
}

/// Reads the app's settings through its handle. Not compiled into the unit-test binary: a path that holds an `AppHandle` drags a window
/// import into it that the test exe has no manifest for; the answer's shape is `agent_default_models_of`, tested on plain data.
#[cfg(not(test))]
fn default_models() -> Reply {
    match link_app_handles() {
        Some((app, _)) => (200, crate::commands::agent_default_models_of(&crate::settings_store::read_public_settings(&app))),
        None => not_ready(),
    }
}

#[cfg(test)]
fn default_models() -> Reply {
    not_ready()
}

fn recent() -> Reply {
    let Some((_, registry)) = link_app_handles() else { return not_ready() };
    let known = known_projects(&registry);
    let total = known.len() as u64;
    let rows: Vec<Value> = known
        .into_iter()
        .enumerate()
        .map(|(i, (path, name, state))| json!({ "path": format!("{OPAQUE_PREFIX}{}", project_id(&path)), "name": name, "state": state, "last_used_ms": total - i as u64 }))
        .collect();
    (200, Value::Array(rows))
}

/// `agent_rules_effective(agent, project)` with the project named by its handle. A fence is a folder path and the notes are the person's
/// own text: only how many fences there are, and that notes exist, travel (the page shows "Notes" and the count, nothing more).
fn rules(args: &Value) -> Reply {
    let Some(agent) = text_arg(args, "agent") else { return bad("INVALID_ARGUMENT", "agent is required") };
    let folder = match text_arg(args, "project") {
        None => None,
        Some(handle) => {
            let Some((_, registry)) = link_app_handles() else { return not_ready() };
            let id = handle.strip_prefix(OPAQUE_PREFIX).unwrap_or(&handle);
            match resolve_project(&known_projects(&registry), id) {
                Some(path) => Some(path),
                None => return (404, json!({ "code": "UNKNOWN_PROJECT", "error": "The PC does not know that project. Open it on the PC first." })),
            }
        }
    };
    let mut pins = crate::commands::agent_rules_effective(agent, folder);
    if let Some(fences) = pins.get_mut("fences").and_then(Value::as_array_mut) {
        fences.iter_mut().for_each(|f| *f = json!(""));
    }
    if pins.get("notes").is_some_and(|n| n.as_str().is_some_and(|t| !t.trim().is_empty())) {
        pins["notes"] = json!(" ");
    }
    (200, pins)
}
