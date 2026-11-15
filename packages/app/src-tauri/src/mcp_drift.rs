//! "Tools are out of date": agents whose MCP connection was started with another tool list than this app's.
//!
//! The MCP program tells the bridge its catalog hash on every request (`mcp_sessions::catalog_seen`). This module
//! compares it with the app's own and, for a chat, can reconnect (restart the agent so it starts the bundled
//! program of THIS app). The chat banner and Settings > Connectors read `report`.

use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolsDrift {
    /// The chat or pane the connection says it runs in; `None` for a host the app cannot place (say, a desktop app).
    pub pane_id: Option<String>,
    /// The tool list the agent has, and the app's.
    pub agent_catalog: String,
    pub app_catalog: String,
    /// The app can restart this one itself (a chat session).
    pub can_reconnect: bool,
}

/// This app's catalog, worked out once.
pub fn app_catalog() -> &'static str {
    static HASH: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(crate::tool_registry::catalog_hash);
    HASH.as_str()
}

/// Every live connection with an out-of-date tool list; one row per pane (the first connection wins), and one row
/// for the ones that name no pane.
pub fn report() -> Vec<ToolsDrift> {
    rows_from(crate::mcp_sessions::stale_connections(app_catalog()), app_catalog(), |pane| crate::acp::chat::get(pane).is_some())
}

pub(crate) fn rows_from(
    stale: Vec<crate::mcp_sessions::StaleConnection>,
    app: &str,
    is_chat: impl Fn(&str) -> bool,
) -> Vec<ToolsDrift> {
    let mut rows: Vec<ToolsDrift> = Vec::new();
    for item in stale {
        if rows.iter().any(|row| row.pane_id == item.pane_id) {
            continue;
        }
        let can_reconnect = item.pane_id.as_deref().is_some_and(&is_chat);
        rows.push(ToolsDrift { pane_id: item.pane_id, agent_catalog: item.catalog, app_catalog: app.to_string(), can_reconnect });
    }
    rows
}

/// Restarts the chat's agent so it starts this app's bundled MCP program. The conversation resumes in the same chat.
/// Refuses while the agent is working, so no answer is cut off.
pub fn reconnect(pane_id: &str) -> Result<(), String> {
    let chat = crate::acp::chat::get(pane_id)
        .ok_or_else(|| "NOT_A_CHAT: Close this agent and open it again to refresh its tools.".to_string())?;
    let session = chat.session().clone();
    if session.snapshot().turn_in_flight() {
        return Err("BUSY: The agent is working. Wait for it to finish, then reconnect.".into());
    }
    if let Some(conn) = session.connection() {
        conn.kill();
        let until = Instant::now() + Duration::from_secs(8);
        while session.is_live() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    chat.restart().map_err(|e| format!("ACP_START_FAILED: The agent could not reconnect: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_sessions::StaleConnection;

    fn conn(session: &str, pane: Option<&str>) -> StaleConnection {
        StaleConnection { session_id: session.into(), pane_id: pane.map(str::to_string), catalog: "old".into() }
    }

    #[test]
    fn one_row_per_pane_and_chats_can_reconnect() {
        let rows = rows_from(vec![conn("a", Some("chat-1")), conn("b", Some("chat-1")), conn("c", Some("term-1")), conn("d", None)], "new", |p| p == "chat-1");
        assert_eq!(rows.len(), 3);
        assert!(rows[0].can_reconnect && rows[0].pane_id.as_deref() == Some("chat-1"));
        assert!(!rows[1].can_reconnect);
        assert_eq!(rows[2].pane_id, None);
        assert!(rows.iter().all(|r| r.agent_catalog == "old" && r.app_catalog == "new"));
    }

    #[test]
    fn reconnect_of_a_pane_that_is_not_a_chat_says_what_to_do() {
        let err = reconnect("no-such-chat").unwrap_err();
        assert!(err.starts_with("NOT_A_CHAT:"), "{err}");
    }
}
