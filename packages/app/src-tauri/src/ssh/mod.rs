//! Over SSH (Devices phase 3): any machine that takes an SSH login becomes a place to run a terminal or a CLI agent.
//!
//! Rules (DEVICES-RUNTIMES-1115 section 5, phase 3):
//! * The check runs one fixed read-only script. "Set it up" (`install`) is the only thing that puts anything on the far machine: the
//!   `potato-host` program, in the user's home folder, through fixed command lines only (a guard test reads the source).
//! * The system `ssh` does everything. Its argument list is built from validated parts only (`command`): the
//!   destination follows `--`, and a folder or program is quoted for the far shell or refused.
//! * `StrictHostKeyChecking` is never turned off. A changed host key stops the connection and is said plainly.
//! * The key file is passed to `ssh -i` by path. It is never opened, read or copied here.
//! * No password is ever asked for or stored here: ssh asks in the terminal itself.
//! * No login of this PC crosses to the far machine: an SSH pane gets no account, hook or model-bridge env.
//! * Desktop only: no bridge route and no MCP tool reaches this module (the guard test reads the sources).
//! * A chat over SSH (`acp`) runs the agent's own ACP adapter ON the far machine, with the far machine's own sign-in. The
//!   adapter's file and terminal requests are not served by this PC (the handshake turns them off), so the agent uses its
//!   own tools there. `browse` lets the window READ a remote project's folders, one file and its git state, with the same hardened `ssh`.
//!   Never run against a real host by the tests; see `acp.rs` for the command shape and its assumptions.

pub mod acp;
pub mod browse;
pub mod check;
pub mod command;
pub mod install;
pub use pm_core::ssh::model;
pub use pm_core::ssh::once;
pub mod run;
pub mod store;

#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod real_tests;
