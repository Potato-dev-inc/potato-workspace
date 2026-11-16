//! `/crews`: read-only views of saved crews (1.1.6). Nothing here creates, changes or starts a crew;
//! applying one comes with the canvas in 1.1.7.
//!
//! * `GET  /crews`           `{crews: [...], templates: [...]}` as summaries (a template is read-only).
//! * `GET  /crews/{id}`      one crew (a saved slug, or `template:<id>`) with its problems.
//! * `POST /crews/validate`  `{text}`: the text of a crew file or of a CLI config file; reports problems. Saves nothing.
//!
//! Who may call: this computer only, like `/config` (a paired phone or a forwarded request is refused).

use super::{Ctx, RouteResult};
use crate::crews::{live, model::CrewError, store, view};
use crate::crews::validate::AgentState;
use crate::mobile_pairing::Caller;
use serde_json::{json, Value};
use std::path::Path;

fn refuse(status: u16, code: &str, message: &str) -> RouteResult {
    Err((status, json!({ "code": code, "error": message, "message": message, "recoverable": false, "context": {} })))
}

fn from_crew_error(error: CrewError) -> RouteResult {
    let status = if error.code == "CREW_NOT_FOUND" { 404 } else { 400 };
    refuse(status, error.code, &error.message)
}

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    handle_request(cx.method, cx.segments, &cx.request_body, cx.headers, cx.peer_loopback, &store::dir(), &live::agent_state, &live::model_ok)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_request(
    method: &str,
    raw_segments: &[&str],
    body: &Value,
    headers: &str,
    peer_loopback: bool,
    dir: &Path,
    agent_state: &dyn Fn(&str) -> AgentState,
    model_ok: &dyn Fn(&str, &str) -> bool,
) -> Option<RouteResult> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(raw_segments);
    if segments.first() != Some(&"crews") {
        return None;
    }
    match crate::mobile_pairing::authorize_caller(headers, peer_loopback, raw_segments, method) {
        Ok(Caller::Local) => {}
        Ok(_) | Err(_) => return Some(refuse(403, "CREWS_LOCAL_ONLY", "Crews can only be read from this computer.")),
    }
    Some(match (method, segments) {
        ("GET", ["crews"]) => Ok((200, view::list(dir, agent_state))),
        ("POST", ["crews", "validate"]) => match body.get("text").and_then(Value::as_str) {
            Some(text) => Ok((200, view::validate_text(text, agent_state, model_ok))),
            None => refuse(400, "INVALID_ARGUMENT", "validate needs the file text in \"text\"."),
        },
        ("GET", ["crews", id]) => match view::show(dir, id, agent_state, model_ok) {
            Ok(value) => Ok((200, value)),
            Err(error) => from_crew_error(error),
        },
        _ => refuse(404, "NOT_FOUND", "Unknown crews route. Crews are read-only for now."),
    })
}

#[cfg(test)]
#[path = "crews_tests.rs"]
mod tests;
