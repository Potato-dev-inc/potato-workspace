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

/// A time-limited raise ("Allow 15 min"): the rule that applies again when `until_ms` passes. It is kept in the
/// rules file, so the raise ends on time even when the app was closed in between.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub before: PaneRule,
    pub until_ms: u64,
}

/// All rules, by pane id.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PaneRules {
    #[serde(default)]
    rules: HashMap<String, PaneRule>,
    #[serde(default)]
    grants: HashMap<String, Grant>,
}

impl PaneRules {
    pub fn rule(&self, pane_id: &str) -> PaneRule {
        self.rules.get(pane_id).copied().unwrap_or_default()
    }

    /// `true` when `cap` is refused for this pane (no rule: never refused).
    pub fn refuses(&self, pane_id: &str, cap: Cap) -> bool {
        self.rules.get(pane_id).is_some_and(|rule| !rule.allows(cap))
    }

    /// The rule at `now`: a grant that has ended counts as gone, so the rule from before applies.
    pub fn rule_at(&self, pane_id: &str, now: u64) -> PaneRule {
        match self.grants.get(pane_id) {
            Some(grant) if grant.until_ms <= now => grant.before,
            _ => self.rule(pane_id),
        }
    }

    pub fn refuses_at(&self, pane_id: &str, cap: Cap, now: u64) -> bool {
        !self.rule_at(pane_id, now).allows(cap)
    }

    /// Raise an agent to on/full until `until_ms`; `before` comes back after. A second grant keeps the first `before`.
    pub fn grant(&mut self, pane_id: &str, before: PaneRule, until_ms: u64) -> Result<(), String> {
        let before = self.grants.get(pane_id).map(|g| g.before).unwrap_or(before);
        self.set(pane_id, PaneRule::default())?;
        self.grants.insert(pane_id.to_string(), Grant { before, until_ms });
        Ok(())
    }

    /// Put back the rule of every grant that ended by `now`. `true` when anything changed.
    pub fn expire(&mut self, now: u64) -> bool {
        let due: Vec<String> = self.grants.iter().filter(|(_, g)| g.until_ms <= now).map(|(pane, _)| pane.clone()).collect();
        for pane in &due {
            if let Some(grant) = self.grants.remove(pane) {
                if self.set(pane, grant.before).is_err() {
                    self.rules.remove(pane);
                }
            }
        }
        !due.is_empty()
    }

    pub fn grant_of(&self, pane_id: &str) -> Option<Grant> {
        self.grants.get(pane_id).copied()
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
        // Rules set before the file was known stay (the app sets none before this; a test may): the file adds to them.
        let mut rules = RULES.write();
        let mut loaded = PaneRules::load(&path);
        loaded.rules.extend(rules.rules.drain());
        loaded.grants.extend(rules.grants.drain());
        *rules = loaded;
    }
}

/// End every grant that is over at `now` and write the result back. A failed write still lowers the
/// rule in memory: the safe side is the lower level.
pub fn settle_at(now: u64) {
    if !RULES.read().grants.values().any(|g| g.until_ms <= now) {
        return;
    }
    let mut rules = RULES.write();
    if rules.expire(now) {
        if let Some(path) = RULES_PATH.get() {
            if let Err(error) = rules.save(path) {
                tracing::warn!(%error, "could not save the remote rules after a grant ended");
            }
        }
    }
}

/// Clean grants that ended while the app was closed (called when the bridge starts).
pub fn settle_on_start() {
    settle_at(super::control_ask::now_ms());
}

pub fn rule(pane_id: &str) -> PaneRule {
    rule_at(pane_id, super::control_ask::now_ms())
}

pub fn rule_at(pane_id: &str, now: u64) -> PaneRule {
    settle_at(now);
    RULES.read().rule_at(pane_id, now)
}

/// `true` when a phone may not use `cap` on this agent (switched off, or the level is lower).
pub fn refuses(pane_id: &str, cap: Cap) -> bool {
    refuses_at(pane_id, cap, super::control_ask::now_ms())
}

pub fn refuses_at(pane_id: &str, cap: Cap, now: u64) -> bool {
    settle_at(now);
    RULES.read().refuses_at(pane_id, cap, now)
}

/// Every agent that has its own rule (not the default), for the phone's lock icons.
pub fn all() -> Vec<(String, PaneRule)> {
    settle_at(super::control_ask::now_ms());
    RULES.read().rules.iter().map(|(pane, rule)| (pane.clone(), *rule)).collect()
}

fn store(next: PaneRules, mut rules: parking_lot::RwLockWriteGuard<'_, PaneRules>) -> Result<(), String> {
    if let Some(path) = RULES_PATH.get() {
        next.save(path)?;
    }
    *rules = next;
    Ok(())
}

fn copy_of(rules: &PaneRules) -> PaneRules {
    PaneRules { rules: rules.rules.clone(), grants: rules.grants.clone() }
}

/// The person changes one agent's rule and it is kept on disk. A running grant for the agent ends (their
/// choice wins). A failed write leaves the old rule in place.
pub fn set(pane_id: &str, rule: PaneRule) -> Result<(), String> {
    let rules = RULES.write();
    let mut next = copy_of(&rules);
    next.grants.remove(pane_id);
    next.set(pane_id, rule)?;
    store(next, rules)
}

/// Raise an agent to on/full until `until_ms`; the rule from before comes back by itself after.
pub fn grant(pane_id: &str, until_ms: u64) -> Result<(), String> {
    let now = super::control_ask::now_ms();
    settle_at(now);
    let rules = RULES.write();
    let mut next = copy_of(&rules);
    let before = rules.rule(pane_id);
    next.grant(pane_id, before, until_ms)?;
    store(next, rules)
}

/// The rule that comes back when the running grant for this agent ends.
pub fn grant_before(pane_id: &str) -> Option<PaneRule> {
    RULES.read().grant_of(pane_id).map(|g| g.before)
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
    settle_at(super::control_ask::now_ms());
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
