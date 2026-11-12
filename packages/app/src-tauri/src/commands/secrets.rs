//! Tauri commands for provider API keys kept in the OS credential store. See `crate::secrets`.

use crate::secrets::{self, SecretMask};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SecretStorageInfo {
    /// True when keys can be kept in the OS credential store.
    pub secure: bool,
    /// Where they are kept, in plain words.
    pub label: String,
}

/// Set, read masked and delete: the provider keys and the custom AI service key.
fn guard(name: &str) -> Result<(), String> {
    if secrets::is_ui_secret(name) {
        Ok(())
    } else {
        Err(format!("'{name}' is not a known secret"))
    }
}

#[tauri::command]
pub fn secret_storage_info() -> SecretStorageInfo {
    let b = secrets::backend();
    SecretStorageInfo { secure: b.available(), label: b.label().to_string() }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    guard(&name)?;
    let value = value.trim();
    if value.is_empty() {
        return Err("the key is empty".into());
    }
    let b = secrets::backend();
    b.set(&name, value)?;
    match b.get(&name)? {
        Some(back) if back == value => Ok(()),
        _ => Err("the credential store did not keep the key".into()),
    }
}

/// Whether the secret is set plus its last 4 characters. Never the value.
#[tauri::command]
pub fn secret_get_masked(name: String) -> Result<SecretMask, String> {
    guard(&name)?;
    secrets::get_masked(secrets::backend(), &name)
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    guard(&name)?;
    secrets::backend().delete(&name)
}

/// INTERNAL: the only command that returns a raw key, and only for one slot: the key of the person's
/// "Custom AI service". The wizard's writer calls that service from the webview and needs it for the
/// request header. The provider keys and the sidecar secrets are never handed back.
#[tauri::command]
pub fn secret_get_custom_ai_key() -> Option<String> {
    secrets::read_secret(secrets::CUSTOM_AI_SECRET)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_masked_commands_take_provider_keys_and_refuse_strangers() {
        // One test: both touch the one process-wide in-memory store, so they must not run side by side.
        let name = "anthropic_api_key".to_string();
        secret_set(name.clone(), "sk-test-provider-0000000000".to_string()).unwrap();
        let mask = secret_get_masked(name.clone()).unwrap();
        assert!(mask.set);
        assert_eq!(mask.last4.as_deref(), Some("0000"));
        secret_delete(name.clone()).unwrap();
        assert!(!secret_get_masked(name).unwrap().set);
        assert!(secret_set("anything_else".into(), "x".into()).is_err());
        assert!(secret_get_masked("anything_else".into()).is_err());
        assert!(secret_delete("anything_else".into()).is_err());
        assert!(secret_set("discord_bot_token".into(), "x".into()).is_err(), "the old bot-token name is gone");
        assert!(secret_get_masked("discord_webhook_url".into()).is_err(), "the webhook link never reaches the webview");
    }

    #[test]
    fn the_custom_ai_key_is_the_only_one_the_webview_can_read_back() {
        secrets::backend().set("openai_api_key", "sk-test-provider-key-000000").unwrap();
        // No command argument: a provider key cannot be asked for, whatever the value stored.
        assert_eq!(secret_get_custom_ai_key(), None);
        secret_set(secrets::CUSTOM_AI_SECRET.into(), "sk-test-custom-key-000000".into()).unwrap();
        assert_eq!(secret_get_custom_ai_key().as_deref(), Some("sk-test-custom-key-000000"));
        assert_eq!(secret_get_masked(secrets::CUSTOM_AI_SECRET.into()).unwrap().last4.as_deref(), Some("0000"));
        secret_delete(secrets::CUSTOM_AI_SECRET.into()).unwrap();
        assert_eq!(secret_get_custom_ai_key(), None);
        secrets::backend().delete("openai_api_key").unwrap();
    }
}
