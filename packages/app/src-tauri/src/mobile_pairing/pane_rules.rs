//! Per-agent remote rules: which agents a paired phone may reach, and how far.
//!
//! A phone's own caps ([`Caps`]) say what it may do anywhere. A pane rule narrows that for one agent
//! pane: the switch "Remote control" (off: no read, no answer, no input) and a level (watch only,
//! watch and answer, full). The rule never widens anything: the phone still needs its own cap, and
//! [`allows`] only takes more away. An agent with no stored rule behaves as before (on, full), so
//! nothing changes until the person flips a switch. The local app is never limited by these rules.
//!
//! The rules are kept in `pane-remote.json` next to the pairing file; only rules that differ from the
//! default are written. The agent's name stays in the pane list for every phone either way.

use super::{Cap, Caps};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Keep the file small: a person never has this many switched agents, and old panes' rules go away
/// when set back to the default.
const MAX_RULES: usize = 500;

/// How far a phone may go in one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// See the agent only.
    Watch,
    /// See it and answer its questions.
    Answer,
    /// Everything the phone itself may do (type, control).
    #[default]
    Full,
}

impl Level {
    /// The most this level lets a phone do.
    pub fn caps(self) -> Caps {
        match self {
            Level::Watch => Caps::none().with(Cap::Watch, true),
            Level::Answer => Caps::watch_and_answer(),
            Level::Full => Caps::all(),
        }
    }

    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim() {
            "watch" => Ok(Level::Watch),
            "answer" => Ok(Level::Answer),
            "full" => Ok(Level::Full),
            other => Err(format!("unknown level {other:?}")),
        }
    }
}

fn on() -> bool {
    true
}

/// One agent's rule. The default is today's behaviour: on, full.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneRule {
    #[serde(default = "on")]
    pub remote: bool,
    #[serde(default)]
    pub level: Level,
}

impl Default for PaneRule {
    fn default() -> Self {
        PaneRule { remote: true, level: Level::Full }
    }
}

impl PaneRule {
    /// Whether a phone may use `cap` here. A switched-off agent allows nothing, `Watch` included.
    pub fn allows(&self, cap: Cap) -> bool {
        self.remote && self.level.caps().has(cap)
    }
}

/// All rules, by pane id.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PaneRules {
    #[serde(default)]
    rules: HashMap<String, PaneRule>,
}

impl PaneRules {
    pub fn rule(&self, pane_id: &str) -> PaneRule {
        self.rules.get(pane_id).copied().unwrap_or_default()
    }

    /// `true` when `cap` is refused for this pane (no rule: never refused).
    pub fn refuses(&self, pane_id: &str, cap: Cap) -> bool {
        self.rules.get(pane_id).is_some_and(|rule| !rule.allows(cap))
    }

    /// Whether any agent is switched off (a cheap test before parsing event payloads).
    pub fn any_off(&self) -> bool {
        self.rules.values().any(|rule| !rule.remote)
    }

    pub fn is_off(&self, pane_id: &str) -> bool {
        self.rules.get(pane_id).is_some_and(|rule| !rule.remote)
    }

    /// Store a rule; the default rule is removed instead of written.
    pub fn set(&mut self, pane_id: &str, rule: PaneRule) -> Result<(), String> {
        if pane_id.trim().is_empty() || pane_id.len() > 200 {
            return Err("pane id is not valid".into());
        }
        if rule == PaneRule::default() {
            self.rules.remove(pane_id);
        } else if self.rules.contains_key(pane_id) || self.rules.len() < MAX_RULES {
            self.rules.insert(pane_id.to_string(), rule);
        } else {
            return Err("too many agents have their own remote rule; set some back to the default".into());
        }
        Ok(())
    }

    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("write {}: {e}", path.display()))
    }
}

static RULES: once_cell::sync::Lazy<RwLock<PaneRules>> = once_cell::sync::Lazy::new(Default::default);
static RULES_PATH: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();

/// Load the rules that sit next to the pairing file (called when the bridge starts).
pub fn init(pairing_file: &Path) {
    let path = pairing_file.with_file_name("pane-remote.json");
    // The first call wins (the bridge starts once; a test may call this again with another folder).
    if RULES_PATH.set(path.clone()).is_ok() {
        *RULES.write() = PaneRules::load(&path);
    }
}

pub fn rule(pane_id: &str) -> PaneRule {
    RULES.read().rule(pane_id)
}

/// `true` when a phone may not use `cap` on this agent (switched off, or the level is lower).
pub fn refuses(pane_id: &str, cap: Cap) -> bool {
    RULES.read().refuses(pane_id, cap)
}

/// Change one agent's rule and keep it on disk. A failed write leaves the old rule in place.
pub fn set(pane_id: &str, rule: PaneRule) -> Result<(), String> {
    let mut rules = RULES.write();
    let mut next = PaneRules { rules: rules.rules.clone() };
    next.set(pane_id, rule)?;
    if let Some(path) = RULES_PATH.get() {
        next.save(path)?;
    }
    *rules = next;
    Ok(())
}

/// The pane a bridge route is about: `/panes/{id}/...`. The four wait routes live under `/panes/wait`
/// and the bare list has no id; neither names a pane.
pub fn pane_of_route<'a>(segments: &[&'a str]) -> Option<&'a str> {
    match segments {
        ["panes", "wait", ..] | ["panes"] | [] => None,
        ["panes", id, ..] => Some(id),
        _ => None,
    }
}

/// What a switched-off agent still shows a phone: the list (its name), its status and size.
const OFF_KEEPS: &[&str] = &["panes", "pane-status", "pane-resize"];

/// Whether an event-stream payload carries content of an agent that is switched off, so a phone must not get it.
pub fn hides_event(payload: &str) -> bool {
    let rules = RULES.read();
    rules.any_off() && event_hidden(&rules, payload)
}

fn event_hidden(rules: &PaneRules, payload: &str) -> bool {
    let Some(rest) = payload.strip_prefix("event: ") else { return false };
    let Some((name, data)) = rest.split_once("\ndata: ") else { return false };
    if OFF_KEEPS.contains(&name) {
        return false;
    }
    let body = data.strip_suffix("\n\n").unwrap_or(data);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else { return false };
    let pane = value
        .get("pane_id")
        .or_else(|| value.get("signal").and_then(|signal| signal.get("pane_id")))
        .and_then(|id| id.as_str());
    pane.is_some_and(|id| rules.is_off(id))
}

#[cfg(test)]
#[path = "pane_rules_tests.rs"]
mod tests;
