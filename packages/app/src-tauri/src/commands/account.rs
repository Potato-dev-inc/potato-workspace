//! Account commands (Labs `account_enabled`): sign in, the device list, sign a device out.
//! Desktop only: Tauri commands, not bridge routes and not MCP tools, so an agent, the companion or a paired phone
//! can never start a sign-in or sign a device out. Only an app window may call them. The window gets plain views:
//! never the session token, the ticket or the verifier.

use crate::account::service::{service, AccountView, DevicesReply};

const WINDOWS: [&str; 3] = ["cockpit", "main", "settings"];

fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if WINDOWS.contains(&webview.label()) {
        Ok(())
    } else {
        Err("The account works only in the app window.".to_string())
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_state(webview: tauri::Webview) -> Result<AccountView, String> {
    guard(&webview)?;
    Ok(service().view())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_sign_in(webview: tauri::Webview) -> Result<AccountView, String> {
    guard(&webview)?;
    service().start_sign_in()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_cancel_sign_in(webview: tauri::Webview) -> Result<AccountView, String> {
    guard(&webview)?;
    Ok(service().cancel_sign_in())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_devices(webview: tauri::Webview) -> Result<DevicesReply, String> {
    guard(&webview)?;
    tauri::async_runtime::spawn_blocking(|| service().devices()).await.map_err(|e| e.to_string())?
}

/// `action` is `sign_out` or `not_me`.
#[tauri::command(rename_all = "snake_case")]
pub async fn account_revoke_device(webview: tauri::Webview, id: String, action: String) -> Result<DevicesReply, String> {
    guard(&webview)?;
    let target = id.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || service().revoke(&id, &action)).await.map_err(|e| e.to_string())??;
    // "Not me" and "Sign out" end this PC's pairing with that device too: a device that is gone from the account must not keep the keys.
    crate::device_link::app::forget_account_device(&target).await;
    Ok(reply)
}

/// The answer to "Add <machine> to your account?" for a screen-less machine: `allow` false is "Not me".
#[tauri::command(rename_all = "snake_case")]
pub async fn account_approve_device(webview: tauri::Webview, code: String, allow: bool) -> Result<(), String> {
    guard(&webview)?;
    tauri::async_runtime::spawn_blocking(move || service().approve_device_code(&code, allow)).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_sign_out_here(webview: tauri::Webview) -> Result<AccountView, String> {
    guard(&webview)?;
    let view = tauri::async_runtime::spawn_blocking(|| service().sign_out_here()).await.map_err(|e| e.to_string())?;
    // This PC is out of the address book now: its door stays shut until the person signs in again.
    crate::device_link::app::account_changed();
    Ok(view)
}
