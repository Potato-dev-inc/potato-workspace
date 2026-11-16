//! In-memory public settings mirror for the HTTP bridge (synced from desktop).

#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;

/// The Labs switches a development build shows as on (see `dev_labs_override_active`). `pane_mcp_enabled` is not
/// one of them: it is on by default and lives in Settings › Agents.
pub const DEV_LABS_KEYS: &[&str] = &[
    "missions_enabled",
    "night_shift_enabled",
    "acp_chat_enabled",
    "model_bridge_enabled",
    "spaces_enabled",
    "lend_enabled",
    "devices_enabled",
    "account_enabled",
    "desktop_pet_enabled",
    "agent_browser_enabled",
    "companion_vault_enabled",
    "discord_bot_enabled",
    "project_guide_enabled",
    "markup_bar_enabled",
    "timeline_day_enabled",
    "smaller_updates_enabled",
    "crews_enabled",
];

/// Tests turn the override on through this; it is off in every test unless a test sets it.
#[cfg(test)]
pub(crate) static TEST_DEV_LABS: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
fn debug_build_allows_override() -> bool {
    TEST_DEV_LABS.load(Ordering::SeqCst)
}

#[cfg(not(test))]
fn debug_build_allows_override() -> bool {
    true
}

/// The rule for the development override, in one place: a debug build, not switched off by `PM_DEV_LABS=0`,
/// and allowed by the build (always, except under `cargo test`, where a test must turn it on).
pub fn dev_labs_gate(debug_build: bool, env: Option<&str>, build_allows: bool) -> bool {
    debug_build && env != Some("0") && build_allows
}

/// Whether every Labs switch reads as on: a debug build (`npm run dev`, the e2e build) unless `PM_DEV_LABS=0`.
/// A release build is never affected. Applied at read time only: `settings.json` is never written with it.
pub fn dev_labs_override_active() -> bool {
    dev_labs_gate(cfg!(debug_assertions), std::env::var("PM_DEV_LABS").ok().as_deref(), debug_build_allows_override())
}

/// The settings the app acts on: `stored` with every Labs switch on when `active`. Pure; `stored` is not changed.
pub fn with_dev_labs(stored: &Value, active: bool) -> Value {
    let mut out = stored.clone();
    if active {
        if let Some(obj) = out.as_object_mut() {
            for key in DEV_LABS_KEYS {
                obj.insert((*key).to_string(), Value::Bool(true));
            }
        }
    }
    out
}

const PATCHABLE_KEYS: &[&str] = &[
    "opencode_model_provider",
    "opencode_model_id",
    "mobile_input_delay_ms",
    "mobile_input_visible",
    "mobile_keyboard_resizes_agent",
    "developer_use_rust_mcp",
    "librarian_indexer_path",
    "confirm_close_running_pane",
    "checkpoints_enabled",
    "checkpoints_keep",
    "away_minutes",
    "budget_default_turns",
    "budget_default_minutes",
    "right_size_suggest",
    "agent_hooks_mode",
    "agent_hooks_agents",
    "pane_mcp_enabled",
    "missions_enabled",
    "night_shift_enabled",
    "acp_chat_enabled",
    "show_terminals",
    "model_bridge_enabled",
    "spaces_enabled",
    "handoff_mode",
    "handoff_fixed_notes",
    "lend_enabled",
    "devices_enabled",
    "account_enabled",
    "desktop_pet_enabled",
    "agent_browser_enabled",
    "companion_vault_enabled",
    "discord_bot_enabled",
    "project_guide_enabled",
    "markup_bar_enabled",
    "timeline_day_enabled",
    "desktop_pet_size",
    "desktop_pet_quiet",
    "desktop_pet_hidden_until_ms",
    "keep_awake_while_working",
    "helper_answers_enabled",
    "helper_default_models",
    "agent_default_models",
    "early_versions_enabled",
    "smaller_updates_enabled",
    "crews_enabled",
    "app_only_failed_for",
];

pub fn default_public_settings() -> Value {
    json!({
        "opencode_model_provider": null,
        "opencode_model_id": null,
        "mobile_input_delay_ms": 60,
        "mobile_input_visible": true,
        "mobile_keyboard_resizes_agent": false,
        "developer_use_rust_mcp": false,
        "librarian_indexer_path": null,
        "confirm_close_running_pane": true,
        "checkpoints_enabled": true,
        "checkpoints_keep": 50,
        "away_minutes": 5,
        // Budgets: 0 = off, which is today's behaviour.
        "budget_default_turns": 0,
        "budget_default_minutes": 0,
        "right_size_suggest": true,
        // Hook Lane (founder decision 2026-10-14): watch-only hooks for agents that declare them.
        "agent_hooks_mode": "shadow",
        "agent_hooks_agents": {},
        // Potato Workspace's helper tools ready inside every agent pane (on unless the person turns it off).
        "pane_mcp_enabled": true,
        // Missions (Preview): off until the person turns them on in Settings › General › Labs.
        "missions_enabled": false,
        // Night Shift (Labs): hours of unattended work, so off until the person turns it on.
        "night_shift_enabled": false,
        // Chat over the Agent Client Protocol. Always on: the Labs switch was removed and Rust ignores this key
        // (kept so old settings files still load). Rust: acp.
        "acp_chat_enabled": true,
        // Terminals (Settings > General): off = every agent starts as a chat and terminal-only controls are hidden; open
        // terminals keep working. Off for new and existing profiles. Rust: show_terminals.
        "show_terminals": false,
        // Model Bridge (Labs): plug a model service into an app such as Codex. Off until chosen. Rust: model_bridge.
        "model_bridge_enabled": false,
        // Spaces (Labs): small-group chat between people's own computers. Off until chosen. Rust: spaces.
        "spaces_enabled": false,
        // What the Hand off button does (Settings > Agents): "file" saves HANDOFF.md, "new_agent" opens a fresh agent that says Ready.
        "handoff_mode": "new_agent",
        // Text added to every handoff under "Always remember".
        "handoff_fixed_notes": "",
        // Share an agent (Labs): lend an agent sign-in to another PC through this one. Off until chosen. Rust: capacity_proxy.
        "lend_enabled": false,
        "devices_enabled": false,
        // Potato account (Labs): one sign-in lists your devices on each other. Off until chosen. Rust: account.
        "account_enabled": false,
        // Desktop Potato (Labs): a small pet window on the desktop. Off until chosen. Rust: pet.
        "desktop_pet_enabled": false,
        // Agent browser (Labs): agents open, read and click pages on this computer, in the Point and Fix preview window. Off until chosen. Rust: browser.
        "agent_browser_enabled": false,
        // Companion memory and mood (Labs): journal, diary and mood for each companion. Off until chosen.
        "companion_vault_enabled": false,
        // Discord bot (Labs): a companion answers in the Discord channels the person lists, with their own bot. Off until chosen.
        "discord_bot_enabled": false,
        // Project guide (Labs): the person's agent writes a short guide to a project, only when asked. Off until chosen. Rust: project_guide.
        "project_guide_enabled": false,
        // Mark up pages (Labs): the floating bar on a page an agent made, and "Open in agent browser". Off until chosen. Rust: markup.
        "markup_bar_enabled": false,
        // The Today page (Labs): one line for the whole day with a way back to any point on it. Off until chosen. Rust: timeline.
        "timeline_day_enabled": false,
        "desktop_pet_size": "medium",
        "desktop_pet_quiet": false,
        "desktop_pet_hidden_until_ms": 0,
        // Keep the PC awake (the screen may still turn off) while an agent works, so locking with Win+L does not stop it.
        "keep_awake_while_working": true,
        // The agent that started a helper may answer its safe questions (allow once, any no). Rust: acp::chat::helper_answers.
        "helper_answers_enabled": true,
        // Settings > Agents > Helper agents: the model a helper runs on per agent id when the request names none.
        "helper_default_models": {},
        // Settings > Agents: the model each agent starts on when nothing names one (agent id -> model id).
        "agent_default_models": {},
        // Get early versions (beta): the updater also reads the beta address and takes the newer. Off until chosen; not a Labs flag.
        "early_versions_enabled": false,
        // Smaller updates (Labs): an update may take the app-only package and leave the built-in tools alone. Off until chosen. Rust: commands/update_plan.
        "smaller_updates_enabled": false,
        // Crews (Labs): shows saved crews, read-only, and lets the command line check a crew file. Off until chosen. Rust: crews.
        "crews_enabled": false,
        // The version whose small update failed; it takes the full package from then on. Written by the app, empty when none.
        "app_only_failed_for": "",
    })
}

pub fn merge_public_settings(base: &Value, patch: &Value) -> Value {
    let mut merged = default_public_settings();
    if let Some(obj) = base.as_object() {
        if let Some(target) = merged.as_object_mut() {
            for (key, value) in obj {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(obj) = patch.as_object() {
        if let Some(target) = merged.as_object_mut() {
            for key in PATCHABLE_KEYS {
                if let Some(value) = obj.get(*key) {
                    if value.is_null() {
                        // Merge-patch rule: null removes the key, so the mirror falls back to its default.
                        let default = default_public_settings().get(*key).cloned().unwrap_or(Value::Null);
                        target.insert((*key).to_string(), default);
                    } else {
                        target.insert((*key).to_string(), value.clone());
                    }
                }
            }
        }
    }
    merged
}

/// The public settings as stored (the mirror), without the development override. Only the code that saves or
/// mirrors settings reads this; everything that acts on a setting reads `read_public_settings`.
fn stored_public_settings(app: &AppHandle) -> Value {
    app.try_state::<AppState>()
        .map(|state| state.public_settings.lock().clone())
        .unwrap_or_else(default_public_settings)
}

/// The effective public settings: the stored mirror with the development Labs override applied (if active).
pub fn read_public_settings(app: &AppHandle) -> Value {
    with_dev_labs(&stored_public_settings(app), dev_labs_override_active())
}

/// What the CLI may list and set: every patchable key with its type, default, saved value and the value the app
/// acts on, the Labs keys, and the keys a patch never writes. Pure; `stored` and `effective` come from the mirror.
pub fn catalog_from(stored: &Value, effective: &Value, override_active: bool) -> Value {
    let defaults = default_public_settings();
    let settings: Vec<Value> = PATCHABLE_KEYS
        .iter()
        .map(|key| {
            let default = defaults.get(*key).cloned().unwrap_or(Value::Null);
            let kind = match &default {
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Object(_) => "object",
                Value::Array(_) => "array",
                Value::Null => "any",
            };
            json!({
                "key": key,
                "type": kind,
                "default": default,
                "saved": stored.get(*key).cloned().unwrap_or(Value::Null),
                "effective": effective.get(*key).cloned().unwrap_or(Value::Null),
                "labs": DEV_LABS_KEYS.contains(key),
            })
        })
        .collect();
    let mut refused: Vec<&str> = crate::settings_patch::OWNED_ELSEWHERE.to_vec();
    refused.extend_from_slice(crate::settings_patch::SECRET_KEYS);
    json!({
        "settings": settings,
        "labs": DEV_LABS_KEYS,
        "dev_labs_override": override_active,
        "refused": refused,
    })
}

/// `GET /settings/catalog`.
pub fn read_catalog(app: &AppHandle) -> Value {
    let stored = stored_public_settings(app);
    let active = dev_labs_override_active();
    let effective = with_dev_labs(&stored, active);
    catalog_from(&stored, &effective, active)
}

/// Tells the bridge SSE and each Labs owner the settings. Always called with the effective settings, so the
/// override reaches every subsystem.
fn apply_public_settings(effective: &Value) {
    crate::bridge::push_settings_sse(effective);
    crate::agent_hooks::apply_settings(effective);
    crate::pane_mcp::apply_settings(effective);
    crate::acp::apply_settings(effective);
    crate::show_terminals::apply_settings(effective);
    crate::model_bridge::apply_settings(effective);
    crate::spaces::runtime::apply_settings(effective);
    crate::capacity_proxy::apply_settings(effective);
    crate::device_link::app::apply_settings(effective);
    crate::keep_awake::apply_settings(effective);
    crate::pet::apply_settings(effective);
    crate::discord_bot::apply_settings(effective);
}

/// Merge `patch` into the public mirror (bridge state + mobile SSE) without any window event.
/// `settings_patch` uses this and emits its own `settings://changed`. Returns the effective settings.
pub fn mirror_public_patch(app: &AppHandle, patch: &Value) -> Value {
    // Read, merge and store under one lock so two patches cannot lose each other's keys.
    let merged = match app.try_state::<AppState>() {
        Some(state) => {
            let mut guard = state.public_settings.lock();
            let merged = merge_public_settings(&guard, patch);
            *guard = merged.clone();
            merged
        }
        None => merge_public_settings(&default_public_settings(), patch),
    };
    let effective = with_dev_labs(&merged, dev_labs_override_active());
    apply_public_settings(&effective);

    effective
}

pub fn patch_public_settings(app: &AppHandle, patch: Value) -> Value {
    let merged = mirror_public_patch(app, &patch);
    let _ = app.emit("settings://apply", patch);
    let _ = app.emit("settings://changed", merged.clone());
    merged
}

/// Public settings as saved in `settings.json` (`{"settings": {...}}`, written by the frontend
/// store plugin). Panes-first has no main window to push them at startup, so Rust loads them.
pub fn public_settings_from_store_file(file: &Value) -> Value {
    let patch = file.get("settings").cloned().unwrap_or(Value::Null);
    let cleaned: serde_json::Map<String, Value> = patch
        .as_object()
        .map(|o| o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    merge_public_settings(&default_public_settings(), &Value::Object(cleaned))
}

/// Load the saved public settings into `AppState` (no-op when the file is missing or unreadable).
pub fn load_saved_public_settings(app: &AppHandle) {
    let path = crate::app_paths::app_data_dir().join("settings.json");
    // A good file gets its backup; a damaged one is kept aside and the page offers "Restore the last good settings".
    crate::settings_safety::check_on_start(&path, std::time::SystemTime::now());
    let Some(file) = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return;
    };
    let merged = public_settings_from_store_file(&file);
    if let Some(state) = app.try_state::<AppState>() {
        *state.public_settings.lock() = merged.clone();
    }
    // The search index's switch is not in the public mirror (desktop-only setting): read it from the file.
    crate::chat_index::apply_setting(file.get("settings").unwrap_or(&Value::Null));
    apply_public_settings(&with_dev_labs(&merged, dev_labs_override_active()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_settings_override_defaults_and_ignore_unknown_or_null_keys() {
        let file = json!({"settings": {
            "mobile_input_delay_ms": 400, "opencode_model_id": null,
            "api_key": "secret", "pane_window_position": {"x": 1, "y": 2}
        }});
        let out = public_settings_from_store_file(&file);
        assert_eq!(out["mobile_input_delay_ms"], 400);
        assert_eq!(out["mobile_keyboard_resizes_agent"], false);
        assert!(out.get("api_key").is_none() && out.get("pane_window_position").is_none());
        assert_eq!(public_settings_from_store_file(&json!({})), default_public_settings());
    }

    #[test]
    fn a_settings_file_from_before_the_orchestrator_was_removed_still_loads() {
        // These keys were settings once. An old file still carries them; they are ignored, nothing else changes.
        let file = json!({"settings": {
            "orchestrator_backend": "claude_cli", "default_provider": "openrouter", "default_model": "m1",
            "custom_models": [{"id": "x"}], "mobile_input_delay_ms": 400
        }});
        let out = public_settings_from_store_file(&file);
        assert_eq!(out["mobile_input_delay_ms"], 400);
        for gone in ["orchestrator_backend", "default_provider", "default_model", "custom_models"] {
            assert!(out.get(gone).is_none(), "{gone} is no longer a public setting");
        }
        let patched = merge_public_settings(&out, &json!({"default_model": "m2"}));
        assert!(patched.get("default_model").is_none(), "a patch cannot bring a removed key back");
    }

    #[test]
    fn a_null_in_a_patch_resets_the_mirror_key_to_its_default() {
        let base = json!({"away_minutes": 30, "mobile_input_delay_ms": 100});
        let out = merge_public_settings(&base, &json!({"away_minutes": null, "mobile_input_delay_ms": 200}));
        assert_eq!(out["away_minutes"], 5, "null removes the key, so the default shows");
        assert_eq!(out["mobile_input_delay_ms"], 200);
        assert_eq!(default_public_settings()["mobile_input_delay_ms"], 60);
    }

    #[test]
    fn chat_is_on_by_default_and_a_saved_off_stays_off() {
        assert_eq!(default_public_settings()["acp_chat_enabled"], true);
        // A profile that never touched the switch (no key in its file) gets Chat.
        let untouched = public_settings_from_store_file(&json!({"settings": {"theme": "dark"}}));
        assert_eq!(untouched["acp_chat_enabled"], true);
        // The Labs switch is gone: a profile saved with it off still gets chat (the saved value is ignored).
        let off = public_settings_from_store_file(&json!({"settings": {"acp_chat_enabled": false}}));
        assert_eq!(off["acp_chat_enabled"], false, "the old key still loads");
        assert!(crate::acp::labs_on(&off), "chat stays on");
        assert!(crate::acp::chat_enabled());
        assert!(crate::acp::labs_on(&untouched));
    }

    #[test]
    fn night_shift_is_off_by_default_and_the_person_can_turn_it_on() {
        let defaults = default_public_settings();
        assert_eq!(defaults["night_shift_enabled"], false);
        assert_eq!(defaults["missions_enabled"], false);
        let on = merge_public_settings(&defaults, &json!({"night_shift_enabled": true}));
        assert_eq!(on["night_shift_enabled"], true);
        // The switch is its own: the missions switch does not turn it on.
        let missions_only = merge_public_settings(&defaults, &json!({"missions_enabled": true}));
        assert_eq!(missions_only["night_shift_enabled"], false);
        let from_file = public_settings_from_store_file(&json!({"settings": {"night_shift_enabled": true}}));
        assert_eq!(from_file["night_shift_enabled"], true);
    }

    #[test]
    fn hand_off_mode_defaults_to_a_new_agent_has_no_notes_and_can_be_patched() {
        let defaults = default_public_settings();
        assert_eq!(defaults["handoff_mode"], "new_agent");
        assert_eq!(defaults["handoff_fixed_notes"], "");
        assert!(PATCHABLE_KEYS.contains(&"handoff_mode") && PATCHABLE_KEYS.contains(&"handoff_fixed_notes"));
        let on = merge_public_settings(&defaults, &json!({"handoff_mode": "file", "handoff_fixed_notes": "Be brief."}));
        assert_eq!(on["handoff_mode"], "file");
        assert_eq!(on["handoff_fixed_notes"], "Be brief.");
        // Not a Labs switch: a development build does not turn it on.
        assert_eq!(with_dev_labs(&defaults, true)["handoff_mode"], "new_agent");
    }

    #[test]
    fn catalog_lists_every_patchable_and_labs_key_and_no_secret() {
        let stored = default_public_settings();
        let effective = with_dev_labs(&stored, true);
        let catalog = catalog_from(&stored, &effective, true);
        let keys: Vec<&str> = catalog["settings"].as_array().unwrap().iter().map(|e| e["key"].as_str().unwrap()).collect();
        for key in PATCHABLE_KEYS {
            assert!(keys.contains(key), "{key} missing");
        }
        for key in crate::settings_patch::SECRET_KEYS {
            assert!(!keys.contains(key), "{key} must not be listed");
        }
        assert!(!keys.contains(&"ui_mode"));
        assert_eq!(catalog["labs"].as_array().unwrap().len(), DEV_LABS_KEYS.len());
        assert_eq!(catalog["dev_labs_override"], true);
        let lend = catalog["settings"].as_array().unwrap().iter().find(|e| e["key"] == "lend_enabled").unwrap();
        // Saved says off, in effect says on: the override must not look like a saved value.
        assert_eq!(lend["saved"], false);
        assert_eq!(lend["effective"], true);
        assert_eq!(lend["labs"], true);
        assert_eq!(lend["type"], "boolean");
        assert!(catalog["refused"].as_array().unwrap().iter().any(|k| k == "ui_mode"));
    }

    #[test]
    fn dev_override_turns_every_labs_switch_on_and_nothing_else() {
        let stored = default_public_settings();
        let effective = with_dev_labs(&stored, true);
        for key in DEV_LABS_KEYS {
            assert_eq!(effective[*key], true, "{key} should read as on");
        }
        // Not a Labs switch: unchanged (on by default, Settings › Agents).
        assert_eq!(effective["pane_mcp_enabled"], true);
        assert_eq!(effective["checkpoints_enabled"], stored["checkpoints_enabled"]);
        assert_eq!(effective["mobile_input_delay_ms"], stored["mobile_input_delay_ms"]);
        // Inactive: the stored value passes through untouched.
        assert_eq!(with_dev_labs(&stored, false), stored);
        assert_eq!(with_dev_labs(&stored, false)["night_shift_enabled"], false);
    }

    #[test]
    fn dev_override_never_changes_the_stored_file() {
        let file = json!({"settings": {"night_shift_enabled": false, "missions_enabled": false}});
        let before = file.clone();
        let stored = public_settings_from_store_file(&file);
        let effective = with_dev_labs(&stored, true);
        assert_eq!(effective["night_shift_enabled"], true);
        assert_eq!(effective["missions_enabled"], true);
        // The mirror (what is saved) and the file are as they were.
        assert_eq!(stored["night_shift_enabled"], false);
        assert_eq!(stored["missions_enabled"], false);
        assert_eq!(file, before);
    }

    #[test]
    fn dev_gate_is_on_only_in_a_debug_build_unless_pm_dev_labs_is_zero() {
        // A debug build with no switch-off: on.
        assert!(dev_labs_gate(true, None, true));
        assert!(dev_labs_gate(true, Some("1"), true));
        assert!(dev_labs_gate(true, Some(""), true));
        // PM_DEV_LABS=0 turns it off.
        assert!(!dev_labs_gate(true, Some("0"), true));
        // A release build is never affected, whatever the variable says.
        assert!(!dev_labs_gate(false, None, true));
        assert!(!dev_labs_gate(false, Some("1"), true));
        // Under cargo test the build itself must allow it (tests are off by default).
        assert!(!dev_labs_gate(true, None, false));
    }

    #[test]
    fn dev_override_is_off_in_tests_until_a_test_turns_it_on() {
        assert!(!dev_labs_override_active(), "tests start with every Labs flag as stored");
        TEST_DEV_LABS.store(true, Ordering::SeqCst);
        let on = dev_labs_override_active();
        TEST_DEV_LABS.store(false, Ordering::SeqCst);
        assert_eq!(on, std::env::var("PM_DEV_LABS").ok().as_deref() != Some("0"));
        assert!(!dev_labs_override_active());
    }

    #[test]
    fn model_bridge_labs_switch_is_off_by_default_patchable_and_on_in_dev_builds() {
        assert!(DEV_LABS_KEYS.contains(&"model_bridge_enabled"));
        assert!(PATCHABLE_KEYS.contains(&"model_bridge_enabled"));
        assert_eq!(default_public_settings()["model_bridge_enabled"], json!(false));
        assert_eq!(with_dev_labs(&default_public_settings(), true)["model_bridge_enabled"], json!(true));
    }
}

#[cfg(test)]
mod spaces_labs_tests {
    use super::{default_public_settings, DEV_LABS_KEYS, PATCHABLE_KEYS};

    #[test]
    fn dev_labs_keys_include_spaces_enabled() {
        assert!(DEV_LABS_KEYS.contains(&"spaces_enabled"));
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "spaces_enabled").count(), 1);
    }

    #[test]
    fn desktop_pet_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "desktop_pet_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"desktop_pet_enabled"));
        assert_eq!(default_public_settings()["desktop_pet_enabled"], serde_json::json!(false));
    }

    #[test]
    fn companion_vault_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "companion_vault_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"companion_vault_enabled"));
        assert_eq!(default_public_settings()["companion_vault_enabled"], serde_json::json!(false));
    }

    #[test]
    fn discord_bot_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "discord_bot_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"discord_bot_enabled"));
        assert_eq!(default_public_settings()["discord_bot_enabled"], serde_json::json!(false));
    }

    #[test]
    fn the_today_page_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "timeline_day_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"timeline_day_enabled"));
        assert_eq!(default_public_settings()["timeline_day_enabled"], serde_json::json!(false));
    }

    #[test]
    fn project_guide_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "project_guide_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"project_guide_enabled"));
        assert_eq!(default_public_settings()["project_guide_enabled"], serde_json::json!(false));
        assert_eq!(crate::project_guide::LABS_KEY, "project_guide_enabled");
    }

    #[test]
    fn agent_browser_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "agent_browser_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"agent_browser_enabled"));
        assert_eq!(default_public_settings()["agent_browser_enabled"], serde_json::json!(false));
        // The route reads the same key the Labs switch writes.
        assert_eq!(crate::browser::live::LABS_KEY, "agent_browser_enabled");
    }

    #[test]
    fn markup_bar_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "markup_bar_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"markup_bar_enabled"));
        assert_eq!(default_public_settings()["markup_bar_enabled"], serde_json::json!(false));
    }

    #[test]
    fn lend_enabled_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "lend_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"lend_enabled"));
        assert_eq!(default_public_settings()["lend_enabled"], serde_json::json!(false));
    }

    #[test]
    fn spaces_enabled_is_patchable_and_off_by_default() {
        assert!(PATCHABLE_KEYS.contains(&"spaces_enabled"));
        assert_eq!(default_public_settings()["spaces_enabled"], serde_json::json!(false));
    }
}

#[cfg(test)]
mod early_versions_tests {
    use super::{default_public_settings, merge_public_settings, with_dev_labs, DEV_LABS_KEYS, PATCHABLE_KEYS};
    use serde_json::json;

    #[test]
    fn early_versions_start_off_can_be_patched_and_is_not_a_labs_flag() {
        assert_eq!(default_public_settings()["early_versions_enabled"], json!(false));
        assert!(PATCHABLE_KEYS.contains(&"early_versions_enabled"));
        // A development build must not move itself onto the beta address.
        assert!(!DEV_LABS_KEYS.contains(&"early_versions_enabled"));
        assert_eq!(with_dev_labs(&default_public_settings(), true)["early_versions_enabled"], json!(false));
        let on = merge_public_settings(&default_public_settings(), &json!({"early_versions_enabled": true}));
        assert!(crate::commands::update_channel::early_versions_on(&on));
    }

    #[test]
    fn crews_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == "crews_enabled").count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"crews_enabled"));
        assert_eq!(default_public_settings()["crews_enabled"], json!(false));
        assert_eq!(with_dev_labs(&default_public_settings(), true)["crews_enabled"], json!(true));
    }

    #[test]
    fn smaller_updates_is_a_dev_labs_key_patchable_and_off_by_default() {
        assert_eq!(DEV_LABS_KEYS.iter().filter(|k| **k == crate::commands::update_plan::SETTING_KEY).count(), 1);
        assert!(PATCHABLE_KEYS.contains(&"smaller_updates_enabled") && PATCHABLE_KEYS.contains(&"app_only_failed_for"));
        assert_eq!(default_public_settings()["smaller_updates_enabled"], json!(false));
        assert_eq!(default_public_settings()["app_only_failed_for"], json!(""));
        assert_eq!(with_dev_labs(&default_public_settings(), true)["smaller_updates_enabled"], json!(true));
        let failed = merge_public_settings(&default_public_settings(), &json!({"app_only_failed_for": "1.2.1"}));
        assert_eq!(failed["app_only_failed_for"], json!("1.2.1"));
    }
}

#[cfg(test)]
mod helper_default_models_tests {
    use super::{default_public_settings, merge_public_settings, PATCHABLE_KEYS};
    use serde_json::json;

    #[test]
    fn helper_default_models_start_empty_and_old_settings_load_with_that() {
        assert!(PATCHABLE_KEYS.contains(&"helper_default_models"));
        assert_eq!(default_public_settings()["helper_default_models"], json!({}));
        let merged = merge_public_settings(&json!({ "orchestrator_backend": "api" }), &json!({}));
        assert_eq!(merged["helper_default_models"], json!({}));
    }

    #[test]
    fn a_saved_map_is_kept() {
        let merged = merge_public_settings(&json!({}), &json!({ "helper_default_models": { "claude": "sonnet" } }));
        assert_eq!(merged["helper_default_models"]["claude"], json!("sonnet"));
    }
}

#[cfg(test)]
mod agent_default_models_tests {
    use super::{default_public_settings, merge_public_settings, PATCHABLE_KEYS};
    use serde_json::json;

    #[test]
    fn agent_default_models_start_empty_are_patchable_and_old_settings_load_with_that() {
        assert!(PATCHABLE_KEYS.contains(&"agent_default_models"));
        assert_eq!(default_public_settings()["agent_default_models"], json!({}));
        assert_eq!(merge_public_settings(&json!({ "orchestrator_backend": "api" }), &json!({}))["agent_default_models"], json!({}));
        let merged = merge_public_settings(&json!({}), &json!({ "agent_default_models": { "claude": "sonnet" } }));
        assert_eq!(merged["agent_default_models"]["claude"], json!("sonnet"));
    }
}
