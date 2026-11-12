//! Proof for `read_only` runs: the project folder looked the same before and after.
//!
//! Works on every lane and for every agent, even where nothing enforces read-only, because it
//! only compares two looks at the folder:
//!
//! * the `HEAD` commit, and
//! * `git status` (tracked changes plus untracked files that are not ignored), each listed file
//!   with its size and modified time.
//!
//! It proves nothing about writes outside the folder or about network actions. Another run in the
//! same folder would cause a false alarm, so it says `not_checked` (`shared_folder`) then. A folder
//! that is not a git repository, or a look that takes too long, is skipped with the reason named.
//! Nothing is ever reverted here.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const TREE_UNCHANGED: &str = "tree_unchanged";
pub const TREE_CHANGED: &str = "tree_changed";
/// Changed paths listed on a receipt; `changed_total` carries the full count.
pub const MAX_PATHS: usize = 20;
/// A look slower than this is abandoned (the process is killed) and the run is `not_checked`.
const LOOK_LIMIT: Duration = if cfg!(test) { Duration::from_secs(120) } else { Duration::from_millis(5000) };
/// A first look slower than this means the folder is too big to check cheaply: skip, say so.
const SLOW_FIRST_LOOK: Duration = if cfg!(test) { Duration::from_secs(120) } else { Duration::from_millis(1000) };

/// What the receipt shows under `guarantees.read_only`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadOnlyProof {
    /// `tree_unchanged` or `tree_changed`; absent when the folder could not be checked (see `reason`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<String>,
    /// Why there is no proof: `not_a_git_folder`, `shared_folder`, `too_slow`, `git_unavailable`,
    /// `app_restarted`, `run_did_not_finish`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_paths: Vec<String>,
    /// All changed paths, when more than `changed_paths` lists.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub changed_total: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl ReadOnlyProof {
    pub fn not_checked(reason: &str) -> Self {
        Self { reason: Some(reason.into()), ..Self::default() }
    }

    pub fn changed(&self) -> bool {
        self.proof.as_deref() == Some(TREE_CHANGED)
    }
}

/// One look at a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeSnapshot {
    head: String,
    files: BTreeMap<String, String>,
}

/// A look that could not be taken: the `reason` for `not_checked`.
fn git_output(dir: &Path, args: &[&str]) -> Result<Vec<u8>, &'static str> {
    let mut command = crate::proc_util::hidden_command("git");
    command
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|_| "git_unavailable")?;
    let mut stdout = child.stdout.take().ok_or("git_unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > LOOK_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("too_slow");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return Err("git_unavailable"),
        }
    };
    let bytes = reader.join().unwrap_or_default();
    if status.success() {
        Ok(bytes)
    } else {
        Err("failed")
    }
}

/// Looks at `dir`. `Err(reason)` when it cannot be checked.
pub fn capture(dir: &Path) -> Result<TreeSnapshot, &'static str> {
    let root = match git_output(dir, &["rev-parse", "--show-toplevel"]) {
        Ok(bytes) => PathBuf::from(String::from_utf8_lossy(&bytes).trim()),
        Err("failed") => return Err("not_a_git_folder"),
        Err(other) => return Err(other),
    };
    // An empty repository has no HEAD yet: that is a state too.
    let head = git_output(dir, &["rev-parse", "HEAD"])
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default();
    let status = git_output(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).map_err(|e| if e == "failed" { "git_unavailable" } else { e })?;
    let mut files = BTreeMap::new();
    let mut entries = status.split(|b| *b == 0).filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = String::from_utf8_lossy(&entry[..2]).to_string();
        let path = String::from_utf8_lossy(&entry[3..]).to_string();
        // A rename or copy lists its old path as the next entry.
        if code.contains('R') || code.contains('C') {
            let _ = entries.next();
        }
        let stat = std::fs::metadata(root.join(&path))
            .map(|meta| {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos());
                format!("{}:{modified}", meta.len())
            })
            .unwrap_or_else(|_| "gone".into());
        files.insert(path, format!("{code}|{stat}"));
    }
    Ok(TreeSnapshot { head, files })
}

/// Compares two looks.
pub fn compare(before: &TreeSnapshot, after: &TreeSnapshot) -> ReadOnlyProof {
    let mut changed: Vec<String> = Vec::new();
    for (path, value) in &after.files {
        if before.files.get(path) != Some(value) {
            changed.push(path.clone());
        }
    }
    for path in before.files.keys() {
        if !after.files.contains_key(path) {
            changed.push(path.clone());
        }
    }
    if before.head != after.head {
        changed.insert(0, "(the current commit moved)".into());
    }
    if changed.is_empty() {
        return ReadOnlyProof { proof: Some(TREE_UNCHANGED.into()), ..ReadOnlyProof::default() };
    }
    let total = changed.len();
    changed.truncate(MAX_PATHS);
    ReadOnlyProof {
        proof: Some(TREE_CHANGED.into()),
        changed_total: if total > MAX_PATHS { total } else { 0 },
        changed_paths: changed,
        ..ReadOnlyProof::default()
    }
}

// ---- runs in flight ---------------------------------------------------------------------------

struct Watch {
    folder: String,
    before: Result<TreeSnapshot, &'static str>,
    shared: bool,
}

fn registry() -> &'static Mutex<HashMap<String, Watch>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Watch>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn folder_key(dir: &Path) -> String {
    let text = dir.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_string();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/// A run starts in `dir`. `others_active` says another run is already working in that folder.
/// Every run calls this (it is free for a run that is not read-only); a read-only run is looked at.
pub fn begin(key: &str, dir: &Path, read_only: bool, others_active: bool) {
    let folder = folder_key(dir);
    let mut tracked = registry().lock();
    let mut shared = others_active;
    for watch in tracked.values_mut().filter(|w| w.folder == folder) {
        watch.shared = true;
        shared = true;
    }
    if !read_only {
        return;
    }
    drop(tracked);
    let started = Instant::now();
    let mut before = capture(dir);
    if before.is_ok() && started.elapsed() > SLOW_FIRST_LOOK {
        before = Err("too_slow");
    }
    registry().lock().insert(key.to_string(), Watch { folder, before, shared });
}

/// The run `key` ended: looks again and compares. Forgets the run. `None` when `begin` never saw it
/// as read-only (a restart, or a run that is not read-only).
pub fn finish(key: &str, dir: &Path) -> Option<ReadOnlyProof> {
    let watch = registry().lock().remove(key)?;
    let before = match watch.before {
        Ok(before) => before,
        Err(reason) => return Some(ReadOnlyProof::not_checked(reason)),
    };
    let overlapped = watch.shared
        || registry().lock().values().any(|other| other.folder == watch.folder);
    if overlapped {
        return Some(ReadOnlyProof::not_checked("shared_folder"));
    }
    match capture(dir) {
        Ok(after) => Some(compare(&before, &after)),
        Err(reason) => Some(ReadOnlyProof::not_checked(reason)),
    }
}

/// Drops a run that ended without a look (cancelled, failed).
pub fn forget(key: &str) {
    registry().lock().remove(key);
}
