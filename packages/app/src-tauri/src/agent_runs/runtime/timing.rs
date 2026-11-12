//! `receipt.timing`: where a run's time went, read from the stage marks the run kept.

use crate::operations::OperationSnapshot;
use serde::{Deserialize, Serialize};

/// All values are milliseconds; a part the lane does not mark is absent (never guessed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunTiming {
    /// Run created until the app began starting it (waiting behind other work).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_ms: Option<u64>,
    /// Started until the prompt was written (pane or process spawn, readiness).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    /// Prompt written until the first output (headless runs mark this).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_output_ms: Option<u64>,
    /// Run created until the turn finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_ms: Option<u64>,
    /// A warm standby worker ran the turn, so no spawn was paid.
    pub warm: bool,
}

pub fn of(snapshot: &OperationSnapshot) -> RunTiming {
    let mark = |name: &str| snapshot.worker.stage_log.iter().find(|m| m.stage == name).map(|m| m.at_ms);
    let dispatched = mark("dispatching");
    let started = snapshot.started_at_ms;
    RunTiming {
        queue_ms: dispatched.map(|at| at.saturating_sub(snapshot.created_at_ms)),
        start_ms: dispatched.zip(started).map(|(at, started)| started.saturating_sub(at)),
        first_output_ms: mark("first_output").zip(started).map(|(at, started)| at.saturating_sub(started)),
        total_ms: super::view::run_timings(snapshot).1,
        warm: snapshot.worker.standby_used,
    }
}
