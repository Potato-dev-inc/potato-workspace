//! Moved out of the app: the `[mcp_host]` table parser a code profile uses (the app re-exports it from `toolbelt`).

use crate::tui::declarative::schema::McpHostTable;

/// Prefix of every config key the toolbelt owns. Anything else in an agent's config is the user's.
pub const KEY_PREFIX: &str = "pm-toolbelt-";

/// Parse a built-in `[mcp_host]` declaration (the TOML text a code profile carries).
pub fn host_from_toml(text: &str) -> Option<McpHostTable> {
    toml::from_str(text).ok()
}
