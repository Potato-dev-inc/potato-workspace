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

use super::app_services::{bad, command_error, not_ready, remote_refusal, Reply};
use pm_core::device_link::pclink::engine_services as engine;
use super::calls::text_arg;
use crate::bridge::link_app_handles;

/// The answer of a command that returns a value, or its `"CODE: sentence"` error.
fn done<T: serde::Serialize>(result: Result<T, String>) -> Reply {
    match result {
        Ok(value) => (200, serde_json::to_value(value).unwrap_or(Value::Null)),
        Err(error) => command_error(&error),
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
    pm_core::device_link::pclink::engine_services::gate(cmd, args)
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
    // The rows that need no window (Stop, the message box, the chat's switches, "show earlier") are the shared copy.
    if let Some(reply) = engine::chat_screen_row(&super::app_services::AppChatEnv, node, cmd, args) {
        return Some(reply);
    }
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
        "chat_picture" => {
            let Some(path) = text_arg(args, "path") else { return Some(bad("INVALID_ARGUMENT", "path is required")) };
            let Some(cwd) = registry.lock().get(&pane).map(|p| p.info.cwd.clone()) else {
                return Some((404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(&pane) })));
            };
            // The picture rides in one answer: the phone's smaller cap, not the window's.
            done(crate::commands::chat_picture_of(&cwd, &path, crate::session_chat::picture::PHONE_MAX_BYTES))
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
