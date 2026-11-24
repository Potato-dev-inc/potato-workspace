//! "How agent runs work", the part that needs no window: the saved choices (`store`), the verification of an agent's
//! one-task mode (`verify`), the helper model rule and the pure kinds of an agent started by an agent (`started_as`).
//! The app keeps the rule that edits a run request (`apply*`) and re-exports all of this under `crate::agent_run_mode`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub mod agent_model;
pub mod helper_model;
pub mod started_as;
#[cfg_attr(feature = "test-util", allow(dead_code))]
pub mod store;
pub mod verify;

pub use verify::{verification_for, Verification};
pub use store::{set_started_agent_kind, set_started_agent_types, started_agent_kind, started_agent_types};
pub use store::{close_helpers_with_agent, helper_visibility, keep_helpers_open, keep_helpers_open_chosen, most_helpers_at_once, set_close_helpers_with_agent, set_most_helpers_at_once, set_stall_minutes, stall_minutes, set_for_agent, set_helper_visibility, set_keep_helpers_open, setting_for};
pub use started_as::{decide as decide_started_as, legacy_kind, parse_asked, StartedAgentKind, StartedAgentTypes, StartedAs, StartedRecord};

/// The run-mode facts of one agent type, as `GET /agents/types` and `list_agents` show them.
pub fn agent_fields(id: &str, is_declarative: bool, headless_supported: bool) -> Value {
    let verification = if is_declarative {
        verification_for(id)
    } else {
        Verification::built_in()
    };
    json!({
        "headless_supported": headless_supported,
        "headless_verified": verification.verified,
        "headless_verified_reason": verification.reason,
        "run_mode": setting_for(id).as_str(),
    })
}

/// Adds the run-mode fields to every agent of a `GET /agents/types` body.
pub fn decorate_listing(mut listing: Value) -> Value {
    let Some(agents) = listing.get_mut("agents").and_then(Value::as_array_mut) else {
        return listing;
    };
    for agent in agents {
        let Some(id) = agent.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let declarative = agent.get("definition").is_some_and(|d| !d.is_null());
        let headless = agent
            .pointer("/modes/headless")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let (Some(target), Some(fields)) = (
            agent.as_object_mut(),
            agent_fields(&id, declarative, headless).as_object().cloned(),
        ) {
            target.extend(fields);
        }
    }
    listing
}

/// Minutes without progress before a helper reads as stuck, unless the person changed it; the most the setting can be (0 turns the signal off).
pub const STALL_DEFAULT_MINUTES: u32 = 5;
pub const STALL_MAX_MINUTES: u32 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// A pane the person can watch. Today's behaviour.
    #[default]
    Visible,
    /// A headless run: verified answer, model and session; no pane.
    OneTask,
}

impl RunMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RunMode::Visible => "visible",
            RunMode::OneTask => "one_task",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "visible" => Some(RunMode::Visible),
            "one_task" => Some(RunMode::OneTask),
            _ => None,
        }
    }
}

/// Settings > Agents > "Helper agents": whether the helpers an agent starts are shown in a pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperVisibility {
    /// Every helper opens in a pane; an agent's `headless: true` is ignored. The default.
    #[default]
    AlwaysShow,
    /// The agent's `headless` argument decides (today's rule without the switch).
    AgentChooses,
    /// Every helper the agent starts runs in the background, with no pane.
    AlwaysBackground,
}

impl HelperVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            HelperVisibility::AlwaysShow => "always_show",
            HelperVisibility::AgentChooses => "agent_chooses",
            HelperVisibility::AlwaysBackground => "always_background",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "always_show" => Some(HelperVisibility::AlwaysShow),
            "agent_chooses" => Some(HelperVisibility::AgentChooses),
            "always_background" => Some(HelperVisibility::AlwaysBackground),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests;
