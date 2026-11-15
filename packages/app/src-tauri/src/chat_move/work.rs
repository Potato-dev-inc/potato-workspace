//! "Take the conversation and the work": the project state travels as git, not as an archive.
//!
//! Near side (`prepare`): the working folder is saved as one commit on a branch `potato/move-<id>`, made from a
//! private copy of the index so the person's own files, index and branch are not touched. A git bundle of that branch
//! (only what the upstream does not have, when there is an upstream) is read into memory.
//!
//! Far side (`receive`): the bundle is checked (`git bundle verify`), fetched into the same branch name, and checked
//! out. A folder that is not a git project, or has unsaved changes, is refused in plain words and nothing is changed.
//!
//! TODO(pm/files/1): the bundle crosses the link as one request body, so it is capped at `BUNDLE_MAX`. When the file
//! transfer (`device_link/files.rs`) lands, send it as a file there and drop the cap.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use sha2::{Digest, Sha256};

/// The biggest bundle sent in one request. A request body is at most 8 MB and the bundle travels as base64 text.
pub const BUNDLE_MAX: usize = 4 * 1024 * 1024;

pub const NOT_GIT: &str = "This folder is not a git project, so the work cannot move. You can still take the conversation.";
pub const NO_COMMITS: &str = "This git project has no saved version yet, so the work cannot move. Save one first, or take the conversation only.";
pub const TOO_BIG: &str = "The work is too big to send over the link yet. Push it to your git remote and pull it there, or take the conversation only.";
pub const FAR_NOT_GIT: &str = "That folder on the other device is not a git project, so the work cannot go there.";
pub const FAR_DIRTY: &str = "That folder on the other device has changes that are not saved. Save or put them aside there first.";
pub const FAR_NOT_SAME: &str = "That project on the other device is not at the same point yet. Update it there (pull), then try again.";
pub const FAR_FAILED: &str = "The other device could not take the work. Nothing was changed there.";
pub const BAD_BRANCH: &str = "That is not a branch name this move would make.";

/// What the near side made.
#[derive(Debug)]
pub struct Bundle {
    pub branch: String,
    pub sha: String,
    pub bytes: Vec<u8>,
}

/// What the far side did.
#[derive(Debug, PartialEq, Eq)]
pub struct Received {
    pub branch: String,
    pub sha: String,
}

/// A short id for one move: unique, not a secret.
pub fn move_id(pane: &str, now_ms: u128) -> String {
    let digest = Sha256::digest(format!("{pane}:{now_ms}").as_bytes());
    digest.iter().take(5).map(|b| format!("{b:02x}")).collect()
}

pub fn branch_for(id: &str) -> String {
    format!("potato/move-{id}")
}

/// `potato/move-` and 6 to 20 lowercase letters or digits: nothing else is ever made into a ref name from outside.
pub fn branch_ok(branch: &str) -> bool {
    branch.strip_prefix("potato/move-").is_some_and(|id| (6..=20).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn git(dir: &Path, args: &[&str], env: &[(&str, &Path)]) -> Result<Out, String> {
    let mut cmd = crate::proc_util::hidden_command("git");
    cmd.args(["-c", "core.quotepath=false"]).args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").stdin(Stdio::null());
    for (key, value) in env {
        cmd.env(key, value);
    }
    let out = cmd.output().map_err(|e| format!("Could not run git: {e}"))?;
    Ok(Out { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() })
}

fn is_work_tree(dir: &Path) -> bool {
    dir.is_dir() && git(dir, &["rev-parse", "--is-inside-work-tree"], &[]).map(|o| o.ok && o.stdout == "true").unwrap_or(false)
}

fn git_dir(dir: &Path) -> Result<PathBuf, String> {
    let out = git(dir, &["rev-parse", "--absolute-git-dir"], &[])?;
    if out.ok {
        Ok(PathBuf::from(out.stdout))
    } else {
        Err(NOT_GIT.into())
    }
}

/// Saves the folder's state to `branch` and bundles it. The folder's own files, index and branch stay as they were.
pub fn prepare(dir: &Path, branch: &str) -> Result<Bundle, String> {
    if !branch_ok(branch) {
        return Err(BAD_BRANCH.into());
    }
    if !is_work_tree(dir) {
        return Err(NOT_GIT.into());
    }
    let head = git(dir, &["rev-parse", "--verify", "HEAD"], &[])?;
    if !head.ok {
        return Err(NO_COMMITS.into());
    }
    let gd = git_dir(dir)?;
    // A private copy of the index: `add -A` here never changes what the person staged.
    let temp_index = gd.join(format!("pm-move-index-{}", branch.trim_start_matches("potato/move-")));
    let real_index = gd.join("index");
    if real_index.exists() {
        std::fs::copy(&real_index, &temp_index).map_err(|e| format!("Could not copy the index: {e}"))?;
    }
    let result = save_snapshot(dir, branch, &temp_index);
    let _ = std::fs::remove_file(&temp_index);
    let sha = result?;
    match make_bundle(dir, branch) {
        Ok(bytes) => Ok(Bundle { branch: branch.to_string(), sha, bytes }),
        Err(e) => {
            // The branch was only for the trip: take it back when the trip cannot happen.
            let _ = git(dir, &["branch", "-D", branch], &[]);
            Err(e)
        }
    }
}

fn save_snapshot(dir: &Path, branch: &str, index: &Path) -> Result<String, String> {
    let env = [("GIT_INDEX_FILE", index)];
    let added = git(dir, &["add", "-A"], &env)?;
    if !added.ok {
        return Err(format!("Could not save the work: {}", added.stderr));
    }
    let tree = git(dir, &["write-tree"], &env)?;
    if !tree.ok {
        return Err(format!("Could not save the work: {}", tree.stderr));
    }
    let commit = git(
        dir,
        &["-c", "user.name=Potato Workspace", "-c", "user.email=move@potato.invalid", "commit-tree", &tree.stdout, "-p", "HEAD", "-m", "Work saved while moving a chat to another device"],
        &[],
    )?;
    if !commit.ok {
        return Err(format!("Could not save the work: {}", commit.stderr));
    }
    let made = git(dir, &["update-ref", &format!("refs/heads/{branch}"), &commit.stdout], &[])?;
    if !made.ok {
        return Err(format!("Could not save the work: {}", made.stderr));
    }
    Ok(commit.stdout)
}

fn make_bundle(dir: &Path, branch: &str) -> Result<Vec<u8>, String> {
    let gd = git_dir(dir)?;
    let file = gd.join(format!("pm-move-{}.bundle", branch.trim_start_matches("potato/move-")));
    let file_text = file.to_string_lossy().to_string();
    // Only what the upstream lacks, when the branch has one: the far device can fetch the rest from the same remote.
    let upstream = git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD@{upstream}"], &[]).ok().filter(|o| o.ok && !o.stdout.is_empty()).map(|o| o.stdout);
    let not = upstream.as_ref().map(|up| format!("^{up}"));
    let mut args = vec!["bundle", "create", file_text.as_str(), branch];
    if let Some(not) = &not {
        args.push(not);
    }
    let made = git(dir, &args, &[])?;
    let read = if made.ok { std::fs::read(&file).map_err(|e| format!("Could not read the bundle: {e}")) } else { Err(format!("Could not pack the work: {}", made.stderr)) };
    let _ = std::fs::remove_file(&file);
    let bytes = read?;
    if bytes.len() > BUNDLE_MAX {
        return Err(TOO_BIG.into());
    }
    Ok(bytes)
}

/// The far side: takes the bundle into the folder and checks the branch out. Nothing is changed when it says no.
pub fn receive(dir: &Path, branch: &str, bytes: &[u8]) -> Result<Received, String> {
    if !branch_ok(branch) || bytes.is_empty() || bytes.len() > BUNDLE_MAX {
        return Err(BAD_BRANCH.into());
    }
    if !is_work_tree(dir) {
        return Err(FAR_NOT_GIT.into());
    }
    let status = git(dir, &["status", "--porcelain"], &[])?;
    if !status.ok || !status.stdout.is_empty() {
        return Err(FAR_DIRTY.into());
    }
    let gd = git_dir(dir)?;
    let file = gd.join(format!("pm-move-in-{}.bundle", branch.trim_start_matches("potato/move-")));
    std::fs::write(&file, bytes).map_err(|e| format!("Could not keep the bundle: {e}"))?;
    let outcome = take(dir, branch, &file);
    let _ = std::fs::remove_file(&file);
    outcome
}

fn take(dir: &Path, branch: &str, file: &Path) -> Result<Received, String> {
    let file_text = file.to_string_lossy().to_string();
    let verified = git(dir, &["bundle", "verify", &file_text], &[])?;
    if !verified.ok {
        return Err(FAR_NOT_SAME.into());
    }
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let fetched = git(dir, &["fetch", "--no-tags", &file_text, &spec], &[])?;
    if !fetched.ok {
        return Err(FAR_FAILED.into());
    }
    let checked = git(dir, &["checkout", branch], &[])?;
    if !checked.ok {
        return Err(FAR_FAILED.into());
    }
    let sha = git(dir, &["rev-parse", "HEAD"], &[])?.stdout;
    Ok(Received { branch: branch.to_string(), sha })
}
