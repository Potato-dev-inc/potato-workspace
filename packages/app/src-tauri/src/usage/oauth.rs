//! The `oauth_usage` reader: ask the agent's own usage address with the sign-in's access token.
//!
//! Rules (founder decision 2026-11-11, `docs/plans/usage-bar.md`):
//! - The token is read from the sign-in's own credential file for one request, kept in a `Secret` (its
//!   Debug prints `***`), never stored, logged, shown or sent anywhere but the table's fixed HTTPS URL.
//! - No redirects are followed (a redirect could carry the header elsewhere).
//! - An expired token is never sent and never refreshed: the agent refreshes its own login.
//! - 429 and errors back off (Retry-After when given); the last numbers are kept with their age.

use super::readers::{window_name, Reading, Window};
use super::source::OauthWindow;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// A token, only for the one request. Never printed.
pub struct Secret(String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

impl Secret {
    fn expose(&self) -> &str {
        &self.0
    }
}

/// What the credential file says.
#[derive(Debug)]
pub enum Token {
    /// No file, or no token in it.
    Missing,
    /// The token has expired; it is not sent.
    Expired,
    Valid(Secret),
}

/// Read only the token and its expiry from the sign-in's credential file.
pub fn read_token(home: &Path, file: &str, token: &str, expires_at: Option<&str>, now_ms: u64) -> Token {
    let Ok(text) = std::fs::read_to_string(home.join(file)) else { return Token::Missing };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return Token::Missing };
    let Some(secret) = value.pointer(token).and_then(Value::as_str).filter(|t| !t.trim().is_empty()) else {
        return Token::Missing;
    };
    if let Some(expiry) = expires_at.and_then(|p| value.pointer(p)).and_then(Value::as_u64) {
        if expiry <= now_ms {
            return Token::Expired;
        }
    }
    Token::Valid(Secret(secret.to_string()))
}

/// How one request ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Fetch {
    Ok(Value),
    /// 401 / 403: the login no longer works.
    Unauthorized,
    /// 429, with the wait the server asked for.
    RateLimited { retry_after_ms: Option<u64> },
    Failed(Failure),
}

/// Why a request failed, for the row's reason. No body text is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Another HTTP status (a redirect included: it is not followed).
    Status(u16),
    /// No answer: offline, DNS, TLS, timeout.
    Network,
    /// The answer was not JSON.
    BadAnswer,
    /// The URL is not allowed (not HTTPS).
    Refused,
}

/// The HTTP call; tests use a local server through `LiveHttp::with_url`.
pub trait UsageHttp: Sync {
    fn get(&self, url: &str, token: &Secret, headers: &[(String, String)]) -> Fetch;
}

const TIMEOUT: Duration = Duration::from_secs(10);

/// The live client: HTTPS only (tests may use a loopback http URL), no redirects, 10 s timeout.
pub struct LiveHttp;

fn allowed(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    cfg!(test) && url.starts_with("http://127.0.0.1:")
}

impl UsageHttp for LiveHttp {
    fn get(&self, url: &str, token: &Secret, headers: &[(String, String)]) -> Fetch {
        if !allowed(url) {
            return Fetch::Failed(Failure::Refused);
        }
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(TIMEOUT).build();
        let mut request = agent.get(url).set("Authorization", &format!("Bearer {}", token.expose()));
        for (name, value) in headers {
            request = request.set(name, value);
        }
        match request.call() {
            Ok(response) if response.status() == 200 => response.into_json::<Value>().map(Fetch::Ok).unwrap_or(Fetch::Failed(Failure::BadAnswer)),
            Ok(response) => Fetch::Failed(Failure::Status(response.status())), // a redirect (3xx) is not followed
            Err(ureq::Error::Status(401 | 403, _)) => Fetch::Unauthorized,
            Err(ureq::Error::Status(429, response)) => Fetch::RateLimited { retry_after_ms: retry_after_ms(response.header("Retry-After")) },
            Err(ureq::Error::Status(code, _)) => Fetch::Failed(Failure::Status(code)),
            Err(ureq::Error::Transport(_)) => Fetch::Failed(Failure::Network),
        }
    }
}

/// `Retry-After` in seconds (an HTTP date is ignored: the default backoff applies).
pub fn retry_after_ms(header: Option<&str>) -> Option<u64> {
    header?.trim().parse::<u64>().ok().map(|secs| secs.min(24 * 3600) * 1000)
}

/// A reset time as RFC 3339, or Unix seconds / milliseconds.
fn reset_ms(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(n) => n.as_f64().map(|v| if v > 1e10 { v as u64 } else { (v * 1000.0) as u64 }),
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s.trim())
            .ok()
            .and_then(|t| u64::try_from(t.timestamp_millis()).ok())
            .or_else(|| s.trim().parse::<f64>().ok().map(|v| if v > 1e10 { v as u64 } else { (v * 1000.0) as u64 })),
        _ => None,
    }
}

/// The windows of one answer.
pub fn parse(answer: &Value, windows: &[OauthWindow], used: &str, resets_at: &str, now_ms: u64) -> Reading {
    let mut out = Reading::default();
    for spec in windows {
        let Some(window) = answer.get(&spec.key).and_then(Value::as_object) else { continue };
        let Some(pct) = window.get(used).and_then(Value::as_f64).filter(|v| v.is_finite()) else { continue };
        let reset = reset_ms(window.get(resets_at));
        let reset_since = reset.is_some_and(|at| at <= now_ms);
        out.windows.push(Window {
            name: spec.name.clone().unwrap_or_else(|| window_name(Some(spec.minutes), &spec.key)),
            used_percent: if reset_since { 0.0 } else { pct.clamp(0.0, 100.0) },
            minutes: Some(spec.minutes),
            resets_at_ms: if reset_since { None } else { reset },
            reset_since,
        });
    }
    out
}

/// How long to wait after the `fails`-th failure in a row: 15 min doubling, at most 2 h, or the server's wait.
pub fn backoff_ms(fails: u32, retry_after_ms: Option<u64>) -> u64 {
    let base = 15 * 60 * 1000u64;
    let doubled = base.saturating_mul(1u64 << fails.saturating_sub(1).min(3)).min(2 * 3600 * 1000);
    retry_after_ms.map(|r| r.max(60_000)).unwrap_or(doubled)
}
