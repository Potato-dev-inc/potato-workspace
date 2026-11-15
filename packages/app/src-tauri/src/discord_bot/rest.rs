//! The one REST call the bot makes: post a message to a channel.
//!
//! - Every message carries `allowed_mentions: { "parse": [] }`, so it can never ping `@everyone`, `@here` or a
//!   role, whatever the text says.
//! - The channel id must be digits only before it goes into a path.
//! - A `429` gives `RateLimited` with the wait Discord asked for; the caller waits and tries again.
//! - Errors are fixed words. A ureq error names the address, so ureq errors are never formatted.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::config::valid_snowflake;
use super::token::Token;
use super::Transport;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestError {
    /// Wait this long, then try once more.
    RateLimited { retry_after_ms: u64 },
    /// The token was refused (401): the bot must stop.
    Unauthorized,
    /// The bot may not post here (403, a missing permission).
    Forbidden,
    Other(u16),
    Network,
}

pub trait Rest: Send + Sync {
    fn post(&self, channel_id: &str, content: &str, reply_to: Option<&str>) -> Result<(), RestError>;
}

/// The longest wait we accept from a `429`.
pub const MAX_WAIT_MS: u64 = 60_000;

/// The body of a post: text, no mentions of anybody, and a reply link when there is one.
pub fn build_body(content: &str, reply_to: Option<&str>) -> Value {
    let mut body = json!({ "content": content, "allowed_mentions": { "parse": [] } });
    if let Some(id) = reply_to.filter(|id| valid_snowflake(id)) {
        body["message_reference"] = json!({ "message_id": id, "fail_if_not_exists": false });
    }
    body
}

/// Reads the wait of a `429` from its body (seconds, maybe a fraction) or its header.
pub fn retry_after_ms(body: Option<&Value>, header: Option<&str>) -> u64 {
    let seconds = body.and_then(|b| b.get("retry_after")).and_then(Value::as_f64).or_else(|| header.and_then(|h| h.trim().parse::<f64>().ok())).unwrap_or(1.0);
    ((seconds.max(0.0) * 1000.0).ceil() as u64).min(MAX_WAIT_MS)
}

pub struct UreqRest {
    token: Token,
    transport: Arc<dyn Transport>,
}

impl UreqRest {
    pub fn new(token: Token, transport: Arc<dyn Transport>) -> Self {
        Self { token, transport }
    }
}

impl Rest for UreqRest {
    fn post(&self, channel_id: &str, content: &str, reply_to: Option<&str>) -> Result<(), RestError> {
        if !valid_snowflake(channel_id) {
            return Err(RestError::Other(0));
        }
        let url = format!("{}/channels/{channel_id}/messages", self.transport.rest_base());
        super::net_guard(&url);
        let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(15)).build();
        let sent = agent
            .post(&url)
            .set("Authorization", &format!("Bot {}", self.token.expose()))
            .set("User-Agent", "DiscordBot (https://github.com/Potato-dev-inc/potato-workspace, 1)")
            .send_json(build_body(content, reply_to));
        match sent {
            Ok(r) if (300..400).contains(&r.status()) => Err(RestError::Other(r.status())),
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(429, resp)) => {
                let header = resp.header("Retry-After").map(str::to_string);
                let body = resp.into_json::<Value>().ok();
                Err(RestError::RateLimited { retry_after_ms: retry_after_ms(body.as_ref(), header.as_deref()) })
            }
            Err(ureq::Error::Status(401, _)) => Err(RestError::Unauthorized),
            Err(ureq::Error::Status(403, _)) => Err(RestError::Forbidden),
            Err(ureq::Error::Status(code, _)) => Err(RestError::Other(code)),
            Err(ureq::Error::Transport(_)) => Err(RestError::Network),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_post_never_pings_anybody() {
        let body = build_body("hello @everyone <@&123456789012345678>", None);
        assert_eq!(body["allowed_mentions"], json!({ "parse": [] }));
        assert_eq!(body["content"], "hello @everyone <@&123456789012345678>");
        assert!(body.get("message_reference").is_none());
    }

    #[test]
    fn a_reply_links_to_the_message_and_does_not_fail_when_it_is_gone() {
        let body = build_body("hi", Some("123456789012345678"));
        assert_eq!(body["message_reference"], json!({ "message_id": "123456789012345678", "fail_if_not_exists": false }));
        assert!(build_body("hi", Some("../x")).get("message_reference").is_none());
    }

    #[test]
    fn the_wait_of_a_429_comes_from_the_body_then_the_header_and_is_capped() {
        assert_eq!(retry_after_ms(Some(&json!({ "retry_after": 1.5 })), None), 1500);
        assert_eq!(retry_after_ms(Some(&json!({ "retry_after": 0.05 })), Some("9")), 50);
        assert_eq!(retry_after_ms(None, Some("3")), 3000);
        assert_eq!(retry_after_ms(None, None), 1000);
        assert_eq!(retry_after_ms(Some(&json!({ "retry_after": 100000.0 })), None), MAX_WAIT_MS);
        assert_eq!(retry_after_ms(Some(&json!({ "retry_after": -4.0 })), None), 0);
    }
}
