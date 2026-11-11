//! The ACP check (SPEC 12): start the program once and send ONE JSON-RPC `initialize` request, then read the reply.
//! Help text is not proof. This never sends `session/new` or `session/prompt`, never sends a second request, and
//! stops the child (its own process tree, by PID) when the answer is in, on a timeout, or on an early exit.
//!
//! The child runs in a fresh empty folder with `env_clear`: only what it needs to start (PATH and the Windows
//! system variables) plus home-style folders that point inside that folder. No API key or other secret passes.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdout, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::exec::{cut_chars, kill_tree, mask_private};

/// How long the reply may take. A slow-starting agent gets the whole of it.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
/// Most bytes read from the child's stdout, all lines together.
const MAX_BYTES: usize = 1024 * 1024;
/// Most lines read from the child's stdout before a reply.
const MAX_LINES: usize = 500;
const MAX_NAME_CHARS: usize = 80;

/// What the check found. `ok` only when the reply is an `initialize` result with a numeric `protocolVersion`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InitCheck {
    pub ok: bool,
    pub protocol_version: Option<u64>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    /// Short plain English; `None` when `ok`.
    pub reason: Option<String>,
}

impl InitCheck {
    fn failed(reason: impl Into<String>) -> Self {
        Self { ok: false, reason: Some(reason.into()), ..Self::default() }
    }

    /// The JSON the app shows: `{ok, protocol_version, agent_name, agent_version, reason}`.
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "protocol_version": self.protocol_version,
            "agent_name": self.agent_name,
            "agent_version": self.agent_version,
            "reason": self.reason,
        })
    }
}

enum Event {
    Line(Vec<u8>),
    Overflow,
    Done,
}

/// The one request this check ever sends (a newline-ended JSON-RPC line).
pub fn initialize_line() -> String {
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {"name": "potato-workspace", "title": "Potato Workspace", "version": crate::app_lifecycle::app_version()},
        },
    });
    format!("{request}\n")
}

/// The only environment the child gets. Fixed names, no secret: home-style folders point into `home`.
pub fn check_env(home: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"] {
        if let Some(v) = std::env::var_os(key) {
            out.push((key.to_string(), v.to_string_lossy().into_owned()));
        }
    }
    let here = home.display().to_string();
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
    ] {
        out.push((key.to_string(), here.clone()));
    }
    out
}

/// Start `program args`, send one `initialize`, wait up to `timeout` for the reply, then stop the child's tree.
pub fn check_initialize(program: &Path, args: &[String], timeout: Duration) -> InitCheck {
    check_observed(program, args, timeout, &mut |_| {})
}

/// `check_initialize`, telling `on_start` the child's PID (tests use it to see the process is really gone).
pub(crate) fn check_observed(program: &Path, args: &[String], timeout: Duration, on_start: &mut dyn FnMut(u32)) -> InitCheck {
    let Some(home) = fresh_dir() else { return InitCheck::failed("could not start") };
    let verdict = run_once(program, args, timeout, &home, on_start);
    let _ = std::fs::remove_dir_all(&home);
    verdict
}

fn fresh_dir() -> Option<PathBuf> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("pm-acp-check-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn run_once(program: &Path, args: &[String], timeout: Duration, home: &Path, on_start: &mut dyn FnMut(u32)) -> InitCheck {
    let mut cmd = crate::proc_util::hidden_command(program);
    cmd.args(args)
        .current_dir(home)
        .env_clear()
        .envs(check_env(home))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return InitCheck::failed("could not start"),
    };
    on_start(child.id());
    let (tx, rx) = mpsc::channel::<Event>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || read_lines(stdout, tx));
    }
    let mut stdin = child.stdin.take();
    if let Some(pipe) = stdin.as_mut() {
        let _ = pipe.write_all(initialize_line().as_bytes());
        let _ = pipe.flush();
    }
    let verdict = wait_for_reply(&rx, timeout);
    drop(stdin);
    kill_tree(&mut child);
    let _ = child.wait();
    verdict
}

/// Reads stdout on its own thread, at most `MAX_BYTES` and `MAX_LINES`, so a silent or noisy child cannot block us.
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

fn wait_for_reply(rx: &mpsc::Receiver<Event>, timeout: Duration) -> InitCheck {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Event::Line(bytes)) => {
                if let Some(reply) = reply_of(&bytes) {
                    return verdict(&reply);
                }
            }
            Ok(Event::Overflow) => return InitCheck::failed("too much output and no reply"),
            Ok(Event::Done) | Err(RecvTimeoutError::Disconnected) => return InitCheck::failed("exited before replying"),
            Err(RecvTimeoutError::Timeout) => {
                return InitCheck::failed(format!("no reply in {} s", timeout.as_secs_f64().ceil() as u64));
            }
        }
    }
}

/// A JSON object with `"id": 1` and a `result` or `error`. Anything else (noise, notifications) is skipped.
fn reply_of(bytes: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let ours = value.get("id") == Some(&json!(1)) && (value.get("result").is_some() || value.get("error").is_some());
    ours.then_some(value)
}

fn verdict(reply: &Value) -> InitCheck {
    let not_init = || InitCheck::failed("reply was not an ACP initialize result");
    let Some(result) = reply.get("result") else { return not_init() };
    let Some(pv) = result.get("protocolVersion").filter(|v| v.is_number()).and_then(Value::as_u64) else {
        return not_init();
    };
    let info = result.get("agentInfo");
    let text = |key: &str| {
        info.and_then(|i| i.get(key)).and_then(Value::as_str).map(|s| cut_chars(&mask_private(s.trim()), MAX_NAME_CHARS))
    };
    InitCheck {
        ok: true,
        protocol_version: Some(pv),
        agent_name: text("name"),
        agent_version: text("version"),
        reason: None,
    }
}
