//! The one place this app answers a permission question for the caller: `run_agent(auto_approve: "reads")`.
//!
//! `AcpSession::set_auto_approve_reads` turns it on for a chat; `session.rs` asks [`read_option`] only for a tool whose kind is a
//! read, search, fetch or think (`read_only_allows`), and only the "allow once" option is ever picked. It never picks "allow
//! always", and an edit or a command never reaches here. Kept apart from `session.rs` so that file still has exactly one place
//! that selects an option for a person (`answer_permission`, see `guard_tests`).

use super::conn::{selected_outcome, AcpConnection};
use super::types::RequestPermissionRequest;
use serde_json::Value;

/// The "allow once" option the agent offered, if it offered one.
pub(super) fn read_option(request: &RequestPermissionRequest) -> Option<String> {
    request.options.iter().find(|o| o.kind == "allow_once").map(|o| o.option_id.clone())
}

pub(super) fn respond(conn: &AcpConnection, rpc_id: &Value, option_id: &str) {
    let _ = conn.respond(rpc_id, selected_outcome(option_id));
}
