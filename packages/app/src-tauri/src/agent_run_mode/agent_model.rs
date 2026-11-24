//! The startup copy of older default-model settings (the rest of this file moved to `pm_core::agent_run_mode::agent_model`).

pub use pm_core::agent_run_mode::agent_model::*;

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
