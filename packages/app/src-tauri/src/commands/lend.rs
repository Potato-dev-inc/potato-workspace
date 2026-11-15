//! Share an agent commands (Labs `lend_enabled`): profiles, requests, answers, Revoke, Give back, and starting an
//! agent on a borrowed sign-in. Desktop only: Tauri commands, not bridge routes and not MCP tools, so an agent, the
//! companion or a paired phone can never lend, accept or revoke. Only an app window may call them. A pasted key goes
//! in and never comes back.

use super::*;
use crate::capacity_proxy::service::{Grant, LendProfile, LendRequest, LendState};
use crate::capacity_proxy::{self as lend, ACCOUNT_PREFIX, NOT_IN_THIS_MODE};

const WINDOWS: [&str; 3] = ["cockpit", "main", "settings"];

/// Whether a webview of this label is one of the app's own windows.
pub(crate) fn window_allowed(label: &str) -> bool {
    WINDOWS.contains(&label)
}

fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if window_allowed(webview.label()) {
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

/// Test link on a lend row: the real link handshake (borrower) or the lender's own checks and a ping (lender).
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_test_link(webview: tauri::Webview, grant_id: String) -> Result<lend::service::LinkTest, String> {
    on(&webview)?.test_link(&grant_id).await
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

/// A new lend sign-in for `agent_id`: an app-managed account folder marked lend-only, to sign into once. With `reuse` (the
/// draft's own account) a sign-in that is still signed out comes back as it is, so retries never pile up "Lend Claude".
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_account_add(webview: tauri::Webview, agent_id: String, label: String, reuse: Option<String>) -> Result<crate::accounts::Account, String> {
    on(&webview)?.signin_account(&agent_id, &label, reuse.as_deref())
}

/// Starts the sign-in of a lend sign-in in a HIDDEN pane that belongs to the sheet: not in the sidebar, never selected, so
/// the person stays where they are. Returns the pane id (the sheet shows its terminal). The pane is stopped by
/// `lend_signin_stop`, or after ten minutes.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_signin_start(webview: tauri::Webview, app: AppHandle, state: State<'_, AppState>, account_id: String) -> Result<serde_json::Value, String> {
    let acc = on(&webview)?.signin_pane_account(&account_id)?;
    let ports = std::sync::Arc::new(lend::signin_pane::AppPorts { registry: state.registry.clone(), app });
    let cwd = crate::app_paths::app_data_dir().join("lend").join("signin");
    let pane_id = lend::signin_pane::app_panes().start(ports, &acc, cwd)?;
    Ok(serde_json::json!({ "pane_id": pane_id }))
}

/// Where the lend sign-in stands: `signed_in` / `signed_out` / `expired`, who is signed in when the agent says so (this PC's
/// screen only), and whether the hidden sign-in pane still runs.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_signin_status(webview: tauri::Webview, account_id: String) -> Result<serde_json::Value, String> {
    let svc = on(&webview)?;
    let status = svc.signin_status(&account_id)?;
    Ok(serde_json::json!({
        "state": status.state,
        "identity": status.identity,
        "pane_alive": lend::signin_pane::app_panes().alive(&account_id),
    }))
}

/// Stops the sign-in pane. With `remove_if_empty`, a lend sign-in that holds no sign-in is forgotten (the person cancelled).
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_signin_stop(webview: tauri::Webview, account_id: String, remove_if_empty: bool) -> Result<bool, String> {
    let svc = on(&webview)?;
    lend::signin_pane::app_panes().stop(&account_id);
    if remove_if_empty {
        return svc.signin_remove_if_empty(&account_id);
    }
    Ok(false)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lend_request(
    webview: tauri::Webview,
    member_id: String,
    device_id: Option<String>,
    agent_id: String,
    secs: u64,
    reason: String,
    profile_id: Option<String>,
    profile_name: Option<String>,
) -> Result<LendRequest, String> {
    let svc = on(&webview)?;
    tauri::async_runtime::spawn_blocking(move || svc.request_with_profile(&member_id, device_id.as_deref(), &agent_id, secs, &reason, profile_id.as_deref(), profile_name.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// What can I borrow from this person (or this PC of mine)? Asks their PC(s) over the team relay and waits up to four
/// seconds. Only what THEY say this asker may use comes back: names and numbers, never a token, a path or an email.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_offers(webview: tauri::Webview, member_id: String, device_id: Option<String>) -> Result<lend::service::OffersResult, String> {
    on(&webview)?.offers(&member_id, device_id.as_deref(), std::time::Duration::from_secs(4)).await
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

/// The X on a past lend or borrow: forgets that ended row (a lend that still runs is never removed here).
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_grant_dismiss(webview: tauri::Webview, grant_id: String) -> Result<bool, String> {
    Ok(on(&webview)?.dismiss_grant(&grant_id))
}

/// "Clear" on the past lends (`out`) or past borrows (`in`): forgets every ended row of that side. Returns how many.
#[tauri::command(rename_all = "snake_case")]
pub async fn lend_past_clear(webview: tauri::Webview, direction: String) -> Result<usize, String> {
    let dir = match direction.as_str() {
        "out" => lend::service::Direction::Out,
        "in" => lend::service::Direction::In,
        _ => return Err("Pick lends or borrows.".into()),
    };
    Ok(on(&webview)?.clear_past(dir))
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
