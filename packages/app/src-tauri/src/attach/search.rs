//! The project file picker behind `@` in the message box: the files of a pane's folder, ranked by the words typed.
//! In a git repository the list is what git tracks plus what it does not ignore (`.gitignore` is respected); in any
//! other folder it is a walk that skips `.git`, `node_modules`, `target`, `.potato-workspace` and hidden folders.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 200;
/// A walk of a folder that is not a git repository stops after this many files.
pub const MAX_WALK_ENTRIES: usize = 20_000;
/// How long a folder's file list is reused.
const CACHE_FOR: Duration = Duration::from_secs(5);
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", ".potato-workspace"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// Relative to the pane's folder, with `/`.
    pub path: String,
    pub abs_path: String,
    pub name: String,
    pub size: u64,
}

type Listing = Arc<Vec<String>>;

fn cache() -> &'static Mutex<HashMap<String, (Instant, Listing)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Listing)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn git_listing(cwd: &str) -> Option<Vec<String>> {
    let mut command = crate::proc_util::hidden_command("git");
    command.args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).current_dir(cwd);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<String> = text.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
    files.sort();
    files.dedup();
    Some(files)
}

fn walk(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push((entry.path(), format!("{prefix}{name}/")));
            } else if kind.is_file() {
                if files.len() >= MAX_WALK_ENTRIES {
                    files.sort();
                    return files;
                }
                files.push(format!("{prefix}{name}"));
            }
        }
    }
    files.sort();
    files
}

fn listing(cwd: &str) -> Listing {
    if let Some((at, files)) = cache().lock().get(cwd) {
        if at.elapsed() < CACHE_FOR {
            return files.clone();
        }
    }
    let files = Arc::new(git_listing(cwd).unwrap_or_else(|| walk(Path::new(cwd))));
    let mut cached = cache().lock();
    cached.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
    cached.insert(cwd.to_string(), (Instant::now(), files.clone()));
    files
}

/// Files whose path has every word of `query` (case-insensitive), best first: a name that starts with the first
/// word, then a name that has all words, then a path that has them. An empty query lists by path.
pub fn search(cwd: &str, query: &str, limit: Option<usize>) -> Vec<ProjectFile> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase().replace('\\', "/")).collect();
    let files = listing(cwd);
    let mut ranked: Vec<(u8, &String)> = Vec::new();
    for path in files.iter() {
        let lower = path.to_lowercase();
        let name = lower.rsplit('/').next().unwrap_or(&lower);
        if !words.iter().all(|w| lower.contains(w.as_str())) {
            continue;
        }
        let tier = match words.first() {
            None => 0,
            Some(first) if name.starts_with(first.as_str()) => 0,
            Some(_) if words.iter().all(|w| name.contains(w.as_str())) => 1,
            Some(_) => 2,
        };
        ranked.push((tier, path));
    }
    if !words.is_empty() {
        ranked.sort_by(|a, b| (a.0, a.1.len(), a.1).cmp(&(b.0, b.1.len(), b.1)));
    }
    let mut out = Vec::new();
    for (_, path) in ranked {
        let abs = Path::new(cwd).join(path);
        // A file git still lists but that is gone from the disk is left out.
        let Ok(meta) = std::fs::metadata(&abs) else { continue };
        if !meta.is_file() {
            continue;
        }
        let abs_path = std::path::absolute(&abs).unwrap_or(abs).display().to_string();
        out.push(ProjectFile { path: path.clone(), abs_path, name: path.rsplit('/').next().unwrap_or(path).to_string(), size: meta.len() });
        if out.len() >= limit {
            break;
        }
    }
    out
}
