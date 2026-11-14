//! A trial run for a folder that has no git: the chat works in a plain copy of the folder, and "Keep the changes"
//! copies back what changed. Small on purpose: big folders are refused with one plain sentence, and nothing is
//! copied back over a file that changed in the project while the chat was working.
//!
//! Layout under `store`: `trial-copies/<handle>/` is the copy; `trial-copies/<handle>.json` remembers what each file
//! looked like when it was copied (a hash), which is how changes are found later.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Folders that are never copied: large, rebuilt by tools, or the project's own history.
const SKIPPED: &[&str] = &[".git", "node_modules", "target", ".potato-workspace", ".venv", "__pycache__", "dist", "build"];
/// A trial run is for small folders.
pub const MAX_FILES: usize = 3000;
pub const MAX_BYTES: u64 = 150 * 1024 * 1024;

/// One plain sentence that says why a step did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    origin: String,
    files: BTreeMap<String, u64>,
}

/// What a copy changed, as relative paths.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Changed {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
}

impl Changed {
    pub fn total(&self) -> usize {
        self.added.len() + self.modified.len() + self.deleted.len()
    }
}

fn root(store: &Path) -> PathBuf {
    store.join("trial-copies")
}

pub fn copy_dir(store: &Path, handle: &str) -> PathBuf {
    root(store).join(handle)
}

fn manifest_path(store: &Path, handle: &str) -> PathBuf {
    root(store).join(format!("{handle}.json"))
}

fn hash_file(path: &Path) -> std::io::Result<u64> {
    let mut file = fs::File::open(path)?;
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            return Ok(hash);
        }
        for byte in &buffer[..n] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
}

/// Every file under `dir` (relative, `/`-separated), skipping the folders nobody wants in a copy.
fn files_of(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        let Ok(entries) = fs::read_dir(dir.join(&relative)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let child = relative.join(&name);
            if kind.is_dir() {
                if !SKIPPED.contains(&name.as_str()) {
                    stack.push(child);
                }
            } else {
                found.push(child.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found.sort();
    found
}

/// Copies `project` into `store`. Refuses a folder that is too big, before anything is written.
pub fn make(project: &Path, store: &Path, handle: &str) -> Result<PathBuf, Refused> {
    let files = files_of(project);
    let too_big = || Refused(format!("This folder is too big for a trial copy (the limit is {MAX_FILES} files or {} MB). Pick a smaller folder, or work in it directly.", MAX_BYTES / 1024 / 1024));
    if files.len() > MAX_FILES {
        return Err(too_big());
    }
    let total: u64 = files.iter().filter_map(|f| fs::metadata(project.join(f)).ok()).map(|m| m.len()).sum();
    if total > MAX_BYTES {
        return Err(too_big());
    }
    let target = copy_dir(store, handle);
    let sorry = |_: std::io::Error| {
        discard(store, handle);
        Refused("The copy could not be made. Check that there is free space and try again.".into())
    };
    fs::create_dir_all(&target).map_err(sorry)?;
    let mut manifest = Manifest { origin: project.to_string_lossy().into_owned(), files: BTreeMap::new() };
    for file in &files {
        let to = target.join(file);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(sorry)?;
        }
        fs::copy(project.join(file), &to).map_err(sorry)?;
        manifest.files.insert(file.clone(), hash_file(&to).map_err(sorry)?);
    }
    let text = serde_json::to_string(&manifest).unwrap_or_default();
    fs::write(manifest_path(store, handle), text).map_err(sorry)?;
    Ok(target)
}

fn manifest_of(store: &Path, handle: &str) -> Option<Manifest> {
    serde_json::from_str(&fs::read_to_string(manifest_path(store, handle)).ok()?).ok()
}

/// What the copy changed since it was made. `None` when the copy is gone.
pub fn changes(store: &Path, handle: &str) -> Option<Changed> {
    let manifest = manifest_of(store, handle)?;
    let dir = copy_dir(store, handle);
    if !dir.is_dir() {
        return None;
    }
    let now = files_of(&dir);
    let mut changed = Changed::default();
    for file in &now {
        match manifest.files.get(file) {
            None => changed.added.push(file.clone()),
            Some(before) if hash_file(&dir.join(file)).ok() != Some(*before) => changed.modified.push(file.clone()),
            _ => {}
        }
    }
    changed.deleted = manifest.files.keys().filter(|f| !now.contains(f)).cloned().collect();
    Some(changed)
}

/// Copies the changes back into the project. Refuses (and writes nothing) when a file the copy changed has also
/// changed in the project since the copy was made. Removes the copy afterwards. Returns what was kept.
pub fn keep(store: &Path, handle: &str) -> Result<Changed, Refused> {
    let gone = || Refused("This copy is gone, so there is nothing to keep.".into());
    let manifest = manifest_of(store, handle).ok_or_else(gone)?;
    let changed = changes(store, handle).ok_or_else(gone)?;
    let origin = PathBuf::from(&manifest.origin);
    let dir = copy_dir(store, handle);
    let clash: Vec<&String> = changed
        .modified
        .iter()
        .chain(&changed.deleted)
        .filter(|f| hash_file(&origin.join(f)).ok() != manifest.files.get(*f).copied())
        .chain(changed.added.iter().filter(|f| origin.join(f).exists() && hash_file(&origin.join(f)).ok() != hash_file(&dir.join(f)).ok()))
        .collect();
    if !clash.is_empty() {
        let names: Vec<&str> = clash.iter().take(3).map(|f| f.as_str()).collect();
        return Err(Refused(format!("Nothing was kept: {} changed in your folder while the chat worked on the copy. Throw the copy away, or move those files out of the way first.", names.join(", "))));
    }
    let sorry = |_: std::io::Error| Refused("The changes could not be copied back. The copy is still there.".into());
    for file in changed.added.iter().chain(&changed.modified) {
        let to = origin.join(file);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(sorry)?;
        }
        fs::copy(dir.join(file), &to).map_err(sorry)?;
    }
    for file in &changed.deleted {
        let _ = fs::remove_file(origin.join(file));
    }
    discard(store, handle);
    Ok(changed)
}

/// Removes the copy and its record.
pub fn discard(store: &Path, handle: &str) {
    let _ = fs::remove_dir_all(copy_dir(store, handle));
    let _ = fs::remove_file(manifest_path(store, handle));
}

/// Whether the copy is still on disk.
pub fn exists(store: &Path, handle: &str) -> bool {
    copy_dir(store, handle).is_dir()
}
