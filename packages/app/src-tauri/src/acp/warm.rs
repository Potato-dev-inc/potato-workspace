//! Warm chat sessions: a chat adapter started ahead of time, so the next helper or chat for the same agent, folder and
//! account starts at once instead of paying the adapter's startup (0.5 s to 12 s, depending on the agent).
//!
//! At most one warm session per key `{agent, project folder, account}`, already through `initialize` and `session/new`.
//! A start (`chat::start::start`) claims the session for its key; the claim is a hit only for a live, ready session, and the
//! session is then exactly what the cold path would have built (same config, folder and account), so a claim never changes
//! what the chat does. After a claim the pool starts the next one in the background.
//!
//! Which keys are wanted is decided from the standby settings ("Keep agents ready": the master switch and the per-agent
//! count) and from whether the agent's helper would run as a chat at all (`compute_policy`); a key that was just used stays
//! wanted for the standby `recent_hours`. Generic code never names an agent.
//!
//! * `Pool<H>` is the state machine, tested with a fake host (`warm_tests.rs`): idle timeout (the key then stays cold until
//!   it is used again), failure back-off (30 s, doubling, at most 10 minutes; a sign-in problem waits the longest), the cap.
//! * `LiveHost` is the real host: `Conversations::prepare_warm` + `AcpSession::ensure_running`.
//! * `init` runs the loop (a background thread) once the app has had a moment to come up; `shutdown` kills the adapters.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};

use super::config::AgentConfig;
use super::conversations::Conversations;
use super::error::AcpError;
use super::session::AcpSession;
use crate::standby::key::canonical_project;
use crate::standby::config::{StandbyConfig, MAX_PRELOAD_TOTAL};

mod helpers;
mod stage;
mod tally;
pub use helpers::{Claimed, HelperClaim, HelperMeta, HelperState, HelperStatus, HelperUser, HelperWant, SeatLook};
pub use tally::{local_day, SkipReason, Tally};
#[cfg(test)]
pub use helpers::{agent_family, same_project};

/// What a warm session is keyed by: everything fixed when its adapter starts.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WarmKey {
    pub agent: String,
    /// `standby::key::canonical_project`.
    pub project: String,
    /// The account the adapter runs under; `None`: the agent's own login.
    pub account: Option<String>,
    /// A standby helper's id (`standby::helpers`): the person's own named standby is its own slot, apart from the plain
    /// warm session of the same agent and folder. `None` for the plain ones.
    pub slot: Option<String>,
}

impl WarmKey {
    pub fn new(agent: &str, folder: &str, account: Option<&str>) -> Self {
        Self {
            agent: agent.to_ascii_lowercase(),
            project: canonical_project(folder),
            account: account.map(str::trim).filter(|a| !a.is_empty()).map(str::to_string),
            slot: None,
        }
    }

    /// The key of a standby helper's slot.
    pub fn for_helper(helper_id: &str, agent: &str, folder: &str, account: Option<&str>) -> Self {
        Self { slot: Some(helper_id.to_string()), ..Self::new(agent, folder, account) }
    }
}

/// A key the policy wants, with the folder to start it in (the key's own spelling is canonical, not a path to use).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmWant {
    pub key: WarmKey,
    pub folder: PathBuf,
}

/// What the pool is asked to keep.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Policy {
    /// The keys to keep warm (the default project, for each agent that is set up for it).
    pub wanted: Vec<WarmWant>,
    /// Agents whose keys stay wanted after a use (a claim, or a start that found nothing warm).
    pub reusable_agents: BTreeSet<String>,
    /// Most warm sessions at once.
    pub cap: usize,
    /// A warm session unused this long is closed and its key stays cold until it is used again.
    pub idle_ms: i64,
    /// How long a used key stays wanted.
    pub recent_ms: i64,
    /// The person's standby helpers (see `warm/helpers.rs`). They count against `cap` like any other warm session.
    pub helpers: Vec<helpers::HelperWant>,
    /// A standby helper unused this long is closed (0: the same as `idle_ms`).
    pub helper_idle_ms: i64,
}

/// Why a warm start failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmFail {
    pub message: String,
    /// The agent needs a sign-in: asking again soon cannot help.
    pub auth: bool,
}

/// The `WarmFail` message that means "memory is low, try again later": not a failure of the agent.
pub const WAITING_FOR_MEMORY: &str = "waiting for memory";
/// The stage a standby shows while it waits for memory.
pub const MEMORY_STAGE: &str = "waiting for memory";
/// How long a start waits after a low-memory skip.
const MEMORY_RETRY_MS: i64 = 30_000;

/// What the pool needs from the machine.
pub trait WarmHost: Send + Sync + 'static {
    type Item: Send + 'static;
    /// Starts a session for `key` in `folder` (blocking: until it is ready).
    fn start(&self, key: &WarmKey, folder: &Path) -> Result<Self::Item, WarmFail>;
    /// `start` for a standby helper made for `model`: the session is put on that model while it warms, so a task finds it ready on it.
    fn start_for(&self, key: &WarmKey, folder: &Path, _model: Option<&str>) -> Result<Self::Item, WarmFail> {
        self.start(key, folder)
    }
    /// Still running and ready.
    fn alive(&self, item: &Self::Item) -> bool;
    /// Stops it for good.
    fn close(&self, item: Self::Item);
    /// The chat id of a session (what a viewer calls its pane). `None`: the host has no such thing.
    fn pane_of(&self, _item: &Self::Item) -> Option<String> {
        None
    }
    /// Whether the chat `pane_id` has a turn running: `Some(true)` working, `Some(false)` waiting for a message, `None`
    /// the chat is gone. A claimed standby helper is busy until this says its task is over.
    fn working(&self, _pane_id: &str) -> Option<bool> {
        None
    }
    /// How many turns chat `pane_id` has started so far. `None`: the host does not count them (or the chat is gone).
    fn turns(&self, _pane_id: &str) -> Option<u64> {
        None
    }
    /// Stops the turn running in chat `pane_id` (the person takes their standby back from a task). The chat is not closed.
    fn cancel_turn(&self, _pane_id: &str) {}
    /// A standby gave up a task's chat: it is an ordinary chat now (the finished chat stays open; nothing closes it). The screens
    /// must read the pane list again, because the chat is no longer the seat's own.
    fn seat_released(&self, _pane_id: &str) {}
    /// A standby is one-time: a task used seat `helper_id` up. The host takes it off the person's list so no replacement is made.
    fn seat_spent(&self, _helper_id: &str) {}
}

const BACKOFF_FIRST_MS: i64 = 30_000;
const BACKOFF_MAX_MS: i64 = 10 * 60_000;

/// The wait after the `fails`-th failure in a row.
pub fn backoff_ms(fails: u32, auth: bool) -> i64 {
    if auth {
        return BACKOFF_MAX_MS;
    }
    let shift = fails.saturating_sub(1).min(10);
    (BACKOFF_FIRST_MS << shift).min(BACKOFF_MAX_MS)
}

enum State<T> {
    Empty,
    Starting { generation: u64 },
    Ready { item: T, since: i64 },
}

struct Slot<T> {
    folder: PathBuf,
    state: State<T>,
    fails: u32,
    backoff_until: i64,
    /// Closed for being unused: not started again until the key is used.
    cold: bool,
    last_use: Option<i64>,
    /// The standby helper this slot belongs to (`key.slot`), as last asked for by the policy.
    helper: Option<helpers::HelperMeta>,
    /// A claimed helper's task, running. An agent's task has taken the session, so the seat's next clean one is started
    /// meanwhile; the seat stays busy until the task is over.
    busy: Option<helpers::Busy>,
    /// Why the last start failed (for the helper's status line).
    last_error: Option<String>,
    /// The visible chat the person opened on this helper's waiting session (it shares that session; see `warm/helpers.rs`).
    opened: Option<String>,
    /// When a sleeping seat was asked to wake (a task or the person wants it). The row says "Waking up" until it is ready.
    waking_since: Option<i64>,
}

impl<T> Slot<T> {
    fn new(folder: PathBuf) -> Self {
        Slot { folder, state: State::Empty, fails: 0, backoff_until: 0, cold: false, last_use: None, helper: None, busy: None, last_error: None, opened: None, waking_since: None }
    }
}

/// A key someone asked to warm for a short while (the phone opened its New chat screen): it starts whatever the standby
/// settings say, and is closed again when nobody used it before `until`.
struct Hint {
    folder: PathBuf,
    until: i64,
}

/// Most hinted keys at once: a person on a phone picks one agent in one folder; the hints never grow into a pool.
const MAX_HINTS: usize = 2;

struct Inner<T> {
    slots: BTreeMap<WarmKey, Slot<T>>,
    hints: BTreeMap<WarmKey, Hint>,
    policy: Policy,
    generation: u64,
    shut: bool,
    /// Task chats a seat just gave up: `tick` tells the host outside the lock (`WarmHost::seat_released`).
    released: Vec<String>,
    /// Per standby: today's claims and the last reason an agent's task passed it by (memory only).
    tally: Tally,
}

/// A start the pool decided on. Run it with `Pool::run`.
pub struct Job {
    key: WarmKey,
    folder: PathBuf,
    generation: u64,
}

pub struct Pool<H: WarmHost> {
    host: Arc<H>,
    inner: Mutex<Inner<H::Item>>,
}

impl<H: WarmHost> Pool<H> {
    pub fn new(host: Arc<H>) -> Arc<Self> {
        Arc::new(Self { host, inner: Mutex::new(Inner { slots: BTreeMap::new(), hints: BTreeMap::new(), policy: Policy::default(), generation: 0, shut: false, released: Vec::new(), tally: Tally::default() }) })
    }

    pub fn set_policy(&self, policy: Policy) {
        self.inner.lock().policy = policy;
    }

    /// Asks for a session for `key` for the next `ttl_ms`, whatever the standby settings say. It is started by the next
    /// `tick` and used by the start that claims it; if nobody does, it is closed when the time is up.
    pub fn hint(&self, key: &WarmKey, folder: &Path, now: i64, ttl_ms: i64) {
        let mut guard = self.inner.lock();
        if guard.shut {
            return;
        }
        guard.hints.retain(|_, hint| hint.until > now);
        guard.hints.insert(key.clone(), Hint { folder: folder.to_path_buf(), until: now + ttl_ms });
        while guard.hints.len() > MAX_HINTS {
            // The one that runs out first goes.
            let Some(oldest) = guard.hints.iter().min_by_key(|(_, hint)| hint.until).map(|(key, _)| key.clone()) else { break };
            guard.hints.remove(&oldest);
        }
        if let Some(slot) = guard.slots.get_mut(key) {
            slot.cold = false;
        }
    }

    /// A start for `key` is in progress (a claim may wait for it).
    pub fn is_starting(&self, key: &WarmKey) -> bool {
        self.inner.lock().slots.get(key).is_some_and(|slot| matches!(slot.state, State::Starting { .. }))
    }

    /// The keys to have a session for now: the wanted ones, the hinted ones, and the ones used lately for an agent that
    /// may be reused.
    fn effective(inner: &Inner<H::Item>, now: i64) -> BTreeSet<WarmKey> {
        let mut keys: BTreeSet<WarmKey> = inner.policy.wanted.iter().map(|w| w.key.clone()).collect();
        keys.extend(inner.policy.helpers.iter().map(|w| w.key.clone()));
        keys.extend(inner.hints.iter().filter(|(_, hint)| hint.until > now).map(|(key, _)| key.clone()));
        for (key, slot) in &inner.slots {
            let used_lately = slot.last_use.is_some_and(|at| now - at < inner.policy.recent_ms);
            if used_lately && inner.policy.reusable_agents.contains(&key.agent) {
                keys.insert(key.clone());
            }
        }
        keys
    }

    fn taken(inner: &Inner<H::Item>) -> usize {
        inner.slots.values().filter(|s| !matches!(s.state, State::Empty)).count()
    }

    /// One pass of the rules. Returns what to close (run it outside the lock) and the starts to run.
    pub(crate) fn plan(&self, now: i64) -> (Vec<H::Item>, Vec<Job>) {
        let mut close = Vec::new();
        let mut jobs = Vec::new();
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        if inner.shut {
            return (close, jobs);
        }
        // A key the policy wants gets a slot (with its folder) so the start below has somewhere to go.
        let wanted: Vec<WarmWant> = inner.policy.wanted.clone();
        for want in &wanted {
            inner.slots.entry(want.key.clone()).or_insert_with(|| Slot::new(want.folder.clone()));
        }
        for want in inner.policy.helpers.clone() {
            let slot = inner.slots.entry(want.key.clone()).or_insert_with(|| Slot::new(want.folder.clone()));
            slot.folder = want.folder.clone();
            slot.helper = Some(want.meta.clone());
        }
        // A claimed helper whose task is over is used up (standbys are one-time; nothing refills it).
        Self::release_finished(inner, &*self.host, now);
        inner.hints.retain(|_, hint| hint.until > now);
        let hinted: Vec<(WarmKey, PathBuf)> = inner.hints.iter().map(|(key, hint)| (key.clone(), hint.folder.clone())).collect();
        for (key, folder) in &hinted {
            inner.slots.entry(key.clone()).or_insert_with(|| Slot::new(folder.clone()));
        }
        let effective = Self::effective(inner, now);
        let plain_idle_ms = inner.policy.idle_ms;
        let helper_idle_ms = if inner.policy.helper_idle_ms > 0 { inner.policy.helper_idle_ms } else { plain_idle_ms };
        for (key, slot) in inner.slots.iter_mut() {
            let wanted_now = effective.contains(key);
            let idle_ms = if key.slot.is_some() { helper_idle_ms } else { plain_idle_ms };
            if let State::Ready { item, since } = &slot.state {
                let dead = !self.host.alive(item);
                // A session the person has open (or is using) is theirs while they do: never closed for sitting idle.
                // (A seat busy with an agent's task holds its next clean session here: that is not idling either.)
                let person_held = slot.opened.is_some() || slot.busy.is_some();
                let gone = slot.opened.as_deref().is_some_and(|pane| self.host.working(pane).is_none());
                let idle = now - *since >= idle_ms && !person_held;
                if dead || gone || idle || !wanted_now {
                    slot.opened = None;
                    if let State::Ready { item, .. } = std::mem::replace(&mut slot.state, State::Empty) {
                        if person_held && !dead && !gone && !idle {
                            // The standby was taken off the list: the person's open chat keeps its session.
                            drop(item);
                        } else {
                            close.push(item);
                        }
                    }
                    if dead && wanted_now {
                        slot.fails += 1;
                        slot.backoff_until = now + backoff_ms(slot.fails, false);
                    } else if idle && wanted_now {
                        slot.cold = true;
                    }
                }
            }
        }
        // A key nobody wants any more is forgotten (one still starting finishes, and `finish` closes what it made).
        inner.slots.retain(|key, slot| matches!(slot.state, State::Starting { .. }) || effective.contains(key));
        let cap = inner.policy.cap.min(MAX_PRELOAD_TOTAL + crate::standby::helpers::MAX_HELPERS);
        let mut taken = Self::taken(inner);
        let mut generation = inner.generation;
        for key in &effective {
            // A hinted key has somebody waiting for it: the cap (a standby setting, zero when it is off) does not hold it back.
            let hinted_key = hinted.iter().any(|(k, _)| k == key);
            if taken >= cap && !hinted_key {
                continue;
            }
            let Some(slot) = inner.slots.get_mut(key) else { continue };
            // A seat an agent's task took is not refilled: a standby is one-time, so nothing is started in its place.
            let refill_ok = slot.busy.is_none();
            if matches!(slot.state, State::Empty) && !slot.cold && refill_ok && now >= slot.backoff_until {
                generation += 1;
                slot.state = State::Starting { generation };
                taken += 1;
                jobs.push(Job { key: key.clone(), folder: slot.folder.clone(), generation });
            }
        }
        inner.generation = generation;
        (close, jobs)
    }

    /// Runs one start (blocking) and records the outcome.
    pub fn run(&self, job: Job, now: impl Fn() -> i64) {
        let model = self.inner.lock().slots.get(&job.key).and_then(|slot| slot.helper.as_ref()).and_then(|meta| meta.model.clone());
        let result = self.host.start_for(&job.key, &job.folder, model.as_deref());
        self.finish(&job.key, job.generation, result, now());
    }

    fn finish(&self, key: &WarmKey, generation: u64, result: Result<H::Item, WarmFail>, now: i64) {
        if let Some(id) = &key.slot {
            stage::clear(id);
        }
        let mut leftover = None;
        {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            let mut current = inner.slots.get_mut(key).filter(|slot| matches!(slot.state, State::Starting { generation: g } if g == generation));
            if let Some(slot) = current.as_deref_mut() {
                // A sleeping seat that was woken: how long it took, then the row stops saying "Waking up".
                if let Some(since) = slot.waking_since.take() {
                    let outcome = if result.is_ok() { "woke up" } else { "could not wake up" };
                    crate::standby::seat_log::line(&format!("seat {} {outcome} in {} ms", key.slot.as_deref().unwrap_or("?"), now - since));
                    tracing::info!(agent = %key.agent, wake_ms = now - since, ok = result.is_ok(), "acp: sleeping standby woke");
                }
            }
            match (current, result, inner.shut) {
                (Some(slot), Ok(item), false) => {
                    slot.fails = 0;
                    slot.backoff_until = 0;
                    slot.last_error = None;
                    slot.state = State::Ready { item, since: now };
                }
                (Some(slot), Err(fail), _) if fail.message == WAITING_FOR_MEMORY => {
                    // Not a failure: no strike, a short wait, and the row says why.
                    slot.backoff_until = now + MEMORY_RETRY_MS;
                    slot.last_error = Some(WAITING_FOR_MEMORY.to_string());
                    slot.state = State::Empty;
                    tracing::info!(agent = %key.agent, "acp: warm chat skipped, memory is low");
                }
                (Some(slot), Err(fail), _) => {
                    slot.fails += 1;
                    slot.backoff_until = now + backoff_ms(slot.fails, fail.auth);
                    slot.last_error = Some(if fail.auth { "needs_sign_in".to_string() } else { "did_not_start".to_string() });
                    slot.state = State::Empty;
                    tracing::info!(agent = %key.agent, fails = slot.fails, auth = fail.auth, "acp: warm chat did not start: {}", fail.message);
                }
                (Some(slot), Ok(item), true) => {
                    slot.state = State::Empty;
                    leftover = Some(item);
                }
                // The key was dropped, or the pool shut down, while this start ran.
                (None, Ok(item), _) => leftover = Some(item),
                (None, Err(_), _) => {}
            }
        }
        if let Some(item) = leftover {
            self.host.close(item);
        }
    }

    /// Takes the warm session for `key`, if there is a live one. `folder` is where a refill starts. A miss still counts as
    /// a use: the key is warmed for the next start. No refill is started (see `claim`).
    pub fn claim_without_refill(&self, key: &WarmKey, folder: &Path, now: i64) -> Option<H::Item> {
        let mut dead = None;
        let hit = {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            if inner.shut {
                return None;
            }
            if !inner.slots.contains_key(key) {
                if !inner.policy.reusable_agents.contains(&key.agent) {
                    return None;
                }
                inner.slots.insert(key.clone(), Slot::new(folder.to_path_buf()));
            }
            let slot = inner.slots.get_mut(key)?;
            slot.last_use = Some(now);
            slot.cold = false;
            match std::mem::replace(&mut slot.state, State::Empty) {
                State::Ready { item, .. } => {
                    if self.host.alive(&item) {
                        // The hint did its job: no second session is kept ready for it.
                        inner.hints.remove(key);
                        Some(item)
                    } else {
                        slot.fails += 1;
                        slot.backoff_until = now + backoff_ms(slot.fails, false);
                        dead = Some(item);
                        None
                    }
                }
                other => {
                    slot.state = other;
                    None
                }
            }
        };
        if let Some(item) = dead {
            self.host.close(item);
        }
        hit
    }

    /// Counts per agent: sessions ready now.
    pub fn ready_counts(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for (key, slot) in &self.inner.lock().slots {
            if matches!(slot.state, State::Ready { .. }) {
                *counts.entry(key.agent.clone()).or_insert(0) += 1;
            }
        }
        counts
    }

    /// Sessions ready or starting.
    pub fn len(&self) -> usize {
        Self::taken(&self.inner.lock())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// One pass: closes what the rules say, then starts what they say on background threads.
    pub fn tick(self: &Arc<Self>, now: i64) {
        let (close, jobs) = self.plan(now);
        for item in close {
            self.host.close(item);
        }
        for pane in self.take_released() {
            self.host.seat_released(&pane);
        }
        self.spawn(jobs);
    }

    /// The task chats seats gave up in the last `plan` (the caller tells the host, outside the lock).
    pub(crate) fn take_released(&self) -> Vec<String> {
        std::mem::take(&mut self.inner.lock().released)
    }

    /// Takes the warm session for `key` and starts the refill in the background.
    pub fn claim(self: &Arc<Self>, key: &WarmKey, folder: &Path, now: i64) -> Option<H::Item> {
        let hit = self.claim_without_refill(key, folder, now);
        self.tick(now);
        hit
    }

    /// `claim`, but a session that is still starting for `key` is waited for (at most `wait`): it is already part of the
    /// way, so waiting is never slower than starting another. A start that failed ends the wait at once.
    pub fn claim_waiting(self: &Arc<Self>, key: &WarmKey, folder: &Path, wait: Duration) -> Option<H::Item> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            let hit = self.claim_without_refill(key, folder, crate::event_log::now_ms());
            if hit.is_some() || !self.is_starting(key) || std::time::Instant::now() >= deadline {
                self.tick(crate::event_log::now_ms());
                return hit;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn spawn(self: &Arc<Self>, jobs: Vec<Job>) {
        for job in jobs {
            let pool = self.clone();
            let name = format!("acp-warm-{}", job.key.agent);
            let spawned = std::thread::Builder::new().name(name).spawn(move || pool.run(job, crate::event_log::now_ms));
            if spawned.is_err() {
                tracing::warn!("acp: could not start a thread for a warm chat");
            }
        }
    }

    /// Closes every warm session and refuses new ones (the app is exiting).
    pub fn shutdown(&self) {
        let items: Vec<H::Item> = {
            let mut inner = self.inner.lock();
            inner.shut = true;
            let mut items = Vec::new();
            for slot in inner.slots.values_mut() {
                if let State::Ready { item, .. } = std::mem::replace(&mut slot.state, State::Empty) {
                    items.push(item);
                }
            }
            items
        };
        for item in items {
            self.host.close(item);
        }
    }

    pub fn is_shut_down(&self) -> bool {
        self.inner.lock().shut
    }
}

// ---- the policy -------------------------------------------------------------------------------------------------------

/// What the policy asks about an agent (the app answers from its settings; tests from a table).
pub trait AgentProbe {
    /// The agent's helper would run as a chat: the Labs chat switch is on, the agent has an `[acp]` definition and its add-on
    /// is installed, and its saved lane is not the terminal.
    fn runs_as_chat(&self, agent: &str) -> bool;
}

/// The wanted keys from the standby settings: for each agent with a count above zero ("Keep agents ready" on) whose helper
/// runs as a chat, one warm session in `project` (the default project folder, `None`/missing: nothing).
pub fn compute_policy(config: &StandbyConfig, project: Option<&Path>, probe: &dyn AgentProbe) -> Policy {
    let mut policy = Policy { cap: config.cap().min(MAX_PRELOAD_TOTAL), idle_ms: config.idle_timeout_secs as i64 * 1000, recent_ms: config.recent_hours as i64 * 3_600_000, ..Policy::default() };
    if !config.preload.enabled {
        return policy;
    }
    for (agent, count) in &config.preload.providers {
        if config.preload.count_for(agent) == 0 || !probe.runs_as_chat(agent) {
            continue;
        }
        policy.reusable_agents.insert(agent.to_ascii_lowercase());
        if let Some(folder) = project.filter(|p| p.is_dir()) {
            let _ = count;
            policy.wanted.push(WarmWant { key: WarmKey::new(agent, &folder.to_string_lossy(), None), folder: folder.to_path_buf() });
        }
    }
    policy
}

/// The app's answers (`runs_as_chat`).
pub struct LiveProbe;

impl AgentProbe for LiveProbe {
    fn runs_as_chat(&self, agent: &str) -> bool {
        use super::lane::RunLane;
        if !super::chat_enabled() {
            return false;
        }
        let Some(cfg) = super::config::find_builtin(agent) else { return false };
        if cfg.disabled || super::install::is_missing(&cfg, &super::config::RealHost) {
            return false;
        }
        !matches!(super::lane::LaneStore::in_app_data().chosen(agent), Some(RunLane::Terminal))
    }
}

// ---- the real host ----------------------------------------------------------------------------------------------------

/// A started chat session waiting for its owner.
pub struct WarmChat {
    /// The conversation id the session was built for (its pane id is baked into the adapter's tool-server setting).
    pub id: String,
    pub session: Arc<AcpSession>,
    pub folder: PathBuf,
    pub account: Option<String>,
    /// The agent's config as it was when this was started; a claim with a different one is not a hit.
    pub config: serde_json::Value,
}

pub struct LiveHost {
    pub conversations: Conversations,
    /// The pane list, for the pool's own look at the standbys (`refresh_now`). `None`: tests and probes.
    pub registry: Option<Arc<Mutex<crate::pty::PaneRegistry>>>,
}

/// The agent's config as a comparable value.
pub fn config_fingerprint(cfg: &AgentConfig) -> serde_json::Value {
    serde_json::to_value(cfg).unwrap_or(serde_json::Value::Null)
}

impl WarmHost for LiveHost {
    type Item = WarmChat;

    fn start(&self, key: &WarmKey, folder: &Path) -> Result<WarmChat, WarmFail> {
        self.start_for(key, folder, None)
    }

    fn start_for(&self, key: &WarmKey, folder: &Path, model: Option<&str>) -> Result<WarmChat, WarmFail> {
        let fail = |message: String| WarmFail { message, auth: false };
        let slot = key.slot.clone();
        let say = |stage: &str| {
            if let Some(id) = &slot {
                stage::note(id, stage);
            }
        };
        // Low commit memory: a warm-up waits (a chat the person starts never does).
        if super::memory::is_low(&super::memory::SystemReader, &key.agent) {
            return Err(fail(WAITING_FOR_MEMORY.into()));
        }
        say("starting program");
        // The same refusals a real start makes: a blocked adapter or a missing add-on is not warmed.
        if let Some(reason) = super::adapter_health::check_before_start(&key.agent) {
            return Err(fail(reason));
        }
        let cfg = self.conversations.warm_config(&key.agent).map_err(|e| fail(e.to_string()))?;
        if super::install::is_missing(&cfg, &super::config::RealHost) {
            return Err(fail("the add-on is not installed".into()));
        }
        let (id, session) = self.conversations.prepare_warm(&key.agent, folder, key.account.as_deref()).map_err(|e| fail(e.to_string()))?;
        if let Some(id) = key.slot.clone() {
            session.on_stage(Arc::new(move |stage| stage::note(&id, stage)));
        }
        if let Err(error) = session.ensure_running() {
            session.close();
            return Err(WarmFail { auth: matches!(error, AcpError::AuthRequired { .. }), message: error.to_string() });
        }
        // A standby made for a model is put on it now, while it waits (a task finds it ready, on its model). A model the agent
        // does not offer, or refuses, is left for the claim to say in words (`default_model::apply_standby_model`).
        if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            say("setting model");
            match super::chat::choice::apply_model_to_session(&session, model) {
                Ok(Some(value)) => tracing::info!(agent = %key.agent, model = %value, "acp: a standby warmed on its model"),
                Ok(None) => tracing::info!(agent = %key.agent, "acp: a standby's model is not offered by the agent"),
                Err(error) => tracing::warn!(agent = %key.agent, %error, "acp: a standby's model could not be set while warming"),
            }
        }
        Ok(WarmChat { id, session, folder: folder.to_path_buf(), account: key.account.clone(), config: config_fingerprint(&cfg) })
    }

    fn alive(&self, item: &WarmChat) -> bool {
        item.session.is_ready()
    }

    fn close(&self, item: WarmChat) {
        item.session.close();
    }

    fn pane_of(&self, item: &WarmChat) -> Option<String> {
        Some(item.id.clone())
    }

    fn working(&self, pane_id: &str) -> Option<bool> {
        let chat = super::chat::get(pane_id)?;
        Some(chat.state().get("turnInFlight").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    fn turns(&self, pane_id: &str) -> Option<u64> {
        Some(super::chat::get(pane_id)?.session().snapshot().turn)
    }

    fn cancel_turn(&self, pane_id: &str) {
        if let Some(chat) = super::chat::get(pane_id) {
            let _ = chat.cancel();
        }
    }

    fn seat_released(&self, pane_id: &str) {
        // The chat is no longer the seat's own: the screens read the pane list again, so it is drawn as the ordinary helper it is now.
        crate::bridge::notify_panes_changed();
        crate::standby::seat_log::line(&format!("chat {pane_id} is an ordinary chat now (the chat stays open; the standby was used up)"));
    }

    fn seat_spent(&self, helper_id: &str) {
        // Off the person's list for good: the next pass of the pool finds nothing to refill. The person adds a new standby by hand.
        // (A seat that is not on the list, as in a test pool, changes and saves nothing.)
        if helpers_file_remove(helper_id).is_ok() {
            crate::standby::seat_log::line(&format!("seat {helper_id} taken off the list: a standby is used once"));
        }
    }
}

fn helpers_file_remove(helper_id: &str) -> Result<(), String> {
    crate::standby::helpers::file().edit(|store| if store.remove(helper_id) { Ok(()) } else { Err("not on the list".to_string()) })
}

// ---- the app's pool ---------------------------------------------------------------------------------------------------

static GLOBAL: Lazy<RwLock<Option<Arc<Pool<LiveHost>>>>> = Lazy::new(|| RwLock::new(None));
static LOOP_STOP: AtomicBool = AtomicBool::new(false);

/// The pool a start claims from (`None` until `init`, and in tests unless one installs a pool).
pub fn pool() -> Option<Arc<Pool<LiveHost>>> {
    GLOBAL.read().clone()
}

/// Installs a pool (tests). Returns the one it replaced.
pub fn install(pool: Option<Arc<Pool<LiveHost>>>) -> Option<Arc<Pool<LiveHost>>> {
    std::mem::replace(&mut *GLOBAL.write(), pool)
}

/// A warm session for this start, if the pool has one that is the same in every respect: the agent's config as it is now,
/// the folder, the account. Anything else is a miss and the cold path runs.
pub fn claim(cfg: &AgentConfig, folder: &Path, account: Option<&str>) -> Option<WarmChat> {
    let pool = pool()?;
    let key = WarmKey::new(&cfg.id, &folder.to_string_lossy(), account);
    let warm = pool.claim(&key, folder, crate::event_log::now_ms())?;
    if warm.config != config_fingerprint(cfg) || warm.account.as_deref() != account.map(str::trim).filter(|a| !a.is_empty()) {
        // Not what this start asked for (the definition changed meanwhile): never used.
        pool.host.close(warm);
        return None;
    }
    Some(warm)
}

/// `claim` for a start that may wait for a session still starting (see `Pool::claim_waiting`).
pub fn claim_waiting(cfg: &AgentConfig, folder: &Path, account: Option<&str>, wait: Duration) -> Option<WarmChat> {
    let pool = pool()?;
    let key = WarmKey::new(&cfg.id, &folder.to_string_lossy(), account);
    let warm = pool.claim_waiting(&key, folder, wait)?;
    if warm.config != config_fingerprint(cfg) || warm.account.as_deref() != account.map(str::trim).filter(|a| !a.is_empty()) {
        pool.host.close(warm);
        return None;
    }
    Some(warm)
}

/// A standby helper that fits this start, taken for it: the caller's own seats come first and a seat can be asked for by
/// name. The task runs in the seat's own chat (`Claimed::pane` when the person has it open). Waits for one that is still
/// starting. A session is checked like `claim`'s: a changed agent definition makes it a miss.
pub fn claim_helper_for(cfg: &AgentConfig, claim: &HelperClaim, wait: Duration) -> Option<Claimed<WarmChat>> {
    let pool = pool()?;
    let mut claimed = pool.claim_helper_waiting_for(claim, wait)?;
    if let Some(item) = claimed.item.take_if(|item| item.config != config_fingerprint(cfg) || item.account.as_deref() != claim.account.map(str::trim).filter(|a| !a.is_empty())) {
        // Nobody starts a chat for it: it is given back at the next pass.
        pool.set_helper_task_pane(&claimed.meta.id, "");
        crate::standby::seat_log::line(&format!("claim SKIPPED after the match: seat {} was started with an older agent definition; it is restarted", claimed.meta.id));
        pool.host.close(item);
        return None;
    }
    Some(claimed)
}

/// The caller's own seat that would take a task for `agent_type`, whatever lane wording the caller used (`Pool::seat_for`).
pub fn seat_for(claim: &HelperClaim) -> Option<SeatLook> {
    pool()?.seat_for(claim)
}

/// A message was sent in chat `pane_id`: when it is a standby the person opened, the helper is theirs ("With you") until the
/// turn ends.
pub fn note_person_send(pane_id: &str) {
    if let Some(pool) = pool() {
        pool.person_sent(pane_id, crate::event_log::now_ms());
    }
}

/// An agent's task for helper `helper_id` runs in chat `pane_id` (a taken-over helper starts a fresh chat): the helper is busy
/// until that chat has finished a turn. An empty `pane_id`: the start failed, the helper is released at the next pass.
pub fn set_helper_task_pane(helper_id: &str, pane_id: &str) {
    if let Some(pool) = pool() {
        pool.set_helper_task_pane(helper_id, pane_id);
    }
}

/// How long a hint keeps a session for a chat that has not been started yet.
const HINT_TTL_MS: i64 = 5 * 60_000;

/// The person is about to start a chat with `agent` in `folder` (the phone's New chat screen): starts its session now,
/// whatever the "Keep agents ready" setting says. False when that agent would not run as a chat, or there is no pool.
pub fn hint(agent: &str, folder: &Path, account: Option<&str>) -> bool {
    let Some(pool) = pool() else { return false };
    if !LiveProbe.runs_as_chat(agent) {
        return false;
    }
    let key = WarmKey::new(agent, &folder.to_string_lossy(), account);
    let now = crate::event_log::now_ms();
    pool.hint(&key, folder, now, HINT_TTL_MS);
    pool.tick(now);
    true
}

/// The pool does not start spawning until the app has had this long to come up (the standby pool waits the same).
const STARTUP_GRACE_MS: i64 = 8_000;
const TICK: Duration = Duration::from_secs(2);

static STARTED_AT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// One look at the standby settings and one pass of the pool. `honour_grace`: the loop leaves the pool alone for the first
/// seconds after the app starts; a person's own action (adding a standby) does not wait for that.
fn refresh(pool: &Arc<Pool<LiveHost>>, registry: &Arc<Mutex<crate::pty::PaneRegistry>>, now: i64, honour_grace: bool) {
    let up = !honour_grace || now - STARTED_AT.load(Ordering::SeqCst) >= STARTUP_GRACE_MS;
    let policy = match crate::standby::config_snapshot() {
        Some(config) if up => {
            let project = crate::standby::default_project(registry);
            let mut policy = compute_policy(&config, Some(Path::new(&project)), &LiveProbe);
            crate::standby::helpers::extend_policy(&mut policy, &crate::standby::helpers::file().snapshot(), &LiveProbe);
            policy
        }
        _ => Policy::default(),
    };
    pool.set_policy(policy);
    pool.tick(now);
}

/// The person changed the standbys (added one, moved one): the pool follows now, not at the next pass of its 2 s loop.
pub fn refresh_now() {
    let Some(pool) = pool() else { return };
    let Some(registry) = pool.host.registry.clone() else { return };
    refresh(&pool, &registry, crate::event_log::now_ms(), false);
}

/// Starts the loop (once): every few seconds the policy is read from the standby settings and the pool follows it.
pub fn init(registry: Arc<Mutex<crate::pty::PaneRegistry>>) {
    if GLOBAL.read().is_some() {
        return;
    }
    let pool = Pool::new(Arc::new(LiveHost { conversations: super::conversations::global().clone(), registry: Some(registry.clone()) }));
    *GLOBAL.write() = Some(pool.clone());
    super::memory::log_start(&super::memory::SystemReader);
    LOOP_STOP.store(false, Ordering::SeqCst);
    STARTED_AT.store(crate::event_log::now_ms(), Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("acp-warm-pool".into()).spawn(move || {
        while !LOOP_STOP.load(Ordering::SeqCst) && !pool.is_shut_down() {
            std::thread::sleep(TICK);
            refresh(&pool, &registry, crate::event_log::now_ms(), true);
        }
    });
    if spawned.is_err() {
        tracing::warn!("acp: could not start the warm chat loop");
    }
}

/// The app is exiting: every warm adapter is killed.
pub fn shutdown() {
    LOOP_STOP.store(true, Ordering::SeqCst);
    if let Some(pool) = pool() {
        pool.shutdown();
    }
}
