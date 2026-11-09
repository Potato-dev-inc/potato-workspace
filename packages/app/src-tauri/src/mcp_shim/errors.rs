//! The one error contract for tool results: `{code, message, retryable, retry_after_ms?, fix?, ...}`.
//! Fields a caller already relies on (`recoverable`, `context`, `outcome`, ...) are kept.

use super::*;

/// What to do when the app is not reachable.
pub(crate) const START_APP_FIX: &str = "Start Potato Workspace, then retry.";

/// Codes that are worth retrying when a payload does not say so itself.
fn code_is_retryable(code: &str) -> bool {
    matches!(
        code,
        "RATE_LIMITED"
            | "BRIDGE_UNAVAILABLE"
            | "BRIDGE_RESTARTING"
            | "BRIDGE_TIMEOUT"
            | "WAIT_TIMEOUT"
            | "CONFLICT"
            | "REQUEST_CANCELLED"
            | "bridge_error"
    )
}

/// Builds the contract body for a plain error string (no JSON, no code).
fn classify_plain(message: &str) -> Value {
    let invalid = message.starts_with("missing required")
        || message.starts_with("refusing to target")
        || message.starts_with("unknown tool:");
    if invalid {
        return json!({"code":"INVALID_ARGUMENT","message":message,"recoverable":false,"context":{}});
    }
    if message.starts_with(BRIDGE_DOWN) || message.starts_with(BRIDGE_UNREACHABLE) {
        return json!({"code":"BRIDGE_UNAVAILABLE","message":message,"recoverable":true,"retry_after_ms":2000,"fix":START_APP_FIX,"context":{}});
    }
    if message.starts_with(BRIDGE_RESET) {
        return json!({"code":"BRIDGE_RESTARTING","message":message,"recoverable":true,"retry_after_ms":2000,"fix":START_APP_FIX,"context":{}});
    }
    if message.starts_with(BRIDGE_TIMEOUT) {
        return json!({"code":"BRIDGE_TIMEOUT","message":message,"recoverable":true,"context":{}});
    }
    json!({"code":"bridge_error","message":message,"recoverable":true,"context":{}})
}

/// Normalises any error text a tool call produced into the contract body.
pub(crate) fn tool_error_detail(message: &str) -> Value {
    let mut detail = match serde_json::from_str::<Value>(message) {
        Ok(value) if value.get("code").is_some() => ensure_error_message(value),
        _ => classify_plain(message),
    };
    apply_contract(&mut detail);
    detail
}

/// Adds `retryable` (mirroring `recoverable` when that is all the payload has) and drops a null
/// `retry_after_ms`, so every error body has the same required fields.
pub(crate) fn apply_contract(detail: &mut Value) {
    let Some(object) = detail.as_object_mut() else { return };
    let code = object.get("code").and_then(Value::as_str).unwrap_or_default().to_owned();
    if !object.contains_key("message") {
        object.insert("message".into(), json!("tool call failed"));
    }
    if !object.get("retryable").is_some_and(Value::is_boolean) {
        let retryable = object
            .get("recoverable")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| code_is_retryable(&code));
        object.insert("retryable".into(), json!(retryable));
    }
    if object.get("retry_after_ms").is_some_and(Value::is_null) {
        object.remove("retry_after_ms");
    }
}

/// An MCP tool result carrying `detail` as an error.
pub(crate) fn tool_error_result(detail: Value) -> Value {
    let text = detail.get("message").and_then(Value::as_str).unwrap_or("tool call failed").to_owned();
    json!({"content":[{"type":"text","text":text}],"isError":true,"structuredContent":detail})
}

/// The app is not running (or never came back within the wait).
pub(crate) fn bridge_unavailable(detail: &str) -> String {
    json!({
        "code": "BRIDGE_UNAVAILABLE",
        "message": format!("Potato Workspace is not reachable. {detail}"),
        "recoverable": true,
        "retryable": true,
        "retry_after_ms": 2000,
        "fix": START_APP_FIX,
        "context": {}
    })
    .to_string()
}

/// The app dropped or refused the connection while it was restarting. `sent` says whether the
/// request may have reached it (a mid-call reset) or certainly did not (a refused connection).
pub(crate) fn bridge_restarting(detail: &str, sent: bool) -> String {
    let advice = if sent {
        "The call may or may not have been applied; check with list_agents or get_operation before repeating a call that has no idempotency_key."
    } else {
        "The request was not sent; it is safe to retry."
    };
    json!({
        "code": "BRIDGE_RESTARTING",
        "message": format!("Potato Workspace is restarting. {advice} ({detail})"),
        "recoverable": true,
        "retryable": true,
        "retry_after_ms": 2000,
        "outcome": if sent { "unknown" } else { "not_sent" },
        "fix": START_APP_FIX,
        "context": {}
    })
    .to_string()
}
