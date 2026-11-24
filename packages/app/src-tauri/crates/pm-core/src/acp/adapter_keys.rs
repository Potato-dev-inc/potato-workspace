//! The keys a reviewed adapter may receive (`acp::adapter_overlay`), kept in the credential store.
//!
//! A key is named by the adapter's catalog entry (`env_keys`). Its value lives in one credential-store slot:
//! the slot the entry names (a Keys-settings slot, the same one that screen shows), else a per-adapter slot derived
//! from the adapter id and the variable name. Nothing here sends a value out: the commands answer with names and a
//! yes/no status, and the value goes only into the child's environment (`acp::config::resolve_spawn`).
//!
//! The `*_in` functions take the store as a parameter, so tests use the in-memory backend.

use serde::Serialize;

use super::adapter_catalog::{self, AdapterEntry, EnvKey};
use crate::secrets::{self, SecretBackend};

/// One key of an adapter, as the screens may show it: the name, its label and whether a value is saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyStatus {
    pub env: String,
    pub label: String,
    pub set: bool,
    /// The key lives in Keys settings (cleared there, not from the adapter's screen).
    pub shared: bool,
}

/// The credential-store slot that holds `key` of `entry`.
pub fn slot_of(entry: &AdapterEntry, key: &EnvKey) -> String {
    key.slot.clone().unwrap_or_else(|| format!("adapter_{}_{}", entry.meta.id, key.env.to_ascii_lowercase()))
}

fn key_of<'a>(entry: &'a AdapterEntry, env: &str) -> Result<&'a EnvKey, String> {
    entry.meta.env_keys.iter().find(|k| k.env == env).ok_or_else(|| format!("INVALID_ARGUMENT: this adapter does not ask for {env}"))
}

/// The reviewed adapter with this id, from the shipped catalog.
pub fn entry_for(adapter_id: &str) -> Result<AdapterEntry, String> {
    adapter_catalog::load().into_iter().find(|e| e.meta.id == adapter_id).ok_or_else(|| "NOT_AVAILABLE: no reviewed adapter has this id".to_string())
}

/// Saves the value of `env`. The value is checked, written and read back; no value is put in any error text.
pub fn set_in(store: &dyn SecretBackend, entry: &AdapterEntry, env: &str, value: &str) -> Result<(), String> {
    let key = key_of(entry, env)?;
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("INVALID_ARGUMENT: the key is empty or is not plain text".into());
    }
    let slot = slot_of(entry, key);
    store.set(&slot, value).map_err(|_| "the credential store did not save the key".to_string())?;
    match store.get(&slot) {
        Ok(Some(back)) if back == value => Ok(()),
        _ => Err("the credential store did not keep the key".into()),
    }
}

/// Whether each key of `entry` has a saved value. Never a value.
pub fn status_in(store: &dyn SecretBackend, entry: &AdapterEntry) -> Result<Vec<KeyStatus>, String> {
    entry
        .meta
        .env_keys
        .iter()
        .map(|key| {
            let set = store.get(&slot_of(entry, key)).map_err(|_| "the credential store could not be read".to_string())?.is_some_and(|v| !v.is_empty());
            Ok(KeyStatus { env: key.env.clone(), label: key.label.clone(), set, shared: key.slot.is_some() })
        })
        .collect()
}

/// Every key group of `entry` has at least one key saved. Else a plain refusal naming the labels (never a value).
pub fn ready_in(store: &dyn SecretBackend, entry: &AdapterEntry) -> Result<(), String> {
    let statuses = status_in(store, entry)?;
    for group in &entry.meta.key_groups {
        let met = group.iter().any(|env| statuses.iter().any(|s| s.env == *env && s.set));
        if !met {
            let labels: Vec<&str> = group.iter().filter_map(|env| entry.meta.env_keys.iter().find(|k| k.env == *env).map(|k| k.label.as_str())).collect();
            return Err(format!("NOT_AVAILABLE: save a key first: {} (one of them is enough)", labels.join(" or ")));
        }
    }
    Ok(())
}

/// `ready_in` against the app's credential store, for the adapter `adapter_id`.
pub fn ready(adapter_id: &str) -> Result<(), String> {
    ready_in(secrets::backend(), &entry_for(adapter_id)?)
}

/// Removes a per-adapter key. A key that also lives in Keys settings is cleared there, not from here.
pub fn clear_in(store: &dyn SecretBackend, entry: &AdapterEntry, env: &str) -> Result<(), String> {
    let key = key_of(entry, env)?;
    if key.slot.is_some() {
        return Err(format!("NOT_AVAILABLE: {env} is also kept in Keys settings; clear it there"));
    }
    store.delete(&slot_of(entry, key)).map_err(|_| "the credential store did not remove the key".to_string())
}

/// Saves a key for the adapter `adapter_id` in the app's credential store.
pub fn set(adapter_id: &str, env: &str, value: &str) -> Result<(), String> {
    set_in(secrets::backend(), &entry_for(adapter_id)?, env, value)
}

/// The saved state of every key of the adapter `adapter_id`: names and yes/no only.
pub fn status(adapter_id: &str) -> Result<Vec<KeyStatus>, String> {
    status_in(secrets::backend(), &entry_for(adapter_id)?)
}

/// Removes a per-adapter key from the app's credential store.
pub fn clear(adapter_id: &str, env: &str) -> Result<(), String> {
    clear_in(secrets::backend(), &entry_for(adapter_id)?, env)
}

/// The slots of every shipped adapter key, read from the catalog once per process (the catalog does not change while
/// the app runs). Gathering redaction secrets must not read the disk or hash scripts on every call.
static KEY_SLOTS: once_cell::sync::Lazy<Vec<String>> = once_cell::sync::Lazy::new(|| {
    adapter_catalog::load().iter().flat_map(|entry| entry.meta.env_keys.iter().map(move |key| slot_of(entry, key))).collect()
});

/// Every adapter key value saved now, so the redactor masks them wherever they show up (`redact::known`).
pub fn all_secret_values() -> Vec<String> {
    KEY_SLOTS.iter().filter_map(|slot| secrets::read_secret(slot)).collect()
}
