//! The ACP chat. The engine moved to `pm_core::acp::chat` (stage 6); what stays here is the half that talks to `agent_runs`,
//! `operations`, `worktrees` and the bridge: the agent-facing surface (`run_agent`, `wait_agents`, ...), the lane decision, the
//! chat-copy feature and the run receipt.

pub use pm_core::acp::chat::*;

pub mod copy;
pub mod decide;
pub mod lanes;
mod receipt_build;
pub(crate) mod stall_support;
mod standby_open;
pub mod surface;
pub use standby_open::open_standby_chat;

/// The chat's receipt: the facts are `pm_core`'s, `build` makes the app's `RunReceipt` from them.
pub mod receipt {
    pub use super::receipt_build::{build, receipt_value};
    pub use pm_core::acp::chat::receipt::*;
}

#[cfg(test)]
mod auto_lane_tests;
#[cfg(test)]
mod copy_tests;
#[cfg(test)]
mod decide_tests;
#[cfg(test)]
mod project_budget_tests;
#[cfg(test)]
mod start_warm_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod workspace_tests;
