//! Devices commands (Labs `devices_enabled`): pair another PC, switch what it may do here, and send requests to it.
//! Desktop only: Tauri commands, not bridge routes and not MCP tools, so an agent, the companion or a paired phone can
//! never show a code, answer the "wants to pair" sheet or send work to another PC. Only an app window may call them.

use serde_json::Value;

use crate::device_link::app as dl;

const WINDOWS: [&str; 3] = ["cockpit", "main", "settings"];

fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if WINDOWS.contains(&webview.label()) {
        Ok(())
    } else {
        Err("Devices works only in the app window.".to_string())
    }
}

fn off_view() -> Value {
    serde_json::json!({
        "enabled": false, "name": dl::computer_name(), "route_pref": "auto", "own_route_ready": false,
        "hosting": null, "pending": null, "joining": null, "message": null, "locked_until": null, "tampered": false, "devices": [],
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_state(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    if !dl::enabled() {
        return Ok(off_view());
    }
    let svc = dl::app_service()?;
    svc.probe_if_stale(10);
    Ok(svc.view())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_show_code(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.show_code().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_cancel_code(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.cancel_code()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_join(webview: tauri::Webview, address: String, code: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.join(&address, &code).await
}

/// The person's answer to the "wants to pair" sheet. Only this window can send it.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_pair_answer(webview: tauri::Webview, id: u64, allow: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.pair_answer(id, allow)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_rename(webview: tauri::Webview, node: String, name: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.rename(&node, &name)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_permission(webview: tauri::Webview, node: String, capability: String, on: bool, level: Option<String>) -> Result<Value, String> {
    guard(&webview)?;
    if capability != crate::p2p::capability::AGENTS_REMOTE {
        return Err("That cannot be turned on here.".into());
    }
    dl::app_service()?.set_permission(&node, on, level.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_remove(webview: tauri::Webview, node: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.remove(&node).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_route(webview: tauri::Webview, pref: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_route(&pref).await
}

/// A pairing link for a device that is far away (single use, 10 minutes). Both people still confirm.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_make_link(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.make_link().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_join_link(webview: tauri::Webview, link: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.join_link(&link).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_activity(webview: tauri::Webview, node: Option<String>) -> Result<Value, String> {
    guard(&webview)?;
    if !dl::enabled() {
        return Ok(Value::Array(Vec::new()));
    }
    dl::app_service()?.activity(node.as_deref())
}

/// "Also allow it through my web address" for one device.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_web(webview: tauri::Webview, node: String, on: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_web(&node, on)
}

/// One device's own route choice (`null`: follow this PC's choice).
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_device_route(webview: tauri::Webview, node: String, pref: Option<String>) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_device_route(&node, pref.as_deref()).await
}

/// Ends a device's access now: its switch goes off and its link closes.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_disconnect(webview: tauri::Webview, node: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.disconnect(&node)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_screen_start(webview: tauri::Webview, node: String, pane_id: String) -> Result<(), String> {
    guard(&webview)?;
    dl::app_service()?.screen_start(&node, &pane_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_screen_stop(webview: tauri::Webview, node: String, pane_id: String) -> Result<(), String> {
    guard(&webview)?;
    dl::app_service()?.screen_stop(&node, &pane_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_request(webview: tauri::Webview, node: String, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    guard(&webview)?;
    let (status, body) = dl::app_service()?.request(&node, &method, &path, body).await?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_subscribe(webview: tauri::Webview, node: String) -> Result<(), String> {
    guard(&webview)?;
    dl::app_service()?.subscribe(&node)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_unsubscribe(webview: tauri::Webview, node: String) -> Result<(), String> {
    guard(&webview)?;
    dl::app_service()?.unsubscribe(&node)
}
