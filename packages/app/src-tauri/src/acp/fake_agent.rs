//! A fake ACP agent for tests. No real agent is ever started by a test.
//!
//! The unit-test executable starts itself again as the agent: the child runs the one test
//! `tests::child_entry` with `PM_FAKE_ACP_ROLE=agent` in its environment, which turns that test into an
//! agent loop on stdin/stdout. (The test harness prints a header line to stdout first; the transport
//! ignores lines that are not JSON-RPC, which is also something worth testing.)
//!
//! What it does is chosen by the first word of the prompt text:
//!
//! | prompt | behaviour |
//! |---|---|
//! | `stream N` | N text chunks, then `end_turn` |
//! | `slow` | a chunk every 25 ms for 10 s; ends with `cancelled` when asked to stop |
//! | `tool` | a tool call that starts and completes, then text |
//! | `perm` | a tool call that needs permission; waits for the answer (no timeout) |
//! | `crash` | one chunk, a line on stderr, then the process exits with code 3 |
//! | `quiet` | says nothing until cancelled |
//! | `hang` | says nothing and ignores cancel |
//! | `flood N` | N chunks as fast as it can |
//! | `fsreq` | stray response with an unknown id, then asks the client to read a file using the SAME id as the prompt |
//! | `rich` | text, a file edit (diff, path), a plan, a usage update, a thought, a command, text; `end_turn` |
//! | `crashtool` | a tool call that starts, then the process exits with code 3 (a tool left open) |
//! | `toolhang` | a tool call that starts and stays in progress until cancelled; then `cancelled` |
//! | `garbage` | a line of bytes that are not UTF-8, a line of plain text, broken JSON, then real chunks and `end_turn` |
//! | `bigdiff N` | one edit call that carries N diffs of 20 KB each, then `end_turn` |
//! | `permcrash` | a tool that needs permission, then the process exits (the question is left open) |
//! | `permend` | a permission request, then `end_turn` while it is still open (reason: turn_ended) |
//! | `bg` | starts a background task, ends the turn, then reports the task finished ~0.8 s later |
//! | `bgreply` | like `bg`, then (after the task ends) sends the real follow-up reply `pong` |
//! | `permkind K` | a tool of kind K (`edit`, `read`, ...) asks permission; says what the client answered (`asked:K outcome:selected option:reject_once`) |
//! | `fswrite` | asks the client to write a file; says the error it got back |
//! | `mode` | says the session mode (`modes=1`: a `mode` config option; `modes=2`: session modes set with `session/set_mode`) |
//! | `permshape V` | a command that needs permission, with an odd option list: V = `long` (a label of 400 characters, like a long command pattern), `none` (no options), `blank` (options with no name and no kind); says what the client answered |
//! | `badperm` | a malformed permission request (the app must refuse it, not park it) |
//! | `empty` | `end_turn` with no output |
//! | `weird` | an update of a kind nobody knows, then text |
//! | `exit0err` | one chunk, stderr `Error: authentication failed (fake)`, then the process exits with code 0 (no response) |
//! | `selfcancel` | a chunk `401 Unauthorized (fake)`, then `stopReason: cancelled` although nobody cancelled |
//! | `rpcerr CODE TEXT` | answers the prompt with a JSON-RPC error (`rpcerr 500 fetch failed`) |
//! | `stall N MS` | N chunks 20 ms apart, silence for MS ms (honours cancel), N more chunks, `end_turn` |
//! | `noise MS` | for MS ms an unknown-kind update every 50 ms (bytes, no progress); honours cancel; `end_turn` with no text |
//! | `bigline N` | ONE chunk of N bytes of `a` with no newline, then `end_turn` |
//! | `len` | replies `len:<number of characters of the whole prompt>` (never echoes it) |
//! | `tools N` | N tool calls `t1..tN`, each started then completed, then `tools done` |
//! | `binary N` | N bytes of junk on stdout (NUL, 0xFF, lone surrogates, CR; a newline every 4096 bytes), then chunk `after junk` |
//! | `emojicrash` | a non-UTF-8 stdout line (cp950), a Python traceback on stderr, then `cancelled` un-asked |
//! | `latechunk` | a chunk `STALE` for a replaced session (`old-...`), then chunk `fresh`, `end_turn` |
//! | `recall` | replies `recall:<previous prompt of this session>` or `recall:none` |
//! | `settings` | replies `model=<m> effort=<e> mode=<mode>` as the fake holds them |
//! | `autowrite PATH` | writes PATH inside the session folder (content `fake`), sends a completed `edit` call, never asks |
//! | `onechunk` | a 15-piece answer delivered as one chunk |
//! | anything else | echoes the text |
//!
//! Chaos / conformance options (SPEC-CHAOS-1113 section 1.2), all off by default:
//!
//! | key | behaviour |
//! |---|---|
//! | `init_never=1` | reads `initialize`, never answers it (stays alive) |
//! | `first_byte_ms=N` | every turn waits N ms before its first output |
//! | `cancel_kills_session=1` | a cancelled turn ends `cancelled` and the session is forgotten; the next prompt gets `-32602 Unknown session` |
//! | `legacy_models=1` | `session/new` returns `models` and `modes` only, no `configOptions` |
//! | `version_file=PATH` | `agentInfo.version` is read from PATH at each start (default `1.0.0`) |
//! | `writes=1` | `perm` / `permkind K` write `notes.txt` / `permkind-K.txt` inside the session folder when the answer allows it |
//! | `cheat=auto_approve` | negative control: a permission word writes and goes on without asking |
//! | `cheat=deny_ignored` | negative control: asks, but does the work even when the answer is `reject_once` |
//! | `cheat=stub` | negative control: handshake and `session/new` only; `session/prompt` is `-32601` |
//! | `profile=bad` | `cancel_kills_session=1;legacy_models=1`, and every permission word behaves like `autowrite`, `stream N` like `onechunk`, `rpcerr` becomes chat text + `cancelled` |
//!
//! Role `host` (`PM_FAKE_ACP_ROLE=host`, `PM_FAKE_ACP_STORE` = a folder): starts one fake agent with `grandchild=1` the way the app
//! does (hidden, in a Job Object), prints `agent_pid=<n> grandchild_pid=<n>`, then sleeps. [`spawn_host`] starts it; a test kills the host
//! by its own PID to stand in for an app crash.
//!
//! `_session/steering` is answered `injected` while a prompt runs, else `promptRequired` (the option `steer=1` advertises it).
//!
//! Options (`PM_FAKE_ACP=load=0;resume=1;lose=1;auth=1;deaf_ms=3000;deaf_after_new_ms=5000;init_delay_ms=300;new_delay_ms=500;fail_init_once=1;grandchild=1`) change
//! what the handshake and session calls do. `PM_FAKE_ACP_STORE` is a folder where sessions are remembered
//! across processes, like an agent's own session files.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::config::{AgentConfig, PinPolicy, Timeouts};

pub const ROLE_ENV: &str = "PM_FAKE_ACP_ROLE";
pub const OPTS_ENV: &str = "PM_FAKE_ACP";
pub const STORE_ENV: &str = "PM_FAKE_ACP_STORE";

const HARNESS_ARGS: [&str; 4] = ["--exact", "acp::fake_agent::tests::child_entry", "--nocapture", "--test-threads=1"];

/// A config that starts the fake agent.
pub fn agent_config(opts: &str, store: &Path) -> AgentConfig {
    AgentConfig {
        id: "fake".into(),
        label: "Fake agent".into(),
        command: std::env::current_exe().expect("test exe").to_string_lossy().into_owned(),
        args: HARNESS_ARGS.iter().map(|a| a.to_string()).collect(),
        env: [
            (ROLE_ENV.to_string(), "agent".to_string()),
            (OPTS_ENV.to_string(), opts.to_string()),
            (STORE_ENV.to_string(), store.to_string_lossy().into_owned()),
        ]
        .into_iter()
        .collect(),
        pin_policy: PinPolicy::Off,
        timeouts: Timeouts { request_secs: 20, new_session_secs: 20, load_secs: 20, stdin_write_secs: 2, ..Timeouts::default() },
        ..AgentConfig::default()
    }
}

#[derive(Default, Clone)]
struct Opts {
    values: HashMap<String, String>,
}

impl Opts {
    fn parse(text: &str) -> Self {
        let values = text
            .split(';')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect();
        let mut opts = Opts { values };
        if opts.values.get("profile").is_some_and(|p| p == "bad") {
            opts.values.insert("cancel_kills_session".into(), "1".into());
            opts.values.insert("legacy_models".into(), "1".into());
        }
        opts
    }
    fn is(&self, name: &str, value: &str) -> bool {
        self.values.get(name).is_some_and(|v| v == value)
    }
    /// `profile=bad`: the deliberately non-conforming agent.
    fn bad(&self) -> bool {
        self.is("profile", "bad")
    }
    fn flag(&self, name: &str, default: bool) -> bool {
        self.values.get(name).map(|v| v == "1").unwrap_or(default)
    }
    /// The sign-in is gone while the file named by `auth_file` exists (a test creates it to expire the login).
    fn signed_out(&self) -> bool {
        self.flag("auth", false) || self.values.get("auth_file").is_some_and(|p| std::path::Path::new(p).exists())
    }
    fn number(&self, name: &str) -> u64 {
        self.values.get(name).and_then(|v| v.parse().ok()).unwrap_or(0)
    }
}

struct Shared {
    out: Mutex<std::io::Stdout>,
    cancel: AtomicBool,
    /// A prompt is being answered (for `_session/steering`).
    running: AtomicBool,
    /// `authenticate` was called (with `needs_authenticate=1` a session cannot open before that).
    authenticated: AtomicBool,
    responses: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next_request: AtomicU64,
    opts: Opts,
    store: PathBuf,
    /// The settings this session currently has (the config options a real agent reports back).
    model: Mutex<String>,
    effort: Mutex<String>,
    /// The session mode (`modes=1` makes the fake offer `default` and `plan`).
    mode: Mutex<String>,
    /// The folder the session was opened in (`session/new` / load / resume).
    cwd: Mutex<PathBuf>,
    /// Sessions the agent lost (`cancel_kills_session`).
    forgotten: Mutex<HashSet<String>>,
    /// The previous prompt text of each session (`recall`).
    last_prompt: Mutex<HashMap<String, String>>,
}

impl Shared {
    fn send(&self, value: Value) {
        let mut out = self.out.lock();
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    }

    fn update(&self, session_id: &str, update: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": update}}));
    }

    fn chunk(&self, session_id: &str, text: &str) {
        self.update(session_id, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}));
    }

    fn reply(&self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn fail(&self, id: &Value, code: i64, message: &str) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }

    /// Sends a request to the client and waits (forever) for its answer.
    fn ask(&self, id: u64, method: &str, params: Value) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        self.responses.lock().insert(id, tx);
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        rx
    }

    fn remember(&self, session_id: &str) {
        let _ = std::fs::create_dir_all(&self.store);
        let _ = std::fs::write(self.store.join(session_id), "x");
    }

    /// The config options the agent reports: model and effort, and the mode with `modes=1` (as a config option) or
    /// `modes=2` (offered only as session modes, set with `session/set_mode`).
    fn options(&self) -> Value {
        let mut options = config_options(&self.model.lock(), &self.effort.lock());
        if self.opts.number("modes") == 1 {
            if let Some(list) = options.as_array_mut() {
                list.push(json!({
                    "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": *self.mode.lock(),
                    "options": [{"value": "default", "name": "Default"}, {"value": "plan", "name": "Plan"}]
                }));
            }
        }
        options
    }

    fn note_cwd(&self, params: &Value) {
        if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
            *self.cwd.lock() = PathBuf::from(cwd);
        }
    }

    /// Writes `relative` inside the session folder (never outside it). Returns whether it was written.
    fn write_in_cwd(&self, relative: &str) -> bool {
        let rel = Path::new(relative);
        let safe = !relative.is_empty() && rel.is_relative() && rel.components().all(|c| matches!(c, std::path::Component::Normal(_)));
        let cwd = self.cwd.lock().clone();
        if !safe || cwd.as_os_str().is_empty() {
            return false;
        }
        let target = cwd.join(rel);
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(target, "fake").is_ok()
    }

    fn knows(&self, session_id: &str) -> bool {
        self.store.join(session_id).exists()
    }
}

fn config_options(model: &str, effort: &str) -> Value {
    json!([
        {
            "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": model,
            "options": [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]
        },
        {
            "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": effort,
            "options": [{"value": "low", "name": "Low"}, {"value": "medium", "name": "Medium"}, {"value": "high", "name": "High"}]
        }
    ])
}

/// The agent loop. Returns when stdin closes.
pub fn run_agent() {
    let opts = Opts::parse(&std::env::var(OPTS_ENV).unwrap_or_default());
    let store = PathBuf::from(std::env::var(STORE_ENV).unwrap_or_default());
    let shared = Arc::new(Shared {
        out: Mutex::new(std::io::stdout()),
        cancel: AtomicBool::new(false),
        running: AtomicBool::new(false),
        authenticated: AtomicBool::new(false),
        responses: Mutex::new(HashMap::new()),
        next_request: AtomicU64::new(1000),
        opts,
        store,
        model: Mutex::new("a".to_string()),
        effort: Mutex::new("medium".to_string()),
        mode: Mutex::new("default".to_string()),
        cwd: Mutex::new(PathBuf::new()),
        forgotten: Mutex::new(HashSet::new()),
        last_prompt: Mutex::new(HashMap::new()),
    });
    // The test harness leaves "test ... " unterminated on stdout; start on a fresh line.
    {
        let mut out = shared.out.lock();
        let _ = writeln!(out);
        let _ = out.flush();
    }
    if shared.opts.flag("fail_init_once", false) {
        let marker = shared.store.join("failed-once");
        if !marker.exists() {
            let _ = std::fs::create_dir_all(&shared.store);
            let _ = std::fs::write(&marker, "x");
            eprintln!("Error: failed to initialize sqlite state runtime: database is locked");
            std::process::exit(1);
        }
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message.get("method").and_then(Value::as_str).map(str::to_string);
        let id = message.get("id").cloned();
        match (method, id) {
            (Some(method), Some(id)) => handle_request(&shared, &method, &id, message.get("params").cloned().unwrap_or(Value::Null)),
            (Some(method), None) => {
                if method == "session/cancel" && !shared.opts.flag("ignore_cancel", false) {
                    shared.cancel.store(true, Ordering::SeqCst);
                }
            }
            (None, Some(id)) => {
                if let Some(tx) = id.as_u64().and_then(|n| shared.responses.lock().remove(&n)) {
                    let _ = tx.send(message);
                }
            }
            (None, None) => {}
        }
    }
}

fn handle_request(shared: &Arc<Shared>, method: &str, id: &Value, params: Value) {
    match method {
        "initialize" => {
            let opts = &shared.opts;
            if opts.flag("init_never", false) {
                return;
            }
            // A real adapter takes a while to come up: `init_delay_ms` makes the fake slow to answer.
            let slow = opts.number("init_delay_ms");
            if slow > 0 {
                std::thread::sleep(Duration::from_millis(slow));
            }
            let mut session_caps = json!({"list": {}, "close": {}});
            if opts.flag("resume", true) {
                session_caps["resume"] = json!({});
            }
            shared.reply(
                id,
                json!({
                    "protocolVersion": 1,
                    "agentInfo": {"name": "fake-acp-agent", "title": "Fake", "version": agent_version(opts)},
                    "agentCapabilities": {
                        "loadSession": opts.flag("load", true),
                        "promptCapabilities": {"image": true, "embeddedContext": true},
                        "sessionCapabilities": session_caps,
                        "mcpCapabilities": {"http": true, "sse": false}
                    },
                    "authMethods": [{"id": "login", "name": "Sign in"}],
                    "_meta": {
                        "steering": {"supported": opts.flag("steer", false)},
                        "jetbrains": {"air": {
                            "version": 1,
                            "capabilities": if opts.flag("background_tasks", true) { vec!["asyncTasks"] } else { Vec::new() }
                        }}
                    }
                }),
            );
            let deaf = opts.number("deaf_ms");
            if deaf > 0 {
                // Stop reading stdin: whatever the client writes next piles up in the pipe.
                std::thread::sleep(Duration::from_millis(deaf));
            }
        }
        "authenticate" => {
            // Records the method id so a test can read it back (`authenticated` marker file in the store).
            let method = params.get("methodId").and_then(Value::as_str).unwrap_or_default().to_string();
            shared.authenticated.store(true, Ordering::SeqCst);
            let _ = std::fs::create_dir_all(&shared.store);
            let _ = std::fs::write(shared.store.join("authenticated"), method);
            shared.reply(id, json!({}));
        }
        "session/new" => {
            if shared.opts.flag("needs_authenticate", false) && !shared.authenticated.load(Ordering::SeqCst) {
                shared.fail(id, -32000, "Authentication required");
                return;
            }
            let slow = shared.opts.number("new_delay_ms");
            if slow > 0 {
                std::thread::sleep(Duration::from_millis(slow));
            }
            if shared.opts.signed_out() {
                shared.fail(id, -32000, "Authentication required");
                return;
            }
            let session_id = format!("fake-{}-{}", std::process::id(), chrono_nanos());
            shared.note_cwd(&params);
            shared.remember(&session_id);
            if shared.opts.flag("grandchild", false) {
                spawn_grandchild(&shared.store);
            }
            let options = shared.options();
            let mut result = json!({"sessionId": session_id, "configOptions": options});
            if shared.opts.flag("legacy_models", false) {
                // An older agent: models and modes as their own lists, no config options.
                result = json!({
                    "sessionId": session_id,
                    "models": {"currentModelId": *shared.model.lock(), "availableModels": [{"modelId": "a", "name": "A"}, {"modelId": "b", "name": "B"}]},
                    "modes": {"currentModeId": *shared.mode.lock(), "availableModes": [{"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]}
                });
            } else if shared.opts.number("modes") == 2 {
                result["modes"] = json!({"currentModeId": *shared.mode.lock(), "availableModes": [{"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]});
            }
            shared.reply(id, result);
            shared.update(
                &session_id,
                json!({"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "review", "description": "Review changes", "input": {"hint": "branch"}}]}),
            );
            let deaf = shared.opts.number("deaf_after_new_ms");
            if deaf > 0 {
                std::thread::sleep(Duration::from_millis(deaf));
            }
        }
        "session/load" | "session/resume" => {
            let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
            shared.note_cwd(&params);
            if shared.opts.signed_out() {
                shared.fail(id, -32000, "Authentication required");
                return;
            }
            if shared.opts.flag("lose", false) || !shared.knows(&session_id) {
                shared.fail(id, -32002, &format!("Session not found: {session_id}"));
                return;
            }
            if method == "session/load" {
                shared.update(&session_id, json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "earlier question"}}));
                shared.chunk(&session_id, "earlier answer");
                shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "old-tool", "title": "Old tool", "kind": "read", "status": "in_progress"}));
            }
            // Some real agents answer a restore with no settings at all.
            if shared.opts.flag("bare_restore", false) || shared.opts.flag("legacy_models", false) {
                shared.reply(id, json!({}));
            } else {
                let options = shared.options();
                shared.reply(id, json!({"configOptions": options}));
            }
        }
        "session/set_model" => {
            let model = params.get("modelId").and_then(Value::as_str).unwrap_or("a").to_string();
            *shared.model.lock() = model;
            shared.reply(id, json!({}));
        }
        "session/set_config_option" if shared.opts.flag("legacy_models", false) => shared.fail(id, -32601, "method not found: session/set_config_option"),
        "session/set_config_option" => {
            let id_of = params.get("configId").and_then(Value::as_str).unwrap_or("model");
            let value = params.get("value").and_then(Value::as_str).unwrap_or("a").to_string();
            if id_of == "effort" {
                *shared.effort.lock() = value;
            } else if id_of == "mode" {
                *shared.mode.lock() = value;
            } else {
                *shared.model.lock() = value;
            }
            let options = shared.options();
            shared.reply(id, json!({"configOptions": options}));
        }
        "session/set_mode" => {
            let mode = params.get("modeId").and_then(Value::as_str).unwrap_or("default").to_string();
            *shared.mode.lock() = mode;
            shared.reply(id, json!({}));
        }
        "_session/steering" => {
            let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
            if shared.running.load(Ordering::SeqCst) {
                let text = params.pointer("/prompt/0/text").and_then(Value::as_str).unwrap_or_default().to_string();
                shared.reply(id, json!({"outcome": "injected"}));
                shared.chunk(&session_id, &format!("steered:{text} "));
            } else {
                shared.reply(id, json!({"outcome": "promptRequired"}));
            }
        }
        "session/prompt" if shared.opts.is("cheat", "stub") => shared.fail(id, -32601, "method not found: session/prompt"),
        "session/prompt" if params.get("sessionId").and_then(Value::as_str).is_some_and(|s| shared.forgotten.lock().contains(s)) => {
            shared.fail(id, -32602, "Unknown session");
        }
        "session/prompt" => {
            // Reset here, not in the worker: a cancel that arrives right behind the prompt must survive.
            shared.cancel.store(false, Ordering::SeqCst);
            shared.running.store(true, Ordering::SeqCst);
            let shared = shared.clone();
            let id = id.clone();
            std::thread::spawn(move || run_prompt(&shared, &id, &params));
        }
        other => shared.fail(id, -32601, &format!("method not found: {other}")),
    }
}

/// `agentInfo.version`: `0.0.1`, or with `version_file=PATH` what that file holds now (`1.0.0` when it cannot be read).
fn agent_version(opts: &Opts) -> String {
    match opts.values.get("version_file") {
        Some(path) => std::fs::read_to_string(path).map(|t| t.trim().to_string()).ok().filter(|t| !t.is_empty()).unwrap_or_else(|| "1.0.0".into()),
        None => "0.0.1".into(),
    }
}

fn chrono_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

fn spawn_grandchild(store: &Path) {
    let exe = std::env::current_exe().expect("test exe");
    let mut command = crate::proc_util::hidden_command(exe);
    command.args(HARNESS_ARGS).env(ROLE_ENV, "sleeper").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if let Ok(child) = command.spawn() {
        let _ = std::fs::create_dir_all(store);
        let _ = std::fs::write(store.join("grandchild.pid"), child.id().to_string());
    }
}

fn run_prompt(shared: &Arc<Shared>, id: &Value, params: &Value) {
    run_prompt_inner(shared, id, params);
    shared.running.store(false, Ordering::SeqCst);
}

fn run_prompt_inner(shared: &Arc<Shared>, id: &Value, params: &Value) {
    let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
    let text = params.pointer("/prompt/0/text").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut words = text.split_whitespace();
    let verb = words.next().unwrap_or("");
    let count: usize = words.next().and_then(|w| w.parse().ok()).unwrap_or(3);
    let done = |stop: &str| {
        // `cancel_kills_session`: a stop that really was asked for loses the session.
        if stop == "cancelled" && shared.opts.flag("cancel_kills_session", false) && shared.cancel.load(Ordering::SeqCst) {
            shared.forgotten.lock().insert(session_id.clone());
        }
        shared.reply(id, json!({"stopReason": stop}))
    };
    let previous = shared.last_prompt.lock().insert(session_id.clone(), text.clone());
    let rest_of = |skip: usize| text.split_whitespace().skip(skip).collect::<Vec<_>>().join(" ");
    let wait_first_byte = |ms: u64| -> bool {
        let until = std::time::Instant::now() + Duration::from_millis(ms);
        while std::time::Instant::now() < until {
            if shared.cancel.load(Ordering::SeqCst) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    };
    let first_byte = shared.opts.number("first_byte_ms");
    if first_byte > 0 && !wait_first_byte(first_byte) {
        return done("cancelled");
    }
    let bad = shared.opts.bad();
    // The deliberately bad agent never asks: a permission word is a silent file write.
    let swapped = bad && matches!(verb, "perm" | "permkind" | "permshape");
    let swapped_file = match verb {
        "perm" => "notes.txt".to_string(),
        "permkind" => format!("permkind-{}.txt", text.split_whitespace().nth(1).unwrap_or("edit")),
        _ => "bad-write.txt".to_string(),
    };
    let verb = if swapped { "autowrite" } else { verb };
    let cheat = shared.opts.values.get("cheat").cloned().unwrap_or_default();

    match verb {
        "stream" if bad => {
            let all: String = (0..count).map(|n| format!("w{n} ")).collect();
            shared.chunk(&session_id, &all);
            done("end_turn");
        }
        "onechunk" => {
            let all: String = (0..15).map(|n| format!("w{n} ")).collect();
            shared.chunk(&session_id, &all);
            done("end_turn");
        }
        "exit0err" => {
            shared.chunk(&session_id, "partial ");
            eprintln!("Error: authentication failed (fake)");
            std::thread::sleep(Duration::from_millis(50));
            std::process::exit(0);
        }
        "selfcancel" => {
            shared.chunk(&session_id, "401 Unauthorized (fake)");
            done("cancelled");
        }
        "rpcerr" => {
            let code: i64 = text.split_whitespace().nth(1).and_then(|w| w.parse().ok()).unwrap_or(-32603);
            let message = rest_of(2);
            if bad {
                shared.chunk(&session_id, &format!("Error {code}: {message}"));
                done("cancelled");
            } else {
                shared.fail(id, code, &message);
            }
        }
        "stall" => {
            let silence: u64 = text.split_whitespace().nth(2).and_then(|w| w.parse().ok()).unwrap_or(1000);
            for n in 0..count {
                shared.chunk(&session_id, &format!("p{n} "));
                std::thread::sleep(Duration::from_millis(20));
            }
            if !wait_first_byte(silence) {
                return done("cancelled");
            }
            for n in 0..count {
                shared.chunk(&session_id, &format!("q{n} "));
                std::thread::sleep(Duration::from_millis(20));
            }
            done("end_turn");
        }
        "noise" => {
            let total: u64 = text.split_whitespace().nth(1).and_then(|w| w.parse().ok()).unwrap_or(1000);
            let until = std::time::Instant::now() + Duration::from_millis(total);
            let mut n = 0;
            while std::time::Instant::now() < until {
                if shared.cancel.load(Ordering::SeqCst) {
                    return done("cancelled");
                }
                shared.update(&session_id, json!({"sessionUpdate": "future_noise", "n": n}));
                n += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            done("end_turn");
        }
        "bigline" => {
            let size: usize = text.split_whitespace().nth(1).and_then(|w| w.parse().ok()).unwrap_or(1_048_576);
            shared.chunk(&session_id, &"a".repeat(size));
            done("end_turn");
        }
        "len" => {
            shared.chunk(&session_id, &format!("len:{}", text.chars().count()));
            done("end_turn");
        }
        "tools" => {
            let total: usize = text.split_whitespace().nth(1).and_then(|w| w.parse().ok()).unwrap_or(3);
            for n in 1..=total {
                shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": format!("t{n}"), "title": format!("Tool {n}"), "kind": "execute", "status": "in_progress"}));
                shared.update(&session_id, json!({"sessionUpdate": "tool_call_update", "toolCallId": format!("t{n}"), "status": "completed"}));
            }
            shared.chunk(&session_id, "tools done");
            done("end_turn");
        }
        "binary" => {
            let total: usize = text.split_whitespace().nth(1).and_then(|w| w.parse().ok()).unwrap_or(4096);
            // NUL, 0xFF, a lone surrogate (ED A0 80), a CR with no LF, an overlong lead byte.
            const JUNK: [u8; 8] = [0x00, 0xFF, 0xED, 0xA0, 0x80, 0x0D, 0xC0, 0x41];
            let bytes: Vec<u8> = (1..=total).map(|n| if n % 4096 == 0 { b'\n' } else { JUNK[n % JUNK.len()] }).collect();
            {
                let mut out = shared.out.lock();
                let _ = out.write_all(&bytes);
                let _ = out.write_all(b"\n");
                let _ = out.flush();
            }
            shared.chunk(&session_id, "after junk");
            done("end_turn");
        }
        "emojicrash" => {
            {
                let mut out = shared.out.lock();
                // "\u{4e2d}\u{6587}" in cp950, then a character cp950 cannot hold, as a Python print would have died on.
                let _ = out.write_all(&[0xA4, 0xA4, 0xA4, 0xE5, 0xFF, b'\n']);
                let _ = out.flush();
            }
            eprintln!("Traceback (most recent call last):");
            eprintln!("  File \"agent.py\", line 12, in <module>");
            eprintln!("UnicodeEncodeError: 'cp950' codec can't encode character '\\U0001f600' in position 0: illegal multibyte sequence");
            done("cancelled");
        }
        "latechunk" => {
            shared.chunk(&format!("old-{}", chrono_nanos()), "STALE");
            shared.chunk(&session_id, "fresh");
            done("end_turn");
        }
        "recall" => {
            shared.chunk(&session_id, &format!("recall:{}", previous.unwrap_or_else(|| "none".into())));
            done("end_turn");
        }
        "settings" => {
            let (model, effort, mode) = (shared.model.lock().clone(), shared.effort.lock().clone(), shared.mode.lock().clone());
            shared.chunk(&session_id, &format!("model={model} effort={effort} mode={mode}"));
            done("end_turn");
        }
        "autowrite" => {
            // The `gptme` shape: the file is written and reported as an edit, nobody was asked.
            let relative = if swapped { swapped_file } else { rest_of(1) };
            let wrote = shared.write_in_cwd(&relative);
            let cwd = shared.cwd.lock().clone();
            let full = cwd.join(&relative).to_string_lossy().into_owned();
            shared.update(
                &session_id,
                json!({"sessionUpdate": "tool_call", "toolCallId": "aw1", "title": format!("Write {relative}"), "kind": "edit", "status": "completed",
                       "locations": [{"path": full}],
                       "content": [{"type": "diff", "path": full, "oldText": null, "newText": "fake"}]}),
            );
            shared.chunk(&session_id, &format!("autowrote:{relative} written:{wrote}"));
            done("end_turn");
        }
        "stream" => {
            for n in 0..count {
                shared.chunk(&session_id, &format!("w{n} "));
            }
            done("end_turn");
        }
        "flood" => {
            for n in 0..count {
                shared.chunk(&session_id, &format!("{n},"));
            }
            done("end_turn");
        }
        "slow" => {
            for n in 0..400 {
                if shared.cancel.load(Ordering::SeqCst) {
                    return done("cancelled");
                }
                shared.chunk(&session_id, &format!("s{n} "));
                std::thread::sleep(Duration::from_millis(25));
            }
            done("end_turn");
        }
        "tool" => {
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Run tests", "kind": "execute", "status": "in_progress"}));
            std::thread::sleep(Duration::from_millis(40));
            shared.update(&session_id, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"}));
            shared.chunk(&session_id, "tool done");
            done("end_turn");
        }
        "perm" if cheat == "auto_approve" => {
            if shared.opts.flag("writes", false) {
                shared.write_in_cwd("notes.txt");
            }
            shared.chunk(&session_id, "chose:auto");
            done("end_turn");
        }
        "perm" => {
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "w1", "title": "Write notes.txt", "kind": "edit", "status": "pending"}));
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let rx = shared.ask(
                ask_id,
                "session/request_permission",
                json!({
                    "sessionId": session_id,
                    "toolCall": {"toolCallId": "w1", "kind": "edit", "status": "pending", "title": "Write notes.txt"},
                    "options": [
                        {"optionId": "allow_once", "name": "Allow Once", "kind": "allow_once"},
                        {"optionId": "allow_always", "name": "Allow for Session", "kind": "allow_always"},
                        {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}
                    ]
                }),
            );
            // No timeout: the agent waits as long as the person takes.
            let Ok(answer) = rx.recv() else { return };
            let outcome = answer.pointer("/result/outcome/outcome").and_then(Value::as_str).unwrap_or("?").to_string();
            if outcome == "cancelled" {
                return done("cancelled");
            }
            let option = answer.pointer("/result/outcome/optionId").and_then(Value::as_str).unwrap_or("?").to_string();
            let allowed = option.starts_with("allow");
            if (allowed || cheat == "deny_ignored") && shared.opts.flag("writes", false) {
                shared.write_in_cwd("notes.txt");
            }
            shared.update(&session_id, json!({"sessionUpdate": "tool_call_update", "toolCallId": "w1", "status": if allowed { "completed" } else { "failed" }}));
            shared.chunk(&session_id, &format!("chose:{option}"));
            done("end_turn");
        }
        "rich" => {
            shared.chunk(&session_id, "Looking at it. ");
            shared.update(&session_id, json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking about it"}}));
            shared.update(
                &session_id,
                json!({"sessionUpdate": "tool_call", "toolCallId": "e1", "title": "Write notes.txt", "kind": "edit", "status": "pending",
                       "locations": [{"path": "C:\\work\\notes.txt"}],
                       "content": [{"type": "diff", "path": "C:\\work\\notes.txt", "oldText": null, "newText": "hello\n"}]}),
            );
            shared.update(&session_id, json!({"sessionUpdate": "tool_call_update", "toolCallId": "e1", "status": "completed"}));
            shared.update(
                &session_id,
                json!({"sessionUpdate": "plan", "entries": [
                    {"content": "Write the notes", "priority": "high", "status": "completed"},
                    {"content": "Run the tests", "priority": "medium", "status": "in_progress"}]}),
            );
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "x1", "title": "Run tests", "kind": "execute", "status": "in_progress"}));
            shared.update(
                &session_id,
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "x1", "status": "completed",
                       "content": [{"type": "content", "content": {"type": "text", "text": "```\n3 passed\n```"}}]}),
            );
            shared.update(&session_id, json!({"sessionUpdate": "usage_update", "used": 1200, "size": 200000}));
            shared.chunk(&session_id, "All done.");
            done("end_turn");
        }
        "crashtool" => {
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Run build", "kind": "execute", "status": "in_progress"}));
            shared.chunk(&session_id, "starting ");
            std::thread::sleep(Duration::from_millis(50));
            eprintln!("fake agent: boom (pretending to crash)");
            std::process::exit(3);
        }
        "toolhang" => {
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "h1", "title": "Run build", "kind": "execute", "status": "in_progress"}));
            shared.chunk(&session_id, "building ");
            loop {
                if shared.cancel.load(Ordering::SeqCst) {
                    return done("cancelled");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        "garbage" => {
            shared.chunk(&session_id, "before ");
            {
                let mut out = shared.out.lock();
                let _ = out.write_all(&[0xff, 0xfe, 0xfa, b'\n']);
                let _ = out.write_all(b"warning: this is a log line, not JSON-RPC\n");
                let _ = out.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\n");
                let _ = out.flush();
            }
            shared.chunk(&session_id, "after");
            done("end_turn");
        }
        "bg" => {
            shared.update(
                &session_id,
                json!({"sessionUpdate": "async_task_spawned", "asyncTaskId": "bg1", "name": "npm test", "taskType": "local_bash"}),
            );
            shared.chunk(&session_id, "started in the background");
            done("end_turn");
            let shared = shared.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(800));
                shared.update(&session_id, json!({"sessionUpdate": "async_task_state_update", "asyncTaskId": "bg1", "state": "completed"}));
            });
        }
        "bgreply" => {
            shared.update(
                &session_id,
                json!({"sessionUpdate": "async_task_spawned", "asyncTaskId": "bg1", "name": "sleep 60", "taskType": "local_bash"}),
            );
            shared.chunk(&session_id, "waiting in the background");
            done("end_turn");
            let shared = shared.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                shared.update(&session_id, json!({"sessionUpdate": "async_task_state_update", "asyncTaskId": "bg1", "state": "completed"}));
                std::thread::sleep(Duration::from_millis(400));
                shared.chunk(&session_id, "pong");
            });
        }
        "permend" => {
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "w1", "title": "Write notes.txt", "kind": "edit", "status": "pending"}));
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let _rx = shared.ask(
                ask_id,
                "session/request_permission",
                json!({
                    "sessionId": session_id,
                    "toolCall": {"toolCallId": "w1", "kind": "edit", "status": "pending", "title": "Write notes.txt"},
                    "options": [{"optionId": "allow_once", "name": "Allow Once", "kind": "allow_once"}]
                }),
            );
            // Let the client park the request before the turn ends (the reported case: a turn that
            // ends with the prompt still open).
            std::thread::sleep(Duration::from_millis(60));
            done("end_turn");
        }
        "permkind" => {
            // `permkind <kind>`: asks permission for a tool of that kind and says what the client answered.
            let kind = text.split_whitespace().nth(1).unwrap_or("edit").to_string();
            let file = format!("permkind-{kind}.txt");
            if cheat == "auto_approve" {
                if shared.opts.flag("writes", false) {
                    shared.write_in_cwd(&file);
                }
                shared.chunk(&session_id, &format!("asked:{kind} outcome:auto option:none"));
                return done("end_turn");
            }
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "k1", "title": "A tool", "kind": kind, "status": "pending"}));
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let rx = shared.ask(
                ask_id,
                "session/request_permission",
                json!({
                    "sessionId": session_id,
                    "toolCall": {"toolCallId": "k1", "kind": kind, "status": "pending", "title": "A tool"},
                    "options": [
                        {"optionId": "allow_once", "name": "Allow Once", "kind": "allow_once"},
                        {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}
                    ]
                }),
            );
            let Ok(answer) = rx.recv() else { return };
            let outcome = answer.pointer("/result/outcome/outcome").and_then(Value::as_str).unwrap_or("?").to_string();
            let option = answer.pointer("/result/outcome/optionId").and_then(Value::as_str).unwrap_or("-").to_string();
            if (option.starts_with("allow") || cheat == "deny_ignored") && shared.opts.flag("writes", false) {
                shared.write_in_cwd(&file);
            }
            shared.chunk(&session_id, &format!("asked:{kind} outcome:{outcome} option:{option}"));
            done("end_turn");
        }
        "permshape" => {
            let variant = text.split_whitespace().nth(1).unwrap_or("long").to_string();
            let options = match variant.as_str() {
                "none" => json!([]),
                "blank" => json!([{"optionId": "x1", "name": "", "kind": ""}]),
                _ => json!([
                    {"optionId": "allow_once", "name": "Allow Once", "kind": "allow_once"},
                    {"optionId": "accept_execpolicy_amendment", "name": format!("Allow Commands Starting With `{}`", "Get-CimInstance ".repeat(30)), "kind": "allow_always"},
                    {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}
                ]),
            };
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "s1", "kind": "execute", "status": "pending"}));
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let rx = shared.ask(
                ask_id,
                "session/request_permission",
                json!({"sessionId": session_id, "toolCall": {"toolCallId": "s1", "kind": "execute", "status": "pending"}, "options": options}),
            );
            let Ok(answer) = rx.recv() else { return };
            let outcome = answer.pointer("/result/outcome/outcome").and_then(Value::as_str).unwrap_or("?").to_string();
            let option = answer.pointer("/result/outcome/optionId").and_then(Value::as_str).unwrap_or("-").to_string();
            shared.chunk(&session_id, &format!("shape:{variant} outcome:{outcome} option:{option}"));
            done("end_turn");
        }
        "fswrite" => {
            // A file write the client was never offered: it must be refused.
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let rx = shared.ask(ask_id, "fs/write_text_file", json!({"sessionId": session_id, "path": "work/notes.txt", "content": "x"}));
            let reply = rx.recv().unwrap_or(Value::Null);
            let code = reply.pointer("/error/code").and_then(Value::as_i64).unwrap_or(0);
            let message = reply.pointer("/error/message").and_then(Value::as_str).unwrap_or("").to_string();
            shared.chunk(&session_id, &format!("fs-error:{code} {message}"));
            done("end_turn");
        }
        "mode" => {
            let mode = shared.mode.lock().clone();
            shared.chunk(&session_id, &format!("mode:{mode}"));
            done("end_turn");
        }
        "badperm" => {
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let rx = shared.ask(ask_id, "session/request_permission", json!({"sessionId": session_id}));
            let _ = rx.recv();
            done("cancelled");
        }
        "bigdiff" => {
            let diffs: Vec<Value> = (0..count).map(|n| json!({"type": "diff", "path": format!("C:\\work\\file{n}.txt"), "oldText": "o".repeat(10_000), "newText": "n".repeat(10_000)})).collect();
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "big1", "title": "Apply patch", "kind": "edit", "status": "in_progress", "content": diffs}));
            shared.update(&session_id, json!({"sessionUpdate": "tool_call_update", "toolCallId": "big1", "status": "completed"}));
            shared.chunk(&session_id, "patched");
            done("end_turn");
        }
        "permcrash" => {
            shared.update(&session_id, json!({"sessionUpdate": "tool_call", "toolCallId": "w1", "title": "Write notes.txt", "kind": "edit", "status": "pending"}));
            let ask_id = shared.next_request.fetch_add(1, Ordering::SeqCst);
            let _rx = shared.ask(
                ask_id,
                "session/request_permission",
                json!({
                    "sessionId": session_id,
                    "toolCall": {"toolCallId": "w1", "kind": "edit", "status": "pending", "title": "Write notes.txt"},
                    "options": [
                        {"optionId": "allow_once", "name": "Allow Once", "kind": "allow_once"},
                        {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}
                    ]
                }),
            );
            std::thread::sleep(Duration::from_millis(400));
            eprintln!("fake agent: boom (crashing with a question open)");
            std::process::exit(4);
        }
        "crash" => {
            shared.chunk(&session_id, "partial ");
            eprintln!("fake agent: boom (pretending to crash)");
            std::process::exit(3);
        }
        "quiet" => loop {
            if shared.cancel.load(Ordering::SeqCst) {
                return done("cancelled");
            }
            std::thread::sleep(Duration::from_millis(20));
        },
        "hang" => loop {
            std::thread::sleep(Duration::from_millis(100));
        },
        "fsreq" => {
            // A response nobody asked for, then a request whose id equals the id of the prompt in flight.
            shared.send(json!({"jsonrpc": "2.0", "id": 99999, "result": {}}));
            let prompt_id = id.as_u64().expect("numeric prompt id");
            let rx = shared.ask(prompt_id, "fs/read_text_file", json!({"sessionId": session_id, "path": "C:\\secret.txt"}));
            let reply = rx.recv().unwrap_or(Value::Null);
            let code = reply.pointer("/error/code").and_then(Value::as_i64).unwrap_or(0);
            shared.chunk(&session_id, &format!("fs-error:{code}"));
            done("end_turn");
        }
        "empty" => done("end_turn"),
        "weird" => {
            shared.update(&session_id, json!({"sessionUpdate": "future_thing", "x": 1}));
            shared.chunk(&session_id, "after weird");
            done("end_turn");
        }
        _ => {
            shared.chunk(&session_id, &format!("echo: {text}"));
            done("end_turn");
        }
    }
}

// ---- the `host` role: an app that can be crashed (SPEC-CHAOS-1113 B03, S08) ------------------------------------------

struct HostEnvForRole {
    root: PathBuf,
}

impl super::config::HostEnv for HostEnvForRole {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
}

/// The body of the `host` role: starts one fake agent (with a grandchild) through a real session, prints both pids, sleeps.
fn host_role() {
    let folder = PathBuf::from(std::env::var(STORE_ENV).unwrap_or_default());
    let _ = std::fs::create_dir_all(&folder);
    let cfg = agent_config("grandchild=1", &folder.join("agent-store"));
    let env: Arc<dyn super::config::HostEnv> = Arc::new(HostEnvForRole { root: folder.clone() });
    let session = super::session::AcpSession::new(Arc::new(cfg), env, super::session::SessionParams { key: "host-role".into(), cwd: folder.clone(), resume_session_id: None });
    if session.ensure_running().is_err() {
        println!("host_failed");
        std::process::exit(2);
    }
    let agent_pid = session.connection().map(|c| c.pid()).unwrap_or(0);
    let grandchild_pid = std::fs::read_to_string(folder.join("agent-store").join("grandchild.pid")).ok().and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0);
    println!("agent_pid={agent_pid} grandchild_pid={grandchild_pid}");
    let _ = std::io::stdout().flush();
    std::thread::sleep(Duration::from_secs(120));
    std::process::exit(0);
}

/// A running `host` (see the module doc): the process to crash, and the two processes it left under it.
pub struct Host {
    child: std::process::Child,
    pub agent_pid: u32,
    pub grandchild_pid: u32,
}

impl Host {
    /// The host's own pid: what a test kills to stand in for an app crash.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Kills the host process alone (not its tree): the agent and the grandchild must go with it by themselves.
    pub fn crash(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // A test that failed halfway leaves nothing behind: only the pids this host reported.
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in [self.agent_pid, self.grandchild_pid] {
            if pid != 0 && crate::proc_util::pid_alive(pid) {
                crate::pty::proc_tree::kill_process_tree(pid);
            }
        }
    }
}

/// Starts the `host` role with `folder` as its working folder. Waits (up to 30 s) until it printed the two pids.
pub fn spawn_host(folder: &Path) -> Result<Host, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = crate::proc_util::hidden_command(exe);
    command
        .args(HARNESS_ARGS)
        .env(ROLE_ENV, "host")
        .env(STORE_ENV, folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("agent_pid=") || line.contains("host_failed") {
                let _ = tx.send(line);
                break;
            }
        }
        // Keep reading so the host never blocks on a full pipe.
    });
    let line = match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(line) => line,
        Err(_) => {
            let _ = child.kill();
            return Err("the host did not report its pids in 30 s".into());
        }
    };
    let number = |key: &str| line.split(key).nth(1).and_then(|rest| rest.split_whitespace().next()).and_then(|n| n.parse::<u32>().ok());
    match (number("agent_pid="), number("grandchild_pid=")) {
        (Some(agent_pid), Some(grandchild_pid)) => Ok(Host { child, agent_pid, grandchild_pid }),
        _ => {
            let _ = child.kill();
            Err(format!("the host said: {line}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a test when run normally. As a child of another test (`PM_FAKE_ACP_ROLE` set) it is the agent.
    #[test]
    fn child_entry() {
        match std::env::var(ROLE_ENV).as_deref() {
            Ok("agent") => {
                run_agent();
                std::process::exit(0);
            }
            Ok("sleeper") => {
                std::thread::sleep(Duration::from_secs(120));
                std::process::exit(0);
            }
            Ok("host") => host_role(),
            _ => {}
        }
    }
}
