//! P4.3: attach a picture or file to a chat on this PC from another PC, and start a chat on a separate copy. The rows are at the END of
//! `calls.rs` under `// ---- P4b ... ----`.
//!
//! - `attachment_save_pasted`: the other PC sends the BYTES (`attach::far::save_sent`, at most 20 MB, the door lets this one call carry
//!   them: `wire::body_max`); they land in the chat's own project (`.potato-workspace/attachments/`). The sender's idea of the name's
//!   folder, of the type and of the size is never used.
//! - `attachment_prepare`: paths on THIS PC only, and only inside the chat's project (`attach::far::prepare_inside`).
//! - `acp_chat_start`: starts a chat in one of this PC's known projects with this PC's own agent and sign-in (an account is never taken
//!   from the asker), on a separate copy when `separateCopy` is true. An older PC without this row answers 404, so the asking side never
//!   starts a chat in the project when it meant a copy.
//! - A message that names attachments (`pane_message_send`, `calls_chat.rs`) goes through [`vouch_all`]: each must lie inside the project.
//!
//! Every action leaves one audit line with a count, never a name, a path or a byte.

use serde_json::{json, Value};

use crate::attach::{far, ChatAttachment, MAX_ATTACHMENTS};

/// The rows of this block (`calls.rs`, `// ---- P4b attach and start ----`).
pub(super) fn mine(cmd: &str) -> bool {
    matches!(cmd, "attachment_prepare" | "attachment_save_pasted" | "acp_chat_start" | "attachment_preview")
}

/// The ids and counts one action leaves in the audit trail (never a name, a path or any text).
pub(super) fn audit_detail(event: &str, pane: Option<&str>, count: usize) -> Value {
    json!({ "event": event, "pane_id": pane, "count": count })
}

/// What a far message names, checked against the chat's folder: at most `MAX_ATTACHMENTS`, each inside `cwd`, described from the disk.
/// The first problem is the answer's `"CODE: sentence"`.
pub(super) fn vouch_all(wanted: &[ChatAttachment], cwd: &str) -> Result<Vec<ChatAttachment>, String> {
    if wanted.len() > MAX_ATTACHMENTS {
        return Err(format!("ATTACHMENT_TOO_MANY: at most {MAX_ATTACHMENTS} files go with one message."));
    }
    wanted.iter().map(|a| far::vouch(a, cwd)).collect()
}

#[cfg(not(test))]
mod real {
    use super::*;
    use crate::bridge::link_app_handles;

    use super::super::app_services::{bad, command_error, known_projects, not_ready, project_id, remote_refusal, Reply};
    use super::super::calls::{arg, text_arg};
    use super::super::calls_workflows::folder_with;

    fn clip(text: &str, max: usize) -> String {
        text.chars().take(max).collect()
    }

    fn audit(node: &str, summary: &str, detail: Value) {
        crate::audit::record(crate::audit::Kind::Setting, crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))), summary, detail);
    }

    /// The folder of a chat pane of this PC, or the refusal.
    pub(in crate::device_link::pclink) fn cwd_of(pane: &str) -> Result<String, Reply> {
        if let Some(refused) = remote_refusal(pane) {
            return Err(refused);
        }
        let Some((_, registry)) = link_app_handles() else { return Err(not_ready()) };
        let cwd = registry.lock().get(pane).map(|p| p.info.cwd.clone());
        cwd.filter(|c| !c.trim().is_empty()).ok_or_else(|| (404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(pane) })))
    }

    pub(in crate::device_link::pclink) fn run(node: &str, cmd: &str, args: &Value) -> Reply {
        match cmd {
            "attachment_prepare" => {
                let Some(pane) = text_arg(args, "paneId") else { return bad("INVALID_ARGUMENT", "paneId is required") };
                let paths: Vec<String> = arg(args, "paths").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|p| clip(p, 1024)).collect()).unwrap_or_default();
                let cwd = match cwd_of(&pane) {
                    Ok(cwd) => cwd,
                    Err(refused) => return refused,
                };
                match far::prepare_inside(&paths, &cwd) {
                    Ok(list) => {
                        audit(node, "A paired PC attached files to a chat", super::audit_detail("attach.prepare", Some(&pane), list.len()));
                        (200, serde_json::to_value(list).unwrap_or(Value::Null))
                    }
                    Err(text) => command_error(&text),
                }
            }
            // The thumbnail of a picture that lies inside the chat's own project (the sender's path means nothing here; a link that leads out is refused).
            "attachment_preview" => {
                let (Some(pane), Some(path)) = (text_arg(args, "paneId"), text_arg(args, "path")) else { return bad("INVALID_ARGUMENT", "paneId and path are required") };
                let cwd = match cwd_of(&pane) {
                    Ok(cwd) => cwd,
                    Err(refused) => return refused,
                };
                match far::preview_inside(&path, &cwd) {
                    Ok(url) => (200, json!(url)),
                    Err(text) => command_error(&text),
                }
            }
            "attachment_save_pasted" => {
                let Some(pane) = text_arg(args, "paneId") else { return bad("INVALID_ARGUMENT", "paneId is required") };
                let Some(data) = arg(args, "dataBase64").and_then(Value::as_str) else { return bad("INVALID_ARGUMENT", "dataBase64 is required") };
                let name = clip(arg(args, "name").and_then(Value::as_str).unwrap_or(""), 200);
                let mime = clip(arg(args, "mime").and_then(Value::as_str).unwrap_or(""), 100);
                let cwd = match cwd_of(&pane) {
                    Ok(cwd) => cwd,
                    Err(refused) => return refused,
                };
                match far::save_sent(&cwd, &name, &mime, data) {
                    Ok(saved) => {
                        audit(node, "A paired PC sent a file to a chat", super::audit_detail("attach.save", Some(&pane), 1));
                        (200, serde_json::to_value(saved).unwrap_or(Value::Null))
                    }
                    Err(text) => command_error(&text),
                }
            }
            "acp_chat_start" => {
                let Some((app, registry)) = link_app_handles() else { return not_ready() };
                let (Some(agent), Some(given)) = (text_arg(args, "agentId"), text_arg(args, "folder")) else { return bad("INVALID_ARGUMENT", "agentId and folder are required") };
                // Only a project this PC already knows (by id or path): the asker's own paths mean nothing here. No account: this PC's own sign-in.
                let Some(folder) = folder_with(&known_projects(&registry), &given, &project_id) else {
                    return (404, json!({ "code": "UNKNOWN_PROJECT", "error": "This PC does not know that project. Open it here first." }));
                };
                let copy = arg(args, "separateCopy").and_then(Value::as_bool).unwrap_or(false);
                let request = json!({ "agent": agent, "folder": folder, "lane": "acp" });
                let deps = crate::commands::acp_chat::live_deps(&app, &registry);
                // No sign-in named: when this PC's own login is signed out, the lend the caller made (as `agents/start` does), on a copy too.
                let account = crate::capacity_proxy::default_account(&agent, Some(node));
                let started = if copy { crate::acp::chat::api::start_copy_with_account(&request, &deps, account) } else { crate::acp::chat::api::start_with_account(&request, &deps, account) };
                match started {
                    Ok((status, reply)) => {
                        crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), &folder);
                        audit(node, if copy { "A paired PC started a chat on a separate copy" } else { "A paired PC started a chat" }, super::audit_detail("chat.start", reply["pane_id"].as_str(), usize::from(copy)));
                        (status, reply)
                    }
                    Err(refused) => refused,
                }
            }
            _ => (404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" })),
        }
    }
}

#[cfg(not(test))]
pub(super) use real::{cwd_of, run};

/// Unit tests never reach the app (see `calls_workflows.rs`): the real body is what the app runs; the pure parts above are tested.
#[cfg(test)]
pub(super) fn run(_node: &str, _cmd: &str, _args: &Value) -> (u16, Value) {
    (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" }))
}

#[cfg(test)]
pub(super) fn cwd_of(_pane: &str) -> Result<String, (u16, Value)> {
    Err((503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" })))
}
