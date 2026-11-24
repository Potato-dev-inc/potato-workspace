//! Prompt risk lives in `pm-core`. These tests stay in the app: some of them read the pane-prompt detector and the agent profiles.
pub use pm_core::prompt_risk::*;

#[cfg(test)]
mod tests;
