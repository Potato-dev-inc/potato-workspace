//! The stall signal: a helper run with no progress for N minutes is "stuck?".
//!
//! No progress means all of these are quiet for N minutes: the helper's screen (spinners and timers
//! do not count), the run's own record (tool events and stage changes update it), and the files in
//! its folder. A run that waits for a person to answer a prompt is never a stall.
//!
//! The decision is a pure function of numbers (`stalled_minutes`), so tests run on a fake clock. A
//! background thread (`spawn`) samples the helper panes every few seconds, keeps the result in a
//! small store, and emits `pane-stall` when it changes. Agents read the same store through the
//! `stalled` fields of `run_agent` / `wait_agents` results; nothing is ever typed into their chat.

use crate::operations::{OperationSnapshot, OperationStatus};
use parking_lot::Mutex;
use serde_json::json;
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// What "Nudge" sends: one short line through the normal send_message path.
pub const NUDGE_TEXT: &str = "Are you still working? Say what you're doing.";

const TICK: Duration = Duration::from_secs(5);
const FILE_SCAN_EVERY_MS: u64 = 15_000;
const FILE_SCAN_BUDGET: usize = 4000;
const FILE_SCAN_DEPTH: usize = 5;
const SKIP_DIRS: [&str; 7] = [".git", "node_modules", "target", "dist", ".next", "__pycache__", ".venv"];

/// What the decision looks at, all in unix milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signals {
    pub now_ms: u64,
    /// When the helper's screen last changed in a way that counts.
    pub screen_ms: u64,
    /// The newest file change in the helper's folder, when one was found.
    pub file_ms: Option<u64>,
    /// The run's own record last changed (a tool event, a stage change).
    pub event_ms: u64,
    /// The turn is running (not queued, finished or waiting).
    pub running: bool,
    /// A question to the person is open.
    pub waiting: bool,
}

/// Whole minutes without progress, once that reaches `threshold_min`. `None`: not stuck (or off).
pub fn stalled_minutes(s: &Signals, threshold_min: u32) -> Option<u64> {
    if threshold_min == 0 || !s.running || s.waiting {
        return None;
    }
    let last = s.screen_ms.max(s.event_ms).max(s.file_ms.unwrap_or(0));
    let quiet_ms = s.now_ms.saturating_sub(last);
    let minutes = quiet_ms / 60_000;
    (minutes >= u64::from(threshold_min)).then_some(minutes)
}

/// A fingerprint of the screen text that ignores what only animates: spinners, progress blocks,
/// digits (clocks, counters) and spaces. `None` for an empty screen.
pub fn screen_fingerprint(text: &str) -> Option<u64> {
    let mut hasher = DefaultHasher::new();
    let mut any = false;
    for ch in text.chars() {
        let animated = ch.is_whitespace()
            || ch.is_ascii_digit()
            || matches!(ch, '|' | '/' | '\\' | '-' | '*' | '.' | '\u{b7}' | '\u{2722}' | '\u{2733}' | '\u{2736}' | '\u{273b}' | '\u{273d}')
            || ('\u{2800}'..='\u{28ff}').contains(&ch)
            || ('\u{2580}'..='\u{259f}').contains(&ch)
            || ('\u{25a0}'..='\u{25ff}').contains(&ch);
        if animated {
            continue;
        }
        ch.hash(&mut hasher);
        any = true;
    }
    any.then(|| hasher.finish())
}

/// One helper pane as the sampler sees it.
#[derive(Debug, Clone)]
pub struct PaneSample {
    pub id: String,
    pub cwd: String,
    /// Fingerprint of the visible screen (`screen_fingerprint`).
    pub screen: Option<u64>,
    /// Last output byte, for panes with no screen text (chat helpers).
    pub last_output_ms: u64,
}

/// What the run behind a pane says.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunState {
    pub running: bool,
    pub waiting: bool,
    pub event_ms: u64,
}

/// Where the sampler gets what is not on the pane. A fake in tests.
pub trait Source {
    fn run_state(&self, pane_id: &str) -> Option<RunState>;
    fn newest_file_ms(&self, cwd: &str, now_ms: u64) -> Option<u64>;
    fn threshold_min(&self) -> u32;
}


/// Which ordinary asks of a minion got their wake-up note. Pure: the sampler feeds it the open asks and the clock.
#[derive(Debug, Default)]
pub struct WakeTracker {
    sent: std::collections::HashSet<(String, u64)>,
}

impl WakeTracker {
    /// The asks that are due a note now: waiting at least `WAKE_AFTER_MS` while the minion's agent is between turns, or
    /// `WAKE_BUSY_AFTER_MS` while it is in the middle of one. An ask that already got its note is never due again.
    pub fn due<'a>(&self, asks: &'a [crate::acp::chat::stall_support::QuietAsk], now_ms: u64, parent_idle: &dyn Fn(&str) -> bool) -> Vec<&'a crate::acp::chat::stall_support::QuietAsk> {
        use crate::acp::chat::helper_answers::{WAKE_AFTER_MS, WAKE_BUSY_AFTER_MS};
        asks.iter()
            .filter(|ask| {
                let age = now_ms.saturating_sub(ask.since_ms);
                !self.sent.contains(&(ask.pane_id.clone(), ask.ask_id)) && (age >= WAKE_BUSY_AFTER_MS || (age >= WAKE_AFTER_MS && parent_idle(&ask.parent)))
            })
            .collect()
    }

    pub fn mark_sent(&mut self, ask: &crate::acp::chat::stall_support::QuietAsk) {
        self.sent.insert((ask.pane_id.clone(), ask.ask_id));
    }

    /// Forgets asks that are gone (answered, or the minion ended).
    pub fn retain_open(&mut self, asks: &[crate::acp::chat::stall_support::QuietAsk]) {
        self.sent.retain(|(pane, id)| asks.iter().any(|a| &a.pane_id == pane && a.ask_id == *id));
    }
}

static WAKES: once_cell::sync::Lazy<Mutex<WakeTracker>> = once_cell::sync::Lazy::new(|| Mutex::new(WakeTracker::default()));

/// One look at the minions' ordinary asks: an ask nobody answered for a minute wakes the agent that started the minion
/// with one app-written note (never typed into the minion, never shown to the person as a card).
fn wake_unanswered_minions() {
    let asks = crate::acp::chat::stall_support::quiet_asks();
    let mut tracker = WAKES.lock();
    tracker.retain_open(&asks);
    let due: Vec<_> = tracker.due(&asks, now_ms(), &crate::acp::chat::stall_support::parent_idle).into_iter().cloned().collect();
    for ask in due {
        let note = crate::acp::chat::helper_answers::wake_note(&ask.name, &ask.pane_id);
        if crate::acp::chat::stall_support::wake_parent(&ask.parent, &note) {
            tracker.mark_sent(&ask);
        }
    }
}

#[derive(Debug, Default)]
struct Entry {
    fingerprint: Option<u64>,
    screen_ms: u64,
    minutes: Option<u64>,
}

/// What the sampler remembers per pane.
#[derive(Debug, Default)]
pub struct Tracker {
    panes: HashMap<String, Entry>,
}

impl Tracker {
    /// One pass over the helper panes. Returns `(pane_id, minutes)` for every pane whose answer changed.
    pub fn tick(&mut self, samples: &[PaneSample], source: &dyn Source, now_ms: u64) -> Vec<(String, Option<u64>)> {
        let threshold = source.threshold_min();
        let mut changed = Vec::new();
        for sample in samples {
            let entry = self.panes.entry(sample.id.clone()).or_insert_with(|| Entry { screen_ms: now_ms, ..Entry::default() });
            if sample.screen.is_some() && entry.fingerprint != sample.screen {
                entry.fingerprint = sample.screen;
                entry.screen_ms = now_ms;
            }
            let screen_ms = if sample.screen.is_some() { entry.screen_ms } else { entry.screen_ms.max(sample.last_output_ms) };
            let run = source.run_state(&sample.id).unwrap_or_default();
            let file_ms = if run.running && !run.waiting && threshold > 0 { source.newest_file_ms(&sample.cwd, now_ms) } else { None };
            let signals = Signals { now_ms, screen_ms, file_ms, event_ms: run.event_ms, running: run.running, waiting: run.waiting };
            let minutes = stalled_minutes(&signals, threshold);
            if minutes != entry.minutes {
                entry.minutes = minutes;
                changed.push((sample.id.clone(), minutes));
            }
        }
        // A pane that is gone is forgotten; if it was shown as stuck, say it is not any more.
        let live: std::collections::HashSet<&str> = samples.iter().map(|s| s.id.as_str()).collect();
        let gone: Vec<String> = self.panes.keys().filter(|id| !live.contains(id.as_str())).cloned().collect();
        for id in gone {
            if self.panes.remove(&id).and_then(|e| e.minutes).is_some() {
                changed.push((id, None));
            }
        }
        changed
    }

    pub fn minutes_of(&self, pane_id: &str) -> Option<u64> {
        self.panes.get(pane_id).and_then(|e| e.minutes)
    }

    pub fn all(&self) -> Vec<(String, u64)> {
        let mut out: Vec<(String, u64)> = self.panes.iter().filter_map(|(id, e)| e.minutes.map(|m| (id.clone(), m))).collect();
        out.sort();
        out
    }
}

static TRACKER: once_cell::sync::Lazy<Mutex<Tracker>> = once_cell::sync::Lazy::new(|| Mutex::new(Tracker::default()));

/// Minutes the run on this pane has had no progress, when it reads as stuck.
pub fn minutes_of(pane_id: &str) -> Option<u64> {
    TRACKER.lock().minutes_of(pane_id)
}

/// Every pane that reads as stuck now: `(pane_id, minutes)`.
pub fn all() -> Vec<(String, u64)> {
    TRACKER.lock().all()
}

/// For the run views an agent reads: stuck minutes of a run that is still running.
pub fn minutes_for_snapshot(snapshot: &OperationSnapshot) -> Option<u64> {
    if snapshot.status.terminal() || snapshot.status == OperationStatus::WaitingInput {
        return None;
    }
    // A chat helper's handle is its pane id, and its record may carry no pane id of its own.
    snapshot.pane_id.as_deref().and_then(minutes_of).or_else(|| (!snapshot.agent_run_id.is_empty()).then(|| minutes_of(&snapshot.agent_run_id)).flatten())
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The newest modification time of any file under `dir`, looking at a bounded part of the tree.
pub fn newest_file_ms_in(dir: &Path) -> Option<u64> {
    let mut best: Option<u64> = None;
    let mut seen = 0usize;
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((path, depth)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&path) else { continue };
        for entry in read.flatten() {
            seen += 1;
            if seen > FILE_SCAN_BUDGET {
                return best;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                let name = entry.file_name();
                if depth < FILE_SCAN_DEPTH && !SKIP_DIRS.iter().any(|skip| name == *skip) {
                    stack.push((entry.path(), depth + 1));
                }
                continue;
            }
            if let Some(ms) = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64) {
                best = Some(best.map_or(ms, |b| b.max(ms)));
            }
        }
    }
    best
}

struct LiveSource {
    registry: Arc<Mutex<crate::pty::PaneRegistry>>,
    files: Mutex<HashMap<String, (u64, Option<u64>)>>,
}

/// The (project, handle) of the run behind a pane: by the pane the record names, else by handle (a chat helper's
/// handle is its pane id).
fn find_run(registry: &Arc<Mutex<crate::pty::PaneRegistry>>, pane_id: &str) -> Option<(String, String)> {
    if let Some(found) = super::pane_api::run_of_pane(registry, pane_id) {
        return Some(found);
    }
    let (default_project, cwd) = {
        let guard = registry.lock();
        (guard.project_path.clone(), guard.panes.get(pane_id).map(|pane| pane.info.cwd.clone()))
    };
    let origin = cwd.as_deref().and_then(crate::worktrees::origin_of_cwd);
    [Some(default_project), origin, cwd]
        .into_iter()
        .flatten()
        .find(|project| crate::operations::latest_agent_run(project, pane_id).is_ok())
        .map(|project| (project, pane_id.to_string()))
}

impl LiveSource {
    fn snapshot_of(&self, pane_id: &str) -> Option<OperationSnapshot> {
        let (project, handle) = find_run(&self.registry, pane_id)?;
        crate::operations::latest_agent_run(&project, &handle).ok()
    }
}

impl Source for LiveSource {
    fn run_state(&self, pane_id: &str) -> Option<RunState> {
        if let Some(chat) = crate::acp::chat::stall_support::run_state(pane_id) {
            return Some(RunState { running: chat.running, waiting: chat.waiting, event_ms: 0 });
        }
        let snapshot = self.snapshot_of(pane_id)?;
        Some(RunState {
            running: snapshot.status == OperationStatus::Running,
            waiting: snapshot.status == OperationStatus::WaitingInput,
            event_ms: snapshot.updated_at_ms,
        })
    }

    fn newest_file_ms(&self, cwd: &str, now_ms: u64) -> Option<u64> {
        let mut cache = self.files.lock();
        if let Some((at, found)) = cache.get(cwd) {
            if now_ms.saturating_sub(*at) < FILE_SCAN_EVERY_MS {
                return *found;
            }
        }
        let found = newest_file_ms_in(Path::new(cwd));
        cache.insert(cwd.to_string(), (now_ms, found));
        found
    }

    fn threshold_min(&self) -> u32 {
        crate::agent_run_mode::stall_minutes()
    }
}

fn samples_of(registry: &Arc<Mutex<crate::pty::PaneRegistry>>) -> Vec<PaneSample> {
    let guard = registry.lock();
    guard
        .panes
        .values()
        // Only helpers an agent started: they have a parent pane or an origin.
        .filter(|pane| !crate::acp::chat::is_remote_pane(&pane.info.id))
        .filter(|pane| (pane.info.parent_pane_id.is_some() || crate::pty::pane_origin::get(&pane.info.id).is_some()) && !crate::pty::hidden::is_hidden(&pane.info.id))
        .map(|pane| {
            // A chat helper has no terminal screen (only a fixed note): its last output is what moves.
            let screen = if pane.info.lane.as_deref() == Some("acp") { None } else { screen_fingerprint(&pane.screen.lock().screen().contents()) };
            let idle_for = pane.last_output.lock().elapsed().as_millis() as u64;
            PaneSample { id: pane.info.id.clone(), cwd: pane.info.cwd.clone(), screen, last_output_ms: now_ms().saturating_sub(idle_for) }
        })
        .collect()
}

/// Starts the sampler (once, at app start).
pub fn spawn(registry: Arc<Mutex<crate::pty::PaneRegistry>>, app: tauri::AppHandle) {
    let source = LiveSource { registry: registry.clone(), files: Mutex::new(HashMap::new()) };
    let _ = std::thread::Builder::new().name("stall-sampler".into()).spawn(move || loop {
        std::thread::sleep(TICK);
        let samples = samples_of(&registry);
        if std::env::var_os("PM_STALL_DEBUG").is_some() {
            for sample in &samples {
                let run = source.run_state(&sample.id);
                eprintln!(
                    "[stall] pane={} screen={} output_age_s={} run={:?} event_age_s={:?} threshold={} stuck={:?}",
                    sample.id,
                    sample.screen.is_some(),
                    now_ms().saturating_sub(sample.last_output_ms) / 1000,
                    run.map(|r| (r.running, r.waiting)),
                    run.map(|r| now_ms().saturating_sub(r.event_ms) / 1000),
                    source.threshold_min(),
                    TRACKER.lock().minutes_of(&sample.id),
                );
            }
        }
        wake_unanswered_minions();
        let changed = TRACKER.lock().tick(&samples, &source, now_ms());
        if !changed.is_empty() {
            crate::attention::on_changed();
        }
        for (pane_id, minutes) in changed {
            let _ = app.emit("pane-stall", json!({ "pane_id": pane_id, "minutes": minutes }));
        }
    });
}

fn run_of(registry: &Arc<Mutex<crate::pty::PaneRegistry>>, pane_id: &str) -> Result<(String, String), String> {
    find_run(registry, pane_id).ok_or_else(|| "NOT_FOUND: this chat has no running task".to_string())
}

fn say(error: crate::operations::OperationError) -> String {
    format!("{}: {}", error.code, error.message)
}

/// Nudge: one short line through the same path `send_message` uses.
pub fn nudge(registry: Arc<Mutex<crate::pty::PaneRegistry>>, app: tauri::AppHandle, pane_id: &str) -> Result<(), String> {
    if crate::acp::chat::stall_support::run_state(pane_id).is_some() {
        return crate::acp::chat::stall_support::nudge(pane_id, NUDGE_TEXT);
    }
    let (project, handle) = run_of(&registry, pane_id)?;
    super::runtime::send_message(&project, &handle, NUDGE_TEXT.to_string(), None, None, None, registry, app).map(|_| ()).map_err(say)
}

/// Stop: the existing cancel.
pub fn stop(registry: Arc<Mutex<crate::pty::PaneRegistry>>, app: tauri::AppHandle, pane_id: &str) -> Result<(), String> {
    if crate::acp::chat::stall_support::run_state(pane_id).is_some() {
        return crate::acp::chat::stall_support::stop(pane_id);
    }
    let (project, handle) = run_of(&registry, pane_id)?;
    super::runtime::cancel_agent(&project, &handle, None, registry, app).map(|_| ()).map_err(say)
}

/// What a fresh helper needs to repeat a run: the same task, agent, model and folder.
pub fn respawn_request(snapshot: &OperationSnapshot) -> serde_json::Value {
    json!({
        "project_path": snapshot.project_path,
        "task": snapshot.task,
        "agent_type": snapshot.agent_type,
        "model": snapshot.worker.requested_model,
        "headless": false,
        "keep_pane": true,
        "background": true,
        "wait_ms": 0,
    })
}

/// Respawn: closes the stuck helper and starts a fresh one with the same task and model. Returns the new handle.
pub fn respawn(registry: Arc<Mutex<crate::pty::PaneRegistry>>, app: tauri::AppHandle, pane_id: &str) -> Result<String, String> {
    if crate::acp::chat::stall_support::run_state(pane_id).is_some() {
        let default_folder = registry.lock().project_path.clone();
        let deps = crate::commands::live_deps(&app, &registry);
        return crate::acp::chat::stall_support::respawn(pane_id, &default_folder, &deps);
    }
    let (project, handle) = run_of(&registry, pane_id)?;
    let snapshot = crate::operations::latest_agent_run(&project, &handle).map_err(say)?;
    let request: super::runtime::AgentRunRequest = serde_json::from_value(respawn_request(&snapshot)).map_err(|e| e.to_string())?;
    super::runtime::cancel_agent(&project, &handle, None, registry.clone(), app.clone()).map_err(say)?;
    super::runtime::close_agent(&project, &handle, None, registry.clone(), app.clone()).ok();
    let view = super::runtime::run_agent(request, registry, app, None).map_err(say)?;
    Ok(view.handle)
}

#[cfg(test)]
#[path = "stall_tests.rs"]
mod tests;
