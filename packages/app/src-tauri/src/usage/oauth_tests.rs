//! Login-based reads against a local fake server (plain HTTP on 127.0.0.1, allowed only in tests; the shipped
//! URL is HTTPS): parsing, headers, 429 backoff, expired token, no redirects, and no token in any output.

use super::oauth::{self, Fetch, Secret, Token, UsageHttp};
use super::source::{self, Reader};
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CLAUDE_TOML: &str = include_str!("../tui/claude/usage.toml");
const ANSWER: &str = include_str!("../tui/claude/fixtures/usage/oauth-usage-synthetic.json");
const TOKEN: &str = "sk-SYNTHETIC-token-0123456789";

/// One canned reply per request, in order. Returns the URL and each request's header block.
fn serve(replies: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/api/oauth/usage", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            log.lock().push(head);
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (url, seen)
}

fn reply(status: &str, extra: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len())
}

fn spec() -> source::UsageSource {
    source::from_toml(CLAUDE_TOML).unwrap()
}

fn headers() -> Vec<(String, String)> {
    match spec().reader {
        Reader::OauthUsage { headers, .. } => headers,
        _ => unreachable!(),
    }
}

fn claude_home(expires_at: u64) -> PathBuf {
    let user = std::env::temp_dir().join(format!("pm-usage-oauth-{}", uuid::Uuid::new_v4()));
    let home = user.join(".claude");
    std::fs::create_dir_all(&home).unwrap();
    let body = format!(
        "{{\"claudeAiOauth\":{{\"accessToken\":\"{TOKEN}\",\"refreshToken\":\"rt-SYNTHETIC\",\"expiresAt\":{expires_at}}}}}"
    );
    std::fs::write(home.join(".credentials.json"), body).unwrap();
    user
}

fn secret() -> Secret {
    let user = claude_home(99_999_999_999_999);
    let token = oauth::read_token(&user.join(".claude"), ".credentials.json", "/claudeAiOauth/accessToken", Some("/claudeAiOauth/expiresAt"), 1);
    let _ = std::fs::remove_dir_all(user);
    match token {
        Token::Valid(s) => s,
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_answer_parses_with_the_agents_headers_and_the_token_never_prints() {
    let (url, seen) = serve(vec![reply("200 OK", "", ANSWER)]);
    let token = secret();
    assert_eq!(format!("{token:?}"), "***");
    let Fetch::Ok(answer) = oauth::LiveHttp.get(&url, &token, &headers()) else { panic!("not ok") };
    let head = seen.lock()[0].to_ascii_lowercase();
    assert!(head.contains(&format!("authorization: bearer {}", TOKEN.to_ascii_lowercase())));
    assert!(head.contains("anthropic-beta: oauth-2025-04-20"));
    assert!(head.contains("user-agent: claude-code/2.1.0"));
    let Reader::OauthUsage { windows, used, resets_at, .. } = spec().reader else { unreachable!() };
    let reading = oauth::parse(&answer, &windows, &used, &resets_at, 1_767_326_400_000);
    let got: Vec<(String, f64)> = reading.windows.iter().map(|w| (w.name.clone(), w.used_percent)).collect();
    assert_eq!(got, vec![("5-hour".to_string(), 42.0), ("Weekly".to_string(), 81.0), ("Weekly Opus".to_string(), 5.0)]);
    assert_eq!(reading.windows[0].resets_at_ms, Some(2_000_000_000_000));
    assert_eq!(reading.windows[2].resets_at_ms, None);
}

#[test]
fn rate_limits_unauthorized_and_redirects_are_told_apart() {
    let (url, seen) = serve(vec![
        reply("429 Too Many Requests", "Retry-After: 120\r\n", "{}"),
        reply("401 Unauthorized", "", "{}"),
        reply("302 Found", "Location: http://127.0.0.1:9/steal\r\n", ""),
    ]);
    let token = secret();
    assert_eq!(oauth::LiveHttp.get(&url, &token, &[]), Fetch::RateLimited { retry_after_ms: Some(120_000) });
    assert_eq!(oauth::LiveHttp.get(&url, &token, &[]), Fetch::Unauthorized);
    assert_eq!(oauth::LiveHttp.get(&url, &token, &[]), Fetch::Failed(oauth::Failure::Status(302)), "a redirect is not followed");
    assert_eq!(seen.lock().len(), 3);
    // A plain http URL that is not the test loopback is refused before any request.
    assert_eq!(oauth::LiveHttp.get("http://example.test/x", &token, &[]), Fetch::Failed(oauth::Failure::Refused));
}

#[test]
fn backoff_doubles_and_honours_retry_after() {
    assert_eq!(oauth::backoff_ms(1, None), 15 * 60_000);
    assert_eq!(oauth::backoff_ms(2, None), 30 * 60_000);
    assert_eq!(oauth::backoff_ms(9, None), 2 * 3_600_000);
    assert_eq!(oauth::backoff_ms(1, Some(120_000)), 120_000);
    assert_eq!(oauth::backoff_ms(1, Some(1_000)), 60_000);
}

/// Answers from a list and counts calls.
struct Scripted {
    answers: Mutex<Vec<Fetch>>,
    calls: AtomicUsize,
}

impl Scripted {
    fn new(answers: Vec<Fetch>) -> Self {
        Self { answers: Mutex::new(answers), calls: AtomicUsize::new(0) }
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl UsageHttp for Scripted {
    fn get(&self, _url: &str, _token: &Secret, _headers: &[(String, String)]) -> Fetch {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut answers = self.answers.lock();
        if answers.is_empty() {
            Fetch::Failed(oauth::Failure::Network)
        } else {
            answers.remove(0)
        }
    }
}

struct NoProbe;
impl Probe for NoProbe {
    fn run(&self, _: &str, _: &[String], _: &[(String, String)]) -> Option<String> {
        None
    }
}

type State = Mutex<std::collections::HashMap<String, OauthState>>;

fn run(user: &Path, http: &dyn UsageHttp, state: &State, now: SystemTime, force: bool) -> UsageSnapshot {
    run_inner(user, http, state, now, force, &[])
}

fn run_with(user: &Path, http: &dyn UsageHttp, state: &State, now: SystemTime, accounts: &[Account]) -> UsageSnapshot {
    run_inner(user, http, state, now, false, accounts)
}

fn run_inner(user: &Path, http: &dyn UsageHttp, state: &State, now: SystemTime, force: bool, accounts: &[Account]) -> UsageSnapshot {
    let claude = AgentUsage {
        id: "claude".into(),
        label: "Claude".into(),
        source: spec(),
        scheme: Some(crate::tui::AccountScheme {
            home_env: "CLAUDE_CONFIG_DIR".into(),
            extra_env: vec![],
            login_hint: String::new(),
            credential_files: vec![".credentials.json".into()],
        }),
    };
    let env = |_: &str| None;
    let inputs = Inputs {
        accounts,
        limits: &[],
        probe: &NoProbe,
        env: &env,
        home: Some(user.to_path_buf()),
        now,
        http,
        login_reads: true,
        may_fetch: true,
        force,
        oauth_state: state,
    };
    build(&[claude], &inputs)
}

fn at(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs)
}

const T0: u64 = 1_767_326_400;

#[test]
fn a_429_backs_off_and_the_last_numbers_stay_with_their_age() {
    let user = claude_home(99_999_999_999_999);
    let answer: serde_json::Value = serde_json::from_str(ANSWER).unwrap();
    let http = Scripted::new(vec![Fetch::Ok(answer), Fetch::RateLimited { retry_after_ms: None }]);
    let state = State::default();
    let first = run(&user, &http, &state, at(T0), false);
    assert_eq!(first.rows[0].state, "ok");
    assert_eq!(first.rows[0].windows[1].used_percent, 81.0);
    assert_eq!(first.rows[0].observed_at_ms, Some(T0 * 1000));
    // Within 15 minutes nothing is asked, even on refresh.
    run(&user, &http, &state, at(T0 + 60), true);
    assert_eq!(http.calls(), 1);
    // After 15 minutes: a 429. The old numbers stay, with their time, and a reason.
    let limited = run(&user, &http, &state, at(T0 + 16 * 60), false);
    assert_eq!(http.calls(), 2);
    assert_eq!(limited.rows[0].windows[1].used_percent, 81.0);
    assert_eq!(limited.rows[0].observed_at_ms, Some(T0 * 1000));
    assert_eq!(
        limited.rows[0].reason.as_deref(),
        Some("Showing the last numbers read. Anthropic said slow down (429); trying again in 15 min.")
    );
    // During the backoff a refresh asks nothing.
    run(&user, &http, &state, at(T0 + 20 * 60), true);
    assert_eq!(http.calls(), 2);
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn an_expired_token_is_never_sent_and_shows_sign_in_expired() {
    let user = claude_home(T0 * 1000 - 1);
    let http = Scripted::new(vec![]);
    let state = State::default();
    let snap = run(&user, &http, &state, at(T0), true);
    assert_eq!(http.calls(), 0);
    assert_eq!(snap.rows[0].state, "expired");
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn a_401_shows_sign_in_expired() {
    let user = claude_home(99_999_999_999_999);
    let http = Scripted::new(vec![Fetch::Unauthorized]);
    let state = State::default();
    assert_eq!(run(&user, &http, &state, at(T0), false).rows[0].state, "expired");
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn no_token_in_the_snapshot_the_state_or_any_log_line() {
    let user = claude_home(99_999_999_999_999);
    let answer: serde_json::Value = serde_json::from_str(ANSWER).unwrap();
    let http = Scripted::new(vec![Fetch::Ok(answer)]);
    let state = State::default();
    let snap = run(&user, &http, &state, at(T0), false);
    let out = format!("{}{:?}{:?}", serde_json::to_string(&snap).unwrap(), snap, state.lock());
    assert!(!out.contains("SYNTHETIC"), "{out}");
    // Guard: no logging call in the usage code mentions a token or a secret.
    for (name, text) in [("oauth.rs", include_str!("oauth.rs")), ("mod.rs", include_str!("mod.rs"))] {
        for line in text.lines() {
            let l = line.to_ascii_lowercase();
            let logs = ["tracing::", "println!", "eprintln!", "log::", "dbg!"].iter().any(|m| l.contains(m));
            assert!(!(logs && (l.contains("token") || l.contains("secret") || l.contains("expose"))), "{name}: {line}");
        }
    }
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn a_failed_first_read_says_what_was_answered_and_when_it_tries_again() {
    let cases = [
        (Fetch::RateLimited { retry_after_ms: Some(120_000) }, "Anthropic said slow down (429); trying again in 2 min."),
        (Fetch::Failed(oauth::Failure::Status(500)), "Anthropic answered 500; trying again in 15 min."),
        (Fetch::Failed(oauth::Failure::Network), "Could not reach Anthropic; trying again in 15 min."),
        (Fetch::Failed(oauth::Failure::BadAnswer), "Anthropic's answer could not be read; trying again in 15 min."),
    ];
    for (answer, want) in cases {
        let user = claude_home(99_999_999_999_999);
        let http = Scripted::new(vec![answer]);
        let state = State::default();
        let snap = run(&user, &http, &state, at(T0), false);
        assert_eq!(snap.rows[0].state, "unknown");
        assert_eq!(snap.rows[0].reason.as_deref(), Some(want));
        // Later, the wait shrinks.
        let later = run(&user, &http, &state, at(T0 + 60), false);
        assert!(!later.rows[0].reason.as_deref().unwrap().contains("Could not read usage yet"));
        let _ = std::fs::remove_dir_all(user);
    }
    assert_eq!(failure_text(LastFailure::RateLimited, "Anthropic", 90 * 60_000), "Anthropic said slow down (429); trying again in 1 h 30 min.");
}

#[test]
fn the_main_login_and_an_account_are_read_from_their_own_homes() {
    // The main login is `<user>/.claude` (no CLAUDE_CONFIG_DIR); an account is its own folder. Each gets its own
    // token, request and backoff: one 429 never holds back the other.
    let user = claude_home(99_999_999_999_999);
    let acct_home = user.join("lend");
    std::fs::create_dir_all(&acct_home).unwrap();
    std::fs::copy(user.join(".claude").join(".credentials.json"), acct_home.join(".credentials.json")).unwrap();
    let answer: serde_json::Value = serde_json::from_str(ANSWER).unwrap();
    let http = Scripted::new(vec![Fetch::RateLimited { retry_after_ms: None }, Fetch::Ok(answer)]);
    let state = State::default();
    let account = Account { id: "acc_l".into(), agent_id: "claude".into(), label: "Lend Claude".into(), home: acct_home.to_string_lossy().into_owned(), lend_only: false };
    let snap = run_with(&user, &http, &state, at(T0), &[account]);
    assert_eq!(http.calls(), 2);
    assert_eq!(snap.rows[0].account_id, None);
    assert!(snap.rows[0].reason.as_deref().unwrap().contains("(429)"));
    assert_eq!(snap.rows[1].account_label.as_deref(), Some("Lend Claude"));
    assert_eq!(snap.rows[1].state, "ok");
    let keys: Vec<String> = state.lock().keys().cloned().collect();
    assert!(keys.iter().any(|k| k.ends_with(".claude")) && keys.iter().any(|k| k.ends_with("lend")), "{keys:?}");
    let _ = std::fs::remove_dir_all(user);
}
