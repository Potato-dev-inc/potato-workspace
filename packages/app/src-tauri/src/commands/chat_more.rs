//! Desktop commands for four chat features (the phone's side is `bridge/routes/chat_more.rs`, with the same checks):
//! "Show earlier" (a page of the chat's journal), a picture the agent named, and the draft that follows the person.

use serde_json::{json, Value};
use tauri::State;

use super::AppState;
use crate::session_chat::{draft, earlier, picture};

fn cwd_of(state: &AppState, pane_id: &str) -> Result<String, String> {
    state.registry.lock().get(pane_id).map(|pane| pane.info.cwd.clone()).ok_or_else(|| format!("unknown pane: {pane_id}"))
}

/// The items right before the oldest one the view holds: `{ items, more }`. `limit` 0 only asks whether there is more.
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_earlier(state: State<'_, AppState>, pane_id: String, before: String, limit: Option<usize>) -> Result<Value, String> {
    cwd_of(&state, &pane_id)?;
    tauri::async_runtime::spawn_blocking(move || earlier::for_pane(&pane_id, &before, limit.unwrap_or(earlier::DEFAULT_PAGE), false))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))
}

/// A picture the agent named, as `{ name, mime, size, dataUrl }`. The path must be inside the chat's project folder;
/// the refusal is one plain sentence (`PICTURE_*: ...`).
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_picture(state: State<'_, AppState>, pane_id: String, path: String) -> Result<Value, String> {
    let cwd = cwd_of(&state, &pane_id)?;
    tauri::async_runtime::spawn_blocking(move || chat_picture_of(&cwd, &path, picture::MAX_BYTES)).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// The body of `chat_picture`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_picture_of(cwd: &str, path: &str, max_bytes: u64) -> Result<Value, String> {
    picture::read(path, cwd, &picture::roots_for(cwd), max_bytes)
        .map(|found| serde_json::to_value(found).unwrap_or(Value::Null))
        .map_err(|refused| format!("{}: {}", refused.code, refused.message))
}

/// The draft of this chat that the PC holds (`{ text, at }`, empty text when there is none).
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_draft_get(pane_id: String) -> Result<Value, String> {
    Ok(draft::answer(draft::app_drafts().get(&pane_id)))
}

/// Keeps `text` as the draft of this chat (blank text drops it).
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_draft_set(pane_id: String, text: String) -> Result<Value, String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let kept = draft::app_drafts().set(&pane_id, &text, now);
    Ok(kept.map_or_else(|| json!({ "text": "", "at": 0 }), |d| json!({ "text": d.text, "at": d.at })))
}
