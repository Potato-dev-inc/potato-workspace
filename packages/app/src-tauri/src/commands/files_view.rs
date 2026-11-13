//! The Files card and the file tab: list a folder, read a file, the changed / new marks, show in Explorer. All of
//! them are limited to the pane's project folder (see `crate::files`).

use super::AppState;
use crate::files::{self, FileContent, FileMark, FolderListing};
use tauri::State;

/// The project folder of a pane; without a pane (an older window) the default project folder.
fn pane_root(state: &AppState, pane_id: &str) -> String {
    let registry = state.registry.lock();
    registry.get(pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// The entries of one folder of the project (`path` is "" for the top).
#[tauri::command]
pub async fn files_list(state: State<'_, AppState>, pane_id: String, path: String, show_heavy: Option<bool>) -> Result<FolderListing, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::list_dir(&root, &path, show_heavy.unwrap_or(false))).await
}

/// One file of the project for the viewer (2 MB at most).
#[tauri::command]
pub async fn files_read(state: State<'_, AppState>, pane_id: String, path: String) -> Result<FileContent, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::read_file(&root, &path)).await
}

/// The changed and new files of the project folder.
#[tauri::command]
pub async fn files_marks(state: State<'_, AppState>, pane_id: String) -> Result<Vec<FileMark>, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || Ok(files::marks(&root))).await
}

/// Shows a file of the project in the system file manager.
#[tauri::command]
pub async fn files_reveal(state: State<'_, AppState>, pane_id: String, path: String) -> Result<(), String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::reveal(&root, &path)).await
}

/// What the agent changed in one file (a unified diff against the last commit).
#[tauri::command]
pub async fn files_diff(state: State<'_, AppState>, pane_id: String, path: String) -> Result<String, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::diff(&root, &path)).await
}
