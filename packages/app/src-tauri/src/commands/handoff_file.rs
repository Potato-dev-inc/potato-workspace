//! "Handoff from here": looks at the one file `HANDOFF.md` in a pane's folder so the window can tell whether
//! the agent wrote it. Reads nothing but the file's size and modified time; never its text.
//!
//! Quick handoff (a setting) uses a temporary file instead, `.potato/handoffs/handoff-<YYYYMMDD-HHMM>.md` in the
//! project. This module makes that folder (and keeps `.potato/` out of git through `.git/info/exclude`, never the
//! person's .gitignore), appends the person's fixed notes, and moves the file into the app's data folder once the
//! new agent has read it, keeping the last 20. The window names the file only by its stamp, never by a path.

use super::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;

/// The handoff file's file name. Fixed: the command can look at no other file.
pub const HANDOFF_FILE: &str = "HANDOFF.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffFileStat {
    pub exists: bool,
    pub modified_ms: u64,
    pub bytes: u64,
}

/// The stat of `HANDOFF.md` in `folder`. A missing (or unreadable) file is `exists: false`.
pub fn stat_handoff(folder: &Path) -> HandoffFileStat {
    stat_path(&folder.join(HANDOFF_FILE))
}

fn stat_path(path: &Path) -> HandoffFileStat {
    let none = HandoffFileStat { exists: false, modified_ms: 0, bytes: 0 };
    let Ok(meta) = std::fs::metadata(path) else { return none };
    if !meta.is_file() {
        return none;
    }
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    HandoffFileStat { exists: true, modified_ms, bytes: meta.len() }
}

/// The pane's folder (the default project folder for an unknown pane).
fn pane_folder(state: &AppState, pane_id: &str) -> String {
    let registry = state.registry.lock();
    registry.get(pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// `HANDOFF.md` in the pane's folder, or (quick handoff) the temporary file named by `stamp`.
#[tauri::command]
pub async fn handoff_file_stat(state: State<'_, AppState>, pane_id: String, stamp: Option<String>) -> Result<HandoffFileStat, String> {
    let folder = pane_folder(&state, &pane_id);
    blocking(move || match stamp {
        None => Ok(stat_handoff(Path::new(&folder))),
        Some(stamp) => Ok(stat_path(&quick_path(Path::new(&folder), &stamp)?)),
    })
    .await
}

/// What `handoff_quick_prepare` answers: the stamp actually used and the absolute path the agent must write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuickPrepared {
    pub stamp: String,
    pub path: String,
}

/// How many quick handoffs the app keeps per project.
pub const QUICK_KEEP: usize = 20;
const QUICK_DIR: [&str; 2] = [".potato", "handoffs"];
const IGNORE_LINE: &str = ".potato/";

/// `YYYYMMDD-HHMM`, optionally `-N` when two were made in one minute. Nothing else is accepted, so a stamp can
/// never carry a path.
fn valid_stamp(stamp: &str) -> bool {
    let mut parts = stamp.split('-');
    let (Some(day), Some(time)) = (parts.next(), parts.next()) else { return false };
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    let tail_ok = match parts.next() {
        None => true,
        Some(n) => !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()),
    };
    digits(day, 8) && digits(time, 4) && tail_ok && parts.next().is_none()
}

fn quick_path(folder: &Path, stamp: &str) -> Result<PathBuf, String> {
    if !valid_stamp(stamp) {
        return Err(format!("INVALID_ARGUMENT: {stamp:?} is not a handoff stamp"));
    }
    Ok(folder.join(QUICK_DIR[0]).join(QUICK_DIR[1]).join(format!("handoff-{stamp}.md")))
}

/// The `info/exclude` file of the git repo that holds `folder` (searching upward), or None when it is not in a repo.
/// A linked worktree has its own gitdir, but the exclude file is shared through `commondir`.
fn exclude_file(folder: &Path) -> Option<PathBuf> {
    for dir in folder.ancestors() {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git.join("info").join("exclude"));
        }
        if dot_git.is_file() {
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
            let mut gitdir = PathBuf::from(target);
            if gitdir.is_relative() {
                gitdir = dir.join(gitdir);
            }
            let common = match std::fs::read_to_string(gitdir.join("commondir")) {
                Ok(c) => {
                    let p = PathBuf::from(c.trim());
                    if p.is_relative() {
                        gitdir.join(p)
                    } else {
                        p
                    }
                }
                Err(_) => gitdir,
            };
            return Some(common.join("info").join("exclude"));
        }
    }
    None
}

/// Adds `.potato/` to `.git/info/exclude` (once) when `folder` is in a git repo. Never touches .gitignore.
fn ignore_potato(folder: &Path) -> Result<(), String> {
    let Some(exclude) = exclude_file(folder) else { return Ok(()) };
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == IGNORE_LINE || l.trim() == ".potato") {
        return Ok(());
    }
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("IO: could not prepare {}: {e}", parent.display()))?;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(IGNORE_LINE);
    next.push('\n');
    std::fs::write(&exclude, next).map_err(|e| format!("IO: could not update {}: {e}", exclude.display()))
}

/// Makes `.potato/handoffs/` in `folder`, ignores it in git and picks a free file name for `stamp`.
pub fn prepare_quick(folder: &Path, stamp: &str) -> Result<QuickPrepared, String> {
    if !valid_stamp(stamp) || stamp.matches('-').count() != 1 {
        return Err(format!("INVALID_ARGUMENT: {stamp:?} is not a handoff stamp"));
    }
    let dir = folder.join(QUICK_DIR[0]).join(QUICK_DIR[1]);
    std::fs::create_dir_all(&dir).map_err(|e| format!("IO: could not make {}: {e}", dir.display()))?;
    ignore_potato(folder)?;
    let mut used = stamp.to_string();
    let mut n = 1;
    while quick_path(folder, &used)?.exists() {
        n += 1;
        used = format!("{stamp}-{n}");
    }
    let path = quick_path(folder, &used)?;
    Ok(QuickPrepared { stamp: used, path: path.to_string_lossy().into_owned() })
}

/// Appends the person's fixed notes to the temporary file with this stamp, or (no stamp) to HANDOFF.md.
pub fn append_notes(folder: &Path, stamp: Option<&str>, notes: &str) -> Result<(), String> {
    let path = match stamp {
        Some(stamp) => quick_path(folder, stamp)?,
        None => folder.join(HANDOFF_FILE),
    };
    let notes = notes.trim();
    if notes.is_empty() {
        return Ok(());
    }
    let mut text = std::fs::read_to_string(&path).map_err(|e| format!("IO: could not read {}: {e}", path.display()))?;
    while text.ends_with('\n') || text.ends_with('\r') || text.ends_with(' ') {
        text.pop();
    }
    text.push_str("\n\n## Always remember\n\n");
    text.push_str(notes);
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| format!("IO: could not write {}: {e}", path.display()))
}

/// A folder name for the project: its last part, lowercase, plus a short hash of the whole path so two projects with
/// the same name do not share a folder.
pub fn project_slug(folder: &Path) -> String {
    let name: String = folder
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let name = name.trim_matches('-');
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in folder.to_string_lossy().to_lowercase().replace('\\', "/").trim_end_matches('/').bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    let name = if name.is_empty() { "project" } else { &name[..name.len().min(40)] };
    format!("{name}-{:08x}", hash & 0xffff_ffff)
}

/// Moves the temporary file to `<data_dir>/handoffs/<slug>/` and keeps the newest `QUICK_KEEP` there. Returns the new
/// path. On any failure the file stays where it is.
pub fn archive_quick(folder: &Path, stamp: &str, data_dir: &Path) -> Result<PathBuf, String> {
    let from = quick_path(folder, stamp)?;
    let dest_dir = data_dir.join("handoffs").join(project_slug(folder));
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("IO: could not make {}: {e}", dest_dir.display()))?;
    let to = dest_dir.join(from.file_name().ok_or("INTERNAL: no file name")?);
    if std::fs::rename(&from, &to).is_err() {
        // A different drive: copy, then remove. The original stays if the copy fails.
        std::fs::copy(&from, &to).map_err(|e| format!("IO: could not move {}: {e}", from.display()))?;
        std::fs::remove_file(&from).map_err(|e| format!("IO: copied to {} but could not remove {}: {e}", to.display(), from.display()))?;
    }
    prune(&dest_dir);
    Ok(to)
}

fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = read
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("handoff-") && e.path().is_file())
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), e.path()))
        .collect();
    files.sort();
    let extra = files.len().saturating_sub(QUICK_KEEP);
    for (_, path) in files.into_iter().take(extra) {
        let _ = std::fs::remove_file(path);
    }
}

/// Quick handoff, step 1: the folder and the path the old agent writes to.
#[tauri::command]
pub async fn handoff_quick_prepare(state: State<'_, AppState>, pane_id: String, stamp: String) -> Result<QuickPrepared, String> {
    let folder = pane_folder(&state, &pane_id);
    blocking(move || prepare_quick(Path::new(&folder), &stamp)).await
}

/// Quick handoff, step 2: append the fixed notes after the agent wrote the file.
#[tauri::command]
pub async fn handoff_quick_append(state: State<'_, AppState>, pane_id: String, stamp: Option<String>, notes: String) -> Result<(), String> {
    let folder = pane_folder(&state, &pane_id);
    blocking(move || append_notes(Path::new(&folder), stamp.as_deref(), &notes)).await
}

/// "Open file" after a Quick handoff: opens HANDOFF.md of the pane's folder with the system's default app.
#[tauri::command]
pub async fn handoff_open_file(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    let folder = pane_folder(&state, &pane_id);
    blocking(move || {
        let path = Path::new(&folder).join(HANDOFF_FILE);
        if !path.is_file() {
            return Err(format!("NOT_FOUND: {} is not there any more.", path.display()));
        }
        #[cfg(windows)]
        let program = "explorer";
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let program = "xdg-open";
        crate::proc_util::hidden_command(program).arg(&path).spawn().map(|_| ()).map_err(|e| format!("IO: Could not open the file: {e}."))
    })
    .await
}

/// Quick handoff, last step: move the file into the app's data folder. Resolves to where it is now.
#[tauri::command]
pub async fn handoff_quick_archive(state: State<'_, AppState>, pane_id: String, stamp: String) -> Result<String, String> {
    let folder = pane_folder(&state, &pane_id);
    blocking(move || archive_quick(Path::new(&folder), &stamp, &crate::app_paths::app_data_dir()).map(|p| p.to_string_lossy().into_owned())).await
}

/// The sign-in (account id) a pane runs under, when the app knows it: a terminal pane's own, or the one its chat
/// conversation was started with. None: the agent's own login, or not known.
#[tauri::command]
pub async fn handoff_pane_account(state: State<'_, AppState>, pane_id: String) -> Result<Option<String>, String> {
    let from_pane = state.registry.lock().get(&pane_id).and_then(|pane| pane.info.account.clone());
    if from_pane.is_some() {
        return Ok(from_pane);
    }
    Ok(crate::acp::conversations::global().record(&pane_id).and_then(|r| r.account))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-quick-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_does_not_exist() {
        let dir = std::env::temp_dir().join(format!("pm-handoff-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!stat_handoff(&dir).exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn written_file_reports_size_and_time() {
        let dir = std::env::temp_dir().join(format!("pm-handoff-some-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(HANDOFF_FILE), "# Goal\n").unwrap();
        let stat = stat_handoff(&dir);
        assert!(stat.exists);
        assert_eq!(stat.bytes, 7);
        assert!(stat.modified_ms > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_named_like_the_file_does_not_count() {
        let dir = std::env::temp_dir().join(format!("pm-handoff-dir-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(HANDOFF_FILE)).unwrap();
        assert!(!stat_handoff(&dir).exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stamps_are_dates_and_nothing_else() {
        assert!(valid_stamp("20261111-0930"));
        assert!(valid_stamp("20261111-0930-2"));
        for bad in ["", "../x", "20261111-0930/..", "2026111-0930", "20261111-09300", "20261111-0930-", "20261111-0930-2-3", "abcdefgh-0930"] {
            assert!(!valid_stamp(bad), "{bad}");
        }
        assert!(quick_path(Path::new("C:/shop"), "..\\..\\x").is_err());
    }

    #[test]
    fn prepare_makes_the_folder_and_hides_it_from_git_without_touching_gitignore() {
        let dir = temp("git");
        std::fs::create_dir_all(dir.join(".git").join("info")).unwrap();
        let exclude_path = dir.join(".git").join("info").join("exclude");
        std::fs::write(&exclude_path, "# keep\n*.log").unwrap();
        let got = prepare_quick(&dir, "20261111-0930").unwrap();
        assert_eq!(got.stamp, "20261111-0930");
        assert!(got.path.ends_with("handoff-20261111-0930.md"));
        assert!(dir.join(".potato").join("handoffs").is_dir());
        assert_eq!(std::fs::read_to_string(&exclude_path).unwrap(), "# keep\n*.log\n.potato/\n");
        prepare_quick(&dir, "20261111-0931").unwrap();
        assert_eq!(std::fs::read_to_string(&exclude_path).unwrap().matches(".potato/").count(), 1);
        assert!(!dir.join(".gitignore").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prepare_outside_git_only_makes_the_folder() {
        let dir = temp("nogit");
        prepare_quick(&dir, "20261111-0930").unwrap();
        assert!(!dir.join(".git").exists());
        assert!(!dir.join(".gitignore").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_linked_worktree_uses_the_shared_exclude_file() {
        let dir = temp("wt");
        let common = dir.join("main.git");
        let gitdir = common.join("worktrees").join("w");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("commondir"), "../..").unwrap();
        let wt = dir.join("w");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        prepare_quick(&wt, "20261111-0930").unwrap();
        assert_eq!(std::fs::read_to_string(common.join("info").join("exclude")).unwrap(), ".potato/\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_in_one_minute_get_different_files() {
        let dir = temp("two");
        let first = prepare_quick(&dir, "20261111-0930").unwrap();
        std::fs::write(&first.path, "a").unwrap();
        let second = prepare_quick(&dir, "20261111-0930").unwrap();
        assert_eq!(second.stamp, "20261111-0930-2");
        assert!(stat_path(Path::new(&first.path)).exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn notes_are_appended_under_always_remember() {
        let dir = temp("notes");
        let got = prepare_quick(&dir, "20261111-0930").unwrap();
        std::fs::write(&got.path, "# Task\nDo it.\n\n").unwrap();
        append_notes(&dir, Some(&got.stamp), "  Reply short.\nNo emojis.  ").unwrap();
        assert_eq!(std::fs::read_to_string(&got.path).unwrap(), "# Task\nDo it.\n\n## Always remember\n\nReply short.\nNo emojis.\n");
        append_notes(&dir, Some(&got.stamp), "   ").unwrap();
        assert!(std::fs::read_to_string(&got.path).unwrap().ends_with("No emojis.\n"));
        assert!(append_notes(&dir, Some("20261111-0000"), "x").is_err(), "a missing file is an error");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn notes_can_go_to_handoff_md_itself() {
        let dir = temp("notes-md");
        std::fs::write(dir.join(HANDOFF_FILE), "# Task
").unwrap();
        append_notes(&dir, None, "Never push.").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(HANDOFF_FILE)).unwrap(), "# Task

## Always remember

Never push.
");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn archive_moves_the_file_and_keeps_the_last_twenty() {
        let project = temp("arc-p");
        let data = temp("arc-d");
        let keep_dir = data.join("handoffs").join(project_slug(&project));
        std::fs::create_dir_all(&keep_dir).unwrap();
        for i in 0..22 {
            std::fs::write(keep_dir.join(format!("handoff-20260101-{i:04}.md")), "old").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        let got = prepare_quick(&project, "20261111-0930").unwrap();
        std::fs::write(&got.path, "new").unwrap();
        let moved = archive_quick(&project, &got.stamp, &data).unwrap();
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "new");
        assert!(!Path::new(&got.path).exists());
        assert_eq!(std::fs::read_dir(&keep_dir).unwrap().count(), QUICK_KEEP);
        assert!(!keep_dir.join("handoff-20260101-0000.md").exists(), "the oldest went first");
        std::fs::remove_dir_all(&project).ok();
        std::fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn a_failed_move_leaves_the_file_in_the_project() {
        let project = temp("fail-p");
        let data = temp("fail-d");
        // "handoffs" in the data folder is a file, so the destination folder cannot be made.
        std::fs::write(data.join("handoffs"), "x").unwrap();
        let got = prepare_quick(&project, "20261111-0930").unwrap();
        std::fs::write(&got.path, "keep me").unwrap();
        assert!(archive_quick(&project, &got.stamp, &data).is_err());
        assert_eq!(std::fs::read_to_string(&got.path).unwrap(), "keep me");
        std::fs::remove_dir_all(&project).ok();
        std::fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn same_named_projects_in_different_places_get_different_slugs() {
        let a = project_slug(Path::new("C:/work/Shop"));
        let b = project_slug(Path::new("D:/other/shop"));
        assert!(a.starts_with("shop-") && b.starts_with("shop-"));
        assert_ne!(a, b);
        assert_eq!(project_slug(Path::new("C:\\work\\Shop")), a);
    }
}
