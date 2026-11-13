//! Tauri commands for "Bring my projects from Orca". Rules live in `crate::import_orca`.

use crate::import_orca::{self, OrcaProject, OrcaScan};

/// Look at Orca's files on this PC (read-only). Runs only when the person presses the button.
#[tauri::command]
pub fn orca_import_scan() -> OrcaScan {
    import_orca::scan()
}

/// Check the picked folders against Orca's list and return the ones that may be added. The window adds them with
/// the same call as the sidebar's "Add project" (the project list lives in the window's own storage).
#[tauri::command]
pub fn orca_import_add(projects: Vec<String>) -> Vec<OrcaProject> {
    import_orca::accept(&projects, &import_orca::scan())
}
