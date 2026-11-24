//! Model Bridge lives in `pm-core`; the app keeps the guard tests that scan the app's own source.
pub use pm_core::model_bridge::*;

#[cfg(test)]
mod guard_tests;
