//! Health of a reviewed adapter after its agent changes. An adapter imports the agent's own code, so an agent update can
//! break it. This module runs two checks on the installed adapter: `confirm_import` (the agent's Python can still import
//! the agent's module) and `check_initialize` (the adapter answers an ACP `initialize`, in an empty folder, with no keys,
//! 10 s at most). Each adapter id keeps one record: `{agent_version, ok, reason, checked_ms}` in `acp/adapter_health.json`.
//!
//! * A failed record blocks the adapter (`blocked_reason`): the Chat option gets that plain reason and starts nothing.
//!   The terminal lane is never touched.
//! * A passing record on a version the adapter was not tested on keeps Chat on and gives a note (`Not tested on version X`).
//! * A check runs when the agent's version changes (`check_on_change`, called by the canary), and at the start of a chat
//!   when the version differs from `tested_version` (`check_at_start`). A passed version is never re-checked; a failed
//!   one is checked again at each start, so a one-time slow start cannot block chat for good.
//! * Nothing here names an agent: the words come from the adapter's own `label`, `tested_version` and `import_name`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::adapter_catalog::AdapterEntry;
use super::adapter_overlay::AdapterOverlay;
use super::agent_python;
use super::config::HostEnv;
use super::overlay::{OverlayItem, OverlayStore};
use crate::canary::version::label as version_label;
use crate::tui::declarative::wizard::acp_check::{self, InitCheck};

/// The start-up check's time limit.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// One adapter's last check. `agent_version` is the version label the check ran on.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Record {
    pub agent_version: String,
    pub ok: bool,
    /// Plain English, set when `ok` is false.
    pub reason: Option<String>,
    pub checked_ms: i64,
}

/// The two checks, as a seam: the app passes the real ones, tests pass fakes.
pub struct Checks<'a> {
    /// `confirm_import(python, import_name)`.
    pub import: &'a dyn Fn(&Path, &str) -> Result<(), String>,
    /// `check_initialize(program, args, timeout)`: the Python, then the adapter script.
    pub handshake: &'a dyn Fn(&Path, &[String], Duration) -> InitCheck,
}

/// The checks the app runs.
pub fn real_checks() -> Checks<'static> {
    Checks { import: &agent_python::confirm_import, handshake: &acp_check::check_initialize }
}

/// Which check failed. Only shapes the plain reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Import,
    Handshake,
}

/// The reason a person reads: one cause and that the terminal still works. Built from the adapter's label and version.
/// After an update the reason names the update; otherwise it is neutral (a one-time slow start must not read as a change).
pub fn reason(label: &str, version: &str, step: Step, from_update: bool) -> String {
    if !from_update {
        return format!("{label} chat adapter did not start on version {version}. The terminal still works.");
    }
    let what = match step {
        Step::Import => "its Python can no longer load the agent's code",
        Step::Handshake => "it did not answer the start-up check",
    };
    format!("{label} updated to {version} and its chat adapter no longer starts ({what}). The terminal still works.")
}

/// The record's version is the one the agent runs now (or the version is not known).
fn for_version(record: &Record, current: Option<&str>) -> bool {
    current.is_none_or(|v| version_label(v) == record.agent_version)
}

/// The plain reason the chat is blocked, when the latest record failed on the version the agent runs now.
pub fn blocked(record: Option<&Record>, current: Option<&str>) -> Option<String> {
    record.filter(|r| !r.ok && for_version(r, current)).and_then(|r| r.reason.clone())
}

/// The note for a passing record on a version the adapter was not tested on; `None` otherwise.
pub fn note(record: Option<&Record>, current: Option<&str>, tested: &str) -> Option<String> {
    let r = record.filter(|r| r.ok && for_version(r, current))?;
    (r.agent_version != version_label(tested)).then(|| format!("Not tested on version {}", r.agent_version))
}

/// Runs the two checks on the installed adapter for `version` and returns the record (not saved).
pub fn run_checks(entry: &AdapterEntry, item: &AdapterOverlay, version: &str, adapters: &Path, checks: &Checks, now_ms: i64, from_update: bool) -> Record {
    let label = version_label(version);
    let fail = |step: Step| Record { agent_version: label.clone(), ok: false, reason: Some(reason(&entry.meta.label, &label, step, from_update)), checked_ms: now_ms };
    let Some(python) = agent_python::find(Path::new(&item.program)) else { return fail(Step::Import) };
    if (checks.import)(&python, &entry.meta.import_name).is_err() {
        return fail(Step::Import);
    }
    let script = adapters.join(&item.script);
    if !(checks.handshake)(&python, &[script.to_string_lossy().into_owned()], HANDSHAKE_TIMEOUT).ok {
        return fail(Step::Handshake);
    }
    Record { agent_version: label, ok: true, reason: None, checked_ms: now_ms }
}

/// The per-adapter records file. `at` is a parameter so tests use a temp folder.
#[derive(Debug, Clone)]
pub struct HealthStore {
    path: PathBuf,
}

impl HealthStore {
    pub fn at(path: impl AsRef<Path>) -> Self {
        Self { path: path.as_ref().to_path_buf() }
    }

    /// `<app data>/acp/adapter_health.json`.
    pub fn in_app_data() -> Self {
        Self::at(crate::app_paths::app_data_dir().join("acp").join("adapter_health.json"))
    }

    fn all(&self) -> BTreeMap<String, Record> {
        std::fs::read(&self.path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<Record> {
        self.all().remove(id)
    }

    pub fn put(&self, id: &str, record: &Record) -> Result<(), String> {
        let mut all = self.all();
        all.insert(id.to_string(), record.clone());
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let bytes = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| format!("could not write the adapter record: {e}"))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("could not save the adapter record: {e}"))
    }

    /// Forgets the record of `id` (a fresh install starts with no record).
    pub fn remove(&self, id: &str) {
        let mut all = self.all();
        if all.remove(id).is_some() {
            if let Ok(bytes) = serde_json::to_vec_pretty(&all) {
                let _ = std::fs::write(&self.path, bytes);
            }
        }
    }
}

/// Runs the checks unless this version already PASSED (a pass is remembered per version; a failure never is).
/// Saves the record either way and returns it.
fn run_and_store(store: &HealthStore, id: &str, entry: &AdapterEntry, item: &AdapterOverlay, version: &str, adapters: &Path, checks: &Checks, now_ms: i64, from_update: bool) -> Record {
    if let Some(record) = store.get(id).filter(|r| r.ok && r.agent_version == version_label(version)) {
        return record;
    }
    let record = run_checks(entry, item, version, adapters, checks, now_ms, from_update);
    let _ = store.put(id, &record);
    record
}

/// The agent's version changed: check now, unless this version already passed. Saves and returns the record.
pub fn check_on_change(store: &HealthStore, id: &str, entry: &AdapterEntry, item: &AdapterOverlay, version: &str, adapters: &Path, checks: &Checks, now_ms: i64) -> Record {
    run_and_store(store, id, entry, item, version, adapters, checks, now_ms, true)
}

/// The start of a chat: a passing record for this version is used as it is. Otherwise a version equal to
/// `tested_version` is not checked (`None`) unless it failed before, and any other version is checked. A failure is
/// checked again on every start, so a one-time slow start does not block chat for good. `None` when the version is unknown.
pub fn check_at_start(store: &HealthStore, id: &str, entry: &AdapterEntry, item: &AdapterOverlay, version: Option<&str>, adapters: &Path, checks: &Checks, now_ms: i64) -> Option<Record> {
    let version = version?;
    let label = version_label(version);
    let saved = store.get(id).filter(|r| r.agent_version == label);
    if let Some(record) = saved.as_ref().filter(|r| r.ok) {
        return Some(record.clone());
    }
    if label == version_label(&entry.meta.tested_version) && saved.is_none() {
        return None;
    }
    Some(run_and_store(store, id, entry, item, version, adapters, checks, now_ms, false))
}

// ---- the app's glue: the real stores, the real checks, the canary's version (no process run) ------------------

/// The stored adapter of agent `id` with its catalog entry, when the overlay holds an adapter.
fn adapter_of(overlay: &OverlayStore, id: &str) -> Option<(AdapterEntry, AdapterOverlay)> {
    let OverlayItem::Adapter(item) = overlay.get_item(id)? else { return None };
    let entry = super::adapter_catalog::load().into_iter().find(|e| e.meta.id == item.adapter_id)?;
    Some((entry, item))
}

/// The agent's version as the canary last read it (a label; no process run).
fn canary_version(agent: &str) -> Option<String> {
    crate::canary::version_of(agent)
}

/// Called by the canary when `agent`'s version changed to `version`. The canary runs it on a background thread.
pub fn on_version_changed(agent: &str, version: &str) {
    let Some((entry, item)) = adapter_of(&OverlayStore::in_app_data(), agent) else { return };
    let adapters = HostEnv::adapters_dir(&super::config::RealHost);
    let record = check_on_change(&HealthStore::in_app_data(), &entry.meta.id, &entry, &item, version, &adapters, &real_checks(), crate::event_log::now_ms());
    tracing::info!(agent, ok = record.ok, "adapter health checked after a version change");
}

/// Before a chat starts: runs the check when it is due, and returns the plain reason when the adapter is blocked.
pub fn check_before_start(agent: &str) -> Option<String> {
    let (entry, item) = adapter_of(&OverlayStore::in_app_data(), agent)?;
    let current = canary_version(agent).or_else(|| super::adapter_overlay::installed_version(&item.program));
    let adapters = HostEnv::adapters_dir(&super::config::RealHost);
    let store = HealthStore::in_app_data();
    check_at_start(&store, &entry.meta.id, &entry, &item, current.as_deref(), &adapters, &real_checks(), crate::event_log::now_ms());
    blocked(store.get(&entry.meta.id).as_ref(), current.as_deref())
}

/// The saved record's blocking reason for an adapter, for the agent's version as the canary knows it. No check runs.
pub fn blocked_now(agent: &str, adapter_id: &str) -> Option<String> {
    blocked(HealthStore::in_app_data().get(adapter_id).as_ref(), canary_version(agent).as_deref())
}

/// The saved record's note for an adapter (`Not tested on version X`). No check runs.
pub fn note_now(agent: &str, adapter_id: &str, tested: &str) -> Option<String> {
    note(HealthStore::in_app_data().get(adapter_id).as_ref(), canary_version(agent).as_deref(), tested)
}

/// The blocking reason and note for the Add chat option, given the version read for it (`installed`, may be unknown).
pub fn option_health(adapter_id: &str, tested: &str, installed: Option<&str>) -> (Option<String>, Option<String>) {
    let record = HealthStore::in_app_data().get(adapter_id);
    (blocked(record.as_ref(), installed), note(record.as_ref(), installed, tested))
}

/// The note for an agent's adapter row, from the saved record (`Not tested on version X`). No check runs.
pub fn note_for_agent(overlay: &OverlayStore, agent: &str) -> Option<String> {
    let (entry, item) = adapter_of(overlay, agent)?;
    note_now(agent, &item.adapter_id, &entry.meta.tested_version)
}
