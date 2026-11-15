//! Routines and Chains: ONE small workflow engine.
//!
//! A workflow is a trigger plus ordered steps, saved as versioned JSON (`model::Workflow`, `v: 1`) so a node
//! editor can be put on top of it later without a new format.
//!
//! - Trigger `schedule` (time of day on chosen days) = a **Routine**.
//! - Trigger `chat_finished` (when a chat finishes, optionally only if it went well) = a **Chain** ("after this,
//!   do that"). It fires once.
//! - Trigger `manual` = "Run now" only.
//! - Steps: `start_agent`, `wait`, `follow_up`, `notify`.
//!
//! It runs inside the app (no OS scheduler). A schedule that came due while the computer was off runs once at
//! the next start, with a note. "At most N at once" is a global limit on running agents (default off): a
//! start over the limit waits in a visible queue.
//!
//! Layout: `model` (types, validation), `schedule` (time of day maths, pure), `store` (private file), `engine`
//! (the `Io` trait, ticks, queue), `view` (what the UI reads), `live` (the real world), tests beside them.
//! The engine is tested with a fake `Io` and a clock the test moves.
//!
//! Safety: a routine only starts agents and sends text to chats the person named. It never answers a question
//! an agent asks, never merges, and never starts an agent in a folder the person did not pick.

pub mod engine;
pub mod live;
pub mod model;
pub mod schedule;
pub mod store;
pub mod view;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod schedule_tests;
#[cfg(test)]
mod store_tests;
