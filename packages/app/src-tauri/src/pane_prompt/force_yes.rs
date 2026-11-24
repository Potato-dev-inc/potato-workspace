//! Force yes for a terminal pane: answers "allow once" to a yes/no prompt the app already detected, for a person who
//! turned the switch on (`agent_rules::terminal`).
//!
//! Only a command approval or a file edit, only when the app's own risk reading (`prompt_risk`, put on the prompt by
//! `detect`) is Low, only when nothing on the prompt looks like a password or a login, and only "allow once": never a
//! trust dialog, a startup screen, a menu of unknown shape, or an "always" answer. Anything else stays on the screen for
//! the person. The key is pressed through `answers::answer_once` like every other answer, and the audit log gets a line.

use crate::agent_rules::force_yes::{looks_secret, Ask};
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;

use crate::pty::PaneRegistry;

/// Whether a detected prompt is one Force yes may answer. Pure: the prompt as `detect` returns it.
pub fn eligible(prompt: &Value) -> bool {
    let text = |key: &str| prompt.get(key).and_then(Value::as_str);
    if !matches!(text("kind"), Some("command_approval" | "file_edit")) {
        return false;
    }
    if prompt.pointer("/risk/level").and_then(Value::as_str) != Some("low") {
        return false;
    }
    let has_allow_once = prompt.get("choices").and_then(Value::as_array).is_some_and(|c| c.iter().any(|x| x.as_str() == Some("allow_once")));
    if !has_allow_once {
        return false;
    }
    let paths: Vec<String> = text("path").map(str::to_string).into_iter().collect();
    let words = [text("text"), text("summary"), text("question")].into_iter().flatten().collect::<Vec<_>>().join("\n");
    !looks_secret(&Ask { kind: text("kind"), title: Some(&words), paths: &paths, command: text("command"), roots: &[] })
}

/// Looks at what `pane_id` shows and answers it when the rules above allow. True when a key was pressed.
pub fn try_answer(registry: &Arc<Mutex<PaneRegistry>>, pane_id: &str) -> bool {
    let (agent_type, cwd) = {
        let reg = registry.lock();
        let Some(pane) = reg.panes.get(pane_id) else { return false };
        (pane.info.agent_type.clone(), pane.info.cwd.clone())
    };
    if !crate::agent_rules::terminal::enabled(pane_id, &agent_type, &cwd) {
        return false;
    }
    let Some(prompt) = super::detect(registry, pane_id, false) else { return false };
    if !eligible(&prompt) {
        return false;
    }
    let adapter = crate::agent_adapters::adapter_for(&agent_type);
    let Ok(reply) = adapter.prompt_reply(&prompt, "allow_once", false) else { return false };
    let Some(keys) = reply.key.or(reply.text) else { return false };
    let prompt_id = prompt.get("prompt_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let sent = pm_core::pane_prompt::answers::answer_once(pane_id, &prompt_id, "allow_once", pm_core::pane_prompt::answers::now_ms(), || {
        crate::pty::registry::write_input(registry, pane_id, &keys, true, false, None, crate::pty::WriteOrigin::Answer)
    });
    if !matches!(sent, Ok(pm_core::pane_prompt::answers::Slot::Sent(()))) {
        return false;
    }
    let mut detail = serde_json::json!({ "event": "auto_allowed", "pane_id": pane_id, "agent": agent_type, "kind": prompt.get("kind") });
    if let Some(command) = prompt.get("command").and_then(Value::as_str) {
        detail["command"] = crate::audit::command_fingerprint(command);
    }
    crate::audit::record(crate::audit::Kind::AgentRules, crate::audit::Who::Desktop, "Force yes allowed an agent's request in a terminal pane", detail);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn prompt(kind: &str, level: &str, command: &str) -> Value {
        json!({ "prompt_id": "p1", "kind": kind, "command": command, "choices": ["allow_once", "deny"], "risk": { "level": level, "headline": "x", "reasons": [] } })
    }

    #[test]
    fn a_low_risk_command_approval_is_answerable() {
        assert!(eligible(&prompt("command_approval", "low", "git status")));
        assert!(eligible(&json!({ "kind": "file_edit", "path": "src/a.rs", "choices": ["allow_once"], "risk": { "level": "low" } })));
    }

    #[test]
    fn risky_and_unusual_prompts_are_left_to_the_person() {
        assert!(!eligible(&prompt("command_approval", "medium", "make deploy")));
        assert!(!eligible(&prompt("command_approval", "high", "rm -rf /")));
        assert!(!eligible(&prompt("workspace_trust", "low", "")));
        assert!(!eligible(&prompt("startup_screen", "low", "")));
        assert!(!eligible(&prompt("unknown_question", "low", "")));
        // No allow-once choice on the screen: nothing to press.
        assert!(!eligible(&json!({ "kind": "command_approval", "command": "ls", "choices": ["deny"], "risk": { "level": "low" } })));
        // No risk reading at all counts as not low.
        assert!(!eligible(&json!({ "kind": "command_approval", "command": "ls", "choices": ["allow_once"] })));
    }

    #[test]
    fn a_prompt_that_looks_like_a_password_is_never_answered() {
        assert!(!eligible(&prompt("command_approval", "low", "echo $PASSWORD")));
        assert!(!eligible(&json!({ "kind": "file_edit", "path": ".env", "choices": ["allow_once"], "risk": { "level": "low" } })));
        assert!(!eligible(&json!({ "kind": "command_approval", "command": "ls", "text": "Enter your password to continue", "choices": ["allow_once"], "risk": { "level": "low" } })));
    }
}
