//! Tauri commands of the chat session over ACP (A2): start one (agent, folder), stop its turn, read its state.
//! Answering a permission question needs no command of its own: it is a question card (`question_answer`).
//! The same start/stop/state are on the bridge (`bridge/routes/acp_chat.rs`) for the phone.
//!
//! Errors are `"CODE: sentence"` like every command. A code that starts with `ACP_` and a message that says the
//! terminal can run the agent instead mean: run it in the terminal (`StartError::fallback`).

use super::*;
use crate::acp::chat::{self, StartDeps, StartError, StartRequest};
use pm_core::device_link::pclink::engine_services as engine;
use serde_json::json;

/// What a start needs from the live app (the engine's own: `pm_core::device_link::pclink::engine_services`).
pub fn live_deps(_app: &AppHandle, registry: &Arc<Mutex<PaneRegistry>>) -> StartDeps {
    engine::live_deps(registry)
}

pub fn start_error_text(error: &StartError) -> String {
    let tail = if error.fallback { " The terminal can run this agent instead." } else { "" };
    format!("{}: {}{}", error.code, error.message, tail)
}

/// The folder a chat starts in: the one named, or (a start from the palette, the board, the inbox...: places that have no
/// folder of their own) the app's default project folder.
pub(crate) fn resolve_folder(named: &str, default_project: impl FnOnce() -> String) -> String {
    if named.trim().is_empty() {
        default_project()
    } else {
        named.to_string()
    }
}

/// Starts a chat session: `{pane_id, agent, lane: "acp"}`. Needs the Labs switch, and the agent's choice to be Chat
/// unless `explicit` is true. The adapter is started before the pane exists, so a failure leaves nothing behind.
#[tauri::command]
pub async fn acp_chat_start(app: AppHandle, state: State<'_, AppState>, agent_id: String, folder: String, explicit: Option<bool>, account_id: Option<String>, separate_copy: Option<bool>) -> Result<Value, String> {
    let deps = live_deps(&app, &state.registry);
    let folder = resolve_folder(&folder, || crate::standby::default_project(&state.registry));
    let mut request = StartRequest { agent_id, folder: PathBuf::from(folder), explicit: explicit.unwrap_or(false), account: account_id.filter(|a| !a.trim().is_empty()), separate_copy: separate_copy.unwrap_or(false), ..Default::default() };
    let started = tauri::async_runtime::spawn_blocking(move || {
        // No sign-in picked and this PC's own login is signed out: run on the lend this PC holds, if any.
        if request.account.is_none() {
            request.account = crate::capacity_proxy::default_account(&request.agent_id, None);
        }
        chat::start_gated(&deps, request)
    }).await.map_err(|e| format!("ACP_START_FAILED: {e}"))?;
    match started {
        Ok(session) => Ok(json!({ "pane_id": session.pane_id(), "agent": session.agent_id(), "lane": chat::LANE })),
        Err(error) => Err(start_error_text(&error)),
    }
}

/// What the copy of a "Work on a copy" chat changed: `{kind, files, additions, deletions}`, or `null` when the chat
/// works in its project (or the copy is gone).
#[tauri::command]
pub async fn acp_chat_copy(pane_id: String) -> Result<Value, String> {
    let Some(link) = chat::copy::link_of(&pane_id) else { return Ok(Value::Null) };
    let found = tauri::async_runtime::spawn_blocking(move || chat::copy::summary(&link)).await.map_err(|e| format!("INTERNAL: {e}"))?;
    Ok(found.unwrap_or(Value::Null))
}

/// "Keep the changes": brings the copy's work into the project; the copy and its chat close. `{kept, files}`.
#[tauri::command]
pub async fn acp_chat_copy_keep(app: AppHandle, state: State<'_, AppState>, pane_id: String) -> Result<Value, String> {
    let link = chat::copy::link_of(&pane_id).ok_or_else(|| "COPY_NOT_FOUND: This chat does not work on a copy.".to_string())?;
    let registry = state.registry.clone();
    let result = tauri::async_runtime::spawn_blocking(move || chat::copy::keep(&link, &pane_id, &registry)).await.map_err(|e| format!("INTERNAL: {e}"))?;
    let _ = app.emit("worktree://changed", ());
    let _ = app.emit("pty://panes-changed", ());
    result
}

/// "Throw away the copy": the copy and its chat close; the project is not touched.
#[tauri::command]
pub async fn acp_chat_copy_discard(app: AppHandle, state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    let link = chat::copy::link_of(&pane_id).ok_or_else(|| "COPY_NOT_FOUND: This chat does not work on a copy.".to_string())?;
    let registry = state.registry.clone();
    let result = tauri::async_runtime::spawn_blocking(move || chat::copy::throw_away(&link, &pane_id, &registry)).await.map_err(|e| format!("INTERNAL: {e}"))?;
    let _ = app.emit("worktree://changed", ());
    let _ = app.emit("pty://panes-changed", ());
    result
}

/// Stops the turn of a chat session (`session/cancel`). True when a turn was running. The state says "stopping"
/// until the agent ends the turn.
#[tauri::command]
pub async fn acp_chat_cancel(pane_id: String) -> Result<bool, String> {
    chat_cancel(&pane_id)
}

/// The body of `acp_chat_cancel`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_cancel(pane_id: &str) -> Result<bool, String> {
    engine::chat_cancel(pane_id)
}

/// "Keep waiting": the agent was quiet, the person chose to wait; the quiet window starts again. True when a turn was running.
/// "Take back": this PC drives the chat again. The device that was driving sees "<this PC> took this back" and has to take
/// over on purpose to send. Returns the id of the device that was driving, or null when nobody else was.
#[tauri::command]
pub async fn acp_chat_take_back(pane_id: String) -> Result<Option<String>, String> {
    chat_take_back(&pane_id)
}

/// The body of `acp_chat_take_back`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_take_back(pane_id: &str) -> Result<Option<String>, String> {
    engine::chat_take_back(pane_id)
}

#[tauri::command]
pub async fn acp_chat_keep_waiting(pane_id: String) -> Result<bool, String> {
    chat_keep_waiting(&pane_id)
}

/// The body of `acp_chat_keep_waiting`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_keep_waiting(pane_id: &str) -> Result<bool, String> {
    engine::chat_keep_waiting(pane_id)
}

/// "Restart chat": brings the adapter of a chat that stopped back. Resolves with the new state; fails with the reason
/// the adapter could not start (the chat then still says it stopped).
#[tauri::command]
pub async fn acp_chat_restart(pane_id: String) -> Result<Value, String> {
    let chat = chat::get(&pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    let worker = chat.clone();
    tauri::async_runtime::spawn_blocking(move || worker.restart())
        .await
        .map_err(|e| format!("ACP_START_FAILED: {e}"))?
        .map_err(|e| format!("ACP_START_FAILED: The chat could not restart: {e}"))?;
    Ok(chat.state())
}

/// The session behind a chat pane: phase, stopping, what waits on the person, settings. `null` for a pane that is not
/// a chat session.
#[tauri::command]
pub async fn acp_chat_state(pane_id: String) -> Result<Value, String> {
    Ok(chat_state(&pane_id))
}

/// The body of `acp_chat_state`, also run for a paired PC (`pclink::calls`).
pub(crate) fn chat_state(pane_id: &str) -> Value {
    engine::chat_state(pane_id)
}

/// The message box got the focus: start the chat's adapter if it sleeps, so "/" has its commands. Starts nothing else.
#[tauri::command]
pub async fn acp_chat_warm(pane_id: String) -> Result<(), String> {
    chat_warm(&pane_id);
    Ok(())
}

/// The body of `acp_chat_warm`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_warm(pane_id: &str) {
    engine::chat_warm(pane_id)
}

/// Changes a setting the agent offers (model, mode, effort) in a chat session. Refused while a turn runs. Returns the
/// new state.
#[tauri::command]
pub async fn acp_chat_set_config(pane_id: String, option_id: String, value: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || chat_set_config(&pane_id, &option_id, &value)).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// The body of `acp_chat_set_config` (blocking: the agent answers), also run for a paired PC (`pclink::calls`).
pub(crate) fn chat_set_config(pane_id: &str, option_id: &str, value: &str) -> Result<Value, String> {
    engine::chat_set_config(pane_id, option_id, value)
}

/// The person's switch: may agents answer this chat's permission questions (default: no, only you)? Only this
/// window can turn it on; the bridge and the MCP tools have no route to it.
#[tauri::command]
pub async fn acp_chat_set_agent_answering(pane_id: String, allowed: bool) -> Result<Value, String> {
    chat_set_agent_answering(&pane_id, allowed)
}

/// The body of `acp_chat_set_agent_answering`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_set_agent_answering(pane_id: &str, allowed: bool) -> Result<Value, String> {
    engine::chat_set_agent_answering(pane_id, allowed)
}

/// The person's Force yes switch for this chat (default off, or what the agent and project start with). A fence still
/// holds, and a question the risk rules do not call low risk still comes to the person. Only this window reaches it.
#[tauri::command]
pub async fn acp_chat_set_force_yes(pane_id: String, on: bool) -> Result<Value, String> {
    chat_set_force_yes(&pane_id, on)
}

/// The body of `acp_chat_set_force_yes`, also run for a paired PC (`pclink::calls`).
pub(crate) fn chat_set_force_yes(pane_id: &str, on: bool) -> Result<Value, String> {
    engine::chat_set_force_yes(pane_id, on)
}

/// "Don't ask again in this chat" for one kind of tool call (`on`), or "Turn back on". In memory for this chat only.
/// Kinds that delete or move things, and kinds the agent did not name, are refused.
#[tauri::command]
pub async fn acp_chat_set_auto_allow(pane_id: String, kind: String, on: bool) -> Result<Value, String> {
    chat_set_auto_allow(&pane_id, &kind, on)
}

/// The body of `acp_chat_set_auto_allow`, also run for a paired PC (`pclink::calls_chat`).
pub(crate) fn chat_set_auto_allow(pane_id: &str, kind: &str, on: bool) -> Result<Value, String> {
    engine::chat_set_auto_allow(pane_id, kind, on)
}

/// "I'm signed in — try again": sends the message the agent refused for want of a sign-in. Fails with the agent's own
/// reason (and the sign-in card stays) when it still wants one.
#[tauri::command]
pub async fn acp_chat_retry_sign_in(pane_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || retry_sign_in(&pane_id)).await.map_err(|e| format!("ACP_START_FAILED: {e}"))?
}

/// The body of `acp_chat_retry_sign_in` (blocking); a paired PC's call runs the same one.
pub(crate) fn retry_sign_in(pane_id: &str) -> Result<(), String> {
    let chat = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    match chat.retry_after_sign_in() {
        Ok(_) => Ok(()),
        Err(chat::SendError::Refused(why)) => Err(format!("ACP_SIGN_IN_NEEDED: {why}")),
        Err(chat::SendError::Busy) => Err("ACP_BUSY: The agent is working. Try again when the turn ends.".to_string()),
        Err(chat::SendError::Gone) => Err("PANE_NOT_FOUND: The chat was closed.".to_string()),
    }
}

#[cfg(test)]
mod folder_tests {
    use super::resolve_folder;

    #[test]
    fn a_start_with_no_folder_uses_the_default_project_and_a_named_folder_is_kept() {
        assert_eq!(resolve_folder("", || "C:/work/default".to_string()), "C:/work/default");
        assert_eq!(resolve_folder("   ", || "C:/work/default".to_string()), "C:/work/default");
        assert_eq!(resolve_folder("C:/work/shop", || panic!("not asked")), "C:/work/shop");
    }
}
