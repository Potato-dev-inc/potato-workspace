//! P4a rows of the far call table (`calls.rs`, `// ---- P4a ... ----`): Ask aside, Hand off, Share (export), closed chats and chat
//! search, for a paired PC. Each row runs the same inner function as the Tauri command of that name (`side_question::side_target_of` /
//! `ask_blocking`, `handoff_file::*_of`, `chat_export::export_text`, `acp_conversations::*`, `session_chat::search_in`), so the far
//! chat does what this PC's own does and the text never leaves the machine that owns it.
//!
//! Levels: reads Watch; a side question runs the far PC's own agent, so Answer; everything that writes a file, reopens or deletes a
//! chat is Full and leaves one audit line (no text). Left out on purpose: `handoff_open_file` (opens a window on the far PC),
//! `chat_export_save` (this PC's Save dialog writes the bytes here, never the far disk) and `acp_delete_all_closed`.
//!
//! The reply of an export is `{ html }` or `{ markdown }`, with no token: a token would keep the page on the far PC. At most
//! [`EXPORT_MAX`] bytes travel. `chat_search` and the closed list only ever show chats this PC would let that PC see.

use serde_json::{json, Value};
use tauri::Manager;

use super::app_services::{bad, command_error, not_ready, remote_ok, Reply};
use super::calls::{arg, text_arg};
use crate::bridge::link_app_handles;

/// The most an exported chat may weigh to cross the link, in bytes (the Save dialog on the asking PC writes it; the cap says so).
pub const EXPORT_MAX: usize = 5 * 1024 * 1024;
/// The most hits one search answers.
const SEARCH_MAX: usize = 100;

/// The commands this block serves (the rows of `calls::TABLE` under `// ---- P4a`).
pub const P4A_ROWS: &[&str] = &[
    "side_question_target",
    "side_question_ask",
    "handoff_file_stat",
    "handoff_quick_prepare",
    "handoff_quick_append",
    "handoff_quick_archive",
    "handoff_pane_account",
    "chat_export_html",
    "chat_export_markdown",
    "acp_closed_list",
    "acp_reopen_closed",
    "acp_delete_closed",
    "chat_search",
    "chat_search_facets",
];

/// The rows that name a closed chat by `id` (not a pane by `paneId`) or no chat at all.
fn names_no_pane(cmd: &str) -> bool {
    matches!(cmd, "acp_closed_list" | "acp_reopen_closed" | "acp_delete_closed" | "chat_search" | "chat_search_facets")
}

fn done<T: serde::Serialize>(result: Result<T, String>) -> Reply {
    match result {
        Ok(value) => (200, serde_json::to_value(value).unwrap_or(Value::Null)),
        Err(error) => command_error(&error),
    }
}

/// One Full act of a paired PC for the audit trail: what and which chat, never any text.
fn audit(node: &str, pane: &str, what: &str) {
    crate::audit::record(
        crate::audit::Kind::Setting,
        crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))),
        &format!("A paired PC used one of your chats ({what})"),
        json!({ "pane_id": pane }),
    );
}

type Runner = fn(&str, &str, &Value) -> Option<Reply>;
static RUNNER: std::sync::OnceLock<Runner> = std::sync::OnceLock::new();

/// Puts the real implementation in place; the app's startup calls it once. The table reaches `run` only through this pointer, so a unit
/// test that calls `AppServices::call` does not link the live registry, chat and agent code (a test exe that does fails to load).
pub fn install() {
    let _ = RUNNER.set(run);
}

/// The call table's way in: `None` for a command that is not a row of this block.
pub fn dispatch(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    if !P4A_ROWS.contains(&cmd) {
        return None;
    }
    // A chat its own PC shut for other PCs is not served, by pane id or by closed-chat id.
    if let Some(id) = text_arg(args, if names_no_pane(cmd) { "id" } else { "paneId" }) {
        if !remote_ok(&id) {
            return Some((403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" })));
        }
    }
    Some(RUNNER.get().and_then(|run| run(node, cmd, args)).unwrap_or_else(not_ready))
}

fn run(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    let Some((app, registry)) = link_app_handles() else { return Some(not_ready()) };
    let full = args.get("_full").and_then(Value::as_bool).unwrap_or(false);
    if !names_no_pane(cmd) {
        let Some(pane) = text_arg(args, "paneId") else { return Some(bad("INVALID_ARGUMENT", "paneId is required")) };
        if registry.lock().get(&pane).is_none() {
            return Some((404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(&pane) })));
        }
        let folder = || crate::commands::handoff_file::folder_in(&registry, &pane);
        let stamp = text_arg(args, "stamp");
        return Some(match cmd {
            "side_question_target" => done(crate::commands::side_question::side_target_of(&registry, &pane)),
            "side_question_ask" => {
                let Some(request) = arg(args, "request").and_then(|r| serde_json::from_value::<crate::side_question::SideRequest>(r.clone()).ok()) else {
                    return Some(bad("INVALID_ARGUMENT", "request is required"));
                };
                audit(node, &pane, "ask aside");
                done(crate::commands::side_question::ask_blocking(app.clone(), registry.clone(), &pane, &request))
            }
            "handoff_file_stat" => done(crate::commands::handoff_file::stat_of(&folder(), stamp.as_deref())),
            "handoff_quick_prepare" => {
                let Some(stamp) = stamp else { return Some(bad("INVALID_ARGUMENT", "stamp is required")) };
                audit(node, &pane, "hand off");
                done(crate::commands::handoff_file::prepare_quick(std::path::Path::new(&folder()), &stamp))
            }
            "handoff_quick_append" => {
                let notes = arg(args, "notes").and_then(Value::as_str).unwrap_or_default();
                done(crate::commands::handoff_file::append_notes(std::path::Path::new(&folder()), stamp.as_deref(), notes))
            }
            "handoff_quick_archive" => {
                let Some(stamp) = stamp else { return Some(bad("INVALID_ARGUMENT", "stamp is required")) };
                done(crate::commands::handoff_file::archive_quick(std::path::Path::new(&folder()), &stamp, &crate::app_paths::app_data_dir()).map(|p| p.to_string_lossy().into_owned()))
            }
            "handoff_pane_account" => (200, json!(crate::commands::handoff_file::account_of(&registry, &pane))),
            _ => {
                // chat_export_html / chat_export_markdown
                let html = cmd == "chat_export_html";
                let turn = |key: &str| arg(args, key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                let range = crate::session_chat::export::TurnRange { from: turn("fromTurn"), to: turn("toTurn") };
                let watchers = app.state::<crate::commands::SessionChatState>().watchers(&app, &registry);
                match crate::commands::chat_export::export_text(&watchers, &registry, &pane, html, range, None) {
                    Ok(text) if text.len() > EXPORT_MAX => (413, json!({ "code": "TOO_BIG", "error": "This chat is too big to send to another PC. Pick fewer turns." })),
                    Ok(text) => (200, if html { json!({ "html": text }) } else { json!({ "markdown": text }) }),
                    Err(error) => command_error(&error),
                }
            }
        });
    }
    Some(match cmd {
        "acp_closed_list" => (200, closed_rows(crate::commands::acp_closed_list(), full)),
        "acp_reopen_closed" | "acp_delete_closed" => {
            let Some(id) = text_arg(args, "id") else { return Some(bad("INVALID_ARGUMENT", "id is required")) };
            let (reply, what) = if cmd == "acp_reopen_closed" {
                (done(crate::commands::acp_conversations::reopen_closed_blocking(&app, &registry, id.clone())), "reopen a closed chat")
            } else {
                (done(crate::commands::acp_conversations::delete_closed_of(&app, &id)), "delete a closed chat")
            };
            if reply.0 == 200 {
                audit(node, &id, what);
            }
            reply
        }
        "chat_search" => {
            let query = arg(args, "query").and_then(Value::as_str).unwrap_or_default();
            let limit = arg(args, "limit").and_then(Value::as_u64).map(|n| (n as usize).min(SEARCH_MAX));
            let filters = arg(args, "filters").filter(|f| !f.is_null()).and_then(|f| serde_json::from_value(f.clone()).ok());
            let index = app.state::<crate::commands::SessionChatState>().index(&registry);
            match crate::commands::session_chat::search_in(index, query, limit, filters) {
                Ok(answer) => (200, searched(serde_json::to_value(answer).unwrap_or(Value::Null))),
                Err(error) => command_error(&error),
            }
        }
        _ => {
            let index = app.state::<crate::commands::SessionChatState>().index(&registry);
            done(crate::commands::session_chat::facets_in(index))
        }
    })
}

/// The closed chats this PC would let that PC see, each with its folder's name in place of its path unless the asker is at Full.
pub(crate) fn closed_rows(list: Value, full: bool) -> Value {
    pm_core::device_link::pclink::engine_services::closed_rows(&super::app_services::AppChatEnv, list, full)
}

/// A search answer without the hits of chats this PC keeps from other PCs.
pub(crate) fn searched(mut out: Value) -> Value {
    if let Some(hits) = out.get_mut("hits").and_then(Value::as_array_mut) {
        // An imported chat is an old one the person read in; it has no live pane and stays on the PC it was read on.
        hits.retain(|hit| hit["imported"] != json!(true) && hit["paneId"].as_str().is_some_and(remote_ok));
    }
    out
}
