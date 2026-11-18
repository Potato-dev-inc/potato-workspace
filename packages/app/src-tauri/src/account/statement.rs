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
    device_statement_with_node(key, account_id, device_id, kind, name, None)
}

/// The same, naming the PC-link id this device answers on (`node_id`): the account's address book entry that lets the
/// person's other PCs find it. Signed by the device key, so the server cannot change it.
pub fn device_statement_with_node(key: &SigningKey, account_id: &str, device_id: &str, kind: &str, name: &str, node_id: Option<&str>) -> Signed {
    let mut value = json!({
        "v": 1,
        "account_id": account_id,
        "device_id": device_id,
        "kind": kind,
        "name": name,
        "device_pub": b64(key.verifying_key().as_bytes()),
    });
    if let Some(node) = node_id {
        value["node_id"] = json!(node);
    }
    sign_with_prefix(key, DEVICE_PREFIX, value.to_string())
}

/// The statement of a PC that lets its other PCs open it: the link id, the relay it is reached through and when it was made, all
/// under the device key. The other PCs trust none of these as more than a place to knock, and ignore a statement that is not recent
/// (the PC says again every minute), so an old one the account kept cannot send them to an address that no longer works.
pub fn device_statement_published(key: &SigningKey, account_id: &str, device_id: &str, name: &str, node_id: &str, relay: Option<&str>, issued_at: u64) -> Signed {
    let mut value = json!({
        "v": 1,
        "account_id": account_id,
        "device_id": device_id,
        "kind": "pc",
        "name": name,
        "device_pub": b64(key.verifying_key().as_bytes()),
        "node_id": node_id,
        "issued_at": issued_at,
    });
    if let Some(relay) = relay {
        value["home_relay"] = json!(relay);
    }
    sign_with_prefix(key, DEVICE_PREFIX, value.to_string())
}

/// Whether `signature` (base64url) is `device_pub`'s (base64url) signature over `statement` under the device prefix.
pub fn verify_device_statement(device_pub: &str, statement: &str, signature: &str) -> bool {
    use crate::keys::crypto::unb64;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let (Some(pubkey), Some(sig)) = (unb64(device_pub), unb64(signature)) else { return false };
    let (Ok(pubkey), Ok(sig)) = (<[u8; 32]>::try_from(pubkey.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pubkey) else { return false };
    let mut msg = DEVICE_PREFIX.as_bytes().to_vec();
    msg.extend_from_slice(statement.as_bytes());
    vk.verify(&msg, &Signature::from_bytes(&sig)).is_ok()
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
