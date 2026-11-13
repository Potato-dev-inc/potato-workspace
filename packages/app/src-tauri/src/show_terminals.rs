//! "Show terminals" (Settings > General): off by default. While it is off every place that starts an agent starts a
//! chat, agents that can only run in a terminal are not offered, and the terminal-only controls are hidden. It never
//! closes or stops anything that is already open: this is about what the app OFFERS, not what runs.
//!
//! The switch is a public setting (`show_terminals`). This module keeps the last value for code with no settings in
//! hand (the phone's new-chat route). The webview reads the same key itself (`lib/showTerminals.ts`).

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

/// The key in the public settings.
pub const KEY: &str = "show_terminals";

static SETTING: AtomicBool = AtomicBool::new(false);

/// The switch in a settings value: on only when it is `true`. Absent, null or anything else is off.
pub fn setting_on(public: &Value) -> bool {
    public.get(KEY).and_then(Value::as_bool) == Some(true)
}

/// Called with the effective public settings whenever they change and once at startup.
pub fn apply_settings(public: &Value) {
    SETTING.store(setting_on(public), Ordering::SeqCst);
}

/// Whether terminals are offered: the switch is on, or Chat itself is off (then a chat cannot start, and hiding the
/// terminal would leave nothing to start).
pub fn allowed(setting: bool, chat_on: bool) -> bool {
    setting || !chat_on
}

/// The agents a chat can start for right now, as `(id, label)`: Chat is on, the agent has a chat way to run (its own or the
/// person's overlay), it is not switched off and its add-on is installed.
pub fn chat_agents() -> Vec<(String, String)> {
    if !crate::acp::chat_enabled() {
        return Vec::new();
    }
    let overlay = crate::acp::overlay::OverlayStore::in_app_data();
    let mut all = crate::acp::config::builtin_agents();
    all.extend(crate::acp::overlay::overlay_agents(&overlay));
    all.into_iter()
        .filter(|cfg| !cfg.disabled && !crate::acp::install::is_missing(cfg, &crate::acp::config::RealHost))
        .map(|cfg| (cfg.id, cfg.label))
        .collect()
}

/// Whether `agent` is one of `chat_agents` (any case).
pub fn can_chat(agent: &str) -> bool {
    chat_agents().iter().any(|(id, _)| id.eq_ignore_ascii_case(agent))
}

/// Whether terminals are offered right now.
pub fn shown() -> bool {
    allowed(SETTING.load(Ordering::SeqCst), crate::acp::chat_enabled())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_switch_is_off_unless_it_is_true() {
        assert!(!setting_on(&json!({})));
        assert!(!setting_on(&json!({"show_terminals": null})));
        assert!(!setting_on(&json!({"show_terminals": "yes"})));
        assert!(!setting_on(&json!({"show_terminals": false})));
        assert!(setting_on(&json!({"show_terminals": true})));
    }

    #[test]
    fn it_is_off_for_new_and_existing_profiles() {
        assert_eq!(crate::settings_store::default_public_settings()["show_terminals"], json!(false));
        // A profile saved before the setting existed has no key: off.
        let old = crate::settings_store::public_settings_from_store_file(&json!({"settings": {"theme": "dark", "acp_chat_enabled": true}}));
        assert_eq!(old["show_terminals"], json!(false));
        assert!(!setting_on(&old));
        let on = crate::settings_store::public_settings_from_store_file(&json!({"settings": {"show_terminals": true}}));
        assert!(setting_on(&on));
    }

    #[test]
    fn the_switch_can_be_patched_like_any_public_setting() {
        let defaults = crate::settings_store::default_public_settings();
        let on = crate::settings_store::merge_public_settings(&defaults, &json!({"show_terminals": true}));
        assert!(setting_on(&on));
        let off = crate::settings_store::merge_public_settings(&on, &json!({"show_terminals": false}));
        assert!(!setting_on(&off));
    }

    #[test]
    fn terminals_stay_when_chat_cannot_start() {
        assert!(!allowed(false, true), "off + chat on: hidden");
        assert!(allowed(true, true), "on: shown");
        assert!(allowed(false, false), "chat is off: a terminal is the only way, so it stays");
        assert!(allowed(true, false));
    }
}
