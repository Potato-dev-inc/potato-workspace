//! "Open in a new window" for a pane's chat or one of its file tabs. The window is another view of the same pane (it
//! reads the same state; no second agent starts). Same pattern as `artifacts_pop_out`.

use super::files_view::pane_root;
use super::AppState;
use crate::app_windows::{parse_tab, TabKind};
use tauri::State;

/// Whether `tab` may open in a window: the chat, or a file that is inside the project folder `root`.
pub(crate) fn check_tab(root: &str, tab: &str) -> Result<(), String> {
    match parse_tab(tab) {
        Some(TabKind::Chat) => Ok(()),
        Some(TabKind::File(path)) => {
            let (_, file) = crate::files::resolve_in_root(root, &path)?;
            if file.is_file() {
                Ok(())
            } else {
                Err("FILES_NOT_FOUND: That file is not there any more.".to_string())
            }
        }
        None => Err("TAB_WINDOW_BAD_TAB: That tab cannot open in a window.".to_string()),
    }
}

fn require_pane(state: &AppState, pane_id: &str) -> Result<(), String> {
    if state.registry.lock().get(pane_id).is_some() {
        Ok(())
    } else {
        Err("TAB_WINDOW_NO_PANE: That agent is not running any more.".to_string())
    }
}

/// Opens the chat (`tab` = `chat`) or a file (`tab` = `file:<path>`) of a pane in its own window.
#[tauri::command]
pub async fn tab_window_open(app: tauri::AppHandle, state: State<'_, AppState>, pane_id: String, tab: String, title: String) -> Result<(), String> {
    require_pane(&state, &pane_id)?;
    let root = pane_root(&state, &pane_id);
    let checked = tab.clone();
    tauri::async_runtime::spawn_blocking(move || check_tab(&root, &checked)).await.map_err(|e| format!("INTERNAL: {e}"))??;
    crate::app_windows::open_tab_window(&app, &pane_id, &tab, &title)
}

/// "Put back": closes the tab's window. The cockpit hears `tabwin://closed` and shows the tab in the pane again.
#[tauri::command]
pub fn tab_window_put_back(app: tauri::AppHandle, pane_id: String, tab: String) -> Result<(), String> {
    if parse_tab(&tab).is_none() {
        return Err("TAB_WINDOW_BAD_TAB: That tab cannot open in a window.".to_string());
    }
    crate::app_windows::close_tab_window(&app, &pane_id, &tab);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("potato-tabwin-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_chat_always_opens_and_a_file_must_be_inside_the_project() {
        let dir = scratch("check");
        let other = scratch("check-other");
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(other.join("s.txt"), "x").unwrap();
        let root = dir.to_str().unwrap();
        assert!(check_tab(root, "chat").is_ok());
        assert!(check_tab(root, "file:a.txt").is_ok());
        assert!(check_tab(root, "file:missing.txt").unwrap_err().starts_with("FILES_NOT_FOUND"));
        assert!(check_tab(root, "file:sub").unwrap_err().starts_with("FILES_NOT_FOUND"), "a folder is not a file tab");
        assert!(check_tab(root, "file:../x/s.txt").unwrap_err().starts_with("TAB_WINDOW_BAD_TAB"));
        let abs = format!("file:{}", other.join("s.txt").to_str().unwrap().replace('\\', "/"));
        assert!(check_tab(root, &abs).is_err(), "an absolute path elsewhere is refused");
        assert!(check_tab(root, "terminal").unwrap_err().starts_with("TAB_WINDOW_BAD_TAB"));
    }
}
