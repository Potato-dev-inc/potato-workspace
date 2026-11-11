//! End to end: a raw HTTP client -> the borrower's shim -> (tokio duplex standing in for the encrypted stream) ->
//! the lender's forwarder -> a fake upstream on this machine. Fake credentials only.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as StdInstant};

use async_trait::async_trait;
use tokio::io::{duplex, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::capacity_proxy::forward::{AuthSource, Forwarder, InjectedAuth, Outcome};
use crate::capacity_proxy::frame;
use crate::capacity_proxy::gate::{EndReason, Gate, Limits, Usage};
use crate::capacity_proxy::shim::{OpenError, Opener, Shim};
use crate::capacity_proxy::spec::ProxySpec;
use crate::p2p::endpoint::BiStream;

const CLAUDE: &str = include_str!("../tui/claude/lend_proxy.toml");
pub(super) const LENDER_KEY: &str = "sk-lender-FAKE";
const LENDER_TOKEN: &str = "tok-lender-FAKE";

// ---------------------------------------------------------------- fake upstream

#[derive(Clone, Debug)]
pub(super) struct Recorded {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}

impl Recorded {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub(super) enum Script {
    Json { status: u16, body: String },
    /// Body pieces, each followed by a pause in milliseconds.
    Sse(Vec<(Vec<u8>, u64)>),
    /// An event every 50 ms, forever.
    Endless,
}

pub(super) struct Upstream {
    pub(super) port: u16,
    seen: Arc<Mutex<Vec<Recorded>>>,
    task: JoinHandle<()>,
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Upstream {
    pub(super) async fn start(script: Script) -> Upstream {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(script);
        let seen2 = seen.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else { continue };
                tokio::spawn(upstream_connection(socket, script.clone(), seen2.clone()));
            }
        });
        Upstream { port, seen, task }
    }

    pub(super) fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
    }
}

async fn upstream_connection(socket: TcpStream, script: Arc<Script>, seen: Arc<Mutex<Vec<Recorded>>>) {
    let (r, mut w) = socket.into_split();
    let mut r = BufReader::new(r);
    let mut line = String::new();
    r.read_line(&mut line).await.unwrap();
    let mut parts = line.trim_end().split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    loop {
        let mut l = String::new();
        r.read_line(&mut l).await.unwrap();
        let l = l.trim_end();
        if l.is_empty() {
            break;
        }
        let (k, v) = l.split_once(':').unwrap();
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").map(|(_, v)| v.parse().unwrap()).unwrap_or(0);
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await.unwrap();
    seen.lock().unwrap().push(Recorded { method, path, headers, body });

    match &*script {
        Script::Json { status, body } => {
            let text = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = w.write_all(text.as_bytes()).await;
        }
        Script::Sse(parts) => {
            let _ = w.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n").await;
            for (bytes, pause) in parts {
                if w.write_all(bytes).await.is_err() || w.flush().await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(*pause)).await;
            }
        }
        Script::Endless => {
            let _ = w.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").await;
            let _ = w.write_all(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n").await;
            loop {
                if w.write_all(b"event: ping\ndata: {\"type\":\"ping\"}\n\n").await.is_err() || w.flush().await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    let _ = w.shutdown().await;
}

/// A real-looking Anthropic stream: input 25, output 42.
pub(super) const SSE_TEXT: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-test\",\"content\":[],\"usage\":{\"input_tokens\":25,\"output_tokens\":1}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: ping\ndata: {\"type\":\"ping\"}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":42}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

pub(super) fn sse_script() -> Script {
    // Cut at awkward places (mid line) with small pauses.
    let bytes = SSE_TEXT.as_bytes();
    let cuts = [0, 37, 200, 311, 480, bytes.len()];
    Script::Sse(cuts.windows(2).map(|w| (bytes[w[0]..w[1]].to_vec(), 20)).collect())
}

pub(super) fn json_script(status: u16, body: &str) -> Script {
    Script::Json { status, body: body.to_string() }
}

// ---------------------------------------------------------------- glue

struct TestOpener {
    forwarder: Arc<Forwarder>,
    gate: Arc<Gate>,
    calls: AtomicUsize,
    handles: Mutex<Vec<JoinHandle<Outcome>>>,
}

#[async_trait]
impl Opener for TestOpener {
    async fn open(&self) -> Result<BiStream, OpenError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (borrower_send, lender_recv) = duplex(64 * 1024);
        let (lender_send, borrower_recv) = duplex(64 * 1024);
        let lender = BiStream { send: Box::new(lender_send), recv: Box::new(lender_recv) };
        let (forwarder, gate) = (self.forwarder.clone(), self.gate.clone());
        let handle = tokio::spawn(async move { forwarder.serve_stream(&gate, lender).await });
        self.handles.lock().unwrap().push(handle);
        Ok(BiStream { send: Box::new(borrower_send), recv: Box::new(borrower_recv) })
    }
}

struct EndedOpener(AtomicUsize);

#[async_trait]
impl Opener for EndedOpener {
    async fn open(&self) -> Result<BiStream, OpenError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(OpenError::Ended)
    }
}

pub(super) struct Rig {
    pub(super) up: Upstream,
    pub(super) gate: Arc<Gate>,
    pub(super) shim: Arc<Shim>,
    opener: Arc<TestOpener>,
    secret: String,
    /// What the lender's forwarder / the borrower's shim were told about the sign-in (`true`: a problem).
    lender_notes: Arc<Mutex<Vec<bool>>>,
    borrower_notes: Arc<Mutex<Vec<bool>>>,
}

#[derive(Clone)]
enum AuthKind {
    ApiKey,
    /// A fixed lend sign-in token.
    Account,
    /// A lend sign-in folder (its `.credentials.json` is read on every request).
    File(String),
}

pub(super) struct RigOptions {
    auth: AuthKind,
    pub(super) deadline: Duration,
    pub(super) limits: Limits,
    pub(super) max_body: usize,
}

impl RigOptions {
    pub(super) fn standard() -> Self {
        Self::default()
    }
}

impl Default for RigOptions {
    fn default() -> Self {
        Self { auth: AuthKind::ApiKey, deadline: Duration::from_secs(3600), limits: Limits::default(), max_body: 1024 * 1024 }
    }
}

async fn rig(script: Script, options: RigOptions) -> Rig {
    rig_with_spec(ProxySpec::parse(CLAUDE).unwrap(), script, options).await
}

/// The same rig for any agent's spec (an API key as the lender's auth).
pub(super) async fn rig_with_spec(spec: ProxySpec, script: Script, options: RigOptions) -> Rig {
    let up = Upstream::start(script).await;
    let spec = Arc::new(spec);
    let auth = match options.auth {
        AuthKind::ApiKey => InjectedAuth::from_spec(spec.auth.api_key.as_ref().unwrap(), LENDER_KEY).into(),
        AuthKind::Account => InjectedAuth::from_spec(spec.auth.account.as_ref().unwrap(), LENDER_TOKEN).into(),
        AuthKind::File(dir) => AuthSource::account(&dir, spec.auth.account.as_ref().unwrap()).unwrap(),
    };
    let (lender_notes, borrower_notes) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
    let (ln, bn) = (lender_notes.clone(), borrower_notes.clone());
    let forwarder = Forwarder::new(spec, auth)
        .unwrap()
        .with_signin(Arc::new(crate::capacity_proxy::now_ms), Arc::new(move |bad| ln.lock().unwrap().push(bad)))
        .with_test_upstream(&format!("http://127.0.0.1:{}", up.port));
    let forwarder = Arc::new(forwarder);
    let gate = Gate::new(tokio::time::Instant::now() + options.deadline, options.limits);
    let opener = Arc::new(TestOpener { forwarder, gate: gate.clone(), calls: AtomicUsize::new(0), handles: Mutex::new(Vec::new()) });
    let shim = Shim::start_with(opener.clone(), options.max_body, Some(Arc::new(move |bad| bn.lock().unwrap().push(bad))), None).await.unwrap();
    let secret = shim.base_url().rsplit('/').next().unwrap().to_string();
    Rig { up, gate, shim, opener, secret, lender_notes, borrower_notes }
}

impl Rig {
    /// The path a client uses: the secret segment, then the real path.
    pub(super) fn path(&self, real: &str) -> String {
        format!("/{}{}", self.secret, real)
    }

    pub(super) async fn post(&self, real: &str, body: &[u8]) -> Reply {
        http(self.shim.port(), "POST", &self.path(real), &[("content-type", "application/json")], body).await
    }

    /// Waits for every forwarder run so far and returns how each ended.
    pub(super) async fn outcomes(&self) -> Vec<Outcome> {
        let handles: Vec<_> = self.opener.handles.lock().unwrap().drain(..).collect();
        let mut out = Vec::new();
        for h in handles {
            out.push(tokio::time::timeout(Duration::from_secs(5), h).await.expect("forwarder finished").unwrap());
        }
        out
    }
}

// ---------------------------------------------------------------- raw client

#[derive(Debug)]
pub(super) struct Reply {
    pub(super) status: u16,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
    /// Whether the reply ended properly (final 0-chunk, or the full Content-Length).
    pub(super) complete: bool,
}

impl Reply {
    pub(super) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub(super) async fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n", body.len());
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    let _ = socket.write_all(req.as_bytes()).await;
    let _ = socket.write_all(body).await;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
        }
    }
    parse_reply(&raw)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn parse_reply(raw: &[u8]) -> Reply {
    let split = find(raw, b"\r\n\r\n").expect("a reply head");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> =
        lines.map(|l| l.split_once(':').unwrap()).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let rest = &raw[split + 4..];
    let get = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    if get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        let (mut body, mut pos, mut complete) = (Vec::new(), 0usize, false);
        while let Some(eol) = find(&rest[pos..], b"\r\n") {
            let Ok(size) = usize::from_str_radix(std::str::from_utf8(&rest[pos..pos + eol]).unwrap().trim(), 16) else { break };
            let start = pos + eol + 2;
            if size == 0 {
                complete = rest[start..].starts_with(b"\r\n");
                break;
            }
            if start + size + 2 > rest.len() {
                break;
            }
            body.extend_from_slice(&rest[start..start + size]);
            pos = start + size + 2;
        }
        Reply { status, headers, body, complete }
    } else {
        let complete = get("content-length").is_some_and(|v| v.parse::<usize>().ok() == Some(rest.len()));
        Reply { status, headers, body: rest.to_vec(), complete }
    }
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn the_lenders_api_key_reaches_upstream_and_the_borrowers_never_does() {
    let rig = rig(json_script(200, r#"{"usage":{"input_tokens":1,"output_tokens":2}}"#), RigOptions::default()).await;
    let reply = http(
        rig.shim.port(),
        "POST",
        &rig.path("/v1/messages"),
        &[
            ("x-api-key", "BORROWER-KEY"),
            ("authorization", "Bearer BORROWER-TOKEN"),
            ("anthropic-beta", "claude-code-20250219"),
            ("anthropic-version", "2023-06-01"),
            ("accept-encoding", "gzip"),
            ("cookie", "BORROWER-COOKIE=1"),
        ],
        br#"{"hi":1}"#,
    )
    .await;
    assert_eq!(reply.status, 200);
    let seen = rig.up.requests();
    assert_eq!(seen.len(), 1);
    let r = &seen[0];
    assert_eq!((r.method.as_str(), r.path.as_str()), ("POST", "/v1/messages"));
    assert_eq!(r.header("x-api-key"), Some(LENDER_KEY));
    assert_eq!(r.header("authorization"), None);
    assert_eq!(r.header("accept-encoding"), Some("identity"));
    assert_eq!(r.header("anthropic-beta"), Some("claude-code-20250219"));
    assert_eq!(r.header("anthropic-version"), Some("2023-06-01"));
    assert_eq!(r.header("cookie"), None);
    assert_eq!(r.body, br#"{"hi":1}"#);
    assert!(r.headers.iter().all(|(_, v)| !v.contains("BORROWER")), "{:?}", r.headers);
}

#[tokio::test]
async fn the_account_variant_sends_bearer_and_joins_the_beta_header() {
    let rig = rig(json_script(200, "{}"), RigOptions { auth: AuthKind::Account, ..RigOptions::default() }).await;
    let reply = http(
        rig.shim.port(),
        "POST",
        &rig.path("/v1/messages"),
        &[("x-api-key", "BORROWER-KEY"), ("authorization", "Bearer pm-lend"), ("anthropic-beta", "claude-code-20250219")],
        b"{}",
    )
    .await;
    assert_eq!(reply.status, 200);
    let r = &rig.up.requests()[0];
    assert_eq!(r.header("authorization"), Some("Bearer tok-lender-FAKE"));
    assert_eq!(r.header("x-api-key"), None);
    assert_eq!(r.header("anthropic-beta"), Some("claude-code-20250219,oauth-2025-04-20"));
    assert_eq!(r.header("accept-encoding"), Some("identity"));
    assert!(r.headers.iter().all(|(_, v)| !v.contains("BORROWER") && !v.contains("pm-lend")));
}

#[tokio::test]
async fn paths_outside_the_spec_never_reach_upstream() {
    let rig = rig(json_script(200, "{}"), RigOptions::default()).await;
    let cases = [
        ("POST", "/v1/models"),
        ("GET", "/v1/messages"),
        ("POST", "/v1/messages/../x"),
        ("POST", "/v1/%2e%2e/x"),
        ("POST", "/v1/messages/"),
        ("POST", "/v1/messages?x=%2e"),
        ("POST", "/v1//messages"),
    ];
    for (method, path) in cases {
        let reply = http(rig.shim.port(), method, &rig.path(path), &[], b"{}").await;
        assert_eq!(reply.status, 403, "{method} {path}");
        assert_eq!(reply.text(), frame::PATH_NOT_ALLOWED, "{method} {path}");
    }
    assert!(rig.up.requests().is_empty());
}

#[tokio::test]
async fn sse_comes_through_byte_identical_with_its_query_and_usage_is_counted() {
    let rig = rig(sse_script(), RigOptions::default()).await;
    let reply = rig.post("/v1/messages?beta=true", br#"{"stream":true}"#).await;
    assert_eq!(reply.status, 200);
    assert!(reply.complete);
    assert_eq!(reply.body, SSE_TEXT.as_bytes());
    assert!(reply.headers.iter().any(|(k, v)| k == "content-type" && v.contains("text/event-stream")));
    assert!(reply.headers.iter().all(|(k, _)| k != "content-length" && k != "set-cookie"));
    assert_eq!(rig.up.requests()[0].path, "/v1/messages?beta=true");
    assert_eq!(rig.outcomes().await, vec![Outcome::Forwarded { status: 200 }]);
    assert_eq!(rig.gate.usage(), Usage { requests: 1, input_tokens: 25, output_tokens: 42 });
}

#[tokio::test]
async fn count_tokens_is_allowed_too() {
    let rig = rig(json_script(200, r#"{"input_tokens":9}"#), RigOptions::default()).await;
    let reply = rig.post("/v1/messages/count_tokens", b"{}").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), r#"{"input_tokens":9}"#);
}

#[tokio::test]
async fn a_deadline_cuts_a_live_stream_and_the_next_request_is_refused() {
    let rig = rig(Script::Endless, RigOptions { deadline: Duration::from_millis(300), ..RigOptions::default() }).await;
    let started = StdInstant::now();
    let reply = rig.post("/v1/messages", b"{}").await;
    let took = started.elapsed();
    assert_eq!(reply.status, 200);
    assert!(!reply.complete, "a cut stream must not end with the final chunk");
    assert!(reply.text().contains("event: ping"));
    assert!(took >= Duration::from_millis(200) && took < Duration::from_secs(3), "{took:?}");
    assert_eq!(rig.outcomes().await, vec![Outcome::Cut(EndReason::Expired)]);
    // Only what was streamed before the cut was counted.
    assert_eq!(rig.gate.usage().input_tokens, 3);

    let next = rig.post("/v1/messages", b"{}").await;
    assert_eq!(next.status, 403);
    assert_eq!(next.text(), r#"{"error":{"type":"lend_ended","message":"This lend ended"}}"#);
    assert_eq!(rig.up.requests().len(), 1);
}

#[tokio::test]
async fn revoking_mid_stream_cuts_at_once() {
    let rig = Arc::new(rig(Script::Endless, RigOptions::default()).await);
    let client = {
        let rig = rig.clone();
        tokio::spawn(async move { rig.post("/v1/messages", b"{}").await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let revoked_at = StdInstant::now();
    rig.gate.end(EndReason::Revoked);
    let reply = client.await.unwrap();
    assert!(revoked_at.elapsed() < Duration::from_secs(1), "{:?}", revoked_at.elapsed());
    assert!(!reply.complete);
    assert!(reply.text().contains("event: ping"));
    assert_eq!(rig.outcomes().await, vec![Outcome::Cut(EndReason::Revoked)]);

    let next = rig.post("/v1/messages", b"{}").await;
    assert_eq!(next.status, 403);
    assert_eq!(next.text(), frame::LEND_ENDED);
}

#[tokio::test]
async fn shim_end_refuses_without_opening_a_stream() {
    let rig = rig(json_script(200, "{}"), RigOptions::default()).await;
    rig.shim.end();
    assert!(rig.shim.ended());
    let reply = rig.post("/v1/messages", b"{}").await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.text(), frame::LEND_ENDED);
    assert_eq!(rig.opener.calls.load(Ordering::SeqCst), 0);
    assert!(rig.up.requests().is_empty());
}

#[tokio::test]
async fn shim_end_aborts_a_streaming_reply() {
    let rig = Arc::new(rig(Script::Endless, RigOptions::default()).await);
    let client = {
        let rig = rig.clone();
        tokio::spawn(async move { rig.post("/v1/messages", b"{}").await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let at = StdInstant::now();
    rig.shim.end();
    let reply = client.await.unwrap();
    assert!(at.elapsed() < Duration::from_secs(1));
    assert!(!reply.complete);
    rig.gate.end(EndReason::Stopped);
}

#[tokio::test]
async fn an_opener_that_says_ended_ends_the_shim() {
    let opener = Arc::new(EndedOpener(AtomicUsize::new(0)));
    let shim = Shim::start(opener.clone(), 1024).await.unwrap();
    let secret = shim.base_url().rsplit('/').next().unwrap().to_string();
    assert!(!shim.ended());
    let reply = http(shim.port(), "POST", &format!("/{secret}/v1/messages"), &[], b"{}").await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.text(), frame::LEND_ENDED);
    assert!(shim.ended());
    let again = http(shim.port(), "POST", &format!("/{secret}/v1/messages"), &[], b"{}").await;
    assert_eq!(again.status, 403);
    assert_eq!(opener.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_unavailable_lender_is_a_502() {
    struct Down;
    #[async_trait]
    impl Opener for Down {
        async fn open(&self) -> Result<BiStream, OpenError> {
            Err(OpenError::Unavailable("no route".into()))
        }
    }
    let shim = Shim::start(Arc::new(Down), 1024).await.unwrap();
    let secret = shim.base_url().rsplit('/').next().unwrap().to_string();
    let reply = http(shim.port(), "POST", &format!("/{secret}/v1/messages"), &[], b"{}").await;
    assert_eq!(reply.status, 502);
    // The agent gets the plain reason, not a bare timeout.
    assert_eq!(reply.text(), frame::unavailable_body("no route"));
}

#[tokio::test]
async fn a_body_over_the_limit_is_413_and_a_wrong_secret_is_404() {
    let rig = rig(json_script(200, "{}"), RigOptions { max_body: 100, ..RigOptions::default() }).await;
    let reply = rig.post("/v1/messages", &[b'x'; 1000]).await;
    assert_eq!(reply.status, 413);
    assert_eq!(reply.text(), frame::TOO_LARGE);

    let small = rig.post("/v1/messages", &[b'x'; 50]).await;
    assert_eq!(small.status, 200);

    for path in ["/v1/messages", "/00000000000000000000000000000000/v1/messages", &format!("/{}x/v1/messages", rig.secret)] {
        let wrong = http(rig.shim.port(), "POST", path, &[], b"{}").await;
        assert_eq!(wrong.status, 404, "{path}");
    }
    assert_eq!(rig.up.requests().len(), 1);
}

#[tokio::test]
async fn a_chunked_request_body_is_read() {
    let rig = rig(json_script(200, "{}"), RigOptions::default()).await;
    let mut socket = TcpStream::connect(("127.0.0.1", rig.shim.port())).await.unwrap();
    let head = format!("POST {} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n", rig.path("/v1/messages?beta=true"));
    socket.write_all(head.as_bytes()).await.unwrap();
    socket.write_all(b"5\r\nhello\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    socket.write_all(b"6;ext=1\r\n world\r\n0\r\n\r\n").await.unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).await.unwrap();
    assert_eq!(parse_reply(&raw).status, 200);
    let r = &rig.up.requests()[0];
    assert_eq!(r.body, b"hello world");
    assert_eq!(r.path, "/v1/messages?beta=true");
}

#[tokio::test]
async fn the_request_limit_gives_a_429_and_does_not_end_the_lend() {
    let rig = rig(json_script(200, "{}"), RigOptions { limits: Limits { max_requests: Some(1), max_tokens: None }, ..RigOptions::default() }).await;
    assert_eq!(rig.post("/v1/messages", b"{}").await.status, 200);
    let second = rig.post("/v1/messages", b"{}").await;
    assert_eq!(second.status, 429);
    assert_eq!(second.text(), frame::LEND_LIMIT);
    assert_eq!(rig.up.requests().len(), 1);
    assert_eq!(rig.gate.ended(), None);
}

#[tokio::test]
async fn upstream_errors_pass_through() {
    let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
    let rig = rig(json_script(401, body), RigOptions::default()).await;
    let reply = rig.post("/v1/messages", b"{}").await;
    assert_eq!(reply.status, 401);
    assert_eq!(reply.text(), body);
    assert!(reply.complete);
    assert_eq!(rig.outcomes().await, vec![Outcome::Forwarded { status: 401 }]);
}

#[tokio::test]
async fn an_unreachable_upstream_is_a_502_upstream_error() {
    let rig = rig(json_script(200, "{}"), RigOptions::default()).await;
    // Close the fake upstream: the port now refuses connections.
    rig.up.task.abort();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let reply = rig.post("/v1/messages", b"{}").await;
    assert_eq!(reply.status, 502);
    assert_eq!(reply.text(), frame::UPSTREAM_ERROR);
    assert!(matches!(rig.outcomes().await[0], Outcome::Failed(_)));
}

#[tokio::test]
async fn an_oversized_body_on_the_lender_side_is_413() {
    // The shim lets it through (big limit); the lender's own cap (the spec's) is lower.
    let spec_text = CLAUDE.replace("max_body_bytes = 16777216", "max_body_bytes = 64");
    let up = Upstream::start(json_script(200, "{}")).await;
    let spec = Arc::new(ProxySpec::parse(&spec_text).unwrap());
    let auth = InjectedAuth::from_spec(spec.auth.api_key.as_ref().unwrap(), LENDER_KEY);
    let forwarder = Forwarder::new(spec, auth).unwrap().with_test_upstream(&format!("http://127.0.0.1:{}", up.port));
    let gate = Gate::new(tokio::time::Instant::now() + Duration::from_secs(60), Limits::default());
    let (mut bs, lr) = duplex(64 * 1024);
    let (ls, mut br) = duplex(64 * 1024);
    let lender = BiStream { send: Box::new(ls), recv: Box::new(lr) };
    let run = tokio::spawn({
        let gate = gate.clone();
        async move { forwarder.serve_stream(&gate, lender).await }
    });
    let head = frame::RequestHead { method: "POST".into(), path: "/v1/messages".into(), headers: vec![] };
    frame::write_request_head(&mut bs, &head).await.unwrap();
    frame::write_request_body(&mut bs, &[0u8; 65]).await.unwrap();
    let h = frame::read_response_head(&mut br).await.unwrap();
    assert_eq!(h.status, 413);
    assert_eq!(run.await.unwrap(), Outcome::Refused { status: 413 });
    assert!(up.requests().is_empty());
    assert_eq!(gate.usage().requests, 0);
}

// ---------------------------------------------------------------- lend sign-in file: re-read, expiry

fn sign_in_folder(token: &str, expires_ms: u64) -> String {
    let dir = std::env::temp_dir().join(format!("pm-lend-signin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    write_sign_in(dir.to_str().unwrap(), token, expires_ms);
    dir.to_string_lossy().to_string()
}

fn write_sign_in(dir: &str, token: &str, expires_ms: u64) {
    let json = format!(r#"{{"claudeAiOauth":{{"accessToken":"{token}","refreshToken":"r-FAKE","expiresAt":{expires_ms}}}}}"#);
    std::fs::write(std::path::Path::new(dir).join(".credentials.json"), json).unwrap();
}

fn in_an_hour() -> u64 {
    crate::capacity_proxy::now_ms() + 3_600_000
}

fn file_rig_options(dir: &str) -> RigOptions {
    RigOptions { auth: AuthKind::File(dir.to_string()), ..RigOptions::default() }
}

#[tokio::test]
async fn the_sign_in_token_is_read_again_on_every_request() {
    let dir = sign_in_folder("tok-A-FAKE", in_an_hour());
    let rig = rig(json_script(200, "{}"), file_rig_options(&dir)).await;
    assert_eq!(rig.post("/v1/messages", b"{}").await.status, 200);
    write_sign_in(&dir, "tok-B-FAKE", in_an_hour());
    assert_eq!(rig.post("/v1/messages", b"{}").await.status, 200);
    let seen = rig.up.requests();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].header("authorization"), Some("Bearer tok-A-FAKE"));
    assert_eq!(seen[1].header("authorization"), Some("Bearer tok-B-FAKE"));
    assert_eq!(seen[1].header("anthropic-beta"), Some("oauth-2025-04-20"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_expired_token_is_never_sent_and_both_sides_hear_about_it() {
    let dir = sign_in_folder("tok-OLD-FAKE", 1_000);
    let rig = rig(json_script(200, "{}"), file_rig_options(&dir)).await;
    let reply = rig.post("/v1/messages", b"{}").await;
    assert_eq!(reply.status, 401);
    assert_eq!(reply.text(), frame::SIGNIN_EXPIRED);
    assert_eq!(reply.header("x-pm-lend"), Some("signin_expired"));
    assert!(rig.up.requests().is_empty(), "the provider was not called");
    assert_eq!(rig.gate.usage().requests, 0, "a refused request is not counted");
    assert_eq!(*rig.lender_notes.lock().unwrap(), vec![true]);
    assert_eq!(*rig.borrower_notes.lock().unwrap(), vec![true]);
    // The agent signs in again: the next request goes through and clears the problem on both sides.
    write_sign_in(&dir, "tok-NEW-FAKE", in_an_hour());
    assert_eq!(rig.post("/v1/messages", b"{}").await.status, 200);
    assert_eq!(rig.up.requests()[0].header("authorization"), Some("Bearer tok-NEW-FAKE"));
    assert_eq!(*rig.lender_notes.lock().unwrap(), vec![true, false]);
    assert_eq!(*rig.borrower_notes.lock().unwrap(), vec![true, false]);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_missing_or_empty_token_file_is_refused_like_an_expired_one() {
    let dir = sign_in_folder("tok-FAKE", in_an_hour());
    let rig = rig(json_script(200, "{}"), file_rig_options(&dir)).await;
    std::fs::remove_file(std::path::Path::new(&dir).join(".credentials.json")).unwrap();
    assert_eq!(rig.post("/v1/messages", b"{}").await.status, 401);
    write_sign_in(&dir, "", in_an_hour());
    let reply = rig.post("/v1/messages", b"{}").await;
    assert_eq!((reply.status, reply.text()), (401, frame::SIGNIN_EXPIRED.to_string()));
    assert!(rig.up.requests().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}
