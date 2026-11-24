//! The event log lives in `pm-core` (`pm_core::event_log`); this keeps the old path, the recent-event queries (they name the
//! OpenCode status) and the read-model rebuild (it names the projections).

pub use pm_core::event_log::*;

mod recent;
pub use recent::*;

pub fn rebuild_read_models() -> Result<crate::projections::ReadModels, String> {
    Ok(crate::projections::build_read_models(&read_global_entries()?))
}
