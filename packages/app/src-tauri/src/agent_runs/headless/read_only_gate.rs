//! The read-only check of `run_agent`, as one function: `read_only: true` starts only on a way that really enforces
//! it. When it cannot, the refusal carries `try`, the same call without `read_only` (and says it weakens the run), so
//! an agent that was only just added (its definition claims nothing) gets an answer it can act on.

use super::super::capabilities;
use crate::agent_runs::runtime::AgentRunRequest;
use crate::operations::OperationError;
use serde_json::{json, Map, Value};

/// The request fields that make up the corrected call. Anything else the caller set is theirs to repeat.
const KEPT: [&str; 7] = ["agent_type", "task", "project_path", "name", "model", "reasoning", "isolation"];

/// `Ok` when the run does not ask for read-only, or the way it will run enforces it.
pub(crate) fn check(request: &AgentRunRequest) -> Result<(), OperationError> {
    if !request.read_only || read_only_ok(request) {
        return Ok(());
    }
    let mut message = capabilities::read_only_unsupported_message(&request.agent_type, !request.headless);
    if request.headless_ignored {
        message.push_str(crate::agent_run_mode::HIDDEN_HELPERS_HINT);
    }
    let mut error = OperationError::new("READ_ONLY_UNSUPPORTED", message, false);
    error.context = json!({ "try": retry_without_read_only(request) });
    Err(error)
}

fn read_only_ok(request: &AgentRunRequest) -> bool {
    let profile = crate::tui::profile_for(&request.agent_type);
    if profile.features().read_only_spawned_pane {
        request.pane_id.as_deref().is_none_or(|pane| capabilities::read_only_supported_for(&request.agent_type, Some(pane)))
    } else if request.headless {
        capabilities::read_only_supported(&request.agent_type, false)
    } else {
        // A visible pane the run spawns itself, started read-only by the agent's own launch flags.
        // A named or adopted pane was started by someone else and is never read-only.
        request.pane_id.is_none() && crate::tui::enforces_read_only_by_flags(profile.as_ref())
    }
}

fn retry_without_read_only(request: &AgentRunRequest) -> Value {
    let all = serde_json::to_value(request).unwrap_or(Value::Null);
    let mut args = Map::new();
    for key in KEPT {
        if let Some(v) = all.get(key).filter(|v| !v.is_null()) {
            args.insert(key.to_string(), v.clone());
        }
    }
    json!({ "tool": "run_agent", "args": Value::Object(args), "changes": ["read_only removed"], "weakens": ["read_only"] })
}
