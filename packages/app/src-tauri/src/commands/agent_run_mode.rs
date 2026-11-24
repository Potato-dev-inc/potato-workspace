//! Tauri commands for Settings > Agents > "How agent runs work". Only the app's own webview can
//! call these; the bridge has no route for them, so a phone or an agent cannot change how an
//! agent runs.

use crate::agent_run_mode::{self, RunMode};
use super::AppState;
use serde_json::Value;
use tauri::State;

/// `{agents: [{id, label, headless_supported, headless_verified, headless_verified_reason, run_mode}]}`
/// for every custom (definition-based) agent.
#[tauri::command]
pub fn agent_run_mode_get() -> Value {
    agent_run_mode::settings_view()
}

/// Saves one agent's choice (`visible` | `one_task`). `one_task` is refused with
/// `RUN_MODE_NOT_VERIFIED` unless the agent's headless mode is verified. Returns the new view.
#[tauri::command]
pub fn agent_run_mode_set(id: String, mode: String) -> Result<Value, String> {
    let mode = RunMode::parse(&mode).ok_or_else(|| format!("INVALID_ARGUMENT: unknown run mode {mode}"))?;
    agent_run_mode::set_checked(&id, mode)?;
    Ok(agent_run_mode::settings_view())
}

/// `{mode: "always_show" | "agent_chooses" | "always_background"}`: "Helper agents" (default `always_show`).
#[tauri::command]
pub fn helper_visibility_get() -> Value {
    serde_json::json!({ "mode": agent_run_mode::helper_visibility().as_str() })
}

/// Saves "Helper agents". Like the run-mode choice, only the Settings window writes it: neither an agent
/// nor a phone has a route to it.
#[tauri::command]
pub fn helper_visibility_set(mode: String) -> Result<Value, String> {
    let mode = agent_run_mode::HelperVisibility::parse(&mode)
        .ok_or_else(|| format!("INVALID_ARGUMENT: unknown helper setting {mode}"))?;
    agent_run_mode::set_helper_visibility(mode)?;
    Ok(helper_visibility_get())
}

/// `{on: bool}`: "Keep helpers open when they finish" (default on).
#[tauri::command]
pub fn keep_helpers_open_get() -> Value {
    serde_json::json!({ "on": agent_run_mode::keep_helpers_open() })
}

/// Saves "Keep helpers open when they finish"; only the Settings window writes it.
#[tauri::command]
pub fn keep_helpers_open_set(on: bool) -> Result<Value, String> {
    agent_run_mode::set_keep_helpers_open(on)?;
    Ok(keep_helpers_open_get())
}

/// `{on: bool}`: "Close helpers when their agent closes" (default on).
#[tauri::command]
pub fn close_helpers_with_agent_get() -> Value {
    serde_json::json!({ "on": agent_run_mode::close_helpers_with_agent() })
}

/// Saves "Close helpers when their agent closes"; only the Settings window writes it.
#[tauri::command]
pub fn close_helpers_with_agent_set(on: bool) -> Result<Value, String> {
    agent_run_mode::set_close_helpers_with_agent(on)?;
    Ok(close_helpers_with_agent_get())
}

/// `{value: number}`: "Most helpers at once" for `run_agents` (default 8).
#[tauri::command]
pub fn most_helpers_at_once_get() -> Value {
    serde_json::json!({ "value": agent_run_mode::most_helpers_at_once() })
}

/// Saves "Most helpers at once"; only the Settings window writes it, so an agent cannot raise its own limit.
#[tauri::command]
pub fn most_helpers_at_once_set(value: u32) -> Result<Value, String> {
    agent_run_mode::set_most_helpers_at_once(value)?;
    Ok(most_helpers_at_once_get())
}

/// `{value: number}`: minutes with no progress before a helper reads as stuck (0 = off, default 5).
#[tauri::command]
pub fn stall_minutes_get() -> Value {
    serde_json::json!({ "value": agent_run_mode::stall_minutes() })
}

/// Saves the stuck-helper minutes; only the Settings window writes it.
#[tauri::command]
pub fn stall_minutes_set(value: u32) -> Result<Value, String> {
    agent_run_mode::set_stall_minutes(value)?;
    Ok(stall_minutes_get())
}

/// Helpers that read as stuck now: `[{pane_id, minutes}]`.
#[tauri::command(async)]
pub fn stalls_list() -> Value {
    Value::Array(crate::agent_runs::stall::all().into_iter().map(|(pane_id, minutes)| serde_json::json!({ "pane_id": pane_id, "minutes": minutes })).collect())
}

/// Nudge a stuck helper: one short line through `send_message`.
#[tauri::command]
pub async fn stall_nudge(state: State<'_, AppState>, app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || crate::agent_runs::stall::nudge(registry, app, &pane_id)).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// Stop a stuck helper: the existing cancel.
#[tauri::command]
pub async fn stall_stop(state: State<'_, AppState>, app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || crate::agent_runs::stall::stop(registry, app, &pane_id)).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// Respawn a stuck helper: close it and start a fresh one with the same task and model. Returns the new handle.
#[tauri::command]
pub async fn stall_respawn(state: State<'_, AppState>, app: tauri::AppHandle, pane_id: String) -> Result<String, String> {
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || crate::agent_runs::stall::respawn(registry, app, &pane_id)).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// The helpers that ran hidden (no pane), newest first, for the Inbox.
#[tauri::command(async)]
pub fn hidden_runs_list() -> Vec<crate::hidden_runs::HiddenRunView> {
    crate::hidden_runs::list()
}

/// Takes one hidden run off the Inbox list.
#[tauri::command]
pub fn hidden_runs_dismiss(app: tauri::AppHandle, handle: String) -> bool {
    crate::hidden_runs::dismiss(&handle, Some(&app))
}

/// `{types: "one" | "two", kind: "agent_chooses" | "minion" | "spin_off"}`: "Agents that agents start" (default One
/// type) and "When an agent starts another agent" (default Let it choose; only used in Two types).
#[tauri::command]
pub fn started_agents_get() -> Value {
    serde_json::json!({
        "types": agent_run_mode::started_agent_types().as_str(),
        "kind": agent_run_mode::started_agent_kind().as_str(),
    })
}

/// Saves either choice (the other is left alone). Like "Helper agents", only the Settings window writes it: neither an
/// agent nor a phone has a route to it, so an agent cannot decide what its own helpers are.
#[tauri::command]
pub fn started_agents_set(types: Option<String>, kind: Option<String>) -> Result<Value, String> {
    let types = types
        .map(|text| agent_run_mode::StartedAgentTypes::parse(&text).ok_or_else(|| format!("INVALID_ARGUMENT: unknown value {text}")))
        .transpose()?;
    let kind = kind
        .map(|text| agent_run_mode::StartedAgentKind::parse(&text).ok_or_else(|| format!("INVALID_ARGUMENT: unknown value {text}")))
        .transpose()?;
    if let Some(types) = types {
        agent_run_mode::set_started_agent_types(types)?;
    }
    if let Some(kind) = kind {
        agent_run_mode::set_started_agent_kind(kind)?;
    }
    Ok(started_agents_get())
}

/// The Default model saved per agent (Settings > Agents) in the public `settings`: `{ agent id: model id }`. Plain data in and out, so the
/// New agent page of this PC and of a PC that looks at this one (`pclink::calls_agents`) read the same answer.
pub fn agent_default_models_of(settings: &Value) -> Value {
    settings.get(agent_run_mode::AGENT_DEFAULT_MODELS_KEY).filter(|v| v.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
pub fn agent_default_models(app: tauri::AppHandle) -> Value {
    agent_default_models_of(&crate::settings_store::read_public_settings(&app))
}
