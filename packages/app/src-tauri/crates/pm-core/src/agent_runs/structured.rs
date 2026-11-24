//! Structured results, built by the app from facts. A helper is never asked to print JSON.
//!
//! The result keeps the shape callers know (`summary`, `files_changed`, `checks_run`,
//! `open_questions`):
//!
//! * `summary`: the agent's final reply, trimmed (cut when long);
//! * `files_changed`: the files that differ between a look at the folder when the turn started and
//!   one when it ended (`tree_proof`: `HEAD` plus `git status`). A folder that is not a git
//!   repository, or a look that fails, gives an empty list;
//! * `checks_run`: the commands the agent ran, from the tool calls the app already records;
//! * `open_questions`: the questions the agent was waiting on.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::tree_proof::{self, TreeSnapshot};

/// The longest `summary`, in characters.
pub const SUMMARY_CHARS: usize = 600;
/// The most paths / commands / questions listed.
pub const MAX_ITEMS: usize = 200;
/// The longest single command or question.
const ITEM_CHARS: usize = 300;

/// The result for one turn. Always the four fields; the lists hold strings.
pub fn build(reply: Option<&str>, files_changed: &[String], checks_run: &[String], open_questions: &[String]) -> Value {
    json!({
        "summary": summary_of(reply.unwrap_or("")),
        "files_changed": list(files_changed, usize::MAX),
        "checks_run": list(checks_run, ITEM_CHARS),
        "open_questions": list(open_questions, ITEM_CHARS),
    })
}

fn list(items: &[String], chars: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim();
        if item.is_empty() || out.iter().any(|seen| seen == item) {
            continue;
        }
        out.push(cut(item, chars));
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    out
}

fn cut(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(chars).collect();
    format!("{}…", kept.trim_end())
}

/// The reply without any `potato-result` block an older prompt may still have made an agent print.
pub fn without_result_block(text: &str) -> String {
    let Some(start) = text.find("```potato-result") else { return text.to_string() };
    let rest = &text[start + 3..];
    let end = rest.find("```").map(|at| start + 3 + at + 3).unwrap_or(text.len());
    format!("{}{}", &text[..start], &text[end..])
}

/// The summary: the reply, trimmed and cut. Empty when the agent said nothing.
pub fn summary_of(reply: &str) -> String {
    cut(without_result_block(reply).trim(), SUMMARY_CHARS)
}

// ---- the look at the folder, from the start of a turn to its end --------------------------------------------------

fn registry() -> &'static Mutex<HashMap<String, TreeSnapshot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, TreeSnapshot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A turn of run `key` starts in `dir`. A folder that cannot be looked at (not a git repository) is
/// simply not tracked.
pub fn begin(key: &str, dir: &Path) {
    match tree_proof::capture(dir) {
        Ok(before) => {
            registry().lock().insert(key.to_string(), before);
        }
        Err(_) => {
            registry().lock().remove(key);
        }
    }
}

/// The turn of run `key` ended: the files that changed since `begin`. Forgets the look. Empty when
/// there was none or the folder cannot be looked at now.
pub fn finish(key: &str, dir: &Path) -> Vec<String> {
    let Some(before) = registry().lock().remove(key) else { return Vec::new() };
    match tree_proof::capture(dir) {
        Ok(after) => tree_proof::changed_files(&before, &after, dir),
        Err(_) => Vec::new(),
    }
}

/// Drops a run that ended without a look.
pub fn forget(key: &str) {
    registry().lock().remove(key);
}

#[cfg(test)]
#[path = "structured_tests.rs"]
mod tests;
