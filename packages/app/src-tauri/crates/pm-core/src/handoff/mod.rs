//! Moved out of the app: the limit tables and the limit detector (the app re-exports `limits`, `reset`, `detect`).
pub mod detect;
pub mod limits;
pub mod reset;
pub use detect::LimitHit;
pub use limits::{validate_limits, CompiledLimits, LimitsTable};

use crate::tui::{StartupGate, TuiProfile};
use reset::SystemClock;

/// The gate a usage limit puts on a pane: nothing is typed into it. No dismiss keys, ever: the
/// person (or the agent's own wait) moves past a limit, Potato Workspace does not.
pub const USAGE_LIMIT_GATE: StartupGate = StartupGate {
    id: "usage_limit",
    summary: "The agent has stopped at its usage limit",
    dismiss: None,
};

/// Readiness input (`agent_runs::readiness::assess`): a gate for a screen that shows a usage limit,
/// an unavailable plan or the vendor's own limit menu. Whether the profile has a `[limits]` table
/// decides; no agent is named here.
pub fn limit_gate(profile: &dyn TuiProfile, screen: &str) -> Option<StartupGate> {
    let hit = profile.detect_limit(screen, &SystemClock)?;
    hit.kind.stops_typing().then_some(USAGE_LIMIT_GATE)
}

