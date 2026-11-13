//! The add-agent ladder (night 2026-11-13, contract 2): one click, zero model calls.
//!
//! `Ladder::start` returns at once with a run in state `checking`; a worker thread then walks the steps
//! `find, version, chat_way, handshake, models, save` and emits the whole run (`add-agent://progress`) after every
//! change. The ladder only ever starts programs through the wizard's guarded runner (`exec`) or the two-request
//! hello (`ladder_handshake`: `initialize`, `session/new`, never a prompt). It never answers a question for the
//! person, never passes a flag that is not in a shipped table, and never overwrites a file.
//!
//! What the machine and the app provide (catalog, registry, install, reload, the capability store) is behind
//! [`Backends`], so the tests run the real ladder against fakes. The real `Backends` live in
//! `commands/add_agent.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;

use crate::acp::adapter_catalog::AdapterEntry;
use crate::acp::config::AgentConfig;
use crate::acp::registry::{self, Choice, Registry};
use crate::agent_caps::types::{AgentCaps, Level, MAX_MODELS};
use crate::tui::declarative::approvals::now_rfc3339;

use super::exec::{self, cut_chars, mask_private, GuardLimits, RunSpec};
use super::headless_probe::{self as hp, ProbeConsent, ProbeOutcome, ProbeRequest};
use super::ladder_handshake::{self as hs, HelloError, HelloSpec, NewOutcome};
use super::ladder_save::{self as save, Written};
use super::locate;
use super::session::{make_work_dir, remove_work_dir, Wizard, WizardEnv};

/// Runs are dropped this long after they end.
pub const KEEP_ENDED: Duration = Duration::from_secs(10 * 60);

// ---- the payload (contract 2.2) -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Checking,
    NeedsInstall,
    /// A way to chat without a screen was found in the help text; proving it sends tiny messages, so the person says yes first.
    NeedsConsent,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Pending,
    Running,
    Done,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepRun {
    pub id: &'static str,
    pub state: StepState,
    pub started_ms: Option<u64>,
    pub elapsed_ms: Option<u64>,
    pub limit_ms: u64,
    /// Masked text for Advanced > Details only.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallView {
    /// `program` | `chat_addon`.
    pub kind: &'static str,
    pub label: String,
    pub what_will_run: Vec<String>,
    pub source_host: String,
    pub can_install: bool,
}

/// What the consent screen shows: the check that costs a little of the person's plan, before it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConsentView {
    pub label: String,
    /// The most messages the check may send.
    pub runs: u8,
    /// The command shape, masked. The check word changes on every run.
    pub what_will_run: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AddResult {
    pub agent_id: String,
    pub label: String,
    /// `chat` | `terminal`.
    pub mode: &'static str,
    pub caps: AgentCaps,
    pub sign_in_needed: bool,
    pub already_added: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunError {
    pub code: String,
    pub message: String,
    pub action: &'static str,
    pub step: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AddAgentRun {
    pub run_id: String,
    pub input: String,
    pub agent_id: Option<String>,
    pub label: Option<String>,
    pub state: RunState,
    pub started_ms: u64,
    pub steps: Vec<StepRun>,
    pub install: Option<InstallView>,
    pub consent: Option<ConsentView>,
    pub result: Option<AddResult>,
    pub error: Option<RunError>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- errors (contract 2.4: the message is final copy) -------------------------------------------------------

/// Every error the ladder can end in. `name` is the agent's label, or the typed text when it is unknown.
pub fn error_for(code: &str, name: &str, step: Option<&'static str>) -> RunError {
    let (message, action): (String, &'static str) = match code {
        "ADD_BAD_INPUT" => ("Type one agent name, like kimi.".into(), "retry"),
        "ADD_UNKNOWN_NAME" => (format!("Potato could not find {name} on this computer."), "retry"),
        "ADD_ALREADY_ADDED" => (format!("{name} is already added."), "open_agent"),
        "ADD_INSTALL_FAILED" => ("The install did not finish.".into(), "show_install"),
        "ADD_NOT_SEEN_AFTER_INSTALL" => (format!("{name} is installed, but Potato cannot see it yet."), "restart_app"),
        "ADD_HANDSHAKE_SILENT" => (format!("{name} did not answer in time."), "use_terminal"),
        "ADD_HANDSHAKE_BAD" => (format!("{name} answered in a way Potato does not understand."), "use_terminal"),
        "ADD_CHAT_OFF" => ("Chat is turned off in Labs.".into(), "open_labs"),
        "ADD_SAVE_FAILED" => (format!("Potato could not save {name}. Nothing was changed."), "retry"),
        "ADD_BUSY" => ("Potato is already adding an agent.".into(), "none"),
        _ => ("That check is gone. Start again.".into(), "retry"),
    };
    RunError { code: code.to_string(), message, action, step }
}

/// `Err(String)` shape of the Tauri commands: `"CODE: plain message"`.
fn command_error(code: &str, name: &str) -> String {
    format!("{code}: {}", error_for(code, name, None).message)
}

// ---- what the app provides ----------------------------------------------------------------------------------

/// A catalog agent the typed name matches.
#[derive(Debug, Clone)]
pub struct CatalogHit {
    pub id: String,
    pub label: String,
    /// The program names its definition looks for.
    pub names: Vec<String>,
    /// The shipped definition has an `[acp]` chat table.
    pub has_chat: bool,
    /// The shipped definition has a `[headless]` table.
    pub has_headless: bool,
}

/// How a missing program gets installed, as the person is shown it.
#[derive(Debug, Clone, Default)]
pub struct InstallPlanView {
    pub what_will_run: Vec<String>,
    pub source_host: String,
    pub can_install: bool,
}

/// What the registry (or a reviewed adapter) offers for a chat add-on.
#[derive(Debug, Clone)]
pub struct AddonPlan {
    pub registry_id: Option<String>,
    pub view: InstallPlanView,
}

/// A program and arguments that speak the chat protocol, plus the fixed variables its table names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub extra_env: Vec<(String, String)>,
}

/// What the free hello learned, in the shape the capability store keeps (contract 1.4 `HandshakeFacts`). The ladder
/// hands it to the store as it is, so the store and the result of the add can never say different things.
pub type HandshakeRecord = crate::agent_caps::HandshakeFacts;

pub trait Backends: Send + Sync {
    /// The shipped catalog agent for a typed name (its id or one of its program names).
    fn catalog_lookup(&self, name: &str) -> Option<CatalogHit>;
    fn registry(&self) -> Registry;
    fn adapters_for(&self, program: &str) -> Vec<AdapterEntry>;
    fn is_registered(&self, id: &str) -> bool;
    fn chat_enabled(&self) -> bool;
    /// The install plan for a program that is not on this computer. `None`: nothing is known about installing it.
    fn program_install_plan(&self, id: &str) -> Option<InstallPlanView>;
    /// The chat table of a shipped definition.
    fn shipped_chat(&self, id: &str) -> Option<AgentConfig>;
    /// The add-on plan the registry offers (`choice` is its `Npx` or `Binary`).
    fn addon_plan(&self, agent: &registry::RegistryAgent, choice: &Choice) -> AddonPlan;
    /// Installs the add-on and returns the chat table that now exists for `agent_id`. Runs only what `plan` showed.
    fn install_addon(&self, plan: &AddonPlan, agent_id: &str, label: &str, cancel: &AtomicBool) -> Result<AgentConfig, String>;
    fn catalog_add(&self, id: &str) -> Result<(), String>;
    fn catalog_remove(&self, id: &str);
    /// Reload the agent registry so a new definition is usable at once.
    fn reload(&self);
    /// Hand the free check's facts to the capability store (`agent_caps::record_handshake`).
    fn record_handshake(&self, agent_id: &str, facts: &HandshakeRecord) -> Result<(), String>;
    /// The agent's capability table as the store gives it now: the result of an add shows exactly this.
    fn caps_of(&self, agent_id: &str) -> AgentCaps;
}

/// The program, arguments and fixed variables to start for a chat table. Only the variables the table names
/// itself (`env`, `env_which`) pass; nothing else of the app's environment does.
pub fn launch_of(cfg: &AgentConfig) -> Result<Launch, String> {
    let spec = crate::acp::config::resolve_spawn(cfg, &crate::acp::config::RealHost, &std::env::temp_dir()).map_err(|e| e.to_string())?;
    let named = |name: &str| cfg.env.keys().chain(cfg.env_which.keys()).any(|k| k.eq_ignore_ascii_case(name));
    let extra_env = spec
        .env
        .iter()
        .filter_map(|(k, v)| {
            let k = k.to_string_lossy().into_owned();
            named(&k).then(|| (k, v.to_string_lossy().into_owned()))
        })
        .collect();
    Ok(Launch {
        program: PathBuf::from(&spec.program),
        args: spec.args.iter().map(|a| a.to_string_lossy().into_owned()).collect(),
        extra_env,
    })
}

// ---- limits -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LadderCfg {
    pub find: Duration,
    pub version: Duration,
    pub chat_way: Duration,
    pub init: Duration,
    pub session_new: Duration,
    pub save: Duration,
    pub install: Duration,
    /// Limits of each run of the headless probe (reading the help, and the paid check after a yes).
    pub probe: GuardLimits,
    /// The whole free path.
    pub total: Duration,
}

impl Default for LadderCfg {
    fn default() -> Self {
        Self {
            find: Duration::from_secs(2),
            version: Duration::from_secs(5),
            chat_way: Duration::from_secs(10),
            init: Duration::from_secs(8),
            session_new: Duration::from_secs(10),
            save: Duration::from_secs(5),
            install: crate::acp::install::INSTALL_LIMIT,
            probe: GuardLimits::default(),
            total: Duration::from_secs(30),
        }
    }
}

const PLANNED: [&str; 6] = ["find", "version", "chat_way", "handshake", "models", "save"];

fn limit_ms(cfg: &LadderCfg, id: &str) -> u64 {
    let d = match id {
        "find" => cfg.find,
        "version" => cfg.version,
        "chat_way" => cfg.chat_way,
        "handshake" => cfg.init + cfg.session_new,
        "models" => Duration::ZERO,
        "save" => cfg.save,
        _ => cfg.install,
    };
    d.as_millis() as u64
}

fn planned_steps(cfg: &LadderCfg, with_install: bool) -> Vec<StepRun> {
    let ids: Vec<&'static str> = if with_install { std::iter::once("install").chain(PLANNED).collect() } else { PLANNED.to_vec() };
    ids.into_iter().map(|id| StepRun { id, state: StepState::Pending, started_ms: None, elapsed_ms: None, limit_ms: limit_ms(cfg, id), detail: None }).collect()
}

// ---- one run ------------------------------------------------------------------------------------------------

struct Pending {
    plan: AddonPlan,
    agent_id: String,
    label: String,
    terminal_only: bool,
}

/// How far the headless probe may go in this pass of the ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeMode {
    /// Read the help text only. A flag that needs a real answer to prove it stops the run for the person's yes.
    Free,
    /// The person said yes: at most `hp::MAX_PAID_RUNS` tiny runs.
    Paid,
    /// The person said no: the program is added for the terminal.
    Skip,
}

struct Inner {
    run: AddAgentRun,
    pending: Option<Pending>,
    written: Option<Written>,
    requests_sent: Vec<String>,
    ended: Option<Instant>,
}

struct Cell {
    inner: Mutex<Inner>,
    cancel: AtomicBool,
}

enum Stop {
    Cancelled,
    Fail(RunError),
    NeedsInstall,
    NeedsConsent,
}

/// Which way the ladder found to chat.
enum ChatWay {
    /// `Level::L0` own chat or `Level::L1` add-on, started with `launch`. `own` = no catalog entry (the chat
    /// definition is written by the ladder).
    Acp { level: Level, launch: Launch, command: String, args: Vec<String> },
    Headless,
    /// The probe proved a way to answer one task without a screen; `toml` is its `[headless]` table.
    Probed { toml: String },
    /// The person chose "use it in a terminal": the chat was not looked for.
    Terminal,
    /// Every chat step said no.
    None,
}

struct Target {
    name: String,
    id: String,
    label: String,
    catalog: Option<CatalogHit>,
    registry: Option<registry::RegistryAgent>,
    program: Option<PathBuf>,
}

pub struct Ladder {
    env: Arc<dyn Fn() -> WizardEnv + Send + Sync>,
    be: Arc<dyn Backends>,
    emit: Arc<dyn Fn(&AddAgentRun) + Send + Sync>,
    cfg: LadderCfg,
    runs: Mutex<HashMap<String, Arc<Cell>>>,
    /// PIDs of every hello child started (tests check they are gone).
    pids: Mutex<Vec<u32>>,
}

fn new_run_id() -> String {
    use rand::Rng;
    format!("{:06x}", rand::thread_rng().gen::<u32>() & 0x00ff_ffff)
}

fn title_case(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The extension in lower case (`kimi.EXE` becomes `kimi.exe`) when that file is the same file.
pub fn lower_ext(path: PathBuf) -> PathBuf {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else { return path };
    if ext.chars().all(|c| !c.is_ascii_uppercase()) {
        return path;
    }
    let lowered = path.with_extension(ext.to_ascii_lowercase());
    if lowered.exists() {
        lowered
    } else {
        path
    }
}

impl Ladder {
    pub fn new(env: Arc<dyn Fn() -> WizardEnv + Send + Sync>, be: Arc<dyn Backends>, emit: Arc<dyn Fn(&AddAgentRun) + Send + Sync>, cfg: LadderCfg) -> Arc<Self> {
        Arc::new(Self { env, be, emit, cfg, runs: Mutex::new(HashMap::new()), pids: Mutex::new(Vec::new()) })
    }

    // ---- the four commands ----

    pub fn start(self: &Arc<Self>, input: &str, terminal_only: bool) -> Result<AddAgentRun, String> {
        self.prune();
        let run = AddAgentRun {
            run_id: new_run_id(),
            input: input.trim().to_string(),
            agent_id: None,
            label: None,
            state: RunState::Checking,
            started_ms: now_ms(),
            steps: planned_steps(&self.cfg, false),
            install: None,
            consent: None,
            result: None,
            error: None,
        };
        let cell = Arc::new(Cell {
            inner: Mutex::new(Inner { run: run.clone(), pending: None, written: None, requests_sent: Vec::new(), ended: None }),
            cancel: AtomicBool::new(false),
        });
        {
            // The busy check and the insert are one step: two starts at once cannot both pass.
            let mut runs = self.runs.lock();
            if runs.values().any(|c| c.inner.lock().run.state == RunState::Checking) {
                return Err(command_error("ADD_BUSY", ""));
            }
            runs.insert(run.run_id.clone(), cell.clone());
        }
        (self.emit)(&run);
        let me = self.clone();
        let typed = run.input.clone();
        let worker = cell.clone();
        let spawned = std::thread::Builder::new().name("add-agent".into()).spawn(move || me.execute(&worker, &typed, terminal_only, None, ProbeMode::Free));
        if let Err(e) = spawned {
            // A run that never started must not block every later start.
            self.finish_failed(&cell, error_for("ADD_SAVE_FAILED", "", None));
            return Err(format!("ADD_SAVE_FAILED: {e}"));
        }
        Ok(run)
    }

    pub fn status(&self, run_id: &str) -> Result<AddAgentRun, String> {
        self.prune();
        self.cell(run_id).map(|c| c.inner.lock().run.clone())
    }

    pub fn cancel(&self, run_id: &str) -> Result<AddAgentRun, String> {
        let cell = self.cell(run_id)?;
        let state = cell.inner.lock().run.state;
        match state {
            RunState::Done | RunState::Failed | RunState::Cancelled => {}
            RunState::NeedsInstall | RunState::NeedsConsent => {
                cell.cancel.store(true, Ordering::SeqCst);
                self.update(&cell, |i| {
                    i.pending = None;
                    i.run.install = None;
                    i.run.consent = None;
                    i.run.state = RunState::Cancelled;
                    i.ended = Some(Instant::now());
                });
            }
            RunState::Checking => {
                cell.cancel.store(true, Ordering::SeqCst);
                let until = Instant::now() + Duration::from_secs(5);
                while Instant::now() < until && cell.inner.lock().run.state == RunState::Checking {
                    std::thread::sleep(Duration::from_millis(20));
                }
                // A step that cannot be interrupted (a help text still being read) must not leave the window
                // waiting: the run ends here, and whatever the step returns later changes nothing.
                if cell.inner.lock().run.state == RunState::Checking {
                    self.finish_cancelled(&cell);
                }
            }
        }
        let run = cell.inner.lock().run.clone();
        Ok(run)
    }

    /// The one approval an install needs. Only a chat add-on the app can install runs; anything else is returned as is.
    pub fn approve_install(self: &Arc<Self>, run_id: &str) -> Result<AddAgentRun, String> {
        let cell = self.cell(run_id)?;
        let cfg = self.cfg.clone();
        // One lock: the pending install is taken and the state flips in the same step, so a double click runs once.
        // The runs lock comes first (as in `start`), so a second add cannot slip in between.
        let (terminal_only, plan, agent_id, label, input, frame) = {
            let runs = self.runs.lock();
            let mut i = cell.inner.lock();
            let installable = i.run.state == RunState::NeedsInstall && i.run.install.as_ref().is_some_and(|v| v.can_install && v.kind == "chat_addon");
            if !installable || i.pending.is_none() {
                return Ok(i.run.clone());
            }
            if runs.values().any(|c| !Arc::ptr_eq(c, &cell) && c.inner.lock().run.state == RunState::Checking) {
                return Err(command_error("ADD_BUSY", ""));
            }
            let Some(p) = i.pending.take() else { return Ok(i.run.clone()) };
            i.run.state = RunState::Checking;
            i.run.steps = planned_steps(&cfg, true);
            i.run.error = None;
            i.ended = None;
            (p.terminal_only, p.plan, p.agent_id, p.label, i.run.input.clone(), i.run.clone())
        };
        (self.emit)(&frame);
        self.step_start(&cell, "install");
        let me = self.clone();
        let c2 = cell.clone();
        std::thread::Builder::new()
            .name("add-agent-install".into())
            .spawn(move || {
                match me.be.install_addon(&plan, &agent_id, &label, &c2.cancel) {
                    Ok(chat) => {
                        me.step_end(&c2, "install", StepState::Done, Some("installed".into()));
                        me.execute(&c2, &input, terminal_only, Some(chat), ProbeMode::Free);
                    }
                    Err(why) => {
                        if c2.cancel.load(Ordering::SeqCst) {
                            me.finish_cancelled(&c2);
                        } else {
                            me.step_end(&c2, "install", StepState::Failed, Some(exec::clean(&why)));
                            me.finish_failed(&c2, error_for("ADD_INSTALL_FAILED", &label, Some("install")));
                        }
                    }
                }
            })
            .map_err(|e| {
                self.finish_failed(&cell, error_for("ADD_INSTALL_FAILED", "", Some("install")));
                format!("ADD_INSTALL_FAILED: {e}")
            })?;
        let run = cell.inner.lock().run.clone();
        Ok(run)
    }

    /// The person's yes to the check: the ladder runs again and the headless probe may send its tiny messages.
    pub fn approve_check(self: &Arc<Self>, run_id: &str) -> Result<AddAgentRun, String> {
        self.resume_after_consent(run_id, ProbeMode::Paid)
    }

    /// The person's no: the program is added for the terminal and nothing is sent to it.
    pub fn skip_check(self: &Arc<Self>, run_id: &str) -> Result<AddAgentRun, String> {
        self.resume_after_consent(run_id, ProbeMode::Skip)
    }

    fn resume_after_consent(self: &Arc<Self>, run_id: &str, mode: ProbeMode) -> Result<AddAgentRun, String> {
        let cell = self.cell(run_id)?;
        let cfg = self.cfg.clone();
        // One lock, as in `approve_install`: the state flips in the same step, so a double click runs once.
        let (input, frame) = {
            let runs = self.runs.lock();
            let mut i = cell.inner.lock();
            if i.run.state != RunState::NeedsConsent {
                return Ok(i.run.clone());
            }
            if runs.values().any(|c| !Arc::ptr_eq(c, &cell) && c.inner.lock().run.state == RunState::Checking) {
                return Err(command_error("ADD_BUSY", ""));
            }
            i.run.state = RunState::Checking;
            i.run.steps = planned_steps(&cfg, false);
            i.run.consent = None;
            i.run.error = None;
            i.ended = None;
            (i.run.input.clone(), i.run.clone())
        };
        (self.emit)(&frame);
        let me = self.clone();
        let worker = cell.clone();
        std::thread::Builder::new().name("add-agent-check".into()).spawn(move || me.execute(&worker, &input, false, None, mode)).map_err(|e| {
            self.finish_failed(&cell, error_for("ADD_SAVE_FAILED", "", None));
            format!("ADD_SAVE_FAILED: {e}")
        })?;
        let run = cell.inner.lock().run.clone();
        Ok(run)
    }

    // ---- test and diagnostics access ----

    /// The request names ever written to the agent in this run (`initialize`, `session/new`).
    pub fn requests_sent(&self, run_id: &str) -> Vec<String> {
        self.cell(run_id).map(|c| c.inner.lock().requests_sent.clone()).unwrap_or_default()
    }

    /// Run ids that are in state `checking` right now (tests: never more than one).
    #[cfg(test)]
    pub fn live_checking(&self) -> Vec<String> {
        self.runs.lock().iter().filter(|(_, c)| c.inner.lock().run.state == RunState::Checking).map(|(id, _)| id.clone()).collect()
    }

    pub fn child_pids(&self) -> Vec<u32> {
        self.pids.lock().clone()
    }

    fn cell(&self, run_id: &str) -> Result<Arc<Cell>, String> {
        self.runs.lock().get(run_id).cloned().ok_or_else(|| command_error("ADD_RUN_NOT_FOUND", ""))
    }

    fn prune(&self) {
        self.runs.lock().retain(|_, c| c.inner.lock().ended.map_or(true, |t| t.elapsed() < KEEP_ENDED));
    }

    // ---- state changes (every one emits the whole run) ----

    fn update(&self, cell: &Cell, change: impl FnOnce(&mut Inner)) {
        let run = {
            let mut i = cell.inner.lock();
            change(&mut i);
            i.run.clone()
        };
        (self.emit)(&run);
    }

    fn step_start(&self, cell: &Cell, id: &'static str) {
        self.update(cell, |i| {
            if let Some(s) = i.run.steps.iter_mut().find(|s| s.id == id) {
                s.state = StepState::Running;
                s.started_ms = Some(now_ms());
            }
        });
    }

    fn step_end(&self, cell: &Cell, id: &'static str, state: StepState, detail: Option<String>) {
        self.update(cell, |i| {
            if let Some(s) = i.run.steps.iter_mut().find(|s| s.id == id) {
                s.elapsed_ms = Some(s.started_ms.map_or(0, |t| now_ms().saturating_sub(t)));
                s.state = state;
                s.detail = detail.map(|d| cut_chars(&mask_private(&d), 300));
            }
        });
    }

    fn finish_failed(&self, cell: &Cell, error: RunError) {
        self.update(cell, |i| {
            // A run the person cancelled stays cancelled.
            if i.run.state == RunState::Cancelled {
                return;
            }
            i.run.state = RunState::Failed;
            i.run.error = Some(error);
            i.ended = Some(Instant::now());
        });
    }

    fn finish_cancelled(&self, cell: &Cell) {
        if cell.inner.lock().run.state == RunState::Cancelled {
            return;
        }
        let env = (self.env)();
        let written = cell.inner.lock().written.take();
        if let Some(w) = written {
            self.undo(&env, &w);
        }
        self.update(cell, |i| {
            i.run.state = RunState::Cancelled;
            i.run.result = None;
            i.ended = Some(Instant::now());
        });
    }

    fn undo(&self, env: &WizardEnv, written: &Written) {
        if let Some(id) = &written.catalog_id {
            self.be.catalog_remove(id);
        }
        save::undo(env, written);
        self.be.reload();
    }

    fn check_cancel(&self, cell: &Cell) -> Result<(), Stop> {
        if cell.cancel.load(Ordering::SeqCst) {
            Err(Stop::Cancelled)
        } else {
            Ok(())
        }
    }

    // ---- the ladder ----

    fn execute(self: &Arc<Self>, cell: &Arc<Cell>, input: &str, terminal_only: bool, addon: Option<AgentConfig>, mode: ProbeMode) {
        match self.walk(cell, input, terminal_only, addon, mode) {
            Ok(result) => self.update(cell, |i| {
                if i.run.state == RunState::Cancelled {
                    return;
                }
                i.run.state = RunState::Done;
                i.run.result = Some(result);
                i.ended = Some(Instant::now());
            }),
            Err(Stop::Cancelled) => self.finish_cancelled(cell),
            Err(Stop::Fail(e)) => {
                let written = cell.inner.lock().written.take();
                if let Some(w) = written {
                    self.undo(&(self.env)(), &w);
                }
                self.finish_failed(cell, e)
            }
            Err(Stop::NeedsInstall | Stop::NeedsConsent) => {}
        }
    }

    fn fail_step(&self, cell: &Cell, step: &'static str, code: &str, name: &str, detail: Option<String>) -> Stop {
        self.step_end(cell, step, StepState::Failed, detail);
        Stop::Fail(error_for(code, name, Some(step)))
    }

    fn walk(self: &Arc<Self>, cell: &Arc<Cell>, input: &str, terminal_only: bool, addon: Option<AgentConfig>, mode: ProbeMode) -> Result<AddResult, Stop> {
        let env = (self.env)();
        let deadline = Instant::now() + self.cfg.total;
        let (mut target, program_path) = self.find(cell, &env, input)?;
        self.check_cancel(cell)?;
        let version = self.version(cell, &env, &program_path)?;
        self.check_cancel(cell)?;
        target.program = Some(program_path.clone());

        let way = if terminal_only {
            self.step_start(cell, "chat_way");
            self.step_end(cell, "chat_way", StepState::Done, Some("terminal only, as asked".into()));
            ChatWay::Terminal
        } else {
            self.chat_way(cell, &env, &target, addon, mode)?
        };
        self.check_cancel(cell)?;

        let mut hello: Option<hs::Hello> = None;
        let mut models: Option<(Vec<String>, u32)> = None;
        match &way {
            ChatWay::Acp { launch, .. } => {
                hello = Some(self.handshake(cell, &target, launch, deadline)?);
                self.check_cancel(cell)?;
                models = self.models(cell, hello.as_ref());
            }
            _ => {
                self.step_skip(cell, "handshake", "no chat hello needed");
                self.step_skip(cell, "models", "no model list");
            }
        }
        self.check_cancel(cell)?;
        self.save(cell, &env, &target, &way, version, hello.as_ref(), models)
    }

    fn step_skip(&self, cell: &Cell, id: &'static str, why: &str) {
        self.step_start(cell, id);
        self.step_end(cell, id, StepState::Skipped, Some(why.into()));
    }

    // ---- step 1: find ----

    fn name_from_input(&self, input: &str) -> Option<String> {
        let tokens: Vec<&str> = input.split_whitespace().collect();
        match tokens.len() {
            0 => None,
            1 => locate::command_name(tokens[0]).ok().map(|n| n.to_ascii_lowercase()),
            _ => self.name_from_install_command(&tokens),
        }
    }

    /// `npm install -g @scope/kimi-cli` -> `kimi` when the catalog or the registry knows that program.
    fn name_from_install_command(&self, tokens: &[&str]) -> Option<String> {
        const SKIP: &[&str] = &["npm", "npx", "pnpm", "yarn", "bun", "bunx", "pip", "pip3", "pipx", "uv", "uvx", "tool", "install", "i", "add", "global", "run", "sudo"];
        let package = tokens.iter().find(|t| !t.starts_with('-') && !SKIP.contains(&t.to_ascii_lowercase().as_str()))?;
        let base = package.rsplit('/').next().unwrap_or(package);
        let base = base.split(['@', '=', '<', '>']).find(|p| !p.is_empty()).unwrap_or(base).to_ascii_lowercase();
        let mut candidates = vec![base.clone()];
        for suffix in ["-cli", "-code", "-agent", "-acp"] {
            if let Some(stripped) = base.strip_suffix(suffix) {
                candidates.push(stripped.to_string());
            }
        }
        let registry = self.be.registry();
        candidates.into_iter().find(|c| self.be.catalog_lookup(c).is_some() || registry::find_match(&registry, c, c, c).is_some())
    }

    fn find(&self, cell: &Arc<Cell>, env: &WizardEnv, input: &str) -> Result<(Target, PathBuf), Stop> {
        self.step_start(cell, "find");
        let Some(name) = self.name_from_input(input) else {
            return Err(self.fail_step(cell, "find", "ADD_BAD_INPUT", input, None));
        };
        let catalog = self.be.catalog_lookup(&name);
        let reg = self.be.registry();
        let in_registry = registry::find_match(&reg, &name, &name, &name).cloned();
        let id = catalog.as_ref().map_or_else(|| locate::id_suggestion(&name), |c| c.id.clone());
        let label = catalog.as_ref().map(|c| c.label.clone()).filter(|l| !l.trim().is_empty()).unwrap_or_else(|| title_case(&name));
        self.update(cell, |i| {
            i.run.agent_id = Some(id.clone());
            i.run.label = Some(label.clone());
        });
        if self.be.is_registered(&id) || self.be.is_registered(&name) {
            return Err(self.fail_step(cell, "find", "ADD_ALREADY_ADDED", &label, None));
        }
        let dirs = locate::search_dirs(env);
        let mut names: Vec<String> = catalog.as_ref().map(|c| c.names.clone()).unwrap_or_default();
        if !names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            names.push(name.clone());
        }
        let found = names.iter().find_map(|n| locate::locate(n, &dirs).ok().map(|l| (n.clone(), lower_ext(l.path))));
        let mut target = Target { name: name.clone(), id: id.clone(), label: label.clone(), catalog, registry: in_registry, program: None };
        match found {
            Some((program_name, path)) => {
                target.name = program_name;
                let shown = exec::clean(&locate::display_path(&path));
                self.step_end(cell, "find", StepState::Done, Some(shown));
                Ok((target, path))
            }
            None => {
                let known = target.catalog.is_some() || target.registry.is_some();
                if !known {
                    return Err(self.fail_step(cell, "find", "ADD_UNKNOWN_NAME", &name, Some("not on PATH, not in the catalog or the registry".into())));
                }
                let plan = self.be.program_install_plan(&id).unwrap_or_default();
                // The app shows the command; it does not run a program install by itself (contract open seam 3).
                let view = InstallView { kind: "program", label: label.clone(), what_will_run: plan.what_will_run, source_host: plan.source_host, can_install: false };
                self.step_end(cell, "find", StepState::Done, Some("not on this computer".into()));
                self.update(cell, |i| {
                    i.run.state = RunState::NeedsInstall;
                    i.run.install = Some(view);
                    i.pending = None;
                    i.ended = Some(Instant::now());
                });
                Err(Stop::NeedsInstall)
            }
        }
    }

    // ---- step 2: version ----

    fn version(&self, cell: &Cell, env: &WizardEnv, program: &Path) -> Result<Option<String>, Stop> {
        self.step_start(cell, "version");
        let work = make_work_dir(&env.temp_root, &Wizard::new_id()).ok();
        let Some(work) = work else {
            self.step_end(cell, "version", StepState::Skipped, Some("no work folder".into()));
            return Ok(None);
        };
        let args = vec!["--version".to_string()];
        let vars = locate::probe_env();
        let mut spec = RunSpec::new(program, &args, &work);
        spec.env = &vars;
        spec.timeout = self.cfg.version;
        spec.max_bytes = 8 * 1024;
        spec.cancel = Some(&cell.cancel);
        let out = exec::run(&spec);
        remove_work_dir(&work);
        self.check_cancel(cell)?;
        let text = exec::clean(&format!("{}\n{}", out.stdout, out.stderr));
        let number = if out.exit == Some(0) { locate::version_number(&text) } else { None };
        match number {
            Some(n) => {
                self.step_end(cell, "version", StepState::Done, Some(n.clone()));
                Ok(Some(n))
            }
            None => {
                self.step_end(cell, "version", StepState::Skipped, Some("no version shown".into()));
                Ok(None)
            }
        }
    }

    // ---- step 3: chat_way ----

    fn chat_way(&self, cell: &Arc<Cell>, env: &WizardEnv, t: &Target, addon: Option<AgentConfig>, mode: ProbeMode) -> Result<ChatWay, Stop> {
        self.step_start(cell, "chat_way");
        let chat_off = |me: &Self| me.fail_step(cell, "chat_way", "ADD_CHAT_OFF", &t.label, None);
        // After an add-on install the ladder restarts here with the chat table the install made.
        if let Some(cfg) = addon {
            if !self.be.chat_enabled() {
                return Err(chat_off(self));
            }
            return match launch_of(&cfg) {
                Ok(launch) => {
                    self.step_end(cell, "chat_way", StepState::Done, Some("chat add-on installed".into()));
                    Ok(ChatWay::Acp { level: Level::L1, command: cfg.command.clone(), args: cfg.args.clone(), launch })
                }
                Err(why) => Err(self.fail_step(cell, "chat_way", "ADD_HANDSHAKE_BAD", &t.label, Some(why))),
            };
        }
        // (a) a shipped definition with a chat table
        if let Some(cfg) = self.be.shipped_chat(&t.id) {
            if let Ok(launch) = launch_of(&cfg) {
                if !self.be.chat_enabled() {
                    return Err(chat_off(self));
                }
                self.step_end(cell, "chat_way", StepState::Done, Some("shipped chat table".into()));
                return Ok(ChatWay::Acp { level: Level::L0, command: cfg.command.clone(), args: cfg.args.clone(), launch });
            }
        }
        self.check_cancel(cell)?;
        // (b) its own chat command, from its help text or a sibling `<name>-acp`
        if t.catalog.as_ref().map_or(true, |c| !c.has_chat) {
            if let Some(way) = self.own_chat(env, t) {
                if !self.be.chat_enabled() {
                    return Err(chat_off(self));
                }
                self.step_end(cell, "chat_way", StepState::Done, Some("its own chat command".into()));
                return Ok(way);
            }
        }
        self.check_cancel(cell)?;
        // (c) the official registry
        let reg = self.be.registry();
        if let Some((agent, choice)) = registry::resolve(&reg, &t.name, &t.id, &t.label, &registry::platform_key()) {
            if !matches!(choice, Choice::Unsupported(_)) {
                if !self.be.chat_enabled() {
                    return Err(chat_off(self));
                }
                let plan = self.be.addon_plan(agent, &choice);
                return Err(self.addon_needed(cell, t, plan, "registry"));
            }
        }
        // (d) a reviewed adapter
        if !self.be.adapters_for(&t.name).is_empty() {
            if !self.be.chat_enabled() {
                return Err(chat_off(self));
            }
            let plan = AddonPlan { registry_id: None, view: InstallPlanView::default() };
            return Err(self.addon_needed(cell, t, plan, "reviewed adapter"));
        }
        // (e) a shipped headless table
        if t.catalog.as_ref().is_some_and(|c| c.has_headless) {
            self.step_end(cell, "chat_way", StepState::Done, Some("shipped one-shot table".into()));
            return Ok(ChatWay::Headless);
        }
        // (f) the headless probe (L2): the help text says how to ask one thing without a screen
        if mode != ProbeMode::Skip {
            self.check_cancel(cell)?;
            if let Some(way) = self.headless_probe(cell, env, t, mode)? {
                return Ok(way);
            }
        }
        self.step_end(cell, "chat_way", StepState::Skipped, Some("no chat way found".into()));
        Ok(ChatWay::None)
    }

    /// Step (f) of `chat_way`. Reading the help text is free. Proving the way sends up to two tiny messages, which
    /// needs the person's yes: without it the run stops in `needs_consent` and nothing has been sent.
    fn headless_probe(&self, cell: &Cell, env: &WizardEnv, t: &Target, mode: ProbeMode) -> Result<Option<ChatWay>, Stop> {
        let Some(program) = t.program.as_ref() else { return Ok(None) };
        let Ok(work_dir) = make_work_dir(&env.temp_root, &Wizard::new_id()) else { return Ok(None) };
        let req = ProbeRequest { tokens: vec![program.to_string_lossy().into_owned()], helps: Vec::new(), work_dir: work_dir.clone(), limits: self.cfg.probe };
        let free = hp::probe(&req, None);
        let result = match (&free.outcome, mode) {
            (ProbeOutcome::NeedsConsent, ProbeMode::Paid) => {
                if self.check_cancel(cell).is_err() {
                    remove_work_dir(&work_dir);
                    return Err(Stop::Cancelled);
                }
                // The one place a prompt can leave: the token exists only because the person said yes.
                Some(hp::probe(&req, Some(ProbeConsent::granted(hp::MAX_PAID_RUNS))))
            }
            (ProbeOutcome::NeedsConsent, _) => {
                remove_work_dir(&work_dir);
                let name = program.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| t.name.clone());
                let shape = free.headless.as_ref().map(|d| {
                    let mut line = vec![name.clone()];
                    line.extend(d.argv.iter().cloned());
                    if let Some(flag) = &d.task_flag {
                        line.push(flag.clone());
                    }
                    if let Some(sep) = &d.task_separator {
                        line.push(sep.clone());
                    }
                    line.push("\"Reply with exactly: <check word>\"".into());
                    line.join(" ")
                });
                let view = ConsentView { label: t.label.clone(), runs: hp::MAX_PAID_RUNS, what_will_run: shape.map(|l| vec![cut_chars(&mask_private(&l), 300)]).unwrap_or_default() };
                self.step_end(cell, "chat_way", StepState::Done, Some("a way to ask without a screen was found; waiting for a yes to check it".into()));
                self.update(cell, |i| {
                    i.run.state = RunState::NeedsConsent;
                    i.run.consent = Some(view);
                    i.ended = Some(Instant::now());
                });
                return Err(Stop::NeedsConsent);
            }
            _ => None,
        };
        remove_work_dir(&work_dir);
        let Some(res) = result else { return Ok(None) };
        match (&res.outcome, res.headless_toml()) {
            (ProbeOutcome::Found, Some(toml)) => {
                let n = res.runs_used;
                self.step_end(cell, "chat_way", StepState::Done, Some(format!("answers one task without a screen ({n} check message{})", if n == 1 { "" } else { "s" })));
                Ok(Some(ChatWay::Probed { toml }))
            }
            _ => Ok(None),
        }
    }

    fn addon_needed(&self, cell: &Cell, t: &Target, plan: AddonPlan, via: &str) -> Stop {
        let view = InstallView {
            kind: "chat_addon",
            label: t.label.clone(),
            what_will_run: plan.view.what_will_run.clone(),
            source_host: plan.view.source_host.clone(),
            can_install: plan.view.can_install,
        };
        self.step_end(cell, "chat_way", StepState::Done, Some(format!("chat add-on available ({via})")));
        let pending = Pending { plan, agent_id: t.id.clone(), label: t.label.clone(), terminal_only: false };
        self.update(cell, |i| {
            i.run.state = RunState::NeedsInstall;
            i.run.install = Some(view);
            i.pending = Some(pending);
            i.ended = Some(Instant::now());
        });
        Stop::NeedsInstall
    }

    /// The program's own chat command (`wizard::acp::detect_program`: help text, then one `initialize` check).
    fn own_chat(&self, env: &WizardEnv, t: &Target) -> Option<ChatWay> {
        let env2 = env.clone();
        let wizard = Wizard::new(move || env2.clone());
        let out = super::acp::detect_program(&wizard, &t.name).ok()?;
        if out["initialize_check"]["ok"] != json!(true) {
            return None;
        }
        let command = out["command"].as_str()?.to_string();
        let args: Vec<String> = out["candidates"][0]["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let dirs = locate::search_dirs(env);
        let program = lower_ext(locate::locate(&command, &dirs).ok()?.path);
        Some(ChatWay::Acp { level: Level::L0, command: command.clone(), args: args.clone(), launch: Launch { program, args, extra_env: Vec::new() } })
    }

    // ---- step 4: handshake ----

    fn handshake(&self, cell: &Cell, t: &Target, launch: &Launch, deadline: Instant) -> Result<hs::Hello, Stop> {
        self.step_start(cell, "handshake");
        let left = deadline.saturating_duration_since(Instant::now());
        let init = self.cfg.init.min(left);
        let new = self.cfg.session_new.min(left.saturating_sub(init).max(Duration::from_secs(1)));
        let pids = &self.pids;
        let on_start = move |pid: u32| pids.lock().push(pid);
        let spec = HelloSpec { program: &launch.program, args: &launch.args, extra_env: &launch.extra_env, init_timeout: init, new_timeout: new, cancel: &cell.cancel, on_start: &on_start };
        match hs::hello(&spec) {
            Ok(hello) => {
                cell.inner.lock().requests_sent = hello.requests_sent.clone();
                let note = match &hello.new {
                    NewOutcome::AuthNeeded => format!("{} answered; it wants a sign-in first", t.label),
                    _ => format!("answered initialize, protocol {}", hello.init.protocol_version),
                };
                self.step_end(cell, "handshake", StepState::Done, Some(note));
                Ok(hello)
            }
            Err(HelloError::Cancelled) => Err(Stop::Cancelled),
            Err(HelloError::Silent) => Err(self.fail_step(cell, "handshake", "ADD_HANDSHAKE_SILENT", &t.label, Some("no reply in time".into()))),
            Err(HelloError::Bad(why)) => Err(self.fail_step(cell, "handshake", "ADD_HANDSHAKE_BAD", &t.label, Some(why))),
        }
    }

    // ---- step 5: models ----

    fn models(&self, cell: &Cell, hello: Option<&hs::Hello>) -> Option<(Vec<String>, u32)> {
        self.step_start(cell, "models");
        let found = match hello.map(|h| &h.new) {
            Some(NewOutcome::Answered(result)) => hs::models_of(result, MAX_MODELS),
            _ => None,
        };
        match &found {
            Some((list, total)) => self.step_end(cell, "models", StepState::Done, Some(format!("{total} models, {} kept", list.len()))),
            None => self.step_end(cell, "models", StepState::Skipped, Some("no model list".into())),
        }
        found
    }

    // ---- step 6: save ----

    /// Catalog agent: the Store path. Otherwise the ladder writes the definition and approves it as the wizard.
    fn write_and_approve(&self, cell: &Cell, env: &WizardEnv, t: &Target, way: &ChatWay, checks: &[String]) -> Result<(), String> {
        if t.catalog.is_some() {
            self.be.catalog_add(&t.id)?;
            cell.inner.lock().written = Some(Written { catalog_id: Some(t.id.clone()), ..Written::default() });
            return Ok(());
        }
        let wizard = {
            let env2 = env.clone();
            Wizard::new(move || env2.clone())
        };
        let mut written = match way {
            ChatWay::Acp { level: Level::L0, command, args, .. } => save::write_chat(&wizard, &t.id, &t.label, &t.name, command, args)?,
            ChatWay::Probed { toml } => save::write_headless(env, &t.id, &t.label, &t.name, toml)?,
            _ => save::write_terminal(env, &t.id, &t.label, &t.name)?,
        };
        cell.inner.lock().written = Some(written.clone());
        save::approve(env, &mut written, &t.id, checks)?;
        cell.inner.lock().written = Some(written);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn save(
        &self,
        cell: &Cell,
        env: &WizardEnv,
        t: &Target,
        way: &ChatWay,
        version: Option<String>,
        hello: Option<&hs::Hello>,
        models: Option<(Vec<String>, u32)>,
    ) -> Result<AddResult, Stop> {
        self.step_start(cell, "save");
        let mut checks = vec!["add_agent:find".to_string()];
        if version.is_some() {
            checks.push("add_agent:version".into());
        }
        if hello.is_some() {
            checks.push("add_agent:handshake".into());
        }
        if matches!(way, ChatWay::Probed { .. }) {
            checks.push("add_agent:headless_probe".into());
        }
        if models.is_some() {
            checks.push("add_agent:models".into());
        }
        if let Err(why) = self.write_and_approve(cell, env, t, way, &checks) {
            let w = cell.inner.lock().written.take();
            if let Some(w) = w {
                self.undo(env, &w);
            }
            return Err(self.fail_step(cell, "save", "ADD_SAVE_FAILED", &t.label, Some(why)));
        }
        self.be.reload();
        self.check_cancel(cell)?;

        let sign_in = hello.is_some_and(|h| h.new == NewOutcome::AuthNeeded);
        let level = match way {
            ChatWay::Acp { level, .. } => *level,
            ChatWay::Headless | ChatWay::Probed { .. } => Level::L2,
            ChatWay::None | ChatWay::Terminal => Level::L5,
        };
        let record = handshake_record(level, version, hello, models.as_ref(), matches!(way, ChatWay::Terminal));
        // A failure to record must not undo a good add; the result then shows what the store really holds.
        let _ = self.be.record_handshake(&t.id, &record);
        let caps = self.be.caps_of(&t.id);
        self.step_end(cell, "save", StepState::Done, Some(format!("saved as {}", t.id)));
        let mode = if matches!(way, ChatWay::None | ChatWay::Terminal) { "terminal" } else { "chat" };
        Ok(AddResult { agent_id: t.id.clone(), label: t.label.clone(), mode, caps, sign_in_needed: sign_in, already_added: false })
    }
}

// ---- the facts the free check hands to the capability store (contract 1.3) ----------------------------------

/// What the free check learned, as the store keeps it. `terminal_only`: the person chose the terminal, so the chat
/// was never looked at and stays unknown (it is not a "no").
pub fn handshake_record(level: Level, version: Option<String>, hello: Option<&hs::Hello>, models: Option<&(Vec<String>, u32)>, terminal_only: bool) -> HandshakeRecord {
    let mut rec = HandshakeRecord { at: now_rfc3339(), program_version: version, ..HandshakeRecord::default() };
    match hello {
        Some(h) => {
            rec.init_ok = true;
            rec.protocol_version = Some(h.init.protocol_version);
            rec.load_session = h.init.load_session;
            rec.resume = h.init.resume;
            rec.image_prompts = h.init.image_prompts;
            rec.session_new_ok = matches!(h.new, NewOutcome::Answered(_));
            if let Some((list, total)) = models {
                rec.models = list.clone();
                rec.models_total = *total;
            }
        }
        None if terminal_only => rec.terminal_only = true,
        None if level == Level::L5 => rec.no_chat_reason = Some("no chat way found".into()),
        None => {}
    }
    rec
}
