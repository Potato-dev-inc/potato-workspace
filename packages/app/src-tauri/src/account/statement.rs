//! What this device signs for the account server: its device statement, a revocation, and every request.
//! Each message starts with its own domain prefix, so the key never signs something that reads as another
//! protocol's message. The formats match `account/server` (`src/core.ts`, `src/api.ts`).

use crate::keys::crypto::{b64, random_bytes, SigningKey};
use ed25519_dalek::Signer;
use serde_json::json;
use sha2::{Digest, Sha256};

pub const DEVICE_PREFIX: &str = "pm/account/device/v1\n";
pub const REVOKE_PREFIX: &str = "pm/account/revoke/v1\n";
pub const REQUEST_PREFIX: &str = "pm/account/req/v1\n";

/// The signed text and its signature (base64url), as the server wants them.
pub struct Signed {
    pub statement: String,
    pub signature: String,
}

fn sign_with_prefix(key: &SigningKey, prefix: &str, statement: String) -> Signed {
    let mut msg = prefix.as_bytes().to_vec();
    msg.extend_from_slice(statement.as_bytes());
    let signature = b64(&key.sign(&msg).to_bytes());
    Signed { statement, signature }
}

/// "This is my device": account, device id, kind, name and public key, signed by the device key itself.
pub fn device_statement(key: &SigningKey, account_id: &str, device_id: &str, kind: &str, name: &str) -> Signed {
    let text = json!({
        "v": 1,
        "account_id": account_id,
        "device_id": device_id,
        "kind": kind,
        "name": name,
        "device_pub": b64(key.verifying_key().as_bytes()),
    })
    .to_string();
    sign_with_prefix(key, DEVICE_PREFIX, text)
}

/// "Sign this device out" (`sign_out`) or "that was not me" (`not_me`) for one device, signed by the calling device.
pub fn revoke_statement(key: &SigningKey, action: &str, target_device_id: &str, by_device_id: &str, now: u64) -> Signed {
    let text = json!({
        "v": 1,
        "action": action,
        "target_device_id": target_device_id,
        "by_device_id": by_device_id,
        "at": now,
    })
    .to_string();
    sign_with_prefix(key, REVOKE_PREFIX, text)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The headers that sign one request: time, a nonce seen once, and the signature over
/// `method | path+query | time | nonce | sha256(body)`.
pub struct RequestAuth {
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

pub fn sign_request(key: &SigningKey, method: &str, path_and_query: &str, now: u64, body: &[u8]) -> RequestAuth {
    let timestamp = now.to_string();
    let nonce = b64(&random_bytes::<16>());
    let text = format!("{REQUEST_PREFIX}{method}\n{path_and_query}\n{timestamp}\n{nonce}\n{}", sha256_hex(body));
    let signature = b64(&key.sign(text.as_bytes()).to_bytes());
    RequestAuth { timestamp, nonce, signature }
}
