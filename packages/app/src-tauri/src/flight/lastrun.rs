//! "Potato Workspace closed unexpectedly last time": found at start from the crash folder and a
//! last-seen marker file.
//!
//! A crash report (`crash/panic-<ms>.log`, written by `crash::install`) newer than the marker means
//! the last run hit a panic. The marker (`<app data>/crash/last-seen`) holds the time of the newest
//! report already shown, so the line is shown once per crash. `exits.log` is not looked at: it is
//! appended on every normal exit too.

use once_cell::sync::OnceCell;
use std::path::Path;

const MARKER: &str = "last-seen";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub closed_unexpectedly: bool,
    /// When the newest crash report was written (ms since 1970), if one exists.
    pub crashed_at_ms: Option<u64>,
}

static FOUND: OnceCell<LastRun> = OnceCell::new();

fn panic_time(name: &str) -> Option<u64> {
    name.strip_prefix("panic-")?.strip_suffix(".log")?.parse().ok()
}

/// Looks at `<data_dir>/crash` against the marker, then moves the marker up to the newest report.
pub fn check_at(data_dir: &Path) -> LastRun {
    let crash = data_dir.join("crash");
    let newest = std::fs::read_dir(&crash)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| panic_time(&e.file_name().to_string_lossy()))
        .max();
    let seen: u64 = std::fs::read_to_string(crash.join(MARKER)).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    let unexpected = newest.is_some_and(|n| n > seen);
    if let Some(n) = newest.filter(|n| *n > seen) {
        let _ = std::fs::write(crash.join(MARKER), n.to_string());
    }
    LastRun { closed_unexpectedly: unexpected, crashed_at_ms: newest }
}

/// Run once at start (before `crash::install` can write this run's own report).
pub fn check_at_start(data_dir: &Path) {
    let _ = FOUND.set(check_at(data_dir));
}

pub fn found() -> LastRun {
    FOUND.get().copied().unwrap_or(LastRun { closed_unexpectedly: false, crashed_at_ms: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pw-lastrun-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("crash")).unwrap();
        d
    }

    #[test]
    fn no_crash_folder_or_only_an_exit_log_is_a_normal_last_run() {
        let d = temp("none");
        std::fs::write(d.join("crash").join("exits.log"), "1 pid=2 code=0 reason=Exit\n").unwrap();
        assert!(!check_at(&d).closed_unexpectedly);
        assert!(!check_at(&std::env::temp_dir().join("pw-lastrun-missing-folder")).closed_unexpectedly);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_new_crash_report_is_found_once() {
        let d = temp("once");
        std::fs::write(d.join("crash").join("panic-1000.log"), "boom").unwrap();
        let first = check_at(&d);
        assert!(first.closed_unexpectedly);
        assert_eq!(first.crashed_at_ms, Some(1000));
        assert!(!check_at(&d).closed_unexpectedly, "the marker moved up");
        std::fs::write(d.join("crash").join("panic-2000.log"), "again").unwrap();
        assert!(check_at(&d).closed_unexpectedly);
        let _ = std::fs::remove_dir_all(&d);
    }
}
