//! A safety net for terminal agents that outlive a crashed app.
//!
//! While the app runs, a small file lists the live terminal agents (pid, process start time, program)
//! and the app itself. At the next start any listed process that is still running and is provably the
//! same process (same pid AND same start time AND same program) is ended with its tree, by pid and never
//! by image name. A pid that the system gave to some other process since has a different start time and
//! is left alone. A file whose owning app is still running (a second copy on the same data folder) is
//! never swept. On Windows the job object (`term_job`) already ends these processes; this covers a job
//! that could not be made, a child that escaped it, and other platforms.

use super::proc_identity::{identity_of, same_exe, ProcIdentity};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "terminal-agents.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub pid: u32,
    pub start: u64,
    pub exe: String,
}

impl Record {
    fn of(pid: u32, id: ProcIdentity) -> Record {
        Record { pid, start: id.start, exe: id.exe }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Book {
    #[serde(default)]
    owner: Option<Record>,
    #[serde(default)]
    agents: Vec<Record>,
}

/// True when `now` is the very process the record was taken from.
pub fn is_same_process(record: &Record, now: Option<&ProcIdentity>) -> bool {
    now.is_some_and(|n| n.start == record.start && same_exe(&n.exe, &record.exe))
}

/// What a start-up should do with the last run's book: `None` when its owner still runs (leave it
/// alone), else the records that are still the same live process.
fn plan(book: &Book, lookup: &dyn Fn(u32) -> Option<ProcIdentity>) -> Option<Vec<Record>> {
    if let Some(owner) = &book.owner {
        if is_same_process(owner, lookup(owner.pid).as_ref()) {
            return None;
        }
    }
    Some(book.agents.iter().filter(|r| is_same_process(r, lookup(r.pid).as_ref())).cloned().collect())
}

fn read_book(path: &Path) -> Book {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Writes through a temporary file and a rename, so a crash never leaves half a file.
fn write_book(path: &Path, book: &Book) {
    let Ok(text) = serde_json::to_string(book) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

struct Store {
    path: PathBuf,
    book: Book,
}

static STORE: Mutex<Option<Store>> = parking_lot::const_mutex(None);

/// Sweeps the last run's leftovers in `dir`, then starts this run's book. Returns the pids it ended.
pub fn init(dir: &Path) -> Vec<u32> {
    init_with(dir, &identity_of, &super::proc_tree::kill_process_tree, std::process::id())
}

fn init_with(
    dir: &Path,
    lookup: &dyn Fn(u32) -> Option<ProcIdentity>,
    end: &dyn Fn(u32),
    me: u32,
) -> Vec<u32> {
    let path = dir.join(FILE_NAME);
    let old = read_book(&path);
    let Some(leftovers) = plan(&old, lookup) else {
        tracing::warn!("pty: another copy of the app owns the terminal agent list; no sweep, nothing recorded");
        return Vec::new();
    };
    let mut ended = Vec::new();
    for record in &leftovers {
        // Our own pid can only be listed by a file from a previous run that reused it; never end ourselves.
        if record.pid == me {
            continue;
        }
        tracing::warn!(pid = record.pid, exe = %record.exe, "pty: ending a terminal agent left behind by the last run");
        end(record.pid);
        ended.push(record.pid);
    }
    let book = Book { owner: lookup(me).map(|id| Record::of(me, id)), agents: Vec::new() };
    write_book(&path, &book);
    *STORE.lock() = Some(Store { path, book });
    ended
}

/// A terminal agent started: remember it (and forget any listed process that is gone).
pub fn record(pid: u32) {
    let mut guard = STORE.lock();
    let Some(store) = guard.as_mut() else { return };
    let Some(id) = identity_of(pid) else { return };
    store.book.agents.retain(|r| r.pid != pid && is_same_process(r, identity_of(r.pid).as_ref()));
    store.book.agents.push(Record::of(pid, id));
    write_book(&store.path, &store.book);
}

/// A terminal agent was stopped on purpose.
pub fn forget(pid: u32) {
    let mut guard = STORE.lock();
    let Some(store) = guard.as_mut() else { return };
    let before = store.book.agents.len();
    store.book.agents.retain(|r| r.pid != pid);
    if store.book.agents.len() != before {
        write_book(&store.path, &store.book);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    fn rec(pid: u32, start: u64, exe: &str) -> Record {
        Record { pid, start, exe: exe.into() }
    }

    fn id(start: u64, exe: &str) -> ProcIdentity {
        ProcIdentity { start, exe: exe.into() }
    }

    fn table(rows: &[(u32, u64, &str)]) -> HashMap<u32, ProcIdentity> {
        rows.iter().map(|(p, s, e)| (*p, id(*s, e))).collect()
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-orphans-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_live_process_with_the_same_start_time_and_program_is_the_same_process() {
        assert!(is_same_process(&rec(7, 100, r"C:\x\node.exe"), Some(&id(100, "c:/x/NODE.exe"))));
    }

    #[test]
    fn a_reused_pid_with_a_different_start_time_is_not_ended() {
        assert!(!is_same_process(&rec(7, 100, "node.exe"), Some(&id(101, "node.exe"))));
    }

    #[test]
    fn a_reused_pid_running_another_program_is_not_ended() {
        assert!(!is_same_process(&rec(7, 100, "node.exe"), Some(&id(100, "chrome.exe"))));
    }

    #[test]
    fn a_process_that_is_gone_is_not_ended() {
        assert!(!is_same_process(&rec(7, 100, "node.exe"), None));
    }

    #[test]
    fn the_plan_picks_only_the_matching_records() {
        let book = Book {
            owner: Some(rec(1, 5, "app.exe")),
            agents: vec![rec(10, 100, "a.exe"), rec(11, 200, "b.exe"), rec(12, 300, "c.exe"), rec(13, 400, "d.exe")],
        };
        // 10 still runs as itself, 11 was reused later, 12 runs another program, 13 is gone, the owner is gone.
        let now = table(&[(10, 100, "a.exe"), (11, 999, "b.exe"), (12, 300, "z.exe")]);
        let picked = plan(&book, &|p| now.get(&p).cloned()).expect("owner is gone");
        assert_eq!(picked, vec![rec(10, 100, "a.exe")]);
    }

    #[test]
    fn a_book_whose_owner_still_runs_is_left_alone() {
        let book = Book { owner: Some(rec(1, 5, "app.exe")), agents: vec![rec(10, 100, "a.exe")] };
        let now = table(&[(1, 5, "app.exe"), (10, 100, "a.exe")]);
        assert!(plan(&book, &|p| now.get(&p).cloned()).is_none());
    }

    #[test]
    fn an_owner_pid_reused_by_another_process_does_not_protect_the_book() {
        let book = Book { owner: Some(rec(1, 5, "app.exe")), agents: vec![rec(10, 100, "a.exe")] };
        let now = table(&[(1, 6, "app.exe"), (10, 100, "a.exe")]);
        assert_eq!(plan(&book, &|p| now.get(&p).cloned()).unwrap().len(), 1);
    }

    #[test]
    fn start_up_ends_the_matches_writes_a_fresh_book_and_never_ends_itself() {
        let dir = temp_dir();
        let old = Book {
            owner: Some(rec(1, 5, "app.exe")),
            agents: vec![rec(10, 100, "a.exe"), rec(11, 200, "b.exe"), rec(42, 50, "app.exe")],
        };
        write_book(&dir.join(FILE_NAME), &old);
        // 42 is this process now, listed by an old file under the same pid and start time.
        let now = table(&[(10, 100, "a.exe"), (11, 201, "b.exe"), (42, 50, "app.exe")]);
        let ended = RefCell::new(Vec::new());
        let out = init_with(&dir, &|p| now.get(&p).cloned(), &|p| ended.borrow_mut().push(p), 42);
        assert_eq!(out, vec![10]);
        assert_eq!(*ended.borrow(), vec![10]);
        let fresh = read_book(&dir.join(FILE_NAME));
        assert!(fresh.agents.is_empty());
        assert_eq!(fresh.owner.map(|o| o.pid), Some(42));
        *STORE.lock() = None;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_broken_file_sweeps_nothing() {
        let dir = temp_dir();
        assert!(init_with(&dir, &|_| None, &|_| panic!("must not end anything"), 1).is_empty());
        std::fs::write(dir.join(FILE_NAME), "{ not json").unwrap();
        assert!(init_with(&dir, &|_| None, &|_| panic!("must not end anything"), 1).is_empty());
        *STORE.lock() = None;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
