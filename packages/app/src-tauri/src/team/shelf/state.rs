//! What the Shelf tab shows, built from three things: what this PC has, what teammates suggested and
//! who says they have what. Pure (no I/O besides reading the local scan), so the screen test and the
//! Rust tests see the same data.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

use super::gate::{self, Risk};
use super::local::{self, Env, LocalItem, Target};
use super::model::{item_id, ItemKind, ShelfItem, ToolTransport};
use super::store::{CardState, ShelfStore};

/// Who is on the team (member id, name), me included.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub me: String,
    pub members: Vec<(String, String)>,
}

impl Ctx {
    fn name(&self, id: &str) -> Option<&str> {
        self.members.iter().find(|(m, _)| m == id).map(|(_, n)| n.as_str())
    }
}

/// Something this PC has.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MineView {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub about: String,
    pub source: &'static str,
    /// Labels of the agents it is in.
    pub agents: Vec<String>,
    pub shareable: bool,
    /// Why it cannot be shared, in a sentence.
    pub reason: Option<String>,
    pub needs: Vec<String>,
    pub shown: String,
    pub skipped_files: u32,
    /// Names of teammates who have it.
    pub have: Vec<String>,
    /// I sent it to the team (or a teammate).
    pub suggested: bool,
    /// Not shareable as it is, but it starts a published package: the public install line can be suggested instead.
    pub install: Option<InstallView>,
}

/// The public install line of a tool (never a folder of this PC): its own id, and the line the person is shown.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallView {
    pub id: String,
    pub shown: String,
}

/// A suggestion, or an item the team recommends.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardView {
    pub card_id: String,
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub about: String,
    pub by: String,
    pub by_name: String,
    pub why: String,
    pub at_ms: u64,
    pub everyone: bool,
    pub needs: Vec<String>,
    pub shown: String,
    pub risk: Option<Risk>,
    pub skipped_files: u32,
    /// From a newer build: listed, cannot be added.
    pub unknown: bool,
    /// Already on this PC (found, or added through the shelf).
    pub here: bool,
    pub have: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recommended {
    pub id: String,
    pub card_id: String,
    pub kind: &'static str,
    pub name: String,
    pub about: String,
    pub by_names: Vec<String>,
    pub have: Vec<String>,
    pub here: bool,
    pub unknown: bool,
    pub needs: Vec<String>,
    pub shown: String,
    pub risk: Option<Risk>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfState {
    pub targets: Vec<Target>,
    pub mine: Vec<MineView>,
    /// Suggested to me alone and not answered.
    pub suggested: Vec<CardView>,
    /// What the whole team (or two people) recommends.
    pub recommended: Vec<Recommended>,
    /// People on the team besides me, for the Suggest menu.
    pub people: Vec<Person>,
    pub team_size: usize,
    /// How many suggestions wait for me (the tab number).
    pub waiting: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
}

pub fn kind_word(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Skill => "skill",
        ItemKind::Tool => "tool",
        ItemKind::Unknown => "unknown",
    }
}

fn shown_of(item: &ShelfItem) -> String {
    match &item.tool {
        Some(t) => match t.transport {
            Some(ToolTransport::Http) => t.url.clone().unwrap_or_default(),
            _ => gate::assess(t).shown,
        },
        None => String::new(),
    }
}

fn have_names(store: &ShelfStore, ctx: &Ctx, id: &str, mine: bool) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if mine {
        names.push(ctx.name(&ctx.me).unwrap_or("You").to_string());
    }
    for (member, have) in &store.have {
        if member != &ctx.me && have.ids.iter().any(|i| i == id) {
            if let Some(n) = ctx.name(member) {
                names.push(n.to_string());
            }
        }
    }
    names
}

fn mine_view(l: &LocalItem, store: &ShelfStore, ctx: &Ctx) -> MineView {
    let (about, needs, shown, skipped) = match &l.item {
        Ok(i) => (i.about.clone(), i.needs(), shown_of(i), i.skipped_files),
        Err(_) => (String::new(), vec![], String::new(), 0),
    };
    MineView {
        id: l.id.clone(),
        kind: l.kind,
        name: l.name.clone(),
        about,
        source: l.source,
        agents: l.agents.iter().map(|a| a.label.clone()).collect(),
        shareable: l.item.is_ok(),
        reason: l.item.as_ref().err().cloned(),
        needs,
        shown,
        skipped_files: skipped,
        have: have_names(store, ctx, &l.id, false),
        suggested: store.suggested.iter().any(|i| i == &l.id),
        install: l.install.as_ref().map(|i| InstallView { id: item_id(i), shown: shown_of(i) }),
    }
}

/// The whole tab. `local` is `local::scan(env)` (passed in so a test can use a fixed list).
pub fn build(env: &Env, local: &[LocalItem], store: &ShelfStore, ctx: &Ctx) -> ShelfState {
    let here_ids: BTreeSet<&str> = local.iter().map(|l| l.id.as_str()).chain(store.added.iter().map(|a| a.item_id.as_str())).collect();
    let mine: Vec<MineView> = local.iter().map(|l| mine_view(l, store, ctx)).collect();

    let live: Vec<_> = store.cards.iter().filter(|c| c.state == CardState::New).collect();
    let card_view = |c: &super::store::Card| CardView {
        card_id: c.id.clone(),
        id: c.item_id.clone(),
        kind: kind_word(c.item.kind),
        name: c.item.name.clone(),
        about: c.item.about.clone(),
        by: c.by.clone(),
        by_name: ctx.name(&c.by).map(str::to_string).unwrap_or_else(|| c.by_name.clone()),
        why: c.why.clone(),
        at_ms: c.at_ms,
        everyone: c.everyone,
        needs: c.item.needs(),
        shown: shown_of(&c.item),
        risk: c.item.tool.as_ref().map(gate::assess),
        skipped_files: c.item.skipped_files,
        unknown: c.item.kind == ItemKind::Unknown,
        here: here_ids.contains(c.item_id.as_str()),
        have: have_names(store, ctx, &c.item_id, here_ids.contains(c.item_id.as_str())),
    };
    let suggested: Vec<CardView> = live.iter().rev().filter(|c| !c.everyone && !here_ids.contains(c.item_id.as_str())).map(|c| card_view(c)).collect();

    // Team recommends: suggested to everyone, or by two different people. Grouped by content.
    let mut groups: BTreeMap<&str, Vec<&super::store::Card>> = BTreeMap::new();
    for c in &live {
        groups.entry(c.item_id.as_str()).or_default().push(c);
    }
    let mut recommended: Vec<Recommended> = groups
        .into_values()
        .filter(|cards| cards.iter().any(|c| c.everyone) || cards.iter().map(|c| c.by.as_str()).collect::<BTreeSet<_>>().len() >= 2)
        .map(|cards| {
            let last = cards.iter().max_by_key(|c| c.at_ms).copied().unwrap_or(cards[0]);
            let mut by_names: Vec<String> = Vec::new();
            for c in &cards {
                let n = ctx.name(&c.by).map(str::to_string).unwrap_or_else(|| c.by_name.clone());
                if !by_names.contains(&n) {
                    by_names.push(n);
                }
            }
            let here = here_ids.contains(last.item_id.as_str());
            Recommended {
                id: last.item_id.clone(),
                card_id: last.id.clone(),
                kind: kind_word(last.item.kind),
                name: last.item.name.clone(),
                about: last.item.about.clone(),
                by_names,
                have: have_names(store, ctx, &last.item_id, here),
                here,
                unknown: last.item.kind == ItemKind::Unknown,
                needs: last.item.needs(),
                shown: shown_of(&last.item),
                risk: last.item.tool.as_ref().map(gate::assess),
            }
        })
        .collect();
    recommended.sort_by(|a, b| b.by_names.len().cmp(&a.by_names.len()).then(a.name.cmp(&b.name)));

    let waiting = suggested.len() + recommended.iter().filter(|r| !r.here && !r.unknown).count();
    ShelfState {
        targets: local::targets(env),
        mine,
        suggested,
        recommended,
        people: ctx.members.iter().filter(|(id, _)| id != &ctx.me).map(|(id, name)| Person { id: id.clone(), name: name.clone() }).collect(),
        team_size: ctx.members.len(),
        waiting,
    }
}
