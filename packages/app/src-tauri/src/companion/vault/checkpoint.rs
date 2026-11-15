//! Checkpoints: a compact summary of a stretch of conversation, `<home>/sessions/<scope>/cp-NNN.md`.
//! Ported from fishd `src/memory/checkpoint.ts` (`safeScope`, `chunkText`, `planChunks`, the numbering).
//!
//! A checkpoint is the "epoch boundary" of a brain that holds its own conversation (the bot, phase P3): after
//! it the prompt changes once and then stays stable. A companion in an agent pane compacts itself, so it
//! does not need these. The files are never overwritten: the counter restarts with the app, so the next
//! number is always one above the highest file on disk.

// The bot brain (P3) is what calls these; the tests cover them now.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Characters per chunk when a long text is condensed in pieces.
pub const CHUNK_CHARS: usize = 6_000;
/// The most model calls one condensation may use (the map calls plus the one that combines them).
pub const MAX_LLM_CALLS: usize = 4;
const DIR: &str = "sessions";

/// A folder name for a scope (a room, a channel). An ASCII scope keeps its name. When any non-ASCII
/// character is there, a short hash of the original is added so two rooms never share a folder.
pub fn safe_scope(scope: &str) -> String {
    let mut cleaned = String::new();
    for c in scope.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            cleaned.push(c);
        } else if !cleaned.ends_with('_') {
            cleaned.push('_');
        }
    }
    let cleaned = cleaned.trim_matches('_').to_string();
    // A name of dots alone would be a path.
    let cleaned = if cleaned.chars().all(|c| c == '.') { String::new() } else { cleaned };
    if scope.is_ascii() {
        let cut: String = cleaned.chars().take(40).collect();
        return if cut.is_empty() { "main".to_string() } else { cut };
    }
    let hash: String = Sha256::digest(scope.as_bytes()).iter().take(3).map(|b| format!("{b:02x}")).collect();
    let cut: String = cleaned.chars().take(33).collect();
    format!("{}-{hash}", if cut.is_empty() { "scope".to_string() } else { cut })
}

/// Breaks one over-long line into pieces of at most `size` characters.
fn hard_split(line: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= size {
        return vec![line.to_string()];
    }
    chars.chunks(size).map(|c| c.iter().collect()).collect()
}

/// Packs whole lines into chunks of at most `size` characters. Nothing is dropped: every non-blank line
/// lands in exactly one chunk (a line longer than `size` is split).
pub fn chunk_text(text: &str, size: usize) -> Vec<String> {
    let size = size.max(1);
    let mut out: Vec<String> = Vec::new();
    let (mut cur, mut cur_len) = (String::new(), 0usize);
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        for piece in hard_split(line, size) {
            let len = piece.chars().count();
            let add = if cur.is_empty() { len } else { len + 1 };
            if !cur.is_empty() && cur_len + add > size {
                out.push(std::mem::take(&mut cur));
                cur = piece;
                cur_len = len;
            } else {
                if !cur.is_empty() {
                    cur.push('\n');
                }
                cur.push_str(&piece);
                cur_len += add;
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// At most `max_calls - 1` chunks (one call is kept for the step that combines them). Short text stays one
/// chunk. A long text gets wider chunks instead of being cut, so all of it is seen.
pub fn plan_chunks(text: &str, size: usize, max_calls: usize) -> Vec<String> {
    let total = text.chars().count();
    if total == 0 {
        return Vec::new();
    }
    if total <= size {
        return vec![text.to_string()];
    }
    let max_map = max_calls.saturating_sub(1).max(1);
    let natural = chunk_text(text, size);
    if natural.len() <= max_map {
        return natural;
    }
    let mut width = total.div_ceil(max_map);
    for _ in 0..32 {
        let wide = chunk_text(text, width);
        if wide.len() <= max_map {
            return wide;
        }
        width = (width as f64 * 1.05).ceil() as usize;
    }
    // Last resort: fixed slices that may cut a line but drop nothing.
    let chars: Vec<char> = text.chars().collect();
    chars.chunks(total.div_ceil(max_map)).map(|c| c.iter().collect()).collect()
}

pub fn scope_dir(home: &Path, scope: &str) -> PathBuf {
    home.join(DIR).join(safe_scope(scope))
}

/// The number the next checkpoint gets: one above the highest `cp-NNN.md`, and at least `wanted`.
pub fn next_index(dir: &Path, wanted: u32) -> u32 {
    let highest = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix("cp-").and_then(|r| r.strip_suffix(".md")).and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0);
    wanted.max(1).max(highest + 1)
}

/// Saves a checkpoint. Never overwrites an older one. Returns the path relative to the home folder.
pub fn write(home: &Path, scope: &str, wanted_index: u32, text: &str) -> std::io::Result<Option<String>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let dir = scope_dir(home, scope);
    fs::create_dir_all(&dir)?;
    let index = next_index(&dir, wanted_index);
    let scope_name = safe_scope(scope);
    let rel = format!("{DIR}/{scope_name}/cp-{index:03}.md");
    let doc = format!("---\nscope: \"{scope_name}\"\nindex: {index}\ntype: checkpoint\n---\n\n{text}\n");
    // create_new: even a race cannot replace a file that is there.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(home.join(&rel))?;
    std::io::Write::write_all(&mut file, doc.as_bytes())?;
    Ok(Some(rel))
}

/// The checkpoints of a scope, oldest first (their bodies, without the front matter).
pub fn read_chain(home: &Path, scope: &str) -> Vec<String> {
    let dir = scope_dir(home, scope);
    let mut files: Vec<(u32, PathBuf)> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().strip_prefix("cp-")?.strip_suffix(".md")?.parse::<u32>().ok()?;
            Some((n, e.path()))
        })
        .collect();
    files.sort_by_key(|(n, _)| *n);
    files
        .into_iter()
        .filter_map(|(_, p)| fs::read_to_string(p).ok())
        .map(|t| {
            let t = t.replace("\r\n", "\n");
            match t.strip_prefix("---\n").and_then(|r| r.split_once("\n---\n")) {
                Some((_, body)) => body.trim().to_string(),
                None => t.trim().to_string(),
            }
        })
        .collect()
}

/// Fits the chain into `max_chars`: the head (the first checkpoint, where the story starts) and as many
/// of the newest ones as fit, with one line that says how many were left out. A chain that fits is
/// returned as it is.
pub fn fit_chain(chain: &[String], max_chars: usize) -> Vec<String> {
    let len = |s: &str| s.chars().count();
    if chain.iter().map(|c| len(c)).sum::<usize>() <= max_chars || chain.len() <= 2 {
        return chain.to_vec();
    }
    let head = chain[0].clone();
    let mut budget = max_chars.saturating_sub(len(&head) + 90);
    let mut tail: Vec<String> = Vec::new();
    for item in chain[1..].iter().rev() {
        if len(item) > budget {
            break;
        }
        budget -= len(item);
        tail.push(item.clone());
    }
    tail.reverse();
    let left_out = chain.len() - 1 - tail.len();
    let mut out = vec![head];
    if left_out > 0 {
        out.push(format!("({left_out} earlier checkpoints are left out here; they are still in the folder.)"));
    }
    out.extend(tail);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-checkpoint-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_ascii_scope_keeps_its_name_and_a_non_ascii_one_gets_a_hash() {
        assert_eq!(safe_scope("general"), "general");
        assert_eq!(safe_scope("a b/c"), "a_b_c");
        assert_eq!(safe_scope(""), "main");
        assert_eq!(safe_scope(".."), "main");
        let (a, b) = (safe_scope("客廳"), safe_scope("臥室"));
        assert_ne!(a, b, "two rooms, two folders");
        assert!(a.starts_with("scope-") && !a.contains('/'));
    }

    #[test]
    fn a_checkpoint_is_never_overwritten_the_number_goes_up() {
        let h = home();
        let first = write(&h, "room", 1, "one").unwrap().unwrap();
        assert_eq!(first, "sessions/room/cp-001.md");
        // The counter restarted at 1, but the file is there: the next one is 002.
        let second = write(&h, "room", 1, "two").unwrap().unwrap();
        assert_eq!(second, "sessions/room/cp-002.md");
        assert!(fs::read_to_string(h.join(&first)).unwrap().contains("one"));
        let third = write(&h, "room", 9, "three").unwrap().unwrap();
        assert_eq!(third, "sessions/room/cp-009.md", "a higher wanted number is kept");
        assert!(write(&h, "room", 1, "   ").unwrap().is_none());
    }

    #[test]
    fn the_chain_reads_back_oldest_first_without_the_front_matter() {
        let h = home();
        for t in ["one", "two", "three"] {
            write(&h, "room", 1, t).unwrap();
        }
        assert_eq!(read_chain(&h, "room"), vec!["one", "two", "three"]);
        assert!(read_chain(&h, "other").is_empty());
    }

    #[test]
    fn a_chain_that_fits_is_left_alone() {
        let chain: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(fit_chain(&chain, 100), chain);
    }

    #[test]
    fn a_long_chain_keeps_the_head_and_the_newest_and_says_what_was_left_out() {
        let chain: Vec<String> = (0..10).map(|i| format!("{i}{}", "x".repeat(99))).collect();
        let fit = fit_chain(&chain, 450);
        assert_eq!(fit[0], chain[0], "the head stays");
        assert_eq!(fit.last().unwrap(), chain.last().unwrap(), "the newest stays");
        assert!(fit.iter().any(|l| l.contains("earlier checkpoints are left out")), "{fit:?}");
        assert!(fit.iter().map(|l| l.chars().count()).sum::<usize>() <= 450);
        assert!(fit.len() < chain.len());
    }

    #[test]
    fn chunks_drop_nothing_and_stay_within_the_size() {
        let text = (0..50).map(|i| format!("line number {i} {}", "y".repeat(30))).collect::<Vec<_>>().join("\n");
        let chunks = chunk_text(&text, 200);
        assert!(chunks.iter().all(|c| c.chars().count() <= 200));
        let rejoined: Vec<&str> = chunks.iter().flat_map(|c| c.lines()).collect();
        assert_eq!(rejoined.len(), 50);
        let long = chunk_text(&"z".repeat(950), 400);
        assert_eq!(long.iter().map(|c| c.chars().count()).sum::<usize>(), 950);
    }

    #[test]
    fn the_plan_never_uses_more_than_three_map_calls_and_never_cuts_the_text() {
        let text = (0..400).map(|i| format!("row {i} {}", "w".repeat(80))).collect::<Vec<_>>().join("\n");
        let plan = plan_chunks(&text, 6_000, MAX_LLM_CALLS);
        assert!(plan.len() <= MAX_LLM_CALLS - 1, "{}", plan.len());
        assert_eq!(plan.iter().flat_map(|c| c.lines()).count(), 400);
        assert_eq!(plan_chunks("short", 6_000, 4), vec!["short".to_string()]);
        assert!(plan_chunks("", 6_000, 4).is_empty());
    }
}
