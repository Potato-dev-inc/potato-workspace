//! The git branch of a pane's folder, for the session rail. Any folder, any agent: it reads the folder
//! the pane runs in, nothing more.

use super::AppState;
use std::path::Path;
use tauri::State;

pub(crate) use pm_core::files::git::branch_of;

static BRANCHES: std::sync::LazyLock<super::brief_cache::BriefCache<Option<String>>> =
    std::sync::LazyLock::new(|| super::brief_cache::BriefCache::new(std::time::Duration::from_millis(1500)));

/// The git branch of the folder this pane works in, or null for a folder that is not a git work tree.
#[tauri::command]
pub async fn pane_git_branch(state: State<'_, AppState>, pane_id: String) -> Result<Option<String>, String> {
    if crate::acp::chat::is_remote_pane(&pane_id) {
        return Ok(None);
    }
    let Some(cwd) = state.registry.lock().list().into_iter().find(|p| p.id == pane_id).map(|p| p.cwd) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || BRANCHES.get_or(&cwd, || branch_of(Path::new(&cwd))))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@example.com"]).args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-pane-git-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn a_plain_folder_has_no_branch() {
        let dir = temp("plain");
        // A temp folder could sit inside someone's repo; only assert when it does not.
        if crate::team::git::run(&dir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
            assert_eq!(branch_of(&dir), None);
        }
    }

    #[test]
    fn a_missing_folder_has_no_branch() {
        assert_eq!(branch_of(Path::new("no-such-folder-pm/at/all")), None);
    }

    #[test]
    fn a_repo_reports_its_branch_and_a_detached_head() {
        let dir = temp("repo");
        git(&dir, &["init", "-q", "-b", "rail-branch"]);
        assert_eq!(branch_of(&dir).as_deref(), Some("rail-branch"));
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        git(&dir, &["checkout", "-q", "--detach"]);
        assert!(branch_of(&dir).unwrap().starts_with("detached at "));
    }
}
