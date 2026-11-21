//! The Files card and the file tab: list a folder, read a file, the changed / new marks, show in Explorer. All of
//! them are limited to the pane's project folder (see `crate::files`).

use super::AppState;
use crate::files::{self, FileBytes, FileContent, FileMark, FolderListing};
use tauri::State;

/// The project folder of a pane; without a pane (an older window) the default project folder.
pub(crate) fn pane_root(state: &AppState, pane_id: &str) -> String {
    // A chat on another computer has no folder here: the NUL makes every file command fail instead of reading a local folder.
    if crate::acp::chat::is_remote_pane(pane_id) {
        return crate::acp::chat::NOT_ON_THIS_PC.to_string();
    }
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

/// One file of the project as raw bytes for the Word, Excel and PDF viewers (15 MB at most; bigger files stream, see `files_open_bytes`).
#[tauri::command]
pub async fn files_read_bytes(state: State<'_, AppState>, pane_id: String, path: String) -> Result<FileBytes, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::read_bytes(&root, &path)).await
}

/// What a Word, Excel or PDF file is, before its bytes stream to the viewer through the `pmfile` protocol (see
/// `files_stream.rs`): its size, and `too_large` when it is over 500 MB.
#[tauri::command]
pub async fn files_open_bytes(state: State<'_, AppState>, pane_id: String, path: String) -> Result<files::FileStreamInfo, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::open_info(&root, &path)).await
}

/// Opens a document of the project in the program the system chose for it (Word, Excel, a PDF reader).
#[tauri::command]
pub async fn files_open_default(state: State<'_, AppState>, pane_id: String, path: String) -> Result<(), String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::open_default(&root, &path)).await
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

/// Saves the editor's text over a file of the project. `base_version` is the version the editor opened; when the file
/// changed on disk since, the error starts with `FILES_CONFLICT` unless `overwrite` is true.
#[tauri::command]
pub async fn files_write(
    state: State<'_, AppState>,
    pane_id: String,
    path: String,
    text: String,
    base_version: Option<String>,
    overwrite: Option<bool>,
) -> Result<files::FileSaved, String> {
    let root = pane_root(&state, &pane_id);
    blocking(move || files::write_file(&root, &path, &text, base_version.as_deref(), overwrite.unwrap_or(false))).await
}

/// "Search inside files": the lines of the project's text files that have `query` (200 at most, off the UI thread).
/// `search_id` names the search so a newer one (or `files_search_cancel`) stops it; `folder` narrows it to one folder.
#[tauri::command]
pub async fn files_search_contents(state: State<'_, AppState>, pane_id: String, query: String, search_id: String, folder: Option<String>) -> Result<files::ContentSearch, String> {
    let root = pane_root(&state, &pane_id);
    let flag = files::begin_search(&search_id);
    let worker = flag.clone();
    let found = blocking(move || files::search_contents(&root, folder.as_deref(), &query, &worker)).await;
    files::end_search(&search_id, &flag);
    found
}

/// Stops a "search inside files" that is still running (nothing happens when it already ended).
#[tauri::command]
pub fn files_search_cancel(search_id: String) {
    files::cancel_search(&search_id);
}
