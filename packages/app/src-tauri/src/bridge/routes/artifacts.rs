//! Artifacts on the bridge.
//!
//! - `POST /artifacts/show` is the `show_artifact` tool: an agent makes or updates a page and a card appears in its
//!   chat. Local callers only (never a phone). The chat is the agent's own pane: the `pane_id` it passes, else the pane
//!   its MCP connection says it runs in, else the pane the connection's process verifiably lives in.
//! - `GET /panes/{pane}/artifacts` lists the pages of that chat's project; `GET /panes/{pane}/artifacts/{id}?v=N` reads
//!   one version. Both are under `/panes/{id}`, so a paired phone passes the pairing token, the `watch` right and that
//!   agent's own remote rule (`mobile_pairing::pane_rules`) before they run: an agent that is locked for phones shows a
//!   phone nothing. A phone is never told a folder or file path, and gets a page only up to `MAX_PHONE_BYTES`.

use serde_json::{json, Value};

use super::{Ctx, RouteResult};
use crate::artifacts::{self, ArtifactError};
use crate::bridge::http::query_param;
use crate::mobile_pairing::Caller;

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("POST", ["artifacts", "show"]) => Some(show(cx)),
        ("GET", ["panes", pane, "artifacts"]) if !super::panes::is_reserved_pane_id(pane) => Some(list(cx, pane)),
        ("GET", ["panes", pane, "artifacts", id]) if !super::panes::is_reserved_pane_id(pane) => Some(read(cx, pane, id)),
        _ => None,
    }
}

fn refuse(status: u16, code: &str, message: &str) -> (u16, Value) {
    (status, json!({ "code": code, "error": message, "message": message, "recoverable": false, "context": {} }))
}

fn failed(error: ArtifactError) -> (u16, Value) {
    let status = match error {
        ArtifactError::NotFound => 404,
        ArtifactError::Io(_) => 500,
        _ => 400,
    };
    refuse(status, error.code(), &error.message())
}

/// The project folder of a pane (the folder its agent works in).
fn project_of(cx: &Ctx, pane: &str) -> Option<std::path::PathBuf> {
    let registry = cx.registry.lock();
    registry.get(pane).map(|p| std::path::PathBuf::from(p.info.cwd.clone())).filter(|p| !p.as_os_str().is_empty())
}

fn show(cx: &Ctx) -> RouteResult {
    if !matches!(crate::mobile_pairing::authorize_caller(cx.headers, cx.peer_loopback, cx.segments, cx.method), Ok(Caller::Local)) {
        return Err(refuse(403, "ARTIFACT_LOCAL_ONLY", "show_artifact is for an agent on this computer. A phone cannot use it."));
    }
    let body = &cx.request_body;
    let named = body.get("pane_id").and_then(Value::as_str).and_then(crate::pty::pane_parent::clean_hint);
    let claimed = cx.session.and_then(crate::mcp_sessions::claimed_session_pane);
    let verified = || crate::companion::peer::caller_pane(cx.registry, &crate::companion::peer::SystemTcp, &crate::pty::agent_proc::snapshot, cx.peer);
    let pane = [named, claimed].into_iter().flatten().find(|p| crate::acp::chat::get(p).is_some()).or_else(|| verified().filter(|p| crate::acp::chat::get(p).is_some()));
    let project = match &pane {
        Some(pane) => project_of(cx, pane),
        None => body.get("project_path").and_then(Value::as_str).map(std::path::PathBuf::from).filter(|p| p.is_dir()),
    };
    let Some(project) = project else {
        return Err(refuse(400, "ARTIFACT_NO_PROJECT", "Say which chat to show the page in: pass pane_id (your own pane), or project_path to only save it."));
    };
    let shown = artifacts::show(&project, body).map_err(failed)?;
    let in_chat = match (&pane, shown.added) {
        (Some(pane), true) => artifacts::announce(pane, &shown.artifact, shown.version),
        (Some(_), false) => true,
        (None, _) => false,
    };
    Ok((200, artifacts::reply(&shown, in_chat)))
}

fn list(cx: &Ctx, pane: &str) -> RouteResult {
    let project = project_of(cx, pane).ok_or_else(|| refuse(404, "UNKNOWN_PANE", "There is no such agent."))?;
    let items: Vec<Value> = artifacts::list(&project).iter().map(artifacts::phone_view).collect();
    Ok((200, json!({ "artifacts": items })))
}

fn read(cx: &Ctx, pane: &str, id: &str) -> RouteResult {
    let project = project_of(cx, pane).ok_or_else(|| refuse(404, "UNKNOWN_PANE", "There is no such agent."))?;
    let version = query_param(cx.query, "v").and_then(|v| v.parse::<u32>().ok());
    let page = artifacts::read(&project, id, version).map_err(failed)?;
    let mut view = artifacts::phone_view(&page.artifact);
    view["version"] = json!(page.version);
    if page.content.len() > artifacts::MAX_PHONE_BYTES {
        view["tooLarge"] = json!(true);
    } else {
        view["content"] = json!(page.content);
    }
    Ok((200, view))
}
