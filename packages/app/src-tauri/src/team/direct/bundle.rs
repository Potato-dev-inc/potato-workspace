//! Repo hand-over ("use at own risk"): a copy of one git branch as a git bundle, cut into pieces for the team relay, put back
//! together, checked, and unpacked into a NEW folder the person picks. Nothing here runs a hook, a script or the repo's code.
//!
//! Why the relay and not the direct PC link: the direct link for files between teammates' PCs (`pm/files/1`) is not built
//! yet. The relay path needs no new network door: every piece is one more sealed item through the same checks as the
//! task itself, and the size cap ([`super::wire::BUNDLE_CAP_BYTES`], 2 MB) is what keeps it honest. The default copy is one
//! commit with the files as they are, which is small and leaves the history at home.
//!
//! What a bundle can carry: objects and refs. Not hooks, not `.git/config`, not untracked or ignored files. The receiver
//! makes a fresh repo with its own settings, with hooks switched off and symlinks written as plain files, and fetches the
//! bundle into it.

use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::wire::{valid_branch_text, valid_ref, History, RepoOffer, BUNDLE_CAP_BYTES, CHUNK_BYTES};
use crate::team::git;

/// A bundle made on this PC, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Made {
    pub path: PathBuf,
    pub offer: RepoOffer,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn chunk_count(bytes: u64) -> u32 {
    bytes.div_ceil(CHUNK_BYTES as u64) as u32
}

/// Why this folder can't go along (plain words), or the repo's top folder and its current branch.
pub fn check_repo(dir: &Path) -> Result<(PathBuf, String), String> {
    if !dir.is_dir() {
        return Err("That folder is not there.".into());
    }
    let top = git::toplevel(dir).ok_or("That folder is not a git repo.")?;
    let branch = git::current_branch(&top).ok_or("Switch to a branch first. This repo has none checked out.")?;
    if !valid_branch_text(&branch) {
        return Err("This branch name can't be sent. Rename the branch first.".into());
    }
    if git::rev_parse(&top, "HEAD").is_none() {
        return Err("This repo has no commits yet.".into());
    }
    if git::is_dirty(&top) {
        return Err("Commit or stash first. Only what is committed goes along.".into());
    }
    Ok((top, branch))
}

/// Makes the bundle of the repo at `dir`'s current branch into `out_dir/<id>.bundle`. The source repo is only read; for
/// `Latest` a temporary ref names the one-commit copy and is deleted again, win or lose.
pub fn make(dir: &Path, history: History, id: &str, out_dir: &Path) -> Result<Made, String> {
    let (top, branch) = check_repo(dir)?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("Could not make a folder for the copy: {e}"))?;
    let path = out_dir.join(format!("{id}.bundle"));
    let _ = std::fs::remove_file(&path);
    let path_s = path.to_string_lossy().to_string();
    let (git_ref, temp_ref) = match history {
        History::Full => (format!("refs/heads/{branch}"), None),
        History::Latest => {
            let temp = format!("refs/potato-handover/{id}");
            let tree = git::run(&top, &["rev-parse", "--verify", "-q", "HEAD^{tree}"]).map_err(|e| format!("Could not read the branch: {e}"))?;
            let head = git::rev_parse(&top, "HEAD").unwrap_or_default();
            let msg = format!("Copy of {branch} at {}", head.get(..8).unwrap_or(&head));
            let args = git::with_identity(&top, &["commit-tree", &tree, "-m", &msg]);
            let commit = git::run(&top, &args).map_err(|e| format!("Could not make the copy: {e}"))?;
            git::run(&top, &["update-ref", &temp, &commit]).map_err(|e| format!("Could not make the copy: {e}"))?;
            (temp.clone(), Some(temp))
        }
    };
    let made = git::run(&top, &["bundle", "create", &path_s, &git_ref]);
    if let Some(temp) = &temp_ref {
        let _ = git::run(&top, &["update-ref", "-d", temp]);
    }
    made.map_err(|e| format!("Could not pack the repo: {e}"))?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the copy: {e}"))?;
    let size = bytes.len() as u64;
    if size > BUNDLE_CAP_BYTES {
        let _ = std::fs::remove_file(&path);
        let hint = if history == History::Full { " Try “Only the latest files”." } else { "" };
        return Err(format!("This repo is too big to send this way ({} MB; the most is {} MB).{hint}", size.div_ceil(1_000_000), BUNDLE_CAP_BYTES / 1_048_576));
    }
    let name = top.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
    let offer = RepoOffer {
        name: super::wire::clean_line(&name, super::wire::MAX_NAME_CHARS),
        branch,
        git_ref,
        history,
        bytes: size,
        sha256: sha256_hex(&bytes),
        chunks: chunk_count(size),
    };
    Ok(Made { path, offer })
}

/// The receiver's copy of a bundle that is arriving. Pieces may come in any order (and twice); each goes to its own place in
/// the part file, and only a piece of exactly the right size is taken.
pub struct Assembly {
    pub path: PathBuf,
    pub total: u32,
    have: Vec<bool>,
    pub got: u32,
    want_bytes: u64,
}

impl Assembly {
    /// Starts an empty part file at `path` for an offer.
    pub fn start(path: PathBuf, offer: &RepoOffer) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        f.set_len(offer.bytes).map_err(|e| e.to_string())?;
        Ok(Self { path, total: offer.chunks, have: vec![false; offer.chunks as usize], got: 0, want_bytes: offer.bytes })
    }

    /// Takes piece `idx`. A repeat is ignored; a piece past the end or of the wrong size is refused.
    pub fn push(&mut self, idx: u32, data: &[u8]) -> Result<bool, String> {
        if idx >= self.total {
            return Err("A piece arrived that does not belong.".into());
        }
        let start = idx as u64 * CHUNK_BYTES as u64;
        let want_len = (self.want_bytes - start).min(CHUNK_BYTES as u64);
        if data.len() as u64 != want_len {
            return Err("A piece was the wrong size.".into());
        }
        if self.have[idx as usize] {
            return Ok(false);
        }
        let mut f = std::fs::OpenOptions::new().write(true).open(&self.path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())?;
        self.have[idx as usize] = true;
        self.got += 1;
        Ok(true)
    }

    pub fn complete(&self) -> bool {
        self.got == self.total
    }
}

/// The whole file is what the offer said: its size and its checksum.
pub fn verify(path: &Path, offer: &RepoOffer) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read the copy: {e}"))?;
    if bytes.len() as u64 != offer.bytes || sha256_hex(&bytes) != offer.sha256 {
        return Err("The copy did not arrive whole. Ask them to send it again.".into());
    }
    Ok(())
}

/// A folder name that is safe on every system, from the sender's display name.
pub fn safe_folder_name(raw: &str) -> String {
    let cleaned: String = raw.chars().map(|c| if c.is_alphanumeric() || "-_. ".contains(c) { c } else { '-' }).collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() { "repo".into() } else { trimmed.chars().take(60).collect() }
}

/// `parent/name`, or `parent/name-2`, `-3`, ... : the first that is not there. Never an existing folder.
pub fn free_folder(parent: &Path, name: &str) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() {
        return first;
    }
    (2..).map(|n| parent.join(format!("{name}-{n}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Unpacks a checked bundle into a NEW folder under `parent` and returns it. A fresh repo with hooks switched off (`hooks_dir`
/// is an empty folder) and symlinks written as plain files; the bundle is fetched into the branch the offer names and that
/// branch is checked out. Built in a hidden folder next to the final one and renamed at the end, so a failure leaves nothing.
pub fn unpack(bundle: &Path, offer: &RepoOffer, parent: &Path, hooks_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !parent.is_dir() {
        return Err("Pick a folder that is there.".into());
    }
    if !valid_ref(&offer.git_ref) || !valid_branch_text(&offer.branch) {
        return Err("The copy names a branch that can't be used.".into());
    }
    verify(bundle, offer)?;
    std::fs::create_dir_all(hooks_dir).map_err(|e| e.to_string())?;
    let work = parent.join(format!(".potato-unpack-{id}"));
    if work.exists() {
        return Err("A copy is already being unpacked there.".into());
    }
    std::fs::create_dir(&work).map_err(|e| format!("Could not make the folder: {e}"))?;
    let result = unpack_into(&work, bundle, offer, hooks_dir).and_then(|_| {
        let target = free_folder(parent, &safe_folder_name(&offer.name));
        std::fs::rename(&work, &target).map_err(|e| format!("Could not finish the folder: {e}"))?;
        Ok(target)
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&work);
    }
    result
}

fn unpack_into(work: &Path, bundle: &Path, offer: &RepoOffer, hooks_dir: &Path) -> Result<(), String> {
    let hooks = format!("core.hooksPath={}", hooks_dir.to_string_lossy());
    let safe = ["-c", hooks.as_str(), "-c", "core.symlinks=false", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false"];
    let run = |rest: &[&str]| -> Result<String, String> {
        let mut args: Vec<&str> = safe.to_vec();
        args.extend_from_slice(rest);
        git::run(work, &args)
    };
    run(&["init", "-q"]).map_err(|e| format!("Could not start the folder: {e}"))?;
    let bundle_s = bundle.to_string_lossy().to_string();
    let spec = format!("+{}:refs/heads/{}", offer.git_ref, offer.branch);
    run(&["fetch", "-q", &bundle_s, &spec]).map_err(|e| format!("The copy could not be opened: {e}"))?;
    run(&["checkout", "-q", &offer.branch]).map_err(|e| format!("The files could not be put out: {e}"))?;
    Ok(())
}
