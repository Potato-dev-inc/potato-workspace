//! "Phone and remote activity": what paired phones did on this PC, as one line each (a time, the phone's name and a
//! kind from a closed list). It reuses the device log of `device_link::activity` (the same kinds, the same words on
//! the page) and never holds a prompt, a message, a path or a token: the kind comes from the method and the shape of
//! the route, and the body is never read.
//!
//! Only what a person would call an action is kept: a phone opening the app, starting an agent, typing, sending a
//! message, answering a question, stopping an agent. Reads and small housekeeping posts (typing indicators, drafts,
//! viewport sizes) are not lines. Runs of the same kind from the same phone within a few seconds are one line.
//!
//! This list is separate from the hash-chained security record (`crate::audit`): Clear empties this list only.

use crate::device_link::activity::{classify, ActivityLog, Dir, Kind};
use crate::device_link::route::PrefsStore;
use once_cell::sync::Lazy;
use serde_json::Value;
#[cfg(not(test))]
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(test)]
mod tests;

/// The same kind from the same phone inside this many seconds is one line.
const MERGE_SECS: u64 = 10;
/// A phone quiet for this long is "opening the app" again on its next action.
const SESSION_SECS: u64 = 30 * 60;

/// One small json file in the app data folder, written whole through a temporary file next to it.
#[cfg(not(test))]
struct FileStore {
    path: PathBuf,
}

#[cfg(not(test))]
impl PrefsStore for FileStore {
    fn load(&self) -> Option<String> {
        std::fs::read_to_string(&self.path).ok()
    }
    fn save(&self, text: &str) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

#[cfg(not(test))]
fn make_store() -> Arc<dyn PrefsStore> {
    Arc::new(FileStore { path: crate::app_paths::app_data_dir().join("phone-activity.json") })
}

#[cfg(test)]
fn make_store() -> Arc<dyn PrefsStore> {
    // Tests that go through the bridge never write the real app data.
    crate::device_link::route::MemoryPrefs::new()
}

static LOG: Lazy<Arc<ActivityLog>> = Lazy::new(|| ActivityLog::new(make_store()));

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Kinds that are an action worth a line. A setting-like post (`Changed`) is housekeeping from the phone's page.
fn worth_a_line(kind: Kind) -> bool {
    matches!(kind, Kind::Started | Kind::Typed | Kind::Messaged | Kind::Answered | Kind::Stopped)
}

/// A request a paired phone made (already authorized). Reads and housekeeping posts leave no line.
pub fn note_request(device_id: &str, method: &str, segments: &[&str]) {
    let target = format!("/{}", segments.join("/"));
    if let Some(kind) = classify(method, &target).filter(|k| worth_a_line(*k)) {
        note_kind(device_id, kind);
    }
}

/// One line for `device_id`. The name is the phone's own (or the name the person gave it).
pub fn note_kind(device_id: &str, kind: Kind) {
    let name = crate::attention::caps::device_name(device_id).unwrap_or_else(|| "A phone".to_string());
    record_at(&LOG, now_secs(), device_id, &name, kind);
}

fn record_at(log: &ActivityLog, now: u64, device_id: &str, name: &str, kind: Kind) {
    let mine = log.list(Some(device_id));
    let last = mine.first();
    let last_at = last.and_then(|r| r["at"].as_u64());
    if let (Some(row), Some(at)) = (last, last_at) {
        if row["kind"] == kind.as_str() && now.saturating_sub(at) < MERGE_SECS {
            return;
        }
    }
    // A phone that was quiet for a while is opening the app again: say so before its first action.
    if last_at.map_or(true, |at| now.saturating_sub(at) >= SESSION_SECS) && kind != Kind::Connected {
        log.record(now, device_id, name, Dir::In, Kind::Connected);
    }
    log.record(now, device_id, name, Dir::In, kind);
}

/// Newest first: `{ at, node, name, dir, kind }`, the same shape as the device activity.
pub fn list() -> Vec<Value> {
    LOG.list(None)
}

/// Empties the list. The hash-chained security record is not touched.
pub fn clear() {
    LOG.clear();
}


/// The bridge calls this once a request is authorized. Only a paired phone leaves a line: the desktop app and its own
/// tools (`Local`) and public routes do not.
pub fn note_authorized(caller: &crate::mobile_pairing::Caller, method: &str, segments: &[&str]) {
    if let crate::mobile_pairing::Caller::Device { device_id, .. } = caller {
        note_request(device_id, method, crate::mobile_pairing::normalize_bridge_segments(segments));
    }
}
