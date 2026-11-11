//! `initialize`: what we offer and what the agent says it can do.
//!
//! We speak ACP v1 only (v2 is a draft). We offer no client features: no file access (`fs`), no terminal.
//! The agent reads and writes the project's files itself and reports shell output inside its tool
//! updates. Turning either on later is one field here and a handler in the session.

use serde::Serialize;
use serde_json::{json, Value};

use super::error::AcpError;

pub const PROTOCOL_VERSION: u64 = 1;

pub fn initialize_params(client_name: &str, client_version: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
            // The Claude adapter reports background (async) tasks only to a client that advertises
            // the Air extension. Codex ignores this. Nothing else changes for agents that do.
            "_meta": {
                "jetbrains": {
                    "air": { "version": 1, "capabilities": ["asyncTasks"] }
                }
            }
        },
        "clientInfo": { "name": client_name, "version": client_version }
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `agent` (the adapter signs in itself) or `terminal` (a command run in a terminal).
    pub kind: String,
}

/// What the agent said in its `initialize` answer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct AgentCaps {
    pub agent_name: Option<String>,
    pub agent_title: Option<String>,
    pub agent_version: Option<String>,
    pub protocol_version: u64,
    /// `session/load` (replays the history as updates).
    pub load_session: bool,
    /// `session/resume` (continues without replaying).
    pub resume: bool,
    pub list: bool,
    pub close: bool,
    pub image_prompts: bool,
    pub embedded_context: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub auth_methods: Vec<AuthMethodInfo>,
    /// The agent says it accepts text sent into a running turn (`_meta.steering.supported`, used by A2+).
    pub steering: bool,
    /// The agent reports background work that outlives a turn (`_meta.jetbrains.air.capabilities`
    /// includes `asyncTasks`). False: the app must not guess about background work.
    pub background_tasks: bool,
}

pub fn parse_initialize(result: &Value) -> Result<AgentCaps, AcpError> {
    let object = result.as_object().ok_or_else(|| AcpError::Protocol("initialize answer is not an object".into()))?;
    let version = object
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| AcpError::Protocol("initialize answer has no protocolVersion".into()))?;
    if version != PROTOCOL_VERSION {
        return Err(AcpError::Unsupported(format!("the agent speaks protocol version {version}; this app speaks {PROTOCOL_VERSION}")));
    }
    let caps = object.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    let flag = |pointer: &str| caps.pointer(pointer).and_then(Value::as_bool).unwrap_or(false);
    // A capability that is an (even empty) object counts as present: `"resume": {}`.
    let present = |pointer: &str| caps.pointer(pointer).is_some_and(|v| !v.is_null());
    let text = |pointer: &str| result.pointer(pointer).and_then(Value::as_str).map(str::to_string);
    let auth_methods = object
        .get("authMethods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| {
                    let id = method.get("id")?.as_str()?.to_string();
                    // The `terminal` method type carries a command; everything else the adapter handles itself.
                    let kind = if method.get("type").and_then(Value::as_str) == Some("terminal") { "terminal" } else { "agent" };
                    Some(AuthMethodInfo {
                        id,
                        name: method.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                        description: method.get("description").and_then(Value::as_str).map(str::to_string),
                        kind: kind.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(AgentCaps {
        agent_name: text("/agentInfo/name"),
        agent_title: text("/agentInfo/title"),
        agent_version: text("/agentInfo/version"),
        protocol_version: version,
        load_session: flag("/loadSession"),
        resume: present("/sessionCapabilities/resume"),
        list: present("/sessionCapabilities/list"),
        close: present("/sessionCapabilities/close"),
        image_prompts: flag("/promptCapabilities/image"),
        embedded_context: flag("/promptCapabilities/embeddedContext"),
        mcp_http: flag("/mcpCapabilities/http"),
        mcp_sse: flag("/mcpCapabilities/sse"),
        auth_methods,
        steering: result.pointer("/_meta/steering/supported").and_then(Value::as_bool).unwrap_or(false),
        background_tasks: result
            .pointer("/_meta/jetbrains/air/capabilities")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|v| v.as_str() == Some("asyncTasks"))),
    })
}

/// What `session/new` / `session/load` / `session/resume` return that the app keeps.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionInfo {
    /// Only `session/new` returns one; load and resume keep the id we sent.
    pub session_id: Option<String>,
    pub config_options: Vec<Value>,
    pub modes: Option<Value>,
}

pub fn parse_session_info(result: &Value) -> SessionInfo {
    SessionInfo {
        session_id: result.get("sessionId").and_then(Value::as_str).map(str::to_string),
        config_options: result.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default(),
        modes: result.get("modes").cloned().filter(|v| v.is_object()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "codex" => include_str!("fixtures/initialize_codex_1_1_4.json"),
            "claude" => include_str!("fixtures/initialize_claude_0_74_0.json"),
            "opencode2" => include_str!("fixtures/initialize_opencode_2_2_7.json"),
            other => panic!("no fixture {other}"),
        };
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn we_offer_no_file_or_terminal_access_and_speak_v1() {
        let params = initialize_params("potato-workspace", "0.2.1");
        assert_eq!(params["protocolVersion"], json!(1));
        assert_eq!(params["clientCapabilities"]["fs"]["readTextFile"], json!(false));
        assert_eq!(params["clientCapabilities"]["fs"]["writeTextFile"], json!(false));
        assert_eq!(params["clientCapabilities"]["terminal"], json!(false));
        assert_eq!(params["clientCapabilities"]["_meta"]["jetbrains"]["air"]["capabilities"], json!(["asyncTasks"]));
    }

    #[test]
    fn a_real_opencode_2_2_7_answer_is_read_into_capabilities() {
        // Recorded from `opencode acp` 2.2.7 (the same handshake our chat lane sends).
        let caps = parse_initialize(&fixture("opencode2")).unwrap();
        assert_eq!(caps.agent_name.as_deref(), Some("OpenCode"));
        assert_eq!(caps.agent_version.as_deref(), Some("2.2.7"));
        assert!(caps.load_session && caps.resume && caps.list && caps.close);
        assert!(caps.image_prompts && caps.embedded_context && caps.mcp_http && !caps.mcp_sse);
        assert!(caps.steering);
        assert_eq!(caps.auth_methods.len(), 1);
        assert_eq!(caps.auth_methods[0].id, "opencode-login");
        assert_eq!(caps.auth_methods[0].kind, "agent");
    }

    #[test]
    fn a_real_codex_answer_is_read_into_capabilities() {
        let caps = parse_initialize(&fixture("codex")).unwrap();
        assert_eq!(caps.agent_version.as_deref(), Some("1.1.4"));
        assert_eq!(caps.agent_title.as_deref(), Some("Codex"));
        assert!(caps.load_session && caps.resume && caps.list && caps.close);
        assert!(caps.image_prompts && caps.embedded_context);
        assert!(caps.mcp_http && !caps.mcp_sse);
        assert!(!caps.steering);
        assert!(!caps.background_tasks, "Codex does not report background work");
        let ids: Vec<&str> = caps.auth_methods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["api-key", "chat-gpt"]);
        assert_eq!(caps.auth_methods[1].name, "ChatGPT");
        assert_eq!(caps.auth_methods[1].kind, "agent");
    }

    #[test]
    fn a_real_claude_answer_has_steering_and_no_auth_methods() {
        let caps = parse_initialize(&fixture("claude")).unwrap();
        assert_eq!(caps.agent_title.as_deref(), Some("Claude Agent"));
        assert!(caps.load_session && caps.resume);
        assert!(caps.steering);
        assert!(caps.background_tasks, "Claude's Air extension reports async tasks");
        assert!(caps.auth_methods.is_empty());
        assert!(caps.mcp_sse);
    }

    #[test]
    fn another_protocol_version_is_refused() {
        let mut answer = fixture("codex");
        answer["protocolVersion"] = json!(2);
        assert!(matches!(parse_initialize(&answer), Err(AcpError::Unsupported(_))));
        assert!(matches!(parse_initialize(&json!({"nonsense": true})), Err(AcpError::Protocol(_))));
    }

    #[test]
    fn session_answers_give_the_id_options_and_modes() {
        let answer: Value = serde_json::from_str(include_str!("fixtures/session_new_claude_modes_and_options.json")).unwrap();
        let info = parse_session_info(&answer);
        assert_eq!(info.session_id.as_deref(), Some("a2e0fdd9-45c9-4478-84ee-e4eb52d0a405"));
        assert_eq!(info.config_options.len(), 2);
        assert_eq!(info.config_options[1]["id"], json!("model"));
        assert_eq!(info.modes.unwrap()["currentModeId"], json!("default"));
        // load/resume answers may be empty objects
        let bare = parse_session_info(&json!({}));
        assert_eq!(bare, SessionInfo::default());
    }
}
