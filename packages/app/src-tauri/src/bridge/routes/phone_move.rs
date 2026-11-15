//! The far side of "Take the conversation and the work" (`crate::chat_move`): another paired Workspace sends the work of a
//! chat as a git bundle and this PC checks it out in one of its own projects.
//!
//! - `POST /phone/move-work {project, branch, bundle_b64}`: `project` is an `id` from `GET /phone/new-chat` (so only a
//!   folder this PC already knows), `branch` is `potato/move-<id>`, `bundle_b64` is the bundle (at most `BUNDLE_MAX`).
//!   Needs `control`. It is answered only for a paired Workspace on the PC link (`link_current_node`): a phone never
//!   moves work. A folder that is not git, has unsaved changes or is not at the same point is refused in plain words
//!   and nothing in it changes.
//!
//! Not an MCP tool: an agent session cannot reach it (`mcp_sessions::authorize`).

use base64::Engine as _;
use serde_json::{json, Value};

use super::phone_chat::resolve_project;
use super::{Ctx, RouteResult};
use crate::chat_move::work;

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("POST", ["phone", "move-work"]) => Some(receive(cx)),
        _ => None,
    }
}

fn refuse(status: u16, code: &str, message: &str) -> (u16, Value) {
    (status, json!({ "code": code, "error": message }))
}

fn receive(cx: &Ctx) -> RouteResult {
    if crate::bridge::link_current_node().is_none() {
        return Err(refuse(403, "NOT_A_DEVICE", "Only a paired computer can move work here."));
    }
    let text = |key: &str| cx.request_body.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let project = text("project").ok_or_else(|| refuse(400, "INVALID_ARGUMENT", "project is required"))?;
    let branch = text("branch").ok_or_else(|| refuse(400, "INVALID_ARGUMENT", "branch is required"))?;
    let b64 = text("bundle_b64").ok_or_else(|| refuse(400, "INVALID_ARGUMENT", "bundle_b64 is required"))?;
    if !work::branch_ok(branch) {
        return Err(refuse(400, "INVALID_ARGUMENT", work::BAD_BRANCH));
    }
    // The base64 text is cut at the cap before it is decoded.
    if b64.len() > work::BUNDLE_MAX / 3 * 4 + 8 {
        return Err(refuse(413, "PAYLOAD_TOO_LARGE", work::TOO_BIG));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| refuse(400, "INVALID_ARGUMENT", "The work did not arrive whole."))?;
    let projects = super::phone_chat::known_projects(cx);
    let Some(folder) = resolve_project(&projects, project) else {
        return Err(refuse(404, "UNKNOWN_PROJECT", "This PC does not know that project. Open it here first."));
    };
    match work::receive(std::path::Path::new(&folder), branch, &bytes) {
        Ok(got) => Ok((200, json!({ "ok": true, "branch": got.branch, "sha": got.sha }))),
        Err(sentence) => Err(refuse(409, "MOVE_REFUSED", &sentence)),
    }
}
