//! The bridge's view of chat sessions (`POST /acp/sessions`, `GET /acp/sessions/{pane}`,
//! `POST /acp/sessions/{pane}/cancel`), free of the HTTP and Tauri types so the tests drive it directly.

use serde_json::{json, Value};

use super::start::start_gated_with;
use super::{get, StartDeps, StartRequest, LANE};
use crate::acp::config::AgentConfig;

pub type ApiResult = Result<(u16, Value), (u16, Value)>;

fn not_a_chat(pane_id: &str) -> (u16, Value) {
    (404, json!({ "code": "PANE_NOT_FOUND", "error": format!("{pane_id} is not a chat session") }))
}

/// `POST /acp/sessions` `{agent, folder, lane?}`: `lane: "acp"` asks for a chat session whatever the agent's saved
/// choice is (the Labs switch always applies). A refusal says whether the terminal can run the agent instead.
pub fn start(body: &Value, deps: &StartDeps) -> ApiResult {
    start_with(body, deps, false, None)
}

/// `start`, asked to work on a separate copy (a git worktree, or a trial copy of a plain folder) when `separate_copy` is true. Only the
/// PC link's own start row passes it; the phone's route never does.
pub fn start_with_copy(body: &Value, deps: &StartDeps, separate_copy: bool) -> ApiResult {
    start_with(body, deps, separate_copy, None)
}

/// `start`, on the borrowed sign-in `account` (`lend:<grant>`). Only the PC link's start passes one, after it checked the lend is the
/// caller's (`pclink::calls_lend`); the bridge route above never does, so `body` can never name an account.
pub fn start_with_account(body: &Value, deps: &StartDeps, account: Option<String>) -> ApiResult {
    start_with(body, deps, false, account)
}

/// `start_with_account` on a separate copy (the far "Work on a copy" start): the lend applies there too.
pub fn start_copy_with_account(body: &Value, deps: &StartDeps, account: Option<String>) -> ApiResult {
    start_with(body, deps, true, account)
}

/// `start_with_account` over an agent table the caller gives (a machine with agents of its own; the bridge never does).
pub fn start_with_agents(body: &Value, deps: &StartDeps, account: Option<String>, find: &dyn Fn(&str) -> Option<AgentConfig>) -> ApiResult {
    start_in(body, deps, false, account, find)
}

fn start_with(body: &Value, deps: &StartDeps, separate_copy: bool, account: Option<String>) -> ApiResult {
    start_in(body, deps, separate_copy, account, &crate::acp::config::find_builtin)
}

fn start_in(body: &Value, deps: &StartDeps, separate_copy: bool, account: Option<String>, find: &dyn Fn(&str) -> Option<AgentConfig>) -> ApiResult {
    let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let agent = text("agent").ok_or_else(|| (400, json!({ "code": "INVALID_ARGUMENT", "error": "agent is required" })))?;
    let folder = text("folder").ok_or_else(|| (400, json!({ "code": "INVALID_ARGUMENT", "error": "folder is required" })))?;
    let explicit = text("lane").as_deref() == Some(LANE);
    match start_gated_with(deps, StartRequest { agent_id: agent, folder: folder.into(), explicit, account, separate_copy, ..Default::default() }, find) {
        Ok(session) => Ok((200, json!({ "pane_id": session.pane_id(), "agent": session.agent_id(), "lane": LANE }))),
        Err(error) => {
            let status = match error.code {
                "INVALID_ARGUMENT" => 400,
                "ACP_START_FAILED" | "ACP_SIGN_IN_NEEDED" => 502,
                _ => 409,
            };
            Err((status, json!({ "code": error.code, "error": error.message, "fallback": error.fallback.then_some("terminal"), "recoverable": error.fallback })))
        }
    }
}

/// `GET /acp/sessions/{pane}`.
pub fn state(pane_id: &str) -> ApiResult {
    let session = get(pane_id).ok_or_else(|| not_a_chat(pane_id))?;
    session.reconcile_cards();
    Ok((200, session.state()))
}

/// `POST /acp/sessions/{pane}/cancel`.
pub fn cancel(pane_id: &str) -> ApiResult {
    let session = get(pane_id).ok_or_else(|| not_a_chat(pane_id))?;
    match session.cancel() {
        Ok(stopped) => Ok((200, json!({ "pane_id": pane_id, "stopped": stopped }))),
        Err(error) => Err((502, json!({ "code": "ACP_CANCEL_FAILED", "error": error.to_string() }))),
    }
}

/// `POST /acp/sessions/{pane}/typing`: a device (a phone, another PC) says it is typing in this chat, so this PC can
/// show "<name> is typing..." with Take back. `from` is the device's identity id; `None` (the app itself) changes nothing.
pub fn typing(pane_id: &str, from: Option<&str>) -> ApiResult {
    let session = get(pane_id).ok_or_else(|| not_a_chat(pane_id))?;
    let Some(from) = from else { return Ok((200, json!({ "pane_id": pane_id, "ignored": true }))) };
    match session.device_typing(from) {
        Ok(()) => Ok((200, json!({ "pane_id": pane_id }))),
        Err(sentence) => Err((409, json!({ "code": super::drive::TOOK_BACK_CODE, "error": sentence }))),
    }
}

/// `POST /acp/sessions/{pane}/claim`: a device that was locked out ("This PC took this back") takes the chat over again.
pub fn claim(pane_id: &str, from: Option<&str>) -> ApiResult {
    let session = get(pane_id).ok_or_else(|| not_a_chat(pane_id))?;
    let Some(from) = from else { return Ok((200, json!({ "pane_id": pane_id, "ignored": true }))) };
    session.device_claims(from);
    Ok((200, json!({ "pane_id": pane_id })))
}
