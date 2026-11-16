//! Where the account session lives: the OS credential store (Windows Credential Manager) through the same
//! `SecretBackend` the provider keys use. Never a file, a log, a view or the webview: the window only gets
//! "signed in as X". The device id is kept beside it and survives a sign-out, so signing in again on the same
//! device finds the same row on the server.

use crate::secrets::SecretBackend;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// What the app keeps after a sign-in. `token` is the session secret.
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub token: String,
    pub device_id: String,
    pub account_id: String,
    pub display_name: String,
    pub provider: String,
    /// The server this session belongs to; a session never travels to another address.
    pub server: String,
}

impl std::fmt::Debug for StoredSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredSession").field("account_id", &self.account_id).field("device_id", &self.device_id).finish_non_exhaustive()
    }
}

struct Global;

impl SecretBackend for Global {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        crate::secrets::backend().get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        crate::secrets::backend().set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        crate::secrets::backend().delete(name)
    }
    fn label(&self) -> &'static str {
        crate::secrets::backend().label()
    }
    fn available(&self) -> bool {
        crate::secrets::backend().available()
    }
}

#[derive(Clone)]
pub struct SessionStore {
    backend: Arc<dyn SecretBackend>,
    prefix: String,
}

impl SessionStore {
    /// The app's store, one per profile (two profiles on one PC are two devices).
    pub fn app() -> Self {
        let profile = crate::app_paths::profile().unwrap_or_else(|| "default".into());
        Self { backend: Arc::new(Global), prefix: format!("account/{profile}/") }
    }

    #[cfg(test)]
    pub fn with_backend(backend: Arc<dyn SecretBackend>, scope: &str) -> Self {
        Self { backend, prefix: format!("account/{scope}/") }
    }

    fn name(&self, what: &str) -> String {
        format!("{}{what}", self.prefix)
    }

    pub fn load(&self) -> Option<StoredSession> {
        let text = self.backend.get(&self.name("session")).ok().flatten()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self, session: &StoredSession) -> Result<(), String> {
        let text = serde_json::to_string(session).map_err(|e| e.to_string())?;
        self.backend.set(&self.name("session"), &text)?;
        // Read it back: a store that silently drops a write must not look signed in.
        match self.load() {
            Some(back) if back.token == session.token => Ok(()),
            _ => Err("the credential store did not keep the sign-in".into()),
        }
    }

    pub fn clear(&self) {
        let _ = self.backend.delete(&self.name("session"));
    }

    /// This device's id on the server: made once, kept for good.
    pub fn device_id(&self) -> Result<String, String> {
        if let Some(id) = self.backend.get(&self.name("device-id"))?.filter(|v| uuid::Uuid::parse_str(v).is_ok()) {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.backend.set(&self.name("device-id"), &id)?;
        Ok(id)
    }
}
