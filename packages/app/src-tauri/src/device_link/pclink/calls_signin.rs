//! P2.2 sign-in rows of the far call table (`calls.rs`, block `---- P2.2 sign-in ----`): what is installed and signed in on THIS PC,
//! and the agent's own sign-in run here. Each row runs the same inner function as the Tauri command of that name; the far PC's window
//! and a paired PC's call cannot drift.
//!
//! A login never crosses: nothing here reads or returns a token or a credential file's contents. The answers are yes/no states, names,
//! and (through the existing terminal pane) the sign-in program's own screen. The sign-in's browser step is done by the person in their
//! own browser; the token is written on this PC by the agent itself.

use serde_json::{json, Value};

use super::calls::{arg, text_arg};
use crate::bridge::link_app_handles;

type Reply = (u16, Value);

fn bad(message: &str) -> Reply {
    (400, json!({ "code": "INVALID_ARGUMENT", "error": message }))
}

/// A Tauri command's `"CODE: sentence"` error as the PC link's `{ code, error }`.
fn command_error(text: &str) -> Reply {
    let (code, message) = match text.split_once(": ") {
        Some((code, message)) if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_') => (code, message),
        _ => ("COMMAND_FAILED", text),
    };
    let status = match code {
        "PANE_NOT_FOUND" => 404,
        "BUSY" | "ACP_BUSY" => 409,
        _ => 400,
    };
    (status, json!({ "code": code, "error": message }))
}

fn not_ready() -> Reply {
    (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" }))
}

/// One sign-in started by a paired PC, for the audit trail: which agent, never anything the sign-in prints.
fn audit_start(node: &str, what: &str) {
    crate::audit::record(
        crate::audit::Kind::Setting,
        crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))),
        &format!("A paired PC started the sign-in of an agent here ({what})"),
        json!({}),
    );
}

/// A found agent as the Tauri command lists it, with the program's path cut to its file name: a PC below Full never sees a path (1.2).
pub(crate) fn found_row(found: &crate::agent_store::detect::FoundAgent) -> Value {
    let mut row = serde_json::to_value(found).unwrap_or(Value::Null);
    let name = found.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    row["path"] = json!(name);
    row
}

// Starting a sign-in needs the app handle (it spawns a pane). A unit-test binary must not link that Tauri layer (STATUS_ENTRYPOINT_NOT_FOUND,
// REPO_MAP), so under test these two answer "not ready" and the real ones are proven in the app.
#[cfg(not(test))]
fn begin_agent(agent: &str) -> Result<Value, String> {
    let (app, registry) = link_app_handles().ok_or("BRIDGE_NOT_READY: The app is not ready yet.")?;
    crate::commands::chat_signin::start_for_agent(app, &registry, agent, None)
}
#[cfg(test)]
fn begin_agent(_: &str) -> Result<Value, String> {
    Err("BRIDGE_NOT_READY: The app is not ready yet.".into())
}
#[cfg(not(test))]
fn begin_chat(pane: &str) -> Result<Value, String> {
    let (app, registry) = link_app_handles().ok_or("BRIDGE_NOT_READY: The app is not ready yet.")?;
    crate::commands::chat_signin::start_for_chat(app, &registry, pane)
}
#[cfg(test)]
fn begin_chat(_: &str) -> Result<Value, String> {
    Err("BRIDGE_NOT_READY: The app is not ready yet.".into())
}

/// The calls whose arguments name no chat pane. `None`: not one of these.
pub fn agent_call(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    Some(match cmd {
        "agents_detect_installed" => {
            let found = crate::commands::agents_detect::found_here(text_arg(args, "projectDir").as_deref());
            (200, Value::Array(found.iter().map(found_row).collect()))
        }
        "agents_health" => (200, crate::commands::agents::agents_health()),
        "agent_login_states" => {
            let fresh = arg(args, "fresh").and_then(Value::as_bool).unwrap_or(false);
            (200, serde_json::to_value(crate::commands::usage::login_states(fresh)).unwrap_or(Value::Null))
        }
        "agent_signin_start" | "agent_signin_status" | "agent_signin_stop" => {
            let Some(agent) = text_arg(args, "agentId") else { return Some(bad("agentId is required")) };
            // Accounts are this PC's own and never listed to another PC: only the agent's normal login signs in from here.
            if text_arg(args, "accountId").is_some() {
                return Some(bad("accountId is not served"));
            }
            use crate::commands::chat_signin as sign;
            let Some((_, registry)) = link_app_handles() else { return Some(not_ready()) };
            match cmd {
                "agent_signin_start" => match begin_agent(&agent) {
                    Ok(started) => {
                        audit_start(node, &agent);
                        (200, started)
                    }
                    Err(text) => command_error(&text),
                },
                "agent_signin_status" => sign::status_for_agent(&registry, &agent, &None).map(|s| (200, s)).unwrap_or_else(|text| command_error(&text)),
                _ => {
                    sign::stop_for_agent(&agent, None);
                    (200, Value::Null)
                }
            }
        }
        _ => return None,
    })
}

/// The calls that name a chat pane (`pane`, already checked against that pane's own rule). `None`: not one of these.
pub fn pane_call(node: &str, cmd: &str, pane: &str) -> Option<Reply> {
    use crate::commands::chat_signin as sign;
    Some(match cmd {
        "acp_chat_retry_sign_in" => match crate::commands::acp_chat::retry_sign_in(pane) {
            Ok(()) => (200, Value::Null),
            Err(text) => command_error(&text),
        },
        "chat_signin_start" => {
            match begin_chat(pane) {
                Ok(started) => {
                    audit_start(node, "a chat's agent");
                    (200, started)
                }
                Err(text) => command_error(&text),
            }
        }
        "chat_signin_status" => {
            let Some((_, registry)) = link_app_handles() else { return Some(not_ready()) };
            sign::status_for_chat(&registry, pane).map(|s| (200, s)).unwrap_or_else(|text| command_error(&text))
        }
        "chat_signin_stop" => {
            sign::stop_for_chat(pane);
            (200, Value::Null)
        }
        _ => return None,
    })
}

#[cfg(test)]
#[path = "calls_signin_tests.rs"]
mod tests;
