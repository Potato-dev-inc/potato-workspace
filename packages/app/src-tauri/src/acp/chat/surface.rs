//! Chat sessions on the agent tools (`run_agent`, `wait_agents`, `inspect_agent`, `followup_task`, `send_message`,
//! `answer_prompt`, `interrupt_agent`, `close_agent`): an agent that orchestrates others can start a worker as a chat
//! session and drive it with the same tools. Their handle is the chat pane's id.
//!
//! What an agent reads from a chat session is the chat (the agent's own words, what it asked, how the turn ended),
//! never the one-line screen of its pane. The request/answer shapes follow the terminal runs' (`status`, `result`,
//! `prompt`, `pane_id`, a cursor), so a caller does not need two code paths.
//!
//! * **Choosing.** `run_agent` takes `lane`: `"acp"` asks for a chat session (the Labs switch still applies), `"terminal"`
//!   asks for today's way, `"auto"` picks (`lanes`), and without it the agent's saved choice ("How to run") decides, else auto. When the saved choice
//!   decides and the chat cannot start, the request falls through to the terminal way (the automatic fallback);
//!   when the caller asked for `"acp"` it gets the error instead.
//! * **Answering permissions.** `answer_prompt` on a chat's question needs the person's switch for that chat
//!   (`AcpChat::set_agent_answering`, default off, Settings window only). Without it the call is refused and says who
//!   can answer. With it, the choice must be one of the options the agent offered, and the answer goes through the
//!   question store like the person's own, with an audit line naming the caller.
//! * **Whose chat.** An agent may steer, answer, stop or close only a chat it started itself. A chat started by the
//!   person (or by another agent) is `NOT_YOUR_CHAT` for it; reading it is open. A caller without an MCP session (the
//!   command line) is not restricted by this rule, but the answer switch applies to it all the same.
//! * **Generic.** Nothing here names an agent.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{get, lanes, AcpChat, AgentAnswerError, Readiness, SendError, StartDeps, StartRequest, LANE};
use crate::acp::lane::LaneStore;
use crate::acp::state::{ExitKind, Phase, Snapshot, StopKind};
use crate::audit::Who;
use crate::operations::OperationError;
use crate::session_chat::ChatItem;
use crate::wait_reasons;

type Reply = Result<Value, OperationError>;

const DEFAULT_WAIT_MS: u64 = 120_000;
const MAX_WAIT_MS: u64 = 300_000;
/// Longest stability window `wait_agents` accepts for `confirm_prompt_ms`.
const MAX_CONFIRM_PROMPT_MS: u64 = 60_000;
/// Longest wait `run_agent` and `followup_task` do before they answer "still running".
const POLL: Duration = Duration::from_millis(100);
/// After the agent's background work drains, how long its last turn must stay finished with no visible change
/// before a wait calls it done. The adapter may start the follow-up turn that carries the real answer a moment
/// later; this window keeps the wait from returning the earlier, partial answer.
const BACKGROUND_SETTLE: Duration = Duration::from_millis(2_000);
/// Items `inspect_agent` shows of the chat.
const RECENT_ITEMS: usize = 16;
const ITEM_TEXT_CHARS: usize = 600;

fn err(code: &str, message: impl Into<String>, recoverable: bool) -> OperationError {
    OperationError::new(code, message, recoverable)
}

// ---- the views ----------------------------------------------------------------------------------------------

/// `completed`, `failed`, `cancelled`, `waiting_input`, `running` or `idle` (nothing was asked yet).
pub fn status_of(snapshot: &Snapshot) -> &'static str {
    match snapshot.phase {
        Phase::Working | Phase::Cancelling | Phase::Starting | Phase::Resuming => "running",
        Phase::NeedsInput => "waiting_input",
        Phase::Idle | Phase::Dormant | Phase::Exited => match snapshot.last_stop {
            Some(StopKind::EndTurn | StopKind::MaxTokens | StopKind::MaxTurnRequests) => "completed",
            Some(StopKind::Cancelled) => "cancelled",
            Some(StopKind::Failed | StopKind::Hung | StopKind::Refusal) => "failed",
            None => match snapshot.exit.as_ref().map(|e| e.kind) {
                Some(ExitKind::Crashed | ExitKind::Hung | ExitKind::WriteStalled | ExitKind::StartFailed) => "failed",
                _ => "idle",
            },
        },
    }
}

fn is_final(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let end = text.char_indices().nth(max).map(|(i, _)| i).unwrap_or(text.len());
    format!("{}…", &text[..end])
}

/// The newest turn's words: the agent's last message after the person's last message.
fn last_turn(items: &[ChatItem]) -> (Option<String>, Option<String>) {
    let mut reply: Option<String> = None;
    let mut problem: Option<String> = None;
    for item in items.iter().rev() {
        match item {
            ChatItem::User { .. } => break,
            ChatItem::Assistant { text, .. } if reply.is_none() && !text.trim().is_empty() => reply = Some(text.clone()),
            ChatItem::Notice { notice_kind, text, .. } if problem.is_none() && notice_kind == "error" => problem = Some(text.clone()),
            _ => {}
        }
    }
    (reply, problem)
}

fn item_line(item: &ChatItem) -> Option<Value> {
    match item {
        ChatItem::User { text, .. } => Some(json!({ "kind": "user", "text": cut(text, ITEM_TEXT_CHARS) })),
        ChatItem::Assistant { text, .. } => Some(json!({ "kind": "assistant", "text": cut(text, ITEM_TEXT_CHARS) })),
        ChatItem::ToolCall { name, summary, .. } => Some(json!({ "kind": "tool", "name": name, "text": cut(summary, 200) })),
        ChatItem::ToolResult { ok, output, .. } => Some(json!({ "kind": "tool_result", "ok": ok, "text": cut(output, 200) })),
        ChatItem::TurnEnd { outcome, duration_ms, .. } => Some(json!({ "kind": "turn_end", "outcome": serde_json::to_value(outcome).unwrap_or(Value::Null), "duration_ms": duration_ms })),
        ChatItem::Notice { text, notice_kind, .. } => Some(json!({ "kind": "notice", "notice_kind": notice_kind, "text": cut(text, 300) })),
        ChatItem::Plan { .. } | ChatItem::Usage { .. } | ChatItem::Session { .. } | ChatItem::Thinking { .. } => None,
    }
}

/// The question the agent waits on, in the shape `answer_prompt` takes: `prompt_id` and one of the option ids.
fn prompt_of(state: &Value) -> Value {
    let Some(first) = state.get("permissions").and_then(Value::as_array).and_then(|list| list.first()) else { return Value::Null };
    let since = first.get("sinceMs").and_then(Value::as_u64);
    let options: Vec<Value> = first
        .get("options")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|o| json!({ "id": o.get("id"), "name": o.get("name"), "kind": o.get("kind") })).collect())
        .unwrap_or_default();
    json!({
        "prompt_id": first.get("questionId").cloned().unwrap_or_else(|| first.get("askId").cloned().unwrap_or(Value::Null)),
        "kind": "acp_permission",
        "title": first.get("title"),
        "tool_kind": first.get("toolKind"),
        "options": options,
        "since_ms": since.map(Value::from).unwrap_or(Value::Null),
        "open_ms": since.map(|ms| Value::from(crate::questions::now_ms().saturating_sub(ms))).unwrap_or(Value::Null),
        "answerable_by_agent": state.get("agentAnswering").and_then(Value::as_bool).unwrap_or(false),
        "hint": if state.get("agentAnswering").and_then(Value::as_bool).unwrap_or(false) {
            "answer_prompt with prompt_id and the id of one option"
        } else {
            "Only the person can answer this: they have not let agents answer in this chat. Tell them, or wait."
        },
    })
}

/// One chat as the tools return it.
pub fn view(chat: &AcpChat) -> Value {
    let snapshot = chat.session().snapshot();
    let state = chat.state();
    let items = chat.items();
    let status = status_of(&snapshot);
    let (reply, problem) = last_turn(&items);
    let in_terminal = !state.get("inTerminal").map(Value::is_null).unwrap_or(true);
    let (model, reasoning) = super::choice::in_use(chat);
    // The run's acceptance checks, evaluated once for a completed turn (cached by turn).
    let results = chat.checked(status == "completed" && !in_terminal, snapshot.turn, reply.as_deref());
    let checks_total = chat.checks_configured();
    let checks_failed = results.as_ref().is_some_and(|r| r.iter().any(|c| !c.passed));
    let (requested_model, account, account_source) = chat.run_meta_snapshot();
    let receipt = super::receipt::build(&super::receipt::ReceiptInputs {
        status: if in_terminal && !is_final(status) { "idle" } else { status },
        final_turn: is_final(status),
        checks_total,
        results: results.as_deref(),
        reply: reply.as_deref(),
        requested_model: requested_model.as_deref(),
        model_in_use: model.as_deref(),
        account: account.as_deref(),
        account_source: account_source.as_deref(),
        lane_note: chat.lane_note().as_ref(),
        warm: chat.warm_claimed(),
    });
    let running: Vec<&crate::acp::state::BackgroundTask> = snapshot.background_tasks.iter().filter(|t| t.is_running()).collect();
    let tracking = match chat.session().caps() {
        Some(caps) if caps.background_tasks => "reported",
        Some(_) => "not_reported_by_adapter",
        None => "unknown_until_started",
    };
    let last_prompt = chat.last_prompt_end().map(|end| json!({
        "prompt_id": end.prompt_id,
        "ask_id": end.ask_id,
        "reason": end.reason,
        "at_ms": end.at_ms,
    })).unwrap_or(Value::Null);
    let mut shown = json!({
        "handle": chat.pane_id(),
        "pane_id": chat.pane_id(),
        "lane": LANE,
        "agent": chat.agent_id(),
        "name": chat.label(),
        "status": if in_terminal && !is_final(status) { "idle" } else if checks_failed { "failed" } else { status },
        "stage": state.get("phase"),
        "result": if status == "completed" { reply.clone().map(Value::String).unwrap_or(Value::Null) } else { Value::Null },
        "result_capture": if is_final(status) { "authoritative" } else { "pending" },
        "prompt": prompt_of(&state),
        "error": if status == "failed" {
            json!({ "code": "ACP_TURN_FAILED", "message": problem.unwrap_or_else(|| "The turn failed.".to_string()), "recoverable": true })
        } else if checks_failed {
            json!({ "code": "ACCEPTANCE_FAILED", "message": crate::agent_runs::checks::failure_summary(results.as_deref().unwrap_or(&[])).unwrap_or_else(|| "A check failed.".to_string()), "recoverable": true })
        } else {
            Value::Null
        },
        "acceptance_status": match results.as_deref() {
            Some(r) if !r.is_empty() && r.iter().all(|c| c.passed) => "passed",
            Some(r) if r.iter().any(|c| !c.passed) => "failed",
            _ => "not_checked",
        },
        "checks_configured": checks_total,
        "checks": results.clone().unwrap_or_default(),
        "verified": results.as_deref().is_some_and(|r| !r.is_empty() && r.iter().all(|c| c.passed)),
        "receipt": super::receipt::receipt_value(&receipt),
        "pane_open": !chat.is_closed(),
        "pane_policy": "stays_open_until_you_close_it",
        "in_terminal": in_terminal,
        "model": model.map(Value::String).unwrap_or(Value::Null),
        "reasoning": reasoning.map(Value::String).unwrap_or(Value::Null),
        "background_running": !running.is_empty(),
        "background_task_count": running.len(),
        "background_tasks": running.iter().map(|t| json!({ "id": t.id, "name": t.name, "state": t.state })).collect::<Vec<_>>(),
        "background_tracking": tracking,
        "background_note": if tracking == "reported" { Value::Null } else { json!("completed covers the turn only; this agent does not report background work that outlives it.") },
        "last_prompt": last_prompt,
        "turn": snapshot.turn,
        "revision": snapshot.revision,
        "next_cursor": snapshot.revision,
        "warnings": chat.choice_warnings(),
    });
    if let Some(note) = chat.lane_note() {
        lanes::merge_note(&mut shown, &note);
    }
    shown
}

fn inspect(chat: &AcpChat) -> Value {
    let mut value = view(chat);
    let items = chat.items();
    let recent: Vec<Value> = items.iter().filter_map(item_line).rev().take(RECENT_ITEMS).collect::<Vec<_>>().into_iter().rev().collect();
    if let Some(map) = value.as_object_mut() {
        map.insert("recent".into(), Value::Array(recent));
        map.insert("capabilities".into(), json!({ "steer": chat.can_steer(), "chat": true, "terminal_screen": false }));
        map.insert("note".into(), json!("A chat session has no terminal screen. `recent` is its conversation; the whole chat is GET /agents/{handle}/transcript."));
    }
    value
}

// ---- helpers ------------------------------------------------------------------------------------------------

fn body_json(body: &[u8]) -> Option<Value> {
    serde_json::from_slice(body).ok()
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// The chat a handle names, if it names one.
fn chat_of(handle: &str) -> Option<std::sync::Arc<AcpChat>> {
    get(handle.trim())
}

fn who(session: Option<&str>) -> Who {
    match session {
        Some(session) => Who::Agent(session.to_string()),
        None => Who::Local,
    }
}

/// An agent (a caller with an MCP session) may change only a chat it started.
fn owned(chat: &AcpChat, session: Option<&str>) -> Result<(), OperationError> {
    match (session, chat.started_by()) {
        (None, _) => Ok(()),
        (Some(me), Some(owner)) if me == owner => Ok(()),
        (Some(_), _) => Err(err(
            "NOT_YOUR_CHAT",
            "This chat session was not started by you, so you may read it but not steer, answer, stop or close it. Start your own with run_agent(lane: \"acp\"), or ask the person.",
            false,
        )),
    }
}

fn chat_for(handle: &str) -> Result<std::sync::Arc<AcpChat>, OperationError> {
    chat_of(handle).ok_or_else(|| err("AGENT_NOT_FOUND", format!("{handle} is not a chat session"), false))
}

fn send_failure(error: SendError) -> OperationError {
    match error {
        SendError::Busy => err("AGENT_BUSY", "The agent is working on a turn. Use send_message to steer it, or wait_agents and then followup_task.", true),
        SendError::Gone => err("AGENT_CLOSED", "That chat session was closed.", false),
        SendError::Refused(why) => err("MESSAGE_REFUSED", why, true),
    }
}

/// Waits until the chat's status is one of `until`, or `wait_ms` is over. Returns the status last seen.
fn wait_status(chat: &AcpChat, until: &[String], wait_ms: u64) -> &'static str {
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    loop {
        let status = status_of(&chat.session().snapshot());
        if until.iter().any(|u| u == status) || chat.is_closed() || Instant::now() >= deadline {
            return status;
        }
        std::thread::sleep(POLL);
    }
}

fn default_until() -> Vec<String> {
    ["completed", "failed", "cancelled", "waiting_input"].iter().map(|s| s.to_string()).collect()
}

fn until_of(value: &Value) -> Vec<String> {
    let listed: Vec<String> = value
        .get("until")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(|s| if s == "needs_input" { "waiting_input".to_string() } else { s.to_string() }).collect())
        .unwrap_or_default();
    if listed.is_empty() {
        default_until()
    } else {
        listed
    }
}

/// How long the same prompt must stay open before `wait_agents` calls a chat blocked. `0` (the
/// default) keeps the old behaviour: one `waiting_input` reading is enough.
fn confirm_prompt_ms_of(value: &Value) -> Result<u64, OperationError> {
    let ms = value.get("confirm_prompt_ms").and_then(Value::as_u64).unwrap_or(0);
    if ms > MAX_CONFIRM_PROMPT_MS {
        return Err(err("INVALID_TIMEOUT", format!("confirm_prompt_ms must be between 0 and {MAX_CONFIRM_PROMPT_MS}"), false));
    }
    Ok(ms)
}

fn wait_ms_of(value: &Value, default: u64) -> Result<u64, OperationError> {
    let ms = value.get("wait_ms").or_else(|| value.get("timeout_ms")).and_then(Value::as_u64).unwrap_or(default);
    if ms > MAX_WAIT_MS {
        return Err(err("INVALID_TIMEOUT", format!("wait_ms must be between 0 and {MAX_WAIT_MS}"), false));
    }
    Ok(ms)
}

// ---- the routes ---------------------------------------------------------------------------------------------

/// Handles `/agents/*` requests that belong to a chat session. `None`: not one of ours, carry on with the terminal
/// runs. `query` is the request's query string (`?after=`).
pub fn intercept(method: &str, segments: &[&str], query: &str, body: &[u8], deps: &StartDeps, session: Option<&str>) -> Option<Reply> {
    intercept_noted(method, segments, query, body, deps, session).0
}

/// [`intercept`] plus, for a `run_agent` that the terminal runs, what to say about the lane: the caller adds it to the
/// terminal run's answer (`lanes::annotate`).
pub fn intercept_noted(method: &str, segments: &[&str], query: &str, body: &[u8], deps: &StartDeps, session: Option<&str>) -> (Option<Reply>, Option<lanes::LaneNote>) {
    intercept_noted_with(method, segments, query, body, deps, session, &Live)
}

/// What the lane decision asks of the app and the agent. [`Live`] answers from the real settings; tests answer
/// with their own agent.
pub trait LaneLookup {
    /// The Labs switch Chat (ACP).
    fn labs_on(&self) -> bool;
    /// The agent's ACP definition.
    fn config_for(&self, agent: &str) -> Option<crate::acp::config::AgentConfig>;
    /// The agent's saved "How to run" (`None`: never changed).
    fn saved(&self, agent: &str) -> Option<crate::acp::lane::RunLane>;
    /// Its chat add-on is installed.
    fn adapter_installed(&self, cfg: &crate::acp::config::AgentConfig, env: &dyn crate::acp::config::HostEnv) -> bool;
    /// The installed OpenCode's major version, when known (2.x has no native terminal agent).
    fn opencode_major(&self) -> Option<u32> {
        None
    }
}

/// The real settings.
pub struct Live;

impl LaneLookup for Live {
    fn labs_on(&self) -> bool {
        crate::acp::chat_enabled()
    }
    fn config_for(&self, agent: &str) -> Option<crate::acp::config::AgentConfig> {
        crate::acp::config::find_builtin(agent)
    }
    fn saved(&self, agent: &str) -> Option<crate::acp::lane::RunLane> {
        LaneStore::in_app_data().chosen(agent)
    }
    fn adapter_installed(&self, cfg: &crate::acp::config::AgentConfig, env: &dyn crate::acp::config::HostEnv) -> bool {
        !crate::acp::install::is_missing(cfg, env)
    }
    fn opencode_major(&self) -> Option<u32> {
        crate::opencode::edition::installed_major()
    }
}

/// [`intercept_noted`] with the agent facts looked up through `lookup`.
pub fn intercept_noted_with(method: &str, segments: &[&str], query: &str, body: &[u8], deps: &StartDeps, session: Option<&str>, lookup: &dyn LaneLookup) -> (Option<Reply>, Option<lanes::LaneNote>) {
    if let ("POST", ["agents", "run"]) = (method, segments) {
        return run(body, query, deps, session, lookup);
    }
    (intercept_rest(method, segments, query, body, deps, session), None)
}

fn intercept_rest(method: &str, segments: &[&str], query: &str, body: &[u8], deps: &StartDeps, session: Option<&str>) -> Option<Reply> {
    match (method, segments) {
        ("POST", ["agents", "wait"]) => wait(body),
        ("POST", ["agents", "followup" | "send"]) => {
            let value = body_json(body)?;
            let handle = text_of(&value, "handle")?;
            let next_turn = segments[1] == "followup";
            match chat_of(&handle) {
                Some(chat) if !chat.is_closed() => Some(followup(&chat, &value, session, next_turn)),
                // A closed chat (or one that is gone after close_agent): followup_task brings the same
                // conversation back, loading the agent's own session, and sends the task as the next turn.
                found if next_turn => match reopen(&handle, deps, session) {
                    Some(Ok(chat)) => Some(followup(&chat, &value, session, true).map(|answer| with_reopened(answer, &handle))),
                    Some(Err(error)) => Some(Err(error)),
                    None => found.map(|chat| followup(&chat, &value, session, next_turn)),
                },
                found => found.map(|chat| followup(&chat, &value, session, next_turn)),
            }
        }
        ("POST", ["agents", "answer"]) => {
            let value = body_json(body)?;
            let chat = chat_of(&text_of(&value, "handle").or_else(|| text_of(&value, "pane_id"))?)?;
            Some(answer(&chat, &value, session))
        }
        ("POST", ["agents", "cancel" | "interrupt"]) => {
            let value = body_json(body)?;
            let chat = chat_of(&text_of(&value, "handle").or_else(|| text_of(&value, "pane_id"))?)?;
            Some(owned(&chat, session).and_then(|()| {
                chat.cancel().map_err(|e| err("ACP_CANCEL_FAILED", e.to_string(), true))?;
                Ok(view(&chat))
            }))
        }
        ("POST", ["agents", "close"]) => {
            let value = body_json(body)?;
            let chat = chat_of(&text_of(&value, "handle")?)?;
            Some(owned(&chat, session).and_then(|()| {
                let last = view(&chat);
                crate::pty::registry_kill_pane_and_wait(&deps.registry, chat.pane_id(), Some("closed by an agent")).map_err(|e| err("CLOSE_FAILED", e, true))?;
                deps.host.panes_changed();
                let mut done = last;
                if let Some(map) = done.as_object_mut() {
                    map.insert("pane_open".into(), json!(false));
                }
                Ok(done)
            }))
        }
        ("GET", ["agents", handle]) => chat_of(handle).map(|chat| Ok(inspect(&chat))),
        ("GET", ["agents", handle, "transcript"]) => {
            let chat = chat_of(handle)?;
            let after = query.trim_start_matches('?').split('&').find_map(|pair| pair.strip_prefix("after=")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
            let lines: Vec<Value> = chat.items().iter().filter_map(item_line).collect();
            let total = lines.len();
            Some(Ok(json!({ "handle": handle, "lane": LANE, "items": lines.into_iter().skip(after).collect::<Vec<_>>(), "next_after": total })))
        }
        _ => None,
    }
}

/// `followup_task` on a chat that was closed: the conversation is brought back under the same handle, in the way a
/// restart does (`Conversations::reopen_closed`, then `restore_panes`), and it loads the agent's own session, so the
/// agent remembers what was said. `None`: this handle is not a closed conversation (the caller carries on as before).
/// An error says why it cannot come back: it is never replaced by a fresh chat without saying so.
fn reopen(handle: &str, deps: &StartDeps, session: Option<&str>) -> Option<Result<std::sync::Arc<AcpChat>, OperationError>> {
    let conversations = deps.conversations.as_ref()?;
    let record = conversations.record(handle)?;
    if record.last_known_state != crate::acp::record::LastState::Closed {
        return None;
    }
    // Only the agent that started the chat may bring it back (a caller without a session, the command line, may).
    if let (Some(me), owner) = (session, record.started_by.as_deref()) {
        if owner != Some(me) {
            return Some(Err(err("NOT_YOUR_CHAT", "This chat session was not started by you, so you may not reopen it. Start your own with run_agent(lane: \"acp\"), or ask the person.", false)));
        }
    }
    if record.session_id.as_deref().is_none_or(str::is_empty) {
        let mut e = err("ACP_SESSION_UNKNOWN", "That chat was closed before the agent gave it a session id, so its conversation cannot be loaded again.", false);
        e.context = json!({ "recovery": "Start a new chat with run_agent(lane: \"acp\") and put what it needs to know in the task; agent_transcript(handle) still shows the old one." });
        return Some(Err(e));
    }
    let failed = |why: String| {
        let mut e = err("ACP_REOPEN_FAILED", why, true);
        e.context = json!({ "recovery": "Open the closed chat from the app, or start a new chat with run_agent(lane: \"acp\")." });
        Some(Err(e))
    };
    if let Err(error) = conversations.reopen_closed(handle) {
        return failed(format!("The closed chat could not be reopened: {error}"));
    }
    super::restore_panes(deps);
    match chat_of(handle) {
        Some(chat) => Some(Ok(chat)),
        None => failed("The closed chat could not be reopened.".into()),
    }
}

/// Adds `reopened` to the answer of a follow-up that brought a closed chat back.
fn with_reopened(mut answer: Value, handle: &str) -> Value {
    if let Some(map) = answer.as_object_mut() {
        map.insert("reopened".into(), json!({ "how": "chat_reopened", "previous_pane_id": handle, "previous_handle": handle, "note": "The chat was closed; reopened it under the same handle, and the agent's earlier session loads with this message so it remembers the conversation." }));
    }
    answer
}

/// A chat that could not take the requested settings is closed and its unused conversation dropped.
fn abandon_chat(deps: &StartDeps, chat: &AcpChat) {
    let _ = crate::pty::registry_kill_pane_and_wait(&deps.registry, chat.pane_id(), Some("the requested model could not be used"));
    if let Some(conversations) = &deps.conversations {
        conversations.discard(chat.pane_id());
    }
    deps.host.panes_changed();
}

/// The ids a chat session can be asked for: agents with an ACP definition.
fn chat_agent_ids() -> Vec<String> {
    let mut ids: Vec<String> = crate::acp::config::builtin_agents().into_iter().map(|c| c.id).collect();
    for cfg in crate::acp::overlay::overlay_agents(&crate::acp::overlay::OverlayStore::in_app_data()) {
        if !ids.contains(&cfg.id) {
            ids.push(cfg.id);
        }
    }
    ids
}

/// Request fields a chat session cannot honour. A chat has no read-only mode, worktree, lock, budget, backup agent,
/// shell allow-list or context packet, so a request that uses them must not quietly run as a chat. (`checks` and
/// `structured_result` are honoured; `role` is only a label and is ignored; `scope` only shapes a packet prompt a
/// chat does not build, so it counts.)
pub fn chat_cannot_do(value: &Value) -> Vec<&'static str> {
    let truthy = |key: &str| value.get(key).and_then(Value::as_bool) == Some(true);
    let present = |key: &str| value.get(key).is_some_and(|v| !v.is_null());
    let filled = |key: &str| match value.get(key) {
        Some(Value::Array(list)) => !list.is_empty(),
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    };
    let mut fields = Vec::new();
    if truthy("read_only") {
        fields.push("read_only");
    }
    if value.get("isolation").and_then(Value::as_str).is_some_and(|i| !i.trim().is_empty() && i.trim() != "none") {
        fields.push("isolation");
    }
    if filled("locks") {
        fields.push("locks");
    }
    if present("budget_turns") {
        fields.push("budget_turns");
    }
    if present("budget_minutes") {
        fields.push("budget_minutes");
    }
    if filled("budget_parent") {
        fields.push("budget_parent");
    }
    if filled("backup_agents") {
        fields.push("backup_agents");
    }
    if truthy("allow_shell") {
        fields.push("allow_shell");
    }
    if filled("allowed_commands") {
        fields.push("allowed_commands");
    }
    if truthy("trust_workspace") {
        fields.push("trust_workspace");
    }
    if truthy("until_checks_pass") {
        fields.push("until_checks_pass");
    }
    let policy_needs_packet = ["context_policy", "context_mode"]
        .iter()
        .any(|key| matches!(value.get(*key).and_then(Value::as_str), Some("parent_summary" | "resume" | "selected_history")));
    if policy_needs_packet {
        fields.push("context_policy");
    }
    if filled("selected_history") {
        fields.push("selected_history");
    }
    if filled("scope") {
        fields.push("scope");
    }
    fields
}

/// `run_agent`s already started as a chat: (MCP session, idempotency key) -> the chat's handle.
static STARTED_BY_KEY: parking_lot::Mutex<Vec<((Option<String>, String), String)>> = parking_lot::Mutex::new(Vec::new());

fn remembered_chat(session: Option<&str>, key: &str) -> Option<std::sync::Arc<AcpChat>> {
    let handle = STARTED_BY_KEY.lock().iter().find(|((s, k), _)| s.as_deref() == session && k == key).map(|(_, h)| h.clone())?;
    chat_of(&handle).filter(|chat| !chat.is_closed())
}

fn remember_chat(session: Option<&str>, key: &str, handle: &str) {
    let mut started = STARTED_BY_KEY.lock();
    started.retain(|((s, k), _)| !(s.as_deref() == session && k == key));
    started.push(((session.map(str::to_string), key.to_string()), handle.to_string()));
    // Entries of chats that are gone leave with the next start.
    started.retain(|(_, h)| get(h).is_some());
}

/// The checks a `run_agent`/`followup_task` body names, validated against the folder.
fn checks_of(value: &Value, folder: &std::path::Path) -> Result<Vec<crate::agent_runs::checks::Check>, OperationError> {
    let Some(raw) = value.get("checks").filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let checks: Vec<crate::agent_runs::checks::Check> = serde_json::from_value(raw.clone()).map_err(|e| err("INVALID_ARGUMENT", format!("checks: {e}"), false))?;
    crate::agent_runs::checks::validate(folder, &checks).map_err(|why| err("INVALID_ARGUMENT", why, false))?;
    Ok(checks)
}

/// `(answer, note)`: the answer when this is a chat session's request; `(None, note)` when the terminal runs it.
fn run(body: &[u8], query: &str, deps: &StartDeps, session: Option<&str>, lookup: &dyn LaneLookup) -> (Option<Reply>, Option<lanes::LaneNote>) {
    let Some(value) = body_json(body) else { return (None, None) };
    let task = text_of(&value, "task");
    // Adopting a chat that exists: the task is its next message.
    if let Some(id) = ["worker_id", "pane_id", "handle"].iter().find_map(|key| text_of(&value, key)) {
        if let Some(chat) = chat_of(&id) {
            return (
                Some(match task {
                    Some(_) => owned(&chat, session).and_then(|()| followup(&chat, &value, session, true)),
                    None => Err(err("INVALID_TASK", "task is required", false)),
                }),
                None,
            );
        }
        // Adopting a terminal pane or worker is not a new run: nothing to say about the lane.
        return (None, None);
    }
    // The same call again (a retry after a timeout): the chat it started, not a second one.
    let key = text_of(&value, "idempotency_key");
    if let Some(chat) = key.as_deref().and_then(|key| remembered_chat(session, key)) {
        if value.get("background").and_then(Value::as_bool) != Some(true) {
            match wait_ms_of(&value, DEFAULT_WAIT_MS) {
                Ok(ms) => {
                    wait_status(&chat, &default_until(), ms);
                }
                Err(e) => return (Some(Err(e)), None),
            }
        }
        return (Some(Ok(view(&chat))), None);
    }
    let mut lane = text_of(&value, "lane");
    let mut agent = text_of(&value, "agent_type");
    // OpenCode 2.x has no native terminal agent: its runs go to the OpenCode chat lane, and say so.
    let mut routed: Option<String> = None;
    if agent.as_deref() == Some("opencode_native") {
        match crate::opencode::edition::route_native_run(lane.as_deref(), lookup.opencode_major()) {
            Ok(Some(why)) => {
                routed = Some(why);
                agent = Some("opencode".to_string());
                lane = Some("acp".to_string());
            }
            Ok(None) => {}
            Err(why) => return (Some(Err(err("OPENCODE_NATIVE_UNAVAILABLE", why, false))), None),
        }
    }
    let account = text_of(&value, "account");
    let headless = value.get("headless").and_then(Value::as_bool) == Some(true);
    let saved = agent.as_deref().and_then(|a| lookup.saved(a));
    let config = agent.as_deref().and_then(|a| lookup.config_for(a));
    let labs_on = lookup.labs_on();
    let facts = lanes::Facts {
        labs_on,
        has_definition: config.is_some(),
        adapter_installed: config.as_ref().is_some_and(|cfg| lookup.adapter_installed(cfg, &*deps.env)),
        headless,
        terminal_only: chat_cannot_do(&value),
    };
    let plan = match lanes::plan(lane.as_deref(), saved, facts) {
        Ok(plan) => plan,
        Err(why) => return (Some(Err(err("INVALID_ARGUMENT", why, false))), None),
    };
    let (explicit, mut reason) = match plan {
        lanes::Plan::Terminal { reason } => return (None, Some(lanes::LaneNote::terminal(&reason))),
        lanes::Plan::CannotChat { fields } => return (Some(Err(lanes::cannot_chat(&fields))), None),
        lanes::Plan::Chat { explicit, reason } => (explicit, reason),
    };
    if let Some(why) = routed {
        reason = why;
    }
    let Some(agent) = agent else {
        return (Some(Err(err("INVALID_ARGUMENT", "agent_type is required with lane: \"acp\"", false))), None);
    };
    // An id that is no agent at all: the ids that can be asked for. (The terminal says UNKNOWN_AGENT_TYPE.)
    if explicit && config.is_none() && !crate::tui::is_registered(&agent) {
        return (Some(Err(lanes::unknown_agent(&agent, &chat_agent_ids()))), None);
    }
    if explicit && !labs_on {
        return (Some(Err(lanes::acp_off())), None);
    }
    let Some(task) = task else { return (Some(Err(err("INVALID_TASK", "task is required", false))), None) };
    // Whether a failure to start gives the terminal a go (auto and the saved choice), or is the caller's error (lane: "acp").
    let fallback = !explicit;
    let folder = text_of(&value, "project_path").or_else(|| query.trim_start_matches('?').split('&').find_map(|p| p.strip_prefix("project_path=").map(str::to_string))).unwrap_or_else(|| deps.registry.lock().project_path.clone());
    let folder = std::path::PathBuf::from(folder);
    // Checks are validated before anything starts: a bad check is the caller's mistake, never a reason for the terminal.
    let checks = match checks_of(&value, &folder) {
        Ok(checks) => checks,
        Err(e) => return (Some(Err(e)), None),
    };
    // The plan already decided on a chat, so the gate left is the Labs switch and a definition. (`start_gated` would
    // read the agent's saved choice again, which is the terminal when nothing is saved, and refuse auto's choice.)
    let started = match super::start::check_gate(labs_on, config.is_some(), crate::acp::lane::RunLane::Acp, true) {
        Err(gate) => Err(gate.into()),
        Ok(()) => match config {
            Some(cfg) => super::start::start(deps, cfg, StartRequest { agent_id: agent, folder: folder.clone(), explicit: true, account: account.clone() }),
            None => Err(super::start::GateError::NoDefinition.into()),
        },
    };
    let chat = match started {
        Ok(chat) => chat,
        // Not the caller's mistake and the terminal can run it: once, the terminal way runs the task.
        Err(error) if fallback && error.fallback => return (None, Some(lanes::LaneNote::fell_back(error.code, &error.message))),
        Err(error) => {
            let mut e = err(error.code, error.message.clone(), error.fallback);
            e.context = if error.fallback {
                json!({ "fallback": "terminal", "hint": "Retry with lane: \"terminal\" to run it in a terminal." })
            } else {
                json!({ "fix": error.message })
            };
            return (Some(Err(e)), None);
        }
    };
    chat.set_started_by(session);
    // The model and effort the caller asked for, applied before the first message. A request the
    // agent cannot honour is an error (explicit lane) or the terminal way (the saved choice); it
    // never quietly runs on another model.
    let model = text_of(&value, "model");
    let reasoning = text_of(&value, "reasoning");
    if model.is_some() || reasoning.is_some() {
        if let Err(choice) = chat.apply_choices(model.as_deref(), reasoning.as_deref()) {
            abandon_chat(deps, &chat);
            if fallback {
                return (None, Some(lanes::LaneNote::fell_back(choice.code, &choice.message)));
            }
            let mut e = err(choice.code, choice.message, true);
            e.context = json!({ "fallback": "terminal", "hint": "The terminal way can run a requested model. Retry with lane: \"terminal\"." });
            return (Some(Err(e)), None);
        }
    }
    // Nested under the pane of the agent that asked for it, exactly like a terminal helper. The
    // pane id the session's tool server sends is a hint; the process tree confirms it.
    crate::bridge::pane_util::note_pane_parent(
        &deps.registry,
        session,
        crate::pty::pane_parent::request_caller().as_deref(),
        chat.pane_id(),
    );
    let parent = deps.registry.lock().panes.get(chat.pane_id()).and_then(|p| p.info.parent_pane_id.clone());
    chat.persist_link(session, parent.as_deref());
    deps.host.panes_changed();
    deps.host.state_changed(chat.pane_id(), &chat.state());
    // Which lane and why (and the account) stay with the chat, so inspect_agent and wait_agents still say it.
    let mut kept = lanes::LaneNote::acp(&reason).to_value();
    if let (Some(account), Some(map)) = (&account, kept.as_object_mut()) {
        map.insert("account".into(), json!(account));
    }
    chat.set_lane_note(kept);
    // What the run asked for, kept for its receipt and its checks.
    chat.set_run_meta(super::receipt::RunMeta {
        folder: Some(folder),
        checks,
        requested_model: model.clone(),
        account: account.clone(),
        account_source: text_of(&value, "account_source"),
        ..Default::default()
    });
    if let Some(key) = &key {
        remember_chat(session, key, chat.pane_id());
    }
    if let Err(error) = chat.send(&task) {
        return (Some(Err(send_failure(error))), None);
    }
    let background = value.get("background").and_then(Value::as_bool).unwrap_or(false);
    if !background {
        let wait_ms = match wait_ms_of(&value, DEFAULT_WAIT_MS) {
            Ok(ms) => ms,
            Err(e) => return (Some(Err(e)), None),
        };
        wait_status(&chat, &default_until(), wait_ms);
    }
    (Some(Ok(view(&chat))), None)
}

fn wait(body: &[u8]) -> Option<Reply> {
    let value = body_json(body)?;
    let handles: Vec<String> = value.get("handles")?.as_array()?.iter().filter_map(Value::as_str).map(str::to_string).collect();
    let chats: Vec<Option<std::sync::Arc<AcpChat>>> = handles.iter().map(|h| chat_of(h)).collect();
    if !chats.iter().any(Option::is_some) {
        return None;
    }
    if chats.iter().any(Option::is_none) {
        return Some(Err(err(
            "MIXED_HANDLES",
            "These handles are a mix of chat sessions and terminal runs. Call wait_agents once for the chat sessions and once for the others.",
            false,
        )));
    }
    let chats: Vec<_> = chats.into_iter().flatten().collect();
    let until = until_of(&value);
    let wait_all = value.get("mode").and_then(Value::as_str) == Some("all");
    if value.get("mode").and_then(Value::as_str).is_some_and(|m| !matches!(m, "all" | "any")) {
        return Some(Err(err("INVALID_WAIT_MODE", "mode must be 'any' or 'all'", false)));
    }
    let wait_ms = match wait_ms_of(&value, DEFAULT_WAIT_MS) {
        Ok(ms) => ms,
        Err(e) => return Some(Err(e)),
    };
    let confirm_ms = match confirm_prompt_ms_of(&value) {
        Ok(ms) => ms,
        Err(e) => return Some(Err(e)),
    };
    // A completed turn does not mean the work is done when the adapter reports background tasks
    // still running. Callers that want the old turn-only answer pass wait_for_background: false.
    let wait_for_background = value.get("wait_for_background").and_then(Value::as_bool).unwrap_or(true);
    #[derive(Clone, Default)]
    struct PromptClock {
        key: Option<(u64, u64)>,
        since: Option<Instant>,
    }
    let mut clocks = vec![PromptClock::default(); chats.len()];
    // Background work that just drained: wait a short, quiet window before calling the chat done, so a follow-up
    // turn the adapter is about to start is not missed.
    let mut settle: Vec<Option<Instant>> = vec![None; chats.len()];
    let mut settle_items: Vec<usize> = chats.iter().map(|c| c.item_count()).collect();
    let mut saw_background = vec![false; chats.len()];
    let started = Instant::now();
    let deadline = started + Duration::from_millis(wait_ms);
    // Every exit from this loop is a `break` that sets `reason` first, so no initial value is needed.
    let reason;
    loop {
        let now = Instant::now();
        let mut hits = 0usize;
        for (i, chat) in chats.iter().enumerate() {
            let snapshot = chat.session().snapshot();
            let status = status_of(&snapshot);
            let closed = chat.is_closed();
            let background_running = snapshot.background_tasks.iter().any(|t| t.is_running());
            if background_running {
                saw_background[i] = true;
                settle[i] = None;
            } else if saw_background[i] {
                // A reply (or a notice) that is still arriving restarts the quiet window, so a streamed answer is
                // not cut in half.
                let items = chat.item_count();
                if settle[i].is_none() || settle_items[i] != items {
                    settle[i] = Some(now);
                    settle_items[i] = items;
                }
            } else {
                settle[i] = None;
            }
            let mut hit = closed || until.iter().any(|u| u == status);
            if hit && !closed && status == "waiting_input" && confirm_ms > 0 {
                let key = snapshot.permission_waits.first().map(|p| (p.ask_id, p.since_ms));
                match key {
                    Some(key) => {
                        if clocks[i].key != Some(key) {
                            clocks[i] = PromptClock { key: Some(key), since: Some(now) };
                        }
                        let stable = clocks[i].since.is_some_and(|since| now.duration_since(since) >= Duration::from_millis(confirm_ms));
                        hit = stable;
                    }
                    None => {
                        clocks[i] = PromptClock::default();
                        hit = false;
                    }
                }
            } else if !closed {
                clocks[i] = PromptClock::default();
            }
            if hit && !closed && is_final(status) && wait_for_background {
                if background_running {
                    hit = false;
                } else if settle[i].is_some_and(|since| now.duration_since(since) < BACKGROUND_SETTLE) {
                    hit = false;
                }
            }
            if hit {
                hits += 1;
            }
        }
        if (wait_all && hits == chats.len()) || (!wait_all && hits > 0) {
            reason = wait_reasons::MATCHED_STATE;
            break;
        }
        if now >= deadline {
            reason = if chats.iter().any(|c| c.session().snapshot().background_tasks.iter().any(|t| t.is_running())) {
                wait_reasons::BACKGROUND
            } else {
                wait_reasons::TIMEOUT
            };
            break;
        }
        std::thread::sleep(POLL);
    }
    let agents: Vec<Value> = chats.iter().map(|c| view(c)).collect();
    Some(Ok(json!({
        "agents": agents,
        "reason": reason,
        "mode": if wait_all { "all" } else { "any" },
        "waited_ms": started.elapsed().as_millis() as u64,
        "requested_wait_ms": wait_ms,
    })))
}

/// `followup_task` (`next_turn`: a new turn, then waits like a first run) and `send_message` (steers the turn that
/// runs).
fn followup(chat: &AcpChat, value: &Value, session: Option<&str>, next_turn: bool) -> Reply {
    owned(chat, session)?;
    let task = text_of(value, "task").or_else(|| text_of(value, "message")).ok_or_else(|| err("INVALID_TASK", "task is required", false))?;
    if chat.is_closed() {
        return Err(err("AGENT_CLOSED", "That chat session was closed.", false));
    }
    let model = text_of(value, "model");
    let reasoning = text_of(value, "reasoning");
    if model.is_some() || reasoning.is_some() {
        chat.apply_choices(model.as_deref(), reasoning.as_deref()).map_err(|choice| err(choice.code, choice.message, true))?;
        if model.is_some() {
            chat.note_requested_model(model.clone());
        }
    }
    // New checks replace the run's checks from this turn on; none named keeps the old ones.
    if next_turn && value.get("checks").is_some_and(|v| !v.is_null()) {
        let folder = chat.run_folder().ok_or_else(|| err("INVALID_ARGUMENT", "checks need the folder of the run, which this chat does not have", false))?;
        let checks = checks_of(value, &folder)?;
        chat.replace_checks(checks);
    }
    if next_turn {
        match chat.send(&task) {
            Ok(_) => {}
            Err(SendError::Busy) => return Err(send_failure(SendError::Busy)),
            Err(other) => return Err(send_failure(other)),
        }
        let wait_ms = wait_ms_of(value, DEFAULT_WAIT_MS)?;
        if value.get("background").and_then(Value::as_bool) != Some(true) {
            wait_status(chat, &default_until(), wait_ms);
        }
    } else if chat.readiness() == Readiness::Ready {
        // Nothing runs: a message is a new turn.
        chat.send(&task).map_err(send_failure)?;
    } else {
        match chat.steer(&task) {
            Some(Ok(())) => {}
            Some(Err(why)) => return Err(err("STEER_FAILED", why, true)),
            None => return Err(err("STEER_UNSUPPORTED", "This agent cannot take a message while it works. Wait for the turn to end, then followup_task.", true)),
        }
    }
    Ok(view(chat))
}

fn answer(chat: &AcpChat, value: &Value, session: Option<&str>) -> Reply {
    owned(chat, session)?;
    let prompt = text_of(value, "prompt_id").ok_or_else(|| err("INVALID_ARGUMENT", "answer_prompt needs prompt_id", false))?;
    let choice = text_of(value, "choice").ok_or_else(|| err("INVALID_ARGUMENT", "answer_prompt needs choice", false))?;
    match chat.answer_for_agent(&prompt, &choice, who(session)) {
        Ok(name) => {
            let mut done = view(chat);
            if let Some(map) = done.as_object_mut() {
                map.insert("answered".into(), json!({ "prompt_id": prompt, "choice": choice, "name": name }));
            }
            Ok(done)
        }
        Err(AgentAnswerError::NotAllowed) => Err(err(
            "AGENT_ANSWER_NOT_ALLOWED",
            "The person has not let agents answer questions in this chat session, so only they can. Nothing was answered. Tell them what you need (ask_user) and wait; do not retry in a loop.",
            false,
        )),
        Err(AgentAnswerError::NoSuchQuestion) => Err(err("NO_OPEN_QUESTION", "That question is not open any more (it was answered, or the agent stopped asking). Read the chat again.", true)),
        Err(AgentAnswerError::BadChoice(offered)) => {
            let mut e = err("INVALID_CHOICE", format!("{choice:?} is not one of the options the agent offered"), true);
            e.context = json!({ "options": offered });
            Err(e)
        }
        Err(AgentAnswerError::Closed) => Err(err("AGENT_CLOSED", "That chat session was closed.", false)),
        Err(AgentAnswerError::Failed(why)) => Err(err("ANSWER_FAILED", why, true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_statuses_end_a_wait_and_running_ones_do_not() {
        for status in ["completed", "failed", "cancelled"] {
            assert!(is_final(status));
        }
        for status in ["running", "waiting_input", "idle"] {
            assert!(!is_final(status));
        }
    }

    #[test]
    fn a_prompt_names_the_options_and_who_may_answer() {
        let state = json!({
            "agentAnswering": false,
            "permissions": [{ "askId": 3, "questionId": "q1", "title": "Write notes.txt", "toolKind": "edit", "options": [{ "id": "allow_once", "name": "Allow Once", "kind": "allow_once" }] }]
        });
        let prompt = prompt_of(&state);
        assert_eq!(prompt["prompt_id"], "q1");
        assert_eq!(prompt["options"][0]["id"], "allow_once");
        assert_eq!(prompt["answerable_by_agent"], false);
        assert_eq!(prompt_of(&json!({ "permissions": [] })), Value::Null);
    }
}
