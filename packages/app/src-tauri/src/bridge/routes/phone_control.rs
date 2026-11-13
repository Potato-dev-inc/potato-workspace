//! Three small routes for the phone (phone part 2).
//!
//! - `POST /panes/{id}/interrupt`: stop one agent's turn, like the Stop key on the PC. A chat session over ACP gets its
//!   turn cancelled, any other pane gets Ctrl+C. The phone needs `type` (`route_need`), and because the path is under
//!   `/panes/{id}` the agent's own remote rule (`mobile_pairing::pane_rules`) is checked by `authorize_caller` before this
//!   runs: a watch-only device, a watch-only agent and a switched-off agent are all refused there.
//! - `GET /pane-rules`: which agents have their own rule (a lock on the phone's drawer row). Any paired device.
//! - `POST /control-asks {pane_id}`: "Ask the PC for control" (`mobile_pairing::control_ask`). Any paired device may ask;
//!   only the person on the PC can allow, and one ask per agent per 5 minutes is taken.
//!
//! None of these is an MCP tool, so an agent session cannot reach them (`mcp_sessions::authorize`).

use serde_json::json;
use tauri::Emitter;

use super::{Ctx, RouteResult};
use crate::mobile_pairing::control_ask::{self, Refusal};
use crate::mobile_pairing::pane_rules;

/// The event the desktop's notice listens to.
pub const CONTROL_ASK_EVENT: &str = "remote://control-ask";

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("POST", ["panes", pane_id, "interrupt"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(interrupt(cx, pane_id)),
        ("GET", ["pane-rules"]) => Some(Ok((200, rules_body()))),
        ("POST", ["control-asks"]) => Some(control_ask(cx)),
        _ => None,
    }
}

fn interrupt(cx: &Ctx, pane_id: &str) -> RouteResult {
    if !cx.registry.lock().panes.contains_key(pane_id) {
        return Err((404, json!({ "error": crate::pty::registry::unknown_pane_message(pane_id), "code": "UNKNOWN_PANE" })));
    }
    if crate::acp::chat::is_chat_pane(cx.registry, pane_id) {
        return crate::acp::chat::api::cancel(pane_id);
    }
    crate::pty::registry_write_input(cx.registry, cx.app, pane_id, "\u{3}", false, false, None, crate::pty::WriteOrigin::User)
        .map_err(|error| (502, json!({ "error": error, "code": "INTERRUPT_FAILED" })))?;
    Ok((200, json!({ "pane_id": pane_id, "stopped": true })))
}

/// `{ "rules": { "<pane id>": { "remote": bool, "level": "watch" | "answer" | "full" } } }`: only the agents whose rule is not
/// the default (on, full). An agent that is not listed has no rule.
pub(super) fn rules_body() -> serde_json::Value {
    let rules: serde_json::Map<String, serde_json::Value> = pane_rules::all()
        .into_iter()
        .map(|(pane, rule)| (pane, json!({ "remote": rule.remote, "level": rule.level })))
        .collect();
    json!({ "rules": rules })
}

fn control_ask(cx: &Ctx) -> RouteResult {
    let Some(device_id) = paired_device(cx) else {
        return Err((403, json!({ "error": "paired_device_required", "code": "PERSON_ONLY", "hint": "Only a paired phone can ask the PC for control." })));
    };
    let Some(pane_id) = cx.request_body.get("pane_id").and_then(|v| v.as_str()).map(str::trim).filter(|id| !id.is_empty()) else {
        return Err((400, json!({ "error": "pane_id is required", "code": "INVALID_ARGUMENT" })));
    };
    if !cx.registry.lock().panes.contains_key(pane_id) {
        return Err((404, json!({ "error": crate::pty::registry::unknown_pane_message(pane_id), "code": "UNKNOWN_PANE" })));
    }
    let name = crate::attention::caps::device_name(&device_id).unwrap_or_else(|| "A phone".to_string());
    match control_ask::request(&device_id, &name, pane_id) {
        Ok(ask) => {
            let _ = cx.app.emit(CONTROL_ASK_EVENT, &ask);
            crate::audit::record(
                crate::audit::Kind::Pairing,
                crate::audit::Who::Device(Some(device_id)),
                "A phone asked for control of one agent",
                json!({ "pane_id": pane_id }),
            );
            Ok((202, json!({ "asked": true, "id": ask.id })))
        }
        Err(Refusal::AlreadyAllowed) => Ok((200, json!({ "asked": false, "reason": "already_allowed" }))),
        Err(Refusal::TooSoon { retry_after_ms }) => {
            Err((429, json!({ "error": "You asked about this agent a moment ago.", "code": "ASKED_RECENTLY", "retry_after_ms": retry_after_ms })))
        }
        Err(Refusal::Busy) => Err((429, json!({ "error": "Too many asks wait on the PC.", "code": "BUSY" }))),
    }
}

/// The paired device that is calling, when it is a person's phone (not an agent's MCP session).
pub(super) fn paired_device(cx: &Ctx) -> Option<String> {
    if cx.session.is_some() {
        return None;
    }
    let token = crate::mobile_pairing::bearer_token(cx.headers)?;
    crate::mobile_pairing::pairing_store()?.lock().device_id_for_token(&token)
}

#[cfg(test)]
#[path = "phone_control_tests.rs"]
mod tests;
