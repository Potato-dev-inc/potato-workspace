//! The sidebar's background tasks and handing one to another agent (`task_sidebar`, `handover`). Desktop window only:
//! no bridge route can change them, and no MCP tool, so an agent cannot hang a task under another agent by itself.

use super::AppState;
use crate::handover::{self, Mode};
use crate::task_sidebar::{self, Placement, Store};
use std::collections::HashMap;
use tauri::State;

/// The tasks shown in the sidebar, in order. Rows of agents that are closed are dropped first.
#[tauri::command]
pub fn task_sidebar_get(state: State<'_, AppState>) -> Store {
    let registry = state.registry.clone();
    let _ = task_sidebar::file().edit(|store| {
        let reg = registry.lock();
        store.prune(|id| reg.panes.contains_key(id));
        Ok(())
    });
    task_sidebar::file().snapshot()
}

/// Puts a task in the sidebar (under the agent that owns it, or on its own), or moves it when it is there already.
#[tauri::command]
pub fn task_sidebar_show(row: Placement) -> Result<Store, String> {
    task_sidebar::file().edit(|store| store.show(row))?;
    crate::bridge::notify_panes_changed();
    Ok(task_sidebar::file().snapshot())
}

/// Sets where a row is nested: under an agent's row, or (`under` empty) on its own.
#[tauri::command]
pub fn task_sidebar_place(task_id: String, under: Option<String>) -> Result<Store, String> {
    task_sidebar::file().edit(|store| if store.place(&task_id, under.as_deref()) { Ok(()) } else { Err("That task is not in the sidebar.".to_string()) })?;
    crate::bridge::notify_panes_changed();
    Ok(task_sidebar::file().snapshot())
}

/// "Back to Background tasks": the row goes, the task keeps running.
#[tauri::command]
pub fn task_sidebar_remove(task_id: String) -> Result<Store, String> {
    task_sidebar::file().edit(|store| {
        store.remove(&task_id);
        Ok(())
    })?;
    crate::bridge::notify_panes_changed();
    Ok(task_sidebar::file().snapshot())
}

/// The order of the rows among their siblings.
#[tauri::command]
pub fn task_sidebar_reorder(order: Vec<String>) -> Result<Store, String> {
    task_sidebar::file().edit(|store| {
        store.reorder(&order);
        Ok(())
    })?;
    Ok(task_sidebar::file().snapshot())
}

/// Hands the task `task_pane` (a minion) to another agent. `mode` is `now` or `when_finished`. `names` are the names the
/// window shows for the task and the two agents (keyed by pane id), told to the agents in the notices.
#[tauri::command]
pub fn task_hand_over(state: State<'_, AppState>, task_pane: String, to_pane: String, mode: Mode, names: Option<HashMap<String, String>>) -> Result<String, String> {
    let out = handover::hand_over_live(&state.registry, &task_pane, &to_pane, mode, names.unwrap_or_default()).map_err(|refused| refused.0.to_string())?;
    crate::bridge::notify_panes_changed();
    let said = match (out.mode, out.told_new) {
        (Mode::Now, true) | (Mode::WhenFinished, true) => String::new(),
        _ => format!("{} could not be told about it.", out.to_name),
    };
    Ok(said)
}

/// Takes back "hand over when it finishes" before it finished.
#[tauri::command]
pub fn task_hand_over_cancel(task_pane: String) -> bool {
    handover::cancel_pending(&task_pane)
}
