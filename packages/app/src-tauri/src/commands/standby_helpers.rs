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
    // Started now, not at the next pass of the pool's 2 s loop.
    crate::acp::warm::refresh_now();
    Ok(helpers::view())
}

/// Rename a standby, change its model, or change what it does after a task.
#[tauri::command]
pub fn standby_helper_update(id: String, name: Option<String>, model: Option<String>, change_model: bool, after_task: Option<AfterTask>, home: Option<String>, change_home: Option<bool>, kind: Option<crate::agent_run_mode::StartedAs>) -> Result<HelpersView, String> {
    helpers::file().edit(|store| {
        store.update(&id, name.as_deref(), change_model.then_some(model.as_deref()), after_task)?;
        if let Some(kind) = kind {
            store.set_kind(&id, kind)?;
        }
        if change_home.unwrap_or(false) {
            store.set_home(&id, home)?;
        }
        Ok(())
    })?;
    crate::acp::warm::refresh_now();
    Ok(helpers::view())
}

/// Remove a standby (a running task on it is not stopped).
#[tauri::command]
pub fn standby_helper_remove(id: String) -> Result<HelpersView, String> {
    helpers::file().edit(|store| if store.remove(&id) { Ok(()) } else { Err("That standby is gone.".to_string()) })?;
    // Its waiting session is closed now, not at the next pass of the pool's loop.
    if let Some(pool) = crate::acp::warm::pool() {
        pool.drop_helper(&id, crate::event_log::now_ms());
    }
    Ok(helpers::view())
}

/// "Remove from the agent": the standby stops belonging to an agent and keeps running as a free warm agent (nothing is closed).
#[tauri::command]
pub fn standby_helper_detach(id: String) -> Result<HelpersView, String> {
    helpers::file().edit(|store| store.detach(&id))?;
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

/// "Never close": the idle time shuts no standby or warm agent down.
#[tauri::command]
pub fn standby_helpers_set_never_close(on: bool) -> Result<HelpersView, String> {
    helpers::file().edit(|store| {
        store.settings.never_close = on;
        Ok(())
    })?;
    crate::acp::warm::refresh_now();
    Ok(helpers::view())
}

/// "At most N standbys", "close a standby nobody used for N minutes" and "A new standby is a: Spin-off / Minion".
#[tauri::command]
pub fn standby_helpers_set_limits(max: usize, idle_minutes: u64, default_kind: Option<crate::agent_run_mode::StartedAs>) -> Result<HelpersView, String> {
    helpers::file().edit(|store| {
        store.set_settings(max, idle_minutes)?;
        if let Some(kind) = default_kind {
            store.settings.default_kind = kind;
        }
        Ok(())
    })?;
    Ok(helpers::view())
}

/// Open a standby as a chat and get its pane id. A ready standby opens without being taken from the pool; one an agent has gives
/// the agent's task chat. One that is not ready says why in a plain sentence.
#[tauri::command]
pub async fn standby_helper_open(app: tauri::AppHandle, state: tauri::State<'_, super::AppState>, id: String) -> Result<String, String> {
    let deps = super::acp_chat::live_deps(&app, &state.registry);
    let opened = tauri::async_runtime::spawn_blocking(move || crate::acp::chat::open_standby_chat(&deps, &id)).await.map_err(|e| format!("INTERNAL: {e}"))?;
    // An asleep standby was woken: it starts now, not at the next pass of the pool's loop.
    if let Some(pool) = crate::acp::warm::pool() {
        pool.tick(crate::event_log::now_ms());
    }
    opened
}

/// Take a standby back from an agent: the agent's task turn is stopped (the agent gets the normal cancelled result) and the
/// standby goes back to waiting. Nothing to take back: the list is returned as it is.
#[tauri::command]
pub async fn standby_helper_take_back(id: String) -> Result<HelpersView, String> {
    if let Some(pool) = crate::acp::warm::pool() {
        if let Some(pane) = pool.take_back_helper(&id) {
            tauri::async_runtime::spawn_blocking(move || pool.cancel_helper_turn(&pane)).await.map_err(|e| format!("INTERNAL: {e}"))?;
        }
    }
    Ok(helpers::view())
}
