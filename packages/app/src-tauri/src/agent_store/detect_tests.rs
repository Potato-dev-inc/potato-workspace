//! Tests for `detect.rs`. Each test plants empty files in a temp folder that stands in for `PATH`, uses
//! its own candidate names (no PC has them) and a fake version runner. No test runs a planted file.

use std::cell::RefCell;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::detect::{detect_in, Candidate, FoundKind};

static N: AtomicUsize = AtomicUsize::new(0);

/// A fresh temp folder, removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("pm-detect-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn folder(&self, name: &str) -> PathBuf {
        let dir = self.0.join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The file name a program has on this PC: `name.exe` on Windows, `name` elsewhere.
fn file_name(program: &str) -> String {
    if cfg!(windows) { format!("{program}.exe") } else { program.to_string() }
}

/// Plants a program file named `file` in `dir` (executable on Unix, so it counts as a program).
fn plant(dir: &Path, file: &str) -> PathBuf {
    let path = dir.join(file);
    fs::write(&path, b"").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn candidate(id: &str, program: &str, kind: FoundKind) -> Candidate {
    Candidate { id: id.into(), display_name: format!("{id} name"), program: program.into(), kind }
}

fn path_of(dirs: &[&Path]) -> OsString {
    std::env::join_paths(dirs).unwrap()
}

/// A runner that answers "1.2.3" and records every argv it was asked to run.
fn recording_runner(calls: &RefCell<Vec<Vec<String>>>) -> impl Fn(&Path, &[String]) -> Option<String> + '_ {
    move |_program: &Path, args: &[String]| {
        calls.borrow_mut().push(args.to_vec());
        Some("1.2.3".to_string())
    }
}

#[test]
fn finds_three_planted_programs() {
    let scratch = Scratch::new();
    let one = scratch.folder("one");
    let two = scratch.folder("two");
    let three = scratch.folder("three");
    let alpha = plant(&one, &file_name("fixture-alpha"));
    let beta = plant(&two, &file_name("fixture-beta"));
    let gamma = plant(&three, &file_name("fixture-gamma-acp"));
    let candidates = vec![
        candidate("alpha", "fixture-alpha", FoundKind::Catalog),
        candidate("beta", "fixture-beta", FoundKind::Registry),
        candidate("gamma", "fixture-gamma-acp", FoundKind::AcpSibling),
        candidate("delta", "fixture-delta", FoundKind::Catalog),
    ];
    let calls = RefCell::new(Vec::new());
    let runner = recording_runner(&calls);
    let found = detect_in(&candidates, &path_of(&[&one, &two, &three]), None, &runner);

    let ids: Vec<&str> = found.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids, ["alpha", "beta", "gamma"]);
    assert_eq!(found[0].path, alpha);
    assert_eq!(found[1].path, beta);
    assert_eq!(found[2].path, gamma);
    assert_eq!(found[1].kind, FoundKind::Registry);
    assert_eq!(found[2].kind, FoundKind::AcpSibling);
    assert_eq!(found[0].version.as_deref(), Some("1.2.3"));
    assert_eq!(found[0].display_name, "alpha name");
}

#[test]
fn ignores_program_in_project_folder() {
    let scratch = Scratch::new();
    let project = scratch.folder("project");
    let other = scratch.folder("other");
    plant(&project, &file_name("fixture-delta"));
    let candidates = vec![candidate("delta", "fixture-delta", FoundKind::Catalog)];
    let calls = RefCell::new(Vec::new());
    let runner = recording_runner(&calls);

    let found = detect_in(&candidates, &path_of(&[&project, &other]), Some(&project), &runner);

    assert!(found.is_empty(), "a program inside the project folder must not be reported");
    assert!(calls.borrow().is_empty(), "nothing is run for a program that was not reported");
}

#[test]
fn matches_upper_case_exe_extension() {
    let scratch = Scratch::new();
    let dir = scratch.folder("bin");
    // The lab's kimi bug: Windows installers write `KIMI.EXE`.
    let planted = if cfg!(windows) { "KIMI.EXE" } else { "kimi" };
    let path = plant(&dir, planted);
    let candidates = vec![candidate("kimi-agent", "kimi", FoundKind::Catalog)];
    let calls = RefCell::new(Vec::new());
    let runner = recording_runner(&calls);

    let found = detect_in(&candidates, &path_of(&[&dir]), None, &runner);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "kimi-agent");
    assert_eq!(found[0].path, path);
}

#[test]
fn runs_nothing_but_version() {
    let scratch = Scratch::new();
    let one = scratch.folder("one");
    let two = scratch.folder("two");
    plant(&one, &file_name("fixture-alpha"));
    plant(&two, &file_name("fixture-beta"));
    let candidates = vec![
        candidate("alpha", "fixture-alpha", FoundKind::Catalog),
        candidate("beta", "fixture-beta", FoundKind::Catalog),
    ];
    let calls = RefCell::new(Vec::new());
    let runner = recording_runner(&calls);

    let found = detect_in(&candidates, &path_of(&[&one, &two]), None, &runner);

    assert_eq!(found.len(), 2);
    let recorded = calls.borrow();
    assert_eq!(recorded.len(), 2, "one run per found agent");
    assert!(recorded.iter().all(|argv| argv.as_slice() == ["--version"]), "only --version may run: {recorded:?}");
}

#[test]
fn dedupes_same_agent_found_twice() {
    let scratch = Scratch::new();
    let first = scratch.folder("first");
    let second = scratch.folder("second");
    let kept = plant(&first, &file_name("fixture-acme"));
    plant(&second, &file_name("fixture-acme"));
    plant(&second, &file_name("fixture-acme-alt"));
    let candidates = vec![
        candidate("acme", "fixture-acme", FoundKind::Catalog),
        candidate("acme", "fixture-acme-alt", FoundKind::Registry),
    ];
    let calls = RefCell::new(Vec::new());
    let runner = recording_runner(&calls);

    let found = detect_in(&candidates, &path_of(&[&first, &second]), None, &runner);

    assert_eq!(found.len(), 1, "one row per agent id: {found:?}");
    assert_eq!(found[0].path, kept, "the first hit on PATH wins");
    assert_eq!(calls.borrow().len(), 1, "the version is asked once per agent");
}
