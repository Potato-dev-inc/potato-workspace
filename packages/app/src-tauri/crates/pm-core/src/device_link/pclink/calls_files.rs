//! The file and git rows of the far call table that work on one project folder alone (`files_*`, `project_files_search`,
//! `pane_git_branch`). The app finds the folder from the chat's pane; the host finds it from its project list
//! (`potato-host/src/services/files.rs`). Both then run these same functions, so a far PC gets one behaviour from either.
//! The folder is never a path the asker sends: a chat's own folder, or a project id this machine knows.
//! Inside it the existing checks apply (`files::resolve_in_root`: no `..`, no link that leads out).

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use super::calls::text_arg;
use crate::audit::{self, Kind, Who};

pub type Reply = (u16, Value);

/// The PC link's refusal for a bad request.
pub fn bad(code: &str, message: &str) -> Reply {
    (400, json!({ "code": code, "error": message }))
}

/// A Tauri command's `"CODE: sentence"` error as the PC link's `{ code, error }` with a status.
pub fn command_error(text: &str) -> Reply {
    let (code, message) = match text.split_once(": ") {
        Some((code, message)) if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_') => (code, message),
        _ => ("COMMAND_FAILED", text),
    };
    let status = match code {
        "PANE_NOT_FOUND" => 404,
        "BUSY" | "ACP_BUSY" => 409,
        "ACP_CONFIG_FAILED" => 502,
        _ => 400,
    };
    (status, json!({ "code": code, "error": message }))
}

pub fn ok<T: Serialize>(value: T) -> Reply {
    match serde_json::to_value(value) {
        Ok(v) => (200, v),
        Err(e) => command_error(&format!("INTERNAL: {e}")),
    }
}

pub fn done<T: Serialize>(result: Result<T, String>) -> Reply {
    result.map_or_else(|text| command_error(&text), ok)
}

pub fn text_of(args: &Value, key: &str) -> Result<String, Reply> {
    super::calls::arg(args, key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| bad("INVALID_ARGUMENT", &format!("{key} is required")))
}

/// The link id a device has in the audit trail (the same form the app's rights mirror uses).
pub fn link_device_id(node_hex: &str) -> String {
    format!("link:{node_hex}")
}

/// Whether `cmd` is one of the rows `project_row` serves.
pub fn is_project_row(cmd: &str) -> bool {
    matches!(
        cmd,
        "files_list" | "files_read" | "files_read_bytes" | "files_marks" | "files_diff" | "files_search_contents" | "files_write" | "project_files_search" | "pane_git_branch"
    )
}

/// `files_search_cancel`: stops a search by its id. It needs no folder, so the caller may run it before finding one.
pub fn cancel_search(args: &Value) -> Reply {
    match text_arg(args, "searchId") {
        Some(id) => {
            crate::files::cancel_search(&id);
            (200, Value::Null)
        }
        None => bad("INVALID_ARGUMENT", "searchId is required"),
    }
}

/// The rows that work on one folder. `root` is the chat's own folder (app) or the project's folder (host). None: not one of these rows.
pub fn in_root(root: &str, cmd: &str, args: &Value) -> Option<Reply> {
    use crate::files;
    let path = || text_of(args, "path");
    macro_rules! need {
        ($e:expr) => {
            match $e {
                Ok(v) => v,
                Err(reply) => return Some(reply),
            }
        };
    }
    Some(match cmd {
        "files_list" => done(files::list_dir(root, &super::calls::arg(args, "path").and_then(Value::as_str).unwrap_or(""), super::calls::arg(args, "showHeavy").and_then(Value::as_bool).unwrap_or(false))),
        "files_read" => done(files::read_file(root, &need!(path()))),
        "files_read_bytes" => done(files::read_bytes(root, &need!(path()))),
        "files_marks" => ok(files::marks(root)),
        "files_diff" => done(files::diff(root, &need!(path()))),
        "files_write" => {
            let text = need!(text_of(args, "text"));
            let overwrite = super::calls::arg(args, "overwrite").and_then(Value::as_bool).unwrap_or(false);
            done(files::write_file(root, &need!(path()), &text, text_arg(args, "baseVersion").as_deref(), overwrite))
        }
        "files_search_contents" => {
            let (query, id) = (need!(text_of(args, "query")), need!(text_of(args, "searchId")));
            let flag = files::begin_search(&id);
            let found = files::search_contents(root, text_arg(args, "folder").as_deref(), &query, &flag);
            files::end_search(&id, &flag);
            done(found)
        }
        "project_files_search" => {
            let limit = super::calls::arg(args, "limit").and_then(Value::as_u64).map(|n| n as usize);
            ok(crate::attach::search::search(root, &super::calls::arg(args, "query").and_then(Value::as_str).unwrap_or(""), limit))
        }
        "pane_git_branch" => ok(crate::files::git::branch_of(Path::new(root))),
        _ => return None,
    })
}

/// One Full change on this PC, for the audit trail: which command, the chat or project id, and the file's name inside the project,
/// never its text.
pub fn record_change(node: &str, cmd: &str, pane: &str, path: Option<&str>) {
    let summary = match cmd {
        "worktree_merge" => "A paired PC kept a chat's separate copy (merged it into the project)",
        "worktree_discard" => "A paired PC threw away a chat's separate copy",
        "files_write" => "A paired PC saved a file in a project",
        "checkpoint_put_back" => "A paired PC put one file back",
        "checkpoint_restore" => "A paired PC restored a project to a checkpoint",
        _ => "A paired PC undid an agent's last turn",
    };
    let detail = json!({ "event": cmd, "pane_id": pane, "path": path });
    audit::record(Kind::Setting, Who::Device(Some(link_device_id(node))), summary, detail);
}
