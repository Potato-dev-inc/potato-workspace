//! The chat engine's transport and small types (stage 3 of the engine move, see `DECISIONS-p7.md`): the JSON-RPC
//! wire, the write queue, the stderr ring, the connection and its containment. The app re-exports each module under
//! its old path (`crate::acp::conn`, ...). Later stages add the rest of `acp/` here.

pub mod account;
pub mod adapter_catalog;
pub mod adapter_health;
pub mod adapter_keys;
pub mod adapter_overlay;
pub mod agent_python;
pub mod ask_facts;
pub mod auto_approve;
pub mod bridge;
pub mod chat;
pub mod journal;
pub mod config;
pub mod closed;
pub mod conn;
pub mod conversations;
pub mod error;
pub mod handover;
pub mod handshake;
pub mod install;
pub mod install_archive;
pub mod install_registry;
pub mod job;
pub mod lane;
pub mod launch;
pub mod leak;
pub mod memory;
pub mod overlay;
pub mod pin;
pub mod record;
pub mod registry;
pub mod ring;
pub mod session;
pub mod state;
pub mod supervisor;
pub mod timers;
pub mod types;
pub mod warm;
pub mod wire;
pub mod write_queue;
pub mod writers;

#[cfg(any(test, feature = "test-util"))]
pub mod fake_agent;
#[cfg(test)]
mod adapter_health_tests;
#[cfg(test)]
mod adapter_key_tests;
#[cfg(test)]
mod conversation_tests;
#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod hardening_tests;
#[cfg(test)]
mod speedup_tests;
#[cfg(test)]
mod warm_helper_tests;
#[cfg(test)]
mod warm_tests;
#[cfg(test)]
mod tests;

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
        if cfg!(any(test, feature = "test-util")) {
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
