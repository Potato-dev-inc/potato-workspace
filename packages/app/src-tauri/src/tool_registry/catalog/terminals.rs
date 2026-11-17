//! Catalog entries: the agent background terminals (`start_terminal`, `read_terminal`, `wait_terminal`,
//! `stop_terminal`). The routes are `POST /terminals/{start,read,wait,stop}` (`bridge/routes/terminals.rs`, logic in
//! `agent_terminals`).
//!
//! They are callable by name in every mode that has the agent tools, and listed (like `show_artifact`) for an agent that
//! Potato Workspace started in one of its own panes: an agent outside every pane has no chat to show a row in.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "start_terminal",
            description: "Run a command that keeps running (a dev server, a watcher, a long test run) without a window. The person sees it in Background tasks and the first one in a chat asks them to Allow it; a dangerous command asks every time. Returns {terminal_id, state, pid, output_tail, ports, matched?}. With wait_for (text or regex) it waits until a line matches, up to wait_ms (default 30000, max 120000). Errors: CONSENT_DENIED, TOO_MANY_TERMINALS (4 running at once; stop one), CWD_OUTSIDE_PROJECT.",
            input_schema: object_schema(
                json!({
                    "command": { "description": "One command line, or a list: the program and its arguments.", "anyOf": [ { "type": "string", "minLength": 1 }, { "type": "array", "items": { "type": "string" }, "minItems": 1 } ] },
                    "cwd": { "type": "string", "description": "A folder inside your project (default: the project)." },
                    "name": { "type": "string", "maxLength": 60, "description": "A short plain name for the row, e.g. \"Dev server\"." },
                    "wait_for": { "type": "string", "description": "Wait until a line contains this text or matches this regular expression, e.g. \"ready\"." },
                    "wait_ms": { "type": "integer", "minimum": 0, "maximum": 120000, "default": 30000 }
                }),
                vec!["command"],
            ),
            output_schema: None,
            safety: ToolSafety::Mutating,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/terminals/start",
        },
        ToolDefinition {
            name: "read_terminal",
            description: "Read what a terminal printed (secrets masked), its state and the ports it listens on. Pass after_cursor from the last answer to get only new lines. Without terminal_id it lists your terminals. Returns {lines, next_cursor, state, exit_code?, ports}. A finished terminal can be read for 10 minutes.",
            input_schema: object_schema(
                json!({
                    "terminal_id": { "type": "string" },
                    "after_cursor": { "type": "integer", "minimum": 0 },
                    "max_lines": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 200 }
                }),
                vec![],
            ),
            output_schema: None,
            safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/terminals/read",
        },
        ToolDefinition {
            name: "wait_terminal",
            description: "Wait for a terminal: until a line matches ({line: \"ready\"}, text or regex), until it listens on a port ({port: true} or {port: 5173}), or until it ends (\"exit\"). Returns {reason: line|port|exit|timeout, matched?, lines, next_cursor, ports, exit_code?}. timeout_ms up to 3600000.",
            input_schema: object_schema(
                json!({
                    "terminal_id": { "type": "string" },
                    "until": { "description": "{line: text-or-regex}, {port: true | number}, or \"exit\".", "anyOf": [ { "type": "string", "enum": ["exit"] }, { "type": "object" } ] },
                    "after_cursor": { "type": "integer", "minimum": 0 },
                    "timeout_ms": { "type": "integer", "minimum": 0, "maximum": 3600000, "default": 60000 }
                }),
                vec!["terminal_id", "until"],
            ),
            output_schema: None,
            safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/terminals/wait",
        },
        ToolDefinition {
            name: "stop_terminal",
            description: "Stop a terminal and everything it started. Returns {state: \"stopped\"}. Your terminals also stop when your chat closes.",
            input_schema: object_schema(json!({ "terminal_id": { "type": "string" } }), vec!["terminal_id"]),
            output_schema: None,
            safety: ToolSafety::Mutating,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/terminals/stop",
        },
    ]
}
