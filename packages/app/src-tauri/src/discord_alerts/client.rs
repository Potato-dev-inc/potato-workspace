//! The one request to a webhook: a POST of a small JSON body, with timeouts, no redirects and no retries.
//!
//! Errors are fixed words. The transport error text of the HTTP library names the link, so it is dropped, never
//! formatted into anything.

use super::webhook::Webhook;
use std::fmt;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RETRY_AFTER_S: u64 = 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    /// Discord answered with this status (a removed webhook is 404, a bad code 401).
    Rejected(u16),
    /// Discord asked to slow down.
    RateLimited { retry_after_s: u64 },
    /// The request did not get through (offline, blocked, too slow).
    Network,
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(401 | 403 | 404) => f.write_str("Discord does not accept that webhook any more. Make a new one."),
            Self::Rejected(code) => write!(f, "Discord refused the message (error {code})."),
            Self::RateLimited { .. } => f.write_str("Discord says to slow down. Try again in a moment."),
            Self::Network => f.write_str("Could not reach Discord. Check your connection."),
        }
    }
}

/// Posts a JSON body to a webhook. A trait so the tests can watch what leaves.
pub trait Post: Send + Sync {
    fn post(&self, hook: &Webhook, json_body: &str) -> Result<(), SendError>;
}

pub struct UreqPost {
    agent: ureq::Agent,
}

impl UreqPost {
    pub fn new() -> Self {
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .user_agent("potato-workspace")
            .build();
        Self { agent }
    }
}

impl Post for UreqPost {
    fn post(&self, hook: &Webhook, json_body: &str) -> Result<(), SendError> {
        match self.agent.post(hook.as_str()).set("Content-Type", "application/json").send_string(json_body) {
            Ok(resp) if (200..300).contains(&resp.status()) => Ok(()),
            Ok(resp) => Err(SendError::Rejected(resp.status())),
            Err(ureq::Error::Status(429, resp)) => {
                let retry_after_s = resp.header("retry-after").and_then(|v| v.trim().parse::<f64>().ok()).map_or(5, |s| (s.ceil() as u64).clamp(1, MAX_RETRY_AFTER_S));
                Err(SendError::RateLimited { retry_after_s })
            }
            Err(ureq::Error::Status(code, _)) => Err(SendError::Rejected(code)),
            // Dropped on purpose: its text names the link.
            Err(ureq::Error::Transport(_)) => Err(SendError::Network),
        }
    }
}
