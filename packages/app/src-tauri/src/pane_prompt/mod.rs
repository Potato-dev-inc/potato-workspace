//! The pane prompt detector lives in `pm-core`; Force yes (`force_yes`) stays here: it asks the app's settings and pins.
pub use pm_core::pane_prompt::*;

pub mod force_yes;
