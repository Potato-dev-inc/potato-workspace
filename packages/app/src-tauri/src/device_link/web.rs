//! "My own route": reaching a paired device through its own web address (a stable-link Worker or a tunnel) when the PC
//! link cannot connect at all. It adds no rights: the far device hands this PC a device token the same way it pairs a
//! phone, with exactly the rights of the level the person switched on there, and every request is checked by the far
//! bridge like a phone's (the paired token is still needed).
//!
//! - **Far side** (`WebGrant`): when the person turned on `Also allow it through my web address` for a device, a request
//!   for the address over the encrypted link is answered with the web address and a fresh token. Turning it off, or
//!   removing the device, revokes the token.
//! - **This side** (`WebStore`, `WebCall`): the address and token are kept in the OS credential store (never in a
//!   file, never in a log, never shown), and used only when the link fails and the route choice allows it.
//!
//! Nothing here opens a window or a socket on its own, and the real network call (`WebCall`) is a seam: tests pass a
//! fake, so no test calls a real relay or worker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::secrets::SecretBackend;

/// The far side: mints and revokes the device token a paired device uses on this PC's web address.
pub trait WebGrant: Send + Sync {
    /// This PC's web address and a fresh token for the device `node` (hex) named `name`, at the given level.
    /// An earlier token of that device is revoked first. `Err`: no web address, or it cannot be made now.
    fn mint(&self, node: &str, name: &str, full: bool) -> Result<(String, String), String>;
    fn revoke(&self, node: &str);
}

/// A grant that never has an address (the default while the own route is not set up, and in tests).
#[cfg(test)]
pub struct NoWebGrant;

#[cfg(test)]
impl WebGrant for NoWebGrant {
    fn mint(&self, _: &str, _: &str, _: bool) -> Result<(String, String), String> {
        Err("This PC has no web address yet. Set one up in Settings > Phone.".into())
    }
    fn revoke(&self, _: &str) {}
}

/// This side: one request on the far device's web address, with its token. Returns the HTTP status and body.
#[async_trait]
pub trait WebCall: Send + Sync {
    async fn call(&self, base: &str, token: &str, method: &str, target: &str, body: Vec<u8>) -> Result<(u16, Vec<u8>), String>;
}

#[cfg(test)]
pub struct NoWebCall;

#[cfg(test)]
#[async_trait]
impl WebCall for NoWebCall {
    async fn call(&self, _: &str, _: &str, _: &str, _: &str, _: Vec<u8>) -> Result<(u16, Vec<u8>), String> {
        Err("No web route".into())
    }
}

/// The addresses and tokens this PC holds for other devices, in the credential store. A small cache in front of it, so
/// asking "is there one" for every view costs nothing.
pub struct WebStore {
    secrets: Arc<dyn SecretBackend>,
    cache: Mutex<HashMap<String, Option<(String, String)>>>,
}

fn secret_name(node: &str) -> String {
    format!("devices/web/{node}")
}

impl WebStore {
    pub fn new(secrets: Arc<dyn SecretBackend>) -> Self {
        Self { secrets, cache: Mutex::new(HashMap::new()) }
    }

    /// The address and token for `node`, if this PC holds them.
    pub fn get(&self, node: &str) -> Option<(String, String)> {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(hit) = cache.get(node) {
            return hit.clone();
        }
        let loaded = self.secrets.get(&secret_name(node)).ok().flatten().and_then(|text| {
            let (url, token) = text.split_once('\n')?;
            (!url.is_empty() && !token.is_empty()).then(|| (url.to_string(), token.to_string()))
        });
        cache.insert(node.to_string(), loaded.clone());
        loaded
    }

    pub fn has(&self, node: &str) -> bool {
        self.get(node).is_some()
    }

    pub fn set(&self, node: &str, url: &str, token: &str) -> Result<(), String> {
        self.secrets.set(&secret_name(node), &format!("{url}\n{token}"))?;
        self.cache.lock().unwrap_or_else(|p| p.into_inner()).insert(node.to_string(), Some((url.to_string(), token.to_string())));
        Ok(())
    }

    pub fn forget(&self, node: &str) {
        let _ = self.secrets.delete(&secret_name(node));
        self.cache.lock().unwrap_or_else(|p| p.into_inner()).insert(node.to_string(), None);
    }
}

/// A web address the far device may hand out: https only (a plain address would send the token in the clear), no
/// credentials in it, no spaces, bounded.
pub fn address_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or("");
    !host.is_empty() && !host.contains('@') && url.len() <= 300 && url.chars().all(|c| c.is_ascii_graphic())
}

/// The target a web request is sent to: the bridge base and the path. Same rules as the link's own request line.
pub fn url_for(base: &str, target: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    #[test]
    fn the_token_lives_in_the_credential_store_and_forget_removes_it() {
        let backend: Arc<dyn SecretBackend> = Arc::new(MemoryBackend::new());
        let store = WebStore::new(backend.clone());
        assert!(!store.has("ab"));
        store.set("ab", "https://w.example/bridge", "tok").unwrap();
        assert_eq!(store.get("ab"), Some(("https://w.example/bridge".into(), "tok".into())));
        // A second store over the same backend (a restart) finds it.
        assert!(WebStore::new(backend.clone()).has("ab"));
        store.forget("ab");
        assert!(!store.has("ab"));
        assert!(!WebStore::new(backend).has("ab"));
    }

    #[test]
    fn only_a_plain_https_address_is_accepted() {
        assert!(address_ok("https://link.example.workers.dev/bridge"));
        assert!(!address_ok("http://link.example/bridge"));
        assert!(!address_ok("https://user:pw@link.example/bridge"));
        assert!(!address_ok("https://"));
        assert!(!address_ok("https://a.example/ b"));
        assert_eq!(url_for("https://w.example/bridge/", "/panes"), "https://w.example/bridge/panes");
    }
}
