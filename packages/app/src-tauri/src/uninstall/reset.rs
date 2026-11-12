//! "Reset settings": every setting goes back to its default. Agents, chats and keys stay.
//!
//! A saved setting that is removed reads as its default, so a reset is one merge patch that sets every
//! saved key to `null` (RFC 7386: `null` removes the key). What stays: the secret keys, `ui_mode`
//! (the settings patch never writes it), and the first-start progress (`onboarding_*`), which is not
//! a preference. Nothing outside `settings.json` is touched.

use serde_json::{Map, Value};

use crate::settings_patch::SECRET_KEYS;

/// Saved keys a reset leaves alone, besides the secret keys.
pub fn is_kept(key: &str) -> bool {
    key == "ui_mode" || key.starts_with("onboarding_") || SECRET_KEYS.contains(&key)
}

/// The patch that resets `current` (the saved `settings` object).
pub fn reset_patch(current: &Value) -> Map<String, Value> {
    current
        .as_object()
        .map(|o| o.keys().filter(|k| !is_kept(k)).map(|k| (k.clone(), Value::Null)).collect())
        .unwrap_or_default()
}

/// Reset the settings file at `path` (tests only: the command goes through the settings store). Returns how many settings went back.
#[cfg(test)]
pub fn reset_file(path: &std::path::Path) -> Result<usize, String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let doc: Value = if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).map_err(|e| format!("settings.json can't be read ({e}); nothing was changed"))? };
    let patch = reset_patch(&doc["settings"]);
    let n = patch.len();
    if n > 0 {
        crate::settings_patch::patch_file(path, &patch)?;
    }
    Ok(n)
}
