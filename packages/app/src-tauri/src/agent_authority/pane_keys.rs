//! A separate secret key for every agent window (pane).
//!
//! Finding the caller of a bridge call by its process tree misses a process that escaped its window
//! (its parent exited: `Start-Process`, `cmd /c start /b`, a double fork) and does not exist off Windows.
//! So each pane also gets its own random key, given to the pane's process in `POTATO_WORKSPACE_PANE_KEY`
//! and to that pane's MCP server entry. The shell CLI and the MCP shim send it as
//! `X-Potato-Workspace-Pane-Key`; the bridge names the pane from it first and falls back to the process
//! tree only when there is no valid key.
//!
//! * Held in memory only, as a SHA-256 (the raw key lives in the pane's environment and in the pane's own
//!   MCP launch entry). A new app run starts with no keys, so any key left in an old file is dead.
//! * Never shown in the UI, never logged, never put in an error message or an audit line.
//! * Revoked when the pane closes (`revoke`), or when the pane is replaced (`mint` replaces the old key).
//! * A key proves WHICH pane a caller is; it grants nothing. A caller with a key still needs the
//!   person's Allow for what a pane may not do alone (`shell_gate`).

use base64::Engine;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// The environment variable the pane's process (and its MCP server entry) carries.
pub const KEY_ENV: &str = crate::mcp_sessions::PANE_KEY_ENV;
/// The header the CLI and the MCP shim send it in.
pub const KEY_HEADER: &str = crate::mcp_sessions::PANE_KEY_HEADER;

#[derive(Default)]
struct Keys {
    pane_by_hash: HashMap<[u8; 32], String>,
    hash_by_pane: HashMap<String, [u8; 32]>,
}

static KEYS: Lazy<Mutex<Keys>> = Lazy::new(|| Mutex::new(Keys::default()));

fn digest(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

/// A fresh key for `pane_id` (43 characters, base64url of 32 random bytes). Replaces any older one.
pub fn mint(pane_id: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let hash = digest(&key);
    let mut keys = KEYS.lock();
    if let Some(old) = keys.hash_by_pane.insert(pane_id.to_string(), hash) {
        keys.pane_by_hash.remove(&old);
    }
    keys.pane_by_hash.insert(hash, pane_id.to_string());
    key
}

/// The pane closed or was replaced: its key stops working at once.
pub fn revoke(pane_id: &str) {
    let mut keys = KEYS.lock();
    if let Some(hash) = keys.hash_by_pane.remove(pane_id) {
        keys.pane_by_hash.remove(&hash);
    }
}

/// The pane a live key belongs to. `None` for an unknown, revoked or malformed key.
pub fn pane_for_key(key: &str) -> Option<String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 128 {
        return None;
    }
    KEYS.lock().pane_by_hash.get(&digest(key)).cloned()
}

/// The key a request header block carries, cut to a sane length. Not checked.
pub fn key_in(headers: &str) -> Option<String> {
    let value = crate::mobile_pairing::header_value(headers, KEY_HEADER)?;
    let value: String = value.chars().take(128).collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The pane a request's key names, when the key is live.
pub fn pane_from_headers(headers: &str) -> Option<String> {
    pane_for_key(&key_in(headers)?)
}

/// Whether `pane_id` has a live key (the tests).
#[cfg(test)]
pub fn has_key(pane_id: &str) -> bool {
    KEYS.lock().hash_by_pane.contains_key(pane_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane() -> String {
        format!("pane-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn every_pane_gets_its_own_key_that_names_only_that_pane() {
        let (a, b) = (pane(), pane());
        let (ka, kb) = (mint(&a), mint(&b));
        assert_ne!(ka, kb);
        assert_eq!(ka.len(), 43);
        assert_eq!(pane_for_key(&ka).as_deref(), Some(a.as_str()));
        assert_eq!(pane_for_key(&kb).as_deref(), Some(b.as_str()));
        assert!(has_key(&a) && has_key(&b));
    }

    #[test]
    fn a_closed_panes_key_is_rejected_and_a_replaced_panes_old_key_too() {
        let a = pane();
        let first = mint(&a);
        let second = mint(&a);
        assert_eq!(pane_for_key(&first), None, "replaced");
        assert_eq!(pane_for_key(&second).as_deref(), Some(a.as_str()));
        revoke(&a);
        assert_eq!(pane_for_key(&second), None, "closed");
        assert!(!has_key(&a));
    }

    #[test]
    fn nonsense_keys_name_no_pane() {
        for key in ["", "   ", "nope", &"x".repeat(500)] {
            assert_eq!(pane_for_key(key), None);
        }
        assert_eq!(pane_from_headers("Host: x\r\n"), None);
        assert_eq!(pane_from_headers(&format!("{KEY_HEADER}:   \r\n")), None);
    }

    #[test]
    fn the_key_is_read_from_the_header() {
        let a = pane();
        let key = mint(&a);
        let headers = format!("Host: 127.0.0.1:1\r\n{KEY_HEADER}: {key}\r\n");
        assert_eq!(pane_from_headers(&headers).as_deref(), Some(a.as_str()));
    }
}
