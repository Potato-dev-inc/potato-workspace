//! Presence on the Team page: who is here, who is away, and (only when they turn it on) which
//! project they work in and the title of their chat.
//!
//! What a person shares is their own choice ([`ShareLevel`], default `here`). The rules live here,
//! in Rust, so the cockpit cannot send more than the level allows:
//! - `nothing`: no event at all (one `gone` when the person switches to it, so others stop showing them);
//! - `here`: here or away, nothing else (no project, no title, no counts);
//! - `project`: also the project folder's name and how many agents run or wait;
//! - `title`: also the chat's title (never the chat itself).
//!
//! A project the person excluded is shared as `here` only. Project and title go through
//! `redact::strict` and are cut to [`MAX_WORDS`] characters before they are sealed. On the way in,
//! a teammate's presence is untrusted: cleaned, cut again, clamped in time, and kept in memory only
//! (never stored, never a card, never in `team_events`).

use super::event::{clean_text, new_event_id, Actor, EventSource, ProjectRef, Subject, TeamEvent, TeamEventKind, Tier, Working, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A beat while the person is here.
pub const BEAT_MS: u64 = 60_000;
/// A state older than this reads as not here.
pub const STALE_MS: u64 = 180_000;
/// The cockpit reports every 30 s; without a report this fresh nothing is sent (the app is closed or frozen).
pub const REPORT_FRESH_MS: u64 = 90_000;
/// Longest project name or chat title, in characters.
pub const MAX_WORDS: usize = 80;
/// A presence event is worth nothing after this.
pub const TTL_MS: u64 = 5 * 60_000;
/// Agent counts are shown up to here.
const MAX_COUNT: u32 = 99;
/// The project key every presence event carries (the schema needs one; it names nothing).
pub const PROJECT_KEY: &str = "presence";

/// What a person shares. `here` is the default: presence is expected on a team; project and title are a choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareLevel {
    Nothing,
    #[default]
    Here,
    Project,
    Title,
}

/// Where a person stands. `Gone` is "going away for good": quit, or sharing switched off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Here,
    Away,
    Gone,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Here => "here",
            Self::Away => "away",
            Self::Gone => "gone",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "here" => Some(Self::Here),
            "away" => Some(Self::Away),
            "gone" => Some(Self::Gone),
            _ => None,
        }
    }
}

/// The raw facts the cockpit reports about this person, every 30 s and when they change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// No input for 5 minutes (or the screen is locked).
    #[serde(default)]
    pub away: bool,
    #[serde(default)]
    pub project_name: Option<String>,
    /// The folder, used only to match the "not for these projects" list. Never sent.
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub running: u32,
    #[serde(default)]
    pub waiting: u32,
}

/// What goes on the wire after the share level was applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shared {
    pub state: State,
    pub project: Option<String>,
    pub title: Option<String>,
    pub running: u32,
    pub waiting: u32,
}

fn norm_path(path: &str) -> String {
    path.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Whether `path` is one of the folders the person keeps private (or inside one).
pub fn is_excluded(exclude: &[String], path: Option<&str>) -> bool {
    let Some(path) = path.map(norm_path).filter(|p| !p.is_empty()) else { return false };
    exclude.iter().map(|e| norm_path(e)).filter(|e| !e.is_empty()).any(|e| path == e || path.starts_with(&format!("{e}/")))
}

/// Text that leaves this PC: secrets and key-shaped runs removed, plain text, cut to [`MAX_WORDS`].
fn outgoing_text(raw: &str) -> Option<String> {
    let redacted = crate::redact::strict(raw).into_inner();
    let text = clean_text(&redacted, MAX_WORDS);
    (!text.is_empty()).then_some(text)
}

/// The share level applied to a report: what may be sent. `None`: nothing at all.
pub fn share(level: ShareLevel, exclude: &[String], report: &Report) -> Option<Shared> {
    let state = if report.away { State::Away } else { State::Here };
    let here_only = Shared { state, project: None, title: None, running: 0, waiting: 0 };
    match level {
        ShareLevel::Nothing => None,
        ShareLevel::Here => Some(here_only),
        ShareLevel::Project | ShareLevel::Title => {
            if is_excluded(exclude, report.project_path.as_deref()) {
                return Some(here_only);
            }
            Some(Shared {
                state,
                project: report.project_name.as_deref().and_then(outgoing_text),
                title: if level == ShareLevel::Title { report.title.as_deref().and_then(outgoing_text) } else { None },
                running: report.running.min(MAX_COUNT),
                waiting: report.waiting.min(MAX_COUNT),
            })
        }
    }
}

/// What this PC last sent, so a beat only goes when something changed or a minute passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub shared: Shared,
    pub at_ms: u64,
}

/// What the next beat should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Beat {
    Nothing,
    Send(Shared),
    /// Tell the team this person is no longer here (sharing switched off).
    Gone,
}

/// Decide the next beat. Pure: the clock and the reports are passed in.
pub fn plan_beat(level: ShareLevel, exclude: &[String], report: Option<(&Report, u64)>, last: Option<&Sent>, now: u64) -> Beat {
    let was_visible = last.is_some_and(|s| s.shared.state != State::Gone);
    let Some((report, reported_at)) = report.filter(|(_, at)| now.saturating_sub(*at) <= REPORT_FRESH_MS) else {
        // No fresh report: the app is closed or frozen. Say nothing; others fade after STALE_MS.
        return if level == ShareLevel::Nothing && was_visible { Beat::Gone } else { Beat::Nothing };
    };
    let _ = reported_at;
    let Some(next) = share(level, exclude, report) else {
        return if was_visible { Beat::Gone } else { Beat::Nothing };
    };
    match last {
        Some(sent) if sent.shared == next && now.saturating_sub(sent.at_ms) < BEAT_MS => Beat::Nothing,
        _ => Beat::Send(next),
    }
}

/// The presence event this PC seals. `member` / `device` / `display` are mine.
pub fn build_event(team: &str, member: &str, device: &str, display: &str, shared: &Shared, now: u64) -> TeamEvent {
    let working = (shared.project.is_some() || shared.title.is_some() || shared.running > 0 || shared.waiting > 0).then(|| Working {
        project: shared.project.clone(),
        title: shared.title.clone(),
        running: shared.running,
        waiting: shared.waiting,
    });
    TeamEvent {
        v: SCHEMA_VERSION,
        id: new_event_id(now),
        team: team.to_string(),
        project: ProjectRef { key: PROJECT_KEY.into(), name: String::new() },
        actor: Actor { member: member.to_string(), device: device.to_string(), display: display.to_string(), agent: None },
        kind: TeamEventKind::Presence,
        at_ms: now,
        subject: Subject { presence: Some(shared.state.as_str().to_string()), working, ..Subject::default() },
        note: None,
        to: vec![],
        tier_hint: Tier::Digest,
        dedupe_key: PROJECT_KEY.into(),
        expires_at_ms: now + TTL_MS,
        source: EventSource::Pm,
    }
}

/// A teammate's presence, read from an event that already passed `validate_inbound`: the state, and
/// the words cleaned again and cut. `None` when it is not a presence event or says something unknown.
pub fn read_event(event: &TeamEvent) -> Option<Shared> {
    if event.kind != TeamEventKind::Presence {
        return None;
    }
    let state = State::parse(event.subject.presence.as_deref()?)?;
    let working = event.subject.working.clone().unwrap_or_default();
    let words = |w: Option<String>| w.map(|t| clean_text(&t, MAX_WORDS)).filter(|t| !t.is_empty());
    Some(Shared {
        state,
        project: words(working.project),
        title: words(working.title),
        running: working.running.min(MAX_COUNT),
        waiting: working.waiting.min(MAX_COUNT),
    })
}

/// One teammate, as the table keeps them (memory only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub shared: Shared,
    /// When the last beat arrived (clamped to now when dated in the future).
    pub at_ms: u64,
    /// When the state last changed (here to away and back).
    pub since_ms: u64,
}

/// Teammates' presence by member id. Never stored on disk.
#[derive(Debug, Default, Clone)]
pub struct Table {
    entries: HashMap<String, Entry>,
}

/// One row of the Team page (`team_state`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub member: String,
    /// `here`, `away` or `gone`. Stale (no beat for [`STALE_MS`]) reads as `gone`.
    pub state: &'static str,
    pub at_ms: u64,
    pub since_ms: u64,
    pub project: Option<String>,
    pub title: Option<String>,
    pub running: u32,
    pub waiting: u32,
}

impl Table {
    /// A beat from `member` (the verified sender, never a name the event claims) dated `at_ms`.
    pub fn apply(&mut self, member: &str, shared: Shared, at_ms: u64, now: u64) {
        // A beat dated ahead of now (clock skew) counts as now.
        let at = at_ms.min(now);
        match self.entries.get_mut(member) {
            // An older beat arriving late never overwrites a newer one.
            Some(old) if at < old.at_ms => {}
            Some(old) => {
                let since = if old.shared.state == shared.state { old.since_ms } else { at };
                *old = Entry { shared, at_ms: at, since_ms: since };
            }
            None => {
                self.entries.insert(member.to_string(), Entry { shared, at_ms: at, since_ms: at });
            }
        }
    }

    /// Keep only people still on the roster.
    pub fn retain_members(&mut self, keep: impl Fn(&str) -> bool) {
        self.entries.retain(|member, _| keep(member));
    }

    /// Everyone the table knows, with stale entries read as `gone` (and their words dropped).
    pub fn views(&self, now: u64) -> Vec<View> {
        let mut out: Vec<View> = self
            .entries
            .iter()
            .map(|(member, e)| {
                let stale = now.saturating_sub(e.at_ms) > STALE_MS;
                let gone = stale || e.shared.state == State::Gone;
                View {
                    member: member.clone(),
                    state: if gone { State::Gone.as_str() } else { e.shared.state.as_str() },
                    at_ms: e.at_ms,
                    since_ms: e.since_ms,
                    project: if gone { None } else { e.shared.project.clone() },
                    title: if gone { None } else { e.shared.title.clone() },
                    running: if gone { 0 } else { e.shared.running },
                    waiting: if gone { 0 } else { e.shared.waiting },
                }
            })
            .collect();
        out.sort_by(|a, b| a.member.cmp(&b.member));
        out
    }
}

/// What the Team page reads about my own sharing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    pub level: ShareLevel,
    pub exclude: Vec<String>,
}

/// Clean the "not for these projects" list the person typed: trimmed, no empties, no repeats, at most 50.
pub fn clean_exclude(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let item = item.trim().to_string();
        if !item.is_empty() && item.len() <= 400 && !out.iter().any(|o| norm_path(o) == norm_path(&item)) {
            out.push(item);
        }
        if out.len() >= 50 {
            break;
        }
    }
    out
}
