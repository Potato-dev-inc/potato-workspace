//! The HTTP side: talk to the account server, signing every call after sign-in with the device key.
//! Bodies and tokens are never logged; an error carries the server's short code only.

use super::statement::sign_request;
use super::store::StoredSession;
use crate::keys::crypto::SigningKey;
use serde_json::Value;
use std::time::Duration;

/// The address of the account server. `POTATO_ACCOUNT_URL` overrides it (staging, or a local server on this PC).
/// Empty until the production address exists: the window then says the service is not ready yet.
pub const DEFAULT_ACCOUNT_URL: &str = "https://potato-workspace-auth.up.railway.app";

#[derive(Debug, PartialEq, Eq)]
pub enum ApiError {
    /// The session is gone (signed out elsewhere, expired, or the key does not match).
    Unauthorized,
    /// The server answered with an error code (`invalid_ticket`, `device_revoked`, ...).
    Server(u16, String),
    Network(String),
}

impl ApiError {
    /// A plain sentence for the window.
    pub fn sentence(&self) -> String {
        match self {
            ApiError::Unauthorized => "You were signed out. Sign in again.".into(),
            ApiError::Server(429, _) => "Too many tries. Wait a few minutes and try again.".into(),
            ApiError::Server(403, c) if c == "device_revoked" => "This device was signed out of the account.".into(),
            ApiError::Server(_, c) if c == "invalid_ticket" => "That sign-in did not work. Start again.".into(),
            ApiError::Server(..) => "The account service did not accept that. Try again.".into(),
            ApiError::Network(_) => "Could not reach the account service. Check your connection and try again.".into(),
        }
    }
}

/// `https` anywhere; plain `http` only for this PC (a local server for testing).
pub fn valid_base(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    if url.len() > 200 || url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '?' || c == '#') {
        return None;
    }
    let (scheme, rest) = url.split_once("://")?;
    if rest.is_empty() || rest.contains('/') || rest.contains('@') {
        return None;
    }
    let host = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => rest,
    };
    match scheme {
        "https" if !host.is_empty() => Some(url.to_string()),
        "http" if matches!(host, "127.0.0.1" | "localhost" | "[::1]") => Some(url.to_string()),
        _ => None,
    }
}

pub fn configured_base() -> Option<String> {
    let env = std::env::var("POTATO_ACCOUNT_URL").ok().filter(|v| !v.trim().is_empty());
    valid_base(env.as_deref().unwrap_or(DEFAULT_ACCOUNT_URL))
}

pub struct Client {
    base: String,
    agent: ureq::Agent,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `sign_in`: a 401 is a refused ticket (the server's code says which), not a lost session.
fn read(result: Result<ureq::Response, ureq::Error>, sign_in: bool) -> Result<Value, ApiError> {
    match result {
        Ok(resp) => {
            let text = resp.into_string().unwrap_or_default();
            Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(401, _)) if !sign_in => Err(ApiError::Unauthorized),
        Err(ureq::Error::Status(code, resp)) => {
            let body: Value = serde_json::from_str(&resp.into_string().unwrap_or_default()).unwrap_or(Value::Null);
            let short = body.get("error").and_then(Value::as_str).unwrap_or("error").chars().take(40).collect();
            Err(ApiError::Server(code, short))
        }
        Err(ureq::Error::Transport(t)) => Err(ApiError::Network(t.kind().to_string())),
    }
}

impl Client {
    pub fn new(base: &str) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).user_agent("potato-workspace-account").build();
        Self { base: base.trim_end_matches('/').to_string(), agent }
    }

    /// Trade the ticket (and the verifier only this app knows) for a session.
    pub fn redeem(&self, ticket: &str, verifier: &str, statement: &str, signature: &str) -> Result<Value, ApiError> {
        let body = serde_json::json!({ "ticket": ticket, "verifier": verifier, "statement": statement, "signature": signature });
        let req = self.agent.post(&format!("{}/v1/session", self.base)).set("content-type", "application/json");
        read(req.send_string(&body.to_string()), true)
    }

    /// A signed call: bearer token, device id, time, nonce and a signature by the device key over the exact request.
    pub fn signed(&self, session: &StoredSession, key: &SigningKey, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let text = body.map(|b| b.to_string()).unwrap_or_default();
        let auth = sign_request(key, method, path, now(), text.as_bytes());
        let req = self
            .agent
            .request(method, &format!("{}{path}", self.base))
            .set("authorization", &format!("Bearer {}", session.token))
            .set("x-device-id", &session.device_id)
            .set("x-timestamp", &auth.timestamp)
            .set("x-nonce", &auth.nonce)
            .set("x-signature", &auth.signature);
        let result = if body.is_some() { req.set("content-type", "application/json").send_string(&text) } else { req.call() };
        read(result, false)
    }
}
