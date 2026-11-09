//! Tauri commands for chat conversations over ACP: the list, "Open in terminal" and "Back to chat".
//! Only the app's own webview can call these (no bridge route). A chat pane is its conversation (same id), so the pane header calls them.
//!
//! Hand-over asks before it interrupts: a conversation with a running turn (or a terminal whose agent is
//! working) answers `{ok: false, ask: ...}` and nothing changes; calling again with `force: true` is the
//! person's yes.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::acp::conversations::global;
use crate::acp::handover::{HandOverError, PaneActivity, PaneHost, TerminalStart};
use crate::pty::status::PaneStatus;

/// The app's real panes, for the hand-over.
struct AppPanes {
    app: AppHandle,
    registry: Arc<Mutex<PaneRegistry>>,
}

impl PaneHost for AppPanes {
    fn start(&self, start: &TerminalStart) -> Result<String, String> {
        let args = SpawnPaneArgs {
            agent_type: start.agent_type.clone(),
            cwd: Some(start.cwd.clone()),
            cols: None,
            rows: None,
            extra_args: Some(start.extra_args.clone()),
            pane_id: None,
            read_only: false,
            account: None,
            guard_env: None,
        };
        let pane = registry_spawn_pane(&self.registry, &self.app, args)?;
        let _ = self.app.emit("pty://panes-changed", ());
        Ok(pane)
    }

    fn activity(&self, pane_id: &str) -> PaneActivity {
        let registry = self.registry.lock();
        let Some(pane) = registry.get(pane_id) else { return PaneActivity::Gone };
        if *pane.exited.lock() {
            return PaneActivity::Gone;
        }
        let status = *pane.status.lock();
        match status {
            PaneStatus::Running => PaneActivity::Working,
            PaneStatus::WaitingInput => PaneActivity::NeedsInput,
            PaneStatus::Idle | PaneStatus::Error => PaneActivity::Idle,
        }
    }

    fn stop(&self, pane_id: &str) -> Result<(), String> {
        crate::pty::registry_kill_pane_and_wait(&self.registry, pane_id, Some("back to chat"))?;
        let _ = self.app.emit("pty://panes-changed", ());
        Ok(())
    }
}

fn panes(app: &AppHandle, state: &State<'_, AppState>) -> AppPanes {
    AppPanes { app: app.clone(), registry: state.registry.clone() }
}

/// `{ok: true, ...}`, or `{ok: false, ask: "...", reason}` when the person is asked first, or an error text.
fn answer<T: serde::Serialize>(result: Result<T, HandOverError>) -> Result<Value, String> {
    match result {
        Ok(done) => Ok(json!({ "ok": true, "result": done })),
        Err(e @ (HandOverError::TurnRunning { .. } | HandOverError::TerminalBusy { .. })) => {
            Ok(json!({ "ok": false, "ask": e.to_string(), "reason": format!("{e:?}") }))
        }
        Err(other) => Err(other.to_string()),
    }
}

/// Every chat conversation, with its notices and who may write to it.
#[tauri::command]
pub fn acp_conversations_list() -> Value {
    json!({ "labs_enabled": crate::acp::chat_enabled(), "conversations": global().list() })
}

/// Brings back the conversations that were live (lazily: nothing starts). Called once at app start.
pub fn acp_restore_at_start(app: &AppHandle, state: &State<'_, AppState>) -> crate::acp::conversations::RestoreReport {
    global().restore_lazily(&panes(app, state))
}

/// The same, for a screen that wants to ask again (it is safe to repeat: a session already there is replaced).
#[tauri::command]
pub fn acp_conversations_restore(app: AppHandle, state: State<'_, AppState>) -> Value {
    json!(acp_restore_at_start(&app, &state))
}

/// Starts a new chat conversation in `cwd`. Nothing runs until the first message.
#[tauri::command]
pub fn acp_conversation_create(agent: String, cwd: String) -> Result<Value, String> {
    if !crate::acp::chat_enabled() {
        return Err("FEATURE_OFF: chat (ACP) is switched off in Labs".into());
    }
    global().create(&agent, Path::new(&cwd)).map(|view| json!(view)).map_err(|e| e.to_string())
}

/// The closed chats, newest first: `[{id, agent, label, cwd, updated_ms, title}]`.
#[tauri::command]
pub fn acp_closed_list() -> Value {
    json!(global().closed_list())
}

/// "Reopen" on a closed chat: the conversation is live again and its chat pane is listed (nothing starts until it is
/// used, as after a restart). Returns the pane id. Refused for a chat that is not closed.
#[tauri::command]
pub async fn acp_reopen_closed(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    if !crate::acp::chat_enabled() {
        return Err("FEATURE_OFF: chat (ACP) is switched off in Labs".into());
    }
    let deps = super::acp_chat::live_deps(&app, &state.registry);
    let opened = tauri::async_runtime::spawn_blocking(move || {
        global().reopen_closed(&id).map_err(|e| match e {
            crate::acp::conversations::ConversationError::Unknown => "This chat is not closed any more.".to_string(),
            other => other.to_string(),
        })?;
        crate::acp::chat::restore_panes(&deps);
        Ok::<String, String>(id)
    })
    .await
    .map_err(|e| format!("INTERNAL: {e}"))??;
    let _ = app.emit("acp-conversations-changed", ());
    Ok(opened)
}

/// "Delete" on a closed chat: its record and its journal files go for good. Refused for a chat that is not closed.
#[tauri::command]
pub fn acp_delete_closed(app: AppHandle, id: String) -> Result<(), String> {
    global().delete_closed(&id).map_err(|_| "This chat is not closed any more.".to_string())?;
    let _ = app.emit("acp-conversations-changed", ());
    Ok(())
}

/// "Delete all closed chats". Returns how many were deleted.
#[tauri::command]
pub fn acp_delete_all_closed(app: AppHandle) -> usize {
    let n = global().delete_all_closed();
    let _ = app.emit("acp-conversations-changed", ());
    n
}

/// Tells the windows that a conversation changed hands: the chat pane re-reads its state (it shows the terminal or
/// the chat), and a terminal pane re-asks whether it holds a conversation.
fn announce_hand_over(app: &AppHandle, conversation: &str) {
    if let Some(chat) = crate::acp::chat::get(conversation) {
        let _ = app.emit("acp-chat-state", json!({ "paneId": conversation, "state": chat.state() }));
    }
    let _ = app.emit("acp-conversations-changed", ());
}

/// "Open in terminal": the chat lets go, a normal terminal pane continues the same conversation.
#[tauri::command]
pub async fn acp_open_in_terminal(app: AppHandle, state: State<'_, AppState>, conversation: String, force: Option<bool>) -> Result<Value, String> {
    let host = panes(&app, &state);
    let id = conversation.clone();
    let answered = tauri::async_runtime::spawn_blocking(move || answer(global().open_in_terminal(&conversation, force.unwrap_or(false), &host)))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))??;
    announce_hand_over(&app, &id);
    Ok(answered)
}

/// "Back to chat": the terminal is stopped, the chat loads the conversation again.
#[tauri::command]
pub async fn acp_back_to_chat(app: AppHandle, state: State<'_, AppState>, conversation: String, force: Option<bool>) -> Result<Value, String> {
    let host = panes(&app, &state);
    let id = conversation.clone();
    let answered = tauri::async_runtime::spawn_blocking(move || answer(global().back_to_chat(&conversation, force.unwrap_or(false), &host)))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))??;
    announce_hand_over(&app, &id);
    Ok(answered)
}

/// Does this ordinary terminal pane hold a chat conversation (it was opened with "Open in terminal")? Then
/// `{conversation, agent}`, so its header can offer "Back to chat". `null` for any other pane.
#[tauri::command]
pub fn acp_conversation_of_terminal(pane_id: String) -> Value {
    match global().of_terminal(&pane_id) {
        Some(view) => json!({ "conversation": view.id, "agent": view.agent }),
        None => Value::Null,
    }
}

/// The person has seen the notices of a conversation.
#[tauri::command]
pub fn acp_conversation_notices_seen(conversation: String) {
    global().mark_notices_seen(&conversation);
}

/// Told by the pane code when a pane's process ended: a conversation that was handed to it goes back to the chat.
pub fn pane_ended(app: &AppHandle, pane_id: &str) {
    if let Some(conversation) = global().terminal_closed(pane_id) {
        tracing::info!(conversation, pane_id, "acp: the terminal ended, the chat has the conversation again");
        announce_hand_over(app, &conversation);
    }
}
