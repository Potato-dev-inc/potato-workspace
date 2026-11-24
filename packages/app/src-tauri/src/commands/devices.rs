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
        "hosting": null, "pending": null, "joining": null, "message": null, "locked_until": null, "tampered": false, "devices": [], "transfers": [],
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

/// The person's pick of the matching number (or the digits they typed) on the "wants to pair" sheet. Only this window can send it.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_pair_pick(webview: tauri::Webview, id: u64, pick: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.pair_pick(id, &pick)
}

/// The person dismissed the note that a PC was unpaired because the account said it was signed out.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_dismiss_removed_pc(webview: tauri::Webview, id: String) -> Result<(), String> {
    guard(&webview)?;
    dl::dismiss_removed_pc(&id);
    Ok(())
}

/// "Let my other PCs open this PC": the tick. Only this window can set it (it is not one of the settings a phone, the bridge or an
/// agent's config plan can patch).
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_open_from_account(webview: tauri::Webview, on: bool) -> Result<(), String> {
    guard(&webview)?;
    dl::set_open_from_account(on).await
}

/// My other PCs from the account (Connect > My PCs): name, online, and what Open would do. Reads the account.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_account_pcs(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    if !dl::enabled() {
        return Ok(serde_json::json!({ "available": false, "signed_in": false, "open_here": false, "published": false, "pcs": [] }));
    }
    let svc = dl::app_service()?;
    tauri::async_runtime::spawn_blocking(move || svc.account_pcs()).await.map_err(|e| e.to_string())?
}

/// "Open" on a PC of my account: the first time the two PCs pair (both people pick the number); after that it only checks the PC answers.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_open_account_pc(webview: tauri::Webview, id: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.open_account_pc(&id).await
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

/// The one-time card on a PC paired through the account before Full became its default: Keep or Lower. Only this window can answer.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_account_default_answer(webview: tauri::Webview, node: String, keep: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.answer_account_default(&node, keep)
}

/// The cards "<PC> asks to work on this PC", waiting for this PC's person.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_full_asks(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    Ok(dl::app_service()?.full_asks())
}

/// The person tapped Allow or No on one card. Only this window can do it.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_full_ask_answer(webview: tauri::Webview, id: String, allow: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.answer_full_ask(&id, allow)
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

/// "Also allow it through my web address" (signed read-only calls through this PC's public tunnel address) for one device. Off by default.
/// An app-window command only: not a bridge route, not an MCP tool, so no phone, agent or paired PC can turn it on.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_pcdoor(webview: tauri::Webview, node: String, on: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_pcdoor(&node, on)
}

/// "Agents may send work to this device" for one device (off by default).
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_agents_send(webview: tauri::Webview, node: String, on: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_agents_send(&node, on)
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
pub async fn devices_request(webview: tauri::Webview, node: String, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    guard(&webview)?;
    let (status, body) = dl::app_service()?.request(&node, &method, &path, body).await?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

/// Opens a far dev server (`port` of far chat `pane_id` on `node`) in a preview window of its own (`device_link/far_preview.rs`). The far PC
/// must list that port for that chat, and the page is shown through the app's own protocol: no port opens on this PC.
#[tauri::command(rename_all = "snake_case")]
pub async fn far_preview_open(app: tauri::AppHandle, webview: tauri::Webview, node: String, pane_id: String, port: u16) -> Result<(), String> {
    guard(&webview)?;
    crate::device_link::far_preview::open(&app, &node, &pane_id, port)
}

/// "Share" on a chat of another PC: that PC makes the page or the Markdown (`pclink::calls_p4a`) and this PC keeps it under a one-time
/// token, so the Save dialog here writes it (`chat_export_save`) and the window never sends text of its own. The answer has the shape of
/// `chat_export_html` / `chat_export_markdown`. What came from afar is data: a page that carries a script is refused, and the size is capped.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_chat_export(webview: tauri::Webview, chat: tauri::State<'_, super::SessionChatState>, node: String, pane_id: String, markdown: bool) -> Result<Value, String> {
    use crate::device_link::pclink::calls_p4a::EXPORT_MAX;
    guard(&webview)?;
    let (cmd, key) = if markdown { ("chat_export_markdown", "markdown") } else { ("chat_export_html", "html") };
    let (status, body) = dl::app_service()?.request(&node, "POST", &format!("/pclink/call/{cmd}"), Some(serde_json::json!({ "paneId": pane_id }))).await?;
    if status != 200 {
        return Err(body["error"].as_str().unwrap_or("The other PC could not make the file.").to_string());
    }
    let text = body[key].as_str().ok_or("The other PC sent no file.")?.to_string();
    if text.len() > EXPORT_MAX {
        return Err("This chat is too big to save as one file. Pick fewer turns.".into());
    }
    if !markdown && text.to_ascii_lowercase().contains("<script") {
        return Err("The other PC sent a page that holds a script, so it was not saved.".into());
    }
    let kind = if markdown { crate::session_chat::export_save::PageKind::Markdown } else { crate::session_chat::export_save::PageKind::Html };
    let token = chat.pages().keep(&format!("dev:{node}:{pane_id}"), kind, &text)?;
    let mut out = serde_json::Map::new();
    out.insert(key.into(), Value::String(text));
    out.insert("token".into(), Value::String(token));
    Ok(Value::Object(out))
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

/// "Borrow my agent sign-ins" for one device: that device may ask this PC to lend an agent (off by default). Nothing is copied.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_lend(webview: tauri::Webview, node: String, on: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_lend(&node, on)
}

// ----- files (phase 4): browse a device's shared folders, copy to this PC, send a file there -----

/// What this PC lets that device do with its files here (its own switch, apart from running agents).
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_set_files(webview: tauri::Webview, node: String, on: bool) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.set_files(&node, on)
}

/// The folders this PC shares with that device (project folders, and the ones the person added).
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_folders(webview: tauri::Webview, node: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.files_folders(&node)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_set_folders(webview: tauri::Webview, node: String, folders: Vec<String>) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.files_set_folders(&node, &folders)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_roots(webview: tauri::Webview, node: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.far_roots(&node).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_list(webview: tauri::Webview, node: String, root: String, path: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.far_list(&node, &root, &path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_preview(webview: tauri::Webview, node: String, root: String, path: String) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.far_preview(&node, &root, &path).await
}

/// `Copy to this PC`: into Downloads (or `dest`). `on_exists`: `ask`, `replace` or `both`.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_copy(webview: tauri::Webview, node: String, root: String, paths: Vec<String>, dest: Option<String>, on_exists: Option<String>) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.far_copy(&node, &root, &paths, dest.as_deref(), on_exists.as_deref().unwrap_or("ask")).await
}

/// `Send a file there`: local files or folders into a far shared folder.
#[tauri::command(rename_all = "snake_case")]
pub async fn devices_files_send(webview: tauri::Webview, node: String, root: String, dir: String, local: Vec<String>, on_exists: Option<String>) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.far_send(&node, &root, &dir, &local, on_exists.as_deref().unwrap_or("ask")).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_transfer_cancel(webview: tauri::Webview, id: u64) -> Result<(), String> {
    guard(&webview)?;
    dl::app_service()?.transfer_cancel(id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn devices_transfers_clear(webview: tauri::Webview) -> Result<Value, String> {
    guard(&webview)?;
    dl::app_service()?.transfers_clear()
}
