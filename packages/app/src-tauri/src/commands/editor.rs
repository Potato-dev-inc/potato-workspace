//! "Open in my editor": which editors are installed, and open a project file (at a line) in one of them.
//! The file is limited to the pane's project folder; the program started is always one found by `crate::editor`.

use super::AppState;
use crate::editor::{self, EditorFound, Places};
use tauri::State;

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// The code editors installed on this computer.
#[tauri::command]
pub async fn editors_found() -> Result<Vec<EditorFound>, String> {
    blocking(|| Ok(editor::find_editors(&Places::from_env()))).await
}

/// Opens a file of the pane's project in the editor `editor` (an id from `editors_found`), at `line` when given.
#[tauri::command]
pub async fn open_in_editor(state: State<'_, AppState>, pane_id: String, path: String, editor: String, line: Option<u32>) -> Result<(), String> {
    let root = {
        let registry = state.registry.lock();
        registry.get(&pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone())
    };
    blocking(move || editor::open(&root, &path, &editor, line)).await
}
