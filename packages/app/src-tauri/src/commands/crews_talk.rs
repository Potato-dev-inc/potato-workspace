//! Tauri command for "Change the crew by talking" (1.1.8): the person's sentence goes to the crew's front desk (its lead
//! agent, one read-only question through `quick_ask`), and what comes back is checked by `crews::talk` (routing only) and
//! returned as a proposal. This command changes nothing: the canvas applies a proposal only when the person presses Apply.

use super::AppState;
use crate::crews::{live, model::Crew, model::CrewError, talk};
use serde::Serialize;
use tauri::{AppHandle, State};

/// The front desk waits this long for an answer.
const WAIT_MS: u64 = 110_000;

#[derive(Serialize)]
pub struct TalkOutcome {
    /// `proposal`, `nothing` (no change needed) or `refused` (not routing, or it would break the crew).
    pub status: &'static str,
    /// The front desk's one sentence (proposal, nothing) or the plain reason (refused).
    pub message: String,
    pub code: Option<String>,
    pub crew: Option<Crew>,
    pub routing_text: Option<String>,
    pub changes: Vec<talk::Change>,
    /// The agent that played the front desk.
    pub asked: Option<String>,
}

fn internal(error: impl std::fmt::Display) -> String {
    format!("INTERNAL: {error}")
}

/// The lead's agent when it can answer read-only here; otherwise the app picks the first one that can.
fn front_desk(crew: &Crew) -> (Option<String>, Option<String>) {
    let Some(lead) = crew.roles.iter().find(|r| r.parent.is_none()) else { return (None, None) };
    let usable = crate::tui::read_only_backends().iter().any(|id| id.eq_ignore_ascii_case(&lead.agent_type)) && crate::tui::profile_for(&lead.agent_type).is_installed();
    if usable {
        (Some(lead.agent_type.clone()), lead.model.clone())
    } else {
        (None, None)
    }
}

fn answer_of(value: serde_json::Value) -> Result<String, CrewError> {
    match value.get("status").and_then(serde_json::Value::as_str) {
        Some("running") => return Err(CrewError::new("CREW_TALK_AGENT", "The front desk is taking too long to answer. Try again.")),
        Some("needs_input") => return Err(CrewError::new("CREW_TALK_AGENT", "The front desk stopped to ask for permission instead of answering. Try another agent as lead.")),
        _ => {}
    }
    let answer = value.get("answer").and_then(serde_json::Value::as_str).unwrap_or("").trim().to_string();
    if answer.is_empty() { Err(CrewError::new("CREW_TALK_AGENT", "The front desk gave an empty answer. Try again.")) } else { Ok(answer) }
}

/// Ask the front desk to change how work is routed. A proposal only: nothing is saved or applied.
#[tauri::command]
pub async fn crews_talk(state: State<'_, AppState>, app: AppHandle, crew: Crew, routing_text: String, request: String) -> Result<TalkOutcome, String> {
    let registry = state.registry.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let crew = crate::crews::validate::normalized(&crew);
        let (backend, model) = front_desk(&crew);
        let folder = std::env::temp_dir().join("potato-workspace-crew-talk");
        let _ = std::fs::create_dir_all(&folder);
        let ask = |prompt: &str| -> Result<String, CrewError> {
            let req = crate::agent_runs::quick::QuickAskRequest {
                task: prompt.to_string(),
                project_path: Some(folder.to_string_lossy().into_owned()),
                backend: backend.clone(),
                model: model.clone(),
                wait_ms: Some(WAIT_MS),
                read_only: Some(true),
                idempotency_key: None,
            };
            match crate::agent_runs::quick::quick_ask(req, registry.clone(), app.clone(), None) {
                Ok(value) => answer_of(value),
                Err(e) => Err(CrewError::new("CREW_TALK_AGENT", format!("The front desk could not answer: {}", e.message))),
            }
        };
        let out = talk::propose(&crew, &routing_text, &request, &ask, &live::agent_state, &live::model_ok);
        match out {
            Ok(talk::Outcome::Proposal(p)) => TalkOutcome { status: "proposal", message: p.explain, code: None, crew: Some(p.crew), routing_text: Some(p.routing_text), changes: p.changes, asked: backend },
            Ok(talk::Outcome::Nothing { explain }) => TalkOutcome { status: "nothing", message: explain, code: None, crew: None, routing_text: None, changes: Vec::new(), asked: backend },
            Err(e) => TalkOutcome { status: "refused", message: e.message, code: Some(e.code.to_string()), crew: None, routing_text: None, changes: Vec::new(), asked: backend },
        }
    })
    .await
    .map_err(internal)
}
