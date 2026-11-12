//! Tauri commands for ambient state and pane titles (docs/features/ambient-and-titles.md).

use super::*;

/// Rename a pane. A blank name clears it and automatic titling resumes. Returns the stored title.
#[tauri::command]
pub async fn pane_set_title(app: AppHandle, state: State<'_, AppState>, pane_id: String, title: String) -> Result<Option<String>, String> {
    if !state.registry.lock().panes.contains_key(&pane_id) {
        return Err(format!("unknown pane {pane_id}"));
    }
    let stored = crate::ambient::store::set_user_title(&pane_id, &title);
    crate::ambient::announce_title_change(&app, &pane_id);
    Ok(stored)
}
