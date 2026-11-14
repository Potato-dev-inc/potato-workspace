//! Tauri commands for file checkpoints (see `docs/features/checkpoints.md`). Errors are plain strings.

use crate::checkpoints::{self, FileChange, ListView, PutBackReport, RestoreReport, TurnReview};

#[tauri::command]
pub async fn checkpoints_list(pane_id: String) -> Result<ListView, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoints::list_view(&pane_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn checkpoint_diff(pane_id: String, id: String) -> Result<Vec<FileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoints::live().diff(&pane_id, &id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn checkpoint_restore(pane_id: String, id: String) -> Result<RestoreReport, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoints::live().restore(&pane_id, &id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// "Undo last turn": restores the start of the newest turn.
#[tauri::command]
pub async fn checkpoint_undo_last(pane_id: String) -> Result<RestoreReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoints::live().undo_last_turn(&pane_id).map_err(|e| match e {
            checkpoints::CheckpointError::NotFound => "There's nothing to undo yet.".to_string(),
            other => other.to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}


/// The files the pane's newest finished turn changed, for the file-by-file review (`None`: nothing to review).
#[tauri::command]
pub async fn checkpoint_turn_review(pane_id: String) -> Result<Option<TurnReview>, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoints::live().turn_review(&pane_id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// "Put back" for one file: return it to its state in checkpoint `before_id` (the start of the turn).
#[tauri::command]
pub async fn checkpoint_put_back(pane_id: String, before_id: String, path: String) -> Result<PutBackReport, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoints::live().put_back(&pane_id, &before_id, &path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// What the turn did to one file: its unified diff between the turn's two checkpoints.
#[tauri::command]
pub async fn checkpoint_file_patch(pane_id: String, from_id: String, to_id: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoints::live().file_patch(&pane_id, &from_id, &to_id, &path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
