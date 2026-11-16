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
    tauri::async_runtime::spawn_blocking(move || service().revoke(&id, &action)).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_sign_out_here(webview: tauri::Webview) -> Result<AccountView, String> {
    guard(&webview)?;
    tauri::async_runtime::spawn_blocking(|| service().sign_out_here()).await.map_err(|e| e.to_string())
}
