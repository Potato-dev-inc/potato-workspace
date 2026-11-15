//! The Discord bot's settings for one companion: `<app data>/companions/<id>/discord-bot.json`.
//!
//! No secret is ever in this file. The token is in the credential store (`token.rs`).
//!
//! The allow list is closed by default: with no server on it the bot answers nowhere. A load of a missing or
//! damaged file gives the default (off, nothing allowed), and a damaged file is never overwritten by a load.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::companion::store;

pub const FILE: &str = "discord-bot.json";
pub const MAX_SERVERS: usize = 20;
pub const MAX_CHANNELS: usize = 50;
pub const MAX_OWNERS: usize = 10;
pub const MAX_NAMES: usize = 8;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Allow {
    pub guild_id: String,
    pub channels: Vec<String>,
    /// Join in without being called. Off unless the person turns it on for this server.
    pub ambient: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Dms {
    /// Only the owners may write to it in a direct message.
    #[default]
    Owners,
    Off,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum GateChoice {
    #[default]
    Heuristic,
    Llm,
    Chain,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct Budget {
    /// At most this many joined-in replies...
    pub count: u32,
    /// ...in this many minutes, per channel.
    pub minutes: u32,
}

impl Default for Budget {
    fn default() -> Self {
        Self { count: 6, minutes: 30 }
    }
}

/// What the bot may do in a chat. Today only `"none"` exists and nothing can set another value.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct Rules {
    pub tools: String,
}

impl Default for Rules {
    fn default() -> Self {
        Self { tools: "none".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct BotSettings {
    pub on: bool,
    pub allow: Vec<Allow>,
    /// Discord user ids of the people the bot treats as its owner (they may write to it in a direct message).
    pub owners: Vec<String>,
    pub dms: Dms,
    /// What people call it besides a mention.
    pub names: Vec<String>,
    pub gate: GateChoice,
    pub budget: Budget,
    pub rules: Rules,
}

/// A Discord id: 15 to 20 digits.
pub fn valid_snowflake(id: &str) -> bool {
    (15..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

fn dedup(list: &mut Vec<String>) {
    let mut seen = Vec::new();
    list.retain(|item| {
        if seen.contains(item) {
            false
        } else {
            seen.push(item.clone());
            true
        }
    });
}

impl BotSettings {
    /// Cleans what the window sent and refuses what cannot be right. The rules are always `none`.
    pub fn checked(mut self) -> Result<Self, String> {
        self.rules = Rules::default();
        if self.allow.len() > MAX_SERVERS {
            return Err("That is too many servers.".into());
        }
        for entry in &mut self.allow {
            entry.guild_id = entry.guild_id.trim().to_string();
            for c in &mut entry.channels {
                *c = c.trim().to_string();
            }
            entry.channels.retain(|c| !c.is_empty());
            dedup(&mut entry.channels);
            if !valid_snowflake(&entry.guild_id) {
                return Err("A server id is 15 to 20 digits.".into());
            }
            if entry.channels.is_empty() {
                return Err("Add at least one channel for each server.".into());
            }
            if entry.channels.len() > MAX_CHANNELS || entry.channels.iter().any(|c| !valid_snowflake(c)) {
                return Err("A channel id is 15 to 20 digits.".into());
            }
        }
        let mut guilds: Vec<&str> = self.allow.iter().map(|a| a.guild_id.as_str()).collect();
        guilds.sort_unstable();
        guilds.dedup();
        if guilds.len() != self.allow.len() {
            return Err("Each server can be listed once.".into());
        }
        for o in &mut self.owners {
            *o = o.trim().to_string();
        }
        self.owners.retain(|o| !o.is_empty());
        dedup(&mut self.owners);
        if self.owners.len() > MAX_OWNERS || self.owners.iter().any(|o| !valid_snowflake(o)) {
            return Err("An owner id is 15 to 20 digits.".into());
        }
        self.names = self.names.iter().map(|n| n.trim().chars().filter(|c| !c.is_control()).take(24).collect::<String>()).filter(|n| !n.is_empty()).collect();
        dedup(&mut self.names);
        self.names.truncate(MAX_NAMES);
        self.budget.count = self.budget.count.min(20);
        self.budget.minutes = self.budget.minutes.clamp(1, 240);
        Ok(self)
    }
}

/// `<root>/companions/<id>/discord-bot.json`. A bad id gives `None`.
pub fn path_for(root: &Path, companion_id: &str) -> Option<PathBuf> {
    store::companion_dir(root, companion_id).ok().map(|dir| dir.join(FILE))
}

/// The saved settings. A missing or damaged file gives the default (off, nothing allowed). Nothing is written.
pub fn load(root: &Path, companion_id: &str) -> BotSettings {
    let Some(path) = path_for(root, companion_id) else { return BotSettings::default() };
    let Ok(text) = std::fs::read_to_string(path) else { return BotSettings::default() };
    serde_json::from_str::<BotSettings>(&text).ok().and_then(|s| s.checked().ok()).unwrap_or_default()
}

/// Saves after checking. Returns what was saved.
pub fn save(root: &Path, companion_id: &str, settings: BotSettings) -> Result<BotSettings, String> {
    let checked = settings.checked()?;
    let path = path_for(root, companion_id).ok_or_else(|| "No companion has that id.".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "The settings could not be saved.".to_string())?;
    }
    let text = serde_json::to_string_pretty(&checked).map_err(|_| "The settings could not be saved.".to_string())?;
    store::write_private_text(&path, &text).map_err(|_| "The settings could not be saved.".to_string())?;
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: &str = "111111111111111111";
    const C: &str = "222222222222222222";

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-discord-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn one() -> BotSettings {
        BotSettings { allow: vec![Allow { guild_id: G.into(), channels: vec![C.into()], ambient: false }], ..Default::default() }
    }

    #[test]
    fn the_default_is_off_and_answers_nowhere_and_ambient_is_off() {
        let s = BotSettings::default();
        assert!(!s.on && s.allow.is_empty() && s.owners.is_empty());
        assert_eq!(s.dms, Dms::Owners);
        assert_eq!(s.gate, GateChoice::Heuristic);
        assert_eq!(s.rules.tools, "none");
        assert!(!Allow::default().ambient);
    }

    #[test]
    fn the_file_shape_is_the_plan_shape() {
        let json = serde_json::to_value(one()).unwrap();
        assert_eq!(json["allow"][0]["guildId"], G);
        assert_eq!(json["allow"][0]["channels"][0], C);
        assert_eq!(json["allow"][0]["ambient"], false);
        assert_eq!(json["dms"], "owners");
        assert_eq!(json["gate"], "heuristic");
        assert_eq!(json["budget"]["count"], 6);
        assert_eq!(json["rules"]["tools"], "none");
    }

    #[test]
    fn ids_are_checked_and_cleaned() {
        let mut s = one();
        s.allow[0].channels = vec![format!(" {C} "), C.into(), String::new()];
        s.owners = vec![format!(" {G}"), G.into()];
        let s = s.checked().unwrap();
        assert_eq!(s.allow[0].channels, vec![C.to_string()]);
        assert_eq!(s.owners, vec![G.to_string()]);
        for bad in ["12345", "abcdefghijklmnopqr", "1234567890123456789012"] {
            let mut s = one();
            s.allow[0].guild_id = bad.into();
            assert!(s.checked().is_err(), "{bad}");
            let mut s = one();
            s.allow[0].channels = vec![bad.into()];
            assert!(s.checked().is_err(), "{bad}");
        }
        let mut s = one();
        s.allow[0].channels.clear();
        assert_eq!(s.checked().unwrap_err(), "Add at least one channel for each server.");
        let mut twice = one();
        twice.allow.push(twice.allow[0].clone());
        assert!(twice.checked().is_err());
    }

    #[test]
    fn a_rule_other_than_none_is_forced_back_to_none() {
        let mut s = one();
        s.rules.tools = "shell".into();
        assert_eq!(s.checked().unwrap().rules.tools, "none");
        let loaded: BotSettings = serde_json::from_str(r#"{"rules":{"tools":"all"}}"#).unwrap();
        assert_eq!(loaded.checked().unwrap().rules.tools, "none");
    }

    #[test]
    fn budget_and_names_are_bounded() {
        let mut s = one();
        s.budget = Budget { count: 500, minutes: 0 };
        s.names = (0..20).map(|n| format!("name{n}")).collect();
        s.names.push("x".repeat(100));
        let s = s.checked().unwrap();
        assert_eq!((s.budget.count, s.budget.minutes), (20, 1));
        assert_eq!(s.names.len(), MAX_NAMES);
        assert!(s.names.iter().all(|n| n.chars().count() <= 24));
    }

    #[test]
    fn save_then_load_round_trips_and_a_damaged_file_loads_as_the_default_without_being_overwritten() {
        let root = temp_root();
        assert_eq!(load(&root, "mochi"), BotSettings::default());
        assert!(!path_for(&root, "mochi").unwrap().exists(), "a load must not create the file");
        let mut s = one();
        s.on = true;
        let saved = save(&root, "mochi", s.clone()).unwrap();
        assert_eq!(load(&root, "mochi"), saved);
        let path = path_for(&root, "mochi").unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&root, "mochi"), BotSettings::default());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        // A bad companion id has no path at all.
        assert!(path_for(&root, "../x").is_none());
        assert!(save(&root, "../x", one()).is_err());
    }
}
