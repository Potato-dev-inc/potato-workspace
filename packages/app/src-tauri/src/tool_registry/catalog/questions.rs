//! Catalog entry: `ask_user`, a structured question to the human that blocks until answered.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: "ask_user",
        description: "Ask the HUMAN a question and wait for the answer, for a decision or fact only the person can give. It shows in the Potato Workspace Inbox (and on a paired phone). Blocks until answered, dismissed or timed out (default 600 s, max 3600 s). Up to 6 choices; free text is on when there are none. Returns {answered:true, choice_id?|text?} or {answered:false, reason}. Do not ask what you can find out yourself.",
        input_schema: object_schema(
            json!({
                "question": { "type": "string", "maxLength": 2000, "description": "The question, short and self-contained." },
                "choices": {
                    "type": "array",
                    "maxItems": 6,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "Returned as choice_id when picked." },
                            "label": { "type": "string", "description": "Button text." }
                        },
                        "required": ["id", "label"]
                    },
                    "description": "Optional answer buttons (max 6)."
                },
                "allow_free_text": { "type": "boolean", "description": "Let the person type an answer. Default true when there are no choices, false otherwise." },
                "context": { "type": "string", "maxLength": 1000, "description": "Optional short background shown under the question." },
                "timeout_s": { "type": "number", "minimum": 1, "maximum": 3600, "description": "Seconds to wait for an answer (default 600, max 3600)." },
                "urgency": { "type": "string", "enum": ["normal", "high"], "description": "high marks the question as needing attention soon." },
                "agent": { "type": "string", "description": "Optional name to show as the asker, for example the agent you are." },
                "pane_id": { "type": "string", "description": "Optional pane you run in, so the question is listed under that pane." }
            }),
            vec!["question"],
        ),
        output_schema: Some(json!({
            "type": "object",
            "properties": {
                "answered": { "type": "boolean" },
                "choice_id": { "type": "string" },
                "text": { "type": "string" },
                "answered_by": { "type": "string", "enum": ["desktop", "phone"] },
                "reason": { "type": "string", "enum": ["timeout", "cancelled"] },
                "question_id": { "type": "string" }
            },
            "required": ["answered"]
        })),
        safety: ToolSafety::ReadOnly,
        visibility: visible_everywhere(),
        method: "POST",
        path: "/questions/ask",
    }]
}
