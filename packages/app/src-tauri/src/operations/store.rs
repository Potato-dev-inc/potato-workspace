//! On-disk operation records: atomic persistence, the project and task indexes, the process
//! locks that serialize writers, and the change notification that wakes waiters.

use super::model::{OperationError, OperationSnapshot};
use parking_lot::{Mutex, MutexGuard};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

static DELEGATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static UPDATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TASK_INDEX_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CHANGE: OnceLock<(Mutex<u64>, parking_lot::Condvar)> = OnceLock::new();
static RUNTIME_ID: OnceLock<String> = OnceLock::new();
#[cfg(test)]
thread_local! {
    static TEST_INDEX_OVERRIDE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Serializes operation creation so idempotency lookups and inserts cannot interleave.
pub(super) fn delegate_lock() -> MutexGuard<'static, ()> {
    DELEGATE_LOCK.get_or_init(|| Mutex::new(())).lock()
}

/// Serializes every read-modify-write of an existing operation snapshot.
pub(super) fn update_lock() -> MutexGuard<'static, ()> {
    UPDATE_LOCK.get_or_init(|| Mutex::new(())).lock()
}

pub(super) fn change() -> &'static (Mutex<u64>, parking_lot::Condvar) {
    CHANGE.get_or_init(|| (Mutex::new(0), parking_lot::Condvar::new()))
}
pub(super) fn current_runtime_id() -> &'static str {
    RUNTIME_ID.get_or_init(|| Uuid::new_v4().to_string())
}
pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn root(project: &str) -> Result<PathBuf, OperationError> {
    let path = Path::new(project);
    if !path.is_absolute() {
        return Err(OperationError::new(
            "INVALID_PROJECT_PATH",
            "project_path must be absolute",
            false,
        ));
    }
    Ok(path.join(".potato-workspace").join("operations"))
}
pub(super) fn path_for(project: &str, id: &str) -> Result<PathBuf, OperationError> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(OperationError::new(
            "INVALID_OPERATION_ID",
            "invalid operation_id",
            false,
        ));
    }
    Ok(root(project)?.join(format!("{id}.json")))
}
/// Runs this process knows to be `running` or `waiting_input`, with the wall-clock time their
/// `timeout_ms` ends at. Kept up to date by `persist` (the only writer of a snapshot), so the
/// watchdog sweeps a handful of entries instead of reading every record of every project. A run
/// from an earlier process is not here: startup recovery fails those.
static WATCHED: OnceLock<Mutex<HashMap<(String, String), u64>>> = OnceLock::new();

fn watched_map() -> &'static Mutex<HashMap<(String, String), u64>> {
    WATCHED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The wall-clock time a run's deadline falls on (its start, or its creation when it never started).
pub(super) fn deadline_ms(op: &OperationSnapshot) -> u64 {
    op.started_at_ms
        .unwrap_or(op.created_at_ms)
        .saturating_add(op.timeout_ms)
}

fn track_for_watchdog(op: &OperationSnapshot) {
    use super::model::OperationStatus;
    let key = (op.project_path.clone(), op.operation_id.clone());
    let mut watched = watched_map().lock();
    if matches!(op.status, OperationStatus::Running | OperationStatus::WaitingInput) {
        watched.insert(key, deadline_ms(op));
    } else {
        watched.remove(&key);
    }
}

/// `(project, operation id, deadline)` of every watched run whose deadline is `grace_ms` or more
/// in the past at `now`, optionally only those of one project.
pub(super) fn watched_past_deadline(
    now: u64,
    grace_ms: u64,
    only_project: Option<&str>,
) -> Vec<(String, String, u64)> {
    watched_map()
        .lock()
        .iter()
        .filter(|((project, _), deadline)| {
            now >= deadline.saturating_add(grace_ms)
                && only_project.is_none_or(|only| project_key(only) == project_key(project))
        })
        .map(|((project, id), deadline)| (project.clone(), id.clone(), *deadline))
        .collect()
}

pub(super) fn untrack_for_watchdog(project: &str, operation_id: &str) {
    watched_map()
        .lock()
        .remove(&(project.to_string(), operation_id.to_string()));
}

pub(super) fn persist(op: &OperationSnapshot) -> Result<(), OperationError> {
    let path = path_for(&op.project_path, &op.operation_id)?;
    let parent = path.parent().unwrap();
    crate::git_exclude::ensure_project_storage_excluded(Path::new(&op.project_path));
    fs::create_dir_all(parent)
        .map_err(|e| OperationError::io_at("create operations dir", parent, e))?;
    update_indexes(&op.project_path, op.task_id.as_deref(), &op.operation_id)?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(
        &temp,
        serde_json::to_vec_pretty(op).map_err(OperationError::io)?,
    )
    .map_err(|e| OperationError::io_at("write operation file", &temp, e))?;
    replace_file(&temp, &path)?;
    note_idempotency_key(op)?;
    if op.status.terminal() {
        if let Some(pane) = op.pane_id.as_deref() {
            crate::agent_runs::pane_lease::release_on_terminal(pane, op.owner_session_id.as_deref());
        }
    }
    track_for_watchdog(op);
    let (lock, cv) = change();
    {
        let mut generation = lock.lock();
        *generation = generation.wrapping_add(1);
    }
    cv.notify_all();
    Ok(())
}
fn update_indexes(
    project: &str,
    task_id: Option<&str>,
    operation_id: &str,
) -> Result<(), OperationError> {
    let _guard = TASK_INDEX_LOCK.get_or_init(|| Mutex::new(())).lock();
    let dir = index_dir()?;
    let project_path = dir.join("operation-project-index.json");
    let task_path = dir.join("operation-task-index.json");
    let mut projects: Vec<String> = match fs::read(&project_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(OperationError::io)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(OperationError::io(error)),
    };
    // Validate every relevant index before changing either one. A corrupt task index must not
    // partially update the project index before the operation write fails.
    let mut tasks: HashMap<String, (String, String)> = if task_id.is_some() {
        match fs::read(&task_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(OperationError::io)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(OperationError::io(error)),
        }
    } else {
        HashMap::new()
    };
    // One entry per project, however its path is spelled (slash direction, case on Windows,
    // trailing separator, extended-length prefix).
    let key = project_key(project);
    if !projects.iter().any(|existing| project_key(existing) == key) {
        projects.push(project.to_string());
    }
    if let Some(task_id) = task_id {
        tasks.insert(
            task_id.to_string(),
            (project.to_string(), operation_id.to_string()),
        );
    }
    atomic_json(&project_path, &projects)?;
    if task_id.is_some() {
        atomic_json(&task_path, &tasks)?;
    }
    Ok(())
}
fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), OperationError> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(
        &temp,
        serde_json::to_vec(value).map_err(OperationError::io)?,
    )
    .map_err(|e| OperationError::io_at("write operation index", &temp, e))?;
    replace_file(&temp, path)
}
pub(super) fn indexed_projects() -> Result<Vec<String>, OperationError> {
    let path = index_dir()?.join("operation-project-index.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(OperationError::io(err)),
    };
    let listed: Vec<String> = serde_json::from_slice(&bytes).map_err(OperationError::io)?;
    // Older index files may hold several spellings of one project.
    let mut seen = std::collections::HashSet::new();
    Ok(listed
        .into_iter()
        .filter(|project| seen.insert(project_key(project)))
        .collect())
}
/// Identity of a project directory independent of how its path is written.
pub(crate) fn project_key(project: &str) -> String {
    crate::project_path::comparable_project_path(Path::new(project))
}
pub(super) fn task_index_path() -> Result<PathBuf, OperationError> {
    Ok(index_dir()?.join("operation-task-index.json"))
}
fn index_dir() -> Result<PathBuf, OperationError> {
    #[cfg(test)]
    {
        if let Some(dir) = TEST_INDEX_OVERRIDE.with(|value| value.borrow().clone()) {
            fs::create_dir_all(&dir).map_err(OperationError::io)?;
            return Ok(dir);
        }
        static TEST_INDEX_DIR: OnceLock<PathBuf> = OnceLock::new();
        let dir = TEST_INDEX_DIR
            .get_or_init(|| {
                std::env::temp_dir().join(format!(
                    "potato-workspace-operation-index-{}",
                    std::process::id()
                ))
            })
            .clone();
        fs::create_dir_all(&dir).map_err(OperationError::io)?;
        Ok(dir)
    }
    #[cfg(not(test))]
    {
        crate::app_paths::ensure_app_data_dir()
            .map_err(|e| OperationError::io_at("create app data dir", Path::new("<app data dir>"), e))
    }
}
#[cfg(test)]
pub(super) fn set_test_index_dir(path: Option<PathBuf>) {
    TEST_INDEX_OVERRIDE.with(|value| *value.borrow_mut() = path);
}
#[cfg(not(windows))]
fn replace_file(temp: &Path, path: &Path) -> Result<(), OperationError> {
    fs::rename(temp, path).map_err(|e| {
        let _ = fs::remove_file(temp);
        OperationError::io(e)
    })
}
/// Win32 calls made directly (unlike `std::fs`) stop at MAX_PATH unless the path carries the
/// extended-length prefix. Short or already-prefixed paths pass through unchanged.
#[cfg(windows)]
pub(crate) fn extended_length(path: &Path) -> std::ffi::OsString {
    let text = path.to_string_lossy();
    if text.len() < 240 || text.starts_with(r"\\?\") || !path.is_absolute() {
        return path.as_os_str().to_os_string();
    }
    let text = text.replace('/', r"\");
    match text.strip_prefix(r"\\") {
        Some(unc) => format!(r"\\?\UNC\{unc}").into(),
        None => format!(r"\\?\{text}").into(),
    }
}
#[cfg(windows)]
fn replace_file(temp: &Path, path: &Path) -> Result<(), OperationError> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = extended_length(temp).encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = extended_length(path).encode_wide().chain(Some(0)).collect();
    // Another process (or a polling reader without FILE_SHARE_DELETE) can hold the target open
    // for a few milliseconds; a swallowed failure here would freeze an operation's state.
    let mut attempt = 0_u64;
    loop {
        let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) };
        if ok != 0 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        // 5 = ACCESS_DENIED, 32 = SHARING_VIOLATION, 33 = LOCK_VIOLATION
        let transient = matches!(e.raw_os_error(), Some(5 | 32 | 33));
        attempt += 1;
        if !transient || attempt >= 25 {
            let _ = fs::remove_file(temp);
            return Err(OperationError::io_at("replace operation file", path, e));
        }
        std::thread::sleep(std::time::Duration::from_millis(10 * attempt.min(10)));
    }
}

#[cfg(all(test, windows))]
mod replace_tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    /// A project path of ~200 chars puts `.potato-workspace/operations/<uuid>.<uuid>.tmp` past
    /// MAX_PATH (260); the replace must still work (B3: raw "os error 3" from MoveFileExW).
    fn long_dir() -> std::path::PathBuf {
        let mut dir = std::env::temp_dir().join(format!("pm-long-{}", uuid::Uuid::new_v4()));
        while dir.as_os_str().len() < 200 {
            dir = dir.join("segment-of-a-long-project-path");
        }
        dir.join(".potato-workspace").join("operations")
    }

    #[test]
    fn replace_works_when_the_path_is_longer_than_max_path() {
        let dir = long_dir();
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
        let temp = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        assert!(temp.as_os_str().len() > 260, "{}", temp.as_os_str().len());
        fs::write(&temp, "new").unwrap();
        replace_file(&temp, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(!temp.exists());
    }

    #[test]
    fn replace_waits_out_a_briefly_exclusive_holder() {
        let dir = std::env::temp_dir().join(format!("pm-replace-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("op.json");
        let temp = dir.join("op.json.tmp");
        fs::write(&target, "old").unwrap();
        fs::write(&temp, "new").unwrap();
        // share_mode(0) makes MoveFileExW fail with ACCESS_DENIED until the handle is dropped.
        let holder = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(80));
            drop(holder);
        });
        replace_file(&temp, &target).unwrap();
        release.join().unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let _ = fs::remove_dir_all(dir);
    }
}
pub(super) fn read(path: &Path) -> Result<OperationSnapshot, OperationError> {
    let raw = fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            OperationError::new("OPERATION_NOT_FOUND", "operation not found", false)
        } else {
            OperationError::io(e)
        }
    })?;
    serde_json::from_slice(&raw).map_err(OperationError::io)
}
/// Like `read`, but a record that cannot be parsed or read is set aside instead of failing the
/// caller: it is moved (never deleted) to `operations/_corrupt/`, a warning is logged and `None`
/// is returned. A record that vanished meanwhile is also `None`.
pub(super) fn read_or_quarantine(path: &Path) -> Result<Option<OperationSnapshot>, OperationError> {
    match read(path) {
        Ok(op) => Ok(Some(op)),
        Err(error) if error.code == "OPERATION_NOT_FOUND" => Ok(None),
        Err(error) => {
            quarantine(path, &error);
            Ok(None)
        }
    }
}

fn quarantine(path: &Path, error: &OperationError) {
    tracing::warn!(path = %path.display(), error = %error.message, "skipping unreadable operation record");
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let dir = parent.join("_corrupt");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut target = dir.join(name);
    if target.exists() {
        target = dir.join(format!("{}-{}", Uuid::new_v4(), name.to_string_lossy()));
    }
    if let Err(e) = fs::rename(path, &target) {
        tracing::warn!(path = %path.display(), error = %e, "could not move unreadable operation record aside");
    }
}

/// Per-project idempotency index: `{ idempotency_key: operation_id }`. The extension is not
/// `json` so directory scans never mistake it for an operation record.
fn idem_index_path(project: &str) -> Result<PathBuf, OperationError> {
    Ok(root(project)?.join("_idempotency.index"))
}
static IDEM_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
type KnownKeys = std::collections::HashSet<(String, String, String)>;
static IDEM_KNOWN: OnceLock<Mutex<KnownKeys>> = OnceLock::new();

fn known_keys() -> &'static Mutex<KnownKeys> {
    IDEM_KNOWN.get_or_init(|| Mutex::new(Default::default()))
}

fn read_idem_index(project: &str) -> Option<HashMap<String, String>> {
    let bytes = fs::read(idem_index_path(project).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Scan every record and write a fresh index. Corrupt records are quarantined on the way.
fn rebuild_idem_index(project: &str) -> Result<HashMap<String, String>, OperationError> {
    let mut map = HashMap::new();
    let dir = root(project)?;
    let entries = match fs::read_dir(&dir) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(map),
        Err(e) => return Err(OperationError::io(e)),
    };
    for entry in entries {
        let entry = entry.map_err(OperationError::io)?;
        if entry.path().extension().is_some_and(|e| e == "json") {
            if let Some(op) = read_or_quarantine(&entry.path())? {
                map.insert(op.idempotency_key, op.operation_id);
            }
        }
    }
    if map.is_empty() {
        return Ok(map);
    }
    atomic_json(&idem_index_path(project)?, &map)?;
    let mut known = known_keys().lock();
    let pk = project_key(project);
    known.retain(|(p, _, _)| *p != pk);
    for (key, id) in &map {
        known.insert((pk.clone(), key.clone(), id.clone()));
    }
    Ok(map)
}

/// Record `key -> operation_id` in the project's index. Cheap when already recorded this run.
fn note_idempotency_key(op: &OperationSnapshot) -> Result<(), OperationError> {
    let triple = (
        project_key(&op.project_path),
        op.idempotency_key.clone(),
        op.operation_id.clone(),
    );
    if known_keys().lock().contains(&triple) {
        return Ok(());
    }
    let _guard = IDEM_LOCK.get_or_init(|| Mutex::new(())).lock();
    let Some(mut map) = read_idem_index(&op.project_path) else {
        // Missing or unparseable: the scan includes the record just written.
        return rebuild_idem_index(&op.project_path).map(|_| ());
    };
    if map.get(&op.idempotency_key) != Some(&op.operation_id) {
        map.insert(op.idempotency_key.clone(), op.operation_id.clone());
        atomic_json(&idem_index_path(&op.project_path)?, &map)?;
    }
    known_keys().lock().insert(triple);
    Ok(())
}

/// `Some(answer)` when the index can answer; `None` when it is inconsistent with the records.
fn indexed_lookup(
    project: &str,
    key: &str,
    map: &HashMap<String, String>,
) -> Option<Option<OperationSnapshot>> {
    let Some(id) = map.get(key) else {
        return Some(None);
    };
    match path_for(project, id).ok().and_then(|p| read(&p).ok()) {
        Some(op) if op.idempotency_key == key => Some(Some(op)),
        _ => None,
    }
}

pub(super) fn find_key(
    project: &str,
    key: &str,
) -> Result<Option<OperationSnapshot>, OperationError> {
    if !root(project)?.is_dir() {
        return Ok(None);
    }
    let _guard = IDEM_LOCK.get_or_init(|| Mutex::new(())).lock();
    if let Some(map) = read_idem_index(project) {
        if let Some(found) = indexed_lookup(project, key, &map) {
            return Ok(found);
        }
    }
    let map = rebuild_idem_index(project)?;
    Ok(indexed_lookup(project, key, &map).unwrap_or(None))
}
pub(super) fn bump(op: &mut OperationSnapshot) -> Result<(), OperationError> {
    op.revision = op.revision.saturating_add(1);
    op.worker.event_cursor = op.worker.event_cursor.max(op.revision);
    op.updated_at_ms = now_ms();
    if let Some(stage) = op.stage.clone() {
        if op.worker.stage_log.last().map(|mark| mark.stage.as_str()) != Some(stage.as_str()) {
            if op.worker.stage_log.len() >= 32 {
                op.worker.stage_log.remove(0);
            }
            op.worker.stage_log.push(super::model::StageMark {
                stage,
                at_ms: op.updated_at_ms,
            });
        }
    }
    let saved = persist(op);
    if saved.is_ok() {
        // A run that just failed gets its pane's flight recording frozen next to its record.
        crate::flight::freeze::on_operation_saved(op);
    }
    saved
}
