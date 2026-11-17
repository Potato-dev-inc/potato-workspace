//! Catalog entry: `message_parent`, a spin-off's one way to write to the agent that spun it off. The route is
//! `POST /agents/message-parent` (`acp/chat/spin_off.rs`: the limits, the delivery and who may call it).
//!
//! It is callable by name in every mode that has the agent tools, and listed (like `companion_recall`) only for an agent that
//! runs in a spin-off (`mcp_shim/stdio.rs` asks the app). Anyone else gets `NOT_A_SPIN_OFF`.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub const MESSAGE_PARENT: &str = "message_parent";

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: MESSAGE_PARENT,
        description: "Spin-offs only: write to the agent that spun you off (a status, a result, a question for it). It shows there as a note from you; the person is not asked. One message a minute, 20 in all, 4,000 characters each; over a limit you get state deferred. For something only the person can decide, ask them in this chat instead. Returns {state: started_turn|queued|deferred|repeat, delivered}.",
        input_schema: object_schema(
            json!({
                "message": { "type": "string", "minLength": 1, "maxLength": 4000, "description": "What to tell the agent that spun you off." },
                "idempotency_key": { "type": "string", "description": "Send the same key to retry safely: a message with a key already sent is not sent twice." }
            }),
            vec!["message"],
        ),
        output_schema: None,
        safety: ToolSafety::Mutating,
        visibility: visible_everywhere(),
        method: "POST",
        path: "/agents/message-parent",
    }]
}
