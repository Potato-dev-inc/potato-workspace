//! Catalog entries: the project guide tools (`read_guide_structure`, `read_guide_page`, `ask_guide`), Labs
//! "Project guide". Read-only; local agents only. Bridge routes: `bridge/routes/guide_mcp.rs`; logic:
//! `crate::project_guide::agent_tools`.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "read_guide_structure",
            description: "Project guide (Labs): the list of pages of this project's guide, with ids. Call this first when you start work in a project and want to know how it fits together. The guide is a few short pages written by an agent and checked against the files; it is not a source of truth, so trust the code over it. Returns {title, commit, age_days, written_by, pages:[{id, title, purpose, stale, needs_review}], diagram, stale_pages}. A stale page cites files that changed since it was written. Errors: GUIDE_OFF, NO_GUIDE, PROJECT_NOT_ALLOWED, INVALID_ARGUMENT.",
            input_schema: object_schema(json!({ "project_path": { "type": "string", "maxLength": 1000, "description": "The project folder (your own working folder)." } }), vec!["project_path"]),
            output_schema: None,
            safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/guide/structure",
        },
        ToolDefinition {
            name: "read_guide_page",
            description: "Project guide (Labs): read one page of the guide as Markdown, with citations like [[src/a.ts:10-40]] that point at real files and lines. page_id is an id from read_guide_structure, or \"diagram\" for the architecture diagram (Mermaid text and the boxes with their files). A stale page starts with a line that names the changed files: check those in the code. Returns {id, title, markdown, stale, changed, needs_review}. Errors: GUIDE_OFF, NO_GUIDE, UNKNOWN_PAGE, PROJECT_NOT_ALLOWED, INVALID_ARGUMENT.",
            input_schema: object_schema(
                json!({
                    "project_path": { "type": "string", "maxLength": 1000, "description": "The project folder (your own working folder)." },
                    "page_id": { "type": "string", "maxLength": 48, "description": "A page id from read_guide_structure, or \"diagram\"." }
                }),
                vec!["project_path", "page_id"],
            ),
            output_schema: None,
            safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/guide/page",
        },
        ToolDefinition {
            name: "ask_guide",
            description: "Project guide (Labs): ask the guide a question about the project, for example ask_guide({question:\"where is sync handled\"}). This does NOT run a model and costs the person nothing: it finds the guide pages that fit the question best and returns the matching passages with their citations, so you read the answer yourself and check the cited files. If the guide does not mention the topic, found is false: search the code instead. Returns {found, matches:[{page_id, title, stale, passage, citations}], answered_by}. Errors: GUIDE_OFF, NO_GUIDE, PROJECT_NOT_ALLOWED, INVALID_ARGUMENT.",
            input_schema: object_schema(
                json!({
                    "project_path": { "type": "string", "maxLength": 1000, "description": "The project folder (your own working folder)." },
                    "question": { "type": "string", "maxLength": 1000, "description": "A few words about the project." }
                }),
                vec!["project_path", "question"],
            ),
            output_schema: None,
            safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/guide/ask",
        },
    ]
}
