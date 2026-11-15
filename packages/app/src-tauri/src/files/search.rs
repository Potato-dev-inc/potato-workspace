//! "Search inside files": the project's text files, line by line. The file list is what git does not ignore (the
//! same list as the `@` picker), binary files and files over 2 MB are skipped, a link that leads out of the project is
//! never followed (every file goes through `resolve_in_root`), and at most `MAX_HITS` lines come back. A search can be
//! cancelled by id; a newer search with the same id cancels the older one.

use super::{resolve_in_root, MAX_READ_BYTES};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

/// A search stops after this many matching lines (the reply says it cut the list).
pub const MAX_HITS: usize = 200;
/// A shown line is cut to this many characters around the match.
const MAX_LINE_CHARS: usize = 240;
/// The match keeps this many characters of its left side when a long line is cut.
const LEAD_CHARS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    /// Relative to the project root, with `/`.
    pub path: String,
    pub name: String,
    /// 1-based.
    pub line: u32,
    /// The line, trimmed and cut to a readable length.
    pub text: String,
    /// The match inside `text`, in characters (`start` inclusive, `end` exclusive).
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearch {
    pub hits: Vec<ContentHit>,
    /// There were more matching lines than `MAX_HITS`.
    pub truncated: bool,
    /// The search was cancelled before it finished (the hits are what it found by then).
    pub cancelled: bool,
    pub files_scanned: u32,
}

fn searches() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static SEARCHES: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    SEARCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers a search under `id` and returns its cancel flag. An older search with the same id is cancelled.
pub fn begin_search(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(old) = searches().lock().insert(id.to_string(), flag.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    flag
}

/// Cancels the search registered under `id` (nothing happens when there is none).
pub fn cancel_search(id: &str) {
    if let Some(flag) = searches().lock().get(id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Forgets a finished search, unless a newer one took its id.
pub fn end_search(id: &str, flag: &Arc<AtomicBool>) {
    let mut all = searches().lock();
    if all.get(id).is_some_and(|cur| Arc::ptr_eq(cur, flag)) {
        all.remove(id);
    }
}

/// One character lower-cased, always to one character (so offsets stay the same as in the original line).
fn fold(c: char) -> char {
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// Where `needle` (already folded) first occurs in `line`, in characters.
fn find_chars(line: &str, needle: &[char]) -> Option<(usize, usize)> {
    let hay: Vec<char> = line.chars().map(fold).collect();
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle).map(|i| (i, i + needle.len()))
}

/// The line as shown: trimmed, cut around the match when it is long. Returns the text and the match inside it.
fn shown(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let chars: Vec<char> = line.chars().collect();
    let mut from = chars.iter().take_while(|c| c.is_whitespace()).count().min(start);
    if chars.len() - from > MAX_LINE_CHARS {
        from = from.max(start.saturating_sub(LEAD_CHARS));
    }
    let to = (from + MAX_LINE_CHARS).min(chars.len()).max(end.min(chars.len()));
    let text: String = chars[from..to].iter().collect::<String>().trim_end().to_string();
    let len = text.chars().count();
    (text, (start - from).min(len) as u32, (end - from).min(len) as u32)
}

/// Searches `paths` (relative to `root`) for `query`, ignoring case. Stops at `MAX_HITS` lines or when `cancel` is set.
pub fn scan(root: &str, paths: &[String], query: &str, cancel: &AtomicBool) -> ContentSearch {
    let mut out = ContentSearch::default();
    let needle: Vec<char> = query.trim().chars().map(fold).collect();
    if needle.is_empty() {
        return out;
    }
    for rel in paths {
        if cancel.load(Ordering::Relaxed) {
            out.cancelled = true;
            return out;
        }
        // Every file is checked against the project root again: a link that leads out is never read.
        let Ok((_, file)) = resolve_in_root(root, rel) else { continue };
        let Ok(meta) = fs::metadata(&file) else { continue };
        if !meta.is_file() || meta.len() > MAX_READ_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        // A NUL byte in the first 8 KB marks a binary file.
        if bytes.iter().take(8192).any(|b| *b == 0) {
            continue;
        }
        out.files_scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        let rel = rel.replace('\\', "/");
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        for (ix, line) in text.lines().enumerate() {
            if let Some((start, end)) = find_chars(line, &needle) {
                if out.hits.len() >= MAX_HITS {
                    out.truncated = true;
                    return out;
                }
                let (text, start, end) = shown(line, start, end);
                out.hits.push(ContentHit { path: rel.clone(), name: name.clone(), line: (ix + 1) as u32, text, start, end });
            }
        }
    }
    out
}

/// The files of the project folder (or of `folder` inside it) that contain `query`, line by line.
pub fn search_contents(root: &str, folder: Option<&str>, query: &str, cancel: &AtomicBool) -> Result<ContentSearch, String> {
    let (canon_root, _) = resolve_in_root(root, "")?;
    let prefix = match folder.map(|f| f.trim().trim_matches(['/', '\\'])).filter(|f| !f.is_empty()) {
        Some(f) => {
            let (_, dir) = resolve_in_root(root, f)?;
            if !dir.is_dir() {
                return Err("FILES_NOT_FOUND: That folder is not there any more.".to_string());
            }
            dir.strip_prefix(&canon_root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
        }
        None => String::new(),
    };
    let root_str = canon_root.to_string_lossy().into_owned();
    let mut paths = crate::attach::search::fresh_file_list(&root_str);
    if !prefix.is_empty() {
        let with_slash = format!("{prefix}/");
        paths.retain(|p| p.starts_with(&with_slash));
    }
    Ok(scan(&root_str, &paths, query, cancel))
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
