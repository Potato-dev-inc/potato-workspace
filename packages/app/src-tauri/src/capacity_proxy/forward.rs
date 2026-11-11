//! The lender's forwarder: takes one borrower request from a bi-stream, checks it against the spec and the gate,
//! adds the lender's own auth, sends it to the one upstream, and streams the reply back unchanged.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::capacity_proxy::frame::{self, FrameError, ResponseHead, SigninNote};
use crate::capacity_proxy::gate::{EndReason, Gate, Refusal};
use crate::capacity_proxy::meter;
use crate::capacity_proxy::signin::SigninFile;
use crate::capacity_proxy::spec::{check_upstream, AuthSpec, NameValue, ProxySpec};
use crate::p2p::endpoint::BiStream;

const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_TIMEOUT: Duration = Duration::from_secs(120);
const READ_SIZE: usize = 16 * 1024;

/// Request headers the borrower may never choose (lower case).
const DROP_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "proxy-authorization",
    "cookie",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "accept-encoding",
];

/// Reply headers that are not passed back (lower case).
const DROP_RESPONSE_HEADERS: &[&str] = &["content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"];

/// The lender's secret as it goes on a forwarded request. Never printed.
#[derive(Clone)]
pub struct InjectedAuth {
    pub header: String,
    pub value: String,
    pub add_headers: Vec<NameValue>,
}

impl InjectedAuth {
    /// `value` is the secret alone, or `<scheme> <secret>` when the spec has a scheme.
    pub fn from_spec(spec: &AuthSpec, secret: &str) -> Self {
        let value = if spec.scheme.is_empty() { secret.to_string() } else { format!("{} {secret}", spec.scheme) };
        Self { header: spec.header.clone(), value, add_headers: spec.add_headers.clone() }
    }
}

impl std::fmt::Debug for InjectedAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InjectedAuth({})", self.header)
    }
}

/// Where the lender's auth comes from for each request.
pub enum AuthSource {
    /// A pasted API key: the same value every time.
    Fixed(InjectedAuth),
    /// A lend sign-in's token file, read again on every request (the agent renews the token in that file).
    Account { file: SigninFile, spec: AuthSpec },
}

impl AuthSource {
    /// The lend sign-in folder `home` and the spec's account auth.
    pub fn account(home: &str, spec: &AuthSpec) -> Result<Self, String> {
        Ok(Self::Account { file: SigninFile::new(home, spec)?, spec: spec.clone() })
    }
}

impl From<InjectedAuth> for AuthSource {
    fn from(auth: InjectedAuth) -> Self {
        Self::Fixed(auth)
    }
}

impl std::fmt::Debug for AuthSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fixed(auth) => write!(f, "AuthSource::Fixed({auth:?})"),
            Self::Account { file, .. } => write!(f, "AuthSource::Account({file:?})"),
        }
    }
}

/// How one forwarded request ended (for tests and logs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The upstream answered; its status went back.
    Forwarded { status: u16 },
    /// Refused here; the upstream was not called.
    Refused { status: u16 },
    /// The lend ended while the reply was streaming.
    Cut(EndReason),
    Failed(String),
}

/// One lend's forwarder. The host it talks to is fixed by the spec.
pub struct Forwarder {
    spec: Arc<ProxySpec>,
    auth: AuthSource,
    base: String,
    agent: ureq::Agent,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    note: SigninNote,
}

enum Msg {
    Head(ResponseHead),
    Data(Vec<u8>),
    Done,
    Error(String),
}

impl Forwarder {
    pub fn new(spec: Arc<ProxySpec>, auth: impl Into<AuthSource>) -> Result<Forwarder, String> {
        check_upstream(&spec.upstream)?;
        let base = spec.upstream.clone();
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(Duration::from_secs(20))
            .timeout_read(Duration::from_secs(300))
            .build();
        let note: SigninNote = Arc::new(|_| {});
        Ok(Forwarder { spec, auth: auth.into(), base, agent, now: Arc::new(crate::capacity_proxy::now_ms), note })
    }

    /// The clock (for token expiry) and who is told when the lend sign-in has a problem or works again.
    pub fn with_signin(mut self, now: Arc<dyn Fn() -> u64 + Send + Sync>, note: SigninNote) -> Self {
        self.now = now;
        self.note = note;
        self
    }

    /// The auth for THIS request. A lend sign-in's file is read now; `None` means it can't be used (not called upstream).
    async fn auth_now(&self) -> Option<InjectedAuth> {
        match &self.auth {
            AuthSource::Fixed(auth) => Some(auth.clone()),
            AuthSource::Account { file, spec } => {
                let (file, now) = (file.clone(), (self.now)());
                let token = tokio::task::spawn_blocking(move || file.token(now)).await.ok().and_then(Result::ok);
                (self.note)(token.is_none());
                token.map(|t| InjectedAuth::from_spec(spec, &t))
            }
        }
    }

    /// Tests only: send to a fake upstream on this machine. There is no way to do this outside tests.
    #[cfg(test)]
    pub fn with_test_upstream(mut self, base: &str) -> Self {
        let port_ok = base
            .strip_prefix("http://127.0.0.1:")
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        assert!(port_ok, "test upstream must be http://127.0.0.1:<port>");
        self.base = base.to_string();
        self
    }

    /// Handles ONE request on `stream` and reports how it ended.
    pub async fn serve_stream(&self, gate: &Arc<Gate>, stream: BiStream) -> Outcome {
        let mut send = stream.send;
        let mut recv = stream.recv;

        // 1. Read the request.
        let head = match tokio::time::timeout(HEAD_TIMEOUT, frame::read_request_head(&mut recv)).await {
            Ok(Ok(h)) => h,
            Ok(Err(FrameError::TooLarge)) => return refuse(&mut send, 413, frame::TOO_LARGE).await,
            Ok(Err(e)) => return Outcome::Failed(e.to_string()),
            Err(_) => return Outcome::Failed("timed out reading the request head".into()),
        };
        let body = match tokio::time::timeout(BODY_TIMEOUT, frame::read_request_body(&mut recv, self.spec.max_body_bytes)).await {
            Ok(Ok(b)) => b,
            Ok(Err(FrameError::TooLarge)) => return refuse(&mut send, 413, frame::TOO_LARGE).await,
            Ok(Err(e)) => return Outcome::Failed(e.to_string()),
            Err(_) => return Outcome::Failed("timed out reading the request body".into()),
        };
        drop(recv);

        // 2. An ended lend answers nothing.
        if gate.ended().is_some() {
            return refuse(&mut send, 403, frame::LEND_ENDED).await;
        }

        // 3. Only the listed method + path pairs, with a clean path and query.
        let Some((path, query)) = split_target(&head.path) else {
            return refuse(&mut send, 403, frame::PATH_NOT_ALLOWED).await;
        };
        if !self.spec.allows(&head.method, path) {
            return refuse(&mut send, 403, frame::PATH_NOT_ALLOWED).await;
        }

        // 4. The lender's auth, read now. A missing or expired sign-in is never sent upstream.
        let Some(auth) = self.auth_now().await else {
            let extra = [(frame::LEND_HEADER, frame::SIGNIN_EXPIRED_VALUE)];
            let _ = frame::write_json_response_with(&mut send, 401, frame::SIGNIN_EXPIRED, &extra).await;
            let _ = send.shutdown().await;
            return Outcome::Refused { status: 401 };
        };

        // 5. Count it in, unless the lend is over or used up.
        match gate.admit() {
            Ok(()) => {}
            Err(Refusal::Ended) => return refuse(&mut send, 403, frame::LEND_ENDED).await,
            Err(Refusal::Limit) => return refuse(&mut send, 429, frame::LEND_LIMIT).await,
        }

        // 6. The URL is always our base + the allowed path (+ the sanitized query).
        let url = if query.is_empty() { format!("{}{}", self.base, path) } else { format!("{}{}?{}", self.base, path, query) };
        let headers = outgoing_headers(&head.headers, &auth);

        // 7. Send from a blocking thread; the reply comes back over a small channel.
        let (tx, mut rx) = mpsc::channel::<Msg>(8);
        let agent = self.agent.clone();
        let method = head.method.clone();
        tokio::task::spawn_blocking(move || run_upstream(agent, method, url, headers, body, tx));

        // 8. Wait for the reply head (the lend may end meanwhile).
        let first = tokio::select! {
            msg = rx.recv() => msg,
            reason = gate.wait_end() => {
                drop(rx);
                let _ = frame::write_json_response(&mut send, 403, frame::LEND_ENDED).await;
                return Outcome::Cut(reason);
            }
        };
        let resp_head = match first {
            Some(Msg::Head(h)) => h,
            Some(Msg::Error(_)) | None => {
                let _ = frame::write_json_response(&mut send, 502, frame::UPSTREAM_ERROR).await;
                let _ = send.shutdown().await;
                return Outcome::Failed("upstream could not be reached".into());
            }
            Some(_) => return Outcome::Failed("upstream reader out of order".into()),
        };
        let status = resp_head.status;
        let content_type = resp_head
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let mut meter = meter::for_shape(&self.spec.shape, &content_type);
        if let Err(e) = frame::write_response_head(&mut send, &resp_head).await {
            return Outcome::Failed(e.to_string());
        }

        // 9. Stream the body until it ends, the borrower goes away, or the lend ends.
        let outcome = loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(Msg::Data(data)) => {
                        if let Some(m) = meter.as_mut() {
                            m.feed(&data);
                        }
                        // A borrower that stops reading must not hold the cut back: the write races the end.
                        let wrote = tokio::select! {
                            r = frame::write_data(&mut send, &data) => r,
                            reason = gate.wait_end() => break Outcome::Cut(reason),
                        };
                        if let Err(e) = wrote {
                            break Outcome::Failed(e.to_string());
                        }
                    }
                    Some(Msg::Done) => {
                        let ended = frame::write_end(&mut send).await;
                        let _ = send.shutdown().await;
                        break match ended {
                            Ok(()) => Outcome::Forwarded { status },
                            Err(e) => Outcome::Failed(e.to_string()),
                        };
                    }
                    Some(Msg::Error(e)) => {
                        let _ = frame::write_cut(&mut send).await;
                        break Outcome::Failed(e);
                    }
                    Some(Msg::Head(_)) => {}
                    None => {
                        let _ = frame::write_cut(&mut send).await;
                        break Outcome::Failed("upstream reader stopped".into());
                    }
                },
                reason = gate.wait_end() => {
                    let _ = frame::write_cut(&mut send).await;
                    let _ = send.flush().await;
                    break Outcome::Cut(reason);
                }
            }
        };
        if let Some(mut m) = meter {
            let (input, output) = m.finish();
            gate.add_usage(input, output);
        }
        outcome
    }
}

/// A refusal made here: a small JSON reply, then the stream is closed.
async fn refuse(send: &mut Box<dyn tokio::io::AsyncWrite + Send + Unpin>, status: u16, body: &str) -> Outcome {
    let _ = frame::write_json_response(send, status, body).await;
    let _ = send.shutdown().await;
    Outcome::Refused { status }
}

/// Splits `/path?query` and checks both. `None` means refuse.
fn split_target(target: &str) -> Option<(&str, &str)> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path_ok = path.starts_with('/')
        && path.is_ascii()
        && !path.bytes().any(|b| b.is_ascii_control() || b == b' ' || b == b'%' || b == b'\\' || b == b'#')
        && !path.contains("//")
        && !path.contains("..");
    let query_ok = query.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'~' | b'=' | b'&' | b'-'));
    (path_ok && query_ok).then_some((path, query))
}

/// The borrower's headers minus the ones it may not choose, plus the lender's auth.
fn outgoing_headers(borrower: &[(String, String)], auth: &InjectedAuth) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = borrower
        .iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            !DROP_REQUEST_HEADERS.contains(&k.as_str()) && !k.eq_ignore_ascii_case(&auth.header)
        })
        .cloned()
        .collect();
    out.push((auth.header.clone(), auth.value.clone()));
    for add in &auth.add_headers {
        let mut existing: Vec<String> = Vec::new();
        out.retain(|(k, v)| {
            if k.eq_ignore_ascii_case(&add.name) {
                existing.push(v.clone());
                false
            } else {
                true
            }
        });
        let mut tokens: Vec<String> = existing
            .iter()
            .flat_map(|v| v.split(','))
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if !tokens.iter().any(|t| t.eq_ignore_ascii_case(&add.value)) {
            tokens.push(add.value.clone());
        }
        out.push((add.name.clone(), tokens.join(",")));
    }
    out.push(("accept-encoding".into(), "identity".into()));
    out
}

/// Runs on a blocking thread: sends the request and passes the reply over `tx`. Stops when the receiver is gone.
fn run_upstream(agent: ureq::Agent, method: String, url: String, headers: Vec<(String, String)>, body: Vec<u8>, tx: mpsc::Sender<Msg>) {
    let mut req = agent.request(&method, &url);
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    let resp = match req.send_bytes(&body) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => {
            let _ = tx.blocking_send(Msg::Error(e.kind().to_string()));
            return;
        }
    };
    let mut out_headers = Vec::new();
    for name in resp.headers_names() {
        if DROP_RESPONSE_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        for value in resp.all(&name) {
            out_headers.push((name.clone(), value.to_string()));
        }
    }
    let head = ResponseHead { status: resp.status(), headers: out_headers };
    if tx.blocking_send(Msg::Head(head)).is_err() {
        return;
    }
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; READ_SIZE];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                let _ = tx.blocking_send(Msg::Done);
                return;
            }
            Ok(n) => {
                if tx.blocking_send(Msg::Data(buf[..n].to_vec())).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                let _ = tx.blocking_send(Msg::Error(e.to_string()));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> InjectedAuth {
        InjectedAuth {
            header: "authorization".into(),
            value: "Bearer tok-FAKE".into(),
            add_headers: vec![NameValue { name: "anthropic-beta".into(), value: "oauth-2025-04-20".into() }],
        }
    }

    fn h(k: &str, v: &str) -> (String, String) {
        (k.into(), v.into())
    }

    #[test]
    fn debug_never_prints_the_secret() {
        assert_eq!(format!("{:?}", auth()), "InjectedAuth(authorization)");
    }

    #[test]
    fn auth_value_with_and_without_scheme() {
        let with = AuthSpec { header: "authorization".into(), scheme: "Bearer".into(), ..Default::default() };
        assert_eq!(InjectedAuth::from_spec(&with, "s").value, "Bearer s");
        let without = AuthSpec { scheme: String::new(), ..with };
        assert_eq!(InjectedAuth::from_spec(&without, "s").value, "s");
    }

    #[test]
    fn targets_are_checked() {
        assert_eq!(split_target("/v1/messages"), Some(("/v1/messages", "")));
        assert_eq!(split_target("/v1/messages?beta=true&a-b_c.d~e=1"), Some(("/v1/messages", "beta=true&a-b_c.d~e=1")));
        for bad in [
            "v1/messages",
            "/v1/messages/../x",
            "/v1/%2e/x",
            "/v1\\x",
            "//v1/messages",
            "/v1//messages",
            "/v1/messages#x",
            "/v1/mess\u{e9}ges",
            "/v1/messages?a=%2f",
            "/v1/messages?a=b c",
            "/v1/messages?a=b?c",
            "/v1/messages?a=<x>",
            "/v1/me ssages",
        ] {
            assert_eq!(split_target(bad), None, "{bad}");
        }
    }

    #[test]
    fn outgoing_headers_drop_the_borrowers_auth_and_join_the_beta_list() {
        let borrower = vec![
            h("Authorization", "Bearer borrower"),
            h("X-Api-Key", "borrower-key"),
            h("Cookie", "a=b"),
            h("Host", "127.0.0.1:1"),
            h("Content-Length", "5"),
            h("Accept-Encoding", "gzip"),
            h("Anthropic-Beta", "claude-code-20250219"),
            h("anthropic-version", "2023-06-01"),
        ];
        let out = outgoing_headers(&borrower, &auth());
        let get = |name: &str| out.iter().filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).collect::<Vec<_>>();
        assert_eq!(get("authorization"), vec!["Bearer tok-FAKE"]);
        assert!(get("x-api-key").is_empty() && get("cookie").is_empty() && get("host").is_empty() && get("content-length").is_empty());
        assert_eq!(get("accept-encoding"), vec!["identity"]);
        assert_eq!(get("anthropic-beta"), vec!["claude-code-20250219,oauth-2025-04-20"]);
        assert_eq!(get("anthropic-version"), vec!["2023-06-01"]);
    }

    #[test]
    fn a_beta_token_already_present_is_not_doubled_and_a_missing_header_is_set() {
        let out = outgoing_headers(&[h("anthropic-beta", "x, oauth-2025-04-20")], &auth());
        assert!(out.contains(&h("anthropic-beta", "x,oauth-2025-04-20")));
        let out = outgoing_headers(&[], &auth());
        assert!(out.contains(&h("anthropic-beta", "oauth-2025-04-20")));
    }
}
