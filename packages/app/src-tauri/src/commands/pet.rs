//! Desktop Potato: the few things its page asks the app for. Every command is a no-op when the window does not
//! exist (the switch is off), so none of them can ever create it.

use super::*;
use tauri::Manager;

/// The page wants room for a speech bubble or the menu above the sprite, or gives it back.
#[tauri::command]
pub async fn pet_set_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    crate::pet::set_expanded(&app, expanded);
    Ok(())
}

/// The person pressed on the pet and moved: let the system drag the window (the page cannot move a window itself).
#[tauri::command]
pub async fn pet_start_drag(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(crate::pet::LABEL) {
        Some(window) => window.start_dragging().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// A small step of a walk, in logical px. Answers true when the edge of the work area stopped it.
#[tauri::command]
pub async fn pet_move_by(app: AppHandle, dx: f64) -> Result<bool, String> {
    let dx = if dx.is_finite() { dx.clamp(-40.0, 40.0) } else { 0.0 };
    Ok(crate::pet::move_by(&app, dx))
}

/// Whether a full-screen app, a game or a presentation is in front; `null` when this computer cannot say.
#[tauri::command]
pub async fn pet_fullscreen_busy() -> Result<Option<bool>, String> {
    Ok(crate::pet::fullscreen_busy())
}
