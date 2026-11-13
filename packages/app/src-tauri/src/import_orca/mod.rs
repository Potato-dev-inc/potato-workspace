//! "Bring my projects from Orca": read the project list Orca keeps on THIS PC and offer it for adding.
//!
//! Read-only and local: it opens Orca's own `orca-data.json` files (the default profile and any named profile),
//! parses them as plain JSON and reads only each repo's folder and name. It never starts a process, never uses
//! the network and never opens a login or key file. Orca's newer SQLite profile store (`profile-state.db`) is not
//! read: a profile with only that file reads as "nothing found" (see the guide in the docs). The shape comes from
//! Orca's public type docs (`repos[]` with `path`, `displayName`, `kind`, `connectionId`); no Orca code is used.
//!
//! The Tauri commands are in `commands/import_orca.rs`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests;

/// The largest `orca-data.json` that is read. A bigger file is skipped, not an error.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Most projects offered in one scan.
const MAX_PROJECTS: usize = 500;

/// One project in Orca's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaProject {
    pub path: String,
    pub name: String,
    /// The folder is on this PC now. A moved or deleted project shows but cannot be added.
    pub exists: bool,
}

/// One chat made in Orca. Orca keeps no chat files of its own: its terminals run the agents, which keep their
/// chats in their own folders ("Bring my chats" reads those). So this list is empty today; the field stays so the
/// answer can grow without a new command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaChat {
    pub title: String,
    pub project: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaScan {
    /// Orca's data was found and read on this PC.
    pub found: bool,
    pub projects: Vec<OrcaProject>,
    pub chats: Vec<OrcaChat>,
}

/// The folders where Orca keeps its data (Electron's per-user data folder, named after the app).
pub fn candidate_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |base: Option<std::ffi::OsString>, rel: &[&str]| {
        if let Some(base) = base.filter(|b| !b.is_empty()) {
            let mut p = PathBuf::from(base);
            for part in rel {
                p.push(part);
            }
            out.push(p);
        }
    };
    if cfg!(windows) {
        push(std::env::var_os("APPDATA"), &["orca"]);
    } else if cfg!(target_os = "macos") {
        push(std::env::var_os("HOME"), &["Library", "Application Support", "orca"]);
    } else {
        push(std::env::var_os("XDG_CONFIG_HOME"), &["orca"]);
        push(std::env::var_os("HOME"), &[".config", "orca"]);
    }
    out
}

/// Every `orca-data.json` under one data folder: the default profile, then each named profile.
fn data_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = vec![dir.join("orca-data.json")];
    if let Ok(profiles) = std::fs::read_dir(dir.join("profiles")) {
        let mut named: Vec<PathBuf> = profiles.flatten().map(|e| e.path().join("orca-data.json")).collect();
        named.sort();
        files.extend(named);
    }
    files.retain(|f| f.is_file());
    files
}

fn key(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    slashed.trim_end_matches('/').to_lowercase()
}

/// The projects in one parsed data file. Remote (SSH) repos are left out: their folder is not on this PC.
fn projects_in(value: &serde_json::Value) -> Vec<(String, String)> {
    let Some(repos) = value.get("repos").and_then(|r| r.as_array()) else { return Vec::new() };
    repos
        .iter()
        .filter_map(|repo| {
            let path = repo.get("path")?.as_str()?.trim();
            if path.is_empty() || !Path::new(path).is_absolute() {
                return None;
            }
            let remote = repo.get("connectionId").is_some_and(|c| c.as_str().is_some_and(|s| !s.is_empty()));
            if remote {
                return None;
            }
            let name = repo.get("displayName").and_then(|n| n.as_str()).map(str::trim).filter(|n| !n.is_empty());
            let name = name.map(str::to_string).unwrap_or_else(|| folder_name(path));
            Some((path.to_string(), name))
        })
        .collect()
}

fn folder_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Read Orca's data from the given folders. Nothing is written. A file that cannot be read or parsed is skipped.
pub fn scan_dirs(dirs: &[PathBuf]) -> OrcaScan {
    let mut scan = OrcaScan::default();
    let mut seen = std::collections::HashSet::new();
    for dir in dirs {
        for file in data_files(dir) {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            if meta.len() > MAX_BYTES {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            scan.found = true;
            for (path, name) in projects_in(&value) {
                if scan.projects.len() >= MAX_PROJECTS || !seen.insert(key(&path)) {
                    continue;
                }
                let exists = Path::new(&path).is_dir();
                scan.projects.push(OrcaProject { path, name, exists });
            }
        }
    }
    scan
}

/// The scan of this PC's Orca folders.
pub fn scan() -> OrcaScan {
    scan_dirs(&candidate_dirs())
}

/// The folders from `wanted` that may be added: each must be a folder on this PC and in Orca's own list now (a page
/// cannot ask for any other folder). The answer keeps the order asked, with no repeats.
pub fn accept(wanted: &[String], listed: &OrcaScan) -> Vec<OrcaProject> {
    let mut out: Vec<OrcaProject> = Vec::new();
    for path in wanted {
        let Some(found) = listed.projects.iter().find(|p| key(&p.path) == key(path)) else { continue };
        if found.exists && Path::new(&found.path).is_dir() && !out.iter().any(|p| key(&p.path) == key(&found.path)) {
            out.push(found.clone());
        }
    }
    out
}
