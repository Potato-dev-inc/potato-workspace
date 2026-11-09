//! Who is answering on a bridge port: the product marker and a per-launch instance id.

use std::sync::OnceLock;

/// The `product` field of `GET /health`. The MCP shim only trusts a probed port that reports it.
pub const PRODUCT: &str = "potato-workspace";

/// Random id generated once per app launch (first use; the bridge touches it while starting).
pub fn app_instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_instance_id_is_random_looking_and_stable_within_a_launch() {
        let id = app_instance_id();
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(id, app_instance_id());
        assert_eq!(PRODUCT, "potato-workspace");
    }
}
