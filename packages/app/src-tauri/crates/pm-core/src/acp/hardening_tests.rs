//! Hardening tests for the ACP client, driven by a scripted stub peer: the unit-test executable starts itself again
//! as the peer (`stub_child_entry`, only when `PM_STUB_ROLE=agent` is set) and talks JSON-RPC lines on its stdio, the
//! same transport a real adapter uses. No real agent is started. What the stub does is chosen by `PM_STUB_MODE`.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::config::{self, AgentConfig, HostEnv, PinPolicy, Timeouts};
use super::session::{AcpSession, SessionEvent, SessionParams};
use super::state::{StopKind, TurnSummary};

const ROLE: &str = "PM_STUB_ROLE";
const MODE: &str = "PM_STUB_MODE";
const LOG: &str = "PM_STUB_LOG";

// ---- the stub peer (child only) ------------------------------------------------------------------------------------

fn send(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

fn send_json(value: Value) {
    send(&format!("{value}\n"));
}

fn chunk(session: &str, text: &str) {
    send_json(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}}));
}

fn note(text: &str) {
    if let Ok(path) = std::env::var(LOG) {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{text}");
        }
    }
}

fn run_stub(mode: &str) {
    // The test harness prints "test name ... " without a newline first; end that line so replies start on their own.
    send("
");
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let (Some(id), Some(method)) = (message.get("id").cloned(), message.get("method").and_then(Value::as_str)) else {
            if message.get("method").and_then(Value::as_str) == Some("session/cancel") {
                note("cancel");
            }
            continue;
        };
        let reply = |result: Value| send_json(json!({"jsonrpc": "2.0", "id": id, "result": result}));
        match method {
            "initialize" => reply(json!({
                "protocolVersion": 1,
                "agentInfo": {"name": "stub", "version": "1"},
                "agentCapabilities": {"loadSession": true, "sessionCapabilities": {"resume": {}}}
            })),
            "session/resume" | "session/load" => {
                send_json(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": "Session not found"}}));
            }
            "session/new" if mode == "modes_only" => reply(json!({
                "sessionId": "s-1",
                "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "Model One"}, {"modelId": "m2", "name": "Model Two"}]},
                "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]}
            })),
            "session/new" => reply(json!({"sessionId": "s-new"})),
            "session/set_model" => {
                note(&format!("set_model {}", message["params"]["modelId"].as_str().unwrap_or_default()));
                reply(json!({}));
            }
            "session/set_mode" => {
                note(&format!("set_mode {}", message["params"]["modeId"].as_str().unwrap_or_default()));
                reply(json!({}));
            }
            "session/prompt" => match mode {
                "cancelled" => reply(json!({"stopReason": "cancelled"})),
                "late" => {
                    chunk("s-old", "LATE ");
                    chunk("s-new", "hello ");
                    chunk("s-old", "LATE2 ");
                    reply(json!({"stopReason": "end_turn"}));
                }
                "burst_eof" => {
                    for n in 0..60 {
                        chunk("s-new", &format!("b{n} "));
                    }
                    // The pipe closes in the middle of a line: no newline, no closing brace.
                    send("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"s-new\",\"upd");
                    std::process::exit(1);
                }
                _ => reply(json!({"stopReason": "end_turn"})),
            },
            _ => send_json(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})),
        }
    }
}

/// Not a test when run normally. As a child of another test (`PM_STUB_ROLE` set) it is the stub peer.
#[test]
fn stub_child_entry() {
    if std::env::var(ROLE).as_deref() == Ok("agent") {
        run_stub(&std::env::var(MODE).unwrap_or_default());
        std::process::exit(0);
    }
}

// ---- rig -------------------------------------------------------------------------------------------------------------

struct Host {
    root: PathBuf,
}

impl HostEnv for Host {
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

fn stub_config(mode: &str, log: &std::path::Path) -> AgentConfig {
    let log = log.to_string_lossy().into_owned();
    AgentConfig {
        id: "stub".into(),
        label: "Stub".into(),
        command: std::env::current_exe().expect("test exe").to_string_lossy().into_owned(),
        args: ["--exact", "acp::hardening_tests::stub_child_entry", "--nocapture", "--test-threads=1"].iter().map(|a| a.to_string()).collect(),
        env: [(ROLE, "agent"), (MODE, mode), (LOG, log.as_str())].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        pin_policy: PinPolicy::Off,
        timeouts: Timeouts { request_secs: 20, new_session_secs: 20, load_secs: 20, stdin_write_secs: 2, ..Timeouts::default() },
        ..AgentConfig::default()
    }
}

struct Rig {
    session: Arc<AcpSession>,
    log: Arc<Mutex<Vec<SessionEvent>>>,
    dir: PathBuf,
}

impl Rig {
    fn new(mode: &str, resume: Option<&str>) -> Rig {
        let dir = std::env::temp_dir().join(format!("pm-acp-hard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = stub_config(mode, &dir.join("calls.log"));
        let host: Arc<dyn HostEnv> = Arc::new(Host { root: dir.clone() });
        let params = SessionParams { key: format!("h-{}", uuid::Uuid::new_v4()), cwd: dir.clone(), resume_session_id: resume.map(str::to_string) };
        let session = AcpSession::new(Arc::new(cfg), host, params);
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        session.add_sink(Arc::new(move |event| sink.lock().push(event.clone())));
        Rig { session, log, dir }
    }

    fn wait_event(&self, from: usize, pred: impl Fn(&SessionEvent) -> bool) -> Option<SessionEvent> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(event) = self.log.lock().iter().skip(from).find(|e| pred(e)) {
                return Some(event.clone());
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn turn(&self, text: &str) -> TurnSummary {
        let from = self.log.lock().len();
        self.session.prompt_text(text).unwrap_or_else(|e| panic!("prompt failed: {e}"));
        match self.wait_event(from, |e| matches!(e, SessionEvent::TurnEnded(_))) {
            Some(SessionEvent::TurnEnded(summary)) => summary,
            _ => panic!("the turn did not end"),
        }
    }

    fn text(&self) -> String {
        self.log
            .lock()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::Update { update, replay: false } => match serde_json::to_value(update.as_ref()) {
                    Ok(v) if v["sessionUpdate"] == "agent_message_chunk" => v["content"]["text"].as_str().map(str::to_string),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }

    fn calls(&self) -> String {
        std::fs::read_to_string(self.dir.join("calls.log")).unwrap_or_default()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.session.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---- items -----------------------------------------------------------------------------------------------------------

#[test]
fn turn_cancelled_without_our_cancel_is_an_error() {
    let rig = Rig::new("cancelled", None);
    let summary = rig.turn("hi");
    assert_eq!(summary.stop, StopKind::Failed, "{summary:?}");
    assert!(!summary.cancel_requested);
    let message = summary.error.expect("a plain message");
    assert!(message.contains("stopped") && !message.contains("stopReason"), "{message}");
    assert!(!rig.calls().contains("cancel"), "we never sent session/cancel");
}

#[test]
fn late_chunks_from_replaced_session_are_dropped() {
    // The old id cannot be restored, so the chat moves to a new session; the agent still sends old-session chunks.
    let rig = Rig::new("late", Some("s-old"));
    let summary = rig.turn("hi");
    assert_eq!(summary.stop, StopKind::EndTurn);
    let snap = rig.session.snapshot();
    assert_eq!(snap.session_id.as_deref(), Some("s-new"));
    assert_eq!(snap.history_lost.as_ref().map(|h| h.old_session_id.as_str()), Some("s-old"));
    assert_eq!(rig.text(), "hello ", "only the new session's text is shown");
    assert_eq!(rig.session.stats().foreign_updates, 2);
}

#[test]
fn models_and_modes_republished_as_config_options() {
    let rig = Rig::new("modes_only", None);
    rig.session.ensure_running().unwrap();
    let snap = rig.session.snapshot();
    let ids: Vec<&str> = snap.config_options.iter().filter_map(|o| o["id"].as_str()).collect();
    assert_eq!(ids, vec!["model", "mode"], "{:?}", snap.config_options);
    let model = &snap.config_options[0];
    assert_eq!(model["currentValue"], json!("m1"));
    assert_eq!(model["options"][1], json!({"value": "m2", "name": "Model Two"}));
    assert_eq!(snap.config_options[1]["currentValue"], json!("ask"));
    assert!(snap.modes.is_some(), "the modes object is still published");
    // Picking goes out as the agent's own methods, and the shown option follows.
    rig.session.set_config_option("model", json!("m2")).unwrap();
    rig.session.set_config_option("mode", json!("code")).unwrap();
    let calls = rig.calls();
    assert!(calls.contains("set_model m2") && calls.contains("set_mode code"), "{calls}");
    let snap = rig.session.snapshot();
    assert_eq!(snap.config_options[0]["currentValue"], json!("m2"));
    assert_eq!(snap.config_options[1]["currentValue"], json!("code"));
    // An agent that sends configOptions keeps exactly those.
    let own = super::handshake::parse_session_info(&json!({"configOptions": [{"id": "x"}], "modes": {"currentModeId": "a", "availableModes": [{"id": "a", "name": "A"}]}}));
    assert_eq!(own.config_options, vec![json!({"id": "x"})]);
}

#[test]
fn python_runtime_gets_utf8_and_unbuffered_env() {
    let host = Host { root: std::env::temp_dir() };
    let value = |env: &[(std::ffi::OsString, std::ffi::OsString)], name: &str| env.iter().find(|(n, _)| n.to_string_lossy() == name).map(|(_, v)| v.to_string_lossy().into_owned());
    let python = config::from_toml_text("p", "P", "command = \"py\"\nruntime = \"python\"\n").unwrap();
    let env = config::build_env(&python, &host, None);
    assert_eq!(value(&env, "PYTHONUTF8").as_deref(), Some("1"));
    assert_eq!(value(&env, "PYTHONUNBUFFERED").as_deref(), Some("1"));
    // Default off: no runtime, no extra variables.
    let plain = config::from_toml_text("n", "N", "command = \"node\"\n").unwrap();
    let env = config::build_env(&plain, &host, None);
    assert!(value(&env, "PYTHONUTF8").is_none() && value(&env, "PYTHONUNBUFFERED").is_none());
    // The definition's own env wins; an unknown runtime is refused.
    let own = config::from_toml_text("o", "O", "command = \"py\"\nruntime = \"python\"\n[env]\nPYTHONUTF8 = \"0\"\n").unwrap();
    assert_eq!(value(&config::build_env(&own, &host, None), "PYTHONUTF8").as_deref(), Some("0"));
    assert!(config::from_toml_text("b", "B", "command = \"x\"\nruntime = \"cobol\"\n").is_err());
}

#[test]
fn a_child_that_closes_stdout_in_the_middle_of_a_line_ends_the_turn_cleanly() {
    let rig = Rig::new("burst_eof", None);
    let started = Instant::now();
    let summary = rig.turn("hi");
    assert!(started.elapsed() < Duration::from_secs(25), "the turn must not hang");
    assert_eq!(summary.stop, StopKind::Failed, "{summary:?}");
    assert!(rig.text().starts_with("b0 b1 "), "the burst that arrived whole is kept");
    assert!(rig.wait_event(0, |e| matches!(e, SessionEvent::Exited(_))).is_some(), "the exit is reported");
}
