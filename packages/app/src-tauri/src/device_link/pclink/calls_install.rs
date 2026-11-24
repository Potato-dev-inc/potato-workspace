//! P6.2 install rows of the far call table (`calls.rs`, block `---- P6.2 install ----`): put an agent on THIS PC when the person at another
//! PC of theirs chose "Install <agent> on <this PC>?". Each row runs the same inner function as the Tauri command of that name
//! (`crate::agent_install`), so the window here and a paired PC cannot drift: the plan is built fresh here, a changed command is refused
//! (`INSTALL_COMMAND_CHANGED`), a downloaded script needs its second yes (`acknowledgedRisk`), and every step runs in a visible
//! terminal pane here that the far viewer opens in its normal terminal view (P2.3).
//!
//! S13: Full only (the table), only from the person's OWN account (`_marked`, set by `pclink::handle`, never by the asker), and audited
//! here by agent id only. No row reads a login, and the vendor script is never reachable except through the plan.

use serde_json::{json, Value};

use super::calls::text_arg;
use crate::bridge::link_app_handles;

type Reply = (u16, Value);

/// The four rows, in table order.
pub const ROWS: [&str; 4] = ["agents_install_plan", "agents_install_run", "agents_install_status", "agents_install_finish"];

pub fn mine(cmd: &str) -> bool {
    ROWS.contains(&cmd)
}

fn bad(message: &str) -> Reply {
    (400, json!({ "code": "INVALID_ARGUMENT", "error": message }))
}

/// A Tauri command's `"CODE: sentence"` error as the PC link's `{ code, error }`.
fn command_error(text: &str) -> Reply {
    let (code, message) = match text.split_once(": ") {
        Some((code, message)) if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_') => (code, message),
        _ => ("COMMAND_FAILED", text),
    };
    (400, json!({ "code": code, "error": message }))
}

/// One install event on this PC for the audit trail: which PC asked, what it did, which agent. Never a command or anything it printed.
fn audit(node: &str, what: &str, agent: &str) {
    crate::audit::record(
        crate::audit::Kind::Setting,
        crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))),
        &summary(what, agent),
        json!({ "agent": agent }),
    );
}

fn summary(what: &str, agent: &str) -> String {
    format!("A paired PC {what} an agent here ({agent})")
}

// Starting a step needs the app handle (it spawns a pane). A unit-test binary must not link that Tauri layer (STATUS_ENTRYPOINT_NOT_FOUND,
// REPO_MAP), so under test the step stops after the checks below and the pane itself is proven in the app.
#[cfg(not(test))]
fn spawn(agent: &str, step: usize, shown: &str, risk: bool) -> Result<Value, String> {
    let (app, registry) = link_app_handles().ok_or("BRIDGE_NOT_READY: The app is not ready yet.")?;
    crate::agent_install::start(&app, &registry, agent, step, shown, risk)
}
#[cfg(test)]
fn spawn(_: &str, _: usize, _: &str, _: bool) -> Result<Value, String> {
    Err("BRIDGE_NOT_READY: The app is not ready yet.".into())
}

/// The checks a run meets before any pane starts, on a plan built here and now: a blocked plan, a step that is not there, a command that
/// is not the one shown, a script without its second yes. The same `check_request` the window's own Install runs.
pub(crate) fn vet(agent: &str, step: usize, shown: &str, risk: bool, tools: &crate::agent_install::plan::Tools) -> Result<(), String> {
    let (plan, _) = crate::agent_install::plan_for(agent, tools)?;
    crate::agent_install::check_request(&plan, step, shown, risk).map(|_| ())
}

/// One install call from a paired PC. The level (Full) was checked before; `None`: not one of these rows.
pub fn run(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    if !mine(cmd) {
        return None;
    }
    // Another account's PC never installs here, whatever level it was given.
    if !args.get("_marked").and_then(Value::as_bool).unwrap_or(false) {
        return Some((403, json!({ "code": "NOT_YOUR_PC", "error": "Only your own PCs can install agents here." })));
    }
    Some(match cmd {
        "agents_install_plan" => match text_arg(args, "agentId") {
            Some(agent) => crate::agent_install::plan(&agent).map(|v| (200, v)).unwrap_or_else(|text| command_error(&text)),
            None => bad("agentId is required"),
        },
        "agents_install_run" => {
            let (Some(agent), Some(step), Some(shown)) = (text_arg(args, "agentId"), super::calls::arg(args, "step").and_then(Value::as_u64), super::calls::arg(args, "shownCommand").and_then(Value::as_str))
            else {
                return Some(bad("agentId, step and shownCommand are required"));
            };
            let risk = super::calls::arg(args, "acknowledgedRisk").and_then(Value::as_bool).unwrap_or(false);
            if let Err(text) = vet(&agent, step as usize, shown, risk, &crate::agent_install::plan::Tools::detect()) {
                return Some(command_error(&text));
            }
            match spawn(&agent, step as usize, shown, risk) {
                Ok(started) => {
                    audit(node, "started an install step of", &agent);
                    (200, started)
                }
                Err(text) => command_error(&text),
            }
        }
        "agents_install_status" => match text_arg(args, "paneId") {
            Some(pane) => match link_app_handles() {
                Some((_, registry)) => (200, crate::agent_install::status(&registry, &pane)),
                None => (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" })),
            },
            None => bad("paneId is required"),
        },
        _ => match text_arg(args, "agentId") {
            Some(agent) => match crate::agent_install::finish(&agent) {
                Ok(done) => {
                    audit(node, "finished an install of", &agent);
                    (200, done)
                }
                Err(text) => command_error(&text),
            },
            None => bad("agentId is required"),
        },
    })
}

#[cfg(test)]
#[path = "calls_install_tests.rs"]
mod tests;
