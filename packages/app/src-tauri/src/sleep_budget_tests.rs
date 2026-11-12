//! Sleep budget for test code.
//!
//! A bare `sleep` in a test is a guess about how long something takes. On a quiet machine the guess is
//! right; under load (ten agents building, a full run beside a build) it is wrong and the test turns
//! flaky. A test should wait for an event or poll a condition with a deadline (see
//! `docs/DEV-SPEED.md`, "Writing tests that do not flake").
//!
//! This guard counts the `thread::sleep(` / `tokio::time::sleep(` lines in test files (`tests.rs`,
//! `*_tests.rs`, anything under a `tests/` folder, and the top-level `tests/` folder). It fails when the
//! count grows. When you REMOVE sleeps, lower `BUDGET` in the same change so the number only goes down.

use std::path::{Path, PathBuf};

/// Sleep lines in test files today. Lower it when you remove sleeps; never raise it.
const BUDGET: usize = 326;

fn is_test_file(rel: &str) -> bool {
    let rel = rel.replace(std::path::MAIN_SEPARATOR, "/");
    if !rel.ends_with(".rs") {
        return false;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let (dirs, file) = parts.split_at(parts.len() - 1);
    let stem = file[0].trim_end_matches(".rs");
    dirs.iter().any(|d| *d == "tests" || *d == "test") || stem == "tests" || stem == "test" || stem.ends_with("_tests") || stem.ends_with("_test")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// Lines that call a sleep (comments do not count).
fn sleep_lines(source: &str) -> usize {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .filter(|line| line.contains("thread::sleep(") || line.contains("time::sleep("))
        .count()
}

fn count_in(root: &Path) -> (usize, Vec<(usize, String)>) {
    let mut files = Vec::new();
    walk(&root.join("src"), &mut files);
    walk(&root.join("tests"), &mut files);
    let mut total = 0;
    let mut per_file = Vec::new();
    for file in files {
        let rel = file.strip_prefix(root).unwrap_or(&file).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        if !is_test_file(&rel) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&file) else { continue };
        let n = sleep_lines(&source);
        total += n;
        if n > 0 {
            per_file.push((n, rel));
        }
    }
    per_file.sort_by(|a, b| b.cmp(a));
    (total, per_file)
}

#[test]
fn test_code_does_not_add_sleeps() {
    let (total, per_file) = count_in(Path::new(env!("CARGO_MANIFEST_DIR")));
    let top: Vec<String> = per_file.iter().take(8).map(|(n, f)| format!("  {n:>3}  {f}")).collect();
    assert!(
        total <= BUDGET,
        "test files now have {total} sleep lines, the budget is {BUDGET}. Wait for an event or poll a condition with a deadline instead of a bare sleep (docs/DEV-SPEED.md). Biggest files:\n{}",
        top.join("\n")
    );
}

#[test]
fn the_sleep_counter_counts_what_it_should() {
    assert_eq!(sleep_lines("std::thread::sleep(a);\n// thread::sleep(b);\n  tokio::time::sleep(c).await;\nsession.sleep();"), 2);
    assert!(is_test_file("src/acp/bridge/tests.rs") && is_test_file("src/potato/open_work_tests.rs") && is_test_file("tests/e2e.rs"));
    assert!(is_test_file("src/agent_hooks/tests/live.rs"));
    assert!(!is_test_file("src/acp/job.rs") && !is_test_file("src/contest.rs") && !is_test_file("src/acp/tests_helper.txt"));
}
