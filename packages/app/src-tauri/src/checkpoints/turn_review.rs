//! File-by-file review of the latest finished turn: which files it changed, and "Put back" for one of them.
//!
//! Put back returns ONE file to the state it had at the start of the turn (the checkpoint taken before it).
//! It only ever touches a path that differs between that checkpoint and the disk right now, always inside the
//! project folder, and it saves the current files as a checkpoint first, so Put back can itself be undone
//! (the undo bar puts the file back from that safety checkpoint). A file the checkpoints never tracked
//! (ignored, oversized, outside the folder) is never written or deleted.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::engine::{
    changes_between, index_path, list_in, lock_for, name_status, prepare, remove_file_forced, safe_relative,
    snapshot_locked, Checkpoint, CheckpointError, Kind, Limits, Snapshot,
};
use super::git::{git_available, Shadow};

/// Files listed for one turn; more are cut (`truncated` says so).
const MAX_FILES: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    /// `A` added, `M` modified, `D` deleted.
    pub status: String,
    pub added: u32,
    pub deleted: u32,
    pub binary: bool,
    /// The file's content id at the end of the turn (empty for a deleted file). "Changed since you looked" compares it.
    pub blob: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnReview {
    pub turn: u32,
    /// The checkpoint the turn started from: Put back returns a file to it.
    pub before_id: String,
    pub after_id: String,
    pub files: Vec<ReviewFile>,
    /// More files changed than are listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PutBackReport {
    /// The checkpoint of the files as they were before Put back (what Undo returns the file from).
    pub safety_id: Option<String>,
    /// `written` (the old content is back), `removed` (the agent created it, so it is gone) or `nothing` (it already matched).
    pub action: String,
}

/// The files the newest finished turn of `pane` changed. `None`: no before/after pair (never snapshotted, the turn
/// is still running for the first time, or nothing changed).
pub fn turn_review(project: &Path, pane: &str) -> Result<Option<TurnReview>, CheckpointError> {
    if !git_available() {
        return Err(CheckpointError::GitMissing);
    }
    let shadow = Shadow::new(project);
    if !shadow.exists() {
        return Ok(None);
    }
    let items = list_in(&shadow, pane)?;
    let Some((before, after)) = latest_turn(&items) else { return Ok(None) };
    if before.tree == after.tree {
        return Ok(None);
    }
    let changes = changes_between(&shadow, &before.tree, &after.tree)?;
    let truncated = changes.len() > MAX_FILES;
    let kept: Vec<_> = changes.into_iter().take(MAX_FILES).collect();
    let blobs = blob_ids(&shadow, &after.tree, kept.iter().filter(|c| c.status != "D").map(|c| c.path.as_str()))?;
    let files = kept
        .into_iter()
        .map(|c| {
            let blob = blobs.get(&c.path).cloned().unwrap_or_default();
            ReviewFile { path: c.path, status: c.status, added: c.added, deleted: c.deleted, binary: c.binary, blob }
        })
        .collect();
    Ok(Some(TurnReview { turn: after.turn, before_id: before.id.clone(), after_id: after.id.clone(), files, truncated }))
}

/// The newest finished turn: the newest "after" save point and the one the turn started from (the newest "before" or
/// "after" taken earlier). `items` are oldest first.
fn latest_turn(items: &[Checkpoint]) -> Option<(&Checkpoint, &Checkpoint)> {
    let at = items.iter().rposition(|c| c.kind == "after")?;
    let before = items[..at].iter().rev().find(|c| c.kind == "before" || c.kind == "after")?;
    Some((before, &items[at]))
}

/// The content ids of `paths` in `tree`.
fn blob_ids<'a>(shadow: &Shadow, tree: &str, paths: impl Iterator<Item = &'a str>) -> Result<HashMap<String, String>, CheckpointError> {
    let mut args: Vec<String> = vec!["--literal-pathspecs".into(), "ls-tree".into(), "-r".into(), "-z".into(), tree.into(), "--".into()];
    let before = args.len();
    args.extend(paths.map(str::to_string));
    let mut out = HashMap::new();
    if args.len() == before {
        return Ok(out);
    }
    let listing = shadow.run(&args, None, None, &[])?;
    for record in listing.stdout.split(|b| *b == 0) {
        let line = String::from_utf8_lossy(record);
        let Some((meta, name)) = line.split_once('\t') else { continue };
        if let Some(object) = meta.split_whitespace().nth(2) {
            out.insert(name.to_string(), object.to_string());
        }
    }
    Ok(out)
}

/// Whether `rel` stays inside the work tree once the folders on its way are resolved (a link out of the folder is refused).
fn stays_inside(work_tree: &Path, rel: &Path) -> bool {
    let Ok(root) = work_tree.canonicalize() else { return false };
    let mut dir = work_tree.join(rel);
    // The nearest folder that exists is the one a link could redirect.
    while !dir.exists() {
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return false,
        }
    }
    let Ok(real) = dir.canonicalize() else { return false };
    real.starts_with(&root)
}

/// Biggest diff of one file the review shows.
const PATCH_MAX_BYTES: usize = 300_000;

/// The unified diff of one file between two checkpoints of `pane` (what the turn did to it). Empty when it did not change.
pub fn file_patch(project: &Path, pane: &str, from_id: &str, to_id: &str, path: &str) -> Result<String, CheckpointError> {
    if !git_available() {
        return Err(CheckpointError::GitMissing);
    }
    let shadow = Shadow::new(project);
    if !shadow.exists() {
        return Err(CheckpointError::NotFound);
    }
    let items = list_in(&shadow, pane)?;
    let from = items.iter().find(|c| c.id == from_id).ok_or(CheckpointError::NotFound)?;
    let to = items.iter().find(|c| c.id == to_id).ok_or(CheckpointError::NotFound)?;
    super::engine::patch_between_trees(project, &from.tree, &to.tree, path, PATCH_MAX_BYTES).map(|(patch, _)| patch)
}

/// Return the file `path` to its state in checkpoint `before_id`. Refused while the pane is working.
pub fn put_back(
    project: &Path,
    pane: &str,
    before_id: &str,
    path: &str,
    pane_running: bool,
    now_ms: u64,
    limits: &Limits,
) -> Result<PutBackReport, CheckpointError> {
    if pane_running {
        return Err(CheckpointError::Running);
    }
    let Some(rel) = safe_relative(path).filter(|_| !path.contains('\\')) else {
        return Err(CheckpointError::Other("That file name is not allowed.".into()));
    };
    let shadow = prepare(project)?;
    let gate = lock_for(&shadow);
    let _held = gate.lock();
    let items = list_in(&shadow, pane)?;
    let target = items.iter().find(|c| c.id == before_id).ok_or(CheckpointError::NotFound)?.clone();
    if !stays_inside(&shadow.work_tree, &rel) {
        return Err(CheckpointError::Other("That file is outside the project folder.".into()));
    }
    // Only a file the newest turn changed: a file the agent never touched (or one made later by someone else) is not ours to move.
    let (turn_before, turn_after) = latest_turn(&items).ok_or(CheckpointError::NotFound)?;
    if !changes_between(&shadow, &turn_before.tree, &turn_after.tree)?.iter().any(|c| c.path == path) {
        return Err(CheckpointError::Other("The agent did not change that file in its last turn.".into()));
    }
    let safety = snapshot_locked(&shadow, pane, Kind::Undo, None, now_ms, limits, None)?;
    let safety_id = match &safety {
        Snapshot::Created(c) => Some(c.id.clone()),
        Snapshot::Unchanged(c) => c.as_ref().map(|c| c.id.clone()),
    };
    let index = index_path(&shadow, pane);
    // The index mirrors the disk after the safety snapshot, so this tree is "what is there now".
    let current = shadow.run(&["write-tree"], Some(&index), None, &[])?.text();
    let status = name_status(&shadow, &current, &target.tree)?.into_iter().find(|(_, p)| p == path).map(|(s, _)| s);
    let abs = shadow.work_tree.join(&rel);
    let action = match status {
        None => "nothing",
        // In the folder now, not in the checkpoint: the agent created it. It is a file the checkpoints track
        // (an ignored file is in neither tree), so removing it takes back only what the turn added.
        Some('D') => {
            remove_file_forced(&abs).map_err(|_| CheckpointError::Other("Could not remove that file. Is it open in another program?".into()))?;
            shadow.run(&["--literal-pathspecs", "update-index", "--force-remove", "--", path], Some(&index), None, &[])?;
            let mut dir = abs.parent().map(Path::to_path_buf);
            while let Some(d) = dir {
                if d == shadow.work_tree || std::fs::remove_dir(&d).is_err() {
                    break;
                }
                dir = d.parent().map(Path::to_path_buf);
            }
            "removed"
        }
        Some(kind) => {
            let listing = shadow.run(&["--literal-pathspecs", "ls-tree", "-z", target.tree.as_str(), "--", path], None, None, &[])?;
            let line = String::from_utf8_lossy(listing.stdout.split(|b| *b == 0).next().unwrap_or_default()).to_string();
            let (meta, name) = line.split_once('\t').ok_or(CheckpointError::NotFound)?;
            let mut fields = meta.split_whitespace();
            let (Some(mode), Some(object_kind), Some(object)) = (fields.next(), fields.next(), fields.next()) else {
                return Err(CheckpointError::NotFound);
            };
            if name != path || object_kind != "blob" {
                return Err(CheckpointError::Other("That file cannot be put back.".into()));
            }
            if kind == 'T' {
                let _ = remove_file_forced(&abs);
            }
            let info = format!("{mode},{object},{path}");
            shadow.run(&["--literal-pathspecs", "update-index", "--add", "--cacheinfo", info.as_str()], Some(&index), None, &[])?;
            shadow
                .run(&["--literal-pathspecs", "checkout-index", "-f", "--", path], Some(&index), None, &[])
                .map_err(|_| CheckpointError::Other("Could not write that file. Is it open in another program?".into()))?;
            "written"
        }
    };
    Ok(PutBackReport { safety_id, action: action.into() })
}

#[cfg(test)]
#[path = "turn_review_tests.rs"]
mod tests;
