//! The phone's side of four chat features. All of them are under `/panes/{id}/...`, so the agent's own remote rule
//! (`pane_rules`) is checked before any of this runs, and none of them is an MCP tool (an agent session cannot reach them).
//!
//! - `GET /panes/{id}/chat/earlier?before=<item id>&limit=<n>`: "Show earlier". The items right before the oldest one the
//!   phone holds, read from the chat's journal. `limit=0` only asks whether there is more. Needs `watch`.
//! - `GET /panes/{id}/picture?path=<path>`: a picture the agent named, as a `data:` URL. Only a file inside the chat's
//!   project folder (or the phone-uploads folder), small enough for a phone, a real png/jpg/gif/webp or a plain svg
//!   (`session_chat::picture`). Needs `watch`.
//! - `GET /panes/{id}/draft` and `POST /panes/{id}/draft {text}`: "Your draft follows you", the half-written message kept
//!   by the PC in memory (`session_chat::draft`). Reading needs `watch`, writing is typing (`type`).

use serde_json::{json, Value};

use super::{Ctx, RouteResult};
use crate::bridge::http::query_param;
use crate::session_chat::{draft, earlier, picture};

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("GET", ["panes", pane_id, "chat", "earlier"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(page(cx, pane_id)),
        ("GET", ["panes", pane_id, "picture"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(show(cx, pane_id)),
        ("GET", ["panes", pane_id, "draft"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(read_draft(cx, pane_id)),
        ("POST", ["panes", pane_id, "draft"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(write_draft(cx, pane_id)),
        _ => None,
    }
}

fn unknown(pane_id: &str) -> (u16, Value) {
    (404, json!({ "code": "UNKNOWN_PANE", "error": crate::pty::registry::unknown_pane_message(pane_id) }))
}

fn pane_cwd(cx: &Ctx, pane_id: &str) -> Result<String, (u16, Value)> {
    cx.registry.lock().get(pane_id).map(|pane| pane.info.cwd.clone()).ok_or_else(|| unknown(pane_id))
}

fn bad(code: &str, message: &str) -> (u16, Value) {
    (400, json!({ "code": code, "error": message }))
}

fn page(cx: &Ctx, pane_id: &str) -> RouteResult {
    pane_cwd(cx, pane_id)?;
    let before = query_param(cx.query, "before").filter(|v| !v.is_empty()).ok_or_else(|| bad("INVALID_ARGUMENT", "before is required"))?;
    let limit = query_param(cx.query, "limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(earlier::DEFAULT_PAGE);
    Ok((200, earlier::for_pane(pane_id, &before, limit, true)))
}

fn show(cx: &Ctx, pane_id: &str) -> RouteResult {
    let cwd = pane_cwd(cx, pane_id)?;
    let path = query_param(cx.query, "path").filter(|v| !v.is_empty()).ok_or_else(|| bad("INVALID_ARGUMENT", "path is required"))?;
    match picture::read(&path, &cwd, &picture::roots_for(&cwd), picture::PHONE_MAX_BYTES) {
        Ok(found) => Ok((200, serde_json::to_value(found).unwrap_or(Value::Null))),
        Err(refused) => Err((if refused.code == "PICTURE_TOO_BIG" { 413 } else { 404 }, picture::refusal_body(&refused))),
    }
}

fn read_draft(cx: &Ctx, pane_id: &str) -> RouteResult {
    pane_cwd(cx, pane_id)?;
    Ok((200, draft::answer(draft::app_drafts().get(pane_id))))
}

fn write_draft(cx: &Ctx, pane_id: &str) -> RouteResult {
    pane_cwd(cx, pane_id)?;
    let text = cx.request_body.get("text").and_then(Value::as_str).ok_or_else(|| bad("INVALID_ARGUMENT", "text is required"))?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok((200, draft::answer(draft::app_drafts().set(pane_id, text, now))))
}

#[cfg(test)]
#[path = "chat_more_tests.rs"]
mod tests;
