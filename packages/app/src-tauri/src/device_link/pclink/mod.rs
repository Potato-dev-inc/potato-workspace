//! The PC link's routes on this app. The rights code (levels, the route table, the call table, the door) is
//! `pm_core::device_link::pclink`, shared with the screen-less host; this module adds what each route does on this app
//! ([`app_services::AppServices`] and the `calls_*.rs` handlers).

pub use pm_core::device_link::pclink::*;

pub mod app_services;
pub mod calls_agents;
pub mod calls_attach;
#[cfg(test)]
mod calls_attach_tests;
#[cfg(test)]
mod calls_agents_tests;
pub mod calls_chat;
pub mod calls_lend;
pub mod calls_files;
pub mod calls_p4a;
pub mod calls_workflows;
pub mod calls_signin;
pub mod calls_install;
pub mod preview;
pub mod sessions_rows;
pub mod terminal;

#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod calls_chat_tests;
#[cfg(test)]
mod calls_lend_tests;
#[cfg(test)]
mod calls_files_tests;
#[cfg(test)]
mod calls_p4a_tests;
#[cfg(test)]
mod calls_terminal_tests;
#[cfg(test)]
mod calls_workflows_tests;
#[cfg(test)]
mod sessions_rows_tests;
