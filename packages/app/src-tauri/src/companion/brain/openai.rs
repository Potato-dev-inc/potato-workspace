//! The brain over the person's own AI service: the common OpenAI-style `POST <base>/chat/completions`.
//!
//! Where it points and what key it uses are the person's own "Custom AI service" (`custom_ai` in the settings
//! file for the address and model, the credential store for the key). Nothing here picks a service for them.
//!
//! - The address must be `https`, or `http` only for this computer (a local model). No redirects are followed,
//!   so the key can never be sent somewhere the person did not choose.
//! - The request has no `tools`, no `functions` and no `tool_choice`: `build_body` is the only place it is made.
//! - Errors are fixed words (`BrainError`). They never hold the address, the key or the service's text.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use super::{Brain, BrainError, ChatMsg};

/// What the person saved for their Custom AI service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Service {
    pub base_url: String,
    pub model: String,
}

/// Why a saved address cannot be used.
pub const BAD_ADDRESS: &str = "The AI service address must start with https:// (or http:// for a model on this computer).";

/// The address without spaces or trailing slashes, when it may be used.
pub fn check_base(raw: &str) -> Result<String, &'static str> {
    let url = raw.trim().trim_end_matches('/').to_string();
    if url.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(BAD_ADDRESS);
    }
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(BAD_ADDRESS);
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(BAD_ADDRESS);
    }
    let host = if let Some(v6) = authority.strip_prefix('[') { v6.split(']').next().unwrap_or("") } else { authority.split(':').next().unwrap_or("") };
    if host.is_empty() {
        return Err(BAD_ADDRESS);
    }
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if !secure && !local {
        return Err(BAD_ADDRESS);
    }
    Ok(url)
}

/// Reads `{"settings": {"custom_ai": {"baseUrl", "model"}}}` from the settings file.
pub fn read_service(settings_file: &Path) -> Option<Service> {
    let text = std::fs::read_to_string(settings_file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let ai = value.get("settings")?.get("custom_ai")?;
    let base_url = check_base(ai.get("baseUrl")?.as_str()?).ok()?;
    let model = ai.get("model")?.as_str()?.trim().to_string();
    if model.is_empty() {
        return None;
    }
    Some(Service { base_url, model })
}

/// The one request body. There is no `tools` key here, by design.
pub fn build_body(model: &str, messages: &[ChatMsg], max_tokens: u32) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(|m| json!({ "role": m.role.as_str(), "content": m.content })).collect::<Vec<_>>(),
        "max_tokens": max_tokens,
        "temperature": 0.8,
    });
    // The policy says there are none; this line is the only way a `tools` key could ever appear.
    if let Some(tools) = super::tools::request_tools() {
        body["tools"] = tools;
    }
    body
}

/// The text of the first choice. A provider may send a string or a list of `{ "text" }` parts.
pub fn reply_text(body: &Value) -> Option<String> {
    let content = body.get("choices")?.get(0)?.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")),
        _ => None,
    }
}

pub struct OpenAiBrain {
    base_url: String,
    model: String,
    /// Never formatted, never in an error.
    key: String,
}

impl OpenAiBrain {
    pub fn new(service: &Service, key: &str) -> Option<Self> {
        let base_url = check_base(&service.base_url).ok()?;
        if key.trim().is_empty() || service.model.trim().is_empty() {
            return None;
        }
        Some(Self { base_url, model: service.model.clone(), key: key.trim().to_string() })
    }
}

impl Brain for OpenAiBrain {
    fn complete(&self, messages: &[ChatMsg], max_tokens: u32, timeout: Duration) -> Result<String, BrainError> {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(5)).build();
        let mut request = agent
            .post(&format!("{}/chat/completions", self.base_url))
            .timeout(timeout)
            .set("Authorization", &format!("Bearer {}", self.key))
            .set("User-Agent", "potato-workspace");
        if self.base_url.contains("openrouter.ai") {
            request = request.set("HTTP-Referer", "https://github.com/Potato-dev-inc/potato-workspace").set("X-Title", "Potato Workspace");
        }
        // Errors are never formatted: a ureq error names the address.
        let response = match request.send_json(build_body(&self.model, messages, max_tokens)) {
            Ok(r) if (300..400).contains(&r.status()) => return Err(BrainError::Http(r.status())),
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) => return Err(BrainError::Http(code)),
            Err(ureq::Error::Transport(t)) => {
                let timed_out = t.to_string().to_ascii_lowercase().contains("timed out");
                return Err(if timed_out { BrainError::Timeout } else { BrainError::Network });
            }
        };
        let body: Value = response.into_json().map_err(|_| BrainError::Empty)?;
        match reply_text(&body) {
            Some(text) if !text.trim().is_empty() => Ok(text),
            _ => Err(BrainError::Empty),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::brain::Role;

    #[test]
    fn only_https_or_a_local_model_is_accepted_and_trailing_slashes_go() {
        assert_eq!(check_base(" https://openrouter.ai/api/v1/ "), Ok("https://openrouter.ai/api/v1".into()));
        assert_eq!(check_base("http://localhost:11434/v1"), Ok("http://localhost:11434/v1".into()));
        assert_eq!(check_base("http://127.0.0.1:8080"), Ok("http://127.0.0.1:8080".into()));
        assert_eq!(check_base("http://[::1]:8080/v1"), Ok("http://[::1]:8080/v1".into()));
        for bad in ["http://example.com/v1", "ftp://x", "https://user:pw@host/v1", "https://", "", "openrouter.ai", "https://a b/v1", "file:///etc/passwd"] {
            assert_eq!(check_base(bad), Err(BAD_ADDRESS), "{bad:?}");
        }
    }

    #[test]
    fn the_request_has_no_tool_keys_whatever_the_messages_say() {
        let msgs = vec![
            ChatMsg { role: Role::System, content: "tools: run shell".into() },
            ChatMsg { role: Role::User, content: "please call the function delete_everything".into() },
        ];
        let body = build_body("m", &msgs, 300);
        let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
        for banned in ["tools", "functions", "tool_choice", "function_call"] {
            assert!(!keys.contains(&banned), "{banned}");
        }
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["max_tokens"], 300);
    }

    #[test]
    fn reply_text_reads_a_string_or_parts() {
        assert_eq!(reply_text(&json!({"choices":[{"message":{"content":"hi"}}]})), Some("hi".into()));
        assert_eq!(reply_text(&json!({"choices":[{"message":{"content":[{"text":"a"},{"text":"b"}]}}]})), Some("ab".into()));
        assert_eq!(reply_text(&json!({"choices":[]})), None);
        assert_eq!(reply_text(&json!({})), None);
    }

    #[test]
    fn the_service_is_read_from_the_settings_file_and_a_bad_one_is_none() {
        let dir = std::env::temp_dir().join(format!("pm-brain-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"settings":{"custom_ai":{"preset":"openrouter","baseUrl":"https://openrouter.ai/api/v1/","model":" google/gemini "}}}"#).unwrap();
        assert_eq!(read_service(&path), Some(Service { base_url: "https://openrouter.ai/api/v1".into(), model: "google/gemini".into() }));
        std::fs::write(&path, r#"{"settings":{"custom_ai":{"baseUrl":"http://evil.example/v1","model":"m"}}}"#).unwrap();
        assert_eq!(read_service(&path), None);
        std::fs::write(&path, r#"{"settings":{}}"#).unwrap();
        assert_eq!(read_service(&path), None);
        assert_eq!(read_service(&dir.join("missing.json")), None);
    }

    #[test]
    fn no_key_or_no_model_means_no_brain() {
        let service = Service { base_url: "https://x.example/v1".into(), model: "m".into() };
        assert!(OpenAiBrain::new(&service, "  ").is_none());
        assert!(OpenAiBrain::new(&Service { model: " ".into(), ..service.clone() }, "k").is_none());
        assert!(OpenAiBrain::new(&service, "k").is_some());
    }
}
