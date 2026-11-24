//! Rules the person sets for their agents: Force yes, Fences and Pins.
//!
//! * **Force yes** (`force_yes`): a switch, per agent and per chat, that answers "allow once" to an agent's permission
//!   questions for the person. Off by default. It never answers a question the risk rules (`prompt_risk`) do not call
//!   low risk, never a question that looks like a password or a login, never "allow always", and every answer is logged
//!   in the audit log and as one quiet line in the chat.
//! * **Fences** (`fence`): folders and files of a project an agent must not touch. A write the agent asks permission
//!   for inside a fence is refused for the person, "Keep" of a copy refuses fenced files, and the fences are written
//!   into the agent's first message.
//! * **Pins** (`data::Pin`): starting settings every new agent of a project (or of every project) picks up: model,
//!   mode, Force yes and notes. A project's pin wins over the global one, field by field.
//!
//! The saved file is `<app data>/agent_rules.json`. Like `agent_authority`, it is written only by the Settings window
//! (Tauri commands); no bridge route or MCP tool reaches it. Nothing here names an agent.

pub mod data;
pub mod fence;
pub mod force_yes;
pub mod notes;
pub mod terminal;
#[cfg(test)]
mod tests;

pub use data::{Pin, RulesStore};

use once_cell::sync::Lazy;

static GLOBAL: Lazy<RulesStore> = Lazy::new(RulesStore::open_default);

/// The app's own store (a file in the app data folder; memory only under test).
pub fn store() -> &'static RulesStore {
    &GLOBAL
}
