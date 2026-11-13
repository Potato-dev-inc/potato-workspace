//! The agents already on this computer (`agent_store::detect`), for the Add an agent screen.

use crate::agent_store::detect::{self, FoundAgent};

/// Looks on the PATH for the agents the app knows by program name and asks each for its version. Runs `--version`
/// only. `project_dir` leaves out any folder inside the open project (a program the project ships is not "installed").
#[tauri::command]
pub async fn agents_detect_installed(project_dir: Option<String>) -> Result<Vec<FoundAgent>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = project_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(std::path::PathBuf::from);
        detect::detect_on_this_pc(dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}
