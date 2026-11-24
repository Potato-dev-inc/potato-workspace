//! The error every operation and engine call can return (moved out of `operations/model.rs`; the app re-exports it there).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(default)]
    pub context: Value,
}
impl OperationError {
    pub fn new(code: &str, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable,
            retry_after_ms: None,
            context: Value::Null,
        }
    }

    /// A request body that did not parse. Always a client mistake, so every code here maps to a
    /// 4xx in `bridge::errors::operation_http_error`:
    /// - `INVALID_JSON`: not JSON at all (syntax error, truncated body);
    /// - `MISSING_FIELD`: valid JSON without a required field (`context.field` names it);
    /// - `INVALID_FIELD`: valid JSON whose shape or value is wrong (wrong type, unknown variant).
    pub fn invalid_body(error: &serde_json::Error) -> Self {
        use serde_json::error::Category;
        let text = error.to_string();
        let (code, field) = match error.classify() {
            Category::Syntax | Category::Eof | Category::Io => ("INVALID_JSON", None),
            Category::Data => match missing_field_name(&text) {
                Some(field) => ("MISSING_FIELD", Some(field)),
                None => ("INVALID_FIELD", None),
            },
        };
        let mut out = Self::new(code, text, false);
        if let Some(field) = field {
            out.context = serde_json::json!({ "field": field });
        }
        out
    }

    pub fn unknown_agent_type(id: impl Into<String>, valid: Vec<String>) -> Self {
        let id = id.into();
        let mut error = Self::new(
            "UNKNOWN_AGENT_TYPE",
            format!("unknown agent_type: {id}"),
            false,
        );
        error.context = serde_json::json!({
            "valid": valid,
            "hint": "GET /agents/types",
        });
        error
    }
    pub fn io(err: impl std::fmt::Display) -> Self {
        Self::new("STORAGE_ERROR", err.to_string(), true)
    }
    /// Storage error that names the failing step and path (a bare OS error like
    /// "The system cannot find the path specified. (os error 3)" is undiagnosable).
    pub fn io_at(
        step: &str,
        path: &std::path::Path,
        err: impl std::fmt::Display,
    ) -> Self {
        let mut error = Self::new(
            "STORAGE_ERROR",
            format!("{step} failed for {}: {err}", path.display()),
            true,
        );
        error.context = serde_json::json!({"step": step, "path": path.display().to_string()});
        error
    }
}

/// `missing field `prompt_id` at line 1 column 40` -> `prompt_id`.
fn missing_field_name(text: &str) -> Option<String> {
    let rest = text.strip_prefix("missing field `")?;
    rest.split('`').next().map(str::to_string)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultCapture {
    Authoritative,
    Inferred,
    Missing,
}
