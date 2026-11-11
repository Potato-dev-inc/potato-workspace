//! HTTP routes for `/agents/*`: dispatches each request to the runtime functions that serve it.
//!
//! - `wire`: request bodies and query-string helpers.
//! - `list`, `handles`, `wait`, `answer`: the handlers that need more than a call into `runtime`.

mod answer;
mod handles;
mod list;
#[cfg(test)]
mod tests;
mod wait;
mod wire;

use super::runtime::{self, AgentRunRequest};
use crate::operations::OperationError;
use handles::resolve_run_handle;
use list::{list_agents, AgentListFilter};
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;
use wait::{transcript, wait_agents};
use wire::{
    headless_left_out, parse, project_path, query_value, AgentHandleRequest, AnswerPromptRequest,
    SendAgentRequest, WaitAgentsRequest,
};

pub(crate) use answer::{answer_decided, answer_for_pane};
pub(crate) use handles::latest_handle_for_pane;
#[cfg(test)]
pub(super) use handles::run_for_pane;
#[cfg(test)]
pub(crate) use list::visible_runs;

pub fn handle_request(
    method: &str,
    segments: &[&str],
    query: &str,
    body: &[u8],
    registry: &Arc<Mutex<crate::pty::PaneRegistry>>,
    app: &AppHandle,
    session_id: Option<&str>,
) -> Option<Result<Value, OperationError>> {
    handle_request_as(method, segments, query, body, registry, app, session_id, false)
}

/// [`handle_request`] for a caller the bridge knows more about: `remote_device` when the request
/// needed a paired phone's token. It only changes who an answer is written down as
/// (`AnsweredBy::for_bridge`), never what the caller may do.
#[allow(clippy::too_many_arguments)]
pub fn handle_request_as(
    method: &str,
    segments: &[&str],
    query: &str,
    body: &[u8],
    registry: &Arc<Mutex<crate::pty::PaneRegistry>>,
    app: &AppHandle,
    session_id: Option<&str>,
    remote_device: bool,
) -> Option<Result<Value, OperationError>> {
    // Mission handles (`mission-<id>`) and `run_agent(until_checks_pass)`: `crate::missions`.
    if let Some(result) = crate::missions::routes::intercept(method, segments, body, registry, app, session_id) {
        return Some(result);
    }
    // `run_agent` is prepared once, before the chat lane looks at it: the helper rules (Helper agents, keep open,
    // the person's default helper account) decide `headless` and `account`, and the chat lane must see the
    // effective values, not the raw body. The terminal path below continues with the same prepared request.
    let mut prepared: Option<AgentRunRequest> = None;
    let mut chat_body: Option<Vec<u8>> = None;
    if let ("POST", ["agents", "run"]) = (method, segments) {
        match prepare_run(body, query, session_id, app) {
            Some(Ok(request)) => {
                chat_body = Some(chat_view_of(body, &request));
                prepared = Some(request);
            }
            Some(Err(error)) => return Some(Err(error)),
            // A body that does not parse: the chat lane and the terminal say so in their own words.
            None => {}
        }
    }
    // Chat sessions over ACP (`lane: "acp"` and their handles): `crate::acp::chat::surface`.
    // When the terminal runs a `run_agent` instead, `lane_note` says which way that was and why.
    let lane_note = {
        let deps = crate::commands::acp_chat::live_deps(app, registry);
        let chat_input = chat_body.as_deref().unwrap_or(body);
        let (answer, note) = crate::acp::chat::surface::intercept_noted(method, segments, query, chat_input, &deps, session_id);
        if let Some(result) = answer {
            return Some(result);
        }
        note
    };
    let result = match (method, segments) {
        ("POST", ["agents", "run"]) => match prepared {
            Some(mut request) => {
                request.lane_note = lane_note.as_ref().map(|note| note.record());
                runtime::run_agent(
                    request,
                    registry.clone(),
                    app.clone(),
                    session_id.map(str::to_string),
                )
                .map(|view| serde_json::to_value(view).unwrap_or(Value::Null))
            }
            None => parse::<AgentRunRequest>(body).map(|_| Value::Null),
        },
        ("POST", ["agents", "quick"]) => {
            parse::<super::quick::QuickAskRequest>(body).and_then(|mut request| {
                if request
                    .project_path
                    .as_deref()
                    .is_none_or(|path| path.trim().is_empty())
                {
                    request.project_path = query_value(query, "project_path");
                }
                super::quick::quick_ask(
                    request,
                    registry.clone(),
                    app.clone(),
                    session_id.map(str::to_string),
                )
            })
        }
        ("POST", ["agents", "wait"]) => parse::<WaitAgentsRequest>(body).and_then(|request| {
            let project = project_path(request.project_path.as_deref(), query, registry);
            wait_agents(&project, request, session_id, registry)
        }),
        ("POST", ["agents", "send"]) => parse::<SendAgentRequest>(body).and_then(|request| {
            let project = project_path(request.project_path.as_deref(), query, registry);
            let message = request.message.or(request.task).unwrap_or_default();
            if message.trim().is_empty() {
                return Err(OperationError::new(
                    "INVALID_TASK",
                    "message is required",
                    false,
                ));
            }
            runtime::send_message(
                &project,
                &request.handle,
                message,
                session_id,
                request.delivery.as_deref(),
                request.idempotency_key.as_deref(),
                registry.clone(),
                app.clone(),
            )
        }),
        ("POST", ["agents", "followup"]) => parse::<SendAgentRequest>(body).and_then(|request| {
            let project = project_path(request.project_path.as_deref(), query, registry);
            let task = request.task.or(request.message).unwrap_or_default();
            let structured = request.structured_result;
            if task.trim().is_empty() {
                return Err(OperationError::new(
                    "INVALID_TASK",
                    "task is required",
                    false,
                ));
            }
            let task = super::structured::with_instruction(&task, structured);
            runtime::send_agent(
                &project,
                &request.handle,
                task,
                session_id.map(str::to_string),
                registry.clone(),
                app.clone(),
                super::persist::FollowupOpts {
                    context_policy: request.context_policy,
                    selected_history: request.selected_history,
                    requested_model: request.model,
                    requested_reasoning: request.reasoning,
                    role: None,
                    scope: request.scope,
                    background: request.background,
                    wait_ms: request.wait_ms,
                    idempotency_key: request.idempotency_key,
                    acceptance_criteria: request.acceptance_criteria,
                    checks: request.checks,
                    locks: request.locks,
                    ..Default::default()
                },
            )
            .map(|view| serde_json::to_value(view).unwrap_or(Value::Null))
        }),
        ("POST", ["agents", "answer"]) => parse::<AnswerPromptRequest>(body)
            .and_then(|request| {
                let by = crate::agent_authority::gate::AnsweredBy::for_bridge(session_id, remote_device);
                answer::route_answer(request, query, session_id, &by, registry, app)
            }),
        ("POST", ["agents", "cancel"]) => parse::<AgentHandleRequest>(body).and_then(|request| {
            let project = project_path(request.project_path.as_deref(), query, registry);
            runtime::cancel_agent(
                &project,
                &request.handle,
                session_id,
                registry.clone(),
                app.clone(),
            )
            .map(|view| serde_json::to_value(view).unwrap_or(Value::Null))
        }),
        ("GET", ["agents", "steer-receipt"]) => {
            let handle = query_value(query, "handle").filter(|value| !value.is_empty());
            let idempotency_key =
                query_value(query, "idempotency_key").filter(|value| !value.is_empty());
            let (Some(handle), Some(idempotency_key)) = (handle, idempotency_key) else {
                return Some(Err(OperationError::new(
                    "INVALID_ARGUMENT",
                    "handle and idempotency_key are required",
                    false,
                )));
            };
            let project = project_path(
                query_value(query, "project_path").as_deref(),
                query,
                registry,
            );
            super::messaging::find_receipt_by_key(&project, &handle, &idempotency_key)
                .map(|receipt| super::messaging::receipt_value(&receipt))
                .ok_or_else(|| {
                    OperationError::new("STEER_RECEIPT_NOT_FOUND", "steer receipt not found", false)
                })
        }
        ("GET", ["agents"]) => {
            let explicit = query_value(query, "project_path");
            let project = project_path(explicit.as_deref(), query, registry);
            let filter = AgentListFilter::from_query(query);
            list_agents(&project, session_id, registry, explicit.is_some(), filter)
        }
        // `GET /agents/types` is the agent-type listing served by `bridge/routes/mcp.rs`.
        ("GET", ["agents", "types"]) => return None,
        ("GET", ["agents", handle]) => {
            let project = project_path(None, query, registry);
            resolve_run_handle(&project, handle, registry).and_then(|handle| {
                let mut value = runtime::inspect_agent(&project, &handle, session_id)?;
                if let Ok(snapshot) = runtime::current_agent_for_read(&project, &handle, session_id)
                {
                    super::persist::overlay_live_model(&mut value, &snapshot, Some(registry));
                }
                Ok(value)
            })
        }
        ("POST", ["agents", "close"]) => parse::<AgentHandleRequest>(body).and_then(|request| {
            let project = project_path(request.project_path.as_deref(), query, registry);
            runtime::close_agent(
                &project,
                &request.handle,
                session_id,
                registry.clone(),
                app.clone(),
            )
            .map(|view| serde_json::to_value(view).unwrap_or(Value::Null))
        }),
        ("GET", ["agents", handle, "transcript"]) => {
            let project = project_path(None, query, registry);
            resolve_run_handle(&project, handle, registry)
                .and_then(|handle| transcript(&project, &handle, query, session_id))
        }
        _ => return None,
    };
    Some(result)
}

/// The `run_agent` request after the helper rules: structured-result instruction, "Helper agents" visibility,
/// "Keep helpers open", the folder from the query and the person's default helper account. `None`: the body does
/// not parse (the callers report it).
fn prepare_run(
    body: &[u8],
    query: &str,
    session_id: Option<&str>,
    app: &AppHandle,
) -> Option<Result<AgentRunRequest, OperationError>> {
    let mut request = parse::<AgentRunRequest>(body).ok()?;
    request.task = super::structured::with_instruction(&request.task, request.structured_result);
    // The caller left `headless` out (or null): the agent's run-mode setting may decide.
    request.headless_unset = headless_left_out(body);
    // "Helper agents": the person's choice decides whether the helper is shown or runs in the background.
    crate::agent_run_mode::apply_helper_visibility(&mut request);
    // "Keep helpers open when they finish": a pane this helper opens is not closed when it ends.
    request.kept_open_by_setting = request.turn_index == 0
        && request.pane_id.is_none()
        && request.worker_id.is_none()
        && crate::agent_run_mode::apply_keep_open(&mut request.keep_pane);
    if request
        .project_path
        .as_deref()
        .is_none_or(|path| path.trim().is_empty())
    {
        request.project_path = query_value(query, "project_path");
    }
    // No model named: the person's "Default model for helpers" for this agent decides. A named model always wins.
    if request.turn_index == 0 && request.pane_id.is_none() && request.worker_id.is_none() && request.handle.is_none() && request.agent_run_id.is_none() {
        request.model_from_helper_default = crate::agent_run_mode::apply_helper_model(
            &crate::settings_store::read_public_settings(app),
            &request.agent_type,
            &mut request.model,
        );
    }
    // An agent starting a helper without naming an account: the person's choice decides, or a card asks.
    Some(
        super::helper_login::for_run(
            &mut request,
            session_id,
            &crate::accounts::Store::default_location(),
            &|| crate::questions::routes::publish_changed(app),
        )
        .map(|()| request),
    )
}

/// The body the chat lane reads: the caller's own, with what the helper rules decided written over it.
fn chat_view_of(body: &[u8], request: &AgentRunRequest) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<Value>(body) else { return body.to_vec() };
    let Some(map) = value.as_object_mut() else { return body.to_vec() };
    // A background run the agent's own "How agent runs work" setting asks for has no chat either.
    let headless = request.headless || {
        let mut probe = request.clone();
        crate::agent_run_mode::apply(&mut probe);
        probe.headless
    };
    map.insert("headless".into(), Value::Bool(headless));
    map.insert("task".into(), Value::String(request.task.clone()));
    if request.model_from_helper_default {
        if let Some(model) = &request.model {
            map.insert("model".into(), Value::String(model.clone()));
        }
    }
    if let Some(account) = &request.account {
        map.insert("account".into(), Value::String(account.clone()));
    }
    if let Some(source) = &request.account_source {
        map.insert("account_source".into(), Value::String(source.clone()));
    }
    if let Some(path) = &request.project_path {
        map.insert("project_path".into(), Value::String(path.clone()));
    }
    serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
}
