//! The three read-only facts a session row carries so a chat on another PC can look like the local one: `branch`, `model`, `mode`.
//! Watch level, no new route: they ride on `GET /pclink/sessions`.
//!
//! What each one exposes, and nothing else:
//! - `branch`: the short branch NAME git reports for the session's folder (never a path, a remote URL, a commit or file names),
//!   `null` outside a git folder or on a detached HEAD. Read straight from `.git/HEAD` (no process, no symlink followed, at most
//!   1 KB), cached for a few seconds per folder, and at most `MAX_PROBES` folders are read per list.
//! - `model`: the display name of the model the chat uses now (the name its agent gives the model), `null` for a terminal or when
//!   the agent offers none.
//! - `mode`: `"asks"`, `"acts_without_asking"` or `"unknown"`. A word from this fixed list, never the agent's own text.
//!
//! Names are cut to `NAME_MAX` characters with control characters removed.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Longest branch or model name that travels.
pub const NAME_MAX: usize = 80;
/// A branch is read again after this long (a person switching branch shows within a few seconds, a list poll costs nothing).
const TTL: Duration = Duration::from_secs(8);
/// Folders asked of git in one list: a PC with many chats never makes one list call spawn dozens of processes.
const MAX_PROBES: usize = 12;
/// Cache size: past it the cache is emptied (nothing is lost but a re-read).
const CACHE_MAX: usize = 128;

pub const MODE_ASKS: &str = "asks";
pub const MODE_ACTS: &str = "acts_without_asking";
pub const MODE_UNKNOWN: &str = "unknown";

/// Format characters (Unicode Cf) and line/paragraph separators: bidi overrides, zero-width marks, tags. They can reorder or hide
/// text on screen, so no name carries them.
fn is_format(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x08E2 | 0x180E | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x2064
        | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// A name that is safe to show: control and format characters removed, trimmed, at most `NAME_MAX` characters. `None` when nothing is left.
pub fn sanitize_name(text: &str) -> Option<String> {
    let cleaned: String = text.chars().filter(|c| !c.is_control() && !is_format(*c)).collect();
    let cut: String = cleaned.trim().chars().take(NAME_MAX).collect();
    let cut = cut.trim().to_string();
    (!cut.is_empty()).then_some(cut)
}

/// The name of the model a chat uses now, from its config options (the `model` category, or the option called `model`).
pub fn model_name(options: &[Value]) -> Option<String> {
    let group = options
        .iter()
        .find(|o| o["category"].as_str() == Some("model"))
        .or_else(|| options.iter().find(|o| o["id"].as_str() == Some("model")))?;
    let current = group["currentValue"].as_str()?;
    let name = group["options"].as_array().and_then(|list| list.iter().find(|c| c["value"].as_str() == Some(current))).and_then(|c| c["name"].as_str());
    match name {
        Some(display) => sanitize_name(display),
        // No display name: the raw value only when it is a plain model name, never a URL, a path or an id with separators.
        None if current.contains([':', '/', '\\']) => None,
        None => sanitize_name(current),
    }
}

/// The permission mode as one of three words. A chat that would run a message with no card at all is `acts_without_asking`;
/// a chat with a mode setting that does not is `asks`; anything else (a terminal, an agent with no mode setting) is `unknown`.
pub fn mode_word(options: &[Value], auto_allowed: &[String], needs_full: impl Fn(&[Value], &[String]) -> bool) -> &'static str {
    if needs_full(options, auto_allowed) {
        return MODE_ACTS;
    }
    let has_mode = options.iter().any(|o| o["category"].as_str() == Some("mode") && o["currentValue"].as_str().is_some());
    if has_mode {
        MODE_ASKS
    } else {
        MODE_UNKNOWN
    }
}

type Cache = HashMap<String, (Instant, Option<String>)>;

/// The branch NAME a folder's HEAD names, read straight from the files: no process is started. `<dir>/.git/HEAD`, or, when `.git`
/// is a file, the one `gitdir:` line in it. A symlink anywhere on the way is refused, at most `HEAD_MAX` bytes are read, and only a
/// `ref: refs/heads/<name>` line counts (a detached HEAD, a tag or anything else is `None`).
pub fn head_branch(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    if meta.file_type().is_symlink() {
        return None;
    }
    let git_dir = if meta.is_dir() {
        dot_git
    } else if meta.is_file() {
        let text = read_small(&dot_git)?;
        let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
        if target.is_empty() || target.contains('\0') {
            return None;
        }
        let path = Path::new(target);
        let path = if path.is_absolute() { path.to_path_buf() } else { dir.join(path) };
        let m = std::fs::symlink_metadata(&path).ok()?;
        if m.file_type().is_symlink() || !m.is_dir() {
            return None;
        }
        path
    } else {
        return None;
    };
    let head = git_dir.join("HEAD");
    let m = std::fs::symlink_metadata(&head).ok()?;
    if m.file_type().is_symlink() || !m.is_file() {
        return None;
    }
    let text = read_small(&head)?;
    let line = text.lines().next()?.trim();
    sanitize_name(line.strip_prefix("ref: refs/heads/")?)
}

/// The most of a HEAD (or `.git` pointer) file that is read; a bigger file is not one.
const HEAD_MAX: u64 = 1024;

fn read_small(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > HEAD_MAX {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(HEAD_MAX + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= HEAD_MAX).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads branches for a list of folders, with a short cache. One lock is held from the cache look-up to the insert, so two
/// parallel lists never read the same folder twice or race on the cache.
pub struct Branches {
    cache: Mutex<Option<Cache>>,
}

impl Branches {
    pub const fn new() -> Self {
        Self { cache: Mutex::new(None) }
    }

    /// The branch of `cwd` (sanitized), or `None` (no folder, not a git folder, detached HEAD, or never read yet because this list
    /// already read `MAX_PROBES` folders). A folder the cap skips keeps its last known branch, so it does not flicker.
    /// `probes` counts the reads made in this list.
    pub fn of(&self, cwd: &str, probes: &mut usize, probe: &dyn Fn(&Path) -> Option<String>) -> Option<String> {
        if cwd.trim().is_empty() {
            return None;
        }
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let cache = guard.get_or_insert_with(Cache::new);
        let old = cache.get(cwd).map(|(at, found)| (at.elapsed() < TTL, found.clone()));
        match old {
            Some((true, found)) => return found,
            Some((false, found)) if *probes >= MAX_PROBES => return found,
            None if *probes >= MAX_PROBES => return None,
            _ => {}
        }
        *probes += 1;
        let dir = Path::new(cwd);
        let found = if dir.is_dir() { probe(dir).and_then(|b| sanitize_name(&b)) } else { None };
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(cwd.to_string(), (Instant::now(), found.clone()));
        found
    }
}

/// The app's own cache.
pub static BRANCHES: Branches = Branches::new();

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn options(mode: &str, model: &str) -> Vec<Value> {
        vec![
            json!({ "id": "mode", "category": "mode", "currentValue": mode, "options": [{ "value": "default", "name": "Ask" }, { "value": "bypassPermissions", "name": "Full access" }] }),
            json!({ "id": "model", "category": "model", "currentValue": model, "options": [{ "value": "sonnet", "name": "Sonnet 5.5" }] }),
        ]
    }
    fn needs(o: &[Value], a: &[String]) -> bool {
        super::super::app_services::message_needs_full(o, a)
    }

    #[test]
    fn names_lose_control_characters_and_are_cut() {
        assert_eq!(sanitize_name("  feat/x\u{1b}[31m\n\t"), Some("feat/x[31m".into()));
        assert_eq!(sanitize_name(&"a".repeat(300)).unwrap().chars().count(), NAME_MAX);
        assert_eq!(sanitize_name("\u{7}\n "), None);
        assert_eq!(sanitize_name(&"\u{65e5}".repeat(200)).unwrap().chars().count(), NAME_MAX);
    }

    #[test]
    fn the_model_is_the_display_name_or_the_value_or_none() {
        assert_eq!(model_name(&options("default", "sonnet")), Some("Sonnet 5.5".into()));
        assert_eq!(model_name(&options("default", "mystery\u{0}-1")), Some("mystery-1".into()));
        assert_eq!(model_name(&[]), None);
    }

    #[test]
    fn the_mode_is_one_of_three_words() {
        assert_eq!(mode_word(&options("default", "sonnet"), &[], needs), MODE_ASKS);
        assert_eq!(mode_word(&options("bypassPermissions", "sonnet"), &[], needs), MODE_ACTS);
        assert_eq!(mode_word(&options("default", "sonnet"), &["execute".to_string()], needs), MODE_ACTS, "kinds allowed without asking");
        assert_eq!(mode_word(&[], &[], needs), MODE_UNKNOWN);
        assert_eq!(mode_word(&[json!({ "id": "model", "category": "model", "currentValue": "x" })], &[], needs), MODE_UNKNOWN);
    }

    #[test]
    fn bidi_zero_width_and_format_characters_are_stripped() {
        assert_eq!(sanitize_name("\u{202e}evil\u{200b}name\u{200d}"), Some("evilname".into()));
        assert_eq!(sanitize_name("\u{feff}a\u{2066}b\u{2069}c\u{e0041}"), Some("abc".into()));
        assert_eq!(sanitize_name("\u{200b}\u{202e}"), None);
    }

    #[test]
    fn the_model_never_falls_back_to_something_that_looks_like_a_url_or_a_path() {
        assert_eq!(model_name(&options("default", "https://evil.example/x")), None);
        assert_eq!(model_name(&options("default", "C:\\Users\\me\\key")), None);
        assert_eq!(model_name(&options("default", "a/b")), None);
        assert_eq!(model_name(&options("default", "sonnet-5")), Some("sonnet-5".into()));
    }

    #[cfg(windows)]
    fn link_file(to: &Path, at: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(to, at)
    }
    #[cfg(windows)]
    fn link_dir(to: &Path, at: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(to, at)
    }
    #[cfg(unix)]
    fn link_file(to: &Path, at: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(to, at)
    }
    #[cfg(unix)]
    fn link_dir(to: &Path, at: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(to, at)
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pclink-meta-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn head_is_read_from_the_file_for_a_repo_a_gitdir_file_and_nothing_else() {
        let repo = temp("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feat/meta\n").unwrap();
        assert_eq!(head_branch(&repo), Some("feat/meta".into()));
        // A worktree: `.git` is a file with one `gitdir:` line.
        let wt = temp("wt");
        let real = temp("realgit");
        std::fs::write(real.join("HEAD"), "ref: refs/heads/side\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(head_branch(&wt), Some("side".into()));
        // Detached HEAD, a tag, and no repository at all.
        std::fs::write(repo.join(".git/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        assert_eq!(head_branch(&repo), None);
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/tags/v1\n").unwrap();
        assert_eq!(head_branch(&repo), None);
        assert_eq!(head_branch(&temp("none")), None);
        // Oversized.
        std::fs::write(repo.join(".git/HEAD"), format!("ref: refs/heads/{}\n", "a".repeat(2000))).unwrap();
        assert_eq!(head_branch(&repo), None);
        // Hostile name: controls and bidi are removed, the length is capped.
        std::fs::write(repo.join(".git/HEAD"), format!("ref: refs/heads/x\u{202e}y\u{200b}{}\n", "b".repeat(200))).unwrap();
        let got = head_branch(&repo).unwrap();
        assert!(got.starts_with("xyb") && got.chars().count() == NAME_MAX, "{got}");
        for d in [repo, wt, real] {
            std::fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn a_symlinked_head_or_dot_git_is_refused() {
        let outside = temp("outside");
        std::fs::write(outside.join("HEAD"), "ref: refs/heads/secret\n").unwrap();
        let repo = temp("symrepo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        if link_file(&outside.join("HEAD"), &repo.join(".git/HEAD")).is_err() {
            return; // no symlink right on this machine: nothing to prove here
        }
        assert_eq!(head_branch(&repo), None);
        let repo2 = temp("symrepo2");
        if link_dir(&outside, &repo2.join(".git")).is_ok() {
            assert_eq!(head_branch(&repo2), None);
        }
        for d in [outside, repo, repo2] {
            std::fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn a_branch_is_read_once_per_folder_cached_and_a_skipped_folder_keeps_its_last_value() {
        let dir = temp("cache");
        let cwd = dir.to_string_lossy().to_string();
        let reads = Cell::new(0);
        let probe = |_: &Path| {
            reads.set(reads.get() + 1);
            Some("feat/meta\u{1b}".to_string())
        };
        let branches = Branches::new();
        let mut probes = 0;
        assert_eq!(branches.of(&cwd, &mut probes, &probe), Some("feat/meta".into()));
        assert_eq!(branches.of(&cwd, &mut probes, &probe), Some("feat/meta".into()));
        assert_eq!(reads.get(), 1, "the second read came from the cache");
        assert_eq!(branches.of("", &mut probes, &probe), None);
        assert_eq!(branches.of("Z:/no/such/folder", &mut probes, &probe), None);
        // Never read and the list's budget is spent: nothing, and it is not cached as "no branch".
        let fresh = Branches::new();
        let mut spent = MAX_PROBES;
        assert_eq!(fresh.of(&cwd, &mut spent, &probe), None);
        assert_eq!(fresh.of(&cwd, &mut 0, &probe), Some("feat/meta".into()));
        // An old entry with the budget spent keeps its value (no flicker).
        {
            let mut guard = fresh.cache.lock().unwrap();
            let entry = guard.as_mut().unwrap().get_mut(&cwd).unwrap();
            entry.0 = Instant::now() - TTL - Duration::from_secs(1);
        }
        assert_eq!(fresh.of(&cwd, &mut spent, &probe), Some("feat/meta".into()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
