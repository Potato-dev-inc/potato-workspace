//! The app's log on disk: `<app data>/logs/app.log`, rolled over by size.
//!
//! Every line is redacted (`redact::strict`) BEFORE it is written, so nothing unredacted is ever on
//! disk. At most `MAX_FILES` files of `MAX_FILE_BYTES` each are kept (5 x 5 MB = 25 MB): when
//! `app.log` is full it becomes `app.log.1`, that one `app.log.2`, and the oldest is deleted.
//! Writing is best effort: a full disk or a locked file never affects the app.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use std::cell::Cell;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_FILES: usize = 5;
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_DIR: &str = "logs";
const BASE_NAME: &str = "app.log";

pub struct RollingLog {
    dir: PathBuf,
    max_files: usize,
    max_bytes: u64,
    file: Option<File>,
    size: u64,
}

impl RollingLog {
    pub fn new(dir: PathBuf, max_files: usize, max_bytes: u64) -> Self {
        Self { dir, max_files: max_files.max(1), max_bytes: max_bytes.max(1), file: None, size: 0 }
    }

    fn path(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.dir.join(BASE_NAME)
        } else {
            self.dir.join(format!("{BASE_NAME}.{index}"))
        }
    }

    fn open(&mut self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.path(0);
        self.size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.file = Some(OpenOptions::new().create(true).append(true).open(path)?);
        Ok(())
    }

    fn roll(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(self.path(self.max_files - 1));
        for i in (0..self.max_files - 1).rev() {
            let from = self.path(i);
            if from.exists() {
                let _ = std::fs::rename(&from, self.path(i + 1));
            }
        }
        self.size = 0;
    }

    /// Append one already-redacted line (a newline is added).
    pub fn append(&mut self, line: &str) {
        let need = line.len() as u64 + 1;
        if self.file.is_none() && self.open().is_err() {
            return;
        }
        if self.size > 0 && self.size + need > self.max_bytes {
            self.roll();
            if self.open().is_err() {
                return;
            }
        }
        if let Some(file) = self.file.as_mut() {
            if writeln!(file, "{line}").is_ok() {
                self.size += need;
            } else {
                self.file = None;
            }
        }
    }
}

static LOG: OnceCell<Mutex<RollingLog>> = OnceCell::new();

thread_local! {
    static WRITING: Cell<bool> = const { Cell::new(false) };
}

/// Start writing the log under `<data_dir>/logs`. Later calls do nothing.
pub fn init(data_dir: &Path) {
    let _ = LOG.set(Mutex::new(RollingLog::new(data_dir.join(LOG_DIR), MAX_FILES, MAX_FILE_BYTES)));
}

/// Redact and write a log line, if the file log was started.
pub fn write(line: &str) {
    let Some(log) = LOG.get() else { return };
    if WRITING.with(|w| w.replace(true)) {
        return; // the redaction logged something: do not recurse
    }
    let clean = crate::redact::strict(line);
    log.lock().append(clean.as_str());
    WRITING.with(|w| w.set(false));
}

/// The log folder, if the file log was started.
#[cfg(test)]
pub fn dir() -> Option<PathBuf> {
    LOG.get().map(|l| l.lock().dir.clone())
}

/// Log files, newest first: `app.log`, `app.log.1`, ...
pub fn files_in(dir: &Path) -> Vec<PathBuf> {
    (0..MAX_FILES)
        .map(|i| if i == 0 { dir.join(BASE_NAME) } else { dir.join(format!("{BASE_NAME}.{i}")) })
        .filter(|p| p.is_file())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pw-logfile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn total(dir: &Path) -> u64 {
        files_in(dir).iter().map(|p| std::fs::metadata(p).unwrap().len()).sum()
    }

    #[test]
    fn the_folder_never_goes_over_the_cap_however_much_is_written() {
        let dir = temp("cap");
        let mut log = RollingLog::new(dir.clone(), 5, 50_000);
        let line = "x".repeat(99);
        for _ in 0..5_000 {
            log.append(&line); // ~500 KB, 10x the 250 KB cap
        }
        assert!(files_in(&dir).len() <= 5);
        assert!(total(&dir) <= 5 * 50_000, "total {}", total(&dir));
        assert!(files_in(&dir).len() == 5, "older files are kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_newest_lines_survive_a_roll() {
        let dir = temp("newest");
        let mut log = RollingLog::new(dir.clone(), 3, 1_000);
        for i in 0..200 {
            log.append(&format!("line {i:04} {}", "y".repeat(40)));
        }
        let text = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(text.contains("line 0199"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_secret_is_masked_on_disk() {
        let dir = temp("mask");
        LOG.get_or_init(|| Mutex::new(RollingLog::new(dir.clone(), 2, 100_000)));
        let target = dir_of_test_log();
        write("connecting with token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef now");
        let mut text = String::new();
        for f in files_in(&target) {
            text.push_str(&std::fs::read_to_string(f).unwrap());
        }
        assert!(text.contains("connecting with token"), "{text}");
        assert!(!text.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "{text}");
    }

    fn dir_of_test_log() -> PathBuf {
        dir().unwrap()
    }
}
