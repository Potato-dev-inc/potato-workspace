//! What the read-only crew routes and the CLI show (1.1.6): the list, one crew with its problems, and a
//! check of a file's text. Nothing here changes anything: applying a crew is for the canvas (1.1.7).
//! Every function takes the folder and the registry's answers, so tests use fakes.

use super::model::{Crew, CrewError};
use super::validate::{normalized, validate_with, AgentState};
use super::{config_format, model, store, templates};
use serde_json::{json, Value};
use std::path::Path;

/// `{crews: [saved crews], templates: [read-only templates]}`, as summaries.
pub fn list(dir: &Path, agent_state: &dyn Fn(&str) -> AgentState) -> Value {
    json!({
        "crews": store::list(dir, agent_state),
        "templates": templates::summaries(agent_state),
    })
}

/// One crew by slug (`template:<id>` for a template) with its problems; `routing_text` is the routing
/// file of a template. A broken file is an error (`CREW_FILE_INVALID`), not a crew with problems.
pub fn show(dir: &Path, id: &str, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) -> Result<Value, CrewError> {
    let (kind, crew) = match templates::lookup(id) {
        Some(crew) => ("template", crew),
        None => ("saved", store::load(dir, id)?),
    };
    let problems = problems_of(&crew, agent_state, model_ok);
    Ok(json!({
        "id": id,
        "kind": kind,
        "crew": crew,
        "problems": problems,
        "routing_text": templates::routing_text(id),
    }))
}

fn problems_of(crew: &Crew, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) -> Vec<CrewError> {
    validate_with(&normalized(crew), agent_state, model_ok)
}

/// Check the text of a crew file or of a CLI config file (`[crew.<id>]` sections). `ok` is true only when
/// the text reads and every crew in it passes. An unreadable text is reported in `problems`.
pub fn validate_text(text: &str, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) -> Value {
    let (kind, parsed) = if config_format::is_config(text) {
        ("config", config_format::parse(text))
    } else {
        ("crew", model::parse(text).map(|crew| vec![("crew".to_string(), crew)]))
    };
    match parsed {
        Err(error) => json!({ "ok": false, "kind": kind, "crews": [], "problems": [error] }),
        Ok(crews) => {
            let rows: Vec<Value> = crews
                .iter()
                .map(|(id, crew)| {
                    let problems = problems_of(crew, agent_state, model_ok);
                    json!({ "id": id, "name": crew.name.trim(), "roles": crew.roles.len(), "problems": problems })
                })
                .collect();
            let ok = !rows.is_empty() && rows.iter().all(|r| r["problems"].as_array().is_some_and(Vec::is_empty));
            let empty = if rows.is_empty() { vec![CrewError::new("CREW_NONE", "This file has no crew in it.")] } else { Vec::new() };
            json!({ "ok": ok, "kind": kind, "crews": rows, "problems": empty })
        }
    }
}
