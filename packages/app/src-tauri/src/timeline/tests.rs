//! Real `git`, real temp folders. No app, no windows.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::journal::{date_of, folder_key, same_or_inside, valid_date, Journal, Row};
use super::{day_view, TimelineError};
use crate::checkpoints::engine::{self, kept_count, Checkpoint, CheckpointError, Kind, Limits, Snapshot};
use crate::checkpoints::{PaneFacts, Runtime, TestEnv as Env, TestOutcome as Outcome, TestSettings as Settings};

/// A temp folder. Git objects are read-only on Windows, so drop makes them writable first.
struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("pm-tl-{tag}-{}", uuid::Uuid::new_v4()));
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
    fn exists(&self, rel: &str) -> bool {
        self.0.join(rel).exists()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
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

fn user_git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_OPTIONAL_LOCKS", "0").env("GIT_CONFIG_GLOBAL", "").output().expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A hash of every file of a folder except the checkpoint store, for "nothing changed".
fn folder_hash(dir: &Path) -> String {
    fn walk(dir: &Path, base: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            if rel.starts_with(".potato-workspace") {
                continue;
            }
            if p.is_dir() {
                walk(&p, base, out);
            } else {
                out.insert(rel, std::fs::read(&p).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(dir, dir, &mut files);
    let mut hasher = Sha256::new();
    for (name, bytes) in files {
        hasher.update(name.as_bytes());
        hasher.update(&bytes);
    }
    format!("{:x}", hasher.finalize())
}

fn refs(dir: &Path) -> Vec<String> {
    let shadow = crate::checkpoints::engine::list_all(dir).unwrap();
    let mut names: Vec<String> = shadow.iter().map(|c| format!("{}/{}", c.pane_id, c.id)).collect();
    names.sort();
    names
}

struct TlEnv {
    panes: Mutex<Vec<(String, PaneFacts)>>,
    now: AtomicU64,
    journal: Mutex<Option<PathBuf>>,
    run_open: AtomicBool,
}

impl TlEnv {
    fn new(journal: &Path) -> Arc<Self> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        Arc::new(Self { panes: Mutex::new(vec![]), now: AtomicU64::new(now), journal: Mutex::new(Some(journal.to_path_buf())), run_open: AtomicBool::new(false) })
    }
    fn add(&self, id: &str, dir: &Path, agent: &str, status: &str) {
        self.panes.lock().push((id.into(), PaneFacts { cwd: dir.to_string_lossy().into(), agent_type: agent.into(), status: status.into() }));
    }
    fn set_status(&self, id: &str, status: &str) {
        for (pid, facts) in self.panes.lock().iter_mut() {
            if pid == id {
                facts.status = status.into();
            }
        }
    }
    fn remove(&self, id: &str) {
        self.panes.lock().retain(|(pid, _)| pid != id);
    }
    fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Env for TlEnv {
    fn pane(&self, id: &str) -> Option<PaneFacts> {
        self.panes.lock().iter().find(|(pid, _)| pid == id).map(|(_, f)| f.clone())
    }
    fn settings(&self) -> Settings {
        Settings { enabled: true, keep: 50 }
    }
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn agent_takes_part(&self, _agent: &str) -> bool {
        true
    }
    fn run_open(&self, _pane_id: &str, _pane: &PaneFacts) -> bool {
        self.run_open.load(Ordering::SeqCst)
    }
    fn journal_dir(&self) -> Option<PathBuf> {
        self.journal.lock().clone()
    }
    fn pane_title(&self, pane_id: &str) -> Option<String> {
        Some(format!("Chat {pane_id}"))
    }
    fn all_panes(&self) -> Vec<(String, PaneFacts)> {
        self.panes.lock().clone()
    }
}

struct Rig {
    project: Tmp,
    journal: Tmp,
    env: Arc<TlEnv>,
    rt: Runtime,
}

impl Rig {
    fn new(tag: &str) -> Self {
        let project = Tmp::new(&format!("{tag}-project"));
        let journal = Tmp::new(&format!("{tag}-journal"));
        let env = TlEnv::new(&journal.p().join("timeline"));
        env.add("p1", project.p(), "claude", "idle");
        let rt = Runtime::new(env.clone());
        Rig { project, journal, env, rt }
    }
    /// Take an "after" save point for `pane` (ten seconds later than the last one, past the debounce).
    fn after(&self, pane: &str) -> Checkpoint {
        self.env.advance(20_000);
        match self.rt.capture(pane, Kind::After, None) {
            Outcome::Created(c) => c,
            other => panic!("expected a save point, got {other:?}"),
        }
    }
    fn journal(&self) -> Journal {
        self.rt.journal().expect("journal")
    }
    fn today(&self) -> String {
        date_of(self.env.now_ms())
    }
    fn rows(&self) -> Vec<Row> {
        self.journal().read_day(&self.today())
    }
}

// ---- the journal -------------------------------------------------------------------------

#[test]
fn a_snapshot_that_creates_a_point_appends_exactly_one_row_and_an_unchanged_one_none() {
    let rig = Rig::new("rows");
    rig.project.write("a.txt", "one");
    let made = rig.after("p1");
    let rows = rig.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].key.as_str(), rows[0].id.as_str(), rows[0].kind.as_str()), ("p1", made.id.as_str(), "after"));
    assert_eq!(rows[0].tree, made.tree);
    assert_eq!(rows[0].agent_type, "claude");
    assert_eq!(rows[0].chat_title, "Chat p1");
    assert_eq!(folder_key(&rows[0].project), folder_key(&rig.project.p().to_string_lossy()));

    rig.env.advance(20_000);
    assert!(matches!(rig.rt.capture("p1", Kind::After, None), Outcome::Unchanged));
    assert_eq!(rig.rows().len(), 1, "an unchanged snapshot adds no row");
}

#[test]
fn a_journal_that_cannot_be_written_does_not_fail_the_snapshot() {
    let rig = Rig::new("nowrite");
    // The journal "folder" is a file: creating it fails.
    let blocker = rig.journal.p().join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    *rig.env.journal.lock() = Some(blocker);
    rig.project.write("a.txt", "one");
    let made = rig.after("p1");
    assert_eq!(made.kind, "after");
    assert_eq!(engine::list(rig.project.p(), "p1").unwrap().len(), 1, "the save point exists");
}

#[test]
fn a_restore_with_a_live_chat_journals_its_safety_point_as_an_undo_mark() {
    let rig = Rig::new("liverestore");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    rig.project.write("a.txt", "v2 not saved");
    rig.rt.restore("p1", &first.id).unwrap();
    let rows = rig.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[1].kind.as_str(), rows[1].key.as_str()), ("undo", "p1"));
}

#[test]
fn the_journal_keeps_14_days_and_removes_older_files() {
    let dir = Tmp::new("days");
    let journal = Journal::new(dir.p().join("timeline"));
    std::fs::create_dir_all(journal.dir()).unwrap();
    for day in ["2026-11-15", "2026-11-01", "2026-10-31", "2026-10-01"] {
        std::fs::write(journal.dir().join(format!("{day}.jsonl")), "{}\n").unwrap();
    }
    std::fs::write(journal.dir().join("notes.txt"), "keep me").unwrap();
    assert_eq!(journal.cleanup("2026-11-15"), 2, "the 14th day back stays, older ones go");
    let mut left: Vec<String> = std::fs::read_dir(journal.dir()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    left.sort();
    assert_eq!(left, ["2026-11-01.jsonl", "2026-11-15.jsonl", "notes.txt"]);
    assert_eq!(journal.recent_dates("2026-11-15"), ["2026-11-15", "2026-11-01"]);
}

#[test]
fn only_a_real_date_can_name_a_day_file() {
    assert!(valid_date("2026-11-15"));
    for bad in ["", "2026-13-01", "2026-11-1", "../secret", "2026-11-15.jsonl", "2026/11/15"] {
        assert!(!valid_date(bad), "{bad}");
    }
    let dir = Tmp::new("baddate");
    assert!(Journal::new(dir.p()).read_day("../x").is_empty());
}

#[test]
fn folder_spellings_compare_equal_and_nesting_is_by_whole_folder_names() {
    assert_eq!(folder_key("C:\\Work\\App\\"), folder_key("c:/work/app"));
    assert!(same_or_inside("C:/work/app/.worktrees/a", "c:\\work\\app"));
    assert!(same_or_inside("/a/b", "/a/b"));
    assert!(!same_or_inside("/a/bc", "/a/b"), "a longer name is not inside");
}

// ---- two chats in one folder ----------------------------------------------------------------

#[test]
fn two_chats_in_one_folder_share_a_lane_and_the_state_at_a_time_is_the_newest_point_of_either() {
    let rig = Rig::new("twochats");
    rig.env.add("p2", rig.project.p(), "codex", "idle");
    rig.project.write("a.txt", "a1");
    let a1 = rig.after("p1");
    rig.project.write("b.txt", "b1");
    let b1 = rig.after("p2");
    rig.project.write("a.txt", "a2");
    let a2 = rig.after("p1");

    let view = day_view(&rig.rt, &rig.today()).unwrap();
    assert_eq!(view.lanes.len(), 1, "one folder, one lane");
    let order: Vec<(&str, &str)> = view.lanes[0].rows.iter().map(|r| (r.row.key.as_str(), r.row.id.as_str())).collect();
    assert_eq!(order, [("p1", a1.id.as_str()), ("p2", b1.id.as_str()), ("p1", a2.id.as_str())], "oldest first, across both chats");

    // "The folder at the time of b1" is the newest point at or before it: b1 itself, whichever chat made it.
    let at = view.lanes[0].rows.iter().filter(|r| r.row.at_ms <= b1.at_ms).max_by_key(|r| r.row.at_ms).unwrap();
    assert_eq!((at.row.key.as_str(), at.row.id.as_str()), ("p2", b1.id.as_str()));
    rig.rt.go_back(rig.project.p(), &at.row.key, &at.row.id).unwrap();
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("a1"));
    assert_eq!(rig.project.read("b.txt").as_deref(), Some("b1"), "the other chat's file is part of that moment");
}

// ---- the prune rule ---------------------------------------------------------------------------

fn points(count: usize, start_ms: u64, step_ms: u64) -> Vec<Checkpoint> {
    (0..count)
        .map(|i| Checkpoint {
            id: (i + 1).to_string(),
            commit: String::new(),
            pane_id: "p".into(),
            turn: 1,
            kind: "after".into(),
            label: String::new(),
            note: String::new(),
            at_ms: start_ms + i as u64 * step_ms,
            files: 1,
            added: 1,
            deleted: 0,
            tree: String::new(),
        })
        .collect()
}

#[test]
fn the_prune_rule_keeps_the_day_up_to_300_and_otherwise_the_newest_50() {
    let hour = 3_600_000_u64;
    let day = 24 * hour;
    let now = 100 * day;
    let limits = Limits::default();
    // 120 points made within one hour: all stay.
    assert_eq!(kept_count(&points(120, now - hour, 20_000), &limits, now), 120);
    // The same 120 points, 25 hours old: only 50 stay.
    assert_eq!(kept_count(&points(120, now - 25 * hour, 20_000), &limits, now), 50);
    // 400 points today: 300 stay.
    assert_eq!(kept_count(&points(400, now - 2 * hour, 10_000), &limits, now), 300);
    // A keep setting above the cap is still honoured.
    assert_eq!(kept_count(&points(400, now - 25 * hour, 10_000), &Limits { keep: 350, ..Limits::default() }, now), 350);
    // Points just inside and just outside 24 hours.
    let mixed: Vec<Checkpoint> = points(60, now - 25 * hour, 1_000).into_iter().chain(points(70, now - 23 * hour, 1_000)).collect();
    assert_eq!(kept_count(&mixed, &limits, now), 70, "only the 70 young ones, and the newest 50 are among them");
    assert!(kept_count(&points(10, now, 1), &limits, now) >= 10, "fewer than keep: all stay");
}

#[test]
fn real_snapshots_follow_the_prune_rule() {
    let project = Tmp::new("prune");
    let limits = Limits { keep: 3, day_cap: 7, ..Limits::default() };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    // Ten points made now: the day window keeps 7 (the cap), not the newest 3.
    for i in 0..10_u64 {
        project.write("a.txt", &format!("v{i}"));
        engine::snapshot(project.p(), "p1", Kind::After, None, now + i, &limits).unwrap();
    }
    assert_eq!(engine::list(project.p(), "p1").unwrap().len(), 7);
    // Ten points made 25 hours ago (all young when they were made, so the cap keeps 7), then one more
    // snapshot now: the old ones are no longer from today, so only the newest 3 and the new one's room stay.
    let aging = Limits { keep: 3, day_cap: 7, ..Limits::default() };
    for i in 0..10_u64 {
        project.write("b.txt", &format!("v{i}"));
        engine::snapshot(project.p(), "old", Kind::After, None, now - 25 * 3_600_000 + i, &aging).unwrap();
    }
    assert_eq!(engine::list(project.p(), "old").unwrap().len(), 7);
    project.write("b.txt", "now");
    engine::snapshot(project.p(), "old", Kind::After, None, now, &aging).unwrap();
    assert_eq!(engine::list(project.p(), "old").unwrap().len(), 3);
}

// ---- going back for a closed chat --------------------------------------------------------------

#[test]
fn going_back_works_for_a_closed_chat_writes_a_day_safety_point_and_undo_brings_the_files_back() {
    let rig = Rig::new("closed");
    rig.project.write("a.txt", "v1");
    rig.project.write("sub/b.txt", "bee");
    let first = rig.after("p1");
    rig.project.write("a.txt", "v2");
    rig.project.write("new.txt", "fresh");
    std::fs::remove_file(rig.project.p().join("sub/b.txt")).unwrap();
    rig.after("p1");
    rig.project.write("a.txt", "v3 typed by hand, in no save point");
    // The chat is closed: it is not a pane any more.
    rig.env.remove("p1");

    let report = rig.rt.go_back(rig.project.p(), "p1", &first.id).unwrap();
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("v1"));
    assert_eq!(rig.project.read("sub/b.txt").as_deref(), Some("bee"));
    assert!(!rig.project.exists("new.txt"));

    let safety_id = report.safety_id.clone().expect("a safety point");
    let day = engine::list(rig.project.p(), "day").unwrap();
    assert_eq!(day.len(), 1, "it lives under refs/pm/day");
    assert_eq!((day[0].id.as_str(), day[0].kind.as_str()), (safety_id.as_str(), "undo"));
    assert!(rig.rows().iter().any(|r| r.key == "day" && r.kind == "undo"), "the go-back is a mark on the line");

    // Restoring the safety point brings every file back, byte for byte.
    rig.rt.go_back(rig.project.p(), "day", &safety_id).unwrap();
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("v3 typed by hand, in no save point"));
    assert_eq!(rig.project.read("new.txt").as_deref(), Some("fresh"));
    assert!(!rig.project.exists("sub/b.txt"));
}

#[test]
fn going_back_is_refused_while_any_chat_in_the_folder_works_and_nothing_changes() {
    let rig = Rig::new("busy");
    rig.env.add("p2", rig.project.p(), "codex", "idle");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    rig.project.write("a.txt", "v2");
    let before_hash = folder_hash(rig.project.p());
    let before_refs = refs(rig.project.p());

    // Another chat in the same folder is working.
    rig.env.set_status("p2", "running");
    assert!(matches!(rig.rt.go_back(rig.project.p(), "p1", &first.id), Err(CheckpointError::Running)));
    rig.env.set_status("p2", "idle");

    // A run is still open on an idle chat.
    rig.env.run_open.store(true, Ordering::SeqCst);
    assert!(matches!(rig.rt.go_back(rig.project.p(), "p1", &first.id), Err(CheckpointError::RunOpen)));
    rig.env.run_open.store(false, Ordering::SeqCst);

    assert_eq!(folder_hash(rig.project.p()), before_hash, "no file changed");
    assert_eq!(refs(rig.project.p()), before_refs, "not even a safety point");

    // Then it works.
    rig.rt.go_back(rig.project.p(), "p1", &first.id).unwrap();
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("v1"));
}

#[test]
fn a_chat_in_a_worktree_inside_the_project_or_around_it_blocks_a_go_back() {
    let rig = Rig::new("worktree");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    rig.project.write("a.txt", "v2");
    let inside = rig.project.p().join(".worktrees").join("helper");
    std::fs::create_dir_all(&inside).unwrap();
    rig.env.add("helper", &inside, "claude", "running");
    assert!(matches!(rig.rt.go_back(rig.project.p(), "p1", &first.id), Err(CheckpointError::Running)), "a worktree inside the project");
    rig.env.remove("helper");
    let unrelated = Tmp::new("worktree-other");
    rig.env.add("elsewhere", unrelated.p(), "claude", "running");
    rig.rt.go_back(rig.project.p(), "p1", &first.id).expect("a chat in another folder does not block");
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("v1"));
}

#[test]
fn a_go_back_is_refused_when_the_folder_is_gone_or_checkpoints_are_off() {
    let rig = Rig::new("gone");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    let missing = rig.project.p().join("nope");
    assert!(matches!(rig.rt.go_back(&missing, "p1", &first.id), Err(CheckpointError::FolderGone)));
}

// ---- reading without writing --------------------------------------------------------------------

#[test]
fn the_now_diff_lists_what_going_back_would_change_and_writes_no_ref_and_no_file() {
    let rig = Rig::new("nowdiff");
    rig.project.write("keep.txt", "same");
    rig.project.write("edit.txt", "old");
    rig.project.write("gone.txt", "was here");
    let first = rig.after("p1");
    rig.project.write("edit.txt", "newer");
    rig.project.write("added.txt", "agent made this");
    std::fs::remove_file(rig.project.p().join("gone.txt")).unwrap();
    rig.after("p1");
    // Work done by hand since the last save point counts too.
    rig.project.write("hand.txt", "typed by me");

    let hash_before = folder_hash(rig.project.p());
    let refs_before = refs(rig.project.p());
    let diff = super::now_diff(&rig.rt, &rig.project.p().to_string_lossy(), "p1", &first.id).unwrap();
    assert_eq!(folder_hash(rig.project.p()), hash_before, "no project file was written");
    assert_eq!(refs(rig.project.p()), refs_before, "no ref was written");

    let by_path: BTreeMap<&str, &str> = diff.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
    assert_eq!(by_path, BTreeMap::from([("added.txt", "D"), ("edit.txt", "M"), ("gone.txt", "A"), ("hand.txt", "D")]));
    assert_eq!((diff.total, diff.changed, diff.restored, diff.removed, diff.more), (4, 1, 1, 2, 0));
    // And it matches what going back really does.
    rig.rt.go_back(rig.project.p(), "p1", &first.id).unwrap();
    assert_eq!(rig.project.read("edit.txt").as_deref(), Some("old"));
    assert!(rig.project.exists("gone.txt") && !rig.project.exists("added.txt") && !rig.project.exists("hand.txt"));
}

#[test]
fn the_now_diff_lists_at_most_300_files_and_counts_the_rest() {
    let rig = Rig::new("many");
    rig.project.write("seed.txt", "x");
    let first = rig.after("p1");
    for i in 0..310 {
        rig.project.write(&format!("many/f{i:03}.txt"), "n");
    }
    let diff = super::now_diff(&rig.rt, &rig.project.p().to_string_lossy(), "p1", &first.id).unwrap();
    assert_eq!((diff.files.len(), diff.total, diff.more, diff.removed), (300, 310, 10, 310));
}

#[test]
fn the_point_diff_and_the_patches_come_from_the_save_points() {
    let rig = Rig::new("patch");
    rig.project.write("a.txt", "one\ntwo\n");
    rig.after("p1");
    rig.project.write("a.txt", "one\ntwo\nthree\n");
    let second = rig.after("p1");
    let project = rig.project.p().to_string_lossy().to_string();
    let changes = super::point_diff(&rig.rt, &project, "p1", &second.id).unwrap();
    assert_eq!((changes[0].path.as_str(), changes[0].added, changes[0].deleted), ("a.txt", 1, 0));
    let (turn, cut) = super::file_patch(&rig.rt, &project, "p1", &second.id, "a.txt", "").unwrap();
    assert!(turn.contains("+three") && !cut);
    // What going back to the second point would do to a file edited since: put "three" back.
    rig.project.write("a.txt", "one\ntwo\nthree\nfour\n");
    let (now, _) = super::file_patch(&rig.rt, &project, "p1", &second.id, "a.txt", "now").unwrap();
    assert!(now.contains("-four"), "{now}");
    assert!(super::file_patch(&rig.rt, &project, "p1", &second.id, "../a.txt", "").is_err());
}

// ---- who may be named -------------------------------------------------------------------------------

#[test]
fn a_folder_that_is_not_in_the_journal_is_refused_by_every_call_and_every_route() {
    let rig = Rig::new("offline");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    let stranger = Tmp::new("stranger");
    stranger.write("secret.txt", "private");
    let other = stranger.p().to_string_lossy().to_string();

    assert!(matches!(super::point_diff(&rig.rt, &other, "p1", &first.id), Err(TimelineError::NotOnLine)));
    assert!(matches!(super::now_diff(&rig.rt, &other, "p1", &first.id), Err(TimelineError::NotOnLine)));
    assert!(matches!(super::file_patch(&rig.rt, &other, "p1", &first.id, "secret.txt", ""), Err(TimelineError::NotOnLine)));
    assert!(matches!(super::go_back(&rig.rt, &other, "p1", &first.id), Err(TimelineError::NotOnLine)));
    assert!(!stranger.exists(".potato-workspace"), "nothing was created in the other folder");

    let q: BTreeMap<&str, String> = BTreeMap::from([("project", other.clone()), ("key", "p1".into()), ("id", first.id.clone()), ("path", "secret.txt".into())]);
    let param = |name: &str| q.get(name).cloned();
    for (method, tail) in [("GET", "diff"), ("GET", "now-diff"), ("GET", "patch"), ("POST", "restore")] {
        let (status, body) = super::http::respond(&rig.rt, method, &["timeline", "point", tail], &param).expect("a timeline route").unwrap_err();
        assert_eq!((status, body["code"].as_str()), (403, Some("FOLDER_NOT_ON_LINE")), "{method} {tail}");
    }
    // The real folder passes the same door.
    let mut ok = q.clone();
    ok.insert("project", rig.project.p().to_string_lossy().to_string());
    let (status, _) = super::http::respond(&rig.rt, "GET", &["timeline", "point", "now-diff"], &|n| ok.get(n).cloned()).unwrap().unwrap();
    assert_eq!(status, 200);
}

#[test]
fn the_http_routes_answer_the_day_and_the_errors_with_codes() {
    let rig = Rig::new("http");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    rig.project.write("a.txt", "v2");
    let second = rig.after("p1");
    let none = |_: &str| None;

    let (status, day): (u16, Value) = super::http::respond(&rig.rt, "GET", &["timeline", &rig.today()], &none).unwrap().unwrap();
    assert_eq!(status, 200);
    assert_eq!(day["lanes"][0]["rows"].as_array().unwrap().len(), 2);
    assert_eq!(day["lanes"][0]["rows"][0]["gone"], json!(false));
    assert_eq!(day["lanes"][0]["rows"][0]["agentType"], json!("claude"));
    assert_eq!(super::http::respond(&rig.rt, "GET", &["timeline", "not-a-date"], &none).unwrap().unwrap_err().0, 400);
    assert!(super::http::respond(&rig.rt, "GET", &["panes", "x", "checkpoints"], &none).is_none(), "other routes are not ours");
    let missing = super::http::respond(&rig.rt, "GET", &["timeline", "point", "diff"], &none).unwrap().unwrap_err();
    assert_eq!((missing.0, missing.1["code"].as_str()), (400, Some("INVALID_ARGUMENT")));

    let q = BTreeMap::from([("project", rig.project.p().to_string_lossy().to_string()), ("key", "p1".to_string()), ("id", first.id.clone())]);
    let param = |name: &str| q.get(name).cloned();
    // Running: refused with the existing code and no file changes.
    rig.env.set_status("p1", "running");
    let (status, body) = super::http::respond(&rig.rt, "POST", &["timeline", "point", "restore"], &param).unwrap().unwrap_err();
    assert_eq!((status, body["code"].as_str()), (409, Some("PANE_RUNNING")));
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("v2"));
    rig.env.set_status("p1", "idle");
    let (status, body) = super::http::respond(&rig.rt, "POST", &["timeline", "point", "restore"], &param).unwrap().unwrap();
    assert_eq!(status, 200);
    assert!(body["safetyId"].is_string());
    assert_eq!(rig.project.read("a.txt").as_deref(), Some("v1"));
    let _ = second;
}

// ---- the person's own git ------------------------------------------------------------------------------

#[test]
fn the_persons_own_git_is_unchanged_after_a_go_back_from_the_day_line() {
    let rig = Rig::new("usergit");
    let dir = rig.project.p();
    user_git(dir, &["init", "-q", "-b", "main"]);
    user_git(dir, &["config", "user.email", "u@example.com"]);
    user_git(dir, &["config", "user.name", "U"]);
    rig.project.write("tracked.txt", "t1");
    user_git(dir, &["add", "tracked.txt"]);
    user_git(dir, &["commit", "-q", "-m", "init"]);
    user_git(dir, &["branch", "side"]);
    let head = user_git(dir, &["rev-parse", "HEAD"]);
    let branches = user_git(dir, &["branch", "-a", "--format=%(refname) %(objectname)"]);
    let all_refs = user_git(dir, &["for-each-ref"]);
    let index = std::fs::read(dir.join(".git/index")).unwrap();

    let first = rig.after("p1");
    rig.project.write("tracked.txt", "t2 agent");
    rig.project.write("made.txt", "m");
    rig.after("p1");
    rig.env.remove("p1");
    rig.rt.go_back(dir, "p1", &first.id).unwrap();

    assert_eq!(rig.project.read("tracked.txt").as_deref(), Some("t1"));
    assert_eq!(user_git(dir, &["rev-parse", "HEAD"]), head);
    assert_eq!(user_git(dir, &["branch", "-a", "--format=%(refname) %(objectname)"]), branches);
    assert_eq!(user_git(dir, &["for-each-ref"]), all_refs);
    assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index, "the person's index is byte-identical");
}

// ---- pruned points --------------------------------------------------------------------------------------

#[test]
fn a_pruned_point_is_gone_on_the_line_and_cannot_be_gone_back_to() {
    let rig = Rig::new("pruned");
    rig.project.write("a.txt", "v1");
    let first = rig.after("p1");
    rig.project.write("a.txt", "v2");
    rig.after("p1");
    // Prune the first point the way retention would.
    let shadow = crate::checkpoints::engine::list_all(rig.project.p()).unwrap();
    assert_eq!(shadow.len(), 2);
    let git_dir = rig.project.p().join(".potato-workspace").join("checkpoints.git");
    let out = Command::new("git")
        .args(["--git-dir"])
        .arg(&git_dir)
        .args(["update-ref", "-d", &format!("refs/pm/p1/{}", first.id)])
        .output()
        .unwrap();
    assert!(out.status.success());

    let view = day_view(&rig.rt, &rig.today()).unwrap();
    let rows = &view.lanes[0].rows;
    assert!(rows[0].gone, "the pruned point is faded");
    assert!(!rows[1].gone);
    let err = super::go_back(&rig.rt, &rig.project.p().to_string_lossy(), "p1", &first.id).unwrap_err();
    assert!(matches!(err, TimelineError::Checkpoint(CheckpointError::NotFound)), "{err}");
    let (status, body) = super::http::respond(
        &rig.rt,
        "POST",
        &["timeline", "point", "restore"],
        &|n| match n {
            "project" => Some(rig.project.p().to_string_lossy().to_string()),
            "key" => Some("p1".into()),
            "id" => Some(first.id.clone()),
            _ => None,
        },
    )
    .unwrap()
    .unwrap_err();
    assert_eq!((status, body["code"].as_str()), (404, Some("CHECKPOINT_NOT_FOUND")));
}

#[test]
fn a_removed_folder_keeps_its_marks_faded() {
    let rig = Rig::new("folder-gone");
    rig.project.write("a.txt", "v1");
    rig.after("p1");
    let kept = rig.project.p().to_path_buf();
    let renamed = kept.with_file_name(format!("{}-moved", kept.file_name().unwrap().to_string_lossy()));
    std::fs::rename(&kept, &renamed).unwrap();
    let view = day_view(&rig.rt, &rig.today()).unwrap();
    assert!(view.lanes[0].folder_gone);
    assert!(view.lanes[0].rows.iter().all(|r| r.gone));
    std::fs::rename(&renamed, &kept).unwrap();
}

#[test]
fn lanes_come_newest_activity_first_and_helper_steps_are_marked() {
    let rig = Rig::new("lanes");
    let second = Tmp::new("lanes-second");
    rig.env.add("q1", second.p(), "codex", "idle");
    rig.project.write("a.txt", "1");
    rig.after("p1");
    second.write("b.txt", "1");
    rig.after("q1");
    // A mission step in the second folder: its own key.
    second.write("b.txt", "2");
    let Snapshot::Created(c) = engine::snapshot(second.p(), "mission-7", Kind::After, None, rig.env.now_ms() + 1, &Limits::default()).unwrap() else { panic!() };
    let row = Row::from_checkpoint(&second.p().to_string_lossy(), "mission-7", &c, &Default::default());
    rig.journal().append(&row).unwrap();

    let view = day_view(&rig.rt, &rig.today()).unwrap();
    assert_eq!(view.lanes.len(), 2);
    assert_eq!(view.lanes[0].name, second.p().file_name().unwrap().to_string_lossy(), "the newest activity is first");
    let helpers: Vec<bool> = view.lanes[0].rows.iter().map(|r| r.helper).collect();
    assert_eq!(helpers, [false, true]);
    assert_eq!(view.dates, [rig.today()]);
}
