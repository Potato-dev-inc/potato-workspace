//! Shim resilience: endpoint identity, restart recovery, cancel, busy, keys, drift, error contract.
//! Each test runs its own fake bridge on an ephemeral port and points only its own MCP session at
//! it (`TEST_ENDPOINTS`), so nothing here touches process-wide env vars or a real app.

use super::*;
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

// ---- a scriptable fake bridge ----

#[derive(Clone)]
enum Reply {
    Json(u16, Value),
    /// Like `Reset`, and the listener goes away too (the app is down until `restart`).
    ResetAndDie,
    /// Answer 200 after this long (a run that is still going).
    HoldThenOk(Duration, Value),
}

type Handler = Arc<dyn Fn(&str, &str, &Value, usize) -> Reply + Send + Sync>;

struct FakeBridge {
    session: String,
    port_file: PathBuf,
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
    handler: Handler,
    stop: Arc<AtomicBool>,
}

impl FakeBridge {
    fn start(handler: impl Fn(&str, &str, &Value, usize) -> Reply + Send + Sync + 'static) -> Self {
        let session = uuid::Uuid::new_v4().to_string();
        let port_file = std::env::temp_dir().join(format!("pm-fake-bridge-{session}.port"));
        TEST_ENDPOINTS.lock().unwrap().push((session.clone(), port_file.clone()));
        let bridge = Self {
            session,
            port_file,
            requests: Arc::new(Mutex::new(Vec::new())),
            handler: Arc::new(handler),
            stop: Arc::new(AtomicBool::new(false)),
        };
        bridge.listen();
        bridge
    }

    /// Opens a new listener (a fresh port) and publishes it in the port file.
    fn listen(&self) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        fs::write(&self.port_file, format!("127.0.0.1:{}\n", listener.local_addr().unwrap().port())).unwrap();
        // `self.stop` is the flag that ends the current listener generation.
        let live = self.stop.clone();
        live.store(false, Ordering::SeqCst);
        let requests = self.requests.clone();
        let handler = self.handler.clone();
        std::thread::spawn(move || {
            while !live.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let requests = requests.clone();
                        let handler = handler.clone();
                        let live = live.clone();
                        std::thread::spawn(move || serve_connection(stream, requests, handler, live));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
            // `listener` drops here: the port refuses connections from now on.
        });
    }

    /// The app starts again on a new port.
    fn restart(&self) {
        // Let the dead listener's thread exit before a new generation reuses the flag.
        std::thread::sleep(Duration::from_millis(60));
        self.listen();
    }

    fn seen(&self) -> Vec<(String, String, Value)> {
        self.requests.lock().unwrap().clone()
    }

    fn count(&self, path: &str) -> usize {
        self.seen().iter().filter(|(_, p, _)| p == path).count()
    }

    fn wait_for(&self, path: &str, at_least: usize) {
        for _ in 0..400 {
            if self.count(path) >= at_least {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the fake bridge never saw {at_least} request(s) to {path}");
    }

    /// Makes this thread's MCP session talk to the fake.
    fn use_session(&self) {
        set_mcp_session_id(self.session.clone());
    }
}

fn serve_connection(
    mut stream: std::net::TcpStream,
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
    handler: Handler,
    live: Arc<AtomicBool>,
) {
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    let (header_end, length) = loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return, // an endpoint probe: connected and left
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
        }
        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..pos]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            break (pos + 4, length);
        }
    };
    while raw.len() < header_end + length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
        }
    }
    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut first = head.lines().next().unwrap_or_default().split_whitespace();
    let (method, path) = (first.next().unwrap_or_default().to_owned(), first.next().unwrap_or_default().to_owned());
    let body: Value = serde_json::from_slice(&raw[header_end..]).unwrap_or(Value::Null);
    let nth = {
        let mut seen = requests.lock().unwrap();
        let nth = seen.iter().filter(|(_, p, _)| *p == path).count();
        seen.push((method.clone(), path.clone(), body.clone()));
        nth
    };
    let write = |stream: &mut std::net::TcpStream, status: u16, value: &Value| {
        let text = value.to_string();
        let _ = write!(
            stream,
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
            text.len()
        );
    };
    match handler(&method, &path, &body, nth) {
        Reply::Json(status, value) => write(&mut stream, status, &value),
        Reply::ResetAndDie => live.store(true, Ordering::SeqCst),
        Reply::HoldThenOk(delay, value) => {
            std::thread::sleep(delay);
            write(&mut stream, 200, &value);
        }
    }
}

fn ok_json() -> Reply {
    Reply::Json(200, json!({"ok": true, "agents": []}))
}

// ---- stdio harness ----

/// A `Read` fed from a channel, so a test can type lines into the shim while it runs.
struct ChannelReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.recv() {
                Ok(bytes) => self.pending = bytes,
                Err(_) => return Ok(0), // the test closed stdin
            }
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

#[derive(Clone, Default)]
struct SharedOut(Arc<Mutex<Vec<u8>>>);

impl Write for SharedOut {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SharedOut {
    fn lines(&self) -> Vec<Value> {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    fn response_for(&self, id: i64) -> Option<Value> {
        self.lines().into_iter().find(|v| v.get("id") == Some(&json!(id)))
    }
}

struct Stdio {
    input: Sender<Vec<u8>>,
    out: SharedOut,
    server: std::thread::JoinHandle<()>,
}

impl Stdio {
    fn start(session: &str) -> Self {
        let (input, rx) = channel();
        let out = SharedOut::default();
        let session = session.to_owned();
        let sink = out.clone();
        let server = std::thread::spawn(move || {
            serve(session, io::BufReader::new(ChannelReader { rx, pending: Vec::new() }), sink);
        });
        Self { input, out, server }
    }

    fn send(&self, value: Value) {
        self.input.send(format!("{value}\n").into_bytes()).unwrap();
    }

    fn call(&self, id: i64, name: &str, arguments: Value) {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}}));
    }

    fn cancel(&self, id: i64) {
        self.send(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}}));
    }

    fn wait_response(&self, id: i64) -> Value {
        for _ in 0..600 {
            if let Some(v) = self.out.response_for(id) {
                return v;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("no response for id {id}");
    }

    fn finish(self) -> SharedOut {
        drop(self.input);
        self.server.join().unwrap();
        self.out
    }
}

// ---- 1. endpoint identity ----

fn free_port_in(range: std::ops::RangeInclusive<u16>) -> (TcpListener, u16) {
    for port in range {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return (listener, port);
        }
    }
    panic!("no free port in the bridge range");
}

/// Answers every connection with `body` as a JSON HTTP 200 until the test ends.
fn answer_health(listener: TcpListener, body: Value) {
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let body = body.to_string();
            std::thread::spawn(move || {
                let mut chunk = [0_u8; 1024];
                let _ = stream.read(&mut chunk);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
}

#[test]
fn the_probe_covers_the_whole_bridge_range_and_finds_a_port_beyond_the_old_one() {
    assert_eq!(puppet_master_app_lib::app_paths::bridge_port_range_for(None), (17421, 17499));
    // 17431.. was never probed before; any free port there proves the range reaches it.
    let (listener, port) = free_port_in(17440..=17499);
    answer_health(listener, json!({"ok": true, "product": "potato-workspace", "app_instance_id": "abc"}));
    assert!(port > 17430);
    assert_eq!(probe_for_bridge("127.0.0.1", port - 2, port + 2), Some(port));
}

#[test]
fn a_foreign_listener_without_the_product_marker_is_not_taken_for_the_app() {
    let (plain, plain_port) = free_port_in(17440..=17499);
    answer_health(plain, json!({"ok": true}));
    let (other, other_port) = free_port_in(plain_port + 1..=17499);
    answer_health(other, json!({"ok": true, "product": "some-other-app"}));
    assert_eq!(probe_for_bridge("127.0.0.1", plain_port, plain_port), None);
    assert_eq!(probe_for_bridge("127.0.0.1", other_port, other_port), None);
    // A listener that accepts and says nothing is rejected too, quickly.
    let (silent, silent_port) = free_port_in(other_port + 1..=17499);
    std::thread::spawn(move || {
        let _held: Vec<_> = silent.incoming().flatten().collect();
        std::thread::sleep(Duration::from_secs(3));
    });
    let started = std::time::Instant::now();
    assert_eq!(probe_for_bridge("127.0.0.1", silent_port, silent_port), None);
    assert!(started.elapsed() < Duration::from_secs(2));
}

// ---- 2. restart recovery ----

#[test]
fn a_bridge_killed_mid_call_and_restarted_is_retried_to_success() {
    let bridge = FakeBridge::start(|_, _, _, nth| if nth == 0 { Reply::ResetAndDie } else { ok_json() });
    let (notes_tx, notes_rx) = channel::<String>();
    let session = bridge.session.clone();
    let call = std::thread::spawn(move || {
        set_mcp_session_id(session);
        let line = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
            "name":"list_agents","arguments":{},"_meta":{"progressToken":"tok-1"}}})
        .to_string();
        let (_cancel_tx, cancel_rx) = channel();
        handle_json_rpc_line_cancellable(&line, Some(cancel_rx), Some(notes_tx))
    });
    bridge.wait_for("/agents", 1);
    std::thread::sleep(Duration::from_millis(300)); // the app is down for a moment
    bridge.restart();
    let response: Value = serde_json::from_str(&call.join().unwrap().unwrap()).unwrap();
    assert_ne!(response.pointer("/result/isError"), Some(&json!(true)), "{response}");
    assert_eq!(bridge.count("/agents"), 2, "one failed attempt and exactly one retry");
    let notes: Vec<String> = notes_rx.try_iter().collect();
    assert!(
        notes.iter().any(|n| n.contains("Waiting for Potato Workspace to start") && n.contains("tok-1")),
        "{notes:?}"
    );
}

#[test]
fn a_call_that_cannot_be_repeated_safely_is_not_retried_after_a_reset() {
    let bridge = FakeBridge::start(|_, _, _, _| Reply::ResetAndDie);
    bridge.use_session();
    // No idempotency_key, POST: it may have been applied, so it must not be re-sent.
    let error = bridge_request("POST", "/agents/cancel", Some(json!({"handle": "h1"}))).unwrap_err();
    let detail = tool_error_detail(&error);
    assert_eq!(detail["code"], "BRIDGE_RESTARTING");
    assert_eq!(detail["retryable"], true);
    assert_eq!(detail["outcome"], "unknown");
    assert_eq!(bridge.count("/agents/cancel"), 1);
}

#[test]
fn an_app_that_never_comes_back_ends_in_bridge_unavailable_with_the_fix() {
    let bridge = FakeBridge::start(|_, _, _, _| Reply::ResetAndDie);
    bridge.use_session();
    let started = std::time::Instant::now();
    let error = bridge_request("GET", "/agents", None).unwrap_err();
    assert!(started.elapsed() >= RESTART_WAIT, "it waited for the app first");
    let detail = tool_error_detail(&error);
    assert_eq!(detail["code"], "BRIDGE_UNAVAILABLE");
    assert_eq!(detail["retryable"], true);
    assert_eq!(detail["fix"], "Start Potato Workspace, then retry.");
    assert_eq!(bridge.count("/agents"), 1, "nothing was sent while it was down");
}

// ---- 3. cancel ----

#[test]
fn cancelling_run_agent_sends_no_response_and_never_cancels_the_run() {
    let bridge = FakeBridge::start(|_, path, _, _| {
        if path == "/agents/run" {
            Reply::HoldThenOk(Duration::from_millis(2500), json!({"handle": "h1", "status": "completed"}))
        } else {
            ok_json()
        }
    });
    let stdio = Stdio::start(&bridge.session);
    stdio.call(7, "run_agent", json!({"agent_type":"claude","project_path":"C:/x","task":"long job"}));
    bridge.wait_for("/agents/run", 1);
    stdio.cancel(7);
    // The loop stays alive and answers other requests while 7 stays silent.
    stdio.send(json!({"jsonrpc":"2.0","id":8,"method":"tools/list","params":{}}));
    assert!(stdio.wait_response(8).pointer("/result/tools").is_some());
    std::thread::sleep(Duration::from_millis(3000)); // longer than the run: a late answer would show up now
    let out = stdio.finish();
    assert!(out.response_for(7).is_none(), "a cancelled request gets no response: {:?}", out.lines());
    let paths: Vec<String> = bridge.seen().into_iter().map(|(_, p, _)| p).collect();
    assert!(paths.iter().all(|p| !p.contains("cancel")), "the run must keep going: {paths:?}");
    assert_eq!(bridge.count("/agents/run"), 1);
}

// ---- 4. busy ----

#[test]
fn a_full_shim_answers_rate_limited_as_a_retryable_tool_error() {
    let bridge = FakeBridge::start(|_, _, _, _| Reply::HoldThenOk(Duration::from_secs(3), json!({"agents": []})));
    let stdio = Stdio::start(&bridge.session);
    for id in 1..=16 {
        stdio.call(id, "list_agents", json!({}));
    }
    bridge.wait_for("/agents", 16);
    stdio.call(17, "list_agents", json!({}));
    let busy = stdio.wait_response(17);
    assert!(busy.get("error").is_none(), "busy is a tool error, not a protocol error: {busy}");
    assert_eq!(busy["result"]["isError"], true);
    let detail = &busy["result"]["structuredContent"];
    assert_eq!(detail["code"], "RATE_LIMITED");
    assert_eq!(detail["retryable"], true);
    assert_eq!(detail["retry_after_ms"], 500);
    for id in 1..=16 {
        stdio.cancel(id);
    }
    stdio.finish();
}

// ---- 5. idempotency keys ----

#[test]
fn a_missing_key_is_derived_so_an_identical_retry_repeats_it() {
    let bridge = FakeBridge::start(|_, _, _, _| ok_json());
    bridge.use_session();
    let args = json!({"agent_type":"claude","project_path":"C:/x","task":"same task"});
    call_tool(json!({"name":"run_agent","arguments":args})).unwrap();
    call_tool(json!({"name":"run_agent","arguments":args})).unwrap();
    call_tool(json!({"name":"run_agent","arguments":{"agent_type":"claude","project_path":"C:/x","task":"another task"}})).unwrap();
    let keys: Vec<String> = bridge
        .seen()
        .iter()
        .filter(|(_, p, _)| p == "/agents/run")
        .map(|(_, _, body)| body["idempotency_key"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(keys.len(), 3);
    assert_eq!(keys[0], keys[1], "same session, tool and arguments");
    assert_ne!(keys[0], keys[2], "different arguments");
}

#[test]
fn derived_keys_depend_on_session_tool_arguments_and_window_but_not_key_order_or_an_existing_key() {
    let args = json!({"a": 1, "b": {"x": 1, "y": 2}});
    let base = derive_idempotency_key("s1", "run_agent", &args, 5);
    assert_eq!(base, derive_idempotency_key("s1", "run_agent", &json!({"b": {"y": 2, "x": 1}, "a": 1}), 5));
    assert_eq!(base, derive_idempotency_key("s1", "run_agent", &json!({"a": 1, "b": {"x": 1, "y": 2}, "idempotency_key": "k"}), 5));
    assert_ne!(base, derive_idempotency_key("s2", "run_agent", &args, 5));
    assert_ne!(base, derive_idempotency_key("s1", "followup_task", &args, 5));
    assert_ne!(base, derive_idempotency_key("s1", "run_agent", &args, 6));
    let mut explicit = json!({"idempotency_key": "mine"});
    assert_eq!(ensure_stable_idempotency_key("run_agent", &mut explicit), "mine");
}

// ---- 6. schema drift by hash ----

#[test]
fn the_drift_notice_names_the_tools_whose_schema_differs() {
    let shim = tool_registry::tool_schema_hashes();
    let health_for = |tools: &BTreeMap<String, String>| {
        json!({"catalog_hash": tool_registry::catalog_hash_of(tools), "tool_hashes": tools, "build_id": "b1", "catalog_version": "same"})
    };
    assert!(schema_drift_with(&health_for(&shim), &shim).is_none(), "equal hashes, no drift");
    let mut app = shim.clone();
    let changed = app.keys().next().unwrap().clone();
    app.insert(changed.clone(), "ffffffffffffffff".into());
    app.insert("brand_new_tool".into(), "1111111111111111".into());
    let drift = schema_drift_with(&health_for(&app), &shim).expect("a schema changed");
    assert_eq!(drift["code"], "SCHEMA_DRIFT");
    assert_eq!(drift["changed_tools"], json!([changed]));
    assert_eq!(drift["only_in_app"], json!(["brand_new_tool"]));
    assert!(drift["message"].as_str().unwrap().contains(&changed));
    // The hand-bumped version string no longer matters once hashes are present.
    let mut health = health_for(&shim);
    health["catalog_version"] = json!("different-string");
    assert!(schema_drift_with(&health, &shim).is_none());
}

// ---- 6b. replay honesty: a derived key that names an earlier run says so ----

#[test]
fn a_derived_key_answer_from_an_earlier_run_is_marked_replayed() {
    let mut caller = json!({"task": "t"});
    assert!(!caller_gave_idempotency_key(&caller));
    caller["idempotency_key"] = json!("mine");
    assert!(caller_gave_idempotency_key(&caller));
    let mut empty = json!({"idempotency_key": ""});
    assert!(!caller_gave_idempotency_key(&empty));
    empty["idempotency_key"] = json!(null);
    assert!(!caller_gave_idempotency_key(&empty));

    let answer = json!({"handle": "h1", "status": "running"}).to_string();
    let earlier = json!({"operation_id": "op-1", "created_at_ms": 1_700_000_000_000u64});
    let replayed: Value = serde_json::from_str(&mark_replayed(answer.clone(), Some(&earlier))).unwrap();
    assert_eq!(replayed["replayed"], true);
    assert_eq!(replayed["started_at_ms"], 1_700_000_000_000u64);
    assert_eq!(replayed["handle"], "h1", "the answer itself is kept");
}

#[test]
fn a_fresh_run_gets_no_replay_marker_and_an_unparsable_answer_passes_through() {
    let answer = json!({"handle": "h1", "status": "running"}).to_string();
    assert_eq!(mark_replayed(answer.clone(), None), answer, "fresh runs are unchanged");
    let text = "not json at all";
    assert_eq!(mark_replayed(text.to_string(), Some(&json!({"operation_id": "op-1"}))), text);
    let fresh: Value = serde_json::from_str(&answer).unwrap();
    assert!(fresh.get("replayed").is_none());
}

// ---- 7. heartbeats ----

#[test]
fn a_blocking_run_sends_progress_heartbeats_while_the_caller_gave_a_token() {
    let bridge = FakeBridge::start(|_, _, _, _| Reply::HoldThenOk(Duration::from_millis(900), json!({"answer": "pong"})));
    let (notes_tx, notes_rx) = channel::<String>();
    let session = bridge.session.clone();
    let call = std::thread::spawn(move || {
        set_mcp_session_id(session);
        let line = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
            "name":"quick_ask","arguments":{"task":"ping"},"_meta":{"progressToken":"hb"}}})
        .to_string();
        let (_cancel_tx, cancel_rx) = channel();
        handle_json_rpc_line_cancellable(&line, Some(cancel_rx), Some(notes_tx))
    });
    let response: Value = serde_json::from_str(&call.join().unwrap().unwrap()).unwrap();
    assert_eq!(response["result"]["structuredContent"]["answer"], "pong");
    let beats: Vec<Value> = notes_rx
        .try_iter()
        .filter_map(|n| serde_json::from_str::<Value>(&n).ok())
        .filter(|n| n["method"] == "notifications/progress" && n["params"]["progressToken"] == "hb")
        .collect();
    assert!(beats.len() >= 2, "{beats:?}");
    let steps: Vec<u64> = beats.iter().map(|b| b["params"]["progress"].as_u64().unwrap()).collect();
    assert!(steps.windows(2).all(|w| w[0] < w[1]), "progress must rise: {steps:?}");
}

// ---- 8. error contract and timeouts ----

#[test]
fn every_error_body_has_code_message_and_retryable() {
    let plain = tool_error_detail("missing required string argument: task");
    assert_eq!(plain["code"], "INVALID_ARGUMENT");
    assert_eq!(plain["retryable"], false);
    let down = tool_error_detail("bridge_down: Potato Workspace bridge port file not found");
    assert_eq!(down["code"], "BRIDGE_UNAVAILABLE");
    assert_eq!(down["retryable"], true);
    assert_eq!(down["fix"], "Start Potato Workspace, then retry.");
    let other = tool_error_detail("something odd");
    assert_eq!(other["code"], "bridge_error");
    assert_eq!(other["message"], "something odd");
    assert!(other["retryable"].is_boolean());
    // Existing fields survive, a null retry_after_ms is dropped, `recoverable` maps to `retryable`.
    let typed = tool_error_detail(
        r#"{"code":"NOT_FOUND","message":"gone","recoverable":false,"retry_after_ms":null,"context":{"http_status":404}}"#,
    );
    assert_eq!(typed["retryable"], false);
    assert_eq!(typed["recoverable"], false);
    assert_eq!(typed["context"]["http_status"], 404);
    assert!(typed.get("retry_after_ms").is_none());
    let rate = tool_error_detail(&legacy_http_error(429, "slow down").to_string());
    assert_eq!(rate["code"], "RATE_LIMITED");
    assert_eq!(rate["retryable"], true);
    assert_eq!(rate["retry_after_ms"], 1000);
}

#[test]
fn timeouts_are_recognised_by_io_error_kind_not_by_message_text() {
    let timed_out = io::Error::from(io::ErrorKind::TimedOut);
    assert!(is_bridge_timeout(&io_failure("bridge read failed", &timed_out)));
    let would_block = io::Error::from(io::ErrorKind::WouldBlock);
    assert!(is_bridge_timeout(&io_failure("bridge read failed", &would_block)));
    // A reset is not a timeout, whatever its text says.
    let reset = io::Error::new(io::ErrorKind::ConnectionReset, "the connection timed out (not really)");
    let text = io_failure("bridge read failed", &reset);
    assert!(text.starts_with(BRIDGE_RESET));
    assert!(!is_bridge_timeout(&text), "{text}");
    assert!(is_connect_failure(&text));
    // A contract error that happens to mention a timeout is not a raw transport timeout either.
    assert!(!is_bridge_timeout(&bridge_unavailable("connect timed out")));
}
