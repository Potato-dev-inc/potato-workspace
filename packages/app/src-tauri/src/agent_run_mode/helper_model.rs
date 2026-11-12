//! "Default model for helpers" (Settings > Agents > Helper agents): the model a helper runs on when the agent that
//! started it named none. Stored as `helper_default_models` (agent id -> model) in the public settings.

use serde_json::Value;

/// The sentence the result and receipt carry when the model came from the setting.
pub const HELPER_MODEL_NOTE: &str = "model: this agent's default model from the person's settings (Settings > Agents); the request named no model.";

/// The saved helper default for `agent_id`, if any. A blank value, a non-text value, or a missing map means none.
pub fn helper_default_for(settings: &Value, agent_id: &str) -> Option<String> {
    saved_model(settings, "helper_default_models", agent_id)
}

/// The saved model for `agent_id` in the settings map `key` (agent id -> model id), matched without regard to case.
/// A blank value, a non-text value, a flag lookalike, or a missing map means none.
pub(super) fn saved_model(settings: &Value, key: &str, agent_id: &str) -> Option<String> {
    let wanted = agent_id.trim();
    settings
        .get(key)?
        .as_object()?
        .iter()
        .find(|(id, _)| id.trim().eq_ignore_ascii_case(wanted))
        .and_then(|(_, value)| value.as_str())
        .map(str::trim)
        .filter(|model| !model.is_empty() && !model.starts_with('-'))
        .map(str::to_string)
}

/// Fills `model` from the helper default when the request named none. True when it did. A named model is never touched.
pub fn apply_helper_model(settings: &Value, agent_id: &str, model: &mut Option<String>) -> bool {
    if model.as_deref().is_some_and(|m| !m.trim().is_empty()) {
        return false;
    }
    match helper_default_for(settings, agent_id) {
        Some(default) => {
            *model = Some(default);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> Value {
        json!({ "helper_default_models": { "Claude": " sonnet ", "codex": "", "cursor": 5 } })
    }

    #[test]
    fn a_request_without_a_model_takes_the_agents_default() {
        let mut model = None;
        assert!(apply_helper_model(&settings(), "claude", &mut model));
        assert_eq!(model.as_deref(), Some("sonnet"));
        let mut blank = Some("  ".to_string());
        assert!(apply_helper_model(&settings(), "claude", &mut blank));
        assert_eq!(blank.as_deref(), Some("sonnet"));
    }

    #[test]
    fn a_model_in_the_request_wins() {
        let mut model = Some("opus".to_string());
        assert!(!apply_helper_model(&settings(), "claude", &mut model));
        assert_eq!(model.as_deref(), Some("opus"));
    }

    #[test]
    fn no_default_blank_or_odd_values_and_old_settings_change_nothing() {
        for agent in ["codex", "cursor", "opencode"] {
            let mut model = None;
            assert!(!apply_helper_model(&settings(), agent, &mut model));
            assert!(model.is_none());
        }
        let mut model = None;
        assert!(!apply_helper_model(&json!({ "orchestrator_backend": "api" }), "claude", &mut model));
        assert!(!apply_helper_model(&json!({ "helper_default_models": [] }), "claude", &mut model));
        assert!(model.is_none());
    }
}
