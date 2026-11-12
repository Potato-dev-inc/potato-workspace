//! Discord alerts: the strict link check, the messages (which kinds, the words, the length), the rate limit, and
//! that the link never leaves the credential store or shows in an error. The server is a fake on 127.0.0.1.

use super::client::{Post, SendError, UreqPost};
use super::service::{AlertKind, Kinds, Outcome, Service, DEDUPE_MS, MAX_PER_WINDOW, SECRET_NAME, TEST_GAP_MS, WINDOW_MS};
use super::webhook::{UrlError, Webhook};
use super::{message_for, MAX_CHARS};
use crate::push::hub::Candidate;
use crate::push::triggers::{Kind, PromptInfo};
use crate::secrets::{MemoryBackend, SecretBackend};
use parking_lot::Mutex;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const ID: &str = "123456789012345678";
const TOKEN: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH";

fn real_url() -> String {
    format!("https://discord.com/api/webhooks/{ID}/{TOKEN}")
}

// ---------------------------------------------------------------------------------------------
// A fake webhook server

struct Fake {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
}

fn serve(stream: &mut TcpStream, requests: &Mutex<Vec<String>>, status: u16) {
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    let (mut head_end, mut want) = (None, 0usize);
    loop {
        let n = stream.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        if head_end.is_none() {
            if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                head_end = Some(at + 4);
                let head = String::from_utf8_lossy(&data[..at]).to_ascii_lowercase();
                want = head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
            }
        }
        if let Some(end) = head_end {
            if data.len() >= end + want {
                break;
            }
        }
    }
    requests.lock().push(String::from_utf8_lossy(&data).to_string());
    let reply = match status {
        204 => "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        429 => "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        code => format!("HTTP/1.1 {code} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    };
    let _ = stream.write_all(reply.as_bytes());
}

fn fake(status: u16) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let r = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            serve(&mut stream, &r, status);
        }
    });
    Fake { port, requests }
}

impl Fake {
    fn hook(&self) -> Webhook {
        Webhook::for_test(&format!("http://127.0.0.1:{}/api/webhooks/{ID}/{TOKEN}", self.port), TOKEN)
    }
    fn count(&self) -> usize {
        self.requests.lock().len()
    }
    fn last_body(&self) -> serde_json::Value {
        let raw = self.requests.lock().last().cloned().expect("a request");
        let body = raw.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();
        serde_json::from_str(&body).unwrap_or_else(|_| panic!("body is json: {body}"))
    }
}

// ---------------------------------------------------------------------------------------------
// A service on an in-memory credential store and a temp folder

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Rig {
    service: Service,
    backend: &'static MemoryBackend,
    prefs: std::path::PathBuf,
}

fn rig_with(post: Box<dyn Post>) -> Rig {
    let backend: &'static MemoryBackend = Box::leak(Box::new(MemoryBackend::new()));
    let dir = std::env::temp_dir().join(format!("pm-discord-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let prefs = dir.join("discord-alerts.json");
    Rig { service: Service::new(backend, prefs.clone(), post), backend, prefs }
}

fn rig(fake: &Fake) -> Rig {
    let r = rig_with(Box::new(UreqPost::new()));
    r.service.use_hook_for_test(fake.hook());
    r
}

fn candidate(kind: Kind, key: &str) -> Candidate {
    Candidate {
        kind,
        key: key.into(),
        pane_id: Some(key.into()),
        agent_label: "Codex".into(),
        heading: Some("auth refactor".into()),
        prompt: None,
        item: None,
        detail: None,
    }
}

fn send(r: &Rig, c: &Candidate, now: u64) -> Outcome {
    let kind = AlertKind::of(c.kind).expect("an alert kind");
    r.service.send_alert(kind, &c.key, &message_for(c), now)
}

// ---------------------------------------------------------------------------------------------
// The link check stays strict

#[test]
fn a_real_looking_discord_link_is_accepted_and_tidied() {
    let hook = Webhook::parse(&format!("  https://DISCORD.com/api/webhooks/{ID}/{TOKEN}/  ")).unwrap();
    assert_eq!(hook.as_str(), real_url());
    assert_eq!(hook.tail(), "EFGH");
    for host in ["discordapp.com", "canary.discord.com", "ptb.discord.com", "canary.discordapp.com", "ptb.discordapp.com"] {
        assert!(Webhook::parse(&format!("https://{host}/api/webhooks/{ID}/{TOKEN}")).is_ok(), "{host}");
    }
}

#[test]
fn only_https_discord_webhook_links_are_accepted() {
    let bad: Vec<(String, UrlError)> = vec![
        (String::new(), UrlError::Empty),
        (format!("http://discord.com/api/webhooks/{ID}/{TOKEN}"), UrlError::NotHttps),
        (format!("http://127.0.0.1:8080/api/webhooks/{ID}/{TOKEN}"), UrlError::NotHttps),
        (format!("https://127.0.0.1/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongHost),
        (format!("https://evil.com/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongHost),
        (format!("https://discord.com.evil.com/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongHost),
        (format!("https://evil-discord.com/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongHost),
        (format!("https://discord.com@evil.com/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongPath),
        (format!("https://discord.com:8443/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}/{TOKEN}?wait=true"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}/{TOKEN}#x"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}/{TOKEN}/github"), UrlError::WrongPath),
        (format!("https://discord.com/api/v10/webhooks/{ID}/{TOKEN}"), UrlError::WrongPath),
        (format!("https://discord.com/webhooks/{ID}/{TOKEN}"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/12ab/{TOKEN}"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}/short"), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}/{}", "a/b".repeat(10)), UrlError::WrongPath),
        (format!("https://discord.com/api/webhooks/{ID}/tok en{}", "x".repeat(20)), UrlError::WrongPath),
        (format!("https://discord.com\\@evil.com/api/webhooks/{ID}/{TOKEN}"), UrlError::WrongPath),
    ];
    for (raw, why) in bad {
        assert_eq!(Webhook::parse(&raw).err(), Some(why), "{raw}");
    }
}

#[test]
fn a_refusal_never_repeats_the_pasted_text() {
    let pasted = "https://evil.example/api/webhooks/123456789012345678/SECRETSECRETSECRETSECRET";
    let err = Webhook::parse(pasted).unwrap_err().to_string();
    assert!(!err.contains("evil") && !err.contains("SECRET"), "{err}");
    let r = rig_with(Box::new(UreqPost::new()));
    let message = r.service.set_url(pasted).unwrap_err();
    assert!(!message.contains("evil") && !message.contains("SECRET"), "{message}");
    assert!(!r.service.status().saved);
}

#[test]
fn debug_output_hides_the_link() {
    let hook = Webhook::parse(&real_url()).unwrap();
    let shown = format!("{hook:?}");
    assert!(!shown.contains(TOKEN) && !shown.contains(ID), "{shown}");
}

// ---------------------------------------------------------------------------------------------
// Where the link is kept

#[test]
fn the_link_lives_only_in_the_credential_store() {
    let r = rig_with(Box::new(UreqPost::new()));
    assert!(!r.service.status().saved);
    let status = r.service.set_url(&real_url()).unwrap();
    assert!(status.saved && status.active);
    assert_eq!(status.tail.as_deref(), Some("EFGH"));
    assert_eq!(r.backend.get(SECRET_NAME).unwrap().as_deref(), Some(real_url().as_str()), "kept in the credential store");

    r.service.set_kinds(Kinds { needs_you: true, finished: true, failed: false }).unwrap();
    let prefs = std::fs::read_to_string(&r.prefs).unwrap();
    assert!(!prefs.contains(TOKEN) && !prefs.contains(ID) && !prefs.contains("discord.com"), "the prefs file holds no link: {prefs}");

    let shown = serde_json::to_string(&r.service.status()).unwrap();
    assert!(!shown.contains(TOKEN) && !shown.contains(ID), "the status holds no link: {shown}");

    let cleared = r.service.clear().unwrap();
    assert!(!cleared.saved && cleared.tail.is_none() && !cleared.active);
    assert_eq!(r.backend.get(SECRET_NAME).unwrap(), None);
}

#[test]
fn a_saved_link_is_read_back_when_the_app_starts_again() {
    let r = rig_with(Box::new(UreqPost::new()));
    r.service.set_url(&real_url()).unwrap();
    r.service.set_kinds(Kinds { needs_you: false, finished: true, failed: false }).unwrap();
    let again = Service::new(r.backend, r.prefs.clone(), Box::new(UreqPost::new()));
    let status = again.status();
    assert!(status.saved);
    assert_eq!(status.kinds, Kinds { needs_you: false, finished: true, failed: false });
    assert!(again.wants(AlertKind::Finished) && !again.wants(AlertKind::NeedsYou));
}

#[test]
fn off_until_a_link_is_saved_and_with_the_defaults_after() {
    let r = rig_with(Box::new(UreqPost::new()));
    assert!(!r.service.listening());
    assert!(!r.service.wants(AlertKind::NeedsYou));
    assert_eq!(r.service.status().kinds, Kinds { needs_you: true, finished: false, failed: true });
    r.service.set_url(&real_url()).unwrap();
    assert!(r.service.listening());
    assert!(r.service.wants(AlertKind::NeedsYou) && r.service.wants(AlertKind::Failed) && !r.service.wants(AlertKind::Finished));
    r.service.set_kinds(Kinds { needs_you: false, finished: false, failed: false }).unwrap();
    assert!(!r.service.listening(), "a link with every alert off posts nothing");
    r.service.clear().unwrap();
    r.service.set_kinds(Kinds::default()).unwrap();
    assert!(!r.service.listening(), "no link, no alerts");
}

#[test]
fn old_or_odd_preference_files_are_ignored_not_fatal() {
    for (text, expected) in [
        ("", Kinds::default()),
        ("not json at all", Kinds::default()),
        ("[1, 2]", Kinds::default()),
        (r#"{"tag_bot": {"enabled": true}, "animated_tray_icon": false, "needs_you": false}"#, Kinds { needs_you: false, finished: false, failed: true }),
        (r#"{"finished": true, "focus": {"on": true}}"#, Kinds { needs_you: true, finished: true, failed: true }),
    ] {
        let r = rig_with(Box::new(UreqPost::new()));
        std::fs::create_dir_all(r.prefs.parent().unwrap()).unwrap();
        std::fs::write(&r.prefs, text).unwrap();
        assert_eq!(r.service.status().kinds, expected, "{text}");
    }
}

// ---------------------------------------------------------------------------------------------
// The Test button

#[test]
fn test_sends_exactly_one_plain_message_that_pings_nobody() {
    let server = fake(204);
    let r = rig(&server);
    let outcome = r.service.test(10_000);
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(server.count(), 1);
    let body = server.last_body();
    assert!(body["content"].as_str().unwrap().contains("Discord alerts are connected"));
    assert_eq!(body["allowed_mentions"], serde_json::json!({"parse": []}));
    let raw = server.requests.lock()[0].clone();
    assert!(raw.starts_with(&format!("POST /api/webhooks/{ID}/{TOKEN} HTTP/1.1")), "{}", raw.lines().next().unwrap_or(""));
}

#[test]
fn test_works_even_when_every_alert_is_off_and_is_not_repeated_at_once() {
    let server = fake(204);
    let r = rig(&server);
    r.service.set_kinds(Kinds { needs_you: false, finished: false, failed: false }).unwrap();
    assert!(r.service.test(0).ok);
    let again = r.service.test(TEST_GAP_MS - 1);
    assert!(!again.ok);
    assert_eq!(server.count(), 1, "the second press sent nothing");
    assert!(r.service.test(TEST_GAP_MS).ok);
    assert_eq!(server.count(), 2);
}

#[test]
fn test_without_a_link_says_so_and_sends_nothing() {
    let r = rig_with(Box::new(UreqPost::new()));
    let outcome = r.service.test(0);
    assert!(!outcome.ok);
    assert!(outcome.message.contains("Paste a webhook link"));
}

// ---------------------------------------------------------------------------------------------
// Which events become messages

#[test]
fn every_push_kind_maps_to_an_alert_or_to_none() {
    use AlertKind::*;
    for kind in [Kind::WaitingInput, Kind::Error, Kind::Question, Kind::TrustGate, Kind::Consent, Kind::Budget, Kind::Limit] {
        assert_eq!(AlertKind::of(kind), Some(NeedsYou), "{}", kind.as_str());
    }
    assert_eq!(AlertKind::of(Kind::RunFinished), Some(Finished));
    assert_eq!(AlertKind::of(Kind::RunFailed), Some(Failed));
    assert_eq!(AlertKind::of(Kind::CompanionReply), None);
    assert_eq!(AlertKind::of(Kind::NightShift), None);
}

#[test]
fn needs_you_finished_and_failed_post_only_when_their_kind_is_on() {
    let server = fake(204);
    let r = rig(&server);
    // The defaults: needs you ON, failed ON, finished OFF.
    assert_eq!(send(&r, &candidate(Kind::WaitingInput, "p1"), 1_000), Outcome::Sent);
    assert_eq!(send(&r, &candidate(Kind::RunFailed, "p2"), 1_000), Outcome::Sent);
    assert_eq!(send(&r, &candidate(Kind::RunFinished, "p3"), 1_000), Outcome::Off);
    assert_eq!(server.count(), 2);
    let texts: Vec<String> = server.requests.lock().iter().map(|raw| raw.to_string()).collect();
    assert!(texts[0].contains("Needs you"), "{}", texts[0]);
    assert!(texts[1].contains("Run failed"), "{}", texts[1]);

    r.service.set_kinds(Kinds { needs_you: false, finished: true, failed: false }).unwrap();
    assert_eq!(send(&r, &candidate(Kind::WaitingInput, "p4"), 2_000), Outcome::Off);
    assert_eq!(send(&r, &candidate(Kind::RunFailed, "p5"), 2_000), Outcome::Off);
    assert_eq!(send(&r, &candidate(Kind::RunFinished, "p6"), 2_000), Outcome::Sent);
    assert_eq!(server.count(), 3);
    assert!(server.requests.lock()[2].contains("finished"));
}

#[test]
fn nothing_is_posted_without_a_link() {
    let server = fake(204);
    let r = rig_with(Box::new(UreqPost::new()));
    assert_eq!(send(&r, &candidate(Kind::Error, "p1"), 0), Outcome::Off);
    assert_eq!(server.count(), 0);
}

// ---------------------------------------------------------------------------------------------
// Rate limit and repeats

#[test]
fn the_same_card_is_posted_once() {
    let server = fake(204);
    let r = rig(&server);
    let card = candidate(Kind::WaitingInput, "p1");
    assert_eq!(send(&r, &card, 1_000), Outcome::Sent);
    assert_eq!(send(&r, &card, 1_500), Outcome::Duplicate);
    assert_eq!(send(&r, &card, DEDUPE_MS), Outcome::Duplicate, "just inside the window");
    assert_eq!(send(&r, &card, 1_000 + DEDUPE_MS), Outcome::Sent, "after the window it may be said again");
    assert_eq!(server.count(), 2);
}

#[test]
fn at_most_ten_alerts_a_minute_and_the_rest_are_dropped() {
    let server = fake(204);
    let r = rig(&server);
    for i in 0..MAX_PER_WINDOW {
        assert_eq!(send(&r, &candidate(Kind::Error, &format!("pane-{i}")), 1_000 + i as u64), Outcome::Sent, "{i}");
    }
    assert_eq!(send(&r, &candidate(Kind::Error, "pane-extra"), 5_000), Outcome::RateLimited);
    assert_eq!(server.count(), MAX_PER_WINDOW);
    assert_eq!(send(&r, &candidate(Kind::Error, "pane-later"), 1_000 + WINDOW_MS), Outcome::Sent, "room again once the first has left the window");
    assert_eq!(server.count(), MAX_PER_WINDOW + 1);
}

// ---------------------------------------------------------------------------------------------
// The words

#[test]
fn a_secret_in_agent_text_is_masked_before_it_leaves() {
    let server = fake(204);
    let r = rig(&server);
    let secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    let mut c = candidate(Kind::WaitingInput, "p1");
    c.prompt = Some(PromptInfo { prompt_id: "x".into(), text: format!("Run command: curl -H 'Authorization: token {secret}' https://api.example.com"), actionable: false, risk: None });
    let text = message_for(&c);
    assert!(!text.contains(secret), "{text}");
    assert_eq!(send(&r, &c, 0), Outcome::Sent);
    assert!(!server.requests.lock()[0].contains(secret));
}

#[test]
fn the_message_is_cut_well_under_the_discord_limit() {
    let mut c = candidate(Kind::WaitingInput, "p1");
    c.heading = Some("h".repeat(400));
    c.prompt = Some(PromptInfo { prompt_id: "x".into(), text: "word ".repeat(2_000), actionable: false, risk: None });
    let text = message_for(&c);
    assert!(text.chars().count() <= MAX_CHARS, "{}", text.chars().count());
    assert!(MAX_CHARS < 2_000);
    let mut q = candidate(Kind::Question, "q-1");
    q.prompt = Some(PromptInfo { prompt_id: String::new(), text: "line\n".repeat(3_000), actionable: false, risk: None });
    assert!(message_for(&q).chars().count() <= MAX_CHARS);
}

#[test]
fn the_message_is_plain_text_with_no_agent_names_in_the_code_path() {
    let c = candidate(Kind::RunFinished, "p1");
    let text = message_for(&c);
    assert!(text.contains("Codex") && text.contains("finished"), "{text}");
    // The same code handles any label.
    let mut other = candidate(Kind::RunFinished, "p2");
    other.agent_label = "Some Other Agent".into();
    assert!(message_for(&other).contains("Some Other Agent"));
}

// ---------------------------------------------------------------------------------------------
// The link never shows in an error or a log

fn assert_no_link(text: &str) {
    assert!(!text.contains(TOKEN), "token in: {text}");
    assert!(!text.contains(ID), "id in: {text}");
    assert!(!text.contains("127.0.0.1"), "address in: {text}");
    assert!(!text.contains("webhooks"), "path in: {text}");
}

#[test]
fn a_failing_send_never_puts_the_link_in_its_error() {
    for status in [400u16, 401, 404, 429, 500, 302] {
        let server = fake(status);
        let r = rig(&server);
        let outcome = send(&r, &candidate(Kind::Error, "p1"), 0);
        let Outcome::Failed(err) = outcome else { panic!("status {status} should fail, got {outcome:?}") };
        assert_no_link(&err.to_string());
        assert_no_link(&format!("{err:?}"));
        let tested = r.service.test(0);
        assert!(!tested.ok);
        assert_no_link(&tested.message);
    }
}

#[test]
fn a_gone_webhook_and_a_slow_down_are_told_in_plain_words() {
    let gone = fake(404);
    let r = rig(&gone);
    assert!(r.service.test(0).message.contains("Make a new one"));
    let slow = fake(429);
    let r = rig(&slow);
    let Outcome::Failed(SendError::RateLimited { retry_after_s }) = send(&r, &candidate(Kind::Error, "p1"), 0) else { panic!("rate limited") };
    assert_eq!(retry_after_s, 2);
}

#[test]
fn an_unreachable_server_is_a_network_error_without_the_address() {
    // A port that nothing listens on: bind, note the port, drop.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let r = rig_with(Box::new(UreqPost::new()));
    r.service.use_hook_for_test(Webhook::for_test(&format!("http://127.0.0.1:{port}/api/webhooks/{ID}/{TOKEN}"), TOKEN));
    let Outcome::Failed(err) = send(&r, &candidate(Kind::Error, "p1"), 0) else { panic!("should fail") };
    assert_eq!(err, SendError::Network);
    assert_no_link(&err.to_string());
    let tested = r.service.test(0);
    assert!(!tested.ok);
    assert_no_link(&tested.message);
}

#[test]
fn the_module_never_logs_or_prints_the_link() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("discord_alerts");
    for file in ["mod.rs", "client.rs", "service.rs", "webhook.rs"] {
        let text = std::fs::read_to_string(dir.join(file)).unwrap();
        for (n, line) in text.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            let logs = ["tracing::", "println!", "eprintln!", "dbg!", "log::", "warn!(", "info!(", "debug!(", "error!("].iter().any(|m| trimmed.contains(m));
            if logs {
                let lowered = trimmed.to_ascii_lowercase();
                for word in ["url", "hook", "token", "secret", "webhook"] {
                    assert!(!lowered.contains(word), "{file}:{}: a log line mentions {word}: {trimmed}", n + 1);
                }
            }
        }
    }
}
