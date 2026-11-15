use super::work::{self, FAR_DIRTY, FAR_NOT_GIT, FAR_NOT_SAME, NOT_GIT};
use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

fn moved(node: &str) -> Moved {
    Moved { node: node.into(), device: "Mac mini".into(), far_pane: "n1".into(), at: 1_700_000_000, mode: "history".into() }
}

// ------------------------------------------------------------------------------------------------ the book

#[test]
fn a_move_is_refused_while_a_reply_runs() {
    let book = Book::new(None);
    assert_eq!(book.begin("p1", true, "history").unwrap_err(), REPLY_RUNNING);
    // Nothing was locked: the chat is as it was.
    assert_eq!(book.status("p1"), Status::None);
    assert_eq!(book.send_refusal("p1"), None);
    assert!(book.begin("p1", false, "history").is_ok());
}

#[test]
fn a_chat_is_locked_while_it_moves_and_opens_again_when_the_move_fails() {
    let book = Book::new(None);
    book.begin("p1", false, "work").unwrap();
    assert_eq!(book.status("p1"), Status::Moving { mode: "work".into() });
    assert_eq!(book.send_refusal("p1").as_deref(), Some(MOVING_NOW));
    // A second move of the same chat is refused too.
    assert_eq!(book.begin("p1", false, "history").unwrap_err(), MOVING_NOW);
    book.abort("p1");
    assert_eq!(book.send_refusal("p1"), None);
    assert!(book.begin("p1", false, "history").is_ok());
}

#[test]
fn the_old_chat_is_read_only_with_the_note_after_it_moved() {
    let book = Book::new(None);
    book.begin("p1", false, "history").unwrap();
    book.finish("p1", moved("a1")).unwrap();
    assert_eq!(book.status("p1"), Status::Moved(moved("a1")));
    assert_eq!(book.send_refusal("p1").as_deref(), Some(ALREADY_MOVED));
    assert_eq!(book.begin("p1", false, "history").unwrap_err(), ALREADY_MOVED);
    // Abort never undoes a move that happened.
    book.abort("p1");
    assert!(matches!(book.status("p1"), Status::Moved(_)));
    // Only a chat that is moving can finish.
    assert!(book.finish("p2", moved("a1")).is_err());
}

#[test]
fn a_moved_note_survives_a_restart_and_a_lock_does_not() {
    let dir = std::env::temp_dir().join(format!("pm-chat-move-book-{}", std::process::id()));
    let file = dir.join("moved-chats.json");
    let _ = std::fs::remove_file(&file);
    let book = Book::new(Some(file.clone()));
    book.begin("p1", false, "history").unwrap();
    book.finish("p1", moved("a1")).unwrap();
    book.begin("p2", false, "work").unwrap();
    let again = Book::new(Some(file.clone()));
    assert_eq!(again.status("p1"), Status::Moved(moved("a1")));
    assert_eq!(again.status("p2"), Status::None);
    // Only device name, time and ids are kept.
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("Mac mini") && !text.contains("conversation"), "{text}");
    let _ = std::fs::remove_file(&file);
}

#[test]
fn only_the_two_ways_to_move_exist() {
    assert!(Book::new(None).begin("p1", false, "everything").is_err());
}

#[test]
fn the_history_message_tells_the_agent_to_read_it_first_and_keeps_an_early_message() {
    let md = "## You\nThe code word is mauve-kettle.\n\n## Agent\nNoted.";
    let text = history_message(md, "Claude", "Desk-PC");
    assert!(text.starts_with("This conversation was moved to you from Claude on Desk-PC. Read it first."));
    assert!(text.contains("mauve-kettle"));
    assert!(text.contains("end of the conversation so far"));
}

#[test]
fn a_very_long_history_keeps_its_start_and_its_end() {
    let md = format!("START-MARK {} END-MARK", "x".repeat(HISTORY_MAX_CHARS * 2));
    let text = history_message(&md, "Claude", "Desk-PC");
    assert!(text.contains("START-MARK") && text.contains("END-MARK"));
    assert!(text.contains("left out"));
    assert!(text.chars().count() < HISTORY_MAX_CHARS + 2_000);
}

// ------------------------------------------------------------------------------------------------ work (git)

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn fresh(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-chat-move-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A bare remote with one commit, and two clones of it (this PC and the far one).
fn remote_and_two_clones(name: &str) -> (PathBuf, PathBuf) {
    let root = fresh(name);
    let remote = root.join("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    let seed = root.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    std::fs::write(seed.join("a.txt"), "one\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "first"]);
    git(&seed, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&seed, &["push", "-q", "origin", "main"]);
    let near = root.join("near");
    let far = root.join("far");
    git(&root, &["clone", "-q", remote.to_str().unwrap(), near.to_str().unwrap()]);
    git(&root, &["clone", "-q", remote.to_str().unwrap(), far.to_str().unwrap()]);
    (near, far)
}

#[test]
fn work_mode_refuses_a_folder_that_is_not_git_with_a_plain_sentence() {
    let dir = fresh("plain");
    std::fs::write(dir.join("notes.txt"), "not saved anywhere").unwrap();
    // A temp folder could sit inside someone's repo; only assert when it does not.
    if Command::new("git").args(["rev-parse", "--is-inside-work-tree"]).current_dir(&dir).output().map(|o| !o.status.success()).unwrap_or(true) {
        let err = work::prepare(&dir, "potato/move-abc123def0").unwrap_err();
        assert_eq!(err, NOT_GIT);
        assert!(!err.contains("fatal"));
    }
}

#[test]
fn work_mode_refuses_a_git_project_with_no_saved_version() {
    let dir = fresh("empty-repo");
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    assert_eq!(work::prepare(&dir, "potato/move-abc123def0").unwrap_err(), work::NO_COMMITS);
}

#[test]
fn only_our_own_branch_names_are_made_into_refs() {
    assert!(work::branch_ok("potato/move-abc123def0"));
    for bad in ["main", "potato/move-", "potato/move-ABC123", "potato/move-../x", "potato/move-abc 123", "potato/move-abc123;rm", "refs/heads/potato/move-abc123"] {
        assert!(!work::branch_ok(bad), "{bad}");
    }
    let dir = fresh("badname");
    assert_eq!(work::prepare(&dir, "main").unwrap_err(), work::BAD_BRANCH);
    assert_eq!(work::receive(&dir, "../../x", b"abc").unwrap_err(), work::BAD_BRANCH);
}

#[test]
fn the_work_travels_as_a_branch_and_the_near_folder_is_left_alone() {
    let (near, far) = remote_and_two_clones("trip");
    // The person's state: an edit, a staged new file and an untracked one.
    std::fs::write(near.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(near.join("staged.txt"), "s").unwrap();
    git(&near, &["add", "staged.txt"]);
    std::fs::write(near.join("loose.txt"), "l").unwrap();
    let status_before = git(&near, &["status", "--porcelain"]);
    let head_before = git(&near, &["rev-parse", "HEAD"]);

    let branch = work::branch_for(&work::move_id("p1", 42));
    let bundle = work::prepare(&near, &branch).unwrap();
    assert!(bundle.bytes.starts_with(b"# v2 git bundle") || bundle.bytes.starts_with(b"# v3 git bundle"));
    // Untouched: same files, same index, same branch.
    assert_eq!(git(&near, &["status", "--porcelain"]), status_before);
    assert_eq!(git(&near, &["rev-parse", "HEAD"]), head_before);
    assert_eq!(git(&near, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    // The branch holds all three changes.
    let files = git(&near, &["ls-tree", "-r", "--name-only", &branch]);
    assert!(files.contains("staged.txt") && files.contains("loose.txt"), "{files}");

    let got = work::receive(&far, &branch, &bundle.bytes).unwrap();
    assert_eq!(got.sha, bundle.sha);
    assert_eq!(git(&far, &["rev-parse", "--abbrev-ref", "HEAD"]), branch);
    assert_eq!(std::fs::read_to_string(far.join("a.txt")).unwrap().replace("\r\n", "\n"), "one\ntwo\n");
    assert_eq!(std::fs::read_to_string(far.join("loose.txt")).unwrap(), "l");
}

#[test]
fn the_far_side_refuses_a_folder_with_unsaved_changes_and_a_folder_that_is_not_git() {
    let (near, far) = remote_and_two_clones("far-refuses");
    std::fs::write(near.join("n.txt"), "n").unwrap();
    let branch = work::branch_for(&work::move_id("p2", 7));
    let bundle = work::prepare(&near, &branch).unwrap();

    std::fs::write(far.join("mine.txt"), "far's own work").unwrap();
    assert_eq!(work::receive(&far, &branch, &bundle.bytes).unwrap_err(), FAR_DIRTY);
    // Nothing changed there.
    assert_eq!(git(&far, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert!(!far.join("n.txt").exists());

    let plain = fresh("far-plain");
    if Command::new("git").args(["rev-parse", "--is-inside-work-tree"]).current_dir(&plain).output().map(|o| !o.status.success()).unwrap_or(true) {
        assert_eq!(work::receive(&plain, &branch, &bundle.bytes).unwrap_err(), FAR_NOT_GIT);
    }
}

#[test]
fn a_far_project_that_is_behind_is_told_to_update_and_is_not_changed() {
    let (near, far) = remote_and_two_clones("behind");
    // The near side moves ahead and pushes; the far one has not pulled.
    std::fs::write(near.join("b.txt"), "b").unwrap();
    git(&near, &["add", "."]);
    git(&near, &["commit", "-q", "-m", "second"]);
    git(&near, &["push", "-q", "origin", "main"]);
    std::fs::write(near.join("c.txt"), "c").unwrap();
    let branch = work::branch_for(&work::move_id("p3", 9));
    let bundle = work::prepare(&near, &branch).unwrap();
    assert_eq!(work::receive(&far, &branch, &bundle.bytes).unwrap_err(), FAR_NOT_SAME);
    assert_eq!(git(&far, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
}

#[test]
fn a_bundle_over_the_cap_is_refused_and_the_trip_branch_is_taken_back() {
    let (near, _far) = remote_and_two_clones("big");
    // Incompressible bytes so the bundle is really bigger than the cap.
    let mut noise = Vec::with_capacity(work::BUNDLE_MAX + 200_000);
    let mut x: u64 = 0x2545F4914F6CDD1D;
    while noise.len() < work::BUNDLE_MAX + 200_000 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        noise.extend_from_slice(&x.to_le_bytes());
    }
    std::fs::write(near.join("big.bin"), &noise).unwrap();
    let branch = work::branch_for(&work::move_id("p4", 11));
    assert_eq!(work::prepare(&near, &branch).unwrap_err(), work::TOO_BIG);
    assert_eq!(git(&near, &["branch", "--list", &branch]), "");
}
