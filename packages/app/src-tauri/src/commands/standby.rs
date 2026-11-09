//! Tauri commands for the warm standby pool (Settings > Performance).

use crate::standby::{self, StandbyConfig, StatusView};

#[tauri::command]
pub fn standby_get_status() -> StatusView {
    standby::status()
}

/// Save the pool settings, apply them at once (standbys that are no longer allowed are shut
/// down) and return the new state.
#[tauri::command]
pub fn standby_set_config(config: StandbyConfig) -> Result<StatusView, String> {
    standby::set_config(config)?;
    Ok(standby::status())
}

/// The cockpit focused a pane in `path`: warm workers follow that folder. The cockpit debounces
/// (about 2 s) so clicking through panes does not churn workers. Returns whether the followed
/// folder changed.
#[tauri::command]
pub fn standby_set_current_project(path: String) -> bool {
    standby::set_current_project(&path)
}
