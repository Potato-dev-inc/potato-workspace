//! Read-only calls behind the Today page (`timeline/`): what going back to a save point would change,
//! one file's patch for a point, and which save points still exist. Nothing here writes a ref or a
//! project file.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;

use serde::Serialize;

use super::engine::{self, Checkpoint, CheckpointError, FileChange, Limits, DAY_KEY};
use super::git::{git_available, Shadow};

/// Most files listed in "what going back would change"; the rest are counted.
pub const MAX_LISTED: usize = 300;
/// A patch longer than this is cut (same cap as the per-turn review).
pub const PATCH_MAX_BYTES: usize = 300_000;

/// What going back to a save point would change in the folder, compared with the files now.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowDiff {
    /// At most `MAX_LISTED` files, sorted by path. Status is from the point of view of going back:
    /// `A` = comes back, `M` = changes, `D` = is removed.
    pub files: Vec<FileChange>,
    pub total: u32,
    pub changed: u32,
    pub restored: u32,
    pub removed: u32,
    /// Files not listed (`total` minus the listed ones).
    pub more: u32,
    /// The folder has its own `.git`: the go-back sheet says its history is not changed.
    pub has_git: bool,
}

fn shadow_of(project: &Path) -> Result<Shadow, CheckpointError> {
    if !git_available() {
        return Err(CheckpointError::GitMissing);
    }
    if !project.is_dir() {
        return Err(CheckpointError::FolderGone);
    }
    let shadow = Shadow::new(project);
    if !shadow.exists() {
        return Err(CheckpointError::NotFound);
    }
    Ok(shadow)
}

/// The `(key, id)` of every save point that still exists in this folder. A folder without a store
/// has none. One cheap git call.
pub fn existing_points(project: &Path) -> Result<HashSet<(String, String)>, CheckpointError> {
    if !git_available() {
        return Err(CheckpointError::GitMissing);
    }
    let shadow = Shadow::new(project);
    if !shadow.exists() {
        return Ok(HashSet::new());
    }
    let out = shadow.run(&["for-each-ref", "--format=%(refname)", "refs/pm/"], None, None, &[])?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    Ok(text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("refs/pm/")?.split_once('/'))
        .map(|(key, id)| (key.to_string(), id.to_string()))
        .collect())
}

/// What the point `key`/`id` changed in its own turn (against the point before it in that series).
pub fn point_diff(project: &Path, key: &str, id: &str) -> Result<Vec<FileChange>, CheckpointError> {
    shadow_of(project)?;
    engine::diff(project, key, id)
}

/// The patch of one file between the point before `id` and `id` itself.
pub fn point_patch(project: &Path, key: &str, id: &str, path: &str) -> Result<(String, bool), CheckpointError> {
    let shadow = shadow_of(project)?;
    let items = engine::list_in(&shadow, key)?;
    let at = engine::find(&items, id)?;
    let prev = if at == 0 { engine::EMPTY_TREE.to_string() } else { items[at - 1].tree.clone() };
    engine::patch_between_trees(project, &prev, &items[at].tree, path, PATCH_MAX_BYTES)
}

/// The patch of one file between the folder now and the point (what going back would do to it).
/// Reads the folder through the `day` index, like `now_diff`.
pub fn now_patch(project: &Path, key: &str, id: &str, path: &str, limits: &Limits) -> Result<(String, bool), CheckpointError> {
    let (shadow, gate) = locked(project)?;
    let _held = gate.lock();
    let items = engine::list_in(&shadow, key)?;
    let target = items[engine::find(&items, id)?].clone();
    let current = current_tree(&shadow, limits)?;
    engine::patch_between_trees(project, &current, &target.tree, path, PATCH_MAX_BYTES)
}

/// The shadow repository and its folder lock (the caller holds the lock while it works).
fn locked(project: &Path) -> Result<(Shadow, Arc<Mutex<()>>), CheckpointError> {
    let shadow = shadow_of(project)?;
    let gate = engine::lock_for(&shadow);
    Ok((shadow, gate))
}

/// The tree of the files on disk now. Refreshes the `day` series' private index (a stat cache, not a
/// ref) and writes no checkpoint.
fn current_tree(shadow: &Shadow, limits: &Limits) -> Result<String, CheckpointError> {
    let index = engine::index_path(shadow, DAY_KEY);
    let big = engine::scan(shadow, &index, limits)?;
    engine::stage_all(shadow, &index, &big)?;
    Ok(shadow.run(&["write-tree"], Some(&index), None, &[])?.text())
}

/// What going back to point `key`/`id` would change. Takes the folder lock (so it never reads
/// half a snapshot), refreshes a private index, and writes no ref and no project file.
pub fn now_diff(project: &Path, key: &str, id: &str, limits: &Limits) -> Result<NowDiff, CheckpointError> {
    let (shadow, gate) = locked(project)?;
    let _held = gate.lock();
    let items = engine::list_in(&shadow, key)?;
    let target: Checkpoint = items[engine::find(&items, id)?].clone();
    let current = current_tree(&shadow, limits)?;
    let all = engine::changes_between(&shadow, &current, &target.tree)?;
    let total = all.len() as u32;
    let count = |s: &str| all.iter().filter(|c| c.status == s).count() as u32;
    let (changed, restored, removed) = (count("M"), count("A"), count("D"));
    let files: Vec<FileChange> = all.into_iter().take(MAX_LISTED).collect();
    let more = total - files.len() as u32;
    Ok(NowDiff { files, total, changed, restored, removed, more, has_git: project.join(".git").exists() })
}
