//! A read-only chat: `run_agent(read_only: true)` as a chat session.
//!
//! Two guards, both data-driven from the agent's `[acp.read_only]` table (`acp::config::ReadOnlyChat`), never from the agent's name:
//!
//! * This app answers every permission question whose tool is not a read, search, fetch or think with "reject", and serves
//!   no file write and no command (`AcpSession::set_read_only`). That alone guards an agent that asks before every such tool.
//! * An agent that runs some tools without asking also gets its own read-only session mode (`mode`), picked before the first
//!   message. When it does not take the mode and the permission guard alone is not enough, no chat is started.
//!
//! The receipt says `enforced` only for a chat that got through [`enable`].

use serde_json::Value;

use super::AcpChat;

/// Why a read-only chat was not started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported(pub String);

/// Whether this agent can run a chat read-only at all (its definition has an `[acp.read_only]` table).
pub fn supported(cfg: &crate::acp::config::AgentConfig) -> bool {
    cfg.read_only.is_some()
}

/// Turns the guards on for a chat that has started and has not had a message yet.
pub fn enable(chat: &AcpChat) -> Result<(), Unsupported> {
    let session = chat.session();
    let rule = session.config().read_only.clone().ok_or_else(|| Unsupported(format!("{} has no way to run a chat read-only.", chat.label())))?;
    // The permission guard comes first: nothing the agent asks while the mode is being picked can pass.
    session.set_read_only(true);
    if rule.mode.trim().is_empty() {
        return Ok(());
    }
    match pick_mode(chat, rule.option_id(), rule.mode.trim()) {
        Ok(()) => Ok(()),
        // The agent asks before every edit and command, so the permission guard holds without its mode.
        Err(_) if rule.asks_before_tools => Ok(()),
        Err(why) => {
            session.set_read_only(false);
            Err(Unsupported(format!("{} did not take its read-only mode ({why}), so nothing was started.", chat.label())))
        }
    }
}

fn pick_mode(chat: &AcpChat, option_id: &str, mode: &str) -> Result<(), String> {
    let snapshot = chat.session().snapshot();
    let offered_as_option = snapshot.config_options.iter().find(|o| o.get("id").and_then(Value::as_str) == Some(option_id)).filter(|o| {
        o.get("options").and_then(Value::as_array).is_some_and(|list| list.iter().any(|v| v.get("value").and_then(Value::as_str) == Some(mode)))
    });
    if let Some(option) = offered_as_option {
        if option.get("currentValue").and_then(Value::as_str) != Some(mode) {
            chat.set_config(option_id, mode).map_err(|e| e.to_string())?;
        }
        let now = chat.session().snapshot().config_options.iter().find(|o| o.get("id").and_then(Value::as_str) == Some(option_id)).and_then(|o| o.get("currentValue").and_then(Value::as_str).map(str::to_string));
        return if now.as_deref() == Some(mode) { Ok(()) } else { Err("the agent still reports another mode".to_string()) };
    }
    let offered_as_mode = snapshot
        .modes
        .as_ref()
        .and_then(|m| m.get("availableModes"))
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(mode)));
    if offered_as_mode {
        return chat.session().set_session_mode(mode).map_err(|e| e.to_string());
    }
    Err("the agent does not list that mode".to_string())
}

#[cfg(test)]
mod tests {
    use crate::acp::config::{find_builtin, from_toml_text, ReadOnlyChat};

    #[test]
    fn the_agents_say_how_they_are_read_only_in_their_definitions() {
        let opencode = find_builtin("opencode").and_then(|c| c.read_only).expect("OpenCode has a read-only chat");
        assert_eq!((opencode.mode.as_str(), opencode.asks_before_tools), ("plan", false), "OpenCode runs tools unasked, so it needs its own mode");
        let claude = find_builtin("claude").and_then(|c| c.read_only).expect("Claude has a read-only chat");
        assert!(claude.asks_before_tools);
        let codex = find_builtin("codex").and_then(|c| c.read_only).expect("Codex has a read-only chat");
        assert!(codex.asks_before_tools && codex.mode.is_empty());
    }

    #[test]
    fn a_read_only_table_with_no_guard_is_not_accepted() {
        let table = "command = \"x\"\n[read_only]\nmode = \"\"\nasks_before_tools = false\n";
        assert!(from_toml_text("x", "X", table).unwrap_err().contains("read_only"));
        let ok = "command = \"x\"\n[read_only]\nmode = \"plan\"\n";
        assert_eq!(from_toml_text("x", "X", ok).unwrap().read_only, Some(ReadOnlyChat { mode: "plan".into(), mode_option: String::new(), asks_before_tools: false }));
    }
}
