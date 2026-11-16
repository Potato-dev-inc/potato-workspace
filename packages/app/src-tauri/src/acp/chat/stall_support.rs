//! What the "stuck helper" signal needs from a chat helper: its state, and the three buttons (nudge, stop, respawn).
//! The signal itself lives in `agent_runs::stall`; nothing here decides what counts as stuck.

use serde_json::json;

use super::{get, surface, Readiness, StartDeps};
use crate::acp::state::Phase;
use crate::session_chat::ChatItem;

/// What the run of a chat helper is doing right now.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ChatRun {
    /// A turn is working (not starting, not finished).
    pub running: bool,
    /// A question to the person is open.
    pub waiting: bool,
}

/// `None`: this pane is not a chat helper (or it is closed).
pub(crate) fn run_state(pane_id: &str) -> Option<ChatRun> {
    let chat = get(pane_id)?;
    if chat.is_closed() {
        return None;
    }
    let snapshot = chat.session().snapshot();
    Some(ChatRun { running: snapshot.phase == Phase::Working, waiting: snapshot.phase == Phase::NeedsInput })
}

/// Nudge: the one short line, as a steer into the turn that runs (the way `send_message` does).
pub(crate) fn nudge(pane_id: &str, text: &str) -> Result<(), String> {
    let chat = get(pane_id).ok_or_else(|| "NOT_FOUND: this chat is gone".to_string())?;
    match chat.steer(text) {
        Some(result) => result,
        None if chat.readiness() == Readiness::Ready => chat.send(text).map(|_| ()).map_err(|e| format!("{e:?}")),
        None => Err("This helper cannot take a message while it works.".to_string()),
    }
}

/// Stop: the existing cancel of the turn.
pub(crate) fn stop(pane_id: &str) -> Result<(), String> {
    let chat = get(pane_id).ok_or_else(|| "NOT_FOUND: this chat is gone".to_string())?;
    chat.cancel().map(|_| ()).map_err(|e| e.to_string())
}

/// The body of the `run_agent` call that repeats this helper: same agent, task, model and folder.
pub(crate) fn respawn_body(pane_id: &str, default_folder: &str) -> Option<serde_json::Value> {
    let chat = get(pane_id)?;
    let task = chat.items().into_iter().find_map(|item| match item {
        ChatItem::User { text, .. } if !text.trim().is_empty() => Some(text),
        _ => None,
    })?;
    let folder = chat.run_folder().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| default_folder.to_string());
    let (model, _, _) = chat.run_meta_snapshot();
    Some(json!({
        "agent_type": chat.agent_id(),
        "project_path": folder,
        "task": task,
        "model": model,
        "lane": "acp",
        "background": true,
        "keep_pane": true,
        "wait_ms": 1,
    }))
}

/// Respawn: starts a fresh chat helper for the same task and model (under the same caller), then closes the stuck one.
/// Returns the new handle.
pub(crate) fn respawn(pane_id: &str, default_folder: &str, deps: &StartDeps) -> Result<String, String> {
    let old = get(pane_id).ok_or_else(|| "NOT_FOUND: this chat is gone".to_string())?;
    let body = respawn_body(pane_id, default_folder).ok_or_else(|| "NOT_FOUND: the task of this helper was not found".to_string())?;
    let session = old.started_by();
    let bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let reply = surface::intercept("POST", &["agents", "run"], "", &bytes, deps, session.as_deref()).ok_or_else(|| "The fresh helper could not be started.".to_string())?;
    let view = reply.map_err(|e| format!("{}: {}", e.code, e.message))?;
    let handle = view.get("handle").and_then(|v| v.as_str()).ok_or_else(|| "The fresh helper has no handle.".to_string())?.to_string();
    // Same "Started by" line as the stuck one.
    if let Some(origin) = crate::pty::pane_origin::get(pane_id) {
        crate::pty::pane_origin::note_parts(&handle, origin.host, origin.task);
    }
    let _ = crate::pty::registry_kill_pane_and_wait(&deps.registry, pane_id, Some("replaced by a fresh helper"));
    deps.host.panes_changed();
    Ok(handle)
}
