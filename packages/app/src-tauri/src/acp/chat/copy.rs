//! "Work on a copy": a chat that works in a separate copy of its project, so the project stays untouched until the
//! person says "Keep the changes". With git the copy is a worktree (the same code the terminal lane and
//! `review_worktree` use); without git it is a plain trial copy (`trial`). Nothing here names an agent.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::start::StartError;
use super::trial;
use crate::acp::conversations::Conversations;
use crate::acp::record::CopyLink;
use crate::pty::PaneRegistry;

pub const GIT: &str = "git";
pub const PLAIN: &str = "plain";

type Registry = Arc<Mutex<PaneRegistry>>;

/// A copy that was just made: the folder the chat starts in, and the link to remember.
pub use pm_core::hooks::ChatCopy as Made;

fn failed(message: impl Into<String>) -> StartError {
    StartError { code: "ACP_COPY_FAILED", message: message.into(), fallback: false }
}

/// Makes the copy of `project`. Git folders with a first commit get a worktree; other folders a plain copy.
pub fn make(project: &Path, store: &Path) -> Result<Made, StartError> {
    let handle = format!("chat-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let origin = project.to_string_lossy().into_owned();
    match crate::worktrees::folder::git_state(project) {
        "repo" => {
            let made = crate::worktrees::create(&origin, &handle).map_err(|e| failed(format!("The copy could not be made: {}", e.message)))?;
            Ok(Made { folder: PathBuf::from(&made.cwd), link: CopyLink { kind: GIT.into(), origin, handle, store: None } })
        }
        "folder" | "no_commits" => {
            let folder = trial::make(project, store, &handle).map_err(|e| failed(e.0))?;
            Ok(Made { folder, link: CopyLink { kind: PLAIN.into(), origin, handle, store: Some(store.to_string_lossy().into_owned()) } })
        }
        _ => Err(failed("This folder was not found, so no copy could be made.")),
    }
}

/// Where the plain copy of `link` lives.
fn store_of(link: &CopyLink) -> PathBuf {
    link.store.as_deref().map(PathBuf::from).unwrap_or_else(crate::app_paths::app_data_dir)
}

/// What the copy changed: `{kind, files, additions, deletions}`. `None` when the copy is gone.
pub fn summary(link: &CopyLink) -> Option<Value> {
    let store = &store_of(link);
    if link.kind == PLAIN {
        let changed = trial::changes(store, &link.handle)?;
        return Some(json!({ "kind": PLAIN, "files": changed.total(), "additions": null, "deletions": null }));
    }
    let worktree = crate::worktrees::find_by_handle(&link.origin, &link.handle).filter(|w| w.closed.is_none())?;
    let changes = crate::worktrees::changes(&worktree).ok()?;
    Some(json!({ "kind": GIT, "files": changes.files_changed, "additions": changes.additions, "deletions": changes.deletions }))
}

fn refusal(error: crate::operations::OperationError) -> String {
    let files = error.context.get("files").and_then(Value::as_array).map(|f| f.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).filter(|f| !f.is_empty());
    match files {
        Some(files) => format!("{}: {} ({files})", error.code, error.message),
        None => format!("{}: {}", error.code, error.message),
    }
}

/// "Keep the changes": brings the copy's work into the project and removes the copy (and the chat that sat in it).
/// `{kept: bool, files}`; `kept: false` means there was nothing to keep.
pub fn keep(link: &CopyLink, pane_id: &str, registry: &Registry) -> Result<Value, String> {
    // Fences first: a copy that changed a fenced file is not kept (nothing moves; the copy stays).
    if let Some(refusal) = fenced_refusal(link) {
        return Err(refusal);
    }
    let store = &store_of(link);
    if link.kind == PLAIN {
        let changed = trial::keep(store, &link.handle).map_err(|e| format!("COPY_KEEP_FAILED: {}", e.0))?;
        close_chat_pane(registry, pane_id);
        return Ok(json!({ "kept": changed.total() > 0, "files": changed.total() }));
    }
    let outcome = crate::worktrees::service::merge(Some(&link.origin), &link.handle, registry).map_err(refusal)?;
    Ok(json!({ "kept": outcome.merged, "files": outcome.files.len() }))
}

/// The files the copy changed, as paths below the project, or `None` when the copy cannot say.
fn changed_files(link: &CopyLink) -> Option<Vec<String>> {
    if link.kind == PLAIN {
        let changed = trial::changes(&store_of(link), &link.handle)?;
        return Some(changed.added.into_iter().chain(changed.modified).chain(changed.deleted).collect());
    }
    let worktree = crate::worktrees::find_by_handle(&link.origin, &link.handle).filter(|w| w.closed.is_none())?;
    let changes = crate::worktrees::changes(&worktree).ok()?;
    Some(changes.files.into_iter().map(|f| f.path).collect())
}

/// The sentence that refuses "Keep" because the copy changed files a fence covers (`agent_rules`), or `None`.
pub fn fenced_refusal(link: &CopyLink) -> Option<String> {
    let fences = crate::agent_rules::store().fences(&link.origin);
    if fences.is_empty() {
        return None;
    }
    let files = changed_files(link)?;
    let root = [PathBuf::from(&link.origin)];
    let hit: Vec<&String> = files.iter().filter(|f| crate::agent_rules::fence::covering(&fences, &root, f).is_some()).collect();
    if hit.is_empty() {
        return None;
    }
    crate::audit::record(
        crate::audit::Kind::AgentRules,
        crate::audit::Who::Desktop,
        "A fence stopped a copy from being kept",
        json!({ "event": "keep_refused", "files": hit.len() }),
    );
    let names: Vec<&str> = hit.iter().take(3).map(|f| f.as_str()).collect();
    let more = if hit.len() > 3 { format!(" and {} more", hit.len() - 3) } else { String::new() };
    Some(format!("FENCED: Nothing was kept. The copy changed fenced files: {}{more}. Throw the copy away, or take the fence off in Settings first.", names.join(", ")))
}

/// "Throw away the copy": removes it and the chat that sat in it. The project is not touched.
pub fn throw_away(link: &CopyLink, pane_id: &str, registry: &Registry) -> Result<(), String> {
    let store = &store_of(link);
    if link.kind == PLAIN {
        close_chat_pane(registry, pane_id);
        trial::discard(store, &link.handle);
        return Ok(());
    }
    crate::worktrees::service::discard(Some(&link.origin), &link.handle, registry).map_err(refusal)
}

fn close_chat_pane(registry: &Registry, pane_id: &str) {
    if registry.lock().panes.contains_key(pane_id) {
        let _ = crate::pty::registry_kill_pane_and_wait(registry, pane_id, Some("copy_closed"));
    }
}

/// The chat is gone: a copy it never changed goes with it. A copy with changes stays (the person decides).
pub fn release_if_pristine(link: &CopyLink) -> bool {
    let store = &store_of(link);
    if link.kind == PLAIN {
        return match trial::changes(store, &link.handle) {
            Some(changed) if changed.total() == 0 => {
                trial::discard(store, &link.handle);
                true
            }
            None => {
                trial::discard(store, &link.handle);
                true
            }
            _ => false,
        };
    }
    match crate::worktrees::find_by_handle(&link.origin, &link.handle).filter(|w| w.closed.is_none()) {
        Some(worktree) => crate::worktrees::discard_if_pristine(&worktree),
        None => false,
    }
}

/// After an app start: copies of closed chats that changed nothing are removed. Returns how many.
pub fn sweep_closed(conversations: &Conversations) -> usize {
    let mut removed = 0;
    for (id, link) in conversations.closed_with_copy() {
        if release_if_pristine(&link) {
            conversations.set_copy(&id, None);
            removed += 1;
        }
    }
    removed
}

/// The copy the chat `pane_id` works in, from the app's saved conversations.
pub fn link_of(pane_id: &str) -> Option<CopyLink> {
    crate::acp::conversations::global().copy_of(pane_id)
}
