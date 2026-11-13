use serde::{Deserialize, Serialize};

pub const CAPS_SCHEMA: u32 = 1;
pub const MAX_MODELS: usize = 50;

/// The ladder level (night plan 2.2). L4 is not used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Level { L0, L1, L2, L3, #[default] L5 }   // JSON: "l0" | "l1" | "l2" | "l3" | "l5"

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Tri { Yes, No, #[default] Unknown }

/// Where a value comes from. `Unknown` = nothing recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// A shipped, reviewed file: bundled or Store definition, or a reviewed adapter's meta. Never a file the ladder just wrote.
    Definition,
    /// The agent's own reply to `initialize` or `session/new` during the free check.
    Handshake,
    /// A free local check that is not a reply: PATH lookup, `--version`, help text, registry or catalog lookup.
    Check,
    /// Observed in a real turn the person started.
    Seen,
    #[default] Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Cap {
    pub value: Tri,
    pub source: Source,
    /// One short fact, max 160 chars, already masked (`wizard::exec::mask_private`). Empty only when source is unknown.
    pub proof: String,
    /// RFC 3339 time the proof was recorded. None only when source is unknown.
    pub at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentCaps {
    pub schema: u32,                 // CAPS_SCHEMA
    pub agent_id: String,
    pub label: String,
    pub level: Level,
    pub level_proof: Cap,            // value Yes always; says why this level
    pub program_version: Option<String>,
    pub chat: Cap,
    pub resume: Cap,
    pub shows_steps: Cap,
    pub edits_files: Cap,
    pub asks_before_edit: Cap,
    pub asks_before_shell: Cap,
    pub model_pick: Cap,
    pub models: Vec<String>,         // at most MAX_MODELS, order as the agent gave it
    pub models_total: u32,           // full count (kilo had 450)
    pub stop: Cap,
    pub images: Cap,
    pub usage: Cap,
    pub read_only: Cap,
    /// The chat was turned off because the program changed and stopped answering; "Check it again" can clear it.
    pub needs_repair: bool,
}
