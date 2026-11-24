//! The ACP lane (A1, the core): drive an agent through the Agent Client Protocol instead of through its
//! terminal screen. No UI and no chat items here; those come in A2 and later. Behind the Labs switch
//! always on (the old `acp_chat_enabled` switch is ignored), and the terminal stays a full way to run every agent
//! (`lane::RunLane`).
//!
//! ```text
//!   AcpSession (session.rs)   state machine + snapshot, parked permission questions, turns, restore
//!     |  Supervisor (supervisor.rs)   sweep: turn clocks, idle TTL, live cap
//!     v
//!   AcpConnection (conn.rs)   process + JSON-RPC over stdio, 5 threads, bounded queues
//!     |-- Containment (job.rs)         Windows Job Object, KILL_ON_JOB_CLOSE (tree kill elsewhere)
//!     |-- WriteQueue (write_queue.rs)  normal + priority lane to stdin, stall watchdog
//!     `-- wire.rs, ring.rs             framing, id spaces, capped stderr ring
//! ```
//!
//! On top of the core (A3):
//!
//! ```text
//!   Conversations (conversations.rs)  record per conversation (record.rs), restart restore, who writes (writers.rs)
//!     `-- hand-over (handover.rs)      "Open in terminal" / "Back to chat": one live writer, via PaneHost
//! ```
//!
//! The agent tables come from the definitions: a code profile's `acp.toml` or a definition's `[acp]`
//! (`config.rs`, docs/specs/agent-definitions).
//!
//! # Why our own transport and our own small types (no ACP crate)
//!
//! Both official crates were looked at and neither is used.
//!
//! * `agent-client-protocol` (the SDK) is a cooperative, `futures`-based connection builder that owns the
//!   read loop, dispatches typed handlers and answers the agent's requests itself. This lane needs the
//!   opposite on five points: a priority write path for cancel and permission replies; a stdin write
//!   timeout that kills the process; a bounded, ordered queue with backpressure onto the child's pipe;
//!   permission requests parked by us with no timeout; and process containment (the Job Object) tied to
//!   the child. Those are easier in a small transport of our own than in a hook around someone else's
//!   driver, and the rest of the app is threads and `parking_lot`, not `futures`. It also pins an exact
//!   schema version.
//! * `agent-client-protocol-schema` (types only) was tried and removed: it requires `serde_json`'s
//!   `preserve_order` feature, and Cargo unifies features across the whole app, so every JSON object in
//!   Potato Workspace would keep insertion order instead of sorted order. Seven existing tests failed at
//!   once (golden files, the pinned tool-catalog version), and any signed or hashed JSON would have
//!   changed silently. `types.rs` has the dozen message types this lane reads, tolerant of unknown fields,
//!   checked against real adapter traffic in `fixtures/`; everything else in a message stays a raw
//!   `serde_json::Value` for A2's chat mapper.
//!
//! # Rules this module keeps (tests in each file)
//!
//! * Never auto-approve. `session/request_permission` is parked until `answer_permission` or `cancel`.
//! * No window: every process starts through `proc_util::hidden_command`.
//! * No process outlives its session or the app (Job Object), and none is ever killed by image name.
//! * Agent specifics are data (`config.rs`): this code never matches an agent id or name.
//! * Every queue is bounded; every wait has a limit written down in `config::Timeouts`.
//! * Only protocol v1. We offer no file or terminal capability; the agent does its own file work.
//!
//! Parts of the design (queue sizes, the two timer windows, idle TTL, respawn with `session/load`, a
//! fail-closed permission relay) follow ideas studied in `D:\pm-research\NUPHOS-ACP-STUDY.md`. No Nuphos
//! code is copied here.

// The chat (A2) is `chat/`; the callers that resume sessions, switch to the terminal and show config chips land in A3 to A5.
#![allow(dead_code)]

pub use pm_core::acp::account;
pub use pm_core::acp::adapter_catalog;
pub use pm_core::acp::adapter_health;
pub use pm_core::acp::adapter_keys;
pub use pm_core::acp::adapter_overlay;
pub use pm_core::acp::agent_python;
pub mod bridge;
pub mod chat;
pub mod config;
pub use pm_core::acp::conn;
pub use pm_core::acp::conversations;
pub use pm_core::acp::error;
pub use pm_core::acp::handover;
pub use pm_core::acp::install;
pub use pm_core::acp::install_registry;
#[cfg(test)]
pub use pm_core::acp::handshake;
pub use pm_core::acp::job;
pub use pm_core::acp::leak;
pub use pm_core::acp::journal;
pub use pm_core::acp::lane;
pub use pm_core::acp::overlay;
pub mod model_probe;
pub use pm_core::acp::pin;
pub use pm_core::acp::record;
pub use pm_core::acp::registry;
pub use pm_core::acp::session;
pub mod signin_ask;
pub use pm_core::acp::state;
pub use pm_core::acp::supervisor;
pub use pm_core::acp::types;
pub use pm_core::acp::memory;
pub use pm_core::acp::warm;
#[cfg(test)]
pub use pm_core::acp::write_queue;
pub use pm_core::acp::writers;

#[cfg(test)]
pub mod fake_agent;
#[cfg(test)]
mod overlay_bridge_tests;
#[cfg(test)]
mod model_probe_tests;

pub use pm_core::acp::{apply_settings, chat_enabled};
#[allow(unused_imports)]
pub use pm_core::acp::{labs_on, LABS_KEY};
