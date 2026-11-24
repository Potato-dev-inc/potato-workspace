//! Moved out of the app: the pieces of `mcp_install::declarative` a profile definition is checked with.

/// The name Potato Workspace's own tool server goes by in an agent's server list.
pub const MCP_SERVER_NAME: &str = "potato-workspace";

pub const PLACEHOLDERS: &[&str] = &["command", "args", "env"];

/// Dotted key path split into non-empty segments.
pub fn key_segments(key_path: &str) -> Result<Vec<&str>, String> {
    let segs: Vec<&str> = key_path.split('.').collect();
    let ok = |s: &&str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !segs.iter().all(ok) {
        return Err(format!("key_path {key_path:?} must be dotted segments of [A-Za-z0-9_-]"));
    }
    Ok(segs)
}

