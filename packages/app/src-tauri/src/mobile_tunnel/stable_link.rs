//! Stable link: tell the person's own Worker (`relay/stable-link`) where this computer is right now.
//!
//! Every new trycloudflare address is registered with the Worker (`POST /_pm/link/register`, bearer =
//! the shared secret). Registration runs in a background thread with a growing wait between tries, so
//! a Worker that is briefly down, or a network that is not up yet, never blocks the tunnel.
//!
//! The secret only ever lives in `tunnel_config` (own file, 0600), in this thread's memory and in the
//! `Authorization` header of the register call. It is never logged and never part of an error text.

use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_WAIT_SECS: u64 = 2;
const LONGEST_WAIT_SECS: u64 = 60;

pub fn register_url(worker_url: &str) -> String {
    format!("{}/_pm/link/register", worker_url.trim_end_matches('/'))
}

pub fn reset_url(worker_url: &str) -> String {
    format!("{}/_pm/link/reset", worker_url.trim_end_matches('/'))
}

pub fn health_url(worker_url: &str) -> String {
    format!("{}/_pm/link/health", worker_url.trim_end_matches('/'))
}

/// Where a registration stands (what Settings shows next to the Worker address).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    /// No quick-tunnel address yet.
    Waiting,
    /// Telling the Worker.
    Registering,
    Linked,
    /// Not linked, with a sentence that says why. The thread keeps trying unless the reason is final.
    Failed(String),
}

/// The Worker's answer to one register call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Linked,
    /// 403: the Worker has another secret. Trying again cannot help.
    SecretMismatch,
    /// 400: the Worker refuses this address. Trying again cannot help.
    AddressRefused,
    /// Anything else (no network, Worker down, 429, 5xx): try again later.
    Retry(String),
}

impl Outcome {
    /// The sentence for the status line; `None` once linked.
    pub fn problem(&self) -> Option<String> {
        match self {
            Self::Linked => None,
            Self::SecretMismatch => Some("The secret does not match the one the Worker has. Make a new secret, or reset the Worker.".into()),
            Self::AddressRefused => Some("The Worker refused this tunnel address. Is it a stable-link Worker?".into()),
            Self::Retry(why) => Some(why.clone()),
        }
    }

    /// Whether another try can still help.
    pub fn is_final(&self) -> bool {
        matches!(self, Self::Linked | Self::SecretMismatch | Self::AddressRefused)
    }
}

/// Read the Worker's answer. Pure, so every case is a unit test.
pub fn interpret_register(http_status: Option<u16>, transport_error: Option<&str>) -> Outcome {
    match (http_status, transport_error) {
        (_, Some(err)) => Outcome::Retry(format!("Could not reach the Worker: {err}")),
        (Some(200), None) => Outcome::Linked,
        (Some(401 | 403), None) => Outcome::SecretMismatch,
        (Some(400), None) => Outcome::AddressRefused,
        (Some(429), None) => Outcome::Retry("The Worker says too many tries. Waiting a little.".into()),
        (Some(code), None) => Outcome::Retry(format!("The Worker answered HTTP {code}.")),
        (None, None) => Outcome::Retry("The Worker did not answer.".into()),
    }
}

/// Seconds to wait after the `attempt`-th failed try (0 = the first): 2, 4, 8 ... 60.
pub fn backoff(attempt: u32) -> Duration {
    let secs = FIRST_WAIT_SECS.saturating_mul(1u64 << attempt.min(6));
    Duration::from_secs(secs.min(LONGEST_WAIT_SECS))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build()
}

/// One register call. The error text never contains the secret (ureq's transport errors name only the URL).
pub fn register_once(worker_url: &str, secret: &str, origin: &str) -> Outcome {
    let result = agent()
        .post(&register_url(worker_url))
        .set("Authorization", &format!("Bearer {secret}"))
        .set("Accept-Encoding", "identity")
        .set("Content-Type", "application/json")
        .send_string(&serde_json::json!({ "origin": origin }).to_string());
    match result {
        Ok(resp) => interpret_register(Some(resp.status()), None),
        Err(ureq::Error::Status(code, _)) => interpret_register(Some(code), None),
        Err(err) => interpret_register(None, Some(&err.kind().to_string())),
    }
}

/// Ask the Worker to forget its link and secret (used before a new secret replaces the old one).
/// Best effort: a Worker that is down or has another secret simply keeps what it has.
pub fn reset_once(worker_url: &str, secret: &str) -> bool {
    agent()
        .post(&reset_url(worker_url))
        .set("Authorization", &format!("Bearer {secret}"))
        .set("Accept-Encoding", "identity")
        .call()
        .is_ok()
}

/// Try until linked, a final answer, or `is_current` turns false (a newer tunnel or a restart).
/// `attempt` does the call, `sleep` waits, `report` shows the state. All three are passed in so the
/// retry rules can be tested without a clock or a network.
pub fn register_until_done(
    mut attempt: impl FnMut() -> Outcome,
    mut sleep: impl FnMut(Duration),
    is_current: impl Fn() -> bool,
    mut report: impl FnMut(LinkState),
) -> Outcome {
    let mut tries: u32 = 0;
    loop {
        if !is_current() {
            return Outcome::Retry("stopped".into());
        }
        report(LinkState::Registering);
        let outcome = attempt();
        match outcome.problem() {
            None => {
                report(LinkState::Linked);
                return outcome;
            }
            Some(why) => report(LinkState::Failed(why)),
        }
        if outcome.is_final() {
            return outcome;
        }
        sleep(backoff(tries));
        tries = tries.saturating_add(1);
    }
}

/// What "Test connection" learns from `<worker>/_pm/link/health`: `Ok` only when linked.
pub fn interpret_worker_health(http_status: Option<u16>, body: &str, transport_error: Option<&str>) -> Result<(), String> {
    match (http_status, transport_error) {
        (_, Some(err)) => Err(format!("Could not reach the Worker: {err}")),
        (Some(200), None) => match serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v.get("linked")?.as_bool()) {
            Some(true) => Ok(()),
            Some(false) => Err("The Worker is up, but this computer is not linked to it yet. Press Restart tunnel.".into()),
            None => Err("That address answered, but it is not a stable-link Worker.".into()),
        },
        (Some(code), None) => Err(format!("The Worker address answered with HTTP {code}, not a stable-link Worker.")),
        (None, None) => Err("The Worker did not answer.".into()),
    }
}

/// Fetch `<worker>/_pm/link/health` (blocking).
pub fn check_worker(worker_url: &str) -> Result<(), String> {
    let result = agent().get(&health_url(worker_url)).set("Accept-Encoding", "identity").call();
    match result {
        Ok(resp) => {
            let status = resp.status();
            interpret_worker_health(Some(status), &resp.into_string().unwrap_or_default(), None)
        }
        Err(ureq::Error::Status(code, resp)) => interpret_worker_health(Some(code), &resp.into_string().unwrap_or_default(), None),
        Err(err) => interpret_worker_health(None, "", Some(&err.kind().to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A loopback Worker that gives `answers` one after the other and records every request it gets.
    fn fake_worker(answers: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let handle = std::thread::spawn(move || {
            for (status, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 4096];
                let mut got = Vec::new();
                // read until the whole request (head + small JSON body) is in
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    let Some(head_end) = text.find("\r\n\r\n") else {
                        if n == 0 {
                            break;
                        }
                        continue;
                    };
                    let wanted = text
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if n == 0 || got.len() >= head_end + 4 + wanted {
                        break;
                    }
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&got).to_string());
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen, handle)
    }

    #[test]
    fn the_worker_answers_map_to_plain_outcomes() {
        assert_eq!(interpret_register(Some(200), None), Outcome::Linked);
        assert_eq!(interpret_register(Some(403), None), Outcome::SecretMismatch);
        assert_eq!(interpret_register(Some(400), None), Outcome::AddressRefused);
        for code in [429, 500, 503, 404] {
            assert!(matches!(interpret_register(Some(code), None), Outcome::Retry(_)), "{code}");
        }
        assert!(matches!(interpret_register(None, Some("dns")), Outcome::Retry(_)));
        let mismatch = Outcome::SecretMismatch.problem().unwrap();
        assert!(mismatch.contains("secret does not match"), "{mismatch}");
        assert!(Outcome::Linked.problem().is_none());
        assert!(Outcome::SecretMismatch.is_final() && Outcome::AddressRefused.is_final() && !Outcome::Retry("x".into()).is_final());
    }

    #[test]
    fn backoff_grows_from_two_to_sixty_seconds() {
        let secs: Vec<u64> = (0..9).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, [2, 4, 8, 16, 32, 60, 60, 60, 60]);
        assert_eq!(backoff(u32::MAX).as_secs(), 60);
    }

    #[test]
    fn retries_with_backoff_until_linked_and_reports_each_step() {
        let answers = RefCell::new(vec![Outcome::Retry("down".into()), Outcome::Retry("down".into()), Outcome::Linked].into_iter());
        let waits = RefCell::new(Vec::new());
        let states = RefCell::new(Vec::new());
        let outcome = register_until_done(
            || answers.borrow_mut().next().unwrap(),
            |d| waits.borrow_mut().push(d.as_secs()),
            || true,
            |s| states.borrow_mut().push(s),
        );
        assert_eq!(outcome, Outcome::Linked);
        assert_eq!(*waits.borrow(), [2, 4]);
        assert_eq!(states.borrow().last(), Some(&LinkState::Linked));
        assert!(states.borrow().contains(&LinkState::Failed("down".into())));
    }

    #[test]
    fn a_wrong_secret_stops_at_once_and_says_so() {
        let tries = Cell::new(0);
        let last = RefCell::new(LinkState::Waiting);
        let outcome = register_until_done(
            || {
                tries.set(tries.get() + 1);
                interpret_register(Some(403), None)
            },
            |_| panic!("must not wait after a final answer"),
            || true,
            |s| *last.borrow_mut() = s,
        );
        assert_eq!(outcome, Outcome::SecretMismatch);
        assert_eq!(tries.get(), 1);
        let final_state = last.borrow().clone();
        match final_state {
            LinkState::Failed(why) => assert!(why.contains("secret does not match"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn it_stops_when_a_newer_tunnel_took_over() {
        let calls = Cell::new(0);
        let alive = Cell::new(true);
        let outcome = register_until_done(
            || {
                calls.set(calls.get() + 1);
                Outcome::Retry("down".into())
            },
            |_| alive.set(false),
            || alive.get(),
            |_| {},
        );
        assert!(matches!(outcome, Outcome::Retry(_)));
        assert_eq!(calls.get(), 1, "no call after it was replaced");
    }

    #[test]
    fn register_once_talks_to_a_fake_worker_over_http_with_the_secret_in_the_bearer_only() {
        let (url, seen, server) = fake_worker(vec![(503, "{}"), (200, r#"{"ok":true}"#)]);
        let first = register_once(&url, "the-shared-secret-0123456789", "https://abc-def.trycloudflare.com");
        assert!(matches!(first, Outcome::Retry(ref why) if why.contains("503")), "{first:?}");
        let second = register_once(&url, "the-shared-secret-0123456789", "https://abc-def.trycloudflare.com");
        assert_eq!(second, Outcome::Linked);
        server.join().unwrap();
        let requests = seen.lock().unwrap();
        let request = &requests[1];
        assert!(request.starts_with("POST /_pm/link/register HTTP/1.1"), "{request}");
        assert!(request.contains("Bearer the-shared-secret-0123456789"));
        assert!(request.to_ascii_lowercase().contains("accept-encoding: identity"), "{request}");
        assert!(request.contains(r#"{"origin":"https://abc-def.trycloudflare.com"}"#), "{request}");
        assert!(!first_error_text(&first).contains("the-shared-secret"), "an error must not carry the secret");
    }

    fn first_error_text(outcome: &Outcome) -> String {
        outcome.problem().unwrap_or_default()
    }

    #[test]
    fn a_403_from_a_fake_worker_is_shown_as_the_secret_not_matching() {
        let (url, _seen, server) = fake_worker(vec![(403, r#"{"error":"secret_mismatch"}"#)]);
        let states = RefCell::new(Vec::new());
        let outcome = register_until_done(
            || register_once(&url, "wrong-secret-0123456789", "https://a.trycloudflare.com"),
            |_| panic!("final"),
            || true,
            |s| states.borrow_mut().push(s),
        );
        server.join().unwrap();
        assert_eq!(outcome, Outcome::SecretMismatch);
        assert!(matches!(states.borrow().last(), Some(LinkState::Failed(why)) if why.contains("secret does not match")));
    }

    #[test]
    fn the_real_loop_retries_over_http_until_the_worker_is_back() {
        let (url, seen, server) = fake_worker(vec![(500, "{}"), (503, "{}"), (200, "{}")]);
        let waited = Cell::new(0u32);
        let outcome = register_until_done(
            || register_once(&url, "secret-secret-secret-1", "https://a.trycloudflare.com"),
            |_| waited.set(waited.get() + 1),
            || true,
            |_| {},
        );
        server.join().unwrap();
        assert_eq!(outcome, Outcome::Linked);
        assert_eq!(waited.get(), 2);
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[test]
    fn worker_health_is_read_into_plain_words() {
        assert!(interpret_worker_health(Some(200), r#"{"linked":true,"updated_at":5}"#, None).is_ok());
        assert!(interpret_worker_health(Some(200), r#"{"linked":false,"updated_at":null}"#, None).unwrap_err().contains("not linked"));
        assert!(interpret_worker_health(Some(200), "<html>hi</html>", None).unwrap_err().contains("not a stable-link Worker"));
        assert!(interpret_worker_health(Some(404), "", None).unwrap_err().contains("404"));
        assert!(interpret_worker_health(None, "", Some("dns error")).unwrap_err().contains("Could not reach"));
    }

    #[test]
    fn check_worker_and_reset_work_against_a_fake_worker() {
        let (url, seen, server) = fake_worker(vec![(200, r#"{"linked":true,"updated_at":1}"#), (200, r#"{"ok":true}"#)]);
        assert!(check_worker(&url).is_ok());
        assert!(reset_once(&url, "old-secret-0123456789"));
        server.join().unwrap();
        let requests = seen.lock().unwrap();
        assert!(requests[0].starts_with("GET /_pm/link/health "));
        assert!(requests[1].starts_with("POST /_pm/link/reset "));
        assert!(requests[1].contains("Bearer old-secret-0123456789"));
    }

    #[test]
    fn urls_ignore_a_trailing_slash() {
        assert_eq!(register_url("https://w.dev/"), "https://w.dev/_pm/link/register");
        assert_eq!(health_url("https://w.dev"), "https://w.dev/_pm/link/health");
        assert_eq!(reset_url("https://w.dev"), "https://w.dev/_pm/link/reset");
    }
}
