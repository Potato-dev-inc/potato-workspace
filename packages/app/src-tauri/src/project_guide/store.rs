//! The files of the guide, under `<project>/.potato/guide/`:
//!
//! ```text
//! manifest.json   commit, agent, per-page cited files with hashes
//! outline.json    the checked outline
//! graph.json      the checked diagram graph
//! diagram.mmd     the graph compiled to Mermaid (so other tools can draw it)
//! pages/<id>.md   one page each, ids are [a-z0-9-]
//! guide.json      optional steering file (the person or team may write it; we only read it)
//! ```
//!
//! The folder is git-excluded (the same mechanism as artifacts). Files are written whole through a temp file, so a
//! stop in the middle never leaves a half page.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

use super::model::{valid_id, Graph, Manifest, Outline};

/// Why a path named by an agent or the window was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathProblem {
    Absolute,
    Escapes,
    Missing,
    NotAFile,
}

pub fn guide_dir(project: &Path) -> PathBuf {
    project.join(".potato").join("guide")
}

pub fn pages_dir(project: &Path) -> PathBuf {
    guide_dir(project).join("pages")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn looks_absolute(rel: &str) -> bool {
    let b = rel.as_bytes();
    rel.starts_with('/') || rel.starts_with('\\') || rel.starts_with('~') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// A path relative to the project, with no `..`, no drive, no NUL. Returns it with `/` separators.
pub fn clean_rel(rel: &str) -> Result<String, PathProblem> {
    let rel = rel.trim();
    if rel.is_empty() || rel.contains('\0') {
        return Err(PathProblem::Missing);
    }
    if looks_absolute(rel) {
        return Err(PathProblem::Absolute);
    }
    let unified = rel.replace('\\', "/");
    let mut parts = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(PathProblem::Escapes),
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(PathProblem::Missing);
    }
    Ok(parts.join("/"))
}

/// The real path of a project-relative file or folder, checked to be inside the project even through links.
pub fn resolve_in_project(project: &Path, rel: &str) -> Result<PathBuf, PathProblem> {
    let rel = clean_rel(rel)?;
    let full = project.join(&rel);
    let real = fs::canonicalize(&full).map_err(|_| PathProblem::Missing)?;
    let root = fs::canonicalize(project).map_err(|_| PathProblem::Missing)?;
    if !real.starts_with(&root) {
        return Err(PathProblem::Escapes);
    }
    Ok(real)
}

/// Like [`resolve_in_project`], but it must be a file.
pub fn resolve_file(project: &Path, rel: &str) -> Result<PathBuf, PathProblem> {
    let real = resolve_in_project(project, rel)?;
    if real.is_file() { Ok(real) } else { Err(PathProblem::NotAFile) }
}

/// The first 16 hex characters of the SHA-256 of a file's bytes; `None` when it cannot be read.
pub fn file_hash(project: &Path, rel: &str) -> Option<String> {
    let real = resolve_file(project, rel).ok()?;
    let bytes = fs::read(real).ok()?;
    Some(hash_bytes(&bytes))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Makes the folder and keeps it out of git (best effort, like artifacts).
pub fn ensure_dir(project: &Path) -> Result<(), String> {
    fs::create_dir_all(pages_dir(project)).map_err(|e| format!("Could not make the guide folder: {e}"))?;
    crate::git_exclude::exclude_file(project, ".potato/guide/");
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, text.as_bytes())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub fn write_manifest(project: &Path, manifest: &Manifest) -> Result<(), String> {
    ensure_dir(project)?;
    write_json(&guide_dir(project).join("manifest.json"), manifest)
}

pub fn read_manifest(project: &Path) -> Option<Manifest> {
    read_json(&guide_dir(project).join("manifest.json"))
}

pub fn write_outline(project: &Path, outline: &Outline) -> Result<(), String> {
    ensure_dir(project)?;
    write_json(&guide_dir(project).join("outline.json"), outline)
}

pub fn read_outline(project: &Path) -> Option<Outline> {
    read_json(&guide_dir(project).join("outline.json"))
}

pub fn write_graph(project: &Path, graph: &Graph, mermaid: &str) -> Result<(), String> {
    ensure_dir(project)?;
    write_json(&guide_dir(project).join("graph.json"), graph)?;
    write_atomic(&guide_dir(project).join("diagram.mmd"), mermaid.as_bytes())
}

pub fn read_graph(project: &Path) -> Option<Graph> {
    read_json(&guide_dir(project).join("graph.json"))
}

pub fn read_diagram(project: &Path) -> Option<String> {
    fs::read_to_string(guide_dir(project).join("diagram.mmd")).ok()
}

pub fn write_page(project: &Path, id: &str, markdown: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("`{id}` is not a valid page id (a-z, 0-9 and dashes)."));
    }
    ensure_dir(project)?;
    write_atomic(&pages_dir(project).join(format!("{id}.md")), markdown.as_bytes())
}

pub fn read_page(project: &Path, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    fs::read_to_string(pages_dir(project).join(format!("{id}.md"))).ok()
}

/// A guide exists once a manifest is on disk (a run writes one as soon as the outline is checked).
pub fn has_guide(project: &Path) -> bool {
    guide_dir(project).join("manifest.json").is_file()
}

/// Deletes the whole guide folder. Refuses any folder that is not `.../.potato/guide`.
pub fn delete_guide(project: &Path) -> Result<bool, String> {
    let dir = guide_dir(project);
    if !dir.ends_with(Path::new(".potato").join("guide")) {
        return Err("Refused: not a guide folder.".into());
    }
    if !dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Could not delete the guide: {e}"))?;
    Ok(true)
}

/// The project's HEAD commit, when it is a git work tree (best effort, no window).
pub fn current_commit(project: &Path) -> Option<String> {
    let out = crate::proc_util::hidden_command("git").arg("-C").arg(project).args(["rev-parse", "--short=7", "HEAD"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The optional steering file: `{ "skip": ["folder"], "pages": ["id"], "language": "...", "notes": "..." }`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct Steering {
    pub skip: Vec<String>,
    pub pages: Vec<String>,
    pub language: Option<String>,
    pub notes: Option<String>,
}

pub fn read_steering(project: &Path) -> Steering {
    read_json(&guide_dir(project).join("guide.json")).unwrap_or_default()
}
