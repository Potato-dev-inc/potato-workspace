//! "Agents that agents start": what an agent that another agent starts is.
//!
//! Two types mode (`started_agent_types: "two"`): a **minion** (work the agent does for itself, in
//! the background) or a **spin-off** (a task handed off into its own chat that the person talks
//! to). One type mode (the default, founder decision D7): every started agent is a helper, as
//! before; `run_agent`'s `as` is accepted and ignored and reported as `as_used: "helper"`.
//!
//! The rule is one pure function, [`decide`]. The route calls it once per new `run_agent` (terminal
//! and chat lanes read the same inputs), stores the answer on the run, the pane and the chat
//! record, and the reply carries `as_used` / `as_reason`.

use serde::{Deserialize, Serialize};

/// What a started agent is, in Two types mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartedAs {
    Minion,
    SpinOff,
}

impl StartedAs {
    pub fn as_str(self) -> &'static str {
        match self {
            StartedAs::Minion => "minion",
            StartedAs::SpinOff => "spin_off",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "minion" => Some(StartedAs::Minion),
            "spin_off" => Some(StartedAs::SpinOff),
            _ => None,
        }
    }
}

/// Settings > Agents: "When an agent starts another agent" (Two types mode only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartedAgentKind {
    /// The agent's `as` decides; left out means a minion. The default.
    #[default]
    AgentChooses,
    /// Every started agent is a minion, whatever `as` says.
    Minion,
    /// Every started agent is a spin-off, whatever `as` says.
    SpinOff,
}

impl StartedAgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StartedAgentKind::AgentChooses => "agent_chooses",
            StartedAgentKind::Minion => "minion",
            StartedAgentKind::SpinOff => "spin_off",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "agent_chooses" => Some(StartedAgentKind::AgentChooses),
            "minion" => Some(StartedAgentKind::Minion),
            "spin_off" => Some(StartedAgentKind::SpinOff),
            _ => None,
        }
    }
}

/// Settings > Agents: "Agents that agents start". One type is today's helper; Two types is minions and spin-offs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartedAgentTypes {
    #[default]
    One,
    Two,
}

impl StartedAgentTypes {
    pub fn as_str(self) -> &'static str {
        match self {
            StartedAgentTypes::One => "one",
            StartedAgentTypes::Two => "two",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "one" => Some(StartedAgentTypes::One),
            "two" => Some(StartedAgentTypes::Two),
            _ => None,
        }
    }
}

/// The reply words for `as_reason`.
pub const AS_REASON_ONE_TYPE: &str = "one_type";
pub const AS_REASON_PERSON_SETTING: &str = "person_setting";
pub const AS_REASON_REQUESTED: &str = "requested";
pub const AS_REASON_DEFAULT: &str = "default";
pub const AS_REASON_STANDBY: &str = "standby";

/// What one new run turned out to be. Stored on the run (`WorkerPersist::started`), copied to the pane
/// (`PaneInfo::started_as`) and the chat record, and reported on the reply.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartedRecord {
    /// `minion` | `spin_off` | `helper` (One type).
    pub as_used: String,
    /// `requested` | `default` | `person_setting` | `standby` | `one_type`.
    pub as_reason: String,
    /// `minion` | `spin_off`; `None` in One type mode (`started_as` is never set there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_as: Option<String>,
    /// The caller left `as` out and the setting is "Let it choose": a ready spin-off standby may take the
    /// run, and if it does the run is a spin-off ([`StartedRecord::took_standby`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub standby_may_upgrade: bool,
    /// A spin-off standby must not take this run (it is a minion by request or by the person's setting).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub standby_refused: bool,
}

impl StartedRecord {
    pub fn kind(&self) -> Option<StartedAs> {
        self.started_as.as_deref().and_then(StartedAs::parse)
    }

    /// A standby (always a spin-off for now) took the run. With no `as` and "Let it choose" the run becomes a
    /// spin-off (`as_reason: "standby"`); a named standby's own kind wins whatever was asked.
    pub fn took_standby(&mut self, named: bool) {
        if self.as_used == "helper" || self.kind() == Some(StartedAs::SpinOff) {
            return;
        }
        if self.standby_may_upgrade || named {
            self.as_used = StartedAs::SpinOff.as_str().to_string();
            self.started_as = Some(StartedAs::SpinOff.as_str().to_string());
            self.as_reason = AS_REASON_STANDBY.to_string();
            self.standby_may_upgrade = false;
            self.standby_refused = false;
        }
    }
}

/// The decision table of the plan (5.1). `asked` is the caller's `as`.
pub fn decide(types: StartedAgentTypes, setting: StartedAgentKind, asked: Option<StartedAs>) -> StartedRecord {
    if types == StartedAgentTypes::One {
        return StartedRecord { as_used: "helper".into(), as_reason: AS_REASON_ONE_TYPE.into(), ..Default::default() };
    }
    let (kind, reason) = match (setting, asked) {
        (StartedAgentKind::Minion, Some(StartedAs::Minion)) => (StartedAs::Minion, AS_REASON_REQUESTED),
        (StartedAgentKind::Minion, _) => (StartedAs::Minion, AS_REASON_PERSON_SETTING),
        (StartedAgentKind::SpinOff, Some(StartedAs::SpinOff)) => (StartedAs::SpinOff, AS_REASON_REQUESTED),
        (StartedAgentKind::SpinOff, _) => (StartedAs::SpinOff, AS_REASON_PERSON_SETTING),
        (StartedAgentKind::AgentChooses, Some(kind)) => (kind, AS_REASON_REQUESTED),
        (StartedAgentKind::AgentChooses, None) => (StartedAs::Minion, AS_REASON_DEFAULT),
    };
    let mut out = StartedRecord {
        as_used: kind.as_str().into(),
        as_reason: reason.into(),
        started_as: Some(kind.as_str().into()),
        ..Default::default()
    };
    if kind == StartedAs::Minion {
        // Only an agent that left `as` out under "Let it choose" may be handed a ready spin-off standby.
        out.standby_may_upgrade = setting == StartedAgentKind::AgentChooses && asked.is_none();
        out.standby_refused = !out.standby_may_upgrade;
    }
    out
}

/// `as` from a request body: `Ok(None)` when absent, an error naming the allowed values otherwise.
pub fn parse_asked(value: Option<&str>) -> Result<Option<StartedAs>, String> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) => StartedAs::parse(text)
            .map(Some)
            .ok_or_else(|| format!("INVALID_ARGUMENT: as must be \"minion\" or \"spin_off\", not \"{text}\"")),
    }
}

/// What an old run, chat or pane that has no `started_as` is (plan section 7): a helper pane or chat that
/// was open at upgrade (it has a composer and a sidebar row) is a spin-off; a hidden or headless run is a minion.
pub fn legacy_kind(has_pane_or_chat: bool, headless: bool) -> StartedAs {
    if has_pane_or_chat && !headless {
        StartedAs::SpinOff
    } else {
        StartedAs::Minion
    }
}
