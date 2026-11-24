use super::tree_proof::*;
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
    let dir = std::env::temp_dir().join(format!("pm-tree-proof-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    fs::write(dir.join("a.txt"), "one").unwrap();
    fs::write(dir.join(".gitignore"), "ignored.log\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "first"]);
    dir
}

#[test]
fn a_run_that_touches_nothing_is_tree_unchanged() {
    let dir = repo("clean");
    begin("clean-run", &dir, true, false);
    // An ignored file is not part of the tree.
    fs::write(dir.join("ignored.log"), "noise").unwrap();
    let proof = finish("clean-run", &dir).expect("a look was taken");
    assert_eq!(proof.proof.as_deref(), Some(TREE_UNCHANGED), "{proof:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_new_edited_or_deleted_file_is_tree_changed_with_its_path() {
    let dir = repo("dirty");
    begin("dirty-run", &dir, true, false);
    fs::write(dir.join("new.txt"), "hi").unwrap();
    fs::write(dir.join("a.txt"), "two!").unwrap();
    let proof = finish("dirty-run", &dir).unwrap();
    assert!(proof.changed(), "{proof:?}");
    assert!(proof.changed_paths.contains(&"new.txt".to_string()) && proof.changed_paths.contains(&"a.txt".to_string()), "{proof:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_file_edited_again_while_already_modified_is_still_caught() {
    let dir = repo("again");
    fs::write(dir.join("a.txt"), "dirty before").unwrap();
    begin("again-run", &dir, true, false);
    fs::write(dir.join("a.txt"), "dirty after, longer").unwrap();
    let proof = finish("again-run", &dir).unwrap();
    assert_eq!(proof.changed_paths, vec!["a.txt".to_string()], "{proof:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_new_commit_counts_as_a_change() {
    let dir = repo("commit");
    begin("commit-run", &dir, true, false);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "sneaky"]);
    let proof = finish("commit-run", &dir).unwrap();
    assert!(proof.changed(), "{proof:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_list_of_changed_paths_is_capped() {
    let dir = repo("many");
    begin("many-run", &dir, true, false);
    for n in 0..(MAX_PATHS + 5) {
        fs::write(dir.join(format!("f{n}.txt")), "x").unwrap();
    }
    let proof = finish("many-run", &dir).unwrap();
    assert_eq!((proof.changed_paths.len(), proof.changed_total), (MAX_PATHS, MAX_PATHS + 5));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_folder_that_is_not_a_git_repo_says_why_it_was_not_checked() {
    let dir = std::env::temp_dir().join(format!("pm-tree-proof-plain-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // A temp dir may sit inside a repo on a dev box; only assert when it does not.
    if capture(&dir).is_err() {
        begin("plain-run", &dir, true, false);
        let proof = finish("plain-run", &dir).unwrap();
        assert_eq!((proof.proof, proof.reason.as_deref()), (None, Some("not_a_git_folder")));
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn two_runs_in_one_folder_are_not_checked_for_either() {
    let dir = repo("shared");
    begin("first-run", &dir, true, false);
    begin("second-run", &dir, true, false);
    let first = finish("first-run", &dir).unwrap();
    let second = finish("second-run", &dir).unwrap();
    assert_eq!(first.reason.as_deref(), Some("shared_folder"));
    assert_eq!(second.reason.as_deref(), Some("shared_folder"));
    // A run that is not read-only and started meanwhile spoils it too.
    begin("ro-run", &dir, true, false);
    begin("writer-run", &dir, false, false);
    assert_eq!(finish("ro-run", &dir).unwrap().reason.as_deref(), Some("shared_folder"));
    // And one already working when the read-only run began.
    begin("ro-late", &dir, true, true);
    assert_eq!(finish("ro-late", &dir).unwrap().reason.as_deref(), Some("shared_folder"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_run_that_is_not_read_only_gets_no_look() {
    let dir = repo("writer");
    begin("plain-writer", &dir, false, false);
    assert!(finish("plain-writer", &dir).is_none());
    let _ = fs::remove_dir_all(dir);
}
