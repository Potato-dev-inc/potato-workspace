//! Real git, real temp folders: the file-by-file review of a turn and Put back.

use std::path::{Path, PathBuf};

use super::*;
use crate::checkpoints::{test_snapshot, TestKind};

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("pm-ckpt-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn p(&self) -> &Path {
        &self.0
    }
    fn write(&self, rel: &str, text: &str) {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(rel)).ok()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        // git object files are read-only on Windows.
        fn unlock(dir: &Path) {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        unlock(&p);
                    } else if let Ok(m) = std::fs::metadata(&p) {
                        let mut perms = m.permissions();
                        #[allow(clippy::permissions_set_readonly_false)]
                        perms.set_readonly(false);
                        let _ = std::fs::set_permissions(&p, perms);
                    }
                }
            }
        }
        unlock(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn snap(t: &Tmp, kind: TestKind, at: u64) -> String {
    match test_snapshot(t.p(), "p1", kind, None, at, &Limits::default()).expect("snapshot") {
        Snapshot::Created(c) => c.id,
        Snapshot::Unchanged(Some(c)) => c.id,
        Snapshot::Unchanged(None) => panic!("no checkpoint"),
    }
}

/// A turn that edits `a.txt`, adds `new.txt` and deletes `gone.txt`; `keep.txt` is untouched.
fn one_turn() -> (Tmp, String) {
    let t = Tmp::new();
    t.write("a.txt", "one\n");
    t.write("gone.txt", "bye\n");
    t.write("keep.txt", "same\n");
    let before = snap(&t, TestKind::Before, 1_000);
    t.write("a.txt", "two\n");
    t.write("new.txt", "made by the agent\n");
    std::fs::remove_file(t.p().join("gone.txt")).unwrap();
    snap(&t, TestKind::After, 2_000);
    (t, before)
}

fn go(t: &Tmp, before: &str, path: &str) -> Result<PutBackReport, CheckpointError> {
    put_back(t.p(), "p1", before, path, false, 3_000, &Limits::default())
}

#[test]
fn the_review_lists_the_files_of_the_last_turn_with_content_ids() {
    let (t, before) = one_turn();
    let review = turn_review(t.p(), "p1").unwrap().expect("a review");
    assert_eq!(review.before_id, before);
    let names: Vec<(&str, &str)> = review.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
    assert_eq!(names, vec![("a.txt", "M"), ("gone.txt", "D"), ("new.txt", "A")]);
    assert!(review.files.iter().find(|f| f.path == "a.txt").unwrap().blob.len() >= 40);
    assert!(review.files.iter().find(|f| f.path == "gone.txt").unwrap().blob.is_empty());
}

#[test]
fn no_review_when_the_turn_changed_nothing() {
    let t = Tmp::new();
    t.write("a.txt", "one\n");
    snap(&t, TestKind::Before, 1_000);
    snap(&t, TestKind::After, 2_000);
    assert!(turn_review(t.p(), "p1").unwrap().is_none());
}

#[test]
fn put_back_returns_only_that_file_and_undo_brings_the_agents_version_back() {
    let (t, before) = one_turn();
    let report = go(&t, &before, "a.txt").unwrap();
    assert_eq!(report.action, "written");
    assert_eq!(t.read("a.txt").as_deref(), Some("one\n"));
    // The other files of the turn stay as the agent left them.
    assert_eq!(t.read("new.txt").as_deref(), Some("made by the agent\n"));
    assert!(t.read("gone.txt").is_none());
    // Undo: the file comes back from the safety checkpoint.
    let safety = report.safety_id.expect("a safety checkpoint");
    let undone = go(&t, &safety, "a.txt").unwrap();
    assert_eq!(undone.action, "written");
    assert_eq!(t.read("a.txt").as_deref(), Some("two\n"));
}

#[test]
fn put_back_of_a_deleted_file_writes_it_again() {
    let (t, before) = one_turn();
    let report = go(&t, &before, "gone.txt").unwrap();
    assert_eq!(report.action, "written");
    assert_eq!(t.read("gone.txt").as_deref(), Some("bye\n"));
}

#[test]
fn put_back_of_a_file_the_agent_created_removes_only_that_file() {
    let (t, before) = one_turn();
    // Someone else's file made after the turn: never touched.
    t.write("mine.txt", "not the agent's\n");
    let report = go(&t, &before, "new.txt").unwrap();
    assert_eq!(report.action, "removed");
    assert!(t.read("new.txt").is_none());
    assert_eq!(t.read("mine.txt").as_deref(), Some("not the agent's\n"));
    assert_eq!(t.read("keep.txt").as_deref(), Some("same\n"));
}

#[test]
fn put_back_refuses_a_file_the_turn_did_not_change() {
    let (t, before) = one_turn();
    t.write("mine.txt", "not the agent's\n");
    assert!(go(&t, &before, "mine.txt").is_err());
    assert!(go(&t, &before, "keep.txt").is_err());
    assert_eq!(t.read("mine.txt").as_deref(), Some("not the agent's\n"));
}

#[test]
fn put_back_never_leaves_the_project_folder() {
    let (t, before) = one_turn();
    let outside = t.p().parent().unwrap().join(format!("pm-outside-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&outside, "outside").unwrap();
    for bad in ["../outside.txt", "..", "/etc/passwd", "C:/Windows/win.ini", "a/../../x", "a\\b", ""] {
        assert!(go(&t, &before, bad).is_err(), "{bad} must be refused");
    }
    let absolute = outside.to_string_lossy().replace('\\', "/");
    assert!(go(&t, &before, &absolute).is_err());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");
    let _ = std::fs::remove_file(outside);
}

#[test]
fn put_back_is_refused_while_the_agent_works() {
    let (t, before) = one_turn();
    let err = put_back(t.p(), "p1", &before, "a.txt", true, 3_000, &Limits::default()).unwrap_err();
    assert!(matches!(err, CheckpointError::Running));
    assert_eq!(t.read("a.txt").as_deref(), Some("two\n"));
}

#[test]
fn put_back_with_an_unknown_save_point_is_refused() {
    let (t, _) = one_turn();
    assert!(matches!(go(&t, "999", "a.txt").unwrap_err(), CheckpointError::NotFound));
}
