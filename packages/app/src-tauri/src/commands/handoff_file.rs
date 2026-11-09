//! "Handoff from here": looks at the one file `HANDOFF.md` in a pane's folder so the window can tell whether
//! the agent wrote it. Reads nothing but the file's size and modified time; never its text.

use super::AppState;
use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::State;

/// The handoff file's file name. Fixed: the command can look at no other file.
pub const HANDOFF_FILE: &str = "HANDOFF.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffFileStat {
    pub exists: bool,
    pub modified_ms: u64,
    pub bytes: u64,
}

/// The stat of `HANDOFF.md` in `folder`. A missing (or unreadable) file is `exists: false`.
pub fn stat_handoff(folder: &Path) -> HandoffFileStat {
    let none = HandoffFileStat { exists: false, modified_ms: 0, bytes: 0 };
    let Ok(meta) = std::fs::metadata(folder.join(HANDOFF_FILE)) else { return none };
    if !meta.is_file() {
        return none;
    }
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    HandoffFileStat { exists: true, modified_ms, bytes: meta.len() }
}

/// `HANDOFF.md` in the pane's folder (the default project folder for an unknown pane).
#[tauri::command]
pub async fn handoff_file_stat(state: State<'_, AppState>, pane_id: String) -> Result<HandoffFileStat, String> {
    let folder = {
        let registry = state.registry.lock();
        registry.get(&pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone())
    };
    tauri::async_runtime::spawn_blocking(move || stat_handoff(Path::new(&folder)))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_does_not_exist() {
        let dir = std::env::temp_dir().join(format!("pm-handoff-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!stat_handoff(&dir).exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn written_file_reports_size_and_time() {
        let dir = std::env::temp_dir().join(format!("pm-handoff-some-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(HANDOFF_FILE), "# Goal\n").unwrap();
        let stat = stat_handoff(&dir);
        assert!(stat.exists);
        assert_eq!(stat.bytes, 7);
        assert!(stat.modified_ms > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_named_like_the_file_does_not_count() {
        let dir = std::env::temp_dir().join(format!("pm-handoff-dir-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(HANDOFF_FILE)).unwrap();
        assert!(!stat_handoff(&dir).exists);
        std::fs::remove_dir_all(&dir).ok();
    }
}
