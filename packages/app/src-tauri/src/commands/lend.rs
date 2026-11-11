//! Share an agent commands (Labs `lend_enabled`): profiles, requests, answers, Revoke, Give back, and starting an
//! agent on a borrowed sign-in. Desktop only: Tauri commands, not bridge routes and not MCP tools, so an agent, the
//! companion or a paired phone can never lend, accept or revoke. Only an app window may call them. A pasted key goes
//! in and never comes back.

use super::*;
use crate::capacity_proxy::service::{Grant, LendProfile, LendRequest, LendState};
use crate::capacity_proxy::{self as lend, ACCOUNT_PREFIX, NOT_IN_THIS_MODE};

const WINDOWS: [&str; 3] = ["cockpit", "main", "settings"];

fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if WINDOWS.contains(&webview.label()) {
        Ok(())
    } else {
        Err("Share an agent works only in the app window.".to_string())
    }
}

/// Window check, switch check and the service, in one place.
fn on(webview: &tauri::Webview) -> Result<std::sync::Arc<lend::service::Lend>, String> {
    guard(webview)?;
    lend::app_service()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_state(webview: tauri::Webview) -> Result<LendState, String> {
    guard(&webview)?;
    if !lend::enabled() {
        return Ok(LendState { enabled: false, profiles: vec![], grants: vec![], requests_in: vec![], requests_out: vec![], drivers: vec![], keeping_awake: false });
    }
    Ok(lend::app_service()?.state(true))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_profile_save(webview: tauri::Webview, profile: LendProfile) -> Result<LendProfile, String> {
    on(&webview)?.profile_save(profile)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_profile_delete(webview: tauri::Webview, id: String) -> Result<(), String> {
    on(&webview)?.profile_delete(&id)
}

/// The API key pasted into a lend profile, into the OS credential store. Never returned.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_key_set(webview: tauri::Webview, profile_id: String, key: String) -> Result<(), String> {
    on(&webview)?.key_set(&profile_id, &key)
}

/// A new lend sign-in for `agent_id`: an app-managed account folder marked lend-only, to sign into once.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_account_add(webview: tauri::Webview, agent_id: String, label: String) -> Result<crate::accounts::Account, String> {
    on(&webview)?;
    crate::accounts::Store::default_location().add_lend(&agent_id, &label)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_request(
    webview: tauri::Webview,
    member_id: String,
    device_id: Option<String>,
    agent_id: String,
    secs: u64,
    reason: String,
) -> Result<LendRequest, String> {
    let svc = on(&webview)?;
    tauri::async_runtime::spawn_blocking(move || svc.request(&member_id, device_id.as_deref(), &agent_id, secs, &reason))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_answer(
    webview: tauri::Webview,
    request_id: String,
    accept: bool,
    profile_id: Option<String>,
    secs: Option<u64>,
) -> Result<Option<Grant>, String> {
    on(&webview)?.answer(&request_id, accept, profile_id.as_deref(), secs).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_revoke(webview: tauri::Webview, grant_id: String) -> Result<(), String> {
    let svc = on(&webview)?;
    tauri::async_runtime::spawn_blocking(move || svc.revoke(&grant_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_return(webview: tauri::Webview, grant_id: String) -> Result<(), String> {
    let svc = on(&webview)?;
    tauri::async_runtime::spawn_blocking(move || svc.give_back(&grant_id)).await.map_err(|e| e.to_string())?
}

/// Starts the grant's agent in `project_path` on the borrowed sign-in `lend:<grant id>`: the same path every
/// account takes (`accounts::Store::launch_env`).
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_start_agent(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    grant_id: String,
    project_path: String,
) -> Result<serde_json::Value, String> {
    let svc = on(&webview)?;
    let (agent_id, _, _) = svc.grant_agent(&grant_id).ok_or("That borrowed sign-in is gone.")?;
    let account = format!("{ACCOUNT_PREFIX}{grant_id}");
    let args = SpawnPaneArgs {
        agent_type: agent_id,
        cwd: Some(project_path),
        cols: None,
        rows: None,
        extra_args: None,
        pane_id: None,
        read_only: false,
        account: Some(account),
        guard_env: None,
    };
    let pane_id = registry_spawn_pane(&state.registry, &app, args)?;
    let _ = app.emit("pty://panes-changed", ());
    Ok(serde_json::json!({ "pane_id": pane_id }))
}

/// "Lend normally" (.pm files) is not part of Lend through my PC.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_export_pm(webview: tauri::Webview) -> Result<(), String> {
    guard(&webview)?;
    Err(NOT_IN_THIS_MODE.into())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_import_pm(webview: tauri::Webview) -> Result<(), String> {
    guard(&webview)?;
    Err(NOT_IN_THIS_MODE.into())
}
