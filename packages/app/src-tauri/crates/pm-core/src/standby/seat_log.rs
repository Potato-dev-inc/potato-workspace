//! The seat log: one plain line for everything that happens to a standby seat (made, opened, a claim that matched or was
//! skipped and why, working, returned, removed). It answers "why did my standby not take that task?" without a debugger.
//!
//! The lines go to the app log (`standby_seat`) and to `<app data>/standby-seat.log` (kept under 512 KB). They hold ids,
//! names and agent types only: no folder, no task text.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::VecDeque;

const KEEP_LINES: usize = 400;
const MAX_FILE_BYTES: u64 = 512 * 1024;

static RECENT: Lazy<Mutex<VecDeque<String>>> = Lazy::new(|| Mutex::new(VecDeque::new()));

/// Writes one line.
pub fn line(text: &str) {
    tracing::info!(target: "standby_seat", "{text}");
    let stamped = format!("{} {text}", crate::event_log::now_ms());
    {
        let mut recent = RECENT.lock();
        recent.push_back(stamped.clone());
        while recent.len() > KEEP_LINES {
            recent.pop_front();
        }
    }
    if cfg!(any(test, feature = "test-util")) {
        return;
    }
    let path = crate::app_paths::app_data_dir().join("standby-seat.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_FILE_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{stamped}");
    }
}

/// The last lines, oldest first (the newest `limit`). Tests read the log through this.
#[cfg(test)]
pub fn recent(limit: usize) -> Vec<String> {
    let recent = RECENT.lock();
    recent.iter().skip(recent.len().saturating_sub(limit)).cloned().collect()
}
