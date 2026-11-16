//! Tauri commands for the crew canvas (Labs "Crews"): open a crew or a template with its routing rules, check
//! one, save it with its rules, try a task on it (a dry run), and apply it (keep its helpers ready).
//! Errors that are not a crew problem read `CODE: message` like the other crew commands.

use crate::crews::{apply, live, model::Crew, routing, store, templates, validate, CrewError};
use serde::Serialize;

fn internal(error: impl std::fmt::Display) -> String {
    format!("INTERNAL: {error}")
}

/// A crew as the canvas opens it. `kind`: `saved` or `template` (a template is read-only until copied).
#[derive(Serialize)]
pub struct Opened {
    pub slug: String,
    pub kind: &'static str,
    pub crew: Crew,
    /// The rules for routing work, in plain words.
    pub routing_text: String,
    pub problems: Vec<CrewError>,
}

/// The ready-made crews (read-only).
#[tauri::command]
pub async fn crews_templates() -> Result<Vec<store::Summary>, String> {
    tauri::async_runtime::spawn_blocking(|| templates::summaries(&live::agent_state)).await.map_err(internal)
}

/// Open a saved crew or a template by slug, with its rules and its problems.
#[tauri::command]
pub async fn crews_open(slug: String) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = store::dir();
        let (kind, crew, routing_text) = match templates::lookup(&slug) {
            Some(crew) => ("template", crew, templates::routing_text(&slug).unwrap_or_default().to_string()),
            None => ("saved", store::load(&dir, &slug)?, store::load_routing(&dir, &slug).unwrap_or_default()),
        };
        let problems = validate::validate_with(&validate::normalized(&crew), &live::agent_state, &live::model_ok);
        Ok(Opened { slug, kind, crew, routing_text, problems })
    })
    .await
    .map_err(internal)?
    .map_err(|e: CrewError| e.to_string())
}

/// Every problem of a crew as it is on the canvas now (the model and the hand-offs included). Nothing is saved.
#[tauri::command]
pub async fn crews_check(crew: Crew) -> Result<Vec<CrewError>, String> {
    tauri::async_runtime::spawn_blocking(move || validate::validate_with(&validate::normalized(&crew), &live::agent_state, &live::model_ok))
        .await
        .map_err(internal)
}

#[derive(Serialize)]
pub struct CanvasSave {
    pub slug: Option<String>,
    pub errors: Vec<CrewError>,
}

/// Save a crew and its routing rules. Nothing is written when the crew has a problem.
#[tauri::command]
pub async fn crews_save_canvas(crew: Crew, routing_text: String, replace: Option<bool>) -> Result<CanvasSave, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = store::dir();
        let problems = validate::validate_with(&validate::normalized(&crew), &live::agent_state, &live::model_ok);
        if !problems.is_empty() {
            return CanvasSave { slug: None, errors: problems };
        }
        match store::save(&dir, &crew, replace.unwrap_or(false), &live::agent_state) {
            Ok(slug) => match store::save_routing(&dir, &slug, &routing_text) {
                Ok(()) => CanvasSave { slug: Some(slug), errors: Vec::new() },
                Err(e) => CanvasSave { slug: Some(slug), errors: vec![e] },
            },
            Err(errors) => CanvasSave { slug: None, errors },
        }
    })
    .await
    .map_err(internal)
}

/// Try a task: where would it go? A dry run; nothing runs. `None` when the rules name no role of the crew.
#[tauri::command]
pub async fn crews_try_task(crew: Crew, routing_text: String, task: String) -> Result<Option<routing::Preview>, String> {
    tauri::async_runtime::spawn_blocking(move || routing::preview(&validate::normalized(&crew), &routing_text, &task)).await.map_err(internal)
}

#[derive(Serialize)]
pub struct Applied {
    /// Names of the helpers kept ready now.
    pub added: Vec<String>,
    pub already: usize,
    pub skipped: Vec<apply::Skipped>,
    /// Set when the helper limit is too low: applying needs this many. Nothing was added; ask the person.
    pub needs_limit: Option<usize>,
    pub problems: Vec<CrewError>,
}

/// Apply a crew in a folder: keep its standby helpers ready. `raise_limit` lifts the standby limit to what the
/// crew needs (the person agreed). A problem in the crew or the folder stops it before anything is added.
#[tauri::command]
pub async fn crews_apply(crew: Crew, folder: String, raise_limit: Option<bool>) -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let none = |problems: Vec<CrewError>| Applied { added: Vec::new(), already: 0, skipped: Vec::new(), needs_limit: None, problems };
        let crew = validate::normalized(&crew);
        let problems = validate::validate_with(&crew, &live::agent_state, &live::model_ok);
        if !problems.is_empty() {
            return none(problems);
        }
        if let Err(e) = live::check_folder(&folder) {
            return none(vec![e]);
        }
        let file = crate::standby::helpers::file();
        let can_wait = |agent: &str| crate::acp::config::find_builtin(agent).is_some();
        let plan = apply::plan(&crew, &folder, &file.snapshot().helpers, &can_wait);
        let store = file.snapshot();
        let need = store.helpers.len() + plan.to_add.len();
        let mut needs_limit = None;
        if need > store.settings.max {
            if raise_limit.unwrap_or(false) && need <= crate::standby::helpers::MAX_HELPERS {
                let _ = file.edit(|s| s.set_settings(need, s.settings.idle_minutes));
            } else {
                needs_limit = Some(need);
            }
        }
        let mut added = Vec::new();
        if needs_limit.is_none() {
            for input in plan.to_add {
                let name = input.name.clone();
                let id = format!("sb-{}", uuid::Uuid::new_v4().simple());
                if file.edit(|s| s.add(input, id).map(|_| ())).is_ok() {
                    added.push(name);
                }
            }
            if !added.is_empty() {
                crate::acp::warm::refresh_now();
            }
        }
        Applied { added, already: plan.already, skipped: plan.skipped, needs_limit, problems: Vec::new() }
    })
    .await
    .map_err(internal)
}
