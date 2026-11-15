//! Force yes for terminal panes: the switch a person set on one pane (kept for the life of the app), else what the pane's
//! agent and project start with (`RulesStore::effective`). The answering itself is `pane_prompt::force_yes`.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::BTreeMap;

static PANES: Lazy<Mutex<BTreeMap<String, bool>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));

/// The person's switch on one pane.
pub fn set(pane_id: &str, on: bool) {
    PANES.lock().insert(pane_id.to_string(), on);
}

pub fn explicit(pane_id: &str) -> Option<bool> {
    PANES.lock().get(pane_id).copied()
}

/// A pane is gone: its switch goes with it.
pub fn forget(pane_id: &str) {
    PANES.lock().remove(pane_id);
}

/// A cheap look before anything is read from the screen: could Force yes be on for this pane? (The switch on the pane,
/// else the agent's own switch or a pin that turns it on.) `enabled` makes the real decision.
pub fn maybe_enabled(pane_id: &str, agent: &str) -> bool {
    explicit(pane_id).unwrap_or_else(|| super::store().force_yes_for_agent(agent) || super::store().any_pin_force_yes())
}

/// Whether Force yes is on for this pane now.
pub fn enabled(pane_id: &str, agent: &str, cwd: &str) -> bool {
    explicit(pane_id).unwrap_or_else(|| super::store().effective(agent, Some(cwd)).force_yes)
}
