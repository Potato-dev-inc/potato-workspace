//! Tauri commands for Force yes, Fences and Pins (`crate::agent_rules`). Only the app's own webview can call these; the
//! bridge and the MCP tools have no route to them, so a phone or an agent cannot loosen a rule.

use crate::agent_rules::{self, Pin};
use crate::audit::{self, Kind, Who};
use serde_json::{json, Value};

fn record(summary: &str, detail: Value) {
    audit::record(Kind::AgentRules, Who::Desktop, summary, detail);
}

/// Everything Settings shows: the agents with Force yes, the global pin, and each project that has fences or a pin.
#[tauri::command]
pub fn agent_rules_overview() -> Value {
    let data = agent_rules::store().snapshot();
    let mut projects: std::collections::BTreeSet<&String> = data.fences.keys().collect();
    projects.extend(data.pin_projects.keys());
    json!({
        "forceYesAgents": data.force_yes_agents,
        "pinGlobal": data.pin_global,
        "projects": projects.into_iter().map(|key| json!({
            "project": key,
            "fences": data.fences.get(key).cloned().unwrap_or_default(),
            "pin": data.pin_projects.get(key).cloned().unwrap_or_default(),
        })).collect::<Vec<_>>(),
    })
}

/// What a new agent of `agent` starts with in `project`: model, mode, Force yes, notes, and the project's fences.
#[tauri::command]
pub fn agent_rules_effective(agent: String, project: Option<String>) -> Value {
    let effective = agent_rules::store().effective(&agent, project.as_deref().filter(|p| !p.trim().is_empty()));
    serde_json::to_value(effective).unwrap_or(Value::Null)
}

/// The agent's own Force yes switch: chats and panes of that agent start with it.
#[tauri::command]
pub fn agent_rules_set_force_yes_agent(agent: String, on: bool) -> Result<bool, String> {
    let changed = agent_rules::store().set_force_yes_for_agent(&agent, on)?;
    if changed {
        record(
            if on { "You turned Force yes on for an agent" } else { "You turned Force yes off for an agent" },
            json!({ "event": if on { "force_yes_on" } else { "force_yes_off" }, "agent": agent.trim().to_lowercase(), "scope": "agent" }),
        );
    }
    Ok(on)
}

#[tauri::command]
pub fn agent_rules_fences(project: String) -> Vec<String> {
    agent_rules::store().fences(&project)
}

/// "Fence this folder": `path` is a file or folder inside `project` (absolute, or relative to it).
#[tauri::command]
pub fn agent_rules_fence_add(project: String, path: String) -> Result<Vec<String>, String> {
    let before = agent_rules::store().fences(&project).len();
    agent_rules::store().add_fence(&project, &path)?;
    let list = agent_rules::store().fences(&project);
    if list.len() != before {
        record("You fenced a path of a project", json!({ "event": "fence_added", "fences": list.len() }));
    }
    Ok(list)
}

#[tauri::command]
pub fn agent_rules_fence_remove(project: String, fence: String) -> Result<Vec<String>, String> {
    if agent_rules::store().remove_fence(&project, &fence)? {
        record("You took a fence off a project", json!({ "event": "fence_removed" }));
    }
    Ok(agent_rules::store().fences(&project))
}

/// The pin of a project, or the global pin when `project` is absent.
#[tauri::command]
pub fn agent_rules_pin_get(project: Option<String>) -> Pin {
    agent_rules::store().pin(project.as_deref().filter(|p| !p.trim().is_empty()))
}

#[tauri::command]
pub fn agent_rules_pin_set(project: Option<String>, pin: Pin) -> Result<Pin, String> {
    let scope = project.as_deref().filter(|p| !p.trim().is_empty());
    let saved = agent_rules::store().set_pin(scope, pin)?;
    record(
        "You saved the starting settings for new agents",
        json!({ "event": "pin_saved", "scope": if scope.is_some() { "project" } else { "global" }, "force_yes": saved.force_yes, "has_model": saved.model.is_some(), "has_mode": saved.mode.is_some(), "has_notes": saved.notes.is_some() }),
    );
    Ok(saved)
}

/// The Force yes switch of one terminal pane (a chat's switch is `acp_chat_set_force_yes`).
#[tauri::command]
pub fn pane_set_force_yes(pane_id: String, on: bool) -> bool {
    let before = agent_rules::terminal::explicit(&pane_id);
    agent_rules::terminal::set(&pane_id, on);
    if before != Some(on) {
        record(
            if on { "You turned Force yes on in a terminal pane" } else { "You turned Force yes off in a terminal pane" },
            json!({ "event": if on { "force_yes_on" } else { "force_yes_off" }, "pane_id": pane_id }),
        );
    }
    on
}

/// Whether Force yes is on for a terminal pane now (the pane's own switch, else what its agent and folder start with).
#[tauri::command(async)]
pub fn pane_force_yes(pane_id: String, agent: String, cwd: String) -> bool {
    agent_rules::terminal::enabled(&pane_id, &agent, &cwd)
}
