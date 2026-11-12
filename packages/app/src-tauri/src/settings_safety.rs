//! Settings safety: a version number in `settings.json`, rotating backups, and "Restore the last good settings".
//!
//! - `schema_version` sits at the top of the file next to `settings`. The current version is 1. A file without it
//!   (every file written before this) counts as version 0, which reads the same as 1: nothing is converted, the number
//!   is only added the next time the file is saved. A file with a higher number (from a newer app) keeps its number.
//! - After a good read, and after a save, a copy is kept as `settings.json.bak-1` (newest) to `.bak-5` (oldest). A new
//!   copy is made only when the content changed, and at most once an hour, so five copies reach back a while.
//! - If `settings.json` is damaged when the app starts, it is copied to `settings.json.damaged`, nothing is deleted, and
//!   the Settings page offers to bring back the newest backup that reads well.
//!
//! The file work takes paths and times, so tests run on a temp folder without an app.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;

/// The version this app writes.
pub const SCHEMA_VERSION: u64 = 1;
/// The top-level key that holds it.
pub const SCHEMA_KEY: &str = "schema_version";
/// How many backups are kept (`.bak-1` .. `.bak-5`).
pub const BACKUP_COUNT: usize = 5;
/// A new backup is made at most this often.
pub const BACKUP_EVERY: Duration = Duration::from_secs(60 * 60);

/// Set when the file was damaged at start-up; cleared by a restore or by "Keep what I have".
static DAMAGED_AT_START: AtomicBool = AtomicBool::new(false);

/// The version a file carries: a missing or odd value is 0.
pub fn schema_version_of(file: &Value) -> u64 {
    file.get(SCHEMA_KEY).and_then(Value::as_u64).unwrap_or(0)
}

/// The number to write on a save: the current one, unless the file already came from a newer app.
pub fn version_to_write(file: &Value) -> u64 {
    schema_version_of(file).max(SCHEMA_VERSION)
}

/// `file` with `schema_version` set for a save. Everything else is untouched.
pub fn stamp(file: &mut Value) {
    let version = version_to_write(file);
    if let Some(obj) = file.as_object_mut() {
        obj.insert(SCHEMA_KEY.to_string(), Value::from(version));
    }
}

/// `settings.json.bak-<n>` next to `path`.
pub fn backup_path(path: &Path, n: usize) -> PathBuf {
    sibling(path, &format!("bak-{n}"))
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "settings.json".into());
    path.with_file_name(format!("{name}.{suffix}"))
}

/// What the file at `path` is.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FileHealth {
    /// No file (a first start).
    Missing,
    /// Reads as a settings file.
    Good,
    /// There, but it cannot be read as one.
    Damaged,
}

/// Whether `text` reads as a settings file: a JSON object whose `settings` (if there) is an object.
fn reads_well(text: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    match obj.get("settings") {
        None => Some(value),
        Some(settings) if settings.is_object() => Some(value),
        Some(_) => None,
    }
}

pub fn health(path: &Path) -> FileHealth {
    match std::fs::read_to_string(path) {
        Ok(text) if reads_well(&text).is_some() => FileHealth::Good,
        Ok(_) => FileHealth::Damaged,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileHealth::Missing,
        // Locked or unreadable bytes: not something to overwrite, so it counts as damaged.
        Err(_) => FileHealth::Damaged,
    }
}

/// Whether the saved content differs from the newest backup (compared as JSON, so formatting does not count).
fn differs_from_newest(path: &Path, current: &Value) -> bool {
    match std::fs::read_to_string(backup_path(path, 1)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(newest) => &newest != current,
        None => true,
    }
}

/// Keep a copy of the settings file if it is good, changed since the newest backup, and the newest backup is older
/// than an hour. Older copies move down one place; the oldest falls away. Returns whether a copy was made.
pub fn rotate_backups(path: &Path, now: SystemTime) -> std::io::Result<bool> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(false) };
    let Some(current) = reads_well(&text) else { return Ok(false) };
    let newest = backup_path(path, 1);
    if let Ok(modified) = std::fs::metadata(&newest).and_then(|m| m.modified()) {
        if now.duration_since(modified).map(|age| age < BACKUP_EVERY).unwrap_or(true) {
            return Ok(false);
        }
    }
    if !differs_from_newest(path, &current) {
        return Ok(false);
    }
    for n in (1..BACKUP_COUNT).rev() {
        let from = backup_path(path, n);
        if from.exists() {
            std::fs::rename(&from, backup_path(path, n + 1))?;
        }
    }
    std::fs::write(&newest, text.as_bytes())?;
    Ok(true)
}

/// The newest backup (lowest number) that reads well, with its number.
pub fn best_backup(path: &Path) -> Option<(usize, String)> {
    (1..=BACKUP_COUNT).find_map(|n| {
        let text = std::fs::read_to_string(backup_path(path, n)).ok()?;
        reads_well(&text).map(|_| (n, text))
    })
}

/// Put the newest good backup back as `settings.json`. A file that is there is first kept as `settings.json.damaged`.
/// Returns the backup number that was used.
pub fn restore_last_good(path: &Path) -> Result<usize, String> {
    let (n, text) = best_backup(path).ok_or_else(|| "There is no saved copy of your settings to bring back.".to_string())?;
    if path.exists() {
        let _ = std::fs::copy(path, sibling(path, "damaged"));
    }
    crate::settings_patch::write_atomic(path, text.as_bytes()).map_err(|e| format!("Could not bring your settings back: {e}"))?;
    Ok(n)
}

/// At start-up: a good file gets its backup; a damaged one is kept aside and flagged for the offer.
pub fn check_on_start(path: &Path, now: SystemTime) -> FileHealth {
    let state = health(path);
    match state {
        FileHealth::Good => {
            DAMAGED_AT_START.store(false, Ordering::SeqCst);
            if let Err(e) = rotate_backups(path, now) {
                tracing::warn!(error = %e, "settings: could not keep a backup");
            }
        }
        FileHealth::Damaged => {
            DAMAGED_AT_START.store(true, Ordering::SeqCst);
            let _ = std::fs::copy(path, sibling(path, "damaged"));
            tracing::warn!("settings: settings.json is damaged; a copy was kept as settings.json.damaged");
        }
        FileHealth::Missing => {}
    }
    state
}

/// After a save: keep a copy unless the file was damaged at start-up and nothing was restored (then the file is a
/// fresh one, and it must not push the good copies out).
pub fn after_save(path: &Path) {
    if DAMAGED_AT_START.load(Ordering::SeqCst) {
        return;
    }
    if let Err(e) = rotate_backups(path, SystemTime::now()) {
        tracing::warn!(error = %e, "settings: could not keep a backup");
    }
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    /// The settings file was damaged when the app started.
    pub damaged: bool,
    /// A saved copy that reads well exists.
    pub has_backup: bool,
}

pub fn status(path: &Path) -> RecoveryStatus {
    RecoveryStatus { damaged: DAMAGED_AT_START.load(Ordering::SeqCst), has_backup: best_backup(path).is_some() }
}

fn settings_file() -> PathBuf {
    crate::app_paths::app_data_dir().join(crate::settings_patch::SETTINGS_FILE)
}

#[tauri::command]
pub fn settings_recovery_status() -> RecoveryStatus {
    status(&settings_file())
}

/// Bring back the last good settings, load them into the running app and tell every window.
#[tauri::command]
pub fn settings_restore_last_good(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_store::StoreExt;
    let _guard = crate::settings_patch::lock_for_restore();
    restore_last_good(&settings_file())?;
    DAMAGED_AT_START.store(false, Ordering::SeqCst);
    // The store plugin keeps its own copy in memory; read the restored file into it so its next save keeps it.
    if let Ok(store) = app.store(crate::settings_patch::SETTINGS_FILE) {
        let _ = store.reload();
    }
    crate::settings_store::load_saved_public_settings(&app);
    let _ = app.emit(crate::settings_patch::CHANGED_EVENT, crate::settings_patch::current_settings(&app));
    Ok(())
}

/// "Keep what I have": the person does not want the offer any more.
#[tauri::command]
pub fn settings_recovery_dismiss() {
    DAMAGED_AT_START.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests;
