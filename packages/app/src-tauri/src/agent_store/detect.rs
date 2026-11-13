//! Finds the agents already installed on this PC (A2): which Store entries, which ACP registry agents
//! and which `<name>-acp` programs are on `PATH`.
//!
//! The scan only reads folder listings. The one program it ever starts is `<program> --version`, for
//! each agent it found, through the guarded run helper (hidden window, 5 s limit, stdin closed). Folders
//! inside the project folder are never searched, so a program planted in a repo is not reported.
//! Several hits for one agent id give one row (the first on `PATH`).
//!
//! The Store entries name their programs in `definition.toml` (`binary.names`). The registry names
//! its programs in its distribution data (`npx` package, binary `cmd`). The registry is the snapshot
//! built into the app, so this makes no network request.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::catalog::{self, CatalogEntry};
use crate::acp::registry::{self, program_stem, split_package, Registry, RegistryAgent};
use crate::tui;
use crate::tui::declarative::parse_definition;
use crate::tui::declarative::wizard::exec;

/// The longest time the version check may take.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// The longest version text kept on a row.
const VERSION_MAX_CHARS: usize = 80;
/// The file extensions a Windows program may have (matched case-insensitively).
const WINDOWS_EXTENSIONS: &[&str] = &["exe", "com", "cmd", "bat", "ps1"];
/// The suffix of an ACP adapter program (`claude-acp`).
const ACP_SUFFIX: &str = "-acp";

/// Where a found agent was matched from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FoundKind {
    /// A Store entry's own program name.
    Catalog,
    /// A program name from the ACP registry.
    Registry,
    /// A `<name>-acp` program next to a known agent.
    AcpSibling,
}

/// One agent found on this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundAgent {
    pub id: String,
    pub display_name: String,
    pub path: PathBuf,
    pub kind: FoundKind,
    /// The first line of `--version`, or `None` when it gave no answer in time.
    pub version: Option<String>,
}

/// One program name to look for, and the agent it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Candidate {
    pub id: String,
    pub display_name: String,
    pub program: String,
    pub kind: FoundKind,
}

/// The agents on the real `PATH`, with the version of each.
pub fn detect_on_this_pc(project_dir: Option<&Path>) -> Vec<FoundAgent> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    detect_installed(&path_var, project_dir)
}

/// The agents on `path_var` (a `PATH` value), leaving out any folder inside `project_dir`.
pub fn detect_installed(path_var: &OsStr, project_dir: Option<&Path>) -> Vec<FoundAgent> {
    let candidates = production_candidates();
    detect_in(&candidates, path_var, project_dir, &run_version)
}

/// `detect_installed` over any candidates and runner.
pub(super) fn detect_in(
    candidates: &[Candidate],
    path_var: &OsStr,
    project_dir: Option<&Path>,
    runner: &dyn Fn(&Path, &[String]) -> Option<String>,
) -> Vec<FoundAgent> {
    let index = index_dirs(&scan_dirs(path_var, project_dir));
    let mut done: HashSet<String> = HashSet::new();
    let mut found = Vec::new();
    for candidate in candidates {
        if done.contains(&candidate.id) {
            continue;
        }
        let Some(path) = index.find(&candidate.program) else { continue };
        done.insert(candidate.id.clone());
        let version = version_of(&path, runner);
        found.push(FoundAgent {
            id: candidate.id.clone(),
            display_name: candidate.display_name.clone(),
            path,
            kind: candidate.kind,
            version,
        });
    }
    found
}

/// The version of one found program: asks `--version` and nothing else.
pub(super) fn version_of(program: &Path, runner: &dyn Fn(&Path, &[String]) -> Option<String>) -> Option<String> {
    runner(program, &["--version".to_string()])
}

/// The one real run: `program` with `args`, guarded (no window, time limit, stdin closed). Returns the
/// first line of its output, or `None` when it did not run or timed out.
pub(super) fn run_version(program: &Path, args: &[String]) -> Option<String> {
    let cwd = program.parent().unwrap_or_else(|| Path::new("."));
    let out = exec::run(&exec::RunSpec { timeout: VERSION_TIMEOUT, ..exec::RunSpec::new(program, args, cwd) });
    if out.spawn_error.is_some() || out.timed_out {
        return None;
    }
    let text = exec::clean(&out.stdout);
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(exec::cut_chars(line, VERSION_MAX_CHARS))
}

/// Every name to look for: the Store entries, the registry agents, then the `-acp` siblings of both.
/// A Store entry comes first, so its row wins over a registry row for the same id.
fn production_candidates() -> Vec<Candidate> {
    candidates_from(catalog::all(), &registry::snapshot())
}

/// `production_candidates` over any catalog and registry.
pub(super) fn candidates_from(entries: &[CatalogEntry], registry: &Registry) -> Vec<Candidate> {
    let mut direct: Vec<Candidate> = Vec::new();
    for entry in entries {
        let id = entry.entry.store.id.clone();
        for program in catalog_programs(entry) {
            direct.push(Candidate { id: id.clone(), display_name: entry.label(), program, kind: FoundKind::Catalog });
        }
    }
    for agent in &registry.agents {
        for program in registry_programs(agent) {
            direct.push(Candidate {
                id: agent.id.clone(),
                display_name: agent.name.clone(),
                program,
                kind: FoundKind::Registry,
            });
        }
    }
    let siblings: Vec<Candidate> = direct
        .iter()
        .filter(|c| !c.program.ends_with(ACP_SUFFIX))
        .map(|c| Candidate { program: format!("{}{ACP_SUFFIX}", c.program), kind: FoundKind::AcpSibling, ..c.clone() })
        .collect();
    direct.extend(siblings);
    direct
}

/// The program names of a Store entry: `binary.names` from its definition. A built-in agent has no
/// definition, so its program is the one its profile starts on Linux.
fn catalog_programs(entry: &CatalogEntry) -> Vec<String> {
    let names = match entry.definition_text.as_deref().and_then(|text| parse_definition(text).ok()) {
        Some(definition) => definition.binary.names,
        None => tui::linux_program(&entry.entry.store.id).into_iter().collect(),
    };
    names.iter().map(|name| program_stem(name)).filter(|name| !name.is_empty()).collect()
}

/// The program names of a registry agent: the package name of its `npx` distribution (`@scope/name`
/// gives `name`) and the program of each binary distribution.
fn registry_programs(agent: &RegistryAgent) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(npx) = &agent.distribution.npx {
        let package = split_package(&npx.package).map(|(name, _)| name).unwrap_or(&npx.package);
        names.push(package.rsplit('/').next().unwrap_or(package).to_ascii_lowercase());
    }
    for binary in agent.distribution.binary.values() {
        names.push(program_stem(&binary.cmd));
    }
    names.retain(|name| !name.is_empty());
    names
}

/// The folders of `path_var` that may be searched: absolute, existing, and not the project folder
/// or inside it.
fn scan_dirs(path_var: &OsStr, project_dir: Option<&Path>) -> Vec<PathBuf> {
    let project = project_dir.and_then(|dir| std::fs::canonicalize(dir).ok());
    std::env::split_paths(path_var)
        .filter(|dir| dir.is_absolute())
        .filter(|dir| match std::fs::canonicalize(dir) {
            Ok(real) => !project.as_ref().is_some_and(|root| real.starts_with(root)),
            Err(_) => false,
        })
        .collect()
}

/// The programs found in the scanned folders, as `(file name, path)` in `PATH` order. On Windows the
/// file name is lower case, so `KIMI.EXE` matches `kimi`.
struct Index {
    files: Vec<(String, PathBuf)>,
}

fn index_dirs(dirs: &[PathBuf]) -> Index {
    let mut files = Vec::new();
    for dir in dirs {
        let Ok(listing) = std::fs::read_dir(dir) else { continue };
        for entry in listing.flatten() {
            let path = entry.path();
            if !is_program_file(&path) {
                continue;
            }
            let raw = entry.file_name().to_string_lossy().into_owned();
            let name = if cfg!(windows) { raw.to_ascii_lowercase() } else { raw };
            files.push((name, path));
        }
    }
    Index { files }
}

impl Index {
    /// The first program in `PATH` order named `program`. On Windows the extensions are tried in
    /// `WINDOWS_EXTENSIONS` order, so `kimi.exe` beats `kimi.cmd` in the same folder.
    fn find(&self, program: &str) -> Option<PathBuf> {
        let wanted = if cfg!(windows) { program.to_ascii_lowercase() } else { program.to_string() };
        let names: Vec<String> = if cfg!(windows) {
            WINDOWS_EXTENSIONS.iter().map(|ext| format!("{wanted}.{ext}")).collect()
        } else {
            vec![wanted]
        };
        names
            .iter()
            .find_map(|name| self.files.iter().find(|(file, _)| file == name).map(|(_, path)| path.clone()))
    }
}

/// A file that can be a program: a known extension on Windows.
#[cfg(windows)]
fn is_program_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    path.is_file() && WINDOWS_EXTENSIONS.contains(&ext.as_str())
}

/// A file that can be a program: a regular file with an execute bit.
#[cfg(unix)]
fn is_program_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
