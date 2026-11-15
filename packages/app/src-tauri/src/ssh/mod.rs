//! Over SSH (Devices phase 3): any machine that takes an SSH login becomes a place to run a terminal or a CLI agent.
//!
//! Rules (DEVICES-RUNTIMES-1115 section 5, phase 3):
//! * Nothing is installed on the far machine, and the check runs one fixed read-only script.
//! * The system `ssh` does everything. Its argument list is built from validated parts only (`command`): the
//!   destination follows `--`, and a folder or program is quoted for the far shell or refused.
//! * `StrictHostKeyChecking` is never turned off. A changed host key stops the connection and is said plainly.
//! * The key file is passed to `ssh -i` by path. It is never opened, read or copied here.
//! * No password is ever asked for or stored here: ssh asks in the terminal itself.
//! * No login of this PC crosses to the far machine: an SSH pane gets no account, hook or model-bridge env.
//! * Desktop only: no bridge route and no MCP tool reaches this module (the guard test reads the sources).
//! * Chats over SSH are NOT offered: the chat-over-ssh lab did not pass (see `check.rs`, `CHAT_LAB`).

pub mod check;
pub mod command;
pub mod model;
pub mod once;
pub mod run;
pub mod store;

#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod tests;
