//! `/config/*`: change the app's setup in two steps, plan then apply (logic: `crate::config_plan`).
//!
//! * `GET  /config/standby`  the standby helpers and their state.
//! * `POST /config/plan`     `{ops:[...]}` -> `{plan_id, lines, ...}`. Changes nothing.
//! * `POST /config/apply`    `{plan_id}` runs exactly that plan, once.
//! * `POST /config/op`       the MCP tool `workspace_config` (`{op:"plan"|"apply"|"read", ...}`), same functions.
//!
//! Who may call: this computer only (a paired phone or any forwarder/foreign-origin request is refused; devices get no
//! config routes in v1). An agent changes nothing without the person's Allow card: a shell command in an agent's window
//! meets the shell gate before it gets here, an MCP session meets the same card below (`apply` only; planning and reading
//! are free). The person's own screen is never asked.

use super::{Ctx, RouteResult};
use crate::agent_authority::shell_gate;
use crate::config_plan::{self, LiveWorld, PlanStore, Refusal, World};
use crate::mobile_pairing::Caller;
use crate::operations::OperationError;
use serde_json::{json, Value};

fn refuse(status: u16, code: &str, message: &str, recoverable: bool) -> RouteResult {
    Err((status, json!({ "code": code, "error": message, "message": message, "recoverable": recoverable, "context": {} })))
}

fn from_refusal((code, message): Refusal) -> RouteResult {
    let status = match code {
        "PLAN_STALE" => 409,
        "PLAN_UNKNOWN" | "NOT_FOUND" => 404,
        "REFUSED" | "UNKNOWN_SETTING" => 403,
        "APPLY_FAILED" => 500,
        _ => 400,
    };
    refuse(status, code, &message, status == 409 || status == 400)
}

/// What the route needs beyond the world: asking the person for an agent caller. Tests swap it.
pub(crate) trait Consent {
    fn ask(&self, session: &str, plan_id: &str) -> Result<(), OperationError>;
}

struct LiveConsent;

impl Consent for LiveConsent {
    fn ask(&self, session: &str, plan_id: &str) -> Result<(), OperationError> {
        shell_gate::check_session_call(session, "POST", &["config", "apply"], &json!({ "plan_id": plan_id }), crate::questions::now_ms())
    }
}

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    let world = LiveWorld { app: cx.app, registry: cx.registry };
    handle_request(cx.method, cx.segments, &cx.request_body, cx.headers, cx.peer_loopback, cx.session, &world, config_plan::store(), &LiveConsent, crate::questions::now_ms())
}

fn plan_id(body: &Value) -> &str {
    body.get("plan_id").and_then(Value::as_str).unwrap_or("").trim()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_request(
    method: &str,
    raw_segments: &[&str],
    body: &Value,
    headers: &str,
    peer_loopback: bool,
    session: Option<&str>,
    world: &dyn World,
    plans: &PlanStore,
    consent: &dyn Consent,
    now: u64,
) -> Option<RouteResult> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(raw_segments);
    let ["config", op] = segments else { return None };
    match crate::mobile_pairing::authorize_caller(headers, peer_loopback, raw_segments, method) {
        Ok(Caller::Local) => {}
        Ok(_) | Err(_) => {
            return Some(refuse(403, "CONFIG_LOCAL_ONLY", "App setup can only be changed from this computer. A phone or any remote caller cannot do it.", false));
        }
    }
    let session = session.map(str::trim).filter(|s| !s.is_empty());
    let result = match (method, *op) {
        ("GET", "standby") => Ok((200, world.standby_view())),
        ("POST", "plan") => config_plan::plan(world, plans, body, now).map(|v| (200, serde_json::to_value(v).unwrap_or_default())),
        ("POST", "apply") => apply(world, plans, session, plan_id(body), consent, now),
        ("POST", "op") => {
            let Some(session) = session else {
                return Some(refuse(400, "SESSION_REQUIRED", "workspace_config needs an MCP session id.", false));
            };
            return Some(mcp_op(world, plans, session, body, consent, now));
        }
        _ => return Some(refuse(404, "NOT_FOUND", "Unknown config route.", false)),
    };
    Some(finish(result))
}

/// Applies a plan. An MCP session is asked here; a shell command was asked before it got to the router's handlers.
fn apply(world: &dyn World, plans: &PlanStore, session: Option<&str>, id: &str, consent: &dyn Consent, now: u64) -> Result<(u16, Value), Refusal> {
    if id.is_empty() {
        return Err(("INVALID_ARGUMENT", "apply needs the plan_id from the plan.".to_string()));
    }
    if let Some(session) = session {
        // Only a plan that exists can raise a card (a made-up id would show an empty card).
        if plans.card_lines(id, now).is_some() {
            if let Err(error) = consent.ask(session, id) {
                return Err(consent_refusal(error));
            }
        }
    }
    let applied = config_plan::apply(world, plans, id, now)?;
    crate::audit::record(
        crate::audit::Kind::Setting,
        session.map(|s| crate::audit::Who::Agent(s.to_string())).unwrap_or(crate::audit::Who::Local),
        "The app setup was changed from a plan",
        json!({ "plan_id": id, "lines": applied.lines.len(), "via": if session.is_some() { "mcp" } else { "bridge" } }),
    );
    Ok((200, serde_json::to_value(applied).unwrap_or_default()))
}

/// A consent answer travels as a refusal with a code the route turns back into its own status.
fn consent_refusal(error: OperationError) -> Refusal {
    let code: &'static str = if error.code == "CONSENT_PENDING" { "CONSENT_PENDING" } else { "CONSENT_DENIED" };
    (code, error.message)
}

fn mcp_op(world: &dyn World, plans: &PlanStore, session: &str, body: &Value, consent: &dyn Consent, now: u64) -> RouteResult {
    let which = body.get("op").and_then(Value::as_str).unwrap_or("").trim();
    let result = match which {
        "plan" => config_plan::plan(world, plans, body, now).map(|v| (200, serde_json::to_value(v).unwrap_or_default())),
        "apply" => apply(world, plans, Some(session), plan_id(body), consent, now),
        "read" => read(world, body),
        _ => Err(("INVALID_ARGUMENT", "op is \"plan\", \"apply\" or \"read\".".to_string())),
    };
    finish(result)
}

fn finish(result: Result<(u16, Value), Refusal>) -> RouteResult {
    match result {
        Ok(ok) => Ok(ok),
        Err(("CONSENT_PENDING", message)) => {
            // Same shape the shell path gets: the agent waits, then makes the same call again.
            Err((
                503,
                json!({ "code": "CONSENT_PENDING", "error": message, "message": message, "recoverable": true, "retry_after_ms": 10_000, "context": { "answered_where": "the Inbox in the Potato Workspace window" } }),
            ))
        }
        Err(("CONSENT_DENIED", message)) => refuse(403, "CONSENT_DENIED", &message, false),
        Err(refusal) => from_refusal(refusal),
    }
}

/// `{op:"read", what:"standby"|"settings"}`: no secrets (the settings catalog only lists keys the person may change).
fn read(world: &dyn World, body: &Value) -> Result<(u16, Value), Refusal> {
    match body.get("what").and_then(Value::as_str).unwrap_or("") {
        "standby" => Ok((200, world.standby_view())),
        "settings" => {
            let catalog = world.catalog();
            let entries: Vec<Value> = catalog["settings"]
                .as_array()
                .map(|all| all.iter().map(|e| json!({ "key": e["key"], "type": e["type"], "default": e["default"], "saved": e["saved"], "labs": e["labs"] })).collect())
                .unwrap_or_default();
            Ok((200, json!({ "settings": entries, "refused": catalog["refused"] })))
        }
        _ => Err(("INVALID_ARGUMENT", "read needs what: \"standby\" or \"settings\".".to_string())),
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
