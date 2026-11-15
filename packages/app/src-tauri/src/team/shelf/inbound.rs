//! Shelf events on the wire: building mine, reading a teammate's.
//!
//! A suggestion is a sealed team event of kind `shelf.suggest` whose `to` names who it is for (nobody =
//! the whole team). It is read where presence is read (`service::open_and_ingest`) and goes no further:
//! never a card in the Feed, never in `team_events`, never remembered as a seen event. What it carries is
//! untrusted: [`ShelfItem::clean`] runs again here, the id is computed here, and the sender is the signed
//! member, never a name the event claims.

use super::model::{is_item_id, item_id, ShelfItem, ShelfPayload, MAX_HAVE, MAX_WHY_CHARS};
use super::store::{Card, CardState};
use crate::team::config::TeamConfig;
use crate::team::event::{self, clean_text, new_event_id, Actor, EventSource, ProjectRef, Subject, TeamEvent, TeamEventKind, Tier, SCHEMA_VERSION};

/// The project key every shelf event carries (the schema needs one; it names nothing).
pub const PROJECT_KEY: &str = "shelf";
/// A "have" list is worth nothing after this.
pub const HAVE_TTL_MS: u64 = 2 * 3600 * 1000;

fn base(team: &str, member: &str, device: &str, display: &str, kind: TeamEventKind, shelf: ShelfPayload, now: u64) -> TeamEvent {
    TeamEvent {
        v: SCHEMA_VERSION,
        id: new_event_id(now),
        team: team.to_string(),
        project: ProjectRef { key: PROJECT_KEY.into(), name: String::new() },
        actor: Actor { member: member.to_string(), device: device.to_string(), display: display.to_string(), agent: None },
        kind,
        at_ms: now,
        subject: Subject { shelf: Some(shelf), ..Subject::default() },
        note: None,
        to: vec![],
        tier_hint: Tier::Digest,
        dedupe_key: PROJECT_KEY.into(),
        expires_at_ms: now + event::DEFAULT_TTL_MS,
        source: EventSource::Pm,
    }
}

/// "I suggest this to you" for `to` (empty = everyone). `why` is cut to [`MAX_WHY_CHARS`].
#[allow(clippy::too_many_arguments)]
pub fn suggest_event(team: &str, member: &str, device: &str, display: &str, item: &ShelfItem, to: Vec<String>, why: &str, now: u64) -> TeamEvent {
    let mut event = base(team, member, device, display, TeamEventKind::ShelfSuggest, ShelfPayload { item: Some(item.clone()), have: vec![] }, now);
    event.to = to;
    event.note = Some(clean_text(why, MAX_WHY_CHARS)).filter(|n| !n.is_empty());
    event
}

/// "These are the ids I have."
pub fn have_event(team: &str, member: &str, device: &str, display: &str, ids: Vec<String>, now: u64) -> TeamEvent {
    let mut event = base(team, member, device, display, TeamEventKind::ShelfHave, ShelfPayload { item: None, have: ids }, now);
    event.expires_at_ms = now + HAVE_TTL_MS;
    event
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    Suggest(Card),
    Have { member: String, ids: Vec<String>, at_ms: u64 },
}

/// A shelf event that passed every check: from a verified member other than me, for this team, in the
/// schema's limits. A suggestion for somebody else is not mine. `None` otherwise.
pub fn read(config: &TeamConfig, member: &str, event: TeamEvent, now: u64) -> Option<Read> {
    let event = event::validate_inbound(event, now).ok()?;
    if event.team != config.team || member.is_empty() || (!config.me.id.is_empty() && member == config.me.id) {
        return None;
    }
    let payload = event.subject.shelf.clone()?;
    match event.kind {
        TeamEventKind::ShelfSuggest => {
            let everyone = event.to.is_empty();
            if !everyone && !event.to.iter().any(|t| t == &config.me.id) {
                return None;
            }
            let item = payload.item?.clean()?;
            Some(Read::Suggest(Card {
                id: event.id.clone(),
                item_id: item_id(&item),
                item,
                by: member.to_string(),
                by_name: clean_text(&event.actor.display, 40),
                why: clean_text(event.note.as_deref().unwrap_or(""), MAX_WHY_CHARS),
                at_ms: event.at_ms.min(now),
                everyone,
                state: CardState::New,
            }))
        }
        TeamEventKind::ShelfHave => {
            let ids: Vec<String> = payload.have.into_iter().filter(|i| is_item_id(i)).take(MAX_HAVE).collect();
            Some(Read::Have { member: member.to_string(), ids, at_ms: event.at_ms })
        }
        _ => None,
    }
}
