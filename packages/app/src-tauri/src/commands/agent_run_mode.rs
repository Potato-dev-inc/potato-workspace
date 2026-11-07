//! Tauri commands for Settings > Agents > "How agent runs work". Only the app's own webview can
//! call these; the bridge has no route for them, so a phone or an agent cannot change how an
//! agent runs.

use crate::agent_run_mode::{self, RunMode};
use serde_json::Value;

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

/// `{allowed: bool}`: whether an agent's `headless: true` may hide a helper ("Allow hidden helpers", off by default).
#[tauri::command]
pub fn hidden_helpers_get() -> Value {
    serde_json::json!({ "allowed": agent_run_mode::hidden_helpers_allowed() })
}

/// Saves "Allow hidden helpers". Like the run-mode choice, only the Settings window writes it: neither an agent
/// nor a phone has a route to it.
#[tauri::command]
pub fn hidden_helpers_set(allowed: bool) -> Result<Value, String> {
    agent_run_mode::set_hidden_helpers_allowed(allowed)?;
    Ok(hidden_helpers_get())
}

/// The helpers that ran hidden (no pane), newest first, for the Inbox.
#[tauri::command]
pub fn hidden_runs_list() -> Vec<crate::hidden_runs::HiddenRunView> {
    crate::hidden_runs::list()
}

/// Takes one hidden run off the Inbox list.
#[tauri::command]
pub fn hidden_runs_dismiss(app: tauri::AppHandle, handle: String) -> bool {
    crate::hidden_runs::dismiss(&handle, Some(&app))
}
