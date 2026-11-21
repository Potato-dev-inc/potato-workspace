//! Tauri commands for crews (`crate::crews`): list, draft from a live pane, save, remove, start.
//! Errors that are not a crew problem read `CODE: message` like the worktree commands.

use super::AppState;
use crate::crews::{agents, live, model::Crew, start, starters, store, CrewError};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct SaveOutcome {
    pub slug: Option<String>,
    pub errors: Vec<CrewError>,
}

fn text(error: CrewError) -> String {
    error.to_string()
}

fn internal(error: impl std::fmt::Display) -> String {
    format!("INTERNAL: {error}")
}

#[tauri::command]
pub async fn crews_list() -> Result<Vec<store::Summary>, String> {
    tauri::async_runtime::spawn_blocking(list_now).await.map_err(internal)
}

/// The built-in starter crews (never written to app data; copy one to My crews to keep it).
#[tauri::command]
pub async fn crews_starters() -> Result<Vec<store::Summary>, String> {
    tauri::async_runtime::spawn_blocking(starters_now).await.map_err(internal)
}

/// A saved crew or a starter, by slug.
#[tauri::command]
pub async fn crews_get(slug: String) -> Result<Crew, String> {
    tauri::async_runtime::spawn_blocking(move || get_now(&slug)).await.map_err(internal)?
}

/// The agents a role can run, and the one `{default}` stands for (null when none is set up).
#[tauri::command]
pub async fn crews_agents() -> Result<agents::Choices, String> {
    tauri::async_runtime::spawn_blocking(agents_now).await.map_err(internal)
}

/// The draft of "Save this team" for a pane and the helpers under it. Nothing is saved yet.
#[tauri::command]
pub async fn crews_draft(state: State<'_, AppState>, pane_id: String) -> Result<crate::crews::draft::Draft, String> {
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || draft_now(&registry, &pane_id)).await.map_err(internal)?
}

/// Save a crew. Problems come back in `errors` (nothing is written then), each naming its role. A crew
/// with the same name is refused (`CREW_NAME_TAKEN`) unless `replace` is true.
#[tauri::command]
pub async fn crews_save(crew: Crew, replace: Option<bool>) -> Result<SaveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || save_now(&crew, replace.unwrap_or(false))).await.map_err(internal)
}

#[tauri::command]
pub async fn crews_remove(slug: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_now(&slug)).await.map_err(internal)?
}

/// Start a crew in `folder`, one role at a time. `agents` maps role names to the agent the Start sheet chose
/// for them (roles not named keep theirs); `{default}` roles take the default agent. Returns who started,
/// and which role failed (if one did). A second start of the same crew while one runs is refused
/// (`CREW_STARTING`), so a double click does not start two sets of panes.
#[tauri::command]
pub async fn crews_start(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    folder: String,
    agents: Option<BTreeMap<String, String>>,
) -> Result<start::Outcome, String> {
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || start_now(registry, app, &slug, &folder, agents.unwrap_or_default())).await.map_err(internal)?
}

// The bodies of the commands above, with no window or state: the Tauri command and a paired PC's far call (`pclink/calls_workflows.rs`)
// run these same functions, so what a crew does cannot differ by who asked.

pub(crate) fn list_now() -> Vec<store::Summary> {
    store::list(&store::dir(), &live::agent_state)
}

pub(crate) fn starters_now() -> Vec<store::Summary> {
    starters::summaries(&live::agent_state)
}

pub(crate) fn get_now(slug: &str) -> Result<Crew, String> {
    store::load_any(&store::dir(), slug).map_err(text)
}

pub(crate) fn agents_now() -> agents::Choices {
    live::choices()
}

pub(crate) fn draft_now(registry: &std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>, pane_id: &str) -> Result<crate::crews::draft::Draft, String> {
    live::draft_for_pane(registry, pane_id).map_err(text)
}

pub(crate) fn save_now(crew: &Crew, replace: bool) -> SaveOutcome {
    match store::save(&store::dir(), crew, replace, &live::agent_state) {
        Ok(slug) => SaveOutcome { slug: Some(slug), errors: Vec::new() },
        Err(errors) => SaveOutcome { slug: None, errors },
    }
}

pub(crate) fn remove_now(slug: &str) -> Result<(), String> {
    store::remove(&store::dir(), slug).map_err(text)
}

pub(crate) fn start_now(
    registry: std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    app: AppHandle,
    slug: &str,
    folder: &str,
    agents: BTreeMap<String, String>,
) -> Result<start::Outcome, String> {
    let _starting = start::StartGuard::claim(slug).map_err(text)?;
    let stored = store::load_any(&store::dir(), slug).map_err(text)?;
    let chosen = agents::with_agents(&stored, &agents);
    let crew = agents::resolve_defaults(&chosen, live::choices().default.as_deref()).map_err(text)?;
    let problems = crate::crews::validate::validate(&crew, &live::agent_state);
    if let Some(first) = problems.into_iter().next() {
        return Err(text(first));
    }
    live::check_folder(folder).map_err(text)?;
    crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), folder);
    Ok(start::run(&crew, folder, &mut live::LiveStarter::new(registry, app)))
}
