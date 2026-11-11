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

/// What a warm session is keyed by: everything fixed when its adapter starts.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WarmKey {
    pub agent: String,
    /// `standby::key::canonical_project`.
    pub project: String,
    /// The account the adapter runs under; `None`: the agent's own login.
    pub account: Option<String>,
}

impl WarmKey {
    pub fn new(agent: &str, folder: &str, account: Option<&str>) -> Self {
        Self {
            agent: agent.to_ascii_lowercase(),
            project: canonical_project(folder),
            account: account.map(str::trim).filter(|a| !a.is_empty()).map(str::to_string),
        }
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
}

/// Why a warm start failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmFail {
    pub message: String,
    /// The agent needs a sign-in: asking again soon cannot help.
    pub auth: bool,
}

/// What the pool needs from the machine.
pub trait WarmHost: Send + Sync + 'static {
    type Item: Send + 'static;
    /// Starts a session for `key` in `folder` (blocking: until it is ready).
    fn start(&self, key: &WarmKey, folder: &Path) -> Result<Self::Item, WarmFail>;
    /// Still running and ready.
    fn alive(&self, item: &Self::Item) -> bool;
    /// Stops it for good.
    fn close(&self, item: Self::Item);
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
}

struct Inner<T> {
    slots: BTreeMap<WarmKey, Slot<T>>,
    policy: Policy,
    generation: u64,
    shut: bool,
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
        Arc::new(Self { host, inner: Mutex::new(Inner { slots: BTreeMap::new(), policy: Policy::default(), generation: 0, shut: false }) })
    }

    pub fn set_policy(&self, policy: Policy) {
        self.inner.lock().policy = policy;
    }

    /// The keys to have a session for now: the wanted ones, and the ones used lately for an agent that may be reused.
    fn effective(inner: &Inner<H::Item>, now: i64) -> BTreeSet<WarmKey> {
        let mut keys: BTreeSet<WarmKey> = inner.policy.wanted.iter().map(|w| w.key.clone()).collect();
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
            inner.slots.entry(want.key.clone()).or_insert_with(|| Slot { folder: want.folder.clone(), state: State::Empty, fails: 0, backoff_until: 0, cold: false, last_use: None });
        }
        let effective = Self::effective(inner, now);
        let idle_ms = inner.policy.idle_ms;
        for (key, slot) in inner.slots.iter_mut() {
            let wanted_now = effective.contains(key);
            if let State::Ready { item, since } = &slot.state {
                let dead = !self.host.alive(item);
                let idle = now - *since >= idle_ms;
                if dead || idle || !wanted_now {
                    if let State::Ready { item, .. } = std::mem::replace(&mut slot.state, State::Empty) {
                        close.push(item);
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
        let cap = inner.policy.cap.min(MAX_PRELOAD_TOTAL);
        let mut taken = Self::taken(inner);
        let mut generation = inner.generation;
        for key in &effective {
            if taken >= cap {
                break;
            }
            let Some(slot) = inner.slots.get_mut(key) else { continue };
            if matches!(slot.state, State::Empty) && !slot.cold && now >= slot.backoff_until {
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
        let result = self.host.start(&job.key, &job.folder);
        self.finish(&job.key, job.generation, result, now());
    }

    fn finish(&self, key: &WarmKey, generation: u64, result: Result<H::Item, WarmFail>, now: i64) {
        let mut leftover = None;
        {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            let current = inner.slots.get_mut(key).filter(|slot| matches!(slot.state, State::Starting { generation: g } if g == generation));
            match (current, result, inner.shut) {
                (Some(slot), Ok(item), false) => {
                    slot.fails = 0;
                    slot.backoff_until = 0;
                    slot.state = State::Ready { item, since: now };
                }
                (Some(slot), Err(fail), _) => {
                    slot.fails += 1;
                    slot.backoff_until = now + backoff_ms(slot.fails, fail.auth);
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
                inner.slots.insert(key.clone(), Slot { folder: folder.to_path_buf(), state: State::Empty, fails: 0, backoff_until: 0, cold: false, last_use: None });
            }
            let slot = inner.slots.get_mut(key)?;
            slot.last_use = Some(now);
            slot.cold = false;
            match std::mem::replace(&mut slot.state, State::Empty) {
                State::Ready { item, .. } => {
                    if self.host.alive(&item) {
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
        self.spawn(jobs);
    }

    /// Takes the warm session for `key` and starts the refill in the background.
    pub fn claim(self: &Arc<Self>, key: &WarmKey, folder: &Path, now: i64) -> Option<H::Item> {
        let hit = self.claim_without_refill(key, folder, now);
        self.tick(now);
        hit
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
}

/// The agent's config as a comparable value.
pub fn config_fingerprint(cfg: &AgentConfig) -> serde_json::Value {
    serde_json::to_value(cfg).unwrap_or(serde_json::Value::Null)
}

impl WarmHost for LiveHost {
    type Item = WarmChat;

    fn start(&self, key: &WarmKey, folder: &Path) -> Result<WarmChat, WarmFail> {
        let fail = |message: String| WarmFail { message, auth: false };
        // The same refusals a real start makes: a blocked adapter or a missing add-on is not warmed.
        if let Some(reason) = super::adapter_health::check_before_start(&key.agent) {
            return Err(fail(reason));
        }
        let cfg = self.conversations.warm_config(&key.agent).map_err(|e| fail(e.to_string()))?;
        if super::install::is_missing(&cfg, &super::config::RealHost) {
            return Err(fail("the add-on is not installed".into()));
        }
        let (id, session) = self.conversations.prepare_warm(&key.agent, folder, key.account.as_deref()).map_err(|e| fail(e.to_string()))?;
        if let Err(error) = session.ensure_running() {
            session.close();
            return Err(WarmFail { auth: matches!(error, AcpError::AuthRequired { .. }), message: error.to_string() });
        }
        Ok(WarmChat { id, session, folder: folder.to_path_buf(), account: key.account.clone(), config: config_fingerprint(&cfg) })
    }

    fn alive(&self, item: &WarmChat) -> bool {
        item.session.is_ready()
    }

    fn close(&self, item: WarmChat) {
        item.session.close();
    }
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

/// The pool does not start spawning until the app has had this long to come up (the standby pool waits the same).
const STARTUP_GRACE_MS: i64 = 8_000;
const TICK: Duration = Duration::from_secs(2);

/// Starts the loop (once): every few seconds the policy is read from the standby settings and the pool follows it.
pub fn init(registry: Arc<Mutex<crate::pty::PaneRegistry>>) {
    if GLOBAL.read().is_some() {
        return;
    }
    let pool = Pool::new(Arc::new(LiveHost { conversations: super::conversations::global().clone() }));
    *GLOBAL.write() = Some(pool.clone());
    LOOP_STOP.store(false, Ordering::SeqCst);
    let started = crate::event_log::now_ms();
    let spawned = std::thread::Builder::new().name("acp-warm-pool".into()).spawn(move || {
        while !LOOP_STOP.load(Ordering::SeqCst) && !pool.is_shut_down() {
            std::thread::sleep(TICK);
            let now = crate::event_log::now_ms();
            let policy = match crate::standby::config_snapshot() {
                Some(config) if now - started >= STARTUP_GRACE_MS => {
                    let project = crate::standby::default_project(&registry);
                    compute_policy(&config, Some(Path::new(&project)), &LiveProbe)
                }
                _ => Policy::default(),
            };
            pool.set_policy(policy);
            pool.tick(now);
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
