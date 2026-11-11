//! Files a person adds to a chat message. The message carries them as a list (`ChatAttachment`), not as text: see
//! `crate::attach`. Nothing is uploaded.

use super::AppState;
use crate::attach::{self, search::ProjectFile, ChatAttachment};
use std::path::Path;
use tauri::State;

/// The folder of a pane; without a pane (an older window) the default project folder.
fn pane_cwd(state: &AppState, pane_id: &str) -> String {
    let registry = state.registry.lock();
    registry.get(pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone())
}

fn failed(e: tauri::Error) -> String {
    format!("INTERNAL: {e}")
}

/// Prepares the files a person picked for a pane's message. The pane's folder decides where copies go.
#[tauri::command]
pub async fn attachment_prepare(state: State<'_, AppState>, pane_id: String, paths: Vec<String>) -> Result<Vec<ChatAttachment>, String> {
    if paths.len() > attach::MAX_ATTACHMENTS {
        return Err(format!("ATTACHMENT_TOO_MANY: at most {} files go with one message.", attach::MAX_ATTACHMENTS));
    }
    let cwd = pane_cwd(&state, &pane_id);
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|path| attach::prepare_one(Path::new(path), &cwd)).collect())
        .await
        .map_err(failed)?
}

/// Saves a picture pasted into the message box (Ctrl+V).
#[tauri::command]
pub async fn attachment_save_pasted(state: State<'_, AppState>, pane_id: String, name: String, mime: String, data_base64: String) -> Result<ChatAttachment, String> {
    let cwd = pane_cwd(&state, &pane_id);
    tauri::async_runtime::spawn_blocking(move || attach::save_pasted(&cwd, &name, &mime, &data_base64)).await.map_err(failed)?
}

/// A `data:` URL of a picture for the thumbnail in the message box, or `None`.
#[tauri::command]
pub async fn attachment_preview(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || attach::preview(Path::new(&path))).await.map_err(failed)
}

/// The project files that match what was typed after `@`.
#[tauri::command]
pub async fn project_files_search(state: State<'_, AppState>, pane_id: String, query: String, limit: Option<usize>) -> Result<Vec<ProjectFile>, String> {
    let cwd = pane_cwd(&state, &pane_id);
    tauri::async_runtime::spawn_blocking(move || attach::search::search(&cwd, &query, limit)).await.map_err(failed)
}

/// The paths of files copied in Explorer (Ctrl+C), for Ctrl+V in the message box. Empty when there are none, or outside Windows.
#[tauri::command]
pub async fn clipboard_file_paths() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(attach::clipboard::clipboard_file_paths).await.map_err(failed)
}
