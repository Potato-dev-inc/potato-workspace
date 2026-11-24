//! The flight recorder lives in `pm-core` (`pm_core::flight`); the app keeps the two parts that read the app's own state:
//! the bundle of a report (`bundle`) and the freeze watcher (`freeze`).
pub use pm_core::flight::*;

pub mod bundle;

use crate::operations::{OperationSnapshot, OperationStatus};

/// Called after an operation record is saved. A run that just failed gets its pane's ring frozen next to its record
/// (only `Failed`: a run the person cancelled is not a fault and leaves no recording).
pub fn on_operation_saved(op: &OperationSnapshot) {
    if op.status != OperationStatus::Failed {
        return;
    }
    let Some(error) = op.error.as_ref() else { return };
    freeze::on_run_failed(&op.project_path, &op.operation_id, op.pane_id.as_deref(), &error.code);
}


#[cfg(test)]
mod tests;
