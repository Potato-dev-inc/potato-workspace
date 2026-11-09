//! A person closes an agent's pane: the helpers it started close with it (when the setting
//! "Close helpers when their agent closes" is on, which is the default).
//!
//! A helper knows its agent from `PaneInfo::parent_pane_id` (set once when the helper is started over
//! MCP by a pane's agent). Terminal panes and chat panes both live in the registry, so one walk
//! covers both. Helpers close the normal way (`kill_pane_with_reason`, the same as a person closing
//! each one), and a helper's own helpers close too. A pane is never visited twice, so a loop in the
//! links cannot spin.
//!
//! This is only for a PERSON closing a pane (the pane list, a pane window, the phone). It is skipped
//! while the app is ending: then every pane is stopped anyway and chats must stay restorable.

use super::{kill_pane_with_reason, PaneRegistry};
use parking_lot::Mutex;
use std::collections::HashSet;

/// Why the helpers were closed (shows in the event log).
pub const HELPERS_CLOSED_REASON: &str = "its agent was closed";

/// Every pane below `root` in the helper links, nearest first. `root` itself is not in the list.
pub(crate) fn helpers_of(registry: &Mutex<PaneRegistry>, root: &str) -> Vec<String> {
    let reg = registry.lock();
    let mut seen: HashSet<String> = HashSet::from([root.to_string()]);
    let mut order = Vec::new();
    let mut frontier = vec![root.to_string()];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for parent in &frontier {
            let mut children: Vec<&String> = reg
                .panes
                .iter()
                .filter(|(_, pane)| pane.info.parent_pane_id.as_deref() == Some(parent.as_str()))
                .map(|(id, _)| id)
                .collect();
            children.sort();
            for child in children {
                if seen.insert(child.clone()) {
                    order.push(child.clone());
                    next.push(child.clone());
                }
            }
        }
        frontier = next;
    }
    order
}

/// The rule with its inputs given, so a test can set them: close the helpers only when the setting
/// is on and the app is not ending.
pub(crate) fn close_with_helpers(
    registry: &Mutex<PaneRegistry>,
    pane_id: &str,
    reason: Option<&str>,
    setting_on: bool,
    app_ending: bool,
) -> Result<(), String> {
    let helpers = if setting_on && !app_ending { helpers_of(registry, pane_id) } else { Vec::new() };
    kill_pane_with_reason(registry, pane_id, reason)?;
    for helper in helpers {
        let _ = kill_pane_with_reason(registry, &helper, Some(HELPERS_CLOSED_REASON));
    }
    Ok(())
}

/// A person closes `pane_id`: it closes, and so do its helpers while the setting is on.
pub fn kill_pane_and_helpers(registry: &Mutex<PaneRegistry>, pane_id: &str, reason: Option<&str>) -> Result<(), String> {
    close_with_helpers(
        registry,
        pane_id,
        reason,
        crate::agent_run_mode::close_helpers_with_agent(),
        crate::acp::chat::app_is_shutting_down(),
    )
}
