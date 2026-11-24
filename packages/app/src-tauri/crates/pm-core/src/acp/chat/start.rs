//! Starting a chat session: the gate (Labs switch, the agent's choice or an explicit ask), the session, its pane.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use super::{AcpChat, ChatHost, CHATS, LANE};
use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::conversations::Conversations;
use crate::acp::lane::RunLane;
use crate::acp::session::{AcpSession, SessionParams};
use crate::acp::supervisor::{self, SweeperHandle};
use crate::pty::registry::{insert_virtual_pane, VirtualPaneSpec};
use crate::pty::PaneRegistry;
use crate::session_chat::pushed;

/// What starting a chat session needs from the app.
#[derive(Clone)]
pub struct StartDeps {
    pub registry: Arc<Mutex<PaneRegistry>>,
    pub host: Arc<dyn ChatHost>,
    pub env: Arc<dyn HostEnv>,
    /// The saved conversations. With them a chat session is a conversation (the pane's id is the conversation's):
    /// it survives an app restart and can be handed to a terminal and back. Without them it lives as long as the app.
    pub conversations: Option<Conversations>,
}

#[derive(Default)]
pub struct StartRequest {
    /// The agent's id (`"codex"`): it must have an ACP definition (`acp::config`).
    pub agent_id: String,
    /// The folder the agent works in.
    pub folder: PathBuf,
    /// The caller asks for a chat session whatever the agent's saved choice is (the Labs switch still applies).
    pub explicit: bool,
    /// The account (`accounts::Store`) to run the agent's adapter under; `None`: the agent's own login.
    pub account: Option<String>,
    /// The model the caller named. It wins over every default; the caller applies it (strictly) after the start.
    pub model: Option<String>,
    /// An agent started this chat as its helper: the "Default model for helpers" setting counts.
    pub is_helper: bool,
    /// "Work on a copy": the chat works in a separate copy of `folder` (a worktree, or a plain copy without git) and the
    /// project stays untouched until the person keeps the changes (`copy`).
    pub separate_copy: bool,
    /// Where plain copies are kept; `None`: the app's data folder. Tests set it.
    pub copy_store: Option<PathBuf>,
    /// The project the chat belongs to when it works in a copy of it (the rules of Force yes, Fences and Pins are the
    /// project's). `None`: the folder the chat starts in.
    pub project: Option<PathBuf>,
    /// The pane of the agent that asks for this chat as its helper. Its own standby helpers are used before others (the link
    /// is written to the registry only after the chat starts, so it is handed in here).
    pub parent_pane: Option<String>,
    /// A standby helper asked for by name.
    pub helper_name: Option<String>,
    /// What the starting agent made this chat (a spin-off or a minion), known before the adapter starts: the chat carries it from the
    /// first moment, so its tool server (which asks the app what the chat is) lists `message_parent` at once.
    pub early_started: Option<crate::agent_run_mode::StartedRecord>,
    /// The chat's agent runs on this SSH machine, in `folder` ON THAT MACHINE (`ssh::acp`). `None`: on this PC.
    pub remote: Option<crate::ssh::model::SshHost>,
}

/// Why a chat session did not start. `fallback`: the terminal is the way to run this agent instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartError {
    pub code: &'static str,
    pub message: String,
    pub fallback: bool,
}

impl StartError {
    fn new(code: &'static str, message: impl Into<String>, fallback: bool) -> Self {
        StartError { code, message: message.into(), fallback }
    }
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Why the gate said no.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
    /// The Labs switch is off: nothing starts.
    LabsOff,
    /// The agent has no ACP definition.
    NoDefinition,
    /// The agent runs in the terminal (its saved choice) and the caller did not ask for a chat session.
    TerminalChosen,
}

impl From<GateError> for StartError {
    fn from(error: GateError) -> Self {
        match error {
            GateError::LabsOff => StartError::new("ACP_LABS_OFF", "Chat sessions are off. Turn on Chat (ACP) in Labs first.", true),
            GateError::NoDefinition => StartError::new("ACP_NO_DEFINITION", "This agent has no chat (ACP) way to run yet.", true),
            GateError::TerminalChosen => StartError::new("ACP_LANE_NOT_CHOSEN", "This agent runs in the terminal. Choose Chat (ACP) for it, or ask for a chat session explicitly.", true),
        }
    }
}

/// The rule: Labs on, an ACP definition, and the agent's choice is Chat or the caller asks for it.
pub fn check_gate(labs_on: bool, has_definition: bool, chosen: RunLane, explicit: bool) -> Result<(), GateError> {
    if !labs_on {
        return Err(GateError::LabsOff);
    }
    if !has_definition {
        return Err(GateError::NoDefinition);
    }
    if chosen != RunLane::Acp && !explicit {
        return Err(GateError::TerminalChosen);
    }
    Ok(())
}

/// Starts a chat session for a built-in agent, behind the gate. Returns the pane id.
pub fn start_gated(deps: &StartDeps, request: StartRequest) -> Result<Arc<AcpChat>, StartError> {
    start_gated_with(deps, request, &crate::acp::config::find_builtin)
}

/// `start_gated` with the agent table given: a machine (or a test) that has its own agents says which config an id names.
pub fn start_gated_with(deps: &StartDeps, request: StartRequest, find: &dyn Fn(&str) -> Option<AgentConfig>) -> Result<Arc<AcpChat>, StartError> {
    let cfg = find(&request.agent_id);
    let chosen = crate::acp::lane::LaneStore::in_app_data().lane_for(&request.agent_id);
    check_gate(crate::acp::chat_enabled(), cfg.is_some(), chosen, request.explicit)?;
    let Some(cfg) = cfg else { return Err(GateError::NoDefinition.into()) };
    start(deps, cfg, request)
}

/// The environment of `account` for `agent`, or the error that names what is wrong (`ACCOUNT_NOT_FOUND`,
/// `ACCOUNT_UNSUPPORTED`). A refusal here never offers the terminal: the account is the caller's mistake.
fn account_launch_env(agent: &str, account: &str) -> Result<crate::tui::LaunchEnv, StartError> {
    crate::acp::account::launch_env(&crate::accounts::Store::default_location(), agent, account).map_err(|p| StartError::new(p.code, p.message, false))
}

static SWEEPER: OnceLock<SweeperHandle> = OnceLock::new();

/// How long a start waits for a warm session that is still starting (it is part of the way; waiting beats starting another).
const WARM_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Starts a chat session with `cfg` (no gate). The adapter is started and the session opened before the pane exists,
/// so a failure leaves nothing behind and the caller can run the agent in a terminal instead (`fallback`).
pub fn start(deps: &StartDeps, cfg: AgentConfig, mut request: StartRequest) -> Result<Arc<AcpChat>, StartError> {
    if request.remote.is_some() {
        return start_remote(deps, cfg, request);
    }
    if !request.separate_copy {
        return start_in(deps, cfg, request);
    }
    // The copy first: the chat starts in it. A start that fails leaves no copy behind.
    let store = request.copy_store.clone().unwrap_or_else(crate::app_paths::app_data_dir);
    let project = request.folder.clone();
    if !project.is_absolute() || !project.is_dir() {
        return Err(StartError::new("INVALID_ARGUMENT", "The folder must be an existing folder (a full path).", false));
    }
    let made = crate::hooks::get().chat_copy_make(&project, &store)?;
    request.folder = made.folder.clone();
    request.project = Some(project.clone());
    request.separate_copy = false;
    match start_in(deps, cfg, request) {
        Ok(chat) => {
            if let Some(conversations) = &deps.conversations {
                conversations.set_copy(chat.pane_id(), Some(made.link));
            }
            Ok(chat)
        }
        Err(error) => {
            crate::hooks::get().chat_copy_release_if_pristine(&made.link);
            Err(error)
        }
    }
}

/// A chat whose agent runs on an SSH machine. Everything that would read or write the folder on this PC, or hand this PC's
/// logins and tool servers to the adapter, is left out on purpose: no folder check here, no copy, no account, no warm
/// session or standby, no saved conversation (a remote chat lives as long as the app), no adapter keys or env, no own
/// tool server, no picture folder, no model default from this PC's settings, no project rules read from this PC.
fn start_remote(deps: &StartDeps, cfg: AgentConfig, request: StartRequest) -> Result<Arc<AcpChat>, StartError> {
    let Some(ssh) = request.remote.clone() else { return Err(StartError::new("INVALID_ARGUMENT", "No computer was named.", false)) };
    let folder_text = request.folder.to_string_lossy().into_owned();
    // A full path only: the adapter's `session/new` needs an absolute folder, and `~` would reach it unexpanded.
    if !ssh.is_valid() || !crate::ssh::model::valid_folder(&folder_text) || !folder_text.starts_with('/') {
        return Err(StartError::new("INVALID_ARGUMENT", "Type the full folder path on that computer, starting with /.", false));
    }
    if request.separate_copy {
        return Err(StartError::new("INVALID_ARGUMENT", "A separate copy is not available on another computer yet.", false));
    }
    if request.account.as_deref().is_some_and(|a| !a.trim().is_empty()) {
        return Err(StartError::new("INVALID_ARGUMENT", "A chat on another computer uses that computer's own sign-in, not an account of this PC.", false));
    }
    let cfg = crate::acp::config::for_remote(&cfg).map_err(|e| match e {
        crate::acp::error::AcpError::Spawn(why) => StartError::new("ACP_REMOTE_UNSUPPORTED", why, false),
        other => StartError::new("ACP_REMOTE_UNSUPPORTED", other.to_string(), false),
    })?;
    // A remote chat is not saved as a conversation: the one-chat-one-folder machinery of this PC does not apply.
    let deps = StartDeps { conversations: None, ..deps.clone() };
    let label = cfg.label.clone();
    let agent_id = cfg.id.clone();
    let pane_id = uuid::Uuid::new_v4().to_string();
    // On this PC the chat's folder is a marker that is no path (`ssh::acp::pane_folder`): nothing can be written at it.
    let marker = crate::ssh::pane_marker::pane_folder(&ssh.id, &folder_text);
    let marker_path = PathBuf::from(&marker);
    let session = AcpSession::new_remote(Arc::new(cfg), deps.env.clone(), SessionParams { key: pane_id.clone(), cwd: PathBuf::from(&marker), resume_session_id: None }, ssh.clone(), folder_text.clone());
    supervisor::global().insert(session.clone());
    super::note_remote_started(&pane_id);
    let chat = build_registered_chat(&deps, &pane_id, &label, &session, &marker_path, None, false);
    ensure_sweeper();
    if let Err(error) = session.ensure_running() {
        let message = session.last_exit_reason().unwrap_or_else(|| start_failure_sentence(&label, &error));
        chat.retire();
        return Err(StartError::new("ACP_START_FAILED", message, false));
    }
    show_pane(&deps, &chat, &session, agent_id, &marker_path, None);
    deps.host.panes_changed();
    deps.host.state_changed(&pane_id, &chat.state());
    Ok(chat)
}

/// The model a standby helper is matched on: only one the caller named. A task that names none takes a standby of its agent type
/// whatever model the standby has (the person made it for that model on purpose); "Default model for helpers" is a default for
/// a helper nobody gave a standby for, never a reason to skip one.
fn match_model(request: &StartRequest) -> Option<String> {
    request.model.clone()
}

fn start_in(deps: &StartDeps, cfg: AgentConfig, request: StartRequest) -> Result<Arc<AcpChat>, StartError> {
    // Timing only: the stages are logged (`startup_stage`). Until the pane exists they sit under a temporary key, then move
    // to the pane's id (`startup_timing::carry`). The key holds no folder: logs stay free of paths.
    let timing_key = format!("chat-start-{}-{}", cfg.id, uuid::Uuid::new_v4());
    crate::startup_timing::begin(&timing_key);
    crate::startup_timing::mark(&timing_key, "chat_start_begin");
    let folder = request.folder.clone();
    if !Path::new(&folder).is_absolute() || !folder.is_dir() {
        return Err(StartError::new("INVALID_ARGUMENT", "The folder must be an existing folder (a full path).", false));
    }
    // The account, checked before anything starts: the adapter gets that login's environment.
    let account_env = match request.account.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        Some(account) => Some((account.to_string(), account_launch_env(&cfg.id, account)?)),
        None => None,
    };
    // A session started ahead of time for this agent, folder and account (`acp::warm`): the same chat, minus the adapter's
    // startup. The checks below ran when it was warmed; nothing about the chat differs.
    let account_id = account_env.as_ref().map(|(id, _)| id.clone());
    // A standby seat the person made that fits this start comes first (agent, folder, account, and a model that agrees). An
    // agent's own seat that is still starting is waited for: the seat takes the task, nothing else is started for it.
    let seat_wait = if request.parent_pane.is_some() { WARM_WAIT } else { std::time::Duration::ZERO };
    let helper = deps.conversations.as_ref().and_then(|_| crate::acp::warm::claim_helper_for(
            &cfg,
            &crate::acp::warm::HelperClaim { agent: &cfg.id, folder: &folder, account: account_id.as_deref(), model: match_model(&request).as_deref(), caller: request.parent_pane.as_deref(), name: request.helper_name.as_deref(), kind: request.early_started.as_ref().and_then(|s| s.standby_kind_wanted(request.helper_name.is_some())) },
            seat_wait,
        ));
    // The seat's chat exists already (the person has the seat open): the task runs in that chat. Nothing is built.
    if let Some(claimed) = &helper {
        if let Some(chat) = claimed.pane.as_deref().and_then(super::get) {
            // A new start on a pane that has had starts before: its clock begins now, not at the first one.
            crate::startup_timing::begin(chat.pane_id());
            crate::startup_timing::mark(chat.pane_id(), "chat_seat_task_begin");
            crate::standby::seat_panes::note(chat.pane_id(), &claimed.meta.id);
            crate::acp::warm::set_helper_task_pane(&claimed.meta.id, chat.pane_id());
            chat.set_seat(Some(&claimed.meta.id));
            deps.host.panes_changed();
            return Ok(chat);
        }
    }
    let (warm, helper_meta) = match helper {
        Some(claimed) => (claimed.item, Some(claimed.meta)),
        None => (deps.conversations.as_ref().and_then(|_| crate::acp::warm::claim_waiting(&cfg, &folder, account_id.as_deref(), WARM_WAIT)), None),
    };
    // Where the task's chat is, told to the pool once it exists. A start that fails leaves it empty and the helper is given back.
    let mut task_pane = TaskPane { helper: helper_meta.as_ref().map(|meta| meta.id.clone()), pane: None };
    crate::startup_timing::mark(&timing_key, if warm.is_some() { "chat_warm_hit" } else { "chat_warm_miss" });
    if warm.is_none() {
        // A reviewed adapter whose last health check failed (or that fails now, when its agent's version is not the tested
        // one): the chat says why and stops. The terminal lane is not touched.
        if let Some(reason) = crate::acp::adapter_health::check_before_start(&cfg.id) {
            return Err(StartError::new("ACP_ADAPTER_BLOCKED", reason, true));
        }
        // The add-on (the adapter) is not installed: say so, so the screen can offer to install it (A5).
        if crate::acp::install::is_missing(&cfg, &*deps.env) {
            let size = cfg.addon.size_mb.map(|mb| format!(" (about {mb} MB)")).unwrap_or_default();
            return Err(StartError::new("ACP_ADDON_MISSING", format!("Chat needs a small add-on for {}{size}. Install it first.", cfg.label), true));
        }
    }
    let label = cfg.label.clone();
    let agent_id = cfg.id.clone();
    let agent_id_for_memory = agent_id.clone();
    let warm_claimed = warm.is_some();
    let (session, pane_id) = match &deps.conversations {
        Some(conversations) if warm.is_some() => {
            let warm = warm.expect("checked above");
            let view = conversations
                .adopt_warm(&warm.id, &agent_id, &folder, account_id.as_deref(), warm.session.clone())
                .map_err(|e| StartError::new("ACP_START_FAILED", format!("The agent could not start: {e}"), true))?;
            (warm.session, view.id)
        }
        Some(conversations) => {
            let view = conversations.create_for(&agent_id, &folder, account_env.as_ref().map(|(id, _)| id.as_str())).map_err(|e| StartError::new("ACP_START_FAILED", format!("The agent could not start: {e}"), true))?;
            let session = conversations.session(&view.id).ok_or_else(|| StartError::new("ACP_START_FAILED", "The agent could not start.", true))?;
            (session, view.id)
        }
        None => {
            let pane_id = uuid::Uuid::new_v4().to_string();
            let mut cfg = cfg;
            crate::acp::config::add_pane_id(&mut cfg, &pane_id);
            if let Some((account, env)) = &account_env {
                crate::acp::config::with_account_env(&mut cfg, env);
                crate::acp::account::apply_lend_extras(&mut cfg, account);
            }
            let session = AcpSession::new(Arc::new(cfg), deps.env.clone(), SessionParams { key: pane_id.clone(), cwd: folder.clone(), resume_session_id: None });
            supervisor::global().insert(session.clone());
            (session, pane_id)
        }
    };
    crate::startup_timing::carry(&timing_key, &pane_id);
    // A seat's chat is the seat's from before it is listed: no screen ever shows it as a new agent.
    if let Some(meta) = &helper_meta {
        crate::standby::seat_panes::note(&pane_id, &meta.id);
    }
    let chat = build_registered_chat(deps, &pane_id, &label, &session, &folder, request.project.as_deref(), warm_claimed);
    chat.set_seat(helper_meta.as_ref().map(|meta| meta.id.as_str()));
    if let Some(started) = request.early_started.clone() {
        chat.set_started(started);
        if let Some(parent) = request.parent_pane.as_deref() {
            chat.set_nested_under(Some(parent));
        }
    }
    ensure_sweeper();

    if let Err(error) = session.ensure_running() {
        chat.retire();
        if let Some(conversations) = &deps.conversations {
            conversations.discard(&pane_id);
        }
        let needs_sign_in = matches!(error, crate::acp::error::AcpError::AuthRequired { .. });
        let message = if needs_sign_in { "The agent needs you to sign in first.".to_string() } else { start_failure_sentence(&label, &error) };
        return Err(StartError::new(if needs_sign_in { "ACP_SIGN_IN_NEEDED" } else { "ACP_START_FAILED" }, message, true));
    }
    crate::startup_timing::mark(&pane_id, "chat_session_ready");

    // The starting model: request, helper default, app setting, last pick, the agent's own default (`default_model::choose`).
    // A standby helper's own model counts as asked for, when the task named none.
    let standby_model = if request.model.is_none() { helper_meta.as_ref().and_then(|meta| meta.model.clone()) } else { None };
    let model = request.model.clone().or_else(|| standby_model.clone());
    match &standby_model {
        // The standby was made for this model: the claimed session is put on it (never left on the agent's own default), or the
        // chat says why it is not.
        Some(wanted) => super::default_model::apply_standby_model(&chat, wanted),
        None => super::default_model::apply_at_start(&chat, request.model.as_deref(), request.is_helper),
    }
    // The pins of the project (model, mode, Force yes) and the agent's own Force yes switch (`rules.rs`).
    super::rules::apply_at_start(&chat, model.is_some());
    crate::startup_timing::mark(&pane_id, "chat_settings_applied");

    let grant = account_env.as_ref().and_then(|(id, _)| id.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX));
    show_pane(deps, &chat, &session, agent_id, &folder, grant);
    crate::startup_timing::mark(&pane_id, "chat_pane_shown");
    deps.host.panes_changed();
    deps.host.state_changed(&pane_id, &chat.state());
    // Low memory never blocks a chat the person starts: one plain line says so.
    if let Some(line) = crate::acp::memory::chat_warning(&crate::acp::memory::SystemReader, &agent_id_for_memory) {
        chat.side_line("low-memory", &line);
    }
    task_pane.pane = Some(pane_id);
    Ok(chat)
}

/// Tells the pool where a claimed standby's task runs when `start_in` is done (or that it did not start: an empty pane).
struct TaskPane {
    helper: Option<String>,
    pane: Option<String>,
}

impl Drop for TaskPane {
    fn drop(&mut self) {
        if let Some(helper) = &self.helper {
            crate::acp::warm::set_helper_task_pane(helper, self.pane.as_deref().unwrap_or(""));
        }
    }
}

/// Starts the sweeper that watches the sessions (once).
pub fn ensure_sweeper() {
    SWEEPER.get_or_init(|| supervisor::global().start_thread());
}

/// The chat around `session`, registered under `pane_id` (the chats table and the pushed views). `warm_claimed`: the session was
/// started ahead of time (a standby or a warm session): the chat has seen what it said while it waited.
pub fn build_registered_chat(deps: &StartDeps, pane_id: &str, label: &str, session: &Arc<AcpSession>, folder: &Path, project: Option<&Path>, warm_claimed: bool) -> Arc<AcpChat> {
    let chat = AcpChat::build(pane_id, label, session.clone(), deps.host.clone(), deps.conversations.clone());
    // A folder of another computer is never a place on this PC's disk: no picture folder is made from it.
    if session.remote_host().is_none() {
        chat.set_image_folder(folder);
    }
    chat.attach();
    chat.set_project_hint(project);
    if warm_claimed {
        chat.set_warm_claimed(true);
        // The chat has seen what the session said while it waited (it was kept for this sink); from now on events come live.
        session.stop_buffering();
    }
    if !cfg!(any(test, feature = "test-util")) && session.remote_host().is_none() {
        // Test agents are fakes with no tool server by design. A chat on another computer has none (it is not handed one).
        chat.note_workspace_tools();
    }
    CHATS.lock().insert(pane_id.to_string(), chat.clone());
    pushed::register(pane_id, chat.clone());
    crate::startup_timing::mark(pane_id, "chat_pane_registered");
    chat
}

/// The chat's pane in the pane list (so the screens, the bridge and the phone see it). `grant`: a borrowed sign-in
/// (`lend:<grant>`) the chat runs on, listed on its grant so the chip and the usage find it.
pub fn show_pane(deps: &StartDeps, chat: &Arc<AcpChat>, session: &Arc<AcpSession>, agent_id: String, folder: &Path, grant: Option<&str>) {
    let pane_id = chat.pane_id().to_string();
    let on_close = {
        let pane_id = pane_id.clone();
        Arc::new(move || super::on_pane_closed(&pane_id)) as Arc<dyn Fn() + Send + Sync>
    };
    let handles = insert_virtual_pane(
        &deps.registry,
        VirtualPaneSpec {
            pane_id: pane_id.clone(),
            agent_type: agent_id,
            cwd: folder.to_string_lossy().into_owned(),
            lane: LANE.to_string(),
            pid: session.connection().map(|conn| conn.pid()).unwrap_or(0),
        },
        on_close,
    );
    chat.set_handles(handles);
    if let Some(grant) = grant {
        crate::hooks::get().capacity_note_pane(grant, &pane_id);
    }
}

/// What the person reads when the chat program of `label` would not start: one cause, one thing to do. No path and no
/// raw system text (a path can carry a user name), and the terminal is always named as the way out.
pub fn start_failure_sentence(label: &str, error: &crate::acp::error::AcpError) -> String {
    use crate::acp::error::AcpError;
    match error {
        // A key the chat add-on needs is not saved (the message names variables only): say that, not "not found".
        AcpError::Spawn(why) if why.contains("is not saved: add the key") => format!("{label} needs an API key before it can chat. Save one for the chat add-on, or run the agent in a terminal."),
        AcpError::Spawn(_) => format!("The chat program for {label} was not found or would not run. Check that it is installed, or run the agent in a terminal."),
        AcpError::Pin(_) => format!("The chat add-on for {label} is not the version this app was tested with. Install it again in Settings, under Agents, or run the agent in a terminal."),
        AcpError::Timeout { .. } => format!("{label} did not answer in time. It may still be starting or may need a sign-in. Try again, or run the agent in a terminal."),
        AcpError::Closed => format!("The chat program for {label} closed right away. Run the agent in a terminal once to see why (it may need a sign-in or an update)."),
        // The agent's own service answered "internal error" (JSON-RPC -32603). It is the agent's server failing (it often does when its
        // model service is slow to boot or the machine is busy), not this app: say so, and what helps.
        AcpError::Rpc { code: -32603, message, .. } => format!("{label}'s own model service failed ({}). This comes from {label}, not from Potato Workspace. Wait a moment and try again; if it keeps happening, open {label} once on its own to see its error.", message.trim().trim_end_matches('.')),
        other => format!("The agent could not start: {other}"),
    }
}

/// After an app start: a chat pane for every conversation that came back (`Conversations::restore_lazily`). The pane
/// is listed at once; nothing starts until a viewer reads it (`AcpChat::wake_for_reader`) or a message is sent. A
/// conversation that is open in a terminal pane (the terminal survived) shows that. Returns the pane ids.
pub fn restore_panes(deps: &StartDeps) -> Vec<String> {
    let Some(conversations) = &deps.conversations else { return Vec::new() };
    // Copies of closed chats that changed nothing are removed (the person may have closed the app mid-clean-up).
    if !cfg!(any(test, feature = "test-util")) {
        let conversations = conversations.clone();
        std::thread::spawn(move || {
            crate::hooks::get().chat_copy_sweep_closed(&conversations);
        });
    }
    let mut restored = Vec::new();
    let mut links: Vec<(String, String)> = Vec::new();
    for id in conversations.open_ids() {
        if CHATS.lock().contains_key(&id) {
            continue;
        }
        let (Some(session), Some(record)) = (conversations.session(&id), conversations.record(&id)) else { continue };
        let Ok(cfg) = conversations.config_for(&record.agent) else { continue };
        let chat = AcpChat::build(&id, &cfg.label, session, deps.host.clone(), Some(conversations.clone()));
        chat.set_image_folder(std::path::Path::new(&record.cwd));
        chat.attach();
        if !cfg!(any(test, feature = "test-util")) {
            // Test agents are fakes with no tool server by design.
            chat.note_workspace_tools();
        }
        CHATS.lock().insert(id.clone(), chat.clone());
        pushed::register(&id, chat.clone());
        SWEEPER.get_or_init(|| supervisor::global().start_thread());
        let on_close = {
            let id = id.clone();
            Arc::new(move || super::on_pane_closed(&id)) as Arc<dyn Fn() + Send + Sync>
        };
        let handles = insert_virtual_pane(
            &deps.registry,
            VirtualPaneSpec {
                pane_id: id.clone(),
                agent_type: record.agent.clone(),
                cwd: record.cwd.clone(),
                lane: LANE.to_string(),
                pid: chat.session().connection().map(|conn| conn.pid()).unwrap_or(0),
            },
            on_close,
        );
        chat.set_handles(handles);
        chat.init_rules();
        chat.set_started_by(record.started_by.as_deref());
        chat.restore_started(record.started_as.as_deref(), record.as_reason.as_deref());
        if let Some(kind) = record.started_as.as_deref() {
            crate::pty::pane_parent::set_started_as(&deps.registry, &id, kind);
        }
        if let Some(note) = record.lane_note.clone() {
            *chat.lane_note.lock() = Some(note);
        }
        if let Some(parent) = record.parent_pane_id.clone() {
            links.push((id.clone(), parent));
        }
        restored.push(id);
    }
    // The helper-of link goes back once every restored pane is listed (a parent may be a chat restored in this
    // loop). Only a parent that is live now counts: a terminal that did not survive is not a parent.
    for (child, parent) in links {
        let live = crate::pty::pane_parent::claimed_pane(&deps.registry, &parent).is_some_and(|pane| !pane.exited);
        if live {
            crate::pty::pane_parent::set_parent(&deps.registry, &child, &parent);
            if let Some(chat) = crate::acp::chat::get(&child) {
                chat.set_nested_under(Some(&parent));
            }
        }
    }
    if !restored.is_empty() {
        deps.host.panes_changed();
    }
    restored
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_needs_labs_a_definition_and_a_choice_or_an_explicit_ask() {
        assert_eq!(check_gate(false, true, RunLane::Acp, true), Err(GateError::LabsOff));
        assert_eq!(check_gate(true, false, RunLane::Acp, true), Err(GateError::NoDefinition));
        assert_eq!(check_gate(true, true, RunLane::Terminal, false), Err(GateError::TerminalChosen));
        assert_eq!(check_gate(true, true, RunLane::Acp, false), Ok(()));
        assert_eq!(check_gate(true, true, RunLane::Terminal, true), Ok(()));
    }

    #[test]
    fn a_failed_start_says_one_cause_and_one_thing_to_do_without_a_path() {
        use crate::acp::error::AcpError;
        let spawn = start_failure_sentence("Kilo", &AcpError::Spawn("C:/Users/someone/kilo.exe: program not found (os error 2)".into()));
        assert_eq!(spawn, "The chat program for Kilo was not found or would not run. Check that it is installed, or run the agent in a terminal.");
        assert!(!spawn.contains("someone") && !spawn.contains("os error"));
        let key = start_failure_sentence("Aider", &AcpError::Spawn("A_KEY or B_KEY is needed by this chat and is not saved: add the key for this adapter".into()));
        assert!(key.contains("needs an API key") && !key.contains("not found"), "{key}");
        assert!(start_failure_sentence("Kilo", &AcpError::Pin("hash".into())).contains("Install it again in Settings"));
        assert!(start_failure_sentence("Kilo", &AcpError::Timeout { method: "session/new".into(), secs: 30 }).contains("did not answer in time"));
        assert!(start_failure_sentence("Kilo", &AcpError::Closed).contains("closed right away"));
        assert!(start_failure_sentence("Kilo", &AcpError::QueueFull).starts_with("The agent could not start"));
        let internal = start_failure_sentence("OpenCode", &AcpError::Rpc { code: -32603, message: "Internal error: Internal service failure".into(), data: None });
        assert!(internal.starts_with("OpenCode's own model service failed (Internal error: Internal service failure)"), "{internal}");
        assert!(!internal.contains("-32603") && !internal.contains("terminal"));
    }

    #[test]
    fn every_refusal_offers_the_terminal_instead() {
        for error in [GateError::LabsOff, GateError::NoDefinition, GateError::TerminalChosen] {
            let start: StartError = error.into();
            assert!(start.fallback, "{start}");
        }
    }
}

#[cfg(test)]
mod remote_pane_tests {
    use crate::acp::chat::{is_remote_pane, NOT_ON_THIS_PC};

    /// A chat on another computer has no folder on this PC: the file commands get a path that cannot name one.
    #[test]
    fn the_folder_of_a_remote_pane_cannot_be_read_on_this_pc() {
        assert!(crate::files::list_dir(NOT_ON_THIS_PC, "", false).is_err());
        assert!(crate::files::read_file(NOT_ON_THIS_PC, "a.txt").is_err());
        assert!(NOT_ON_THIS_PC.contains('\0'));
        assert!(!is_remote_pane("no-such-pane"));
    }
}
