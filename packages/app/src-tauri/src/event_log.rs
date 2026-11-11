//! Append-only JSONL event log: per-project and global files, system/bridge event append,
//! replay into pane timelines and read models. Recent-event queries live in `recent`.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::actors::ActorId;
use crate::events::{CommandId, EventEntry, PaneId, SystemEvent};

mod recent;
pub use recent::*;

const EVENT_LOG_FILE_NAME: &str = "events.jsonl";
const PROJECT_STORAGE_DIR_NAME: &str = ".potato-workspace";

static EVENT_LOG: OnceCell<Arc<EventLogManager>> = OnceCell::new();

/// A log that grows past this is moved aside (`events.jsonl.1`, replacing the last one) and a new
/// file started, so reading it back (read models, `/events/recent`) stays cheap. One busy
/// project's log reached 40 MB.
const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;
/// After a failed rotation, how much more may be written before the next try.
const ROTATE_RETRY_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
struct LogWriter {
    file: File,
    size: u64,
    rotate_at: u64,
}

#[derive(Debug)]
pub struct EventLog {
    path: PathBuf,
    writer: Mutex<LogWriter>,
    max_bytes: u64,
}

static SHARED_LOGS: once_cell::sync::Lazy<Mutex<std::collections::HashMap<PathBuf, Arc<EventLog>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".1");
    PathBuf::from(name)
}

#[derive(Debug)]
struct EventLogSlot {
    path: PathBuf,
    log: Arc<EventLog>,
}

#[derive(Debug)]
pub struct EventLogManager {
    fallback_path: PathBuf,
    active_project_path: Mutex<Option<PathBuf>>,
    slot: Mutex<EventLogSlot>,
}

impl EventLog {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        Self::with_limit(path, MAX_LOG_BYTES)
    }

    fn with_limit(path: PathBuf, max_bytes: u64) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("create event log dir {}: {err}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|err| format!("open event log {}: {err}", path.display()))?;
        let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        Ok(Self {
            path,
            writer: Mutex::new(LogWriter { file, size, rotate_at: max_bytes }),
            max_bytes,
        })
    }

    /// The one writer for this file in this process. Every append to a path goes through the same
    /// handle and lock, so two threads cannot interleave their lines.
    pub fn shared(path: PathBuf) -> Result<Arc<EventLog>, String> {
        let mut all = SHARED_LOGS.lock();
        if let Some(log) = all.get(&path) {
            // The file (or its folder) was removed under us: a handle to it would write to nothing.
            if path.exists() {
                return Ok(log.clone());
            }
        }
        let log = Arc::new(EventLog::new(path.clone())?);
        all.insert(path, log.clone());
        Ok(log)
    }

    /// Moves the full log aside and starts a new file. Best effort: on failure the log keeps
    /// growing and is tried again after a little more.
    fn rotate(&self, writer: &mut LogWriter) {
        let rotated = rotated_path(&self.path);
        let _ = fs::remove_file(&rotated);
        let started = fs::rename(&self.path, &rotated).and_then(|()| {
            OpenOptions::new().create(true).append(true).open(&self.path)
        });
        match started {
            Ok(file) => {
                writer.file = file;
                writer.size = 0;
                writer.rotate_at = self.max_bytes;
            }
            Err(err) => {
                tracing::warn!(path = %self.path.display(), %err, "could not rotate the event log");
                writer.rotate_at = writer.size.saturating_add(ROTATE_RETRY_BYTES);
            }
        }
    }

    pub fn append(&self, entry: &EventEntry) -> Result<(), String> {
        let mut line = serde_json::to_string(entry)
            .map_err(|err| format!("serialize event log entry: {err}"))?;
        line.push('\n');
        let mut writer = self.writer.lock();
        if writer.size >= writer.rotate_at {
            self.rotate(&mut writer);
        }
        // One write for the entry and its newline: a second handle appending at the same moment
        // can then never land between them and glue two entries into one line.
        writer
            .file
            .write_all(line.as_bytes())
            .map_err(|err| format!("write event log {}: {err}", self.path.display()))?;
        writer.size = writer.size.saturating_add(line.len() as u64);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn read_all(&self) -> Result<Vec<EventEntry>, String> {
        read_entries(&self.path)
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn event_log_path() -> PathBuf {
    crate::app_paths::app_data_dir().join(EVENT_LOG_FILE_NAME)
}

pub fn project_storage_dir(project_path: &Path) -> PathBuf {
    project_path.join(PROJECT_STORAGE_DIR_NAME)
}

pub fn project_event_log_path(project_path: &Path) -> PathBuf {
    project_storage_dir(project_path).join(EVENT_LOG_FILE_NAME)
}

impl EventLogManager {
    pub fn new(fallback_path: PathBuf) -> Result<Self, String> {
        let log = EventLog::shared(fallback_path.clone())?;
        Ok(Self {
            fallback_path: fallback_path.clone(),
            active_project_path: Mutex::new(None),
            slot: Mutex::new(EventLogSlot {
                path: fallback_path,
                log,
            }),
        })
    }

    pub fn set_active_project_path(&self, path: Option<PathBuf>) {
        let normalized =
            path.and_then(|candidate| crate::project_path::normalize_project_path(&candidate).ok());
        *self.active_project_path.lock() = normalized;
    }

    pub fn active_project_path(&self) -> Option<PathBuf> {
        self.active_project_path.lock().clone()
    }

    pub fn current_path(&self) -> PathBuf {
        self.active_project_path()
            .map(|project_path| project_event_log_path(&project_path))
            .unwrap_or_else(|| self.fallback_path.clone())
    }

    fn current_log(&self) -> Result<Arc<EventLog>, String> {
        let path = self.current_path();
        let mut slot = self.slot.lock();
        if slot.path == path {
            return Ok(slot.log.clone());
        }
        if let Some(project) = self.active_project_path() {
            // The project's events.jsonl must not end up in the user's commits.
            crate::git_exclude::ensure_project_storage_excluded(&project);
        }
        let log = EventLog::shared(path.clone())?;
        *slot = EventLogSlot {
            path,
            log: log.clone(),
        };
        Ok(log)
    }

    pub fn append(&self, entry: &EventEntry) -> Result<(), String> {
        self.current_log()?.append(entry)
    }

    pub fn read_all(&self) -> Result<Vec<EventEntry>, String> {
        read_entries(&self.current_path())
    }
}

pub fn init_global_event_log(path: PathBuf) -> Result<(), String> {
    let log = Arc::new(EventLogManager::new(path)?);
    let _ = EVENT_LOG.set(log);
    Ok(())
}

pub fn set_active_project_path(path: Option<PathBuf>) {
    let Some(log) = EVENT_LOG.get() else {
        tracing::debug!("event log not initialized; cannot set active project path");
        return;
    };
    log.set_active_project_path(path);
}

pub fn active_project_path() -> Option<PathBuf> {
    EVENT_LOG.get().and_then(|log| log.active_project_path())
}

pub fn current_event_log_path() -> PathBuf {
    EVENT_LOG
        .get()
        .map(|log| log.current_path())
        .unwrap_or_else(event_log_path)
}

pub fn append_system_event(payload: SystemEvent) {
    let Some(log) = EVENT_LOG.get() else {
        tracing::debug!("event log not initialized; dropping event");
        return;
    };
    let entry = EventEntry::new(ActorId::system(), CommandId::new(), payload);
    if let Err(err) = log.append(&entry) {
        tracing::warn!(%err, "append event failed");
    } else {
        crate::pane_wait_notify::bump_waiters();
    }
}

pub fn append_bridge_event(payload: SystemEvent) {
    let Some(log) = EVENT_LOG.get() else {
        tracing::debug!("event log not initialized; dropping bridge event");
        return;
    };
    let entry = EventEntry::new(ActorId::bridge(), CommandId::new(), payload);
    if let Err(err) = log.append(&entry) {
        tracing::warn!(%err, "append bridge event failed");
    } else {
        crate::pane_wait_notify::bump_waiters();
    }
}

pub fn replay_global_pane_timeline() -> Result<Vec<PaneTimelineEvent>, String> {
    let log = EVENT_LOG
        .get()
        .ok_or_else(|| "event log not initialized".to_string())?;
    replay_pane_timeline_from_entries(log.read_all()?)
}

pub fn read_global_entries() -> Result<Vec<EventEntry>, String> {
    let log = EVENT_LOG
        .get()
        .ok_or_else(|| "event log not initialized".to_string())?;
    log.read_all()
}

pub fn rebuild_read_models() -> Result<crate::projections::ReadModels, String> {
    Ok(crate::projections::build_read_models(
        &read_global_entries()?
    ))
}

/// Bytes read per step when scanning a log from its end.
const TAIL_CHUNK_BYTES: usize = 256 * 1024;

/// The newest entry (scanning from the end of the file) that satisfies `want`. Reads the log in
/// chunks backwards and stops at the first match, so a lookup of a recent event costs a few
/// hundred KB instead of parsing a multi-MB history (a busy project's log reached 40MB and took
/// 1.3s to parse on every worker-status call).
pub fn find_last_entry(want: impl FnMut(&EventEntry) -> bool) -> Result<Option<EventEntry>, String> {
    let log = EVENT_LOG
        .get()
        .ok_or_else(|| "event log not initialized".to_string())?;
    find_last_entry_in(&log.current_path(), TAIL_CHUNK_BYTES, want)
}

fn find_last_entry_in(
    path: &Path,
    chunk_bytes: usize,
    mut want: impl FnMut(&EventEntry) -> bool,
) -> Result<Option<EventEntry>, String> {
    let mut found = None;
    scan_entries_backwards(path, chunk_bytes, |entry| {
        if want(&entry) {
            found = Some(entry);
            true
        } else {
            false
        }
    })?;
    Ok(found)
}

/// Whether a damaged line has been reported already (the first one is a warning, the rest are not,
/// so a log with one bad line does not fill the app's own log on every read).
static WARNED_BAD_LINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The entries on one log line. Normally one; a line written by two interleaved appends (`{A}{B}`)
/// yields both; a line that cannot be read is skipped (logged), never an error for the whole log.
fn entries_of_line(line: &[u8], path: &Path) -> Vec<EventEntry> {
    let mut out = Vec::new();
    for item in serde_json::Deserializer::from_slice(line).into_iter::<EventEntry>() {
        match item {
            Ok(entry) => out.push(entry),
            Err(err) => {
                if WARNED_BAD_LINE.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    tracing::debug!(path = %path.display(), %err, "skipping an unreadable event log line");
                } else {
                    tracing::warn!(path = %path.display(), %err, "skipping an unreadable event log line");
                }
                break;
            }
        }
    }
    out
}

/// Calls `visit` with the entries of the log newest first until it returns true. Reads the file in
/// chunks from its end, so stopping early costs only the tail.
fn scan_entries_backwards(
    path: &Path,
    chunk_bytes: usize,
    mut visit: impl FnMut(EventEntry) -> bool,
) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    if !path.exists() {
        return Ok(());
    }
    let mut file =
        File::open(path).map_err(|err| format!("open event log {}: {err}", path.display()))?;
    let mut position = file
        .metadata()
        .map_err(|err| format!("stat event log {}: {err}", path.display()))?
        .len();
    // Bytes read so far that do not yet start at a line boundary (the line continues further up).
    let mut carry: Vec<u8> = Vec::new();
    let chunk_bytes = chunk_bytes.max(1);
    while position > 0 {
        let step = (chunk_bytes as u64).min(position);
        position -= step;
        let mut chunk = vec![0_u8; step as usize];
        file.seek(SeekFrom::Start(position))
            .and_then(|_| file.read_exact(&mut chunk))
            .map_err(|err| format!("read event log {}: {err}", path.display()))?;
        chunk.extend_from_slice(&carry);
        let buffer = chunk;
        // Everything after the first newline is made of whole lines; the head may be a partial
        // line unless this chunk reaches the start of the file.
        let (head_len, lines_start) = match buffer.iter().position(|byte| *byte == b'\n') {
            Some(newline) if position > 0 => (newline, newline + 1),
            _ if position > 0 => (buffer.len(), buffer.len()),
            _ => (0, 0),
        };
        for line in buffer[lines_start..].split(|byte| *byte == b'\n').rev() {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            for entry in entries_of_line(line, path).into_iter().rev() {
                if visit(entry) {
                    return Ok(());
                }
            }
        }
        carry = if position > 0 { buffer[..head_len].to_vec() } else { Vec::new() };
    }
    Ok(())
}

/// Like [`find_last_entry`], for any consumer that walks the global log newest first (`visit`
/// returns true to stop).
pub(crate) fn scan_global_entries_backwards(visit: impl FnMut(EventEntry) -> bool) -> Result<(), String> {
    let log = EVENT_LOG
        .get()
        .ok_or_else(|| "event log not initialized".to_string())?;
    scan_entries_backwards(&log.current_path(), TAIL_CHUNK_BYTES, visit)
}

pub fn read_entries(path: &Path) -> Result<Vec<EventEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file =
        File::open(path).map_err(|err| format!("open event log {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for (index, line) in reader.split(b'\n').enumerate() {
        let line = line.map_err(|err| format!("read event log line {}: {err}", index + 1))?;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        entries.extend(entries_of_line(&line, path));
    }
    Ok(entries)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaneTimelineEvent {
    pub timestamp_ms: i64,
    pub pane_id: PaneId,
    pub event: String,
}

pub fn replay_pane_timeline_from_entries(
    entries: Vec<EventEntry>,
) -> Result<Vec<PaneTimelineEvent>, String> {
    let mut timeline = Vec::new();
    for entry in entries {
        match entry.payload {
            SystemEvent::PaneSpawned { pane_id, .. } => timeline.push(PaneTimelineEvent {
                timestamp_ms: entry.timestamp_ms,
                pane_id,
                event: "spawned".to_string(),
            }),
            SystemEvent::PaneInputWritten { pane_id, .. } => timeline.push(PaneTimelineEvent {
                timestamp_ms: entry.timestamp_ms,
                pane_id,
                event: "input_written".to_string(),
            }),
            SystemEvent::PaneOutputObserved { pane_id, .. } => timeline.push(PaneTimelineEvent {
                timestamp_ms: entry.timestamp_ms,
                pane_id,
                event: "output_observed".to_string(),
            }),
            SystemEvent::PaneStatusChanged { pane_id, status } => {
                timeline.push(PaneTimelineEvent {
                    timestamp_ms: entry.timestamp_ms,
                    pane_id,
                    event: format!("status:{status}"),
                })
            }
            SystemEvent::PaneKilled { pane_id, .. } => timeline.push(PaneTimelineEvent {
                timestamp_ms: entry.timestamp_ms,
                pane_id,
                event: "killed".to_string(),
            }),
            SystemEvent::McpToolCalled { .. }
            | SystemEvent::McpToolCompleted { .. }
            | SystemEvent::TaskCreated { .. }
            | SystemEvent::TaskClaimed { .. }
            | SystemEvent::TaskLeaseRenewed { .. }
            | SystemEvent::TaskStatusUpdated { .. }
            | SystemEvent::TaskCompleted { .. }
            | SystemEvent::TaskBlocked { .. }
            | SystemEvent::ReviewerAssigned { .. }
            | SystemEvent::ResourceLockAcquired { .. }
            | SystemEvent::ResourceLockConflict { .. }
            | SystemEvent::ResourceLockReleased { .. }
            | SystemEvent::ResourceLockExpired { .. }
            | SystemEvent::AgentObservation { .. }
            | SystemEvent::SessionGoalUpdated { .. }
            | SystemEvent::PaneRoleSet { .. }
            | SystemEvent::PaneDigestUpdated { .. }
            | SystemEvent::DelegationPrepared { .. }
            | SystemEvent::OrchestratorStandbyPolicyUpdated { .. }
            | SystemEvent::OpenCodeKeySwap { .. }
            | SystemEvent::PaneModelSwitched { .. }
            | SystemEvent::PaneTuiReattached { .. } => {}
        }
    }
    Ok(timeline)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
