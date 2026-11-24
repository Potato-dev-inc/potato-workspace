//! Agent spawn configuration, as data.
//!
//! [`AgentConfig`] is also the schema of the `[acp]` table that agent definitions carry, so a new ACP
//! agent is a TOML table and not code. A code-profile agent (Codex, Claude) keeps its table in
//! `tui/<agent>/acp.toml`; a declarative definition carries it as `[acp]` (docs/specs/agent-definitions).
//!
//! ```toml
//! [acp]
//! command = "node"
//! runtime = "python"                  # optional; python adds PYTHONUTF8=1 and PYTHONUNBUFFERED=1 to the env
//! args = ["{adapters}/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js"]
//! env_allow = ["CODEX_HOME"]          # names passed on from the app's environment
//! resume = "prefer_resume"
//! resume_command = ["resume", "{session}"]   # arguments added to the agent's normal terminal launch
//!
//! [acp.env]
//! INITIAL_AGENT_MODE = "read-only"
//!
//! [acp.env_which]                     # NAME -> program found on PATH, e.g. the user's own CLI
//! CODEX_PATH = "codex"
//!
//! [acp.quirks]                        # how this adapter differs from the protocol's happy path
//! cancel_reports_end_turn = true      # a stop that was asked for may still end with `end_turn`
//! serial_prompts = true               # one prompt at a time (the only value this build supports)
//!
//! [acp.mcp_config]                    # keep the person's own tool-server list out of the chat session
//! mode = "disable_listed"             # agent_default | session_meta | private_home | disable_listed
//!
//! [[acp.pins]]                        # versions this build accepts, and the SHA-256 of the file that runs
//! package = "@agentclientprotocol/codex-acp"
//! version = "1.1.4"
//! entry = "{adapters}/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
//! sha256 = "..."
//! ```
//!
//! Nothing outside this file, `tui/<agent>/acp.toml` and the definitions names an agent: the connection,
//! session, supervisor and hand-over code only read these fields.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use super::launch::*;

/// Names passed from the app's own environment to every adapter (a Windows adapter needs these to start
/// at all). Everything else is dropped; an agent that needs more lists it in `env_allow`.
pub const BASE_ENV_ALLOW: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    // macOS/Linux login name. Claude Code uses it to find its Keychain item on macOS; without it the
    // agent reports "Not logged in" even though the person's terminal session is fine.
    "USER",
    "LOGNAME",
    "USERNAME",
    "TEMP",
    "TMP",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
    "COMPUTERNAME",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AgentConfig {
    /// The agent id used everywhere else in the app (`"codex"`). Not part of the `[acp]` table: the id and
    /// the label come from the definition's `[agent]` (see [`from_toml_text`]).
    pub id: String,
    pub label: String,
    /// Present in the build but switched off: it is listed (with `disabled_note`) and never started.
    pub disabled: bool,
    /// Why it is off, in a plain sentence the settings screen can show.
    pub disabled_note: String,
    /// The program to start, found on PATH or absolute.
    pub command: String,
    /// Arguments. `{adapters}` is the folder the adapters are installed in.
    pub args: Vec<String>,
    /// The program and arguments that start this agent's chat adapter on ANOTHER computer over SSH (`["claude-agent-acp"]`,
    /// `["opencode", "acp"]`). The first word is a bare program name the far login shell finds on its PATH; the adapter
    /// is NOT installed by this app there. Empty: this agent has no chat over SSH yet.
    pub remote_command: Vec<String>,
    /// Fixed, NON-SECRET variables the adapter needs on the other computer (`INITIAL_AGENT_MODE = "read-only"`). Sent as
    /// `env NAME=VALUE` words in front of the program, so they are visible in that computer's process list: never a key.
    /// Names are variable names; values hold only letters, digits and `. _ - :`.
    pub remote_env: BTreeMap<String, String>,
    /// What the program runs on, when that changes how it must be started. `"python"`: the child gets `PYTHONUTF8=1`
    /// and `PYTHONUNBUFFERED=1` (a Python adapter on a Windows pipe otherwise writes in the console code page and
    /// buffers its output, which garbles or stalls the protocol). Empty (the default): nothing is added. A variable the
    /// definition sets itself in `env` wins.
    pub runtime: String,
    /// Extra names to pass through from the app's environment.
    pub env_allow: Vec<String>,
    /// Fixed variables.
    pub env: BTreeMap<String, String>,
    /// Keys an approved adapter receives from the credential store at start: the variable name and the slot that
    /// holds its value. Names only, never a value; set by `adapter_overlay::config_with` and read by `resolve_spawn`.
    #[serde(skip)]
    pub adapter_keys: Vec<AdapterKey>,
    /// Key groups of an approved adapter: each group needs at least one of its keys saved at start. An approved key
    /// that is in no group is required on its own. Names only.
    #[serde(skip)]
    pub adapter_key_groups: Vec<Vec<String>>,
    /// A built-in profile's optional key: a key from the app's credential store (Settings > Keys) that is passed to the adapter
    /// ONLY when the person saved one. Nothing is asked and nothing fails when it is not saved (the agent's own login
    /// is used then). Names only (the variable and the slot), never a value. Set in code by a built-in profile only
    /// (`serde(skip)`): a definition file, a wizard definition or a store definition can never ask for a saved secret.
    #[serde(skip)]
    pub optional_keys: Vec<OptionalKey>,
    /// `NAME -> program`: sets NAME to where `program` is on PATH (when found).
    pub env_which: BTreeMap<String, String>,
    /// A folder owned by this lane, so the agent does not read the user's own config (which, for some
    /// agents, starts all their tool servers). The agent then needs its own sign-in in that folder.
    pub private_home: Option<PrivateHome>,
    /// Tool servers handed to `session/new`. Empty by default: the agent gets only what is listed here.
    pub mcp_servers: Vec<Value>,
    /// Merged into `_meta` of `session/new`, `session/load` and `session/resume`.
    pub session_meta: Option<Value>,
    /// Adapter versions this build accepts.
    pub pins: Vec<AdapterPin>,
    pub pin_policy: PinPolicy,
    pub timeouts: Timeouts,
    pub resume: ResumePreference,
    pub history_lost: HistoryLostPolicy,
    /// Retry a start that failed with one of these messages (the agent's own start-up lock, for instance).
    pub start_retry: Option<StartRetry>,
    /// Error text (lower case) that means "the agent does not know this session id", as opposed to a
    /// transient failure. Empty = every agent error on resume counts as "does not know".
    pub unknown_session_patterns: Vec<String>,
    /// Image names (no `.exe`) of a long-lived server of this agent that starts the tool servers of its sessions and
    /// keeps them after a session ends (OpenCode's `opencode serve --service`). Empty (the default): the agent's tool
    /// servers live under its adapter and end with it. When set, each session marks this app's own tool server
    /// (`acp::leak`) and a closed session, and the next app start, end the marked ones left behind, by pid.
    pub shared_server_images: Vec<String>,
    pub quirks: Quirks,
    /// How the person's own tool-server list is kept out of a chat session.
    pub mcp_config: McpConfig,
    /// Arguments added to the agent's normal terminal launch to continue this session there ("Open in
    /// terminal"). `{session}` is the agent's own session id. Empty = the agent cannot be handed over.
    pub resume_command: Vec<String>,
    /// What the install and sign-in screens say about this agent's chat add-on (A5).
    pub addon: AddonInfo,
    /// Which model a new chat starts on when nobody asked for one, and what a "needs credit" failure says
    /// (`[acp.default_model]`). Absent: the agent's own default is kept.
    pub default_model: Option<DefaultModel>,
    /// How a read-only chat is enforced for this agent (`[acp.read_only]`). Absent: the agent cannot run a chat
    /// read-only, and `run_agent(read_only: true)` says so instead of starting one.
    pub read_only: Option<ReadOnlyChat>,
    /// The terminal is no way out for this agent (its terminal screen cannot be driven reliably). A chat that cannot
    /// start is then an error the caller reads, and is never quietly run in a terminal instead.
    pub chat_only: bool,
    /// Set for one session only (never from a table): the `authenticate` method to call right after `initialize`. A chat on
    /// a borrowed sign-in (`capacity_proxy`) uses it, because the adapter then has no login of its own, only a placeholder key.
    #[serde(skip)]
    pub authenticate_with: Option<String>,
}

/// `[acp.read_only]`: what makes a chat of this agent read-only. This app always answers the agent's permission
/// questions for edit, delete, move, execute and any other non-read tool with "reject", and never serves file writes
/// or commands itself. That alone is enough only for an agent that asks before every such tool (`asks_before_tools`).
/// An agent that runs some tools without asking needs its own read-only session mode as well (`mode`), selected
/// before the first message; when it does not take the mode, no chat is started.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ReadOnlyChat {
    /// The value of the session mode that cannot edit (`plan`). Empty: the agent has no such mode.
    pub mode: String,
    /// The settings option (or session mode list) that holds it. Empty means `mode`.
    pub mode_option: String,
    /// The agent asks (`session/request_permission`) before every edit, delete, move and command, so rejecting the
    /// questions is a full guard on its own.
    pub asks_before_tools: bool,
}

impl ReadOnlyChat {
    pub fn option_id(&self) -> &str {
        if self.mode_option.is_empty() {
            "mode"
        } else {
            &self.mode_option
        }
    }
}

/// `[acp.default_model]`: the app setting that picks the starting model of a chat, and the words for a model that
/// cannot be used for want of credit. Data, so the chat code never asks which agent it is starting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DefaultModel {
    /// The app settings holding the provider and the model id (`opencode_model_provider`, `opencode_model_id`).
    pub provider_setting: String,
    pub model_setting: String,
    /// The provider used when the saved model id has none of its own. Empty: the id is used as saved.
    pub provider_fallback: String,
    /// Between provider and model id in the value the agent offers (`opencode-go/glm-5.2`).
    pub separator: String,
    /// Lower-case pieces of an agent error that mean "this model cannot be used without credit" (or does not exist).
    pub credit_patterns: Vec<String>,
    /// The sentence shown for such an error. `{model}` is the model in use.
    pub credit_message: String,
}

/// An optional key of a built-in profile: the variable the adapter gets and the credential-store slot it is read from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OptionalKey {
    pub env: String,
    pub slot: String,
}

/// One approved key of a reviewed adapter: the variable the child gets and the credential-store slot it is read from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdapterKey {
    pub env: String,
    pub slot: String,
}

/// `[acp.addon]`: plain words for the install prompt and the sign-in card. Data, so the screens never ask
/// which agent they are showing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AddonInfo {
    /// Roughly how big the install is, for "about N MB". Absent: no size is claimed.
    pub size_mb: Option<u32>,
    /// One sentence for the sign-in card: what to do in the terminal that opens. Empty: a general sentence.
    pub signin_hint: String,
}

/// How an adapter differs from the protocol's happy path. Data, so the session code never asks which
/// agent it is talking to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Quirks {
    /// After a stop was asked for the adapter may still answer `end_turn` instead of `cancelled`. True:
    /// the turn is reported as cancelled anyway (what the person did). False: the adapter's word is kept.
    pub cancel_reports_end_turn: bool,
    /// The adapter takes one prompt at a time. Reserved: only `true` is supported by this build.
    pub serial_prompts: bool,
}

impl Default for Quirks {
    fn default() -> Self {
        Self { cancel_reports_end_turn: true, serial_prompts: true }
    }
}

/// What to do about the person's own tool-server list (the MCP servers in the agent's own settings). A
/// chat session started by this app must not start them all (about 25 processes for one Codex user,
/// including this app's own MCP program).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpMode {
    /// Nothing is done: the agent loads whatever it is set up with.
    #[default]
    AgentDefault,
    /// The agent has a session switch for it, sent in `session_meta`.
    SessionMeta,
    /// A folder only this lane uses (`private_home`). The agent needs its own sign-in there, and its
    /// sessions are separate, so a conversation cannot be handed over to the terminal.
    PrivateHome,
    /// The person's own config is used (login and sessions are shared, so hand-over works) and every tool
    /// server it lists is switched off through a JSON setting the adapter merges into each session.
    DisableListed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListFailure {
    /// The chat session is not started (the caller falls back to the terminal).
    #[default]
    Refuse,
    /// Start anyway, with the agent's own list loaded.
    Continue,
}

/// `[acp.mcp_config]`. Only the fields of the chosen `mode` are read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct McpConfig {
    pub mode: McpMode,
    /// `disable_listed`: the variable that holds the JSON setting (the adapter merges it into each session).
    pub env: String,
    /// `disable_listed`: JSON merged first, for settings that are not about one server.
    pub base: Value,
    /// `disable_listed`: the agent's own program (found on PATH) that lists its tool servers as JSON.
    pub list_program: String,
    pub list_args: Vec<String>,
    /// `disable_listed`: the field of each listed entry that holds the server's name.
    pub name_field: String,
    /// `disable_listed`: where one server's switch goes in the JSON; `{name}` is the server's name.
    pub disable_path: Vec<String>,
    /// `disable_listed`: the value put there.
    pub disable_value: Value,
    /// `disable_listed`: where this app's own tool server goes in the JSON (`{name}` is its name). When set, that
    /// server is handed over here, after the switches, and left out of `mcpServers` in the session calls. Some
    /// adapters drop a requested server whose name is already in the person's own setup, and replace the whole
    /// server table (the switches included) whenever one is requested; the setting has neither problem.
    pub own_server_path: Vec<String>,
    /// `disable_listed`: JSON merged into the own server's entry (a switch that turns it on, its approval setting).
    pub own_server_extra: Value,
    pub on_list_failure: ListFailure,
    /// `disable_listed`: the files the agent's own list is read from (templates: `{home}` the user's home folder, `{cwd}` the
    /// session's folder, `{NAME}` an environment variable; a file whose variable is not set is left out). When set, the
    /// listing is remembered for ten minutes and asked again as soon as one of these files changes or appears/disappears.
    /// Empty (the default): the listing is asked for at every start.
    pub list_cache_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrivateHome {
    /// The variable that points the agent at the folder.
    pub env_var: String,
    pub config_file: String,
    pub config_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterPin {
    pub package: String,
    pub version: String,
    /// The file that runs (template). Its SHA-256 is compared when `sha256` is set.
    pub entry: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PinPolicy {
    /// A version or file that is not pinned is refused (the caller falls back to the terminal).
    #[default]
    Enforce,
    /// Logged, then started anyway (development).
    Warn,
    Off,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResumePreference {
    /// `session/resume` first (no history replay, cheaper), `session/load` if the agent has no resume.
    #[default]
    PreferResume,
    /// `session/load` first (replays the history).
    PreferLoad,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryLostPolicy {
    /// Start a new session, tell everyone (`HistoryLost`), and send the prompt there.
    #[default]
    ContinueFresh,
    /// Start a new session, tell everyone, and refuse the prompt: the caller asks the person first.
    Refuse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StartRetry {
    /// Lower-case fragments of the error (or of the adapter's stderr) that make a retry worth it.
    pub patterns: Vec<String>,
    /// Waits before each retry, in milliseconds. One entry = one retry.
    pub delays_ms: Vec<u64>,
}

pub use super::timers::Timeouts;

// ---- the table: parsing and checking -----------------------------------------------------------------

/// An `[acp]` table's text, with the identity (`[agent] id`, `label`) put in. Fails on an unknown field, a
/// field with the wrong type, or a table that does not pass [`table_problems`].
pub fn from_toml_text(id: &str, label: &str, text: &str) -> Result<AgentConfig, String> {
    let mut cfg: AgentConfig = toml::from_str(text).map_err(|e| e.to_string())?;
    if let Some((path, message)) = table_problems(&cfg).into_iter().next() {
        return Err(format!("{path}: {message}"));
    }
    cfg.id = id.to_string();
    cfg.label = label.to_string();
    Ok(cfg)
}

/// What is wrong with a table as it appears in a definition (the id and label are not part of it).
pub fn table_problems(cfg: &AgentConfig) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if !cfg.id.is_empty() || !cfg.label.is_empty() {
        out.push(("acp".to_string(), "id and label come from [agent]; remove them from [acp]".to_string()));
    }
    out.extend(problems(cfg));
    out
}

pub const MAX_TEXT: usize = 512;

pub fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '(' || c == ')')
        && name.len() <= 128
}

pub fn plain_text(text: &str) -> bool {
    text.chars().count() <= MAX_TEXT && !text.chars().any(char::is_control)
}

/// Every reason this config could not be used, as `(path, message)`. Empty = fine. Run on definitions that
/// come from outside the build, and on the built-in tables (a test keeps those clean).
pub fn problems(cfg: &AgentConfig) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut add = |path: &str, message: String| out.push((format!("acp.{path}"), message));
    if cfg.command.trim().is_empty() || !plain_text(&cfg.command) {
        add("command", "needed, at most 512 characters, no control characters".into());
    }
    if !matches!(cfg.runtime.trim().to_ascii_lowercase().as_str(), "" | "python") {
        add("runtime", "must be empty or \"python\"".into());
    }
    if cfg.args.len() > 64 || !cfg.args.iter().all(|a| plain_text(a)) {
        add("args", "at most 64 arguments of at most 512 characters, no control characters".into());
    }
    if let Some((program, rest)) = cfg.remote_command.split_first() {
        if !crate::ssh::model::valid_program(program) || rest.len() > 15 || !rest.iter().all(|a| plain_text(a)) {
            add("remote_command", "a bare program name, then at most 15 arguments of at most 512 characters".into());
        }
    }
    if cfg.remote_env.len() > 8 || cfg.remote_env.iter().any(|(k, v)| !valid_env_name(k) || !valid_remote_env_value(v)) {
        add("remote_env", "at most 8 variables; values hold only letters, digits and . _ - : (it is not for secrets)".into());
    }
    for name in cfg.env_allow.iter().chain(cfg.env.keys()).chain(cfg.env_which.keys()) {
        if !valid_env_name(name) {
            add("env", format!("{name:?} is not a variable name"));
        }
    }
    if cfg.env.len() > 32 || cfg.env_allow.len() > 32 || cfg.env_which.len() > 8 || !cfg.env.values().all(|v| plain_text(v)) {
        add("env", "too many variables, or a value is too long".into());
    }
    if cfg.env_which.values().any(|p| p.is_empty() || p.contains(['/', '\\', ':']) || !plain_text(p)) {
        add("env_which", "each value is a bare program name looked up on PATH".into());
    }
    if cfg.mcp_servers.len() > 16 || !cfg.mcp_servers.iter().all(Value::is_object) {
        add("mcp_servers", "at most 16 tool servers, each an object".into());
    }
    if cfg.pins.len() > 16 {
        add("pins", "at most 16 pins".into());
    }
    for (i, pin) in cfg.pins.iter().enumerate() {
        if pin.package.trim().is_empty() || pin.version.trim().is_empty() || pin.entry.trim().is_empty() {
            add(&format!("pins.{i}"), "package, version and entry are needed".into());
        }
        if pin.sha256.as_deref().is_some_and(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit())) {
            add(&format!("pins.{i}.sha256"), "must be 64 hex characters".into());
        }
    }
    if cfg.pin_policy == PinPolicy::Enforce && !cfg.pins.is_empty() && cfg.pins.iter().all(|p| p.sha256.is_none()) {
        add("pins", "with pin_policy \"enforce\" at least one pin needs a sha256".into());
    }
    if let Some(ro) = &cfg.read_only {
        if ro.mode.trim().is_empty() && !ro.asks_before_tools {
            add("read_only", "needs a mode, or asks_before_tools = true (otherwise nothing makes the chat read-only)".into());
        }
        if !plain_text(&ro.mode) || !plain_text(&ro.mode_option) {
            add("read_only", "mode and mode_option are short plain text".into());
        }
    }
    let t = &cfg.timeouts;
    let secs = [t.request_secs, t.new_session_secs, t.load_secs, t.stdin_write_secs, t.inactivity_secs, t.progress_secs, t.hung_grace_secs, t.idle_ttl_secs];
    if secs.iter().any(|s| *s == 0 || *s > 24 * 3600) {
        add("timeouts", "every value is between 1 and 86400 seconds".into());
    }
    if !cfg.quirks.serial_prompts {
        add("quirks.serial_prompts", "reserved: this build supports one prompt at a time only (true)".into());
    }
    if cfg.shared_server_images.len() > 4 || !cfg.shared_server_images.iter().all(|p| plain_text(p) && !p.contains(['/', '\\'])) {
        add("shared_server_images", "at most 4 program names, no folders".into());
    }
    if cfg.unknown_session_patterns.len() > 16 || !cfg.unknown_session_patterns.iter().all(|p| plain_text(p)) {
        add("unknown_session_patterns", "at most 16 short patterns".into());
    }
    if cfg.addon.size_mb.is_some_and(|mb| mb == 0 || mb > 4096) || cfg.addon.signin_hint.chars().count() > 300 || cfg.addon.signin_hint.chars().any(char::is_control) {
        add("addon", "size_mb is 1 to 4096; signin_hint is at most 300 characters on one line".into());
    }
    if let Some(d) = &cfg.default_model {
        let short = |t: &str| t.chars().count() <= 300 && !t.chars().any(char::is_control);
        if d.model_setting.trim().is_empty() || d.credit_patterns.len() > 16 || !d.credit_patterns.iter().all(|p| plain_text(p)) || !short(&d.credit_message) || !short(&d.separator) {
            add("default_model", "model_setting is needed; at most 16 short credit_patterns; credit_message at most 300 characters on one line".into());
        }
    }
    if cfg.disabled_note.chars().count() > 300 {
        add("disabled_note", "at most 300 characters".into());
    }
    if !cfg.resume_command.is_empty() && crate::session_chat::history::resume_args_from(&cfg.resume_command, SAMPLE_SESSION).is_none() {
        add("resume_command", "must contain {session} and no other braces".into());
    }
    if cfg.resume_command.len() > 16 || !cfg.resume_command.iter().all(|a| plain_text(a)) {
        add("resume_command", "at most 16 arguments of at most 512 characters".into());
    }
    let m = &cfg.mcp_config;
    match m.mode {
        McpMode::AgentDefault => {}
        McpMode::SessionMeta => {
            if session_meta(cfg).is_none() {
                add("mcp_config.mode", "\"session_meta\" needs a session_meta table".into());
            }
        }
        McpMode::PrivateHome => {
            if cfg.private_home.is_none() {
                add("mcp_config.mode", "\"private_home\" needs a private_home table".into());
            }
        }
        McpMode::DisableListed => {
            if !valid_env_name(&m.env) {
                add("mcp_config.env", "must be the name of the variable that holds the setting".into());
            }
            if m.list_program.is_empty() || m.list_program.contains(['/', '\\', ':']) || !plain_text(&m.list_program) {
                add("mcp_config.list_program", "a bare program name looked up on PATH".into());
            }
            if m.list_args.len() > 16 || !m.list_args.iter().all(|a| plain_text(a)) {
                add("mcp_config.list_args", "at most 16 short arguments".into());
            }
            if m.name_field.is_empty() || !plain_text(&m.name_field) {
                add("mcp_config.name_field", "needed".into());
            }
            if m.disable_path.is_empty() || m.disable_path.len() > 8 || !m.disable_path.iter().any(|p| p.contains("{name}")) {
                add("mcp_config.disable_path", "1 to 8 parts, at least one with {name}".into());
            }
            if !m.disable_value.is_object() && !m.disable_value.is_boolean() {
                add("mcp_config.disable_value", "an object or a boolean".into());
            }
            if !m.base.is_null() && !m.base.is_object() {
                add("mcp_config.base", "an object".into());
            }
            if !m.own_server_path.is_empty() && (m.own_server_path.len() > 8 || !m.own_server_path.iter().any(|p| p.contains("{name}"))) {
                add("mcp_config.own_server_path", "1 to 8 parts, at least one with {name}".into());
            }
            if !m.own_server_extra.is_null() && !m.own_server_extra.is_object() {
                add("mcp_config.own_server_extra", "an object".into());
            }
            if cfg.env.keys().any(|k| k.eq_ignore_ascii_case(&m.env)) {
                add("mcp_config.env", "is also set in [acp.env]".into());
            }
            if m.list_cache_files.len() > 8 || !m.list_cache_files.iter().all(|f| plain_text(f)) {
                add("mcp_config.list_cache_files", "at most 8 short file names".into());
            }
        }
    }
    if m.mode != McpMode::PrivateHome && cfg.private_home.is_some() {
        add("private_home", "set mcp_config.mode = \"private_home\" to use it".into());
    }
    out
}

/// A session id shaped like a real one, for checking templates.
pub const SAMPLE_SESSION: &str = "00000000-0000-0000-0000-000000000000";

/// A `remote_env` value: letters, digits and `. _ - :` only, so nothing in it is special to any shell.
pub fn valid_remote_env_value(v: &str) -> bool {
    !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// `_meta` for the session calls: the config's, or nothing.
pub fn session_meta(cfg: &AgentConfig) -> Option<Value> {
    cfg.session_meta.clone().filter(|v| !v.is_null())
}
