//! The shipped app version, for the app and the host alike.

/// The shipped app version. It lives in `tauri.conf.json` (what the installer and updater use);
/// `CARGO_PKG_VERSION` is a stale crate number. Read from the embedded config so it needs no app handle.
pub fn app_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../tauri.conf.json"))
            .ok()
            .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_version_comes_from_tauri_conf() {
        // Not the crate number (0.2.2 is stale), and it is the same file the app reads.
        assert_ne!(super::app_version(), env!("CARGO_PKG_VERSION"));
        assert_eq!(super::app_version().split('.').count(), 3);
    }
}
