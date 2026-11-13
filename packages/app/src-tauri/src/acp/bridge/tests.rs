//! Tests of the bridge with a fake headless agent: the unit-test executable starts itself again as the agent
//! (the one test `child_entry`, chosen by `PM_BRIDGE_ROLE`), like `acp/fake_agent.rs` does. No real agent runs.

use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::*;
use crate::acp::bridge::extras::ModelListCommand;
use crate::proc_util::pid_alive;
use crate::tui::{Features, HeadlessLaunch, LaunchSpec, TuiProfile};

const ROLE: &str = "PM_BRIDGE_ROLE";
const TASK: &str = "PM_BRIDGE_TASK";
const RESUME: &str = "PM_BRIDGE_RESUME";
const DIR: &str = "PM_BRIDGE_DIR";
const MEMORY: &str = "PM_BRIDGE_MEMORY";
const MODEL: &str = "PM_BRIDGE_MODEL";
const HARNESS: [&str; 4] = ["--exact", "acp::bridge::tests::child_entry", "--nocapture", "--test-threads=1"];
const SECRET: &str = "sk-abcdefghijk123";

/// The agent under test: a headless command that re-runs this test exe in the `headless` role.
struct FakeProfile {
    memory: bool,
    headless: bool,
    dir: PathBuf,
    /// The definition names a model-list command (and a model flag).
    list: bool,
    /// The definition has `[headless.output.tool]` rules.
    tools: bool,
}

impl FakeProfile {
    fn new(memory: bool, dir: PathBuf) -> FakeProfile {
        FakeProfile { memory, headless: true, dir, list: false, tools: false }
    }
}

const TOOL_RULES: &str = r#"
id = "id"
title = "name"
input = "input"
output = "out"
[start]
where = { type = "tool", phase = "start" }
[finish]
where = { type = "tool", phase = "end" }
[failed]
where = { ok = false }
"#;

impl TuiProfile for FakeProfile {
    fn id(&self) -> &'static str {
        "bridgefake"
    }

    fn features(&self) -> Features {
        Features { resumable_headless: self.memory, ..Features::CLI }
    }

    fn headless_command(&self, launch: &HeadlessLaunch) -> Result<LaunchSpec, String> {
        if !self.headless {
            return Err("headless launch is unsupported for agent type: bridgefake".into());
        }
        let mut env = vec![
            (ROLE.to_string(), "headless".to_string()),
            (TASK.to_string(), launch.task.to_string()),
            (DIR.to_string(), self.dir.to_string_lossy().into_owned()),
            ("RUST_TEST_NOCAPTURE".to_string(), "1".to_string()),
            ("RUST_TEST_THREADS".to_string(), "1".to_string()),
        ];
        if let Some(resume) = launch.resume_session {
            env.push((RESUME.to_string(), resume.to_string()));
        }
        if let Some(model) = launch.model {
            env.push((MODEL.to_string(), model.to_string()));
        }
        Ok(LaunchSpec {
            program: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
            args: HARNESS.iter().map(|a| a.to_string()).collect(),
            cwd: PathBuf::from(launch.project),
            read_only_enforced: false,
            env,
            env_remove: Vec::new(),
        })
    }

    fn accepts_headless_model(&self) -> bool {
        self.list
    }

    fn bridge_tables(&self) -> Option<DefinitionTables> {
        use crate::tui::declarative::schema::{ModelSource, ModelTable};
        let model = if self.list {
            // Three tokens at most (the bridge refuses longer list commands); capture and threads come from the env.
            let argv: Vec<String> = ["--exact", "acp::bridge::tests::child_entry", "list-models"].iter().map(|a| a.to_string()).collect();
            ModelTable { source: ModelSource::ProbeCommand, probe_argv: Some(argv), probe_regex: Some(r"^model:(\S+)$".into()), default: None }
        } else {
            ModelTable::default()
        };
        let tool = self.tools.then(|| toml::from_str(TOOL_RULES).expect("tool rules"));
        Some(DefinitionTables { model, tool })
    }

    fn extract_result(&self, output: &str, exit_code: i32) -> Option<String> {
        if exit_code != 0 {
            return None;
        }
        if self.tools && output.lines().any(|l| l.starts_with('{')) {
            let text: Vec<String> = output
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
                .filter(|v| v["type"] == "text")
                .filter_map(|v| v["text"].as_str().map(str::to_string))
                .collect();
            return (!text.is_empty()).then(|| text.join("\n"));
        }
        let text: Vec<&str> = output.lines().filter(|l| !l.starts_with("SESSION:") && !l.contains("child_entry") && !l.starts_with("running ")).collect();
        let text = text.join("\n").trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn extract_provider_session(&self, output: &str) -> Option<String> {
        output.lines().find_map(|l| l.strip_prefix("SESSION:").map(str::to_string))
    }
}

/// Not a test when run normally. As a child (role set) it is the fake headless agent, the fake chat bridge, or
/// a process that only sleeps.
#[test]
fn child_entry() {
    let role = std::env::var(ROLE).unwrap_or_default();
    match role.as_str() {
        "headless" => headless_child(),
        "bridge" => {
            // The harness leaves "test ... " unterminated on stdout; the first JSON line must start fresh.
            println!();
            let profile = FakeProfile::new(std::env::var(MEMORY).as_deref() == Ok("1"), PathBuf::from(std::env::var(DIR).unwrap_or_default()));
            serve(Arc::new(profile), "Fake Chat".into(), std::io::stdin().lock(), std::io::stdout(), ServeOptions::default());
            std::process::exit(0);
        }
        "sleeper" => {
            std::thread::sleep(Duration::from_secs(120));
            std::process::exit(0);
        }
        _ => {}
    }
}

/// The fake CLI's model-list command: counts how often it ran, prints three kinds of lines.
fn list_models_child() {
    println!();
    let dir = PathBuf::from(std::env::var(DIR).unwrap_or_default());
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let _ = std::fs::write(dir.join(format!("listed-{nanos}")), "x");
    println!("Available models:");
    println!("model:alpha");
    println!("model:beta");
    println!("model:alpha");
    println!("not a model line");
    std::process::exit(0);
}

fn headless_child() {
    if std::env::args().any(|a| a == "list-models") {
        list_models_child();
    }
    println!();
    let task = std::env::var(TASK).unwrap_or_default();
    let dir = PathBuf::from(std::env::var(DIR).unwrap_or_default());
    let mut words = task.split_whitespace();
    let verb = words.next().unwrap_or("").to_string();
    let count: usize = words.next().and_then(|w| w.parse().ok()).unwrap_or(3);
    match verb.as_str() {
        "stream" => {
            for n in 0..count {
                println!("line{n} done");
                let _ = std::io::stdout().flush();
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        "slow" => {
            let exe = std::env::current_exe().unwrap();
            let mut grandchild = crate::proc_util::hidden_command(exe);
            grandchild.args(HARNESS).env(ROLE, "sleeper").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let grandchild = grandchild.spawn().expect("grandchild");
            // Written whole: the test reads this file while it is being made, and must never see half of a pid.
            let _ = std::fs::write(dir.join("slow.pids.tmp"), format!("{} {}", std::process::id(), grandchild.id()));
            let _ = std::fs::rename(dir.join("slow.pids.tmp"), dir.join("slow.pids"));
            for _ in 0..600 {
                println!("tick");
                let _ = std::io::stdout().flush();
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        "fail" => {
            eprintln!("fatal: key {SECRET} was rejected");
            std::process::exit(3);
        }
        "empty" => {}
        "whichmodel" => {
            println!("using:{}", std::env::var(MODEL).unwrap_or_else(|_| "none".into()));
            println!("SESSION:s-1");
        }
        "remember" | "recall" => {
            // A CLI that keeps one code word per conversation id, on disk, like a real one keeps its history.
            let resume = std::env::var(RESUME).ok();
            let id = resume.clone().unwrap_or_else(|| {
                let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
                format!("cw-{nanos}")
            });
            let file = dir.join(format!("mem-{id}"));
            if verb == "remember" {
                let _ = std::fs::write(&file, task.split_whitespace().nth(1).unwrap_or(""));
                println!("ok");
            } else {
                println!("word:{}", std::fs::read_to_string(&file).unwrap_or_else(|_| "none".into()));
            }
            println!("SESSION:{id}");
        }
        "opentool" | "opentoolhang" => {
            // A card starts and never finishes; a finish for a card nobody started comes too.
            println!("{}", json!({"type": "tool", "phase": "start", "id": "o1", "name": "run", "input": "make"}));
            println!("{}", json!({"type": "tool", "phase": "end", "id": "ghost", "ok": true, "out": "x"}));
            let _ = std::io::stdout().flush();
            if verb == "opentoolhang" {
                let (_keep, rx) = mpsc::channel::<()>();
                let _ = rx.recv_timeout(Duration::from_secs(120));
            }
            std::process::exit(3);
        }
        "tools" => {
            let lines = [
                json!({"type": "tool", "phase": "start", "id": "t1", "name": "read_file", "input": "a.txt"}),
                json!({"type": "tool", "phase": "end", "id": "t1", "ok": true, "out": format!("body {SECRET}")}),
                json!({"type": "tool", "phase": "start", "id": "t2", "name": "run", "input": "make"}),
                json!({"type": "tool", "phase": "end", "id": "t2", "ok": false, "out": "boom"}),
                json!({"type": "text", "text": "all done"}),
            ];
            for line in lines {
                println!("{line}");
                let _ = std::io::stdout().flush();
            }
            println!("SESSION:s-1");
        }
        _ => {
            let resume = std::env::var(RESUME).unwrap_or_else(|_| "none".into());
            println!("got:{task} resume:{resume}");
            println!("SESSION:s-1");
        }
    }
    std::process::exit(0);
}

// ---- in-process rig: serve() on channel-backed pipes -------------------------------------------------------

struct ChanRead {
    rx: mpsc::Receiver<Vec<u8>>,
    rest: Vec<u8>,
}

impl Read for ChanRead {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.rest.is_empty() {
            match self.rx.recv() {
                Ok(bytes) => self.rest = bytes,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.rest.len());
        out[..n].copy_from_slice(&self.rest[..n]);
        self.rest.drain(..n);
        Ok(n)
    }
}

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Rig {
    tx: Option<mpsc::Sender<Vec<u8>>>,
    out: Sink,
    server: Option<std::thread::JoinHandle<()>>,
    dir: PathBuf,
    next_id: u64,
    /// Keep `dir` when the rig is dropped (a test that restarts the bridge on the same folder).
    keep: bool,
}

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-bridge-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fast_limits() -> TurnLimits {
    TurnLimits { extract_every: Duration::from_millis(20), poll: Duration::from_millis(10), ..TurnLimits::default() }
}

impl Rig {
    fn new(memory: bool) -> Rig {
        Rig::with(FakeProfile::new(memory, temp_dir()), fast_limits())
    }

    fn with(profile: FakeProfile, limits: TurnLimits) -> Rig {
        Rig::with_store(profile, limits, None)
    }

    fn with_store(profile: FakeProfile, limits: TurnLimits, store_dir: Option<PathBuf>) -> Rig {
        let dir = profile.dir.clone();
        let (tx, rx) = mpsc::channel();
        let out = Sink::default();
        let sink = out.clone();
        let server = std::thread::spawn(move || {
            serve(Arc::new(profile), "Fake Chat".into(), BufReader::new(ChanRead { rx, rest: Vec::new() }), sink, ServeOptions { read_only: false, limits, store_dir, list_timeout: None });
        });
        Rig { tx: Some(tx), out, server: Some(server), dir, next_id: 0, keep: false }
    }

    fn send_raw(&self, value: Value) {
        self.tx.as_ref().unwrap().send(format!("{value}\n").into_bytes()).unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        self.send_raw(json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}));
        self.next_id
    }

    fn lines(&self) -> Vec<Value> {
        String::from_utf8_lossy(&self.out.0.lock()).lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    fn response(&self, id: u64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(found) = self.lines().into_iter().find(|v| v["id"] == id && v.get("method").is_none()) {
                return found;
            }
            assert!(Instant::now() < deadline, "no answer to request {id}; got {:#?}", self.lines());
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn init(&mut self) -> String {
        let id = self.request("initialize", json!({"protocolVersion": 1}));
        assert!(self.response(id).get("result").is_some());
        let id = self.request("session/new", json!({"cwd": self.dir.to_string_lossy(), "mcpServers": []}));
        self.response(id)["result"]["sessionId"].as_str().unwrap().to_string()
    }

    fn prompt(&mut self, session: &str, text: &str) -> u64 {
        self.request("session/prompt", json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]}))
    }

    /// The chunks sent so far for `session`, in order, with the time they were first seen.
    /// Waits (with a deadline) until `n` tool-card updates were sent.
    fn wait_cards(&self, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while tool_updates(self).len() < n {
            assert!(Instant::now() < deadline, "no tool card; got {:#?}", self.lines());
            std::thread::park_timeout(Duration::from_millis(5));
        }
    }

    fn chunks(&self) -> Vec<String> {
        self.lines()
            .iter()
            .filter(|v| v["method"] == "session/update" && v["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
            .map(|v| v["params"]["update"]["content"]["text"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn wait_chunks(&self, secs: u64, pred: impl Fn(&[String]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while !pred(&self.chunks()) {
            assert!(Instant::now() < deadline, "chunks never matched: {:?}", self.chunks());
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn wait_dead(pid: u32, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !pid_alive(pid)
}

fn pids(dir: &std::path::Path) -> Vec<u32> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = std::fs::read_to_string(dir.join("slow.pids")) {
            let found: Vec<u32> = text.split_whitespace().filter_map(|p| p.parse().ok()).collect();
            if found.len() == 2 {
                return found;
            }
        }
        assert!(Instant::now() < deadline, "the slow agent never wrote its pids");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ---- protocol ----------------------------------------------------------------------------------------------

#[test]
fn initialize_says_text_only_load_only_with_memory_and_the_agents_label() {
    let mut rig = Rig::new(true);
    let id = rig.request("initialize", json!({"protocolVersion": 1, "clientCapabilities": {}}));
    let reply = rig.response(id);
    let result = &reply["result"];
    assert_eq!(result["protocolVersion"], 1);
    assert_eq!(result["agentInfo"]["name"], "Fake Chat");
    assert_eq!(result["agentCapabilities"]["loadSession"], true, "an agent that can resume offers session/load");
    assert_eq!(result["agentCapabilities"]["promptCapabilities"]["image"], false);
    assert_eq!(result["authMethods"], json!([]));
    // An agent with no resume mechanism has nothing to load.
    let mut rig = Rig::new(false);
    let id = rig.request("initialize", json!({"protocolVersion": 1}));
    assert_eq!(rig.response(id)["result"]["agentCapabilities"]["loadSession"], false);
    let id = rig.request("session/load", json!({"sessionId": "x", "cwd": ".", "mcpServers": []}));
    assert_eq!(rig.response(id)["error"]["code"], -32601);
}

#[test]
fn an_agent_with_no_headless_mode_is_refused_on_initialize() {
    let profile = FakeProfile { headless: false, ..FakeProfile::new(false, temp_dir()) };
    let dir = profile.dir.clone();
    let mut rig = Rig::with(profile, fast_limits());
    let id = rig.request("initialize", json!({"protocolVersion": 1}));
    let reply = rig.response(id);
    assert_eq!(reply["error"]["message"], "Fake Chat has no non-interactive mode, so a chat adapter cannot be made");
    // The bridge ends after refusing.
    let server = rig.server.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !server.is_finished() {
        assert!(Instant::now() < deadline, "the bridge kept running");
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = server.join();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_prompt_streams_chunks_while_the_agent_runs_and_ends_with_end_turn() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    let started = Instant::now();
    let id = rig.prompt(&session, "stream 4");
    // The first line is forwarded long before the agent (4 x 250 ms) is done.
    rig.wait_chunks(10, |c| c.concat().contains("line0"));
    assert!(started.elapsed() < Duration::from_millis(900), "first chunk came only at the end: {:?}", started.elapsed());
    let reply = rig.response(id);
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    let chunks = rig.chunks();
    assert!(chunks.len() >= 2, "expected the answer in several chunks: {chunks:?}");
    let text = chunks.concat();
    for n in 0..4 {
        assert!(text.contains(&format!("line{n} done")), "{text:?}");
    }
    // Every chunk went out before the answer to the prompt.
    let lines = rig.lines();
    let answer_at = lines.iter().position(|v| v["id"] == id).unwrap();
    let last_chunk_at = lines.iter().rposition(|v| v["method"] == "session/update").unwrap();
    assert!(last_chunk_at < answer_at);
    // A memory agent has no notice.
    assert!(!text.contains("no conversation memory"));
}

#[test]
fn without_memory_the_first_message_says_so_once() {
    let mut rig = Rig::new(false);
    let session = rig.init();
    let id = rig.prompt(&session, "echo one");
    assert_eq!(rig.response(id)["result"]["stopReason"], "end_turn");
    let first = rig.chunks();
    assert_eq!(first[0], format!("{NO_MEMORY_NOTICE}\n\n"));
    let id = rig.prompt(&session, "echo two");
    assert_eq!(rig.response(id)["result"]["stopReason"], "end_turn");
    let all = rig.chunks().concat();
    assert_eq!(all.matches("no conversation memory").count(), 1, "{all:?}");
    // And turn 2 started fresh although the output carried a session id.
    assert!(all.contains("got:echo two resume:none"), "{all:?}");
}

#[test]
fn with_memory_the_second_turn_resumes_the_first() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    let id = rig.prompt(&session, "echo one");
    rig.response(id);
    assert!(rig.chunks().concat().contains("got:echo one resume:none"));
    let before = rig.chunks().len();
    let id = rig.prompt(&session, "echo two");
    rig.response(id);
    let second = rig.chunks()[before..].concat();
    assert!(second.contains("got:echo two resume:s-1"), "{second:?}");
    // Another session starts its own conversation.
    let other = {
        let id = rig.request("session/new", json!({"cwd": rig.dir.to_string_lossy()}));
        rig.response(id)["result"]["sessionId"].as_str().unwrap().to_string()
    };
    let before = rig.chunks().len();
    let id = rig.prompt(&other, "echo three");
    rig.response(id);
    assert!(rig.chunks()[before..].concat().contains("resume:none"));
}

#[test]
fn cancel_kills_the_whole_process_tree() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    let id = rig.prompt(&session, "slow");
    rig.wait_chunks(15, |c| c.concat().contains("tick"));
    let pids = pids(&rig.dir);
    assert!(pids.iter().all(|p| pid_alive(*p)), "the agent and its helper run before the cancel");
    rig.send_raw(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}));
    assert_eq!(rig.response(id)["result"]["stopReason"], "cancelled");
    for pid in pids {
        assert!(wait_dead(pid, 10), "process {pid} survived the cancel");
    }
    // The next message works.
    let id = rig.prompt(&session, "echo again");
    assert_eq!(rig.response(id)["result"]["stopReason"], "end_turn");
}

#[test]
fn a_failing_agent_gives_one_plain_sentence_without_secrets() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    let id = rig.prompt(&session, "fail");
    let reply = rig.response(id);
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("Fake Chat stopped with an error (exit code 3)."), "{message}");
    assert!(message.contains("It said:") && message.contains("was rejected"), "{message}");
    assert!(!message.contains(SECRET), "a secret reached the host: {message}");
    assert_ne!(reply["error"]["code"], -32000, "-32000 means sign in first to the host");
}

#[test]
fn an_agent_that_prints_nothing_is_an_error_not_an_empty_answer() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    let id = rig.prompt(&session, "empty");
    let reply = rig.response(id);
    assert!(reply["error"]["message"].as_str().unwrap_or_default().contains("did not give an answer this app can read"), "{reply} {:?}", rig.lines());
}

#[test]
fn a_turn_past_the_time_limit_is_stopped_with_a_sentence() {
    let limits = TurnLimits { timeout: Duration::from_millis(600), ..fast_limits() };
    let mut rig = Rig::with(FakeProfile::new(true, temp_dir()), limits);
    let session = rig.init();
    let id = rig.prompt(&session, "slow");
    let reply = rig.response(id);
    assert!(reply["error"]["message"].as_str().unwrap().contains("took longer than"), "{reply}");
    for pid in pids(&rig.dir) {
        assert!(wait_dead(pid, 10), "process {pid} survived the time limit");
    }
}

#[test]
fn a_second_message_while_one_runs_is_refused_and_bad_prompts_are_rejected() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    let first = rig.prompt(&session, "slow");
    rig.wait_chunks(15, |c| c.concat().contains("tick"));
    let second = rig.prompt(&session, "echo x");
    assert!(rig.response(second)["error"]["message"].as_str().unwrap().contains("still being answered"));
    let image_only = rig.request("session/prompt", json!({"sessionId": session, "prompt": [{"type": "image", "data": "x", "mimeType": "image/png"}]}));
    assert_eq!(rig.response(image_only)["error"]["code"], -32602);
    let unknown = rig.request("session/prompt", json!({"sessionId": "nope", "prompt": [{"type": "text", "text": "hi"}]}));
    assert_eq!(rig.response(unknown)["error"]["code"], -32602);
    rig.send_raw(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}));
    assert_eq!(rig.response(first)["result"]["stopReason"], "cancelled");
}

#[test]
fn closing_the_host_pipe_stops_a_running_agent() {
    let mut rig = Rig::new(true);
    let session = rig.init();
    rig.prompt(&session, "slow");
    rig.wait_chunks(15, |c| c.concat().contains("tick"));
    let pids = pids(&rig.dir);
    rig.tx.take();
    let server = rig.server.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !server.is_finished() {
        assert!(Instant::now() < deadline, "the bridge outlived its host");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = server.join();
    for pid in pids {
        assert!(wait_dead(pid, 10), "process {pid} outlived the host");
    }
}

// ---- the API -----------------------------------------------------------------------------------------------

#[test]
fn info_says_whether_there_is_memory_and_refuses_no_headless() {
    let with = info_for_profile(&FakeProfile::new(true, PathBuf::new()), "Fake Chat").unwrap();
    assert!(with.has_memory && with.note.contains("continue the same conversation"));
    let without = info_for_profile(&FakeProfile::new(false, PathBuf::new()), "Fake Chat").unwrap();
    assert!(!without.has_memory && without.note.contains("each message starts fresh"));
    let refused = info_for_profile(&FakeProfile { headless: false, ..FakeProfile::new(false, PathBuf::new()) }, "Fake Chat").unwrap_err();
    assert_eq!(refused, "Fake Chat has no non-interactive mode, so a chat adapter cannot be made");
}

#[test]
fn the_real_registry_answers_and_a_shell_is_not_an_agent_to_bridge() {
    let shell = available_for("powershell").unwrap_err();
    assert!(shell.contains("cannot be made"), "{shell}");
    assert!(available_for("definitely-not-an-agent").unwrap_err().contains("not a known agent"));
    // A registered agent with a headless mode gets a spec: this exe, the subcommand, the agent id.
    let ids: Vec<String> = crate::tui::registered_agent_ids();
    let bridgeable = ids.iter().find(|id| available_for(id).is_ok()).expect("some registered agent has a headless mode");
    let spec = spawn_spec(bridgeable).unwrap();
    assert_eq!(PathBuf::from(&spec.program), std::env::current_exe().unwrap());
    assert_eq!(spec.args, ["acp-bridge", "--agent", bridgeable.as_str()].map(std::ffi::OsString::from));
    assert!(spec.env.iter().any(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH")), "the bridge needs PATH");
    assert!(spawn_spec("powershell").is_err());
}

#[test]
fn the_command_line_is_ours_only_for_the_subcommand() {
    assert_eq!(run_cli(&[]), None);
    assert_eq!(run_cli(&["--new-pane".into(), "x".into()]), None);
    assert_eq!(run_cli(&["acp-bridge".into()]), Some(2));
    assert_eq!(run_cli(&["acp-bridge".into(), "--bogus".into()]), Some(2));
}

// ---- bridge v2: model chip, tool cards, resume ------------------------------------------------------------------

fn option_values(options: &Value) -> Vec<String> {
    options[0]["options"].as_array().unwrap().iter().map(|o| o["value"].as_str().unwrap().to_string()).collect()
}

fn listed(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("listed-")).count()
}

#[test]
fn bridge_model_chip_from_cli_list() {
    let mut rig = Rig::with(FakeProfile { list: true, ..FakeProfile::new(true, temp_dir()) }, fast_limits());
    let id = rig.request("initialize", json!({"protocolVersion": 1}));
    rig.response(id);
    let id = rig.request("session/new", json!({"cwd": rig.dir.to_string_lossy(), "mcpServers": []}));
    let reply = rig.response(id);
    let options = &reply["result"]["configOptions"];
    assert_eq!(options[0]["id"], "model");
    assert_eq!(options[0]["category"], "model");
    assert_eq!(options[0]["type"], "select");
    assert_eq!(options[0]["currentValue"], "", "nothing is chosen until the person picks: no guess");
    // The agent's default first, then the CLI's own list, once each, in its order.
    assert_eq!(option_values(options), ["", "alpha", "beta"]);
    let session = reply["result"]["sessionId"].as_str().unwrap().to_string();

    // Before a pick, no model flag goes out.
    let id = rig.prompt(&session, "whichmodel");
    rig.response(id);
    assert!(rig.chunks().concat().contains("using:none"), "{:?}", rig.chunks());

    // A pick is checked against the list and then rides on the next turn.
    let id = rig.request("session/set_config_option", json!({"sessionId": session, "configId": "model", "value": "beta"}));
    assert_eq!(rig.response(id)["result"]["configOptions"][0]["currentValue"], "beta");
    let id = rig.request("session/set_config_option", json!({"sessionId": session, "configId": "model", "value": "not-in-the-list"}));
    assert_eq!(rig.response(id)["error"]["code"], -32602);
    let id = rig.request("session/set_config_option", json!({"sessionId": session, "configId": "effort", "value": "high"}));
    assert_eq!(rig.response(id)["error"]["code"], -32602);
    let before = rig.chunks().len();
    let id = rig.prompt(&session, "whichmodel");
    rig.response(id);
    assert!(rig.chunks()[before..].concat().contains("using:beta"), "{:?}", rig.chunks());

    // Back to the default: no flag again.
    let id = rig.request("session/set_config_option", json!({"sessionId": session, "configId": "model", "value": ""}));
    rig.response(id);
    let before = rig.chunks().len();
    let id = rig.prompt(&session, "whichmodel");
    rig.response(id);
    assert!(rig.chunks()[before..].concat().contains("using:none"));

    // Another chat shows the same list, and the CLI was asked for it exactly once.
    let id = rig.request("session/new", json!({"cwd": rig.dir.to_string_lossy()}));
    assert_eq!(option_values(&rig.response(id)["result"]["configOptions"]), ["", "alpha", "beta"]);
    assert_eq!(listed(&rig.dir), 1, "the list command ran more than once");
}

#[test]
fn bridge_no_model_option_without_list_command() {
    let mut rig = Rig::new(true);
    let id = rig.request("initialize", json!({"protocolVersion": 1}));
    rig.response(id);
    let id = rig.request("session/new", json!({"cwd": rig.dir.to_string_lossy(), "mcpServers": []}));
    let reply = rig.response(id);
    assert!(reply["result"].get("configOptions").is_none(), "{reply}");
    let session = reply["result"]["sessionId"].as_str().unwrap().to_string();
    let id = rig.request("session/set_config_option", json!({"sessionId": session, "configId": "model", "value": "alpha"}));
    assert_eq!(rig.response(id)["error"]["code"], -32602);
    assert_eq!(listed(&rig.dir), 0, "nothing was run to look for models");
}

#[test]
fn bridge_tool_lines_become_tool_cards() {
    let mut rig = Rig::with(FakeProfile { tools: true, ..FakeProfile::new(true, temp_dir()) }, fast_limits());
    let session = rig.init();
    let id = rig.prompt(&session, "tools");
    assert_eq!(rig.response(id)["result"]["stopReason"], "end_turn");
    let updates: Vec<Value> = rig
        .lines()
        .into_iter()
        .filter(|v| v["method"] == "session/update")
        .map(|v| v["params"]["update"].clone())
        .filter(|u| u["sessionUpdate"] != "agent_message_chunk")
        .collect();
    let kinds: Vec<(&str, &str)> = updates.iter().map(|u| (u["sessionUpdate"].as_str().unwrap(), u["toolCallId"].as_str().unwrap())).collect();
    assert_eq!(kinds, [("tool_call", "t1"), ("tool_call_update", "t1"), ("tool_call", "t2"), ("tool_call_update", "t2")], "{updates:#?}");
    assert_eq!(updates[0]["title"], "read_file");
    assert_eq!(updates[0]["status"], "in_progress");
    assert_eq!(updates[0]["rawInput"], "a.txt");
    assert_eq!(updates[1]["status"], "completed");
    assert_eq!(updates[3]["status"], "failed");
    let shown = updates[1]["content"][0]["content"]["text"].as_str().unwrap();
    assert!(shown.starts_with("body ") && !shown.contains(SECRET), "a secret in tool output must be redacted: {shown:?}");
    // The answer is still the agent's text, and the cards came before the end of the turn.
    assert_eq!(rig.chunks().concat(), "all done");
    let lines = rig.lines();
    let answer_at = lines.iter().position(|v| v["id"] == id).unwrap();
    assert!(lines.iter().rposition(|v| v["params"]["update"]["sessionUpdate"] == "tool_call_update").unwrap() < answer_at);

    // Plain text stays text.
    let before = rig.lines().len();
    let id = rig.prompt(&session, "echo hello");
    rig.response(id);
    let after = rig.lines()[before..].to_vec();
    assert!(after.iter().all(|v| !v["params"]["update"]["sessionUpdate"].as_str().is_some_and(|k| k.starts_with("tool_call"))), "{after:#?}");
    assert!(rig.chunks().concat().contains("got:echo hello"));

    // An agent whose definition has no tool rules gets no cards from the same lines.
    let mut rig = Rig::with(FakeProfile { tools: false, ..FakeProfile::new(true, temp_dir()) }, fast_limits());
    let session = rig.init();
    let id = rig.prompt(&session, "tools");
    rig.response(id);
    assert!(rig.lines().iter().all(|v| !v["params"]["update"]["sessionUpdate"].as_str().is_some_and(|k| k.starts_with("tool_call"))));
}

fn tool_updates(rig: &Rig) -> Vec<(String, String, String)> {
    rig.lines()
        .into_iter()
        .map(|v| v["params"]["update"].clone())
        .filter(|u| u["sessionUpdate"].as_str().is_some_and(|k| k.starts_with("tool_call")))
        .map(|u| (u["sessionUpdate"].to_string(), u["toolCallId"].to_string(), u["status"].to_string()))
        .collect()
}

#[test]
fn open_tool_cards_are_closed_when_a_turn_fails_or_is_cancelled() {
    let mut rig = Rig::with(FakeProfile { tools: true, ..FakeProfile::new(true, temp_dir()) }, fast_limits());
    let session = rig.init();
    let id = rig.prompt(&session, "opentool");
    assert!(rig.response(id).get("error").is_some(), "the agent exits with an error");
    let cards = tool_updates(&rig);
    let q = |s: &str| format!("\"{s}\"");
    assert_eq!(cards, [(q("tool_call"), q("o1"), q("in_progress")), (q("tool_call_update"), q("o1"), q("failed"))], "a finish for an unknown card is dropped: {cards:?}");

    let id = rig.prompt(&session, "opentoolhang");
    rig.wait_cards(3);
    rig.send_raw(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}));
    assert_eq!(rig.response(id)["result"]["stopReason"], "cancelled");
    let cards = tool_updates(&rig);
    assert_eq!(cards.len(), 4, "{cards:?}");
    assert_eq!(cards[3], (q("tool_call_update"), q("o1"), q("failed")));
}

#[test]
fn leading_dash_ids_are_never_selectable_or_resumed() {
    let cmd = ModelListCommand::from_table(&crate::tui::declarative::schema::ModelTable {
        source: crate::tui::declarative::schema::ModelSource::ProbeCommand,
        probe_argv: Some(vec!["--list-models".into()]),
        probe_regex: Some(r"^(\S+)$".into()),
        default: None,
    })
    .expect("a plain list command");
    assert_eq!(cmd.parse("--evil
-x
alpha
"), ["alpha"]);
}

#[test]
fn bridge_refuses_probe_argv_with_bypass_flag() {
    use crate::tui::declarative::schema::{ModelSource, ModelTable};
    let table = |argv: &[&str]| ModelTable {
        source: ModelSource::ProbeCommand,
        probe_argv: Some(argv.iter().map(|a| a.to_string()).collect()),
        probe_regex: Some("(.+)".into()),
        default: None,
    };
    assert!(ModelListCommand::from_table(&table(&["models", "list"])).is_some());
    assert!(ModelListCommand::from_table(&table(&["--list-models"])).is_some());
    for bad in [
        vec!["-p", "delete the tests", "--dangerously-skip-permissions"],
        vec!["models", "--yolo"],
        vec!["--dangerously-skip-permissions"],
        vec!["a", "b", "c", "d"],
        vec!["ask", "delete the tests"],
        vec!["run", "{task}"],
    ] {
        assert!(ModelListCommand::from_table(&table(&bad)).is_none(), "{bad:?}");
    }
}

#[test]
fn session_load_in_other_folder_is_invalid_params() {
    let dir = temp_dir();
    let store = temp_dir();
    let other = temp_dir();
    let mut first = Rig::with_store(FakeProfile::new(true, dir.clone()), fast_limits(), Some(store.clone()));
    first.keep = true;
    let chat = first.init();
    let id = first.prompt(&chat, "remember pineapple");
    first.response(id);
    drop(first);

    let mut second = Rig::with_store(FakeProfile::new(true, dir.clone()), fast_limits(), Some(store.clone()));
    second.keep = true;
    let id = second.request("initialize", json!({"protocolVersion": 1}));
    second.response(id);
    let id = second.request("session/load", json!({"sessionId": chat, "cwd": other.to_string_lossy(), "mcpServers": []}));
    let reply = second.response(id);
    assert_eq!(reply["error"]["code"], -32602, "{reply}");
    // The chat was not created in the other folder: the right folder still brings it back.
    let id = second.request("session/load", json!({"sessionId": chat, "cwd": dir.to_string_lossy(), "mcpServers": []}));
    assert!(second.response(id).get("error").is_none());
    // Once held in memory, the other folder is refused the same way.
    let id = second.request("session/load", json!({"sessionId": chat, "cwd": other.to_string_lossy(), "mcpServers": []}));
    assert_eq!(second.response(id)["error"]["code"], -32602);
    second.keep = false;
    drop(second);
    let _ = std::fs::remove_dir_all(store);
    let _ = std::fs::remove_dir_all(other);
}

#[test]
fn resume_recalls_code_word_after_restart() {
    let dir = temp_dir();
    let store = temp_dir();
    let fresh = || FakeProfile::new(true, dir.clone());

    let mut first = Rig::with_store(fresh(), fast_limits(), Some(store.clone()));
    first.keep = true;
    let chat = first.init();
    let id = first.prompt(&chat, "remember pineapple");
    assert_eq!(first.response(id)["result"]["stopReason"], "end_turn");
    drop(first);

    // A new bridge process-equivalent: nothing in memory, only the store and the CLI's own files.
    let mut second = Rig::with_store(fresh(), fast_limits(), Some(store.clone()));
    second.keep = true;
    let id = second.request("initialize", json!({"protocolVersion": 1}));
    assert_eq!(second.response(id)["result"]["agentCapabilities"]["loadSession"], true);
    let id = second.request("session/load", json!({"sessionId": chat, "cwd": dir.to_string_lossy(), "mcpServers": []}));
    assert!(second.response(id).get("error").is_none(), "{:?}", second.lines());
    let id = second.prompt(&chat, "recall");
    assert_eq!(second.response(id)["result"]["stopReason"], "end_turn");
    assert!(second.chunks().concat().contains("word:pineapple"), "{:?}", second.chunks());

    // A new chat in the same bridge does not know the word.
    let other = {
        let id = second.request("session/new", json!({"cwd": dir.to_string_lossy()}));
        second.response(id)["result"]["sessionId"].as_str().unwrap().to_string()
    };
    let before = second.chunks().len();
    let id = second.prompt(&other, "recall");
    second.response(id);
    assert!(second.chunks()[before..].concat().contains("word:none"));
    second.keep = false;
    drop(second);
    let _ = std::fs::remove_dir_all(store);
}

#[test]
fn unknown_session_id_is_invalid_params() {
    let store = temp_dir();
    let mut rig = Rig::with_store(FakeProfile::new(true, temp_dir()), fast_limits(), Some(store.clone()));
    let id = rig.request("initialize", json!({"protocolVersion": 1}));
    rig.response(id);
    let id = rig.request("session/load", json!({"sessionId": "bridge-never-existed", "cwd": rig.dir.to_string_lossy(), "mcpServers": []}));
    let reply = rig.response(id);
    assert_eq!(reply["error"]["code"], -32602);
    assert!(reply["error"]["message"].as_str().unwrap().contains("not remembered"));
    // A chat made but never answered has no conversation to bring back either.
    let chat = rig.init();
    let id = rig.request("session/load", json!({"sessionId": "bridge-other", "cwd": ".", "mcpServers": []}));
    assert_eq!(rig.response(id)["error"]["code"], -32602);
    // Loading a chat this very bridge holds is fine.
    let id = rig.request("session/load", json!({"sessionId": chat, "cwd": rig.dir.to_string_lossy(), "mcpServers": []}));
    assert!(rig.response(id).get("error").is_none());
    let _ = std::fs::remove_dir_all(store);
}

// ---- end to end: the real host code (conn.rs + session.rs) talks to the bridge subprocess -------------------

mod host {
    use super::*;
    use crate::acp::config::{AgentConfig, HostEnv, PinPolicy, Timeouts};
    use crate::acp::session::{AcpSession, Readiness, SessionEvent, SessionParams, StartKind};
    use crate::acp::state::StopKind;

    struct Env(PathBuf);

    impl HostEnv for Env {
        fn var(&self, name: &str) -> Option<std::ffi::OsString> {
            std::env::var_os(name)
        }
        fn which(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn adapters_dir(&self) -> PathBuf {
            self.0.join("adapters")
        }
        fn homes_dir(&self) -> PathBuf {
            self.0.join("homes")
        }
    }

    fn config(dir: &std::path::Path, memory: bool) -> AgentConfig {
        AgentConfig {
            id: "bridgefake".into(),
            label: "Fake Chat".into(),
            command: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
            args: HARNESS.iter().map(|a| a.to_string()).collect(),
            env: [
                (ROLE.to_string(), "bridge".to_string()),
                (DIR.to_string(), dir.to_string_lossy().into_owned()),
                (MEMORY.to_string(), if memory { "1" } else { "0" }.to_string()),
            ]
            .into_iter()
            .collect(),
            pin_policy: PinPolicy::Off,
            timeouts: Timeouts { request_secs: 20, new_session_secs: 20, load_secs: 20, stdin_write_secs: 2, ..Timeouts::default() },
            ..AgentConfig::default()
        }
    }

    struct Chat {
        session: Arc<AcpSession>,
        log: Arc<Mutex<Vec<SessionEvent>>>,
        dir: PathBuf,
    }

    impl Chat {
        fn new(memory: bool) -> Chat {
            let dir = temp_dir();
            let host: Arc<dyn HostEnv> = Arc::new(Env(dir.clone()));
            let session = AcpSession::new(
                Arc::new(config(&dir, memory)),
                host,
                SessionParams { key: format!("bridge-{}", uuid::Uuid::new_v4()), cwd: dir.clone(), resume_session_id: None },
            );
            let log = Arc::new(Mutex::new(Vec::new()));
            let sink = log.clone();
            session.add_sink(Arc::new(move |event| sink.lock().push(event.clone())));
            Chat { session, log, dir }
        }

        fn turn(&self, text: &str) -> crate::acp::state::TurnSummary {
            let from = self.log.lock().len();
            self.session.prompt_text(text).unwrap_or_else(|e| panic!("prompt {text:?}: {e}"));
            self.wait_end(from)
        }

        fn wait_end(&self, from: usize) -> crate::acp::state::TurnSummary {
            let deadline = Instant::now() + Duration::from_secs(40);
            loop {
                if let Some(SessionEvent::TurnEnded(summary)) = self.log.lock().iter().skip(from).find(|e| matches!(e, SessionEvent::TurnEnded(_))) {
                    return summary.clone();
                }
                assert!(Instant::now() < deadline, "the turn never ended");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn text_since(&self, from: usize) -> String {
            self.log
                .lock()
                .iter()
                .skip(from)
                .filter_map(|e| match e {
                    SessionEvent::Update { update, replay: false } => match serde_json::to_value(update.as_ref()) {
                        Ok(v) if v["sessionUpdate"] == "agent_message_chunk" => v["content"]["text"].as_str().map(str::to_string),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        }
    }

    impl Drop for Chat {
        fn drop(&mut self) {
            self.session.close();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn the_host_session_chats_through_the_bridge_with_memory() {
        let chat = Chat::new(true);
        assert_eq!(chat.session.ensure_running().unwrap(), Readiness::Started(StartKind::New));
        let caps = chat.session.caps().unwrap();
        assert_eq!(caps.agent_name.as_deref(), Some("Fake Chat"));
        assert!(caps.load_session && !caps.resume && !caps.image_prompts, "a memory agent offers session/load only");
        let summary = chat.turn("echo hello");
        assert_eq!(summary.stop, StopKind::EndTurn, "{summary:?}");
        assert!(chat.text_since(0).contains("got:echo hello resume:none"), "{}", chat.text_since(0));
        let from = chat.log.lock().len();
        let summary = chat.turn("echo again");
        assert_eq!(summary.stop, StopKind::EndTurn);
        assert!(chat.text_since(from).contains("resume:s-1"), "{}", chat.text_since(from));
        assert!(!chat.text_since(0).contains("no conversation memory"));
    }

    #[test]
    fn the_host_sees_the_no_memory_notice_once() {
        let chat = Chat::new(false);
        chat.turn("echo a");
        let from = chat.log.lock().len();
        chat.turn("echo b");
        let all = chat.text_since(0);
        assert_eq!(all.matches("no conversation memory").count(), 1, "{all}");
        assert!(chat.text_since(from).contains("resume:none"));
    }

    #[test]
    fn the_host_cancel_and_failure_paths_work_through_the_bridge() {
        let chat = Chat::new(true);
        // Failure: the host gets the sentence as the turn's error, no secret in it.
        let summary = chat.turn("fail");
        let error = summary.error.clone().unwrap_or_default();
        assert!(error.contains("exit code 3") && !error.contains(SECRET), "{summary:?}");
        // Cancel: the host's Stop reaches the headless process tree.
        let from = chat.log.lock().len();
        chat.session.prompt_text("slow").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !chat.text_since(from).contains("tick") {
            assert!(Instant::now() < deadline, "no output from the slow agent");
            std::thread::sleep(Duration::from_millis(20));
        }
        let pids = pids(&chat.dir);
        chat.session.cancel().unwrap();
        let summary = chat.wait_end(from);
        assert_eq!(summary.stop, StopKind::Cancelled, "{summary:?}");
        for pid in pids {
            assert!(wait_dead(pid, 10), "process {pid} survived the host's stop");
        }
        // The chat is still usable.
        assert_eq!(chat.turn("echo after").stop, StopKind::EndTurn);
    }

    /// A conversation started from a `source: "bridge"` overlay agent: the overlay resolves the app exe + `acp-bridge`,
    /// the test swaps in the fake bridge process (the unit-test exe is not the app), the rest of the config is the
    /// overlay's own.
    struct BridgeSource {
        store: crate::acp::overlay::OverlayStore,
        fake: AgentConfig,
    }

    impl crate::acp::conversations::AgentSource for BridgeSource {
        fn config(&self, agent: &str) -> Option<Arc<AgentConfig>> {
            let mut cfg = crate::acp::overlay::resolve_with(&self.store, agent, None, Some("Fake Chat".into()))?;
            assert_eq!(PathBuf::from(&cfg.command), std::env::current_exe().unwrap());
            assert_eq!(cfg.args, ["acp-bridge", "--agent", agent]);
            assert!(cfg.resume_command.is_empty() && cfg.env_allow.is_empty());
            cfg.command = self.fake.command.clone();
            cfg.args = self.fake.args.clone();
            cfg.env = self.fake.env.clone();
            Some(Arc::new(cfg))
        }
    }

    #[test]
    fn a_conversation_starts_from_a_bridge_overlay_agent() {
        use crate::acp::conversations::Conversations;
        use crate::acp::record::RecordStore;
        use crate::acp::supervisor::{Supervisor, SupervisorConfig};
        let dir = temp_dir();
        let store = crate::acp::overlay::OverlayStore::at(dir.join("acp_overlay.json"));
        let agent = crate::tui::registered_agent_ids().into_iter().find(|id| available_for(id).is_ok()).expect("a headless agent");
        store.put_item(&agent, &crate::acp::overlay::OverlayItem::Bridge(crate::acp::overlay::BridgeEntry { raw: json!({"source": "bridge"}) })).unwrap();
        let source = Arc::new(BridgeSource { store: store.clone(), fake: config(&dir, true) });
        let host: Arc<dyn HostEnv> = Arc::new(Env(dir.clone()));
        let conversations = Conversations::new(RecordStore::at(dir.join("conversations.json")), Arc::new(Supervisor::new(SupervisorConfig::default())), host, source);
        let view = conversations.create(&agent, &dir).expect("create from the bridge overlay");
        let session = conversations.session(&view.id).unwrap();
        session.prompt_text("echo hello").unwrap();
        let snap = session.wait_for(|s| s.turn >= 1 && !s.turn_in_flight(), Duration::from_secs(40));
        assert!(snap.is_some(), "the turn did not finish");
        session.close();
        store.remove(&agent).unwrap();
        assert!(conversations.create(&agent, &dir).is_err(), "removing the overlay removes the agent for new chats");
        let _ = std::fs::remove_dir_all(dir);
    }
}
