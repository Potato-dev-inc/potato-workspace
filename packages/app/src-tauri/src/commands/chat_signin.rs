//! "Sign in without a terminal": the agent's own sign-in for a chat that needs it, run in a hidden pane (the approach of the
//! lend sign-in, `capacity_proxy::signin_pane`). The chat's card shows the pane's terminal under "Details" and opens it when
//! the screen asks a question (`acp::signin_ask`). Nothing here reads or sends a login: the agent signs itself in, and
//! the card finds out by trying the kept message again (`acp_chat_retry_sign_in`), as before.
//! Desktop only; not reachable through the bridge, the phone or MCP.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::AppState;
use crate::capacity_proxy::signin_pane::{app_panes, AppPorts};

pub(crate) type Registry = Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>;

/// One hidden sign-in pane per agent.
fn key_of(agent: &str) -> String {
    format!("chat-signin:{agent}")
}

/// The chat session of `pane_id`, when it is one that waits for a sign-in. Anything else is refused, so this never starts
/// an agent for a pane that did not ask.
fn waiting_chat(pane_id: &str) -> Result<Arc<crate::acp::chat::AcpChat>, String> {
    let chat = crate::acp::chat::get(pane_id).ok_or_else(|| "This is not a chat that can sign in.".to_string())?;
    if !chat.sign_in_needed() {
        return Err("This chat does not need a sign-in now.".into());
    }
    Ok(chat)
}

/// Starts the hidden sign-in of the agent behind this chat (or returns the one that runs). `{ pane_id }`.
#[tauri::command(rename_all = "snake_case")]
pub async fn chat_signin_start(app: AppHandle, state: State<'_, AppState>, pane_id: String) -> Result<Value, String> {
    start_for_chat(app, &state.registry, &pane_id)
}

// The `start_for_*` / `status_for_*` / `stop_for_*` functions below are the bodies of the commands; a paired PC's call runs the same ones
// (`device_link::pclink::calls_signin`), so the far PC signs in exactly as its own window would.
pub(crate) fn start_for_chat(_app: AppHandle, registry: &Registry, pane_id: &str) -> Result<Value, String> {
    let chat = waiting_chat(pane_id)?;
    let agent = chat.agent_id().to_string();
    let cwd = registry.lock().get(pane_id).map(|pane| pane.info.cwd.clone()).ok_or_else(|| format!("unknown pane: {pane_id}"))?;
    let ports = Arc::new(AppPorts { registry: registry.clone() });
    let hidden = app_panes().start_for_agent(ports, &key_of(&agent), &agent, std::path::PathBuf::from(cwd))?;
    Ok(json!({ "pane_id": hidden }))
}

/// Where the sign-in stands: whether its pane still runs, and whether its screen is asking the person something.
#[tauri::command(rename_all = "snake_case")]
pub async fn chat_signin_status(state: State<'_, AppState>, pane_id: String) -> Result<Value, String> {
    status_for_chat(&state.registry, &pane_id)
}

pub(crate) fn status_for_chat(registry: &Registry, pane_id: &str) -> Result<Value, String> {
    let agent = crate::acp::chat::get(pane_id).map(|chat| chat.agent_id().to_string()).ok_or_else(|| "This is not a chat.".to_string())?;
    let Some(hidden) = app_panes().pane_alive(&key_of(&agent)) else {
        return Ok(json!({ "alive": false, "asking": false, "pane_id": Value::Null }));
    };
    let screen = crate::pty::registry_read_snapshot(registry, &hidden).unwrap_or_default();
    Ok(json!({ "alive": true, "asking": crate::acp::signin_ask::asks_the_person(&screen), "pane_id": hidden }))
}

/// Stops the hidden sign-in pane of the agent behind this chat (nothing happens when there is none).
#[tauri::command(rename_all = "snake_case")]
pub async fn chat_signin_stop(pane_id: String) -> Result<(), String> {
    stop_for_chat(&pane_id);
    Ok(())
}

pub(crate) fn stop_for_chat(pane_id: &str) {
    if let Some(chat) = crate::acp::chat::get(pane_id) {
        app_panes().stop(&key_of(chat.agent_id()));
    }
}

// ---------------------------------------------------------------------------------------------- No chat

/// A sign-in that starts with no chat: "Sign in again" on the Usage card, in Problems, in Settings. The same hidden pane as above,
/// in an app-owned folder; nothing reaches the sidebar. `account_id` is one of the person's extra sign-ins, or absent for the
/// agent's normal login.
fn standalone(agent_id: &str, account_id: &Option<String>) -> Result<String, String> {
    if !crate::tui::descriptors().iter().any(|d| d.id == agent_id) {
        return Err("That agent is not known.".into());
    }
    crate::capacity_proxy::signin_pane::check_standalone(&crate::accounts::Store::default_location(), agent_id, account_id.as_deref())?;
    Ok(crate::capacity_proxy::signin_pane::standalone_key(agent_id, account_id.as_deref()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_signin_start(app: AppHandle, state: State<'_, AppState>, agent_id: String, account_id: Option<String>) -> Result<Value, String> {
    start_for_agent(app, &state.registry, &agent_id, account_id)
}

pub(crate) fn start_for_agent(_app: AppHandle, registry: &Registry, agent_id: &str, account_id: Option<String>) -> Result<Value, String> {
    let key = standalone(agent_id, &account_id)?;
    let ports = Arc::new(AppPorts { registry: registry.clone() });
    let cwd = crate::app_paths::app_data_dir().join("lend").join("signin");
    let hidden = app_panes().start_for_agent_account(ports, &key, agent_id, account_id.filter(|a| !a.is_empty()), cwd)?;
    Ok(json!({ "pane_id": hidden }))
}

/// Where the sign-in stands. `signed_in` is the only sign of "done": `true` when this login's credential file was written since the
/// sign-in started, `false` when the folder shows none, `null` when this agent's login is not in a folder (then only a real usage
/// reading of exactly this login can say). A pane that is alive, or a folder that is not empty, never means signed in.
#[tauri::command(rename_all = "snake_case")]
pub async fn agent_signin_status(state: State<'_, AppState>, agent_id: String, account_id: Option<String>) -> Result<Value, String> {
    status_for_agent(&state.registry, &agent_id, &account_id)
}

pub(crate) fn status_for_agent(registry: &Registry, agent_id: &str, account_id: &Option<String>) -> Result<Value, String> {
    let key = standalone(agent_id, account_id)?;
    let signed_in = crate::accounts::sign_in_proof(&crate::accounts::Store::default_location(), agent_id, account_id.as_deref(), app_panes().started_at(&key));
    let Some(hidden) = app_panes().pane_alive(&key) else {
        return Ok(json!({ "alive": false, "asking": false, "pane_id": Value::Null, "signed_in": signed_in }));
    };
    let screen = crate::pty::registry_read_snapshot(registry, &hidden).unwrap_or_default();
    Ok(json!({ "alive": true, "asking": crate::acp::signin_ask::asks_the_person(&screen), "pane_id": hidden, "signed_in": signed_in }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_signin_stop(agent_id: String, account_id: Option<String>) -> Result<(), String> {
    stop_for_agent(&agent_id, account_id.as_deref());
    Ok(())
}

pub(crate) fn stop_for_agent(agent_id: &str, account_id: Option<&str>) {
    app_panes().stop(&crate::capacity_proxy::signin_pane::standalone_key(agent_id, account_id));
}
