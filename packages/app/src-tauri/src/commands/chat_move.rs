//! "Move to..." in the chat menu (`crate::chat_move`): the window's commands for moving a chat to another device.
//! Desktop window only: no bridge route, no MCP tool. The far device is driven by the window through the ordinary PC
//! link (`devices_request`), so the far side's own rights decide; these commands only keep the near side's book (the lock
//! and the "Moved to..." note), make the history text and, for the work, the git bundle.
//!
//! Order: `chat_move_begin` (locks; refuses while a reply runs) -> `chat_move_history` or `chat_move_prepare_work`
//! -> the window sends it to the far device -> `chat_move_finish` (or `chat_move_abort`, which unlocks).

use super::chat_export::read_items;
use super::session_chat::SessionChatState;
use super::AppState;
use crate::chat_move::{self, work, Moved, Status};
use crate::session_chat::export::{self, Meta, TurnRange};
use base64::Engine as _;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

const HOLDER: &str = "chat-move";
const NO_CHAT: &str = "That chat is not open any more.";

/// The window listens for this to redraw the chat's note and box: the pane id.
pub const CHANGED: &str = "chat-move://changed";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub agent_type: String,
    pub agent_label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// The whole first message for the new agent.
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkReady {
    pub branch: String,
    pub sha: String,
    pub bundle_b64: String,
    pub size: usize,
}

fn pane_facts(state: &AppState, pane_id: &str) -> Result<(String, String, String), String> {
    let registry = state.registry.lock();
    let pane = registry.get(pane_id).ok_or_else(|| NO_CHAT.to_string())?;
    Ok((pane.info.agent_type.clone(), pane.info.cwd.clone(), pane.info.status.clone()))
}

fn note(app: &AppHandle, pane_id: &str) {
    let _ = app.emit(CHANGED, pane_id);
}

/// Where the chat stands: nothing, moving, or moved (with the note's facts).
#[tauri::command]
pub fn chat_move_status(pane_id: String) -> Status {
    chat_move::book().status(&pane_id)
}

/// Locks the chat for a move. `mode` is `history` or `work`. Refused while a reply runs or the chat already moves.
/// For `work` the folder must be a git project: the sentence says so before anything is sent.
#[tauri::command]
pub async fn chat_move_begin(app: AppHandle, state: State<'_, AppState>, pane_id: String, mode: String) -> Result<Begun, String> {
    let (agent_type, cwd, status) = pane_facts(&state, &pane_id)?;
    let running = matches!(status.as_str(), "running" | "waiting_input");
    chat_move::book().begin(&pane_id, running, &mode)?;
    if mode == "work" {
        let dir = PathBuf::from(&cwd);
        let is_git = tauri::async_runtime::spawn_blocking(move || super::pane_git::branch_of(&dir).is_some()).await.unwrap_or(false);
        if !is_git {
            chat_move::book().abort(&pane_id);
            return Err(work::NOT_GIT.to_string());
        }
    }
    note(&app, &pane_id);
    Ok(Begun { agent_label: crate::ambient::agent_label(&agent_type), agent_type })
}

/// The history as the first message for the new agent. Only while the chat is locked for a move.
#[tauri::command]
pub async fn chat_move_history(
    app: AppHandle,
    state: State<'_, AppState>,
    chat: State<'_, SessionChatState>,
    pane_id: String,
    from_device: String,
) -> Result<History, String> {
    if !matches!(chat_move::book().status(&pane_id), Status::Moving { .. }) {
        return Err("That chat is not moving.".into());
    }
    let (items, agent_type, cwd) = read_items(&app, &state, &chat, &pane_id, HOLDER).await?;
    let ctx = crate::redact::known::context();
    let agent = crate::ambient::agent_label(&agent_type);
    let meta = Meta { agent: agent.clone(), folder: export::folder_of(&cwd, ctx.home.as_deref()), date: chrono::Local::now().format("%Y-%m-%d").to_string() };
    let markdown = crate::session_chat::export_md::markdown(&items, &meta, TurnRange { from: None, to: None }, &ctx);
    let name: String = from_device.chars().filter(|c| !c.is_control()).take(60).collect();
    Ok(History { text: chat_move::history_message(&markdown, &agent, &name) })
}

/// The work as a git bundle on a branch `potato/move-<id>`. Only while the chat is locked for a `work` move.
#[tauri::command]
pub async fn chat_move_prepare_work(state: State<'_, AppState>, pane_id: String) -> Result<WorkReady, String> {
    if chat_move::book().status(&pane_id) != (Status::Moving { mode: "work".into() }) {
        return Err("That chat is not moving with its work.".into());
    }
    let (_, cwd, _) = pane_facts(&state, &pane_id)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let branch = work::branch_for(&work::move_id(&pane_id, now));
    let made = tauri::async_runtime::spawn_blocking(move || work::prepare(std::path::Path::new(&cwd), &branch))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))??;
    Ok(WorkReady { size: made.bytes.len(), bundle_b64: base64::engine::general_purpose::STANDARD.encode(&made.bytes), branch: made.branch, sha: made.sha })
}

/// The far device has the chat: it stays here, read-only, with the note.
#[tauri::command]
pub fn chat_move_finish(app: AppHandle, pane_id: String, node: String, device: String, far_pane: String) -> Result<(), String> {
    let mode = match chat_move::book().status(&pane_id) {
        Status::Moving { mode } => mode,
        _ => return Err("That chat is not moving.".into()),
    };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let clip = |s: String, max: usize| -> String { s.chars().filter(|c| !c.is_control()).take(max).collect() };
    chat_move::book().finish(&pane_id, Moved { node: clip(node, 80), device: clip(device, 60), far_pane: clip(far_pane, 128), at, mode })?;
    note(&app, &pane_id);
    Ok(())
}

/// The move did not happen: the chat opens again.
#[tauri::command]
pub fn chat_move_abort(app: AppHandle, pane_id: String) {
    chat_move::book().abort(&pane_id);
    note(&app, &pane_id);
}
