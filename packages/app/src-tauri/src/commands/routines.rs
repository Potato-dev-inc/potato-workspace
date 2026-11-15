//! Tauri commands of Routines and Chains (`crate::routines`). Desktop only: nothing here is an MCP tool, a
//! bridge route or a phone path, so only the person makes, changes and runs them.
//!
//! Errors are one plain sentence for the form.

use serde::Serialize;

use crate::routines::live;
use crate::routines::model::NewWorkflow;
use crate::routines::view::RoutinesView;

/// One agent the form can pick.
#[derive(Debug, Clone, Serialize)]
pub struct RoutineAgent {
    pub id: String,
    pub label: String,
}

fn internal(error: impl std::fmt::Display) -> String {
    format!("Something went wrong: {error}")
}

/// Everything the Routines page shows.
#[tauri::command]
pub async fn routines_view() -> Result<RoutinesView, String> {
    tauri::async_runtime::spawn_blocking(live::view).await.map_err(internal)
}

/// The agents that can be started by a routine, installed ones, in the usual order.
#[tauri::command]
pub async fn routines_agents() -> Result<Vec<RoutineAgent>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::crews::live::startable_agents().into_iter().map(|a| RoutineAgent { id: a.id, label: a.label }).collect()
    })
    .await
    .map_err(internal)
}

/// Makes a routine or a chain. Returns its id.
#[tauri::command]
pub async fn routines_create(workflow: NewWorkflow) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || live::create(workflow)).await.map_err(internal)?
}

#[tauri::command]
pub async fn routines_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || live::set_enabled(&id, enabled)).await.map_err(internal)?
}

#[tauri::command]
pub async fn routines_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || live::delete(&id)).await.map_err(internal)?
}

#[tauri::command]
pub async fn routines_run_now(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || live::run_now(&id)).await.map_err(internal)?
}

#[tauri::command]
pub async fn routines_stop_run(run_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || live::stop_run(&run_id)).await.map_err(internal)?
}

/// "At most N at once". `null` turns it off.
#[tauri::command]
pub async fn routines_set_limit(limit: Option<u32>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || live::set_limit(limit)).await.map_err(internal)?
}
