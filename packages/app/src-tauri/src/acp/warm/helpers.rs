//! Standby helpers inside the warm chat pool: sessions the person asked for by name ("Reviewer · Codex · gpt-5").
//!
//! They are ordinary warm slots with two differences. Each has its own key (`WarmKey::slot` = the helper's id), so two
//! helpers of one agent and folder do not share a slot. And a claim takes only a helper that matches the task: the same
//! agent, folder and account, and a model that agrees (a task that names no model takes any; one that names a model takes
//! a helper with that model or with none). A claimed helper is *busy* until its chat has finished a turn (or is gone);
//! only then is its slot refilled, so a helper is back on standby after its task and never twice at once.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{Inner, Pool, Slot, State, WarmHost, WarmKey};
use crate::standby::key::canonical_project;

/// What the pool knows about a helper besides its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperMeta {
    pub id: String,
    pub name: String,
    /// The model the helper is for; `None`: whatever the agent starts with.
    pub model: Option<String>,
    /// After one task the helper is removed instead of going back to standby.
    pub close_after_use: bool,
}

/// A helper the policy wants kept ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperWant {
    pub key: WarmKey,
    pub folder: PathBuf,
    pub meta: HelperMeta,
}

impl HelperWant {
    pub fn new(meta: HelperMeta, agent: &str, folder: &Path, account: Option<&str>) -> Self {
        Self { key: WarmKey::for_helper(&meta.id, agent, &folder.to_string_lossy(), account), folder: folder.to_path_buf(), meta }
    }
}

/// A claimed helper's task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Busy {
    pub pane: String,
    pub since: i64,
    /// A turn was seen running. Until then the chat may simply not have been sent its task yet.
    pub saw_work: bool,
}

/// A chat that never ran a turn is given this long before its helper goes back to standby.
const IDLE_CLAIM_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperState {
    /// Started and waiting; the next matching task takes it.
    Ready,
    /// A task is running on it.
    Busy,
    Starting,
    /// Closed after sitting unused; it starts again when a matching task asks, or on "Start".
    Asleep,
    /// It could not start (`note` says why).
    Problem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelperStatus {
    pub state: HelperState,
    /// A short code for the problem (`did_not_start`, `needs_sign_in`), when there is one.
    pub note: Option<String>,
    /// The chat running the task, while busy.
    pub pane_id: Option<String>,
}

/// What a task finds among the helpers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperMatch {
    None,
    /// A matching helper is still starting (a claim may wait for it).
    Starting,
    Ready,
}

fn model_fits(requested: Option<&str>, helper: &Option<String>) -> bool {
    match (requested.map(str::trim).filter(|m| !m.is_empty()), helper) {
        (None, _) | (Some(_), None) => true,
        (Some(wanted), Some(own)) => own.eq_ignore_ascii_case(wanted),
    }
}

struct Wanted {
    agent: String,
    project: String,
    account: Option<String>,
}

impl Wanted {
    fn new(agent: &str, folder: &Path, account: Option<&str>) -> Self {
        Self {
            agent: agent.to_ascii_lowercase(),
            project: canonical_project(&folder.to_string_lossy()),
            account: account.map(str::trim).filter(|a| !a.is_empty()).map(str::to_string),
        }
    }

    fn fits<T>(&self, key: &WarmKey, slot: &Slot<T>, model: Option<&str>) -> bool {
        key.slot.is_some()
            && key.agent == self.agent
            && key.project == self.project
            && key.account == self.account
            && slot.busy.is_none()
            && slot.helper.as_ref().is_some_and(|meta| model_fits(model, &meta.model))
    }
}

impl<H: WarmHost> Pool<H> {
    /// Ends the busy state of helpers whose task is over (or whose chat is gone).
    pub(super) fn release_finished(inner: &mut Inner<H::Item>, host: &H, now: i64) {
        for slot in inner.slots.values_mut() {
            let Some(busy) = slot.busy.as_mut() else { continue };
            let over = match host.working(&busy.pane) {
                None => true,
                Some(true) => {
                    busy.saw_work = true;
                    false
                }
                Some(false) => busy.saw_work || now - busy.since >= IDLE_CLAIM_MS,
            };
            if over {
                slot.busy = None;
            }
        }
    }

    /// Whether a helper fits a task, without taking it.
    pub fn helper_match(&self, agent: &str, folder: &Path, account: Option<&str>, model: Option<&str>) -> HelperMatch {
        let wanted = Wanted::new(agent, folder, account);
        let guard = self.inner.lock();
        let mut found = HelperMatch::None;
        for (key, slot) in &guard.slots {
            if !wanted.fits(key, slot, model) {
                continue;
            }
            match slot.state {
                State::Ready { .. } => return HelperMatch::Ready,
                State::Starting { .. } => found = HelperMatch::Starting,
                State::Empty => {}
            }
        }
        found
    }

    /// Takes a ready helper that fits the task. It is busy from now until its chat has finished a turn. A matching helper
    /// that is asleep is woken (it starts again) but this call still misses.
    pub fn claim_helper(&self, agent: &str, folder: &Path, account: Option<&str>, model: Option<&str>, now: i64) -> Option<(H::Item, HelperMeta)> {
        let wanted = Wanted::new(agent, folder, account);
        let mut dead = None;
        let hit = {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            if inner.shut {
                return None;
            }
            let keys: Vec<WarmKey> = inner.slots.iter().filter(|(k, s)| wanted.fits(k, s, model)).map(|(k, _)| k.clone()).collect();
            let mut hit = None;
            for key in keys {
                let Some(slot) = inner.slots.get_mut(&key) else { continue };
                slot.cold = false;
                slot.last_use = Some(now);
                if !matches!(slot.state, State::Ready { .. }) {
                    continue;
                }
                let State::Ready { item, .. } = std::mem::replace(&mut slot.state, State::Empty) else { continue };
                if !self.host.alive(&item) {
                    slot.fails += 1;
                    slot.backoff_until = now + super::backoff_ms(slot.fails, false);
                    dead = Some(item);
                    continue;
                }
                let Some(meta) = slot.helper.clone() else { continue };
                slot.busy = Some(Busy { pane: self.host.pane_of(&item).unwrap_or_default(), since: now, saw_work: false });
                // "Close after one task": it is not started again until a task asks for it (or the person presses Start).
                slot.cold = meta.close_after_use;
                hit = Some((item, meta));
                break;
            }
            hit
        };
        if let Some(item) = dead {
            self.host.close(item);
        }
        hit
    }

    /// `claim_helper`, waiting (at most `wait`) for a matching helper that is still starting: it is part of the way.
    pub fn claim_helper_waiting(self: &std::sync::Arc<Self>, agent: &str, folder: &Path, account: Option<&str>, model: Option<&str>, wait: std::time::Duration) -> Option<(H::Item, HelperMeta)> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            let hit = self.claim_helper(agent, folder, account, model, crate::event_log::now_ms());
            if hit.is_some() || self.helper_match(agent, folder, account, model) != HelperMatch::Starting || std::time::Instant::now() >= deadline {
                self.tick(crate::event_log::now_ms());
                return hit;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// A sleeping helper starts again now ("Start").
    pub fn wake_helper(&self, helper_id: &str) {
        let mut guard = self.inner.lock();
        for (key, slot) in guard.slots.iter_mut() {
            if key.slot.as_deref() == Some(helper_id) {
                slot.cold = false;
                slot.backoff_until = 0;
            }
        }
    }

    /// Every helper the pool has a slot for, by id.
    pub fn helper_statuses(&self) -> BTreeMap<String, HelperStatus> {
        let guard = self.inner.lock();
        let mut out = BTreeMap::new();
        for (key, slot) in &guard.slots {
            let Some(id) = &key.slot else { continue };
            let status = if let Some(busy) = &slot.busy {
                HelperStatus { state: HelperState::Busy, note: None, pane_id: Some(busy.pane.clone()).filter(|p| !p.is_empty()) }
            } else {
                match &slot.state {
                    State::Ready { .. } => HelperStatus { state: HelperState::Ready, note: None, pane_id: None },
                    State::Starting { .. } => HelperStatus { state: HelperState::Starting, note: None, pane_id: None },
                    State::Empty if slot.cold => HelperStatus { state: HelperState::Asleep, note: None, pane_id: None },
                    State::Empty if slot.fails > 0 => HelperStatus { state: HelperState::Problem, note: slot.last_error.clone(), pane_id: None },
                    State::Empty => HelperStatus { state: HelperState::Starting, note: None, pane_id: None },
                }
            };
            out.insert(id.clone(), status);
        }
        out
    }
}
