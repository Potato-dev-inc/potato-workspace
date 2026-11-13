//! The free hello of the add-agent ladder (night 2026-11-13, contract 2.3 step 4).
//!
//! One child, in a fresh temp folder, with the environment of `acp_check::check_env` (no secret passes) plus the
//! fixed variables the agent's own table names. Exactly two requests are ever written: `initialize`, then
//! `session/new` (`mcpServers: []`). Never `session/prompt`. The child's whole process tree is stopped at the end,
//! on a timeout and when the cancel flag is set. Output read is capped at 1 MB.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::acp::handshake::{parse_initialize, parse_session_info, AgentCaps as InitCaps, SessionInfo};

use super::acp_check::{check_env, initialize_line};
use super::exec::{cut_chars, kill_tree, mask_private};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_LINES: usize = 500;
/// How often the wait loops look at the cancel flag.
const TICK: Duration = Duration::from_millis(50);

/// What to start and how long each answer may take.
pub struct HelloSpec<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    /// Fixed variables from the agent's own table (never a secret passed through from the app).
    pub extra_env: &'a [(String, String)],
    pub init_timeout: Duration,
    pub new_timeout: Duration,
    pub cancel: &'a AtomicBool,
    /// Told the child's PID (tests use it to see the process is gone).
    pub on_start: &'a (dyn Fn(u32) + Sync),
}

/// How `session/new` went. An agent that wants a sign-in first is not a failure.
#[derive(Debug, Clone, PartialEq)]
pub enum NewOutcome {
    /// Answered; the raw `result` is kept so models can be read from it.
    Answered(Value),
    AuthNeeded,
    /// An error that is not a sign-in question. Nothing is learned from it.
    Refused,
}

#[derive(Debug, Clone)]
pub struct Hello {
    pub init: InitCaps,
    pub new: NewOutcome,
    /// Every request line ever written. May only hold `initialize` and `session/new`.
    pub requests_sent: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HelloError {
    /// No reply in time (or the program ended without one).
    Silent,
    /// A reply that is not an `initialize` result, or the wrong protocol. The text is for Details only.
    Bad(String),
    Cancelled,
}

enum Event {
    Line(Vec<u8>),
    Overflow,
    Done,
}

fn fresh_dir() -> Option<PathBuf> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("pm-add-hello-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn read_lines(stdout: ChildStdout, tx: mpsc::Sender<Event>) {
    let mut reader = BufReader::new(stdout.take(MAX_BYTES as u64 + 1));
    let (mut total, mut lines) = (0usize, 0usize);
    loop {
        let mut line = Vec::new();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                lines += 1;
                if total > MAX_BYTES || lines > MAX_LINES {
                    let _ = tx.send(Event::Overflow);
                    return;
                }
                if tx.send(Event::Line(line)).is_err() {
                    return;
                }
            }
        }
    }
    let _ = tx.send(Event::Done);
}

/// The request line for `session/new`: the temp folder as `cwd`, no tool servers.
fn session_new_line(cwd: &Path) -> String {
    let request = json!({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": cwd.to_string_lossy(), "mcpServers": []}});
    format!("{request}\n")
}

/// A reply to our request `id` (a `result` or an `error`); anything else is noise.
fn reply_to(bytes: &[u8], id: u64) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let ours = value.get("id") == Some(&json!(id)) && (value.get("result").is_some() || value.get("error").is_some());
    ours.then_some(value)
}

fn wait_reply(rx: &mpsc::Receiver<Event>, id: u64, timeout: Duration, cancel: &AtomicBool) -> Result<Value, HelloError> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(HelloError::Cancelled);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(HelloError::Silent);
        }
        match rx.recv_timeout(left.min(TICK)) {
            Ok(Event::Line(bytes)) => {
                if let Some(reply) = reply_to(&bytes, id) {
                    return Ok(reply);
                }
            }
            Ok(Event::Overflow) => return Err(HelloError::Bad("too much output and no reply".into())),
            Ok(Event::Done) | Err(RecvTimeoutError::Disconnected) => return Err(HelloError::Silent),
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// Text that says the agent wants a sign-in before it opens a session.
fn is_sign_in_error(error: &Value) -> bool {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let code = error.get("code").and_then(Value::as_i64);
    code == Some(-32000)
        || ["auth", "sign in", "sign-in", "log in", "login", "credential", "api key", "unauthorized"].iter().any(|w| message.contains(w))
}

/// Start the program, say `initialize`, then `session/new`; stop the tree. See the module doc for the guarantees.
pub fn hello(spec: &HelloSpec<'_>) -> Result<Hello, HelloError> {
    let Some(home) = fresh_dir() else { return Err(HelloError::Silent) };
    let verdict = run(spec, &home);
    let _ = std::fs::remove_dir_all(&home);
    verdict
}

fn run(spec: &HelloSpec<'_>, home: &Path) -> Result<Hello, HelloError> {
    let mut cmd = crate::proc_util::hidden_command(spec.program);
    let mut env = check_env(home);
    for (k, v) in spec.extra_env {
        env.retain(|(name, _)| !name.eq_ignore_ascii_case(k));
        env.push((k.clone(), v.clone()));
    }
    cmd.args(spec.args).current_dir(home).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| HelloError::Silent)?;
    (spec.on_start)(child.id());
    let (tx, rx) = mpsc::channel::<Event>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || read_lines(stdout, tx));
    }
    let mut stdin = child.stdin.take();
    let verdict = talk(spec, home, &rx, &mut stdin);
    drop(stdin);
    stop(&mut child);
    verdict
}

fn stop(child: &mut Child) {
    kill_tree(child);
    let _ = child.wait();
}

fn send(stdin: &mut Option<std::process::ChildStdin>, line: &str) -> bool {
    match stdin.as_mut() {
        Some(pipe) => pipe.write_all(line.as_bytes()).and_then(|()| pipe.flush()).is_ok(),
        None => false,
    }
}

fn talk(spec: &HelloSpec<'_>, home: &Path, rx: &mpsc::Receiver<Event>, stdin: &mut Option<std::process::ChildStdin>) -> Result<Hello, HelloError> {
    let mut requests_sent: Vec<String> = Vec::new();
    requests_sent.push("initialize".into());
    if !send(stdin, &initialize_line()) {
        return Err(HelloError::Silent);
    }
    let reply = wait_reply(rx, 1, spec.init_timeout, spec.cancel)?;
    let Some(result) = reply.get("result") else {
        return Err(HelloError::Bad("the reply to initialize was an error".into()));
    };
    let init = parse_initialize(result).map_err(|e| HelloError::Bad(cut_chars(&mask_private(&e.to_string()), 160)))?;

    requests_sent.push("session/new".into());
    // A program that closed its input after `initialize` cannot answer: that is silence.
    if !send(stdin, &session_new_line(home)) {
        return Err(HelloError::Silent);
    }
    let reply = wait_reply(rx, 2, spec.new_timeout, spec.cancel)?;
    let new = match (reply.get("result"), reply.get("error")) {
        (Some(result), _) => NewOutcome::Answered(result.clone()),
        (None, Some(error)) if is_sign_in_error(error) => NewOutcome::AuthNeeded,
        _ => NewOutcome::Refused,
    };
    Ok(Hello { init, new, requests_sent })
}

/// The models a `session/new` answer lists, as the agent gave them: the `model` config option's choices, else
/// `models.availableModels`. `(first MAX, full count)`; `None` when the answer lists no model at all.
pub fn models_of(result: &Value, max: usize) -> Option<(Vec<String>, u32)> {
    let info: SessionInfo = parse_session_info(result);
    let mut all: Vec<String> = Vec::new();
    for option in &info.config_options {
        let is_model = option.get("category").and_then(Value::as_str) == Some("model") || option.get("id").and_then(Value::as_str) == Some("model");
        if !is_model {
            continue;
        }
        collect_choices(option.get("options"), &mut all);
    }
    if all.is_empty() {
        if let Some(list) = result.pointer("/models/availableModels").and_then(Value::as_array) {
            all.extend(list.iter().filter_map(|m| m.get("modelId").or_else(|| m.get("id")).and_then(Value::as_str)).map(str::to_string));
        }
    }
    if all.is_empty() {
        return None;
    }
    let total = all.len() as u32;
    all.truncate(max);
    Some((all.into_iter().map(|m| cut_chars(&mask_private(&m), 120)).collect(), total))
}

/// Choices are `{value, name}` items, or groups `{group, options: [...]}`.
fn collect_choices(options: Option<&Value>, out: &mut Vec<String>) {
    let Some(list) = options.and_then(Value::as_array) else { return };
    for item in list {
        if let Some(inner) = item.get("options") {
            collect_choices(Some(inner), out);
        } else if let Some(value) = item.get("value").and_then(Value::as_str) {
            out.push(value.to_string());
        }
    }
}

/// Does the answer to `session/new` say anything about models? (`model_pick` No needs a real answer with neither.)
pub fn answered_without_models(result: &Value) -> bool {
    models_of(result, 1).is_none()
}
