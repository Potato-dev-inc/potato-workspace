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
    let chat = waiting_chat(&pane_id)?;
    let agent = chat.agent_id().to_string();
    let cwd = state.registry.lock().get(&pane_id).map(|pane| pane.info.cwd.clone()).ok_or_else(|| format!("unknown pane: {pane_id}"))?;
    let ports = Arc::new(AppPorts { registry: state.registry.clone(), app });
    let hidden = app_panes().start_for_agent(ports, &key_of(&agent), &agent, std::path::PathBuf::from(cwd))?;
    Ok(json!({ "pane_id": hidden }))
}

/// Where the sign-in stands: whether its pane still runs, and whether its screen is asking the person something.
#[tauri::command(rename_all = "snake_case")]
pub async fn chat_signin_status(state: State<'_, AppState>, pane_id: String) -> Result<Value, String> {
    let agent = crate::acp::chat::get(&pane_id).map(|chat| chat.agent_id().to_string()).ok_or_else(|| "This is not a chat.".to_string())?;
    let Some(hidden) = app_panes().pane_alive(&key_of(&agent)) else {
        return Ok(json!({ "alive": false, "asking": false, "pane_id": Value::Null }));
    };
    let screen = crate::pty::registry_read_snapshot(&state.registry, &hidden).unwrap_or_default();
    Ok(json!({ "alive": true, "asking": crate::acp::signin_ask::asks_the_person(&screen), "pane_id": hidden }))
}

/// Stops the hidden sign-in pane of the agent behind this chat (nothing happens when there is none).
#[tauri::command(rename_all = "snake_case")]
pub async fn chat_signin_stop(pane_id: String) -> Result<(), String> {
    if let Some(chat) = crate::acp::chat::get(&pane_id) {
        app_panes().stop(&key_of(chat.agent_id()));
    }
    Ok(())
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
    let key = standalone(&agent_id, &account_id)?;
    let ports = Arc::new(AppPorts { registry: state.registry.clone(), app });
    let cwd = crate::app_paths::app_data_dir().join("lend").join("signin");
    let hidden = app_panes().start_for_agent_account(ports, &key, &agent_id, account_id.filter(|a| !a.is_empty()), cwd)?;
    Ok(json!({ "pane_id": hidden }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_signin_status(state: State<'_, AppState>, agent_id: String, account_id: Option<String>) -> Result<Value, String> {
    let key = standalone(&agent_id, &account_id)?;
    let Some(hidden) = app_panes().pane_alive(&key) else {
        return Ok(json!({ "alive": false, "asking": false, "pane_id": Value::Null }));
    };
    let screen = crate::pty::registry_read_snapshot(&state.registry, &hidden).unwrap_or_default();
    Ok(json!({ "alive": true, "asking": crate::acp::signin_ask::asks_the_person(&screen), "pane_id": hidden }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_signin_stop(agent_id: String, account_id: Option<String>) -> Result<(), String> {
    app_panes().stop(&crate::capacity_proxy::signin_pane::standalone_key(&agent_id, account_id.as_deref()));
    Ok(())
}
