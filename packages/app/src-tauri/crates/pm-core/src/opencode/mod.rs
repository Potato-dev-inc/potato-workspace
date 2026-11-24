//! Moved out of the app: the pieces of the OpenCode lane a pane carries (the app re-exports each under its old path).
pub mod client;
pub mod edition;
pub mod link;

pub use client::{OpenCodeModelRef, OpenCodePermission};
pub use link::OpenCodeLink;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeySwapEvent {
    pub kind: String,
    pub pane_id: String,
    pub from_profile: String,
    pub to_profile: Option<String>,
    pub reason: String,
    pub auto_rotated: bool,
    pub at_ms: i64,
}
