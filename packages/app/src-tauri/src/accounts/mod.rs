//! Accounts (named logins per agent) live in `pm-core`. What stays here is the helper-login card: it raises a question card
//! (`questions`, stage 6), so it cannot move yet.

pub use pm_core::accounts::*;

pub mod helper;
