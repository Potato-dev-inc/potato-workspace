//! Tauri commands for an agent's "Remote control" card: read and set the per-agent rule the bridge
//! enforces for paired phones (`mobile_pairing::pane_rules`). The phones themselves come from the
//! existing `list_paired_mobile_devices`.

use crate::mobile_pairing::pane_rules::{self, Level, PaneRule};
use serde::Serialize;

/// What the card shows for one agent. `level` is `"watch"`, `"answer"` or `"full"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaneRemote {
    pub remote: bool,
    pub level: String,
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::Watch => "watch",
        Level::Answer => "answer",
        Level::Full => "full",
    }
}

impl From<PaneRule> for PaneRemote {
    fn from(rule: PaneRule) -> Self {
        PaneRemote { remote: rule.remote, level: level_name(rule.level).into() }
    }
}

/// The rule for one agent pane (no rule stored: on, full control, as before).
#[tauri::command]
pub fn get_pane_remote(pane_id: String) -> PaneRemote {
    pane_rules::rule(&pane_id).into()
}

/// Change the switch and/or the level of one agent pane. A field left out keeps its value.
#[tauri::command]
pub fn set_pane_remote(pane_id: String, remote: Option<bool>, level: Option<String>) -> Result<PaneRemote, String> {
    let mut rule = pane_rules::rule(&pane_id);
    if let Some(remote) = remote {
        rule.remote = remote;
    }
    if let Some(level) = level {
        rule.level = Level::parse(&level)?;
    }
    pane_rules::set(&pane_id, rule)?;
    crate::audit::record(
        crate::audit::Kind::Pairing,
        crate::audit::Who::Desktop,
        if rule.remote { "You changed what phones may do in one agent" } else { "You switched remote control off for one agent" },
        serde_json::json!({ "pane_id": pane_id, "remote": rule.remote, "level": level_name(rule.level) }),
    );
    Ok(rule.into())
}
