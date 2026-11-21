//! The chat feed rows of the far call table (P1.7): open and close a chat's feed, "Show earlier", a picture, Stop, the message box
//! (send, cancel, hold, edit, list) and the chat's own switches. Each row runs the same inner function as the Tauri command of that
//! name (`commands::session_chat`, `chat_more`, `acp_chat`, `pane_outbox`), and its level is in `calls.rs` (reads Watch, send and
//! stop Answer, anything that lets the agent act without asking or changes its settings Full).
//!
//! The press and hold: turning ON a switch that lets the agent act without asking needs `hold: true` from a PC that does not carry
//! the account marker; a marked PC (the person's own) is not asked (`_marked`, set by `pclink::handle` and never read from the asker).
//! The items and status of an open feed come back as `app` frames (`events.rs`), not as answers.

use serde_json::{json, Value};
use tauri::Manager;

use super::app_services::{audit_call, bad, command_error, needs_hold_reply, not_ready, remote_refusal, Reply};
use super::calls::{arg, text_arg};
use crate::bridge::link_app_handles;

fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn failed(error: String) -> Reply {
    command_error(&error)
}

/// The answer of a command that returns a value, or its `"CODE: sentence"` error.
fn done<T: serde::Serialize>(result: Result<T, String>) -> Reply {
    match result {
        Ok(value) => (200, serde_json::to_value(value).unwrap_or(Value::Null)),
        Err(error) => failed(error),
    }
}

/// A message of the outbox as it leaves this PC (its text redacted), or the refusal.
fn message(result: Result<crate::pane_outbox::OutboxMessage, String>, code: &str) -> Reply {
    match result {
        Ok(m) => (200, serde_json::to_value(crate::pane_outbox::redacted(&m)).unwrap_or(Value::Null)),
        Err(error) => (409, json!({ "code": code, "error": error })),
    }
}

/// The far surfaces that hold a feed open on this PC, as `(pane, holder)`. The window's feed events go out as `app` frames only while
/// one is open for that pane, so a chat nobody watches from afar adds nothing to the shared event log.
static WATCHING: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// Whether a paired PC holds the feed of `pane` open.
pub fn watching(pane: &str) -> bool {
    WATCHING.lock().is_ok_and(|w| w.iter().any(|(p, _)| p == pane))
}

pub(crate) fn watch(pane: &str, holder: &str, on: bool) {
    if let Ok(mut w) = WATCHING.lock() {
        w.retain(|(p, h)| !(p == pane && h == holder));
        if on {
            w.push((pane.to_string(), holder.to_string()));
        }
    }
}

/// The holder of one far surface on this PC's reader: the asking PC and its own surface id, so one PC never lets go of another's.
pub(crate) fn holder_of(node: &str, args: &Value) -> String {
    let surface: String = text_arg(args, "surface").unwrap_or_default().chars().take(64).collect();
    format!("pclink:{node}#{surface}")
}

/// The press-and-hold rule, before anything runs: turning ON a switch that lets the agent act without asking (Force yes, "don't ask
/// again", agents answering for the person) needs `hold: true` from the asker, unless it is the person's own PC (`_marked`).
/// `Some`: the refusal. (Force yes and the permission mode are `app_services.rs`'s rows; they use the same two keys.)
pub fn gate(cmd: &str, args: &Value) -> Option<Reply> {
    let on = match cmd {
        "acp_chat_set_auto_allow" => arg(args, "on").and_then(Value::as_bool),
        "acp_chat_set_agent_answering" => arg(args, "allowed").and_then(Value::as_bool),
        _ => return None,
    };
    match on {
        None => Some(bad("INVALID_ARGUMENT", if cmd == "acp_chat_set_auto_allow" { "kind and on are required" } else { "allowed is required" })),
        Some(true) if !(flag(args, "hold") || flag(args, "_marked")) => Some(needs_hold_reply()),
        Some(_) => None,
    }
}

type Runner = fn(&str, &str, &Value) -> Option<Reply>;
static RUNNER: std::sync::OnceLock<Runner> = std::sync::OnceLock::new();

/// Puts the real implementation in place; the app's startup calls it once. The call table reaches `run` only through this pointer, so a
/// unit test that calls `AppServices::call` does not link the live outbox and terminal code (a test exe that does fails to load).
pub fn install() {
    let _ = RUNNER.set(run);
}

/// The call table's way in: `None` for a command that is not a row of this block (or before `install`).
pub fn dispatch(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    if !CHAT_ROWS.contains(&cmd) {
        return None;
    }
    // The press-and-hold rule and the arguments are checked here, where a test can reach them.
    if let Some(refused) = text_arg(args, "paneId").and_then(|pane| remote_refusal(&pane)) {
        return Some(refused);
    }
    if let Some(refused) = gate(cmd, args) {
        return Some(refused);
    }
    RUNNER.get().and_then(|run| run(node, cmd, args))
}

fn run(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    let Some(pane) = text_arg(args, "paneId") else { return Some(bad("INVALID_ARGUMENT", "paneId is required")) };
    let Some((app, registry)) = link_app_handles() else { return Some(not_ready()) };
    Some(match cmd {
        "session_chat_open" => {
            let watchers = app.state::<crate::commands::SessionChatState>().watchers(&app, &registry);
            let holder = holder_of(node, args);
            match crate::commands::open_chat_feed(&watchers, &registry, &pane, &holder) {
                Ok(opened) => {
                    watch(&pane, &holder, true);
                    (200, crate::redact::json(serde_json::to_value(opened).unwrap_or(Value::Null)).into_inner())
                }
                Err(error) => (404, json!({ "code": "UNKNOWN_SESSION", "error": error })),
            }
        }
        "session_chat_close" => {
            let holder = holder_of(node, args);
            watch(&pane, &holder, false);
            crate::commands::close_chat_feed(&app.state::<crate::commands::SessionChatState>(), &pane, &holder);
            (200, Value::Null)
        }
        "chat_earlier" => {
            let Some(before) = text_arg(args, "before") else { return Some(bad("INVALID_ARGUMENT", "before is required")) };
            if registry.lock().get(&pane).is_none() {
                return Some((404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(&pane) })));
            }
            let limit = arg(args, "limit").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(crate::session_chat::earlier::DEFAULT_PAGE);
            (200, crate::redact::json(crate::session_chat::earlier::for_pane(&pane, &before, limit, false)).into_inner())
        }
        "chat_picture" => {
            let Some(path) = text_arg(args, "path") else { return Some(bad("INVALID_ARGUMENT", "path is required")) };
            let Some(cwd) = registry.lock().get(&pane).map(|p| p.info.cwd.clone()) else {
                return Some((404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(&pane) })));
            };
            // The picture rides in one answer: the phone's smaller cap, not the window's.
            done(crate::commands::chat_picture_of(&cwd, &path, crate::session_chat::picture::PHONE_MAX_BYTES))
        }
        "acp_chat_cancel" => done(crate::commands::acp_chat::chat_cancel(&pane)),
        "acp_chat_keep_waiting" => done(crate::commands::acp_chat::chat_keep_waiting(&pane)),
        "acp_chat_warm" => {
            crate::commands::acp_chat::chat_warm(&pane);
            (200, Value::Null)
        }
        "acp_chat_take_back" => {
            let reply = done(crate::commands::acp_chat::chat_take_back(&pane));
            if reply.0 == 200 {
                audit_call(node, &pane, "take back", false);
            }
            reply
        }
        "acp_chat_set_auto_allow" => {
            let (Some(kind), Some(on)) = (text_arg(args, "kind"), arg(args, "on").and_then(Value::as_bool)) else {
                return Some(bad("INVALID_ARGUMENT", "kind and on are required"));
            };
            let reply = done(crate::commands::acp_chat::chat_set_auto_allow(&pane, &kind, on));
            if reply.0 == 200 {
                audit_call(node, &pane, "auto-allow", on && flag(args, "hold"));
            }
            reply
        }
        "acp_chat_set_agent_answering" => {
            let Some(allowed) = arg(args, "allowed").and_then(Value::as_bool) else { return Some(bad("INVALID_ARGUMENT", "allowed is required")) };
            let reply = done(crate::commands::acp_chat::chat_set_agent_answering(&pane, allowed));
            if reply.0 == 200 {
                audit_call(node, &pane, "agent answering", allowed && flag(args, "hold"));
            }
            reply
        }
        "pane_message_send" => {
            let Some(text) = arg(args, "text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) else { return Some(bad("INVALID_ARGUMENT", "text is required")) };
            // A file named here would be a path on the asking PC: files travel with the attach rows, not with a message.
            if arg(args, "attachments").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                return Some(bad("ATTACHMENTS_NOT_YET", "Attaching a file to a chat on another PC is not possible yet."));
            }
            let (status, body) = super::app_services::send_message(node, &pane, text, flag(args, "_full"));
            (status, if status == 200 { body["message"].clone() } else { body })
        }
        "pane_message_cancel" | "pane_message_hold" | "pane_message_edit" => {
            let Some(id) = text_arg(args, "messageId") else { return Some(bad("INVALID_ARGUMENT", "messageId is required")) };
            let outbox = crate::pane_outbox::global(&registry, &app);
            match cmd {
                "pane_message_cancel" => message(outbox.cancel(&pane, &id), "MESSAGE_NOT_CANCELLABLE"),
                "pane_message_hold" => match arg(args, "hold").and_then(Value::as_bool) {
                    Some(hold) => message(outbox.hold(&pane, &id, hold), "MESSAGE_NOT_HELD"),
                    None => bad("INVALID_ARGUMENT", "hold is required"),
                },
                _ => match arg(args, "text").and_then(Value::as_str) {
                    Some(text) => message(outbox.edit(&pane, &id, text), "MESSAGE_NOT_EDITABLE"),
                    None => bad("INVALID_ARGUMENT", "text is required"),
                },
            }
        }
        "pane_messages_list" => {
            let (status, body) = super::app_services::outbox_list(&pane);
            (status, if status == 200 { body["messages"].clone() } else { body })
        }
        _ => return None,
    })
}

/// The commands this block serves (the rows of `calls::TABLE` under `// ---- P1.7 chat feed ----`).
pub const CHAT_ROWS: &[&str] = &[
    "session_chat_open",
    "session_chat_close",
    "chat_earlier",
    "chat_picture",
    "acp_chat_cancel",
    "pane_message_send",
    "pane_message_cancel",
    "pane_message_hold",
    "pane_message_edit",
    "pane_messages_list",
    "acp_chat_keep_waiting",
    "acp_chat_take_back",
    "acp_chat_set_auto_allow",
    "acp_chat_set_agent_answering",
    "acp_chat_warm",
];
