//! The crew file and its error type.
//!
//! One shape serves two files: the saved crew (`crews/<slug>.toml`, `[[roles]]`) and a crew section of the
//! CLI config file (`[crew.<id>]` with `[[crew.<id>.role]]`, see `config_format`). The first fields (`name`,
//! `roles` with `name`, `agent_type`, `task`, `parent`) are the older saved-team shape; everything after
//! them is optional, so an older file still reads and the "Start crew" flow is unchanged.

use serde::{Deserialize, Serialize};

/// A crew holds at most this many roles.
pub const MAX_ROLES: usize = 8;
/// The only placeholder a task may use: the folder the crew is started in.
pub const PLACEHOLDER: &str = "{folder}";
/// The agent of a starter role: the person's default agent, filled in when the crew starts.
pub const DEFAULT_AGENT: &str = "{default}";
/// A crew file larger than this is not read.
pub const MAX_FILE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Crew {
    /// In a config file the name may be left out: the section id is used.
    #[serde(default)]
    pub name: String,
    /// `[[roles]]` in a crew file, `[[crew.<id>.role]]` in the CLI config file.
    #[serde(default, alias = "role")]
    pub roles: Vec<Role>,
    /// Usage cap for one run of the crew. Read-only in 1.1.6; the canvas edits it in 1.1.7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    /// Most helpers alive at once (standbys included). `None`: the app's own limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_helpers: Option<u32>,
    /// Most times the checker may send work back to the orchestrator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_loops: Option<u32>,
    /// A plain file name (like `difficulty.md`) that says how work is routed, in words for the
    /// orchestrator. Never code, never a path.
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "route_by")]
    pub routing_file: Option<String>,
    /// Workflow (Labs): one shared note given to every role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how_i_work: Option<String>,
    /// Workflow: `front` (only the Front starts; it starts helpers when needed, the default) or `horde` (all now).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_mode: Option<String>,
    /// Workflow: most helper runs the Front may start per message from the person. `None`: `DEFAULT_HELPER_CAP`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_cap: Option<u32>,
}

/// Helper runs per message when a workflow does not say.
pub const DEFAULT_HELPER_CAP: u32 = 3;
pub const START_MODES: [&str; 2] = ["front", "horde"];
pub const KINDS: [&str; 2] = ["minion", "spin_off"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
}

pub const WRITE_LEVELS: [&str; 3] = ["none", "worktree", "scoped"];
pub const RUN_LEVELS: [&str; 4] = ["none", "read-only", "worktree", "ask"];

/// What a role may do. These become real app settings when a crew is applied (1.1.7): read-only runs,
/// worktree isolation, the shell gate. They are never only words in a prompt.
/// `write`: `none`, `worktree` (its own worktree) or `scoped` (only the folder `write_scope` names).
/// `run` (shell): `none`, `read-only`, `worktree` or `ask` (each command asks the person).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    #[serde(default = "yes")]
    pub read: bool,
    #[serde(default = "none_word")]
    pub write: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_scope: Option<String>,
    #[serde(default = "none_word")]
    pub run: String,
    #[serde(default)]
    pub start_helpers: bool,
    /// Merge branches. Only the orchestrator (the role with no parent) may.
    #[serde(default)]
    pub merge: bool,
}

fn yes() -> bool {
    true
}

fn none_word() -> String {
    "none".to_string()
}

/// Where a role sits on the canvas (1.1.7). Not used for anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

/// One agent of the crew. `task` may use `{folder}`; `parent` names another role of the crew (the
/// root role has none).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Role {
    /// A short stable id (`worker-easy`). Empty: the name is the id.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub name: String,
    #[serde(alias = "agent")]
    pub agent_type: String,
    /// The job text (`job` is accepted too).
    #[serde(alias = "job")]
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Permissions>,
    /// Helpers of this role to keep warm (the standby pool).
    #[serde(default, skip_serializing_if = "is_zero", alias = "warm")]
    pub standbys: u8,
    /// Who this role hands work to (ids or names). Reporting back to the parent is not an edge.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hands_to: Vec<String>,
    /// This role checks work. Its edge back to the orchestrator is the one loop a crew may have.
    #[serde(default, skip_serializing_if = "is_false")]
    pub check: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    /// Workflow: this role is the Front (at most one; it must be the lead).
    #[serde(default, skip_serializing_if = "is_false")]
    pub front: bool,
    /// Workflow helper: `minion` (default) or `spin_off`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Workflow helper: one line, "hard coding tasks".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
}

fn is_zero(n: &u8) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl Role {
    /// The id other roles use for this one.
    pub fn key(&self) -> &str {
        if self.id.is_empty() { &self.name } else { &self.id }
    }

    /// `name` is this role's id or its name (case ignored).
    pub fn is_called(&self, name: &str) -> bool {
        self.key().eq_ignore_ascii_case(name) || self.name.eq_ignore_ascii_case(name)
    }
}

/// Why a crew was refused. `code` is stable; `message` is plain words for the person. `role` names
/// the role the problem belongs to (so the sheet can mark its row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CrewError {
    pub code: &'static str,
    pub role: Option<String>,
    pub message: String,
}

impl CrewError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, role: None, message: message.into() }
    }

    pub fn for_role(code: &'static str, role: &str, message: impl Into<String>) -> Self {
        Self { code, role: Some(role.to_string()), message: message.into() }
    }
}

impl std::fmt::Display for CrewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Read a crew file's text. Shape only; `validate::validate` decides whether it may be used.
pub fn parse(text: &str) -> Result<Crew, CrewError> {
    if text.len() > MAX_FILE_BYTES {
        return Err(CrewError::new("CREW_FILE_TOO_BIG", "This crew file is too big to read."));
    }
    toml::from_str::<Crew>(text).map_err(|e| CrewError::new("CREW_FILE_INVALID", format!("This crew file cannot be read: {}", e.message())))
}

/// The file text of a crew.
pub fn to_toml(crew: &Crew) -> Result<String, CrewError> {
    toml::to_string(crew).map_err(|e| CrewError::new("CREW_FILE_INVALID", format!("This crew cannot be saved: {e}")))
}
