//! Tauri commands for standby helpers (Settings > Agents > Standby helpers, and the top bar). See `standby::helpers`.

use crate::standby::helpers::{self, AfterTask, HelpersView, NewHelper};
use std::path::Path;

/// The standbys with their state (ready, busy, starting, asleep, problem).
#[tauri::command]
pub fn standby_helpers_get() -> HelpersView {
    helpers::view()
}

/// Make a standby. It starts at once and waits.
#[tauri::command]
pub fn standby_helper_add(input: NewHelper) -> Result<HelpersView, String> {
    if crate::acp::config::find_builtin(&input.agent).is_none() {
        return Err("That agent has no chat way to run yet, so it cannot wait on standby.".into());
    }
    if !Path::new(input.project.trim()).is_dir() {
        return Err("That project folder does not exist.".into());
    }
    let id = format!("sb-{}", uuid::Uuid::new_v4().simple());
    helpers::file().edit(|store| store.add(input, id).map(|_| ()))?;
    Ok(helpers::view())
}

/// Rename a standby, change its model, or change what it does after a task.
#[tauri::command]
pub fn standby_helper_update(id: String, name: Option<String>, model: Option<String>, change_model: bool, after_task: Option<AfterTask>) -> Result<HelpersView, String> {
    helpers::file().edit(|store| store.update(&id, name.as_deref(), change_model.then_some(model.as_deref()), after_task))?;
    Ok(helpers::view())
}

/// Remove a standby (a running task on it is not stopped).
#[tauri::command]
pub fn standby_helper_remove(id: String) -> Result<HelpersView, String> {
    helpers::file().edit(|store| if store.remove(&id) { Ok(()) } else { Err("That standby is gone.".to_string()) })?;
    Ok(helpers::view())
}

/// Start a standby that went to sleep (or failed) now.
#[tauri::command]
pub fn standby_helper_start(id: String) -> HelpersView {
    if let Some(pool) = crate::acp::warm::pool() {
        pool.wake_helper(&id);
        pool.tick(crate::event_log::now_ms());
    }
    helpers::view()
}

/// "At most N standbys" and "close a standby nobody used for N minutes".
#[tauri::command]
pub fn standby_helpers_set_limits(max: usize, idle_minutes: u64) -> Result<HelpersView, String> {
    helpers::file().edit(|store| store.set_settings(max, idle_minutes))?;
    Ok(helpers::view())
}
