//! Taking our entries out of other tools' config files, and nothing else.
//!
//! Where an agent keeps its MCP servers comes from the agent's own declaration (`McpHostTable`, passed
//! in as `AgentSpec`s), so nothing here matches an agent name. Only two kinds of key are ever removed:
//! `potato-workspace` and `pm-toolbelt-*`. The edit is format-preserving (`toolbelt::edit`): every other
//! byte of the file stays as it was. The file is copied to the backup folder first.

use std::path::{Path, PathBuf};

use super::roots::Roots;
use crate::agent_pack::plan::AgentSpec;
use crate::mcp_install::declarative::{key_segments, resolve_config_path};
use crate::mcp_install::MCP_SERVER_NAME;
use crate::toolbelt::edit::{self, Format, Op};
use crate::toolbelt::KEY_PREFIX;

/// One config file and the table inside it that holds MCP servers.
#[derive(Debug, Clone, PartialEq)]
pub struct HostFile {
    /// The agent that declared it (a label for the list), or "Other tools".
    pub label: String,
    pub path: PathBuf,
    pub format: Format,
    pub parent: Vec<String>,
}

/// Files `mcp_install` writes that no agent declaration lists: `(path, format, table)`. A path starting
/// with `~/` is under the home folder, `%APPDATA%/` under the roaming folder.
const EXTRA_GLOBAL: &[(&str, Format, &[&str])] = &[
    ("~/.mcp.json", Format::Json, &["mcpServers"]),
    ("%APPDATA%/opencode/opencode.json", Format::Json, &["mcp"]),
];

/// Per-project files `mcp_install` writes, relative to the project.
const EXTRA_PROJECT: &[(&str, Format, &[&str])] = &[
    (".mcp.json", Format::Json, &["mcpServers"]),
    (".codex/config.toml", Format::Toml, &["mcp_servers"]),
    ("opencode.json", Format::Json, &["mcp"]),
];

/// True for a key this app owns.
pub fn is_ours(key: &str) -> bool {
    key == MCP_SERVER_NAME || key.starts_with(KEY_PREFIX)
}

fn push_unique(out: &mut Vec<HostFile>, file: HostFile) {
    if !out.iter().any(|h| h.path == file.path && h.parent == file.parent) {
        out.push(file);
    }
}

fn parent_of(key_path: &str) -> Option<Vec<String>> {
    let segs = key_segments(key_path).ok()?;
    let (_, parent) = segs.split_last()?;
    Some(parent.iter().map(|s| s.to_string()).collect())
}

/// The per-user files: each agent's declared config, plus the extras.
pub fn global_hosts(agents: &[AgentSpec], roots: &Roots) -> Vec<HostFile> {
    let mut out = Vec::new();
    for spec in agents {
        let Some(table) = &spec.mcp else { continue };
        let (Ok(path), Some(parent)) = (resolve_config_path(&table.config_path, &roots.home, None), parent_of(&table.key_path)) else {
            continue;
        };
        push_unique(&mut out, HostFile { label: spec.label.clone(), path, format: table.format, parent });
    }
    for (raw, format, parent) in EXTRA_GLOBAL {
        let path = match raw.strip_prefix("%APPDATA%/") {
            Some(rest) => roots.appdata.join(rest),
            None => roots.home.join(raw.trim_start_matches("~/")),
        };
        push_unique(&mut out, HostFile { label: "Other tools".into(), path, format: *format, parent: parent.iter().map(|s| s.to_string()).collect() });
    }
    out
}

/// The files inside one project folder.
pub fn project_hosts(agents: &[AgentSpec], project: &Path) -> Vec<HostFile> {
    let mut out = Vec::new();
    for spec in agents {
        let Some(table) = &spec.mcp else { continue };
        let (Some(rel), Some(parent)) = (&table.project_config_path, parent_of(&table.key_path)) else { continue };
        if rel.contains("..") || Path::new(rel).is_absolute() {
            continue;
        }
        push_unique(&mut out, HostFile { label: spec.label.clone(), path: project.join(rel), format: table.format, parent });
    }
    for (rel, format, parent) in EXTRA_PROJECT {
        push_unique(&mut out, HostFile { label: "Other tools".into(), path: project.join(rel), format: *format, parent: parent.iter().map(|s| s.to_string()).collect() });
    }
    out
}

/// The keys of ours in this file. Empty when the file is missing, unreadable or has none.
pub fn our_keys(host: &HostFile) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(&host.path) else { return Vec::new() };
    let parent: Vec<&str> = host.parent.iter().map(String::as_str).collect();
    edit::members(host.format, &text, &parent)
        .map(|members| members.into_iter().map(|(k, _)| k).filter(|k| is_ours(k)).collect())
        .unwrap_or_default()
}

/// Copies files into one folder before they are touched. Each copy gets a number, and `index.txt` says
/// which original it came from.
pub struct Backup {
    pub dir: PathBuf,
}

impl Backup {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Copy `file` in (a file that is not there needs no copy). Returns the copy's path.
    pub fn save(&self, file: &Path) -> Result<Option<PathBuf>, String> {
        if !file.is_file() {
            return Ok(None);
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("could not create {}: {e}", self.dir.display()))?;
        let n = std::fs::read_dir(&self.dir).map(|r| r.count()).unwrap_or(0);
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let copy = self.dir.join(format!("{n:03}-{name}"));
        std::fs::copy(file, &copy).map_err(|e| format!("could not back up {}: {e}", file.display()))?;
        let line = format!("{} <- {}\n", copy.file_name().unwrap_or_default().to_string_lossy(), file.display());
        let index = self.dir.join("index.txt");
        let old = std::fs::read_to_string(&index).unwrap_or_default();
        let _ = std::fs::write(&index, format!("{old}{line}"));
        Ok(Some(copy))
    }
}

/// What happened to one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub path: PathBuf,
    pub keys: Vec<String>,
}

/// Remove our keys from `host`, after a backup. `Ok(None)`: nothing of ours there.
pub fn remove_ours(host: &HostFile, backup: &Backup) -> Result<Option<Removed>, String> {
    let keys = our_keys(host);
    if keys.is_empty() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&host.path).map_err(|e| format!("could not read {}: {e}", host.path.display()))?;
    backup.save(&host.path)?;
    let parent: Vec<&str> = host.parent.iter().map(String::as_str).collect();
    let ops: Vec<Op> = keys.iter().map(|k| Op::Remove { key: k.clone() }).collect();
    let next = edit::apply(host.format, &text, &parent, &ops)?;
    if next != text {
        crate::settings_patch::write_atomic(&host.path, next.as_bytes()).map_err(|e| format!("could not write {}: {e}", host.path.display()))?;
    }
    Ok(Some(Removed { path: host.path.clone(), keys }))
}

/// `enableAllProjectMcpServers` in the project's Claude settings: we cannot tell whether we or the
/// person set it, so it is only reported, never changed.
pub fn blanket_trust_flag(project: &Path) -> Option<PathBuf> {
    let path = project.join(".claude").join("settings.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&text).ok()?;
    (doc.get("enableAllProjectMcpServers").and_then(serde_json::Value::as_bool) == Some(true)).then_some(path)
}

/// The skill folders of ours inside an agent's skills folder: only those whose `SKILL.md` carries the
/// pack marker. A folder the person made with the same name stays.
pub fn our_skill_dirs(skills_dir: &Path) -> Vec<PathBuf> {
    crate::agent_pack::assets::SKILLS
        .iter()
        .map(|(name, _)| skills_dir.join(name))
        .filter(|dir| std::fs::read_to_string(dir.join("SKILL.md")).is_ok_and(|t| t.contains(crate::agent_pack::MARKER_PREFIX)))
        .collect()
}

/// Remove one of our skill folders: the `SKILL.md`, then the folder if nothing else is in it.
pub fn remove_skill_dir(dir: &Path) -> Result<(), String> {
    std::fs::remove_file(dir.join("SKILL.md")).map_err(|e| format!("could not remove {}: {e}", dir.display()))?;
    let _ = std::fs::remove_dir(dir);
    Ok(())
}
