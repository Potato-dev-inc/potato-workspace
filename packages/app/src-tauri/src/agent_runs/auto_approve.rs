//! `run_agent(auto_approve)`: the caller lets the app answer permission questions for the run.
//!
//! The only step above "ask" is `"reads"`: a question whose tool kind is a read, search, fetch or think is answered "allow
//! once" (the chat lane does it, `acp::session`). Edits and commands are never auto-approved by this option, and anything
//! the app cannot sort by kind still parks as `needs_input`. The terminal has no structured tool kinds, so a terminal run
//! that asks for it is refused instead of quietly asking.

use serde_json::{json, Value};

use crate::operations::OperationError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoApprove {
    Ask,
    Reads,
}

/// The `auto_approve` the request names (`"ask"` when it is left out).
pub(crate) fn parse(body: &Value) -> Result<AutoApprove, OperationError> {
    match body.get("auto_approve") {
        None | Some(Value::Null) => Ok(AutoApprove::Ask),
        Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
            "" | "ask" | "none" => Ok(AutoApprove::Ask),
            "reads" => Ok(AutoApprove::Reads),
            other => Err(invalid(format!(
                "auto_approve {other:?} is not allowed: a caller can auto-approve reads only. Edits and commands always ask the person."
            ))),
        },
        Some(_) => Err(invalid("auto_approve must be \"ask\" or \"reads\".".to_string())),
    }
}

fn invalid(message: String) -> OperationError {
    let mut error = OperationError::new("INVALID_ARGUMENT", message, false);
    error.context = json!({ "field": "auto_approve", "valid": ["ask", "reads"], "try": { "tool": "run_agent", "change": { "auto_approve": "reads" } } });
    error
}

/// A run in the terminal cannot sort questions by kind, so it cannot auto-approve reads.
pub(crate) fn needs_chat() -> OperationError {
    let mut error = OperationError::new(
        "AUTO_APPROVE_NEEDS_CHAT",
        "auto_approve: \"reads\" works in a chat session only (a terminal cannot tell a read from an edit). Nothing was started.",
        false,
    );
    error.context = json!({ "try": { "tool": "run_agent", "change": { "lane": "acp" }, "or": { "omit": ["auto_approve"] } } });
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn left_out_means_ask() {
        assert_eq!(parse(&json!({})).unwrap(), AutoApprove::Ask);
        assert_eq!(parse(&json!({ "auto_approve": null })).unwrap(), AutoApprove::Ask);
        assert_eq!(parse(&json!({ "auto_approve": "ask" })).unwrap(), AutoApprove::Ask);
    }

    #[test]
    fn reads_is_the_only_step_up() {
        assert_eq!(parse(&json!({ "auto_approve": "reads" })).unwrap(), AutoApprove::Reads);
        for more in ["project_edits", "edits", "all", "commands"] {
            let error = parse(&json!({ "auto_approve": more })).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{more}");
            assert!(error.message.contains("reads only"), "{}", error.message);
        }
        assert!(parse(&json!({ "auto_approve": ["reads"] })).is_err());
    }

    #[test]
    fn a_terminal_run_is_refused_with_a_way_forward() {
        let error = needs_chat();
        assert_eq!(error.code, "AUTO_APPROVE_NEEDS_CHAT");
        assert_eq!(error.context["try"]["change"]["lane"], "acp");
    }
}
