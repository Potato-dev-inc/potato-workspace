//! The repo hand-over on its own (real git, temporary folders): what a bundle carries, what an unpack builds, the size cap,
//! the checks before sending, and what a broken or hostile copy does.

use std::path::Path;

use super::bundle::{self, Assembly};
use super::tests::small_repo;
use super::wire::{self, History, BUNDLE_CAP_BYTES, CHUNK_BYTES};
use crate::team::git;
use crate::team::tests_v1::temp_dir;

fn g(dir: &Path, args: &[&str]) {
    let out = git::raw(dir, args).unwrap();
    assert!(out.ok, "git {args:?}: {}", out.stderr);
}

fn made(history: History, repo: &Path) -> (bundle::Made, std::path::PathBuf) {
    let out = temp_dir("bundle-out");
    (bundle::make(repo, history, "tk_b1", &out).unwrap(), out)
}

#[test]
fn a_hook_and_local_settings_never_travel() {
    let repo = small_repo("bundle-hook", 0);
    // Things that live in the source repo's .git and must not reach the other PC.
    std::fs::write(repo.join(".git").join("hooks").join("post-checkout"), "#!/bin/sh\necho PLANTED > /tmp/planted\n").unwrap();
    g(&repo, &["config", "core.fsmonitor", "planted-monitor"]);
    g(&repo, &["config", "alias.boom", "!echo planted-alias"]);
    g(&repo, &["config", "user.name", "Planted Name"]);
    for history in [History::Latest, History::Full] {
        let (m, _out) = made(history, &repo);
        let parent = temp_dir("bundle-unpack");
        let hooks = temp_dir("bundle-nohooks");
        let folder = bundle::unpack(&m.path, &m.offer, &parent, &hooks, "tk_b1").unwrap();
        assert_eq!(folder, parent.join("potato-site"));
        assert_eq!(std::fs::read_to_string(folder.join("README.md")).unwrap(), "# site\n");
        let hooks_dir = folder.join(".git").join("hooks");
        let planted_hook = hooks_dir.join("post-checkout");
        assert!(!planted_hook.exists(), "a hook must not travel");
        let config = std::fs::read_to_string(folder.join(".git").join("config")).unwrap();
        for word in ["planted-monitor", "planted-alias", "Planted Name", "boom"] {
            assert!(!config.contains(word), "{word} in the new repo's config: {config}");
        }
        // No leftover work folder next to it.
        let names: Vec<_> = std::fs::read_dir(&parent).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, ["potato-site"], "{names:?}");
    }
}

#[test]
fn latest_is_one_commit_and_full_keeps_the_history() {
    let repo = small_repo("bundle-history", 0);
    let top = |h: History| {
        let (m, _out) = made(h, &repo);
        let parent = temp_dir("bundle-hist-unpack");
        let folder = bundle::unpack(&m.path, &m.offer, &parent, &temp_dir("bundle-h2"), "tk_b1").unwrap();
        git::run(&folder, &["rev-list", "--count", "HEAD"]).unwrap()
    };
    assert_eq!(top(History::Latest), "1");
    assert_eq!(top(History::Full), "2");
    // The source branch and its refs are untouched.
    assert_eq!(git::current_branch(&repo).as_deref(), Some("main"));
    assert!(git::run(&repo, &["for-each-ref", "refs/potato-handover"]).unwrap().is_empty());
}

#[test]
fn a_folder_that_is_there_is_never_overwritten() {
    let repo = small_repo("bundle-exists", 0);
    let (m, _out) = made(History::Latest, &repo);
    let parent = temp_dir("bundle-exists-parent");
    std::fs::create_dir_all(parent.join("potato-site")).unwrap();
    std::fs::write(parent.join("potato-site").join("mine.txt"), "keep me").unwrap();
    let hooks = temp_dir("bundle-exists-hooks");
    let first = bundle::unpack(&m.path, &m.offer, &parent, &hooks, "tk_b1").unwrap();
    assert_eq!(first, parent.join("potato-site-2"));
    let second = bundle::unpack(&m.path, &m.offer, &parent, &hooks, "tk_b2").unwrap();
    assert_eq!(second, parent.join("potato-site-3"));
    assert_eq!(std::fs::read_to_string(parent.join("potato-site").join("mine.txt")).unwrap(), "keep me");
    // A parent that is not there is a plain error, nothing is created.
    assert!(bundle::unpack(&m.path, &m.offer, &parent.join("nope"), &hooks, "tk_b3").is_err());
    assert!(!parent.join("nope").exists());
}

#[test]
fn the_size_cap_holds_on_the_sending_side() {
    // A repo of a few MB of noise is over the 2 MB cap in both shapes, and nothing is left behind.
    let repo = small_repo("bundle-cap", (BUNDLE_CAP_BYTES as usize) + 200_000);
    for history in [History::Latest, History::Full] {
        let out = temp_dir("bundle-cap-out");
        let err = bundle::make(&repo, history, "tk_c1", &out).unwrap_err();
        assert!(err.contains("too big"), "{err}");
        assert!(std::fs::read_dir(&out).unwrap().next().is_none(), "no copy is kept when it is too big");
    }
    assert!(git::run(&repo, &["for-each-ref", "refs/potato-handover"]).unwrap().is_empty());
    // Just under the cap goes.
    let small = small_repo("bundle-under-cap", 1_000_000);
    assert!(bundle::make(&small, History::Latest, "tk_c2", &temp_dir("bundle-under-out")).is_ok());
    // And the wire refuses an offer over the cap even if a sender forgot (see tests::an_item_over_a_limit_is_a_bad_item).
    assert!(BUNDLE_CAP_BYTES >= 2 * 1024 * 1024);
}

#[test]
fn only_a_clean_repo_on_a_branch_can_go() {
    let out = temp_dir("bundle-checks-out");
    // Not a repo, not a folder.
    assert!(bundle::make(&temp_dir("bundle-plain"), History::Latest, "a", &out).unwrap_err().contains("not a git repo"));
    assert!(bundle::make(Path::new("Z:/not/there"), History::Latest, "a", &out).unwrap_err().contains("not there"));
    // Uncommitted work.
    let repo = small_repo("bundle-dirty", 0);
    std::fs::write(repo.join("README.md"), "changed\n").unwrap();
    assert!(bundle::make(&repo, History::Latest, "a", &out).unwrap_err().contains("Commit or stash"));
    std::fs::write(repo.join("README.md"), "# site\n").unwrap();
    std::fs::write(repo.join("untracked.txt"), "new\n").unwrap();
    assert!(bundle::make(&repo, History::Latest, "a", &out).unwrap_err().contains("Commit or stash"));
    std::fs::remove_file(repo.join("untracked.txt")).unwrap();
    // A detached HEAD has no branch to name.
    g(&repo, &["checkout", "-q", "--detach"]);
    assert!(bundle::make(&repo, History::Latest, "a", &out).unwrap_err().contains("Switch to a branch"));
    // An empty repo.
    let empty = temp_dir("bundle-empty");
    g(&empty, &["init", "-q", "-b", "main"]);
    assert!(bundle::make(&empty, History::Latest, "a", &out).unwrap_err().contains("no commits"));
}

#[test]
fn a_broken_or_changed_copy_leaves_no_folder() {
    let repo = small_repo("bundle-broken", 5000);
    let (m, _out) = made(History::Latest, &repo);
    let parent = temp_dir("bundle-broken-parent");
    let hooks = temp_dir("bundle-broken-hooks");
    // One changed byte: the checksum no longer matches.
    let mut bytes = std::fs::read(&m.path).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 1;
    let bad = parent.join("bad.bundle");
    std::fs::write(&bad, &bytes).unwrap();
    assert!(bundle::unpack(&bad, &m.offer, &parent, &hooks, "tk_x1").unwrap_err().contains("whole"));
    // The right bytes, but the offer names a ref that is not in the bundle: git fails and the work folder is removed.
    let mut wrong = m.offer.clone();
    wrong.git_ref = "refs/heads/nothing-here".into();
    assert!(bundle::unpack(&m.path, &wrong, &parent, &hooks, "tk_x2").is_err());
    // A ref outside the two allowed places is refused before git is asked.
    let mut outside = m.offer.clone();
    outside.git_ref = "refs/remotes/origin/main".into();
    assert!(bundle::unpack(&m.path, &outside, &parent, &hooks, "tk_x3").unwrap_err().contains("branch"));
    let names: Vec<_> = std::fs::read_dir(&parent).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    assert_eq!(names, ["bad.bundle"], "no half folder is left: {names:?}");
}

#[test]
fn pieces_come_in_any_order_twice_and_only_at_the_right_size() {
    let total = 3;
    let bytes = (CHUNK_BYTES * 2 + 100) as u64;
    let offer = wire::RepoOffer { name: "r".into(), branch: "main".into(), git_ref: "refs/heads/main".into(), history: History::Full, bytes, sha256: "00".repeat(32), chunks: total };
    let dir = temp_dir("bundle-asm");
    let mut a = Assembly::start(dir.join("x.part"), &offer).unwrap();
    let full = vec![7u8; CHUNK_BYTES];
    // Out of order, a repeat, a wrong size, one past the end.
    assert_eq!(a.push(2, &[9u8; 100]), Ok(true));
    assert_eq!(a.push(2, &[9u8; 100]), Ok(false));
    assert!(a.push(0, &full[..10]).is_err());
    assert!(a.push(1, &[1u8; 101]).is_err());
    assert!(a.push(3, &full).is_err());
    assert!(!a.complete());
    assert_eq!(a.push(0, &full), Ok(true));
    assert_eq!(a.push(1, &full), Ok(true));
    assert!(a.complete());
    let written = std::fs::read(dir.join("x.part")).unwrap();
    assert_eq!(written.len() as u64, bytes);
    assert_eq!(&written[..CHUNK_BYTES], &full[..]);
    assert_eq!(&written[CHUNK_BYTES * 2..], &[9u8; 100][..]);
}

#[test]
fn folder_names_are_safe() {
    assert_eq!(bundle::safe_folder_name("potato-site"), "potato-site");
    let evil = bundle::safe_folder_name(r"..\..\evil/x");
    assert!(!evil.contains(['/', '\\']) && !evil.starts_with('.'), "{evil}");
    assert_eq!(bundle::safe_folder_name("..."), "repo");
    assert_eq!(bundle::safe_folder_name(""), "repo");
    let n = bundle::safe_folder_name(&"a".repeat(200));
    assert_eq!(n.len(), 60);
    assert!(!bundle::safe_folder_name("a/b\\c:d").contains(['/', '\\', ':']));
}
