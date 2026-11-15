//! "Make helper of..." in the sidebar (`crate::pty::pane_adopt`): the window's one command to drag an agent under
//! another agent, or take it back out. Desktop window only: no bridge route, no MCP tool, so an agent cannot hang
//! itself under another. The person's choice, nothing else, gives the new parent the right to steer a chat
//! (`acp::chat::surface::owned`).

use super::AppState;
use tauri::State;

/// Makes `pane_id` a helper of `parent_id`, or, with no `parent_id`, a main agent again. Refused with a plain sentence
/// (itself, a loop, a pane that is not open, a pane that is already a helper).
#[tauri::command]
pub fn pane_set_helper_of(state: State<'_, AppState>, pane_id: String, parent_id: Option<String>) -> Result<(), String> {
    set_helper_of(&state.registry, &pane_id, parent_id.as_deref())
}

pub(crate) fn set_helper_of(registry: &std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>, pane_id: &str, parent_id: Option<&str>) -> Result<(), String> {
    crate::pty::pane_adopt::reparent(registry, pane_id, parent_id).map_err(|refused| refused.0.to_string())?;
    // A chat keeps the link with its conversation and lets the new parent's agent steer it.
    if let Some(chat) = crate::acp::chat::get(pane_id) {
        chat.adopt_under(parent_id);
    }
    crate::bridge::notify_panes_changed();
    Ok(())
}
