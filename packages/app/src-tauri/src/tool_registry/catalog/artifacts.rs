//! Catalog entry: `show_artifact`, a page the agent made (HTML, Markdown, SVG or a Mermaid diagram) that shows as a
//! card in the agent's chat and opens beside it. The route is `bridge/routes/artifacts.rs`; the store is `crate::artifacts`.
//!
//! It is callable by name in every mode that has the agent tools, and listed (like `companion_recall`) for an agent that
//! Potato Workspace started in one of its own panes: that agent has a chat to show the page in. An agent that cannot call
//! tools writes a file into `<project>/.potato/artifacts/` instead; the app turns each file and each edit into a version.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub const SHOW: &str = "show_artifact";

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: SHOW,
        description: "Show the person a page you made: a report, chart, diagram, mockup or small tool. It appears as a card in your chat and opens beside it (scripts run, no network except a few CDNs). Give content or a path inside the project. Same id again = next version. Or just write the file into <project>/.potato/artifacts/. Returns {id, version, file}.",
        input_schema: object_schema(
            json!({
                "title": { "type": "string", "maxLength": 120, "description": "Short name shown on the card." },
                "content": { "type": "string", "description": "The page itself (up to 16 MB). Use this or path." },
                "path": { "type": "string", "description": "A file inside the project to show, instead of content." },
                "kind": { "type": "string", "enum": ["html", "markdown", "svg", "mermaid"], "description": "Left out: guessed from the file name or the text." },
                "id": { "type": "string", "maxLength": 48, "description": "To update a page you showed before, pass its id. Left out: made from the title." },
                "pane_id": { "type": "string", "description": "Your own pane, when you know it (usually not needed)." }
            }),
            vec![],
        ),
        output_schema: None,
        safety: ToolSafety::ReadOnly,
        visibility: visible_everywhere(),
        method: "POST",
        path: "/artifacts/show",
    }]
}
