//! Questions the moved engine asks the app it came from. The engine code lives in `pm-core`; a few things it needs (which MCP
//! servers a chat gets, whether a pane is ready) stay in the app crate. The app sets one `EngineHooks` at start; a host with no
//! app (`potato-host`) keeps the defaults, which say "nothing here". A hook is a question, never a second copy of a decision.
//! A default must show on the far screen as disabled-with-reason, never as silent success. Each stage adds its methods here.

use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::conn::SpawnSpec;
use crate::acp::error::AcpError;
use crate::acp::chat::StartError;
use crate::acp::conversations::Conversations;
use crate::acp::journal::Page;
use crate::acp::record::CopyLink;
use crate::agent_run_mode::started_as::StartedAgentTypes;
use crate::opencode::OpenCodeModelRef;
use crate::capacity_proxy::BorrowedChat;
use crate::pty::registry::{PaneRegistry, SpawnPaneArgs};
use crate::questions::Question;
use crate::standby::config::StandbyConfig;
use crate::ssh::model::SshHost;
use crate::tui::pane_mcp::PaneMcpLaunch;
use crate::tui::{LaunchEnv, TuiProfile, VersionCommand};

/// What `prepare_spawn` adds to a pane's launch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookLaunch {
    pub env: Vec<(String, String)>,
    pub extra_args: Vec<String>,
}

/// The env var a pane's agent gets its pane key in (same text as the app's `mcp_sessions::PANE_KEY_ENV`, which a test pins).
pub const PANE_KEY_ENV: &str = "POTATO_WORKSPACE_PANE_KEY";

/// Questions the terminal engine asks the app. Every method has a "nothing here" default.
pub trait EngineHooks: Send + Sync {
    /// Agent hooks installed for a pane: remove them (pane closed).
    fn agent_hooks_revoke(&self, _pane_id: &str) {}
    /// Mint the pane's token and install the agent's hooks for this spawn; nothing to add by default.
    fn agent_hooks_prepare(&self, _agent: &str, _pane_id: &str, _cwd: &str, _user_args: &[String]) -> HookLaunch {
        HookLaunch::default()
    }
    /// A key that lets this pane's agent call the app's MCP bridge. `None`: no bridge here, the agent gets no key.
    fn pane_key_mint(&self, _pane_id: &str) -> Option<String> {
        None
    }
    fn pane_key_revoke(&self, _pane_id: &str) {}
    /// Force yes: forget a closed pane's switch / could it be on for this pane (a cheap look).
    fn force_yes_forget(&self, _pane_id: &str) {}
    fn force_yes_maybe_enabled(&self, _pane_id: &str, _agent: &str) -> bool {
        false
    }
    /// Terminals an agent started (the `agent_terminals` tool): stop the ones a pane owns / all of them.
    fn agent_terminals_stop_owned_by(&self, _owner: &str) {}
    fn agent_terminals_stop_all(&self) {}
    /// A pane left the registry: windows refresh their lists.
    fn pane_removed(&self) {}
    /// A pane's size changed (the viewer's, or by lease): tell the bridge's listeners.
    fn pane_resized(&self, _pane_id: &str, _cols: u16, _rows: u16) {}
    fn pty_resized_by_lease(&self, _pane_id: &str, _cols: u16, _rows: u16) {}
    fn panes_changed(&self) {}
    /// A pane's own title (set by the person or derived from what they typed).
    fn pane_title(&self, _pane_id: &str) -> Option<String> {
        None
    }
    /// Note what was typed so a title can be derived; true when the title changed.
    fn pane_title_observe_input(&self, _pane_id: &str, _agent: &str, _screen_line: &str, _text: &str, _append_newline: bool) -> bool {
        false
    }
    fn pane_title_changed(&self, _pane_id: &str) {}
    /// The standby seat this pane holds, if it is a warm helper.
    fn standby_seat(&self, _pane_id: &str) -> Option<String> {
        None
    }
    /// The MCP client name a session announced.
    fn mcp_session_client_name(&self, _session_id: &str) -> Option<String> {
        None
    }
    /// Before an agent runs: the canary checks for that agent type.
    fn canary_before_run(&self, _agent: &str) {}
    /// The shared project notes ("one brain") are synced into a folder before an agent starts in it.
    fn one_brain_sync_on_spawn(&self, _cwd: &str) {}
    /// A pane's process ended: a chat that was handed to it takes the conversation back.
    fn pane_ended(&self, _pane_id: &str) {}
    /// The app's build id (the wizard stamps what it writes with it).
    fn build_id(&self) -> String {
        "host".to_string()
    }
    /// The login a pane runs under (an account the person chose): its env and its label. No accounts here: refused.
    fn pane_account_launch(&self, _agent_type: &str, _account: &str) -> Result<(LaunchEnv, String), String> {
        Err("Accounts are not set up on this computer yet.".to_string())
    }
    /// The tool server a pane's agent is given (the MCP bridge). Nothing by default.
    fn pane_mcp_prepare(&self, _profile: &dyn TuiProfile, _pane_id: &str, _user_args: &[String], _pane_key: Option<&str>) -> PaneMcpLaunch {
        PaneMcpLaunch::default()
    }
    /// Dev builds with a fake agent: hold the output chunk a test asked to hold.
    fn fake_tui_hold_output_chunk(&self, _bytes: &[u8]) {}
    /// A pane runs under a borrowed account (`lend:<grant>`).
    fn capacity_note_pane(&self, _grant: &str, _pane_id: &str) {}
    /// Watches one pane's prompts (cards, Force yes). `None`: no prompt cards on this machine.
    fn prompt_watch(&self, _pane_id: &str, _agent_type: &str, _registry: &Arc<Mutex<PaneRegistry>>) -> Option<Box<dyn PromptWatch>> {
        None
    }
    /// OpenCode's own screen (serve + attach): start it / type into it. Not on a machine without the app.
    fn opencode_spawn_native(&self, _registry: &Arc<Mutex<PaneRegistry>>, _args: SpawnPaneArgs) -> Result<String, String> {
        Err("OpenCode's own screen is not available on this computer yet.".to_string())
    }
    fn opencode_write_native_input(&self, _registry: &Arc<Mutex<PaneRegistry>>, _pane_id: &str, _text: &str, _model: Option<&OpenCodeModelRef>) -> Result<(), String> {
        Err("OpenCode's own screen is not available on this computer yet.".to_string())
    }
    /// Settings > Agents: one helper type or two; whether helpers close with their agent.
    fn started_agent_types(&self) -> StartedAgentTypes {
        StartedAgentTypes::One
    }
    fn close_helpers_with_agent(&self) -> bool {
        true
    }
    /// The ACP chat lane: a pane that is a chat on another computer / the app is ending / a chat's process id / its earlier page.
    fn chat_is_remote_pane(&self, _pane_id: &str) -> bool {
        false
    }
    fn chat_app_is_shutting_down(&self) -> bool {
        false
    }
    fn chat_pid(&self, _pane_id: &str) -> Option<u32> {
        None
    }
    fn chat_earlier(&self, _pane_id: &str, _before: &str, _limit: usize) -> Page {
        Page::default()
    }
    /// An isolated run's worktree: is this folder one, and release it when its pane is gone.
    fn worktree_is_isolated(&self, _cwd: &str) -> bool {
        false
    }
    fn worktree_release_closed_pane(&self, _pane_id: &str, _cwd: &str) {}
    /// Agent run gates: the canary's startup gate and its signals.
    fn canary_note_not_ready(&self, _agent: &str) {}
    fn canary_note_ambiguous_idle(&self, _agent: &str) {}
    /// A chat session has no terminal: input typed at its pane (a line is a message, Ctrl+C / Esc stop the turn).
    /// `None`: this pane is not a chat session.
    fn chat_terminal_input(&self, _pane_id: &str, _text: &str, _append_newline: bool) -> Option<Result<(), String>> {
        None
    }
    /// A chat's launch (stage 5): what only the app can answer. Every default says "nothing here".
    /// An account's helper standbys go cold when the account changes.
    fn standby_account_changed(&self, _agent: &str) {}
    /// The borrowed sign-in `lend:<grant>`: its env for a terminal, what a chat is started with, its label, the picker rows, a profile's name.
    fn lend_launch_env(&self, _agent: &str, _grant: &str) -> Result<LaunchEnv, String> {
        Err("Sharing an agent is not available on this computer.".to_string())
    }
    fn lend_chat(&self, _agent: &str, _grant: &str) -> Result<BorrowedChat, String> {
        Err("Sharing an agent is not available on this computer.".to_string())
    }
    fn lend_label(&self, _grant: &str) -> Option<String> {
        None
    }
    fn lend_rows(&self) -> Vec<serde_json::Value> {
        Vec::new()
    }
    fn lend_profile_name(&self, _account_id: &str) -> Option<String> {
        None
    }
    /// The version of an agent as the canary last read it; a label. `None`: not read.
    fn canary_version_of(&self, _agent: &str) -> Option<String> {
        None
    }
    /// What a CLI's `--version` printed (one short run). `None`: it did not answer.
    fn cli_version_line(&self, _command: &VersionCommand) -> Option<String> {
        None
    }
    /// The program and arguments of the app's own tool bridge as a chat adapter. Not on a machine without the app.
    fn bridge_chat_table(&self, _agent: &str) -> Result<(String, Vec<String>), String> {
        Err("The tool bridge is not available on this computer.".to_string())
    }
    /// Whether this machine has the app's bundled tool server, and the list of tool servers every chat gets with no setup. Host v1: none.
    fn mcp_bundled_available(&self) -> bool {
        false
    }
    fn mcp_chat_default_servers(&self) -> Vec<serde_json::Value> {
        Vec::new()
    }
    /// A chat's history will be sent again from the replay (the chat starts its record over).
    fn chat_history_will_be_replayed(&self, _conversation: &str) {}
    /// The one plain sentence for a chat that did not start.
    fn chat_start_failure_sentence(&self, label: &str, error: &AcpError) -> String {
        format!("{label} did not start: {error}")
    }
    /// A chat over SSH: the program that starts it, and the sentence for a failed start. Not on a machine without the app.
    fn ssh_chat_spawn(&self, _cfg: &AgentConfig, _host: &dyn HostEnv, _ssh: &SshHost, _folder: &str) -> Result<SpawnSpec, AcpError> {
        Err(AcpError::Spawn("Chats over SSH start from the app on your own computer.".to_string()))
    }
    fn ssh_chat_failure_sentence(&self, _host_name: &str, _program: &str, _stderr_tail: &[String]) -> Option<String> {
        None
    }
    /// The capability table: does this agent have a read-only run table / did the Store add it.
    fn read_only_run_table(&self, _agent: &str) -> bool {
        false
    }
    fn store_added_agent(&self, _agent: &str) -> bool {
        false
    }

    // ----- The chat surface (stage 6) -----
    /// The warm pool's own settings (`None`: no pool on this machine) and the folder it warms in (default: the registry's project).
    fn standby_config(&self) -> Option<StandbyConfig> {
        None
    }
    fn standby_default_project(&self, registry: &Mutex<PaneRegistry>) -> String {
        crate::pty::registry_get_project_path(registry)
    }
    /// The highest "used" percent of the plan windows of this agent's sign-ins, from the last usage reading (`None`: nothing known).
    fn usage_plan_percent(&self, _agent_id: &str) -> Option<f64> {
        None
    }
    /// A card was answered / dismissed by a person or a PC: the app's own cards (consent, budget, handoff, issue, CI) go on from here.
    fn question_answered(&self, _question: &Question) {}
    fn question_dismissed(&self, _question: &Question) {}
    /// Whether `id` is a CI fix id a card may carry (CI cards are the app's).
    fn question_fix_id_valid(&self, _id: &str) -> bool {
        false
    }
    /// A card was raised: the phone gets a push. The question list changed: the attention counts and the SSE listeners refresh.
    fn question_notify(&self, _question: &Question) {}
    fn attention_changed(&self) {}
    fn push_sse(&self, _frame: String) {}
    /// An agent run (`run_agent`) is open on this pane in this folder.
    fn pane_has_open_run(&self, _pane_id: &str, _cwd: &str) -> bool {
        false
    }
    /// A chat that is being moved to another computer: the sentence that refuses a message to it. `None`: not being moved.
    fn chat_move_send_refusal(&self, _pane_id: &str) -> Option<String> {
        None
    }
    /// A task handed over to another agent: a turn of its chat ended / the chat is gone.
    fn handover_turn_ended_soon(&self, _pane_id: &str) {}
    fn handover_forget(&self, _pane_id: &str) {}
    /// "Work on a copy" of a project (worktree or trial copy): make it, release one nobody changed, sweep the ones of closed chats.
    fn chat_copy_make(&self, _project: &std::path::Path, _store: &std::path::Path) -> Result<ChatCopy, StartError> {
        Err(StartError { code: "ACP_COPY_FAILED", message: "Working on a copy is not available on this computer yet.".to_string(), fallback: false })
    }
    fn chat_copy_release_if_pristine(&self, _link: &CopyLink) -> bool {
        false
    }
    fn chat_copy_sweep_closed(&self, _conversations: &Conversations) {}
}

/// A copy a chat works in ("Work on a copy"): the folder the chat starts in and the link to remember.
pub struct ChatCopy {
    pub folder: std::path::PathBuf,
    pub link: CopyLink,
}

/// One pane's prompt watcher (made by `EngineHooks::prompt_watch`, fed from the pane's reader thread).
pub trait PromptWatch: Send {
    /// The screen changed: `waiting` is whether the pane waits for the person, `screen` is the snapshot.
    fn observe(&mut self, waiting: bool, screen: &str);
}

/// The hooks of a process that has none set: every question answers "nothing here".
pub struct NoHooks;
impl EngineHooks for NoHooks {}

static HOOKS: OnceLock<Arc<dyn EngineHooks>> = OnceLock::new();

/// Set the process's hooks. A second call is ignored (the first stays).
pub fn set(hooks: Arc<dyn EngineHooks>) {
    let _ = HOOKS.set(hooks);
}

/// The process's hooks, or the "nothing here" defaults before any are set.
pub fn get() -> Arc<dyn EngineHooks> {
    HOOKS.get().cloned().unwrap_or_else(|| Arc::new(NoHooks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_hooks_default_and_first_set_wins() {
        let _ = get();
        struct One;
        impl EngineHooks for One {}
        set(Arc::new(One));
        set(Arc::new(NoHooks));
        let _ = get();
    }
}
