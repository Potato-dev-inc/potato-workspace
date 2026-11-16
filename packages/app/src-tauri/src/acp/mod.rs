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

pub mod account;
mod ask_facts;
mod auto_approve;
pub mod adapter_catalog;
pub mod adapter_health;
pub mod adapter_keys;
pub mod adapter_overlay;
pub mod agent_python;
pub mod bridge;
pub mod chat;
pub mod closed;
pub mod config;
pub mod conn;
pub mod conversations;
pub mod error;
pub mod handover;
pub mod handshake;
pub mod install;
pub mod install_archive;
pub mod install_registry;
pub mod job;
pub mod leak;
pub mod journal;
pub mod lane;
pub mod overlay;
pub mod model_probe;
pub mod pin;
pub mod record;
pub mod registry;
pub mod ring;
pub mod session;
pub mod signin_ask;
pub mod state;
pub mod supervisor;
pub mod timers;
pub mod types;
pub mod memory;
pub mod warm;
pub mod wire;
pub mod write_queue;
pub mod writers;

#[cfg(test)]
mod adapter_health_tests;
#[cfg(test)]
mod adapter_key_tests;
#[cfg(test)]
mod conversation_tests;
#[cfg(test)]
pub(crate) mod fake_agent;
#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod hardening_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod speedup_tests;
#[cfg(test)]
mod model_probe_tests;
#[cfg(test)]
mod warm_tests;
#[cfg(test)]
mod warm_helper_tests;

use serde_json::Value;

/// The old Labs switch in the public settings. The Labs switch was removed: chat is always on, so this key is
/// kept only so old settings files still load. Its saved value is never read.
pub const LABS_KEY: &str = "acp_chat_enabled";

/// Chat is always on. Whatever the saved `acp_chat_enabled` says (an old profile may hold `false`), the answer is
/// `true`. The value is ignored, so a stale off cannot block chat.
pub fn labs_on(_public: &Value) -> bool {
    true
}

/// Called with the public settings whenever they change (and once at startup from the saved file).
pub fn apply_settings(public: &Value) {
    chat::default_model::note_settings(public);
    chat::helper_answers::apply_settings(public);
    sweep_leftovers_once();
}

/// At the first settings load of a run: tool servers an earlier run left behind in an agent's shared server are ended
/// (`leak::sweep_stale`; only ours, proven by the marker). In the background: it reads the process list.
fn sweep_leftovers_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if cfg!(test) {
            return;
        }
        std::thread::spawn(|| {
            let images = leak::all_shared_images();
            if !images.is_empty() {
                leak::sweep_stale(&images);
            }
        });
    });
}

/// Whether chat is on. Always true: the Labs switch was removed.
pub fn chat_enabled() -> bool {
    true
}

#[cfg(test)]
mod labs_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_stays_on_even_when_a_saved_profile_says_off() {
        assert!(labs_on(&json!({})), "on by default");
        assert!(labs_on(&json!({"acp_chat_enabled": true})));
        assert!(labs_on(&json!({"acp_chat_enabled": false})), "a stale saved off does not block chat");
        assert!(labs_on(&json!({"acp_chat_enabled": "yes"})));
        assert!(labs_on(&json!({"acp_chat_enabled": null})));
        assert!(chat_enabled());
    }
}
