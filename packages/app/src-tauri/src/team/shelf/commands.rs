//! The Shelf tab's commands (Tauri `invoke`, local to this app). They are the person's own clicks: no
//! bridge route, no MCP tool and no phone surface names this module (`tests::no_agent_surface_can_reach_the_shelf`).
//! The definition added is always read from the suggestion this PC stored, never from what the screen sends.

use serde_json::Value;

use super::add;
use super::inbound;
use super::local::{self, Env};
use super::model::{item_id, ShelfItem};
use super::state::{self, Ctx};
use super::store;
use crate::team::service;

/// An update over this size would not fit the relay's limit once sealed.
const MAX_EVENT_BYTES: usize = 16_000;

async fn blocking<T: serde::Serialize + Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<Value, String> {
    let out = tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())??;
    serde_json::to_value(out).map_err(|e| e.to_string())
}

fn ctx_of(c: &service::ShelfCtx) -> Ctx {
    Ctx { me: c.member.clone(), members: c.members.clone() }
}

pub fn state_for(env: &Env, c: &service::ShelfCtx) -> state::ShelfState {
    let local = local::scan(env);
    let store = store::read(&c.file);
    state::build(env, &local, &store, &ctx_of(c))
}

/// What the person has, what was suggested, what the team recommends, who has what.
#[tauri::command]
pub async fn shelf_state() -> Result<Value, String> {
    blocking(|| {
        let c = service::shelf_ctx()?;
        // People who left the team no longer count as having anything.
        store::with(&c.file, |s| s.retain_members(|m| c.members.iter().any(|(id, _)| id == m)));
        Ok(state_for(&Env::live()?, &c))
    })
    .await
}

/// The item to send for a local id, or the sentence why it cannot go. Pure: the commands and the tests share it.
pub fn item_to_send(env: &Env, id: &str) -> Result<ShelfItem, String> {
    let found = local::scan(env).into_iter().find(|l| l.id == id).ok_or("Potato Workspace cannot find that on this PC any more.")?;
    found.item
}

/// Check who it goes to: people on the team, not me. Empty = the whole team.
pub fn check_recipients(c: &service::ShelfCtx, to: &[String]) -> Result<(), String> {
    for id in to {
        if id == &c.member || !c.members.iter().any(|(m, _)| m == id) {
            return Err("Pick people who are on the team.".into());
        }
    }
    Ok(())
}

/// "Suggest to…": the definition goes to those people (nobody picked = everyone). Nothing but the definition travels.
#[tauri::command]
pub async fn shelf_suggest(item_id: String, to: Vec<String>, why: String) -> Result<Value, String> {
    blocking(move || {
        let c = service::shelf_ctx()?;
        check_recipients(&c, &to)?;
        let item = item_to_send(&Env::live()?, &item_id)?;
        let id = item_id_of(&item);
        let probe = inbound::suggest_event(&c.team, &c.member, &c.device, &c.name, &item, to.clone(), &why, 0);
        if serde_json::to_string(&probe).map_or(true, |t| t.len() > MAX_EVENT_BYTES) {
            return Err("This is too big to send.".into());
        }
        service::shelf_send(|ctx, now| inbound::suggest_event(&ctx.team, &ctx.member, &ctx.device, &ctx.name, &item, to.clone(), &why, now))?;
        store::with(&c.file, |s| s.mark_suggested(&id));
        service::shelf_changed();
        Ok(serde_json::json!({ "sent": true, "id": id }))
    })
    .await
}

fn item_id_of(item: &ShelfItem) -> String {
    item_id(item)
}

fn card_item(c: &service::ShelfCtx, card_id: &str) -> Result<ShelfItem, String> {
    store::read(&c.file).cards.into_iter().find(|card| card.id == card_id).map(|card| card.item).ok_or_else(|| "That suggestion is not there any more.".to_string())
}

/// Exactly what Add would write for these agents. Writes nothing.
#[tauri::command]
pub async fn shelf_preview(card_id: String, agents: Vec<String>) -> Result<Value, String> {
    blocking(move || {
        let c = service::shelf_ctx()?;
        let item = card_item(&c, &card_id)?;
        add::preview(&Env::live()?, &item, &agents)
    })
    .await
}

/// Add the suggestion to the agents picked. `trusted` is the person's "I trust this" tick.
#[tauri::command]
pub async fn shelf_add(card_id: String, agents: Vec<String>, trusted: bool) -> Result<Value, String> {
    blocking(move || {
        let c = service::shelf_ctx()?;
        let item = card_item(&c, &card_id)?;
        let done = add::apply(&Env::live()?, &item, &agents, trusted)?;
        store::with(&c.file, |s| s.mark_added(&done.id, &done.name, done.kind, done.agent_ids.clone(), service::now_ms()));
        service::shelf_changed();
        Ok(done)
    })
    .await
}

/// Take the last add back (a file that changed since is left alone).
#[tauri::command]
pub async fn shelf_undo(token: String, item_id: String) -> Result<Value, String> {
    blocking(move || {
        let c = service::shelf_ctx()?;
        let out = add::undo(&Env::live()?, &token)?;
        store::with(&c.file, |s| s.unmark_added(&item_id));
        service::shelf_changed();
        Ok(out)
    })
    .await
}

/// "Not for me".
#[tauri::command]
pub async fn shelf_dismiss(card_id: String) -> Result<Value, String> {
    blocking(move || {
        let c = service::shelf_ctx()?;
        let done = store::with(&c.file, |s| s.dismiss(&card_id));
        service::shelf_changed();
        Ok(done)
    })
    .await
}
