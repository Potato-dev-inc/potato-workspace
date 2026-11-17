//! Tauri commands for workflows (Labs "Workflows"; Rust `crews::workflow`): the New agent page lists the workflows
//! (every saved crew; a crew with no marked Front uses its lead), asks for the plan of one in a folder (the brief the Front gets first), and, in whole-horde
//! mode, starts the helpers right after the Front. Errors read `CODE: message` like the other crew commands.

use super::AppState;
use crate::crews::workflow::{self, Plan, ReplyStyle};
use crate::crews::{agents, live, model::Crew, start, store, validate, CrewError};
use serde::Serialize;
use tauri::{AppHandle, State};

fn text(error: CrewError) -> String {
    error.to_string()
}

fn internal(error: impl std::fmt::Display) -> String {
    format!("INTERNAL: {error}")
}

fn setting(app: &AppHandle, key: &str) -> serde_json::Value {
    crate::settings_store::read_public_settings(app).get(key).cloned().unwrap_or(serde_json::Value::Null)
}

fn on(app: &AppHandle) -> bool {
    setting(app, "workflows_enabled") == serde_json::Value::Bool(true)
}

fn style(app: &AppHandle) -> ReplyStyle {
    ReplyStyle::parse(setting(app, "workflow_reply_style").as_str().unwrap_or(""))
}

#[derive(Serialize)]
pub struct WorkflowSummary {
    pub slug: String,
    pub plan: Plan,
}

/// Any saved crew read as a workflow, its `{default}` agents filled in. A crew with no marked Front uses its lead as the
/// Front (derived here, never saved).
fn load_workflow(slug: &str) -> Result<Crew, CrewError> {
    let stored = workflow::with_default_front(&store::load(&store::dir(), slug)?);
    if !workflow::is_workflow(&stored) {
        return Err(CrewError::new("WORKFLOW_NOT_FOUND", "There is no such workflow."));
    }
    agents::resolve_defaults(&stored, live::choices().default.as_deref())
}

/// How many saved crews the picker leaves out because they have a problem (so it can say so instead of "no workflows").
#[tauri::command]
pub async fn workflows_hidden_count(app: AppHandle) -> Result<u32, String> {
    if !on(&app) {
        return Ok(0);
    }
    tauri::async_runtime::spawn_blocking(|| store::list(&store::dir(), &live::agent_state).iter().filter(|s| s.problem.is_some()).count() as u32)
        .await
        .map_err(internal)
}

/// The first problem that stops a start. A crew saved with a Front is checked with the workflow rules; an older crew
/// (its Front derived from its lead) is checked as the plain crew it is, so it needs no "when to use" lines.
fn validate_for_start(slug: &str, resolved: &Crew) -> Option<CrewError> {
    let saved_front = store::load(&store::dir(), slug).map(|c| c.roles.iter().any(|r| r.front)).unwrap_or(true);
    let mut checked = resolved.clone();
    if !saved_front {
        for role in &mut checked.roles {
            role.front = false;
        }
    }
    validate::validate(&validate::normalized(&checked), &live::agent_state).into_iter().next()
}

/// The saved workflows; `None` while Labs "Workflows" is off. The brief is left empty here (it needs a folder).
#[tauri::command]
pub async fn workflows_list(app: AppHandle) -> Result<Option<Vec<WorkflowSummary>>, String> {
    if !on(&app) {
        return Ok(None);
    }
    let reply = style(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = store::dir();
        Some(
            store::list(&dir, &live::agent_state)
                .into_iter()
                .filter(|s| s.problem.is_none())
                .filter_map(|s| {
                    let crew = load_workflow(&s.slug).ok()?;
                    let mut plan = workflow::plan(&crew, "{folder}", reply, "")?;
                    plan.brief.clear();
                    plan.first_message.clear();
                    Some(WorkflowSummary { slug: s.slug, plan })
                })
                .collect(),
        )
    })
    .await
    .map_err(internal)
}

/// The plan of one workflow in `folder`: who the Front is, its helpers, and the Front's first message (the brief).
/// Refused when the switch is off or the crew has a problem.
#[tauri::command]
pub async fn workflows_plan(app: AppHandle, slug: String, folder: String, request: String) -> Result<Plan, String> {
    if let Some(refused) = workflow::refuse_off(on(&app)) {
        return Err(text(refused));
    }
    let reply = style(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let crew = load_workflow(&slug).map_err(text)?;
        if let Some(first) = validate_for_start(&slug, &crew) {
            return Err(text(first));
        }
        live::check_folder(&folder).map_err(text)?;
        workflow::plan(&crew, &folder, reply, &request).ok_or_else(|| text(CrewError::new("WORKFLOW_NOT_FOUND", "There is no such workflow.")))
    })
    .await
    .map_err(internal)?
}

/// What whole-horde mode did: who started, and the note to give the Front (the pane id of each helper).
#[derive(Serialize)]
pub struct HordeOutcome {
    #[serde(flatten)]
    pub outcome: start::Outcome,
    pub note: String,
}

/// Whole-horde mode: start every helper now, under the Front's pane. Nothing is answered for them. Refused when the
/// switch is off, the crew has a problem, the workflow is not in horde mode, the Front's pane is not open, or the
/// workflow is already starting.
#[tauri::command]
pub async fn workflows_start_helpers(app: AppHandle, state: State<'_, AppState>, slug: String, folder: String, front_pane: String) -> Result<HordeOutcome, String> {
    if let Some(refused) = workflow::refuse_off(on(&app)) {
        return Err(text(refused));
    }
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _starting = start::StartGuard::claim(&slug).map_err(text)?;
        let crew = load_workflow(&slug).map_err(text)?;
        let live_pane = registry.lock().list().iter().any(|info| info.id == front_pane);
        if let Some(refused) = workflow::refuse_horde_start(&crew, live_pane) {
            return Err(text(refused));
        }
        if let Some(first) = validate_for_start(&slug, &crew) {
            return Err(text(first));
        }
        live::check_folder(&folder).map_err(text)?;
        let mut starter = live::LiveStarter::new(registry, app);
        let mut out = start::Outcome { started: Vec::new(), failed: None, not_started: Vec::new() };
        let helpers = workflow::helpers_of(&crew);
        for (n, helper) in helpers.iter().enumerate() {
            let step = start::Step {
                role: (*helper).clone(),
                task: workflow::horde_task(&crew, helper, &folder),
                folder: folder.clone(),
                parent_pane: Some(front_pane.clone()),
                workflow: true,
            };
            match start::Starter::start(&mut starter, &step) {
                Ok(pane_id) => out.started.push(start::Started { role: helper.name.clone(), agent_type: helper.agent_type.clone(), pane_id }),
                Err(f) => {
                    out.failed = Some(start::Failed { role: helper.name.clone(), code: f.code, message: f.message });
                    out.not_started = helpers[n + 1..].iter().map(|h| h.name.clone()).collect();
                    break;
                }
            }
        }
        let note = workflow::horde_note(&out.started.iter().map(|s| (s.role.clone(), s.pane_id.clone())).collect::<Vec<_>>());
        Ok(HordeOutcome { outcome: out, note })
    })
    .await
    .map_err(internal)?
}
