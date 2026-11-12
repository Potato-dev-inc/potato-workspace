//! `POST /agents/review`: a second opinion on a finished run (MCP `review_agent`, and what `run_agent(review_by)` calls).

use super::wire::{parse, project_path};
use crate::operations::OperationError;
use crate::second_opinion::mcp::{ReviewAsk, DEFAULT_WAIT_MS, MAX_WAIT_MS};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
struct ReviewRequest {
    handle: String,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    allow_same: bool,
    #[serde(default)]
    wait_ms: Option<u64>,
}

pub(super) fn review_agent(
    body: &[u8],
    query: &str,
    session_id: Option<&str>,
    registry: &Arc<Mutex<crate::pty::PaneRegistry>>,
    app: &AppHandle,
) -> Result<Value, OperationError> {
    let request = parse::<ReviewRequest>(body)?;
    if request.handle.trim().is_empty() {
        return Err(OperationError::new("INVALID_ARGUMENT", "handle is required", false));
    }
    let wait_ms = request.wait_ms.unwrap_or(DEFAULT_WAIT_MS);
    if wait_ms > MAX_WAIT_MS {
        return Err(OperationError::new("INVALID_TIMEOUT", format!("wait_ms must be between 0 and {MAX_WAIT_MS}"), false));
    }
    let explicit = request.project_path.as_deref().filter(|p| !p.trim().is_empty());
    let project = explicit.map(|p| project_path(Some(p), query, registry));
    let ask = ReviewAsk { agent_type: request.agent_type, model: request.model, allow_same: request.allow_same };
    let review = crate::second_opinion::mcp_live::review_handle(
        registry.clone(),
        app.clone(),
        session_id.map(str::to_string),
        project.as_deref(),
        &request.handle,
        &ask,
        wait_ms,
    )?;
    Ok(json!({ "handle": request.handle, "review": review }))
}
