//! The capability table lives in `pm-core`. What stays here is the drift check: it re-runs the add-agent ladder's free
//! checks (`wizard_ladder`), which is app-only.

pub use pm_core::agent_caps::*;

pub mod drift;

#[cfg(test)]
mod added_agent_tests;
