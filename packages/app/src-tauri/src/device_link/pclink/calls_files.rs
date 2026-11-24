//! P5: the files, git, checkpoint, artifact and usage rows of the far call table (`calls.rs`, block `P5`). Each runs the SAME inner function
//! the Tauri command runs (`files::*`, `checkpoints::live()`, `artifacts::*`, `budgets::usage_of_pane`) on this PC, for the folder of the chat
//! the call names.
//!
//! The folder is the chat's own (its working directory in the pane registry): never a path the asker sends. A chat that is not in the
//! registry, or that lives on another computer, is refused: unlike the window's own commands, nothing falls back to "the default project".
//! Inside it the existing checks apply (`files::resolve_in_root`: no `..`, no link that leads out; `checkpoints`: no `..`, no backslash).
//! Reads of folder contents are Full (`calls.rs`); a save, a put back and an undo are Full and leave one audit line with no file text.

use serde_json::{json, Value};

pub(super) use pm_core::device_link::pclink::calls_files::in_root;
use pm_core::device_link::pclink::calls_files::text_of;
#[cfg(not(test))]
use pm_core::device_link::pclink::calls_files::{done, ok};

use super::app_services::{bad, Reply};

/// Whether `cmd` is a row of this block that `run` serves (the table says which of them exist; the usage and preview rows are the app services').
pub(super) fn mine(cmd: &str) -> bool {
    cmd.starts_with("files_")
        || cmd.starts_with("checkpoint")
        || matches!(cmd, "project_files_search" | "pane_git_branch" | "artifacts_read" | "artifacts_sync" | "pane_usage" | "pane_open_bundle" | "pane_worktree" | "worktree_diff" | "worktree_merge" | "worktree_discard")
}

/// The rows `pane_open_bundle` runs for a chat that has just opened, each only when the asker's own level allows that row (the same levels as
/// `calls::TABLE`): the bundle never gives a Watch or Answer asker what its part would refuse them. A part that fails is left out (the asker
/// then makes that one call itself and sees its own refusal).
pub(super) fn bundle_parts(full: bool, answer: bool) -> Vec<&'static str> {
    let mut parts = vec!["pane_usage"];
    if answer {
        parts.push("artifacts_sync");
    }
    if full {
        parts.extend(["pane_git_branch", "pane_worktree", "checkpoints_list"]);
    }
    parts
}

/// A worktree row may only act on the copy THIS chat works in: `own` is the handle of that copy (none: the chat is not on a copy), `given` the one the
/// asker named. The project the copy belongs to is always the copy's own, never anything the asker sends.
pub(super) fn own_handle(own: Option<&str>, given: &str) -> Result<(), Reply> {
    match own {
        Some(handle) if !handle.is_empty() && handle == given => Ok(()),
        Some(_) => Err((404, json!({ "code": "UNKNOWN_WORKTREE", "error": "That is not the copy this chat works in." }))),
        None => Err((404, json!({ "code": "UNKNOWN_WORKTREE", "error": "This chat is not working on a separate copy." }))),
    }
}

/// The path of a checkpoint row, which may only be a plain relative path of the project (the engine checks again).
pub(super) fn clean_path(args: &Value) -> Result<String, Reply> {
    let path = text_of(args, "path")?;
    crate::checkpoints::engine::safe_relative(&path).filter(|_| !path.contains('\\')).map(|_| path).ok_or_else(|| bad("INVALID_ARGUMENT", "That file name is not allowed."))
}

/// What one artifact page shows another PC: a path of this PC's disk (the page's own file, the loose file it follows) travels only at Full.
pub(super) fn artifact_page(mut page: Value, full: bool) -> Value {
    if !full {
        page["path"] = json!("");
        if let Some(artifact) = page.get_mut("artifact").and_then(Value::as_object_mut) {
            artifact.remove("source");
            artifact.remove("share");
        }
    }
    page
}

/// The list of pages, with the same scrub.
pub(super) fn artifact_list(mut list: Value, full: bool) -> Value {
    if !full {
        for item in list.as_array_mut().into_iter().flatten().filter_map(Value::as_object_mut) {
            item.remove("source");
            item.remove("share");
        }
    }
    list
}

/// A helper's account label is the person's own on that PC: below Full it does not travel.
pub(super) fn usage_view(mut usage: Value, full: bool) -> Value {
    if !full {
        for helper in usage.get_mut("helpers").and_then(Value::as_array_mut).into_iter().flatten() {
            helper["accountLabel"] = Value::Null;
        }
    }
    usage
}

/// The ids one Full change leaves in the audit trail: the chat and the file's name inside the project, never its text.
#[cfg(test)]
pub(super) fn audit_detail(cmd: &str, pane: &str, path: Option<&str>) -> Value {
    json!({ "event": cmd, "pane_id": pane, "path": path })
}

#[cfg(not(test))]
mod real {
    use serde_json::{json, Value};
    use tauri::Manager;

    use super::super::app_services::{bad, command_error, not_ready, remote_refusal, Reply};
    use super::super::calls::{arg, text_arg};
    use super::{artifact_list, artifact_page, clean_path, done, in_root, ok, usage_view};
    use crate::bridge::link_app_handles;

    fn audit(node: &str, cmd: &str, pane: &str, path: Option<&str>) {
        pm_core::device_link::pclink::calls_files::record_change(node, cmd, pane, path);
    }

    /// The working folder of a chat that lives on this PC; a chat that is not open here has no folder (no fall-back to a default project).
    fn folder_of(registry: &parking_lot::Mutex<crate::pty::PaneRegistry>, pane: &str) -> Result<String, Reply> {
        if let Some(refused) = remote_refusal(pane) {
            return Err(refused);
        }
        let cwd = registry.lock().get(pane).map(|p| p.info.cwd.clone()).filter(|c| !c.trim().is_empty());
        cwd.ok_or_else(|| (404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(pane) })))
    }

    pub(in crate::device_link::pclink) fn run(node: &str, cmd: &str, args: &Value) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        if cmd == "files_search_cancel" {
            return match text_arg(args, "searchId") {
                Some(id) => {
                    crate::files::cancel_search(&id);
                    (200, Value::Null)
                }
                None => bad("INVALID_ARGUMENT", "searchId is required"),
            };
        }
        let Some(pane) = text_arg(args, "paneId") else { return bad("INVALID_ARGUMENT", "paneId is required") };
        let root = match folder_of(&registry, &pane) {
            Ok(root) => root,
            Err(reply) => return reply,
        };
        if cmd == "pane_open_bundle" {
            let level = |key: &str| args.get(key).and_then(Value::as_bool).unwrap_or(false);
            let mut parts = serde_json::Map::new();
            for part in super::bundle_parts(level("_full"), level("_answer")) {
                let (status, body) = run(node, part, args);
                if status == 200 {
                    parts.insert(part.to_string(), body);
                }
            }
            return (200, json!({ "parts": parts }));
        }
        if let Some(reply) = in_root(&root, cmd, args) {
            if cmd == "files_write" && reply.0 == 200 {
                audit(node, cmd, &pane, text_arg(args, "path").as_deref());
            }
            return reply;
        }
        let full = args.get("_full").and_then(Value::as_bool).unwrap_or(false);
        let project = std::path::Path::new(&root);
        let checkpoints = crate::checkpoints::live();
        match cmd {
            "checkpoints_list" => done(crate::checkpoints::list_view(&pane)),
            "checkpoint_diff" => match text_arg(args, "id") {
                Some(id) => done(checkpoints.diff(&pane, &id).map_err(|e| e.to_string())),
                None => bad("INVALID_ARGUMENT", "id is required"),
            },
            "checkpoint_turn_review" => done(checkpoints.turn_review(&pane).map_err(|e| e.to_string())),
            "checkpoint_file_patch" => match (text_arg(args, "fromId"), text_arg(args, "toId"), clean_path(args)) {
                (Some(from), Some(to), Ok(path)) => done(checkpoints.file_patch(&pane, &from, &to, &path).map_err(|e| e.to_string())),
                (_, _, Err(reply)) => reply,
                _ => bad("INVALID_ARGUMENT", "fromId, toId and path are required"),
            },
            "checkpoint_put_back" => match (text_arg(args, "beforeId"), clean_path(args)) {
                (Some(before), Ok(path)) => {
                    let out = checkpoints.put_back(&pane, &before, &path).map_err(|e| e.to_string());
                    if out.is_ok() {
                        audit(node, cmd, &pane, Some(&path));
                    }
                    done(out)
                }
                (_, Err(reply)) => reply,
                _ => bad("INVALID_ARGUMENT", "beforeId and path are required"),
            },
            "checkpoint_restore" => match text_arg(args, "id") {
                Some(id) => {
                    let out = checkpoints.restore(&pane, &id).map_err(|e| e.to_string());
                    if out.is_ok() {
                        audit(node, cmd, &pane, None);
                    }
                    done(out)
                }
                None => bad("INVALID_ARGUMENT", "id is required"),
            },
            "checkpoint_undo_last" => {
                let out = checkpoints.undo_last_turn(&pane).map_err(|e| match e {
                    crate::checkpoints::CheckpointError::NotFound => "There's nothing to undo yet.".to_string(),
                    other => other.to_string(),
                });
                if out.is_ok() {
                    audit(node, cmd, &pane, None);
                }
                done(out)
            }
            "pane_worktree" => ok(crate::worktrees::service::for_pane(&registry, &pane)),
            "worktree_diff" | "worktree_merge" | "worktree_discard" => {
                use tauri::Emitter;
                use crate::worktrees::service;
                let Some(handle) = text_arg(args, "handle") else { return bad("INVALID_ARGUMENT", "handle is required") };
                let found = service::for_pane(&registry, &pane);
                if let Err(refused) = super::own_handle(found.as_ref().map(|item| item.entry.worktree.handle.as_str()), &handle) {
                    return refused;
                }
                let repo = found.map(|item| item.entry.worktree.repo).unwrap_or_default();
                let repo = Some(repo.as_str());
                let to_text = crate::commands::text;
                let out = match cmd {
                    "worktree_diff" => service::diff(repo, &handle, text_arg(args, "path").as_deref(), &registry).map(|view| serde_json::to_value(view).unwrap_or(Value::Null)).map_err(to_text),
                    "worktree_merge" => service::merge(repo, &handle, &registry).map(|outcome| serde_json::to_value(outcome).unwrap_or(Value::Null)).map_err(to_text),
                    _ => service::discard(repo, &handle, &registry).map(|()| Value::Null).map_err(to_text),
                };
                if cmd != "worktree_diff" {
                    // The same two events the window's own command sends, so this PC's own screens catch up.
                    let _ = app.emit("worktree://changed", ());
                    let _ = app.emit("pty://panes-changed", ());
                    if out.is_ok() {
                        audit(node, cmd, &pane, None);
                    }
                }
                done(out)
            }
            "artifacts_sync" => {
                crate::artifacts::announce_folder(project, &pane);
                ok(artifact_list(serde_json::to_value(crate::artifacts::list(project)).unwrap_or(Value::Null), full))
            }
            "artifacts_read" => match text_arg(args, "id") {
                Some(id) => {
                    let version = arg(args, "version").and_then(Value::as_u64).map(|v| v as u32);
                    let page = crate::artifacts::read(project, &id, version).map_err(|e| e.to_string()).and_then(|page| {
                        let file = crate::artifacts::file_of(project, &id, Some(page.version)).map_err(|e| e.to_string())?;
                        Ok(json!({ "artifact": page.artifact, "version": page.version, "content": page.content, "path": file.to_string_lossy().trim_start_matches(r"\\?\") }))
                    });
                    page.map_or_else(|text| command_error(&text), |page| (200, artifact_page(page, full)))
                }
                None => bad("INVALID_ARGUMENT", "id is required"),
            },
            "pane_usage" => {
                let watchers = app.state::<crate::commands::SessionChatState>().existing();
                let usage = crate::budgets::usage_of_pane(&registry, watchers.as_deref(), &pane);
                (200, usage_view(serde_json::to_value(usage).unwrap_or(Value::Null), full))
            }
            _ => (404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" })),
        }
    }
}

#[cfg(not(test))]
pub(super) use real::run;

/// Unit tests never reach the app (a test exe that links the window layer does not start): the tests call `in_root` and the scrubs directly.
#[cfg(test)]
pub(super) fn run(_node: &str, _cmd: &str, _args: &Value) -> Reply {
    (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" }))
}
