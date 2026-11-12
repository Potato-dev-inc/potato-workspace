//! "Default model" per agent (Settings > Agents): the model an agent starts on when nothing named one. Stored as
//! `agent_default_models` (agent id -> model id) in the public settings. Works for every agent that has models; which
//! agents those are comes from their definitions, never from a name here.
//!
//! Order everywhere: the request's model, then the helper default (helpers only), then this default, then the last pick
//! on the New agent page (the page only), then the agent's own default.

use serde_json::{json, Value};

use super::helper_model::saved_model;

/// The key in the public settings.
pub const AGENT_DEFAULT_MODELS_KEY: &str = "agent_default_models";

/// The saved default model for `agent_id`, if any (case-insensitive id match).
pub fn agent_default_for(settings: &Value, agent_id: &str) -> Option<String> {
    saved_model(settings, AGENT_DEFAULT_MODELS_KEY, agent_id)
}

/// Fills `model` from the agent default when the request named none. True when it did. A named model is never touched.
pub fn apply_agent_default_model(settings: &Value, agent_id: &str, model: &mut Option<String>) -> bool {
    if model.as_deref().is_some_and(|m| !m.trim().is_empty()) {
        return false;
    }
    match agent_default_for(settings, agent_id) {
        Some(default) => {
            *model = Some(default);
            true
        }
        None => false,
    }
}

/// The launch flags a terminal pane of `agent_id` starts on when the caller named no model: `Ok(None)` for no default,
/// or for an agent that takes no model on its command line (`flags_for` says `None`: the default is for its chats
/// only). `Err` carries the warning for a saved default that is stale; the pane then starts on the agent's own default.
/// `listed` is the agent's model list: when it has entries, a default not in it (any case) is stale, and the listed
/// spelling is what goes out. Never fails a start.
pub fn terminal_default_flags(settings: &Value, agent_id: &str, listed: &[String], flags_for: impl Fn(&str) -> Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
    let Some(saved) = agent_default_for(settings, agent_id) else { return Ok(None) };
    let model = if listed.is_empty() {
        saved
    } else {
        match listed.iter().find(|m| m.eq_ignore_ascii_case(&saved)) {
            Some(hit) => hit.clone(),
            None => return Err(format!("Your default model '{saved}' for {agent_id} isn't available any more, so {agent_id} starts on its own default.")),
        }
    };
    Ok(flags_for(&model))
}

/// Copies the older model setting (OpenCode's) into `agent_default_models` once: only when that agent has no entry yet.
/// `composed` is the model as the agent writes it (`provider/model`). Returns the settings patch to save, if any.
pub fn migrate_legacy_default(settings: &Value, agent_id: &str, composed: Option<&str>) -> Option<Value> {
    let composed = composed.map(str::trim).filter(|m| !m.is_empty())?;
    if agent_default_for(settings, agent_id).is_some() {
        return None;
    }
    let mut map = settings.get(AGENT_DEFAULT_MODELS_KEY).and_then(Value::as_object).cloned().unwrap_or_default();
    map.insert(agent_id.to_string(), json!(composed));
    Some(json!({ AGENT_DEFAULT_MODELS_KEY: map }))
}

/// Startup, once per install: every agent whose definition names an older model setting (`[acp.default_model]`) gets
/// that setting copied into `agent_default_models`. A marker file keeps it to once, so clearing the default later sticks.
pub fn migrate_legacy_defaults_once(app: &tauri::AppHandle) {
    let marker = crate::app_paths::app_data_dir().join("agent_default_models.migrated");
    if marker.exists() {
        return;
    }
    let mut settings = crate::settings_store::read_public_settings(app);
    let mut patch = None;
    for cfg in crate::acp::config::builtin_agents() {
        let Some(rule) = &cfg.default_model else { continue };
        let composed = crate::acp::chat::default_model::setting_value(rule, &settings);
        if let Some(next) = migrate_legacy_default(&settings, &cfg.id, composed.as_deref()) {
            settings[AGENT_DEFAULT_MODELS_KEY] = next[AGENT_DEFAULT_MODELS_KEY].clone();
            patch = Some(next);
        }
    }
    if let Some(patch) = patch {
        if let Err(error) = crate::settings_patch::apply(app, &patch) {
            tracing::warn!(%error, "agent default models: could not save the copied model setting");
            return;
        }
    }
    let _ = std::fs::write(marker, "done");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Value {
        json!({ "agent_default_models": { "Claude": " sonnet ", "codex": "", "cursor": 5, "flaggy": "--yolo" } })
    }
    fn flags(model: &str) -> Option<Vec<String>> {
        Some(vec!["--model".into(), model.into()])
    }

    #[test]
    fn the_agent_default_matches_any_case_and_ignores_blank_or_odd_values() {
        assert_eq!(agent_default_for(&settings(), "claude").as_deref(), Some("sonnet"));
        for agent in ["codex", "cursor", "flaggy", "nobody"] {
            assert!(agent_default_for(&settings(), agent).is_none(), "{agent}");
        }
        assert!(agent_default_for(&json!({}), "claude").is_none());
        assert!(agent_default_for(&json!({ "agent_default_models": [] }), "claude").is_none());
    }

    #[test]
    fn a_request_without_a_model_takes_the_agent_default_and_a_named_model_wins() {
        let mut model = None;
        assert!(apply_agent_default_model(&settings(), "claude", &mut model));
        assert_eq!(model.as_deref(), Some("sonnet"));
        let mut named = Some("opus".to_string());
        assert!(!apply_agent_default_model(&settings(), "claude", &mut named));
        assert_eq!(named.as_deref(), Some("opus"));
    }

    #[test]
    fn a_terminal_starts_on_the_default_through_the_agents_flag() {
        assert_eq!(terminal_default_flags(&settings(), "claude", &[], flags), Ok(Some(vec!["--model".into(), "sonnet".into()])));
        assert_eq!(terminal_default_flags(&settings(), "nobody", &[], flags), Ok(None), "no default: the agent's own");
    }

    #[test]
    fn a_terminal_uses_the_listed_spelling_and_drops_a_stale_default_with_a_warning() {
        let listed = vec!["Sonnet".to_string(), "opus".to_string()];
        assert_eq!(terminal_default_flags(&settings(), "claude", &listed, flags), Ok(Some(vec!["--model".into(), "Sonnet".into()])));
        let stale = vec!["opus".to_string()];
        let warning = terminal_default_flags(&settings(), "claude", &stale, flags).unwrap_err();
        assert!(warning.contains("'sonnet'") && warning.contains("own default"), "{warning}");
    }

    #[test]
    fn an_agent_that_takes_no_model_flag_keeps_its_own_default_in_the_terminal() {
        assert_eq!(terminal_default_flags(&settings(), "claude", &[], |_| None), Ok(None));
    }

    #[test]
    fn the_old_opencode_setting_is_copied_once() {
        let patch = migrate_legacy_default(&json!({}), "opencode", Some("go/glm")).unwrap();
        assert_eq!(patch["agent_default_models"]["opencode"], json!("go/glm"));
        let keeps_others = migrate_legacy_default(&json!({ "agent_default_models": { "claude": "sonnet" } }), "opencode", Some("go/glm")).unwrap();
        assert_eq!(keeps_others["agent_default_models"]["claude"], json!("sonnet"));
        let already = json!({ "agent_default_models": { "opencode": "mine" } });
        assert!(migrate_legacy_default(&already, "opencode", Some("go/glm")).is_none(), "an existing choice is never overwritten");
        assert!(migrate_legacy_default(&json!({}), "opencode", Some("  ")).is_none());
        assert!(migrate_legacy_default(&json!({}), "opencode", None).is_none());
    }
}
