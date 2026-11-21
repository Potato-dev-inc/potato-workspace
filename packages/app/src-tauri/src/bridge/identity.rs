//! Who is answering on a bridge port: the product marker and a per-launch instance id.

use std::sync::OnceLock;

/// The `product` field of `GET /health`. The MCP shim only trusts a probed port that reports it.
pub const PRODUCT: &str = "potato-workspace";

/// What this running app answers to a Check of the person's own address: a hash only this launch can make from the
/// caller's nonce. The instance id is never sent; a server that repeats the nonce back cannot produce this.
pub fn own_domain_proof(nonce: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"potato-workspace:own-domain:");
    h.update(app_instance_id().as_bytes());
    h.update(b":");
    h.update(nonce.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A nonce a Check may send: 16 to 64 hex characters, nothing else.
pub fn valid_nonce(nonce: &str) -> bool {
    (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Random id generated once per app launch (first use; the bridge touches it while starting).
pub fn app_instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_own_domain_proof_depends_on_the_nonce_and_never_equals_it() {
        let n1 = "0123456789abcdef0123456789abcdef";
        let n2 = "fedcba9876543210fedcba9876543210";
        assert_eq!(own_domain_proof(n1), own_domain_proof(n1));
        assert_ne!(own_domain_proof(n1), own_domain_proof(n2));
        assert_ne!(own_domain_proof(n1), n1);
        assert_eq!(own_domain_proof(n1).len(), 64);
        assert!(!own_domain_proof(n1).contains(app_instance_id()));
        assert!(valid_nonce(n1) && !valid_nonce("abc") && !valid_nonce("zzzzzzzzzzzzzzzzzzzz") && !valid_nonce(&"a".repeat(65)));
    }

    #[test]
    fn the_instance_id_is_random_looking_and_stable_within_a_launch() {
        let id = app_instance_id();
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(id, app_instance_id());
        assert_eq!(PRODUCT, "potato-workspace");
    }
}
