//! The shelf's own small file (`shelf.json` in the team folder): suggestions I received, what I added
//! through the shelf, and which ids each teammate said they have ("Who has this"). Ids only for the
//! last two. A suggestion holds the cleaned definition (names of keys, never a value).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use super::model::{is_item_id, ItemKind, ShelfItem, MAX_HAVE};

/// Suggestions kept (the oldest go first).
pub const MAX_CARDS: usize = 100;
/// A suggestion nobody answered is dropped after this long.
pub const CARD_TTL_MS: u64 = 30 * 24 * 3600 * 1000;
const MAX_ADDED: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardState {
    #[default]
    New,
    Dismissed,
}

/// A suggestion from a teammate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// The event id: a suggestion that arrives twice is one card.
    pub id: String,
    /// Computed here from the content, never taken from the sender.
    pub item_id: String,
    pub item: ShelfItem,
    /// The signed sender (member id).
    pub by: String,
    /// The sender's name as the event gave it (the roster's name wins when shown).
    pub by_name: String,
    pub why: String,
    pub at_ms: u64,
    /// Sent to the whole team, not to me alone.
    pub everyone: bool,
    #[serde(default)]
    pub state: CardState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub item_id: String,
    pub name: String,
    pub kind: ItemKind,
    pub agents: Vec<String>,
    pub at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Have {
    pub ids: Vec<String>,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfStore {
    #[serde(default)]
    pub cards: Vec<Card>,
    #[serde(default)]
    pub added: Vec<Added>,
    /// Ids I suggested (I have them, so a teammate who adds one sees me in "who has this").
    #[serde(default)]
    pub suggested: Vec<String>,
    /// Teammates' ids by member id.
    #[serde(default)]
    pub have: BTreeMap<String, Have>,
}

impl ShelfStore {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let Ok(text) = serde_json::to_string_pretty(self) else { return };
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }

    /// A suggestion that arrived. False when it is already here (the replay guard) or too old.
    pub fn add_card(&mut self, card: Card, now_ms: u64) -> bool {
        if self.cards.iter().any(|c| c.id == card.id) || now_ms.saturating_sub(card.at_ms) > CARD_TTL_MS {
            return false;
        }
        // The sender has what they suggest.
        let have = self.have.entry(card.by.clone()).or_default();
        if !have.ids.contains(&card.item_id) && have.ids.len() < MAX_HAVE {
            have.ids.push(card.item_id.clone());
        }
        self.cards.push(card);
        self.cards.retain(|c| now_ms.saturating_sub(c.at_ms) <= CARD_TTL_MS);
        while self.cards.len() > MAX_CARDS {
            self.cards.remove(0);
        }
        true
    }

    /// A teammate's list of ids (replaces theirs; an older list never replaces a newer one).
    pub fn set_have(&mut self, member: &str, ids: Vec<String>, at_ms: u64, now_ms: u64) {
        let at_ms = at_ms.min(now_ms);
        if self.have.get(member).is_some_and(|h| h.at_ms > at_ms) {
            return;
        }
        let mut ids: Vec<String> = ids.into_iter().filter(|i| is_item_id(i)).collect();
        ids.sort();
        ids.dedup();
        ids.truncate(MAX_HAVE);
        self.have.insert(member.to_string(), Have { ids, at_ms });
    }

    pub fn dismiss(&mut self, card_id: &str) -> bool {
        match self.cards.iter_mut().find(|c| c.id == card_id) {
            Some(c) => {
                c.state = CardState::Dismissed;
                true
            }
            None => false,
        }
    }

    pub fn mark_added(&mut self, item_id: &str, name: &str, kind: ItemKind, agents: Vec<String>, at_ms: u64) {
        self.added.retain(|a| a.item_id != item_id);
        self.added.push(Added { item_id: item_id.to_string(), name: name.to_string(), kind, agents, at_ms });
        while self.added.len() > MAX_ADDED {
            self.added.remove(0);
        }
    }

    pub fn unmark_added(&mut self, item_id: &str) {
        self.added.retain(|a| a.item_id != item_id);
    }

    pub fn mark_suggested(&mut self, item_id: &str) {
        if !self.suggested.iter().any(|i| i == item_id) {
            self.suggested.push(item_id.to_string());
        }
        while self.suggested.len() > MAX_HAVE {
            self.suggested.remove(0);
        }
    }

    /// The ids I tell teammates I have: what I added through the shelf and what I suggested.
    pub fn my_have(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.added.iter().map(|a| a.item_id.clone()).chain(self.suggested.iter().cloned()).collect();
        ids.sort();
        ids.dedup();
        ids.truncate(MAX_HAVE);
        ids
    }

    /// Drop what teammates who left the team told me.
    pub fn retain_members(&mut self, keep: impl Fn(&str) -> bool) {
        self.have.retain(|m, _| keep(m));
    }
}

static LOCK: Mutex<()> = Mutex::new(());

/// Read, change and save the file under one lock (the transport thread and the cockpit both touch it).
pub fn with<R>(path: &Path, f: impl FnOnce(&mut ShelfStore) -> R) -> R {
    let _guard = LOCK.lock();
    let mut store = ShelfStore::load(path);
    let out = f(&mut store);
    store.save(path);
    out
}

/// A read-only look.
pub fn read(path: &Path) -> ShelfStore {
    let _guard = LOCK.lock();
    ShelfStore::load(path)
}

/// What this PC last told the team it has, and when (memory only).
static LAST_HAVE: Mutex<Option<(Vec<String>, u64)>> = Mutex::new(None);
/// Resend the list this often even when nothing changed, so a teammate who joined later learns it.
pub const HAVE_RESEND_MS: u64 = 30 * 60_000;

/// Whether the list of ids should go out now: it changed, or it was last sent long ago and is not empty.
pub fn have_due(ids: &[String], now_ms: u64) -> bool {
    match &*LAST_HAVE.lock() {
        None => !ids.is_empty(),
        Some((last, at)) => last != ids || (!ids.is_empty() && now_ms.saturating_sub(*at) >= HAVE_RESEND_MS),
    }
}

pub fn have_sent(ids: Vec<String>, now_ms: u64) {
    *LAST_HAVE.lock() = Some((ids, now_ms));
}
