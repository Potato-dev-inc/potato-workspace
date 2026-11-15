//! The tool policy of the Discord brain: none.
//!
//! Default `rules.tools = "none"` and nothing in the app turns it on. A message from Discord is typed by a
//! stranger, so the brain behind it has no shell, no files, no `delegate`, no pane message, no sandbox and no
//! MCP: it can read its prompt and write one reply. Any future tool use from Discord would need the person's own
//! rule per owner id and an approval card on the desktop; none of that exists today.

use serde_json::Value;

/// The `tools` part of a request: there is none, so the request never has one.
pub fn request_tools() -> Option<Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn there_are_no_tools() {
        assert!(request_tools().is_none());
    }
}
