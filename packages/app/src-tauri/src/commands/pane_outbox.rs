//! Tauri commands of the Chat tab's message box: send a message to the agent in a pane (now when it is ready,
//! later when its turn ends), cancel one that has not started, list a pane's messages. The list changes arrive as
//! `pane-outbox` events (`{ paneId, messages }`). Desktop commands; a phone uses the bridge routes
//! (`bridge/routes/panes.rs`), which share the same outbox.

use super::AppState;
use crate::attach::ChatAttachment;
use crate::pane_outbox::{self, OutboxMessage};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn pane_message_send(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    text: String,
    attachments: Option<Vec<ChatAttachment>>,
) -> Result<OutboxMessage, String> {
    let registry = state.registry.clone();
    let attachments = attachments.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || pane_outbox::global(&registry, &app).send_with(&pane_id, &text, &attachments))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))?
}

#[tauri::command]
pub async fn pane_message_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    message_id: String,
) -> Result<OutboxMessage, String> {
    pane_outbox::global(&state.registry, &app).cancel(&pane_id, &message_id)
}

/// Holds a waiting message back while the person edits it (`hold` true), or lets it go on (false).
#[tauri::command]
pub async fn pane_message_hold(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    message_id: String,
    hold: bool,
) -> Result<OutboxMessage, String> {
    pane_outbox::global(&state.registry, &app).hold(&pane_id, &message_id, hold)
}

/// Saves new text for a waiting message, in the same place in the list.
#[tauri::command]
pub async fn pane_message_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    message_id: String,
    text: String,
) -> Result<OutboxMessage, String> {
    pane_outbox::global(&state.registry, &app).edit(&pane_id, &message_id, &text)
}

#[tauri::command]
pub async fn pane_messages_list(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<Vec<OutboxMessage>, String> {
    Ok(pane_outbox::global(&state.registry, &app).list(&pane_id))
}
