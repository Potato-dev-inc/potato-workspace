//! Fences: which paths of a project an agent must not touch.
//!
//! A fence is stored as a path inside the project, `/` separated, no leading or trailing slash (`secrets`,
//! `config/prod.yml`). It covers that file, or that folder and everything in it. Matching ignores case (Windows).
//! A path an agent names may be absolute or relative to the folder it works in; a chat that works on a copy of the
//! project works in another folder, so a path is tried against every root given.

use std::path::PathBuf;

fn slashes(text: &str) -> String {
    let mut text = text.trim().replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    text
}

/// The parts of `path` with `.` dropped and `..` folded in. `None` when `..` climbs out of the start.
fn parts(path: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            other => out.push(other.to_string()),
        }
    }
    Some(out)
}

fn is_absolute(text: &str) -> bool {
    text.starts_with('/') || text.as_bytes().get(1) == Some(&b':')
}

/// `path` (absolute, or relative to `root`) as parts below `root`; `None` when it is not inside `root`.
fn below(root: &str, path: &str) -> Option<Vec<String>> {
    let root_text = slashes(root);
    let root = parts(&root_text)?;
    let path = slashes(path);
    let full = if is_absolute(&path) { parts(&path)? } else { parts(&format!("{root_text}/{path}"))? };
    if full.len() < root.len() || !full.iter().zip(&root).all(|(a, b)| a.eq_ignore_ascii_case(b)) {
        return None;
    }
    Some(full[root.len()..].to_vec())
}

/// A path the person gave (or the file tree sent) as the stored form of a fence. Refuses a path outside the project
/// and the project folder itself.
pub fn normalise(project: &str, path: &str) -> Result<String, String> {
    if project.trim().is_empty() {
        return Err("INVALID_ARGUMENT: name the project first".into());
    }
    let inside = below(project, path).ok_or("INVALID_ARGUMENT: that path is not inside this project")?;
    if inside.is_empty() {
        return Err("INVALID_ARGUMENT: fencing the whole project would stop the agent doing anything".into());
    }
    if inside.iter().any(|p| p.contains(['*', '?', '<', '>', '|', '"'])) {
        return Err("INVALID_ARGUMENT: a fence is a folder or a file, not a pattern".into());
    }
    Ok(inside.join("/"))
}

/// The fence that covers `path`, if any. `roots` are the folders a relative path may be relative to and an absolute
/// path may sit under: the folder the agent works in first, then the project itself.
pub fn covering<'a>(fences: &'a [String], roots: &[PathBuf], path: &str) -> Option<&'a str> {
    if fences.is_empty() {
        return None;
    }
    let path = slashes(path);
    let mut candidates: Vec<Vec<String>> = Vec::new();
    for root in roots {
        if let Some(found) = below(&root.to_string_lossy(), &path) {
            candidates.push(found);
        }
    }
    // A relative path with no root to anchor it is still checked as written.
    if candidates.is_empty() && !is_absolute(&path) {
        candidates.extend(parts(&path));
    }
    fences.iter().map(String::as_str).find(|fence| {
        let fence_parts: Vec<&str> = fence.split('/').filter(|p| !p.is_empty()).collect();
        !fence_parts.is_empty() && candidates.iter().any(|c| c.len() >= fence_parts.len() && c.iter().zip(&fence_parts).all(|(a, b)| a.eq_ignore_ascii_case(b)))
    })
}

/// The words a command line is searched for: whether `command` names a fenced path (it may touch it).
pub fn mentioned_in(fences: &[String], command: &str) -> Option<String> {
    let text = slashes(command).to_lowercase();
    fences.iter().find(|fence| text.contains(&fence.to_lowercase())).cloned()
}
