//! `/terminals/*`: the agent background terminal tools (`start_terminal`, `read_terminal`, `wait_terminal`,
//! `stop_terminal`; logic in `crate::agent_terminals`).
//!
//! Who may call: an agent on THIS computer that runs in one of Potato Workspace's own panes (a chat or a terminal agent).
//! The pane is found as `show_artifact` finds it: the pane the MCP connection says it runs in, else the pane the
//! connection's process verifiably lives in. A phone, a forwarded request and a caller with no pane are refused.
//! An agent reads and stops its own terminals and those of the agents below it (its minions), never anyone else's.
//! Starting asks the person (`agent_authority::terminal_gate`): the first start in a chat, and every dangerous command.

use super::{Ctx, RouteResult};
use crate::agent_authority::terminal_gate;
use crate::agent_terminals::{self as terms, Cmd, Reason, StartRequest, Until};
use crate::mobile_pairing::Caller;
use crate::operations::OperationError;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// How long a start waits for the person's Allow before it answers "ask again in a moment".
const ALLOW_WAIT: Duration = Duration::from_secs(60);
const ALLOW_POLL: Duration = Duration::from_millis(500);

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(cx.segments);
    let ["terminals", op] = segments else { return None };
    if cx.method != "POST" || !matches!(*op, "start" | "read" | "wait" | "stop") {
        return None;
    }
    Some(run(cx, op))
}

fn refuse(status: u16, code: &str, message: &str) -> (u16, Value) {
    (status, json!({ "code": code, "error": message, "message": message, "recoverable": false, "context": {} }))
}

fn failed(error: OperationError) -> (u16, Value) {
    let status = match error.code.as_str() {
        "INVALID_ARGUMENT" | "INVALID_CWD" | "CWD_OUTSIDE_PROJECT" => 400,
        "TERMINAL_NOT_FOUND" => 404,
        "NOT_YOUR_TERMINAL" | "CONSENT_DENIED" => 403,
        "TOO_MANY_TERMINALS" => 429,
        "CONSENT_PENDING" => 409,
        "TERMINAL_START_FAILED" => 500,
        _ => return crate::bridge::errors::operation_http_error(error),
    };
    let mut body = json!({ "error": error.message, "message": error.message, "code": error.code, "recoverable": error.recoverable, "context": error.context });
    if let Some(ms) = error.retry_after_ms {
        body["retry_after_ms"] = json!(ms);
    }
    (status, body)
}

/// The pane of the agent that asks: named by its connection, else proven by its process.
fn caller_pane(cx: &Ctx) -> Option<String> {
    let claimed = cx.session.and_then(crate::mcp_sessions::claimed_session_pane).or_else(crate::pty::pane_parent::request_caller);
    let exists = |p: &String| cx.registry.lock().get(p).is_some();
    claimed.filter(exists).or_else(|| {
        crate::companion::peer::caller_pane(cx.registry, &crate::companion::peer::SystemTcp, &crate::pty::agent_proc::snapshot, cx.peer).filter(exists)
    })
}

struct PaneFacts {
    project: std::path::PathBuf,
    agent_label: String,
    minion: bool,
    parent: Option<String>,
}

fn facts_of(cx: &Ctx, pane: &str) -> Option<PaneFacts> {
    let registry = cx.registry.lock();
    let p = registry.get(pane)?;
    Some(PaneFacts {
        project: std::path::PathBuf::from(&p.info.cwd),
        agent_label: crate::agent_authority::gate::agent_label_of(&p.info.agent_type),
        minion: p.info.started_as.as_deref() == Some("minion"),
        parent: p.info.parent_pane_id.clone(),
    })
}

fn parent_of(cx: &Ctx, pane: &str) -> Option<String> {
    cx.registry.lock().get(pane).and_then(|p| p.info.parent_pane_id.clone())
}

fn run(cx: &Ctx, op: &str) -> RouteResult {
    if !matches!(crate::mobile_pairing::authorize_caller(cx.headers, cx.peer_loopback, cx.segments, cx.method), Ok(Caller::Local)) {
        return Err(refuse(403, "TERMINALS_LOCAL_ONLY", "Background terminals are for an agent on this computer. A phone cannot use them."));
    }
    let Some(pane) = caller_pane(cx) else {
        return Err(refuse(400, "NO_PANE", "Background terminals work for an agent that runs in a Potato Workspace chat or terminal. This caller is not in one."));
    };
    let body = &cx.request_body;
    match op {
        "start" => start(cx, &pane, body),
        "read" => read(cx, &pane, body),
        "wait" => wait(cx, &pane, body),
        _ => stop(cx, &pane, body),
    }
}

fn command_of(body: &Value) -> Result<Cmd, OperationError> {
    match body.get("command") {
        Some(Value::String(line)) if !line.trim().is_empty() => Ok(Cmd::Line(line.clone())),
        Some(Value::Array(parts)) if !parts.is_empty() && parts.iter().all(Value::is_string) => Ok(Cmd::Argv(parts.iter().filter_map(Value::as_str).map(str::to_string).collect())),
        _ => Err(OperationError::new("INVALID_ARGUMENT", "command is required: one command line, or a list with the program and its arguments.", false)),
    }
}

fn start(cx: &Ctx, pane: &str, body: &Value) -> RouteResult {
    let command = command_of(body).map_err(failed)?;
    let facts = facts_of(cx, pane).ok_or_else(|| refuse(404, "PANE_NOT_FOUND", "Your chat is not open any more."))?;
    let name = body.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
    let shown = crate::redact::text(&command.display()).into_inner();
    // The chat whose grant counts: a minion uses the chat it belongs to.
    let mut chat = pane.to_string();
    let mut requester = facts.agent_label.clone();
    if facts.minion {
        if let Some(parent) = facts.parent.as_deref() {
            chat = parent.to_string();
            requester = format!("A minion of {}", facts_of(cx, parent).map_or_else(|| "its chat".to_string(), |f| f.agent_label));
        }
    }
    let target = name.clone().unwrap_or_else(|| terms::program_of(&shown));
    let session = cx.session.unwrap_or("local:terminal");
    let request = terminal_gate::Request { session, caller: pane, chat: &chat, requester, target, command: &shown, project: &facts.project };
    let began = Instant::now();
    loop {
        match terminal_gate::check(&request, crate::questions::now_ms()) {
            Ok(()) => break,
            Err(e) if e.code == "CONSENT_PENDING" && began.elapsed() < ALLOW_WAIT => std::thread::sleep(ALLOW_POLL),
            Err(e) => return Err(failed(e)),
        }
    }
    let term = terms::manager()
        .start(StartRequest { owner: pane.to_string(), project: facts.project, command, cwd: body.get("cwd").and_then(Value::as_str).map(str::to_string), name })
        .map_err(failed)?;
    let mut answer = terms::view(&term, terms::DEFAULT_READ_LINES);
    let wait_for = body.get("wait_for").and_then(Value::as_str).map(str::trim).filter(|w| !w.is_empty());
    if let Some(text) = wait_for {
        let ms = body.get("wait_ms").and_then(Value::as_u64).unwrap_or(30_000).min(terms::MAX_START_WAIT_MS);
        let outcome = terms::manager().wait(&term, &Until::Line(text.to_string()), 0, Duration::from_millis(ms));
        answer = terms::view(&term, terms::DEFAULT_READ_LINES);
        answer["matched"] = json!(outcome.reason == Reason::Line);
        if let Some(line) = outcome.matched.filter(|_| outcome.reason == Reason::Line) {
            answer["matched_line"] = json!(line);
        }
        if outcome.reason == Reason::Exit {
            answer["ended_before_match"] = json!(true);
        }
    }
    Ok((200, answer))
}

/// The terminal `id` when `pane` may use it.
fn terminal_for(cx: &Ctx, pane: &str, body: &Value) -> Result<std::sync::Arc<terms::Terminal>, (u16, Value)> {
    let id = body.get("terminal_id").and_then(Value::as_str).map(str::trim).filter(|i| !i.is_empty());
    let Some(id) = id else {
        return Err(failed(OperationError::new("INVALID_ARGUMENT", "terminal_id is required.", false)));
    };
    let term = terms::manager().get(id).ok_or_else(|| failed(OperationError::new("TERMINAL_NOT_FOUND", "There is no such terminal (it may have ended more than 10 minutes ago). read_terminal without terminal_id lists yours.", false)))?;
    if !terms::may_use(pane, &term, &|p| parent_of(cx, p)) {
        return Err(failed(OperationError::new("NOT_YOUR_TERMINAL", "That terminal belongs to another agent.", false)));
    }
    Ok(term)
}

fn read(cx: &Ctx, pane: &str, body: &Value) -> RouteResult {
    if body.get("terminal_id").and_then(Value::as_str).is_none_or(|i| i.trim().is_empty()) {
        // The list: this agent's terminals and those below it.
        let mine: Vec<Value> = terms::manager().all().iter().filter(|t| terms::may_use(pane, t, &|p| parent_of(cx, p))).map(|t| terms::view(t, 5)).collect();
        return Ok((200, json!({ "terminals": mine })));
    }
    let term = terminal_for(cx, pane, body)?;
    let after = body.get("after_cursor").and_then(Value::as_u64).unwrap_or(0);
    let max = body.get("max_lines").and_then(Value::as_u64).map_or(terms::DEFAULT_READ_LINES, |m| m.clamp(1, 2000) as usize);
    Ok((200, terms::read_view(&term, after, max)))
}

fn until_of(body: &Value) -> Result<Until, OperationError> {
    let bad = || OperationError::new("INVALID_ARGUMENT", "until must be \"exit\", {line: \"text or regex\"} or {port: true | number}.", false);
    match body.get("until") {
        Some(Value::String(s)) if s == "exit" => Ok(Until::Exit),
        Some(Value::Object(map)) => {
            if let Some(line) = map.get("line").and_then(Value::as_str).filter(|l| !l.is_empty()) {
                Ok(Until::Line(line.to_string()))
            } else if let Some(port) = map.get("port") {
                match port {
                    Value::Bool(true) => Ok(Until::Port(None)),
                    Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()).map(|p| Until::Port(Some(p))).ok_or_else(bad),
                    _ => Err(bad()),
                }
            } else if map.get("exit").and_then(Value::as_bool) == Some(true) {
                Ok(Until::Exit)
            } else {
                Err(bad())
            }
        }
        _ => Err(bad()),
    }
}

fn wait(cx: &Ctx, pane: &str, body: &Value) -> RouteResult {
    let term = terminal_for(cx, pane, body)?;
    let until = until_of(body).map_err(failed)?;
    let after = body.get("after_cursor").and_then(Value::as_u64).unwrap_or(0);
    let ms = body.get("timeout_ms").and_then(Value::as_u64).unwrap_or(60_000).min(terms::MAX_WAIT_SLICE_MS);
    let outcome = terms::manager().wait(&term, &until, after, Duration::from_millis(ms));
    let read = term.read(after, terms::DEFAULT_READ_LINES);
    let mut answer = json!({
        "terminal_id": term.id,
        "reason": outcome.reason.as_str(),
        "state": term.state().as_str(),
        "lines": read.lines,
        "next_cursor": read.next_cursor,
        "ports": term.ports(),
    });
    if let Some(partial) = read.partial {
        answer["partial_line"] = json!(partial);
    }
    if let Some(matched) = outcome.matched {
        answer["matched"] = json!(matched);
    }
    if let Some(code) = term.exit_code() {
        answer["exit_code"] = json!(code);
    }
    if let Some(by) = term.stopped_by() {
        answer["stopped_by"] = json!(by);
    }
    Ok((200, answer))
}

fn stop(cx: &Ctx, pane: &str, body: &Value) -> RouteResult {
    let term = terminal_for(cx, pane, body)?;
    terms::manager().stop(&term.id, "the agent");
    // The stop is by the job object: it takes effect at once; give the waiter a moment to record how it ended.
    let began = Instant::now();
    while term.is_running() && began.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok((200, json!({ "terminal_id": term.id, "state": if term.is_running() { "stopping" } else { "stopped" } })))
}
