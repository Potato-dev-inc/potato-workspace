use super::*;
use std::fs;
use std::path::{Path, PathBuf};

fn git(dir: &Path, args: &[&str]) {
    let out = crate::proc_util::hidden_command("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn repo(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-structured-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    fs::write(dir.join("a.txt"), "one").unwrap();
    fs::write(dir.join("b.txt"), "two").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "first"]);
    dir
}

#[test]
fn a_git_folder_lists_edited_new_and_deleted_files() {
    let dir = repo("changes");
    begin("changes", &dir);
    fs::write(dir.join("a.txt"), "edited").unwrap();
    fs::write(dir.join("new.txt"), "new").unwrap();
    fs::remove_file(dir.join("b.txt")).unwrap();
    let files = finish("changes", &dir);
    assert_eq!(files, vec!["a.txt", "b.txt", "new.txt"]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn files_already_dirty_at_the_start_are_not_blamed_and_a_commit_still_counts() {
    let dir = repo("dirty");
    fs::write(dir.join("a.txt"), "dirty before").unwrap();
    begin("dirty", &dir);
    // The agent commits a new file: the commit moved, `git status` is clean for it.
    fs::write(dir.join("c.txt"), "c").unwrap();
    git(&dir, &["add", "c.txt"]);
    git(&dir, &["commit", "-q", "-m", "second"]);
    let files = finish("dirty", &dir);
    assert_eq!(files, vec!["c.txt"], "{files:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_run_that_changes_nothing_and_a_non_git_folder_give_an_empty_list() {
    let dir = repo("quiet");
    begin("quiet", &dir);
    assert!(finish("quiet", &dir).is_empty());
    let _ = fs::remove_dir_all(dir);

    let plain = std::env::temp_dir().join(format!("pm-structured-plain-{}", std::process::id()));
    let _ = fs::remove_dir_all(&plain);
    fs::create_dir_all(&plain).unwrap();
    begin("plain", &plain);
    fs::write(plain.join("x.txt"), "x").unwrap();
    assert!(finish("plain", &plain).is_empty());
    let _ = fs::remove_dir_all(plain);
}

#[test]
fn the_result_keeps_the_four_fields_with_commands_and_questions() {
    let v = build(
        Some("  Fixed it.\n"),
        &["a.rs".into(), "a.rs".into(), "b.rs".into()],
        &["cargo test".into(), " ".into()],
        &["Which branch?".into()],
    );
    assert_eq!(v["summary"], "Fixed it.");
    assert_eq!(v["files_changed"], json!(["a.rs", "b.rs"]));
    assert_eq!(v["checks_run"], json!(["cargo test"]));
    assert_eq!(v["open_questions"], json!(["Which branch?"]));
}

#[test]
fn an_empty_reply_gives_an_empty_summary_but_still_the_facts() {
    let v = build(None, &["a.rs".into()], &[], &[]);
    assert_eq!(v["summary"], "");
    assert_eq!(v["files_changed"], json!(["a.rs"]));
    assert_eq!(v["checks_run"], json!([]));
    assert_eq!(v["open_questions"], json!([]));
}

#[test]
fn a_long_reply_is_cut_and_an_old_result_block_is_left_out_of_the_summary() {
    let long = "x".repeat(SUMMARY_CHARS + 50);
    assert_eq!(build(Some(&long), &[], &[], &[])["summary"].as_str().unwrap().chars().count(), SUMMARY_CHARS + 1);
    let old = "Done.\n```potato-result\n{\"summary\":\"\",\"files_changed\":[]}\n```";
    assert_eq!(summary_of(old), "Done.");
    assert_eq!(summary_of("```potato-result\n{}\n```"), "");
}
