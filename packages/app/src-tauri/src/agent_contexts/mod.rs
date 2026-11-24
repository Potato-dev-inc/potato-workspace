//! The agent context profiles live in `pm-core`; the app keeps the part that asks a running OpenCode pane (`inspect`).
pub use pm_core::agent_contexts::*;

mod inspect;
pub use inspect::*;

#[cfg(test)]
mod tests;
