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
    /// The agent (pane id) the helper is shown under; a task from that agent takes it before any other free match.
    pub home: Option<String>,
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
    /// An agent's task, or the person using the helper's chat.
    pub by: HelperUser,
    /// An agent took the helper from the person while they were using it.
    pub taken_over: bool,
    /// A turn was seen running. Until then the chat may simply not have been sent its task yet.
    pub saw_work: bool,
    /// An agent took the helper from the person: the person's chat (its turn was stopped; it stays readable as a plain chat).
    pub person_pane: Option<String>,
    /// The task's chat is not started yet (`pane` is empty): the helper is not released until `set_helper_task_pane`.
    pub awaiting_pane: bool,
}

/// Who has a busy helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperUser {
    Agent,
    Person,
}

/// A task asking for a helper.
#[derive(Debug, Clone, Copy)]
pub struct HelperClaim<'a> {
    pub agent: &'a str,
    pub folder: &'a Path,
    pub account: Option<&'a str>,
    pub model: Option<&'a str>,
    /// The pane of the agent asking (its own helpers go first). `None`: someone else (a routine, the person).
    pub caller: Option<&'a str>,
    /// Asked for by name (`run_agent({ helper })`).
    pub name: Option<&'a str>,
}

/// A helper a task took. `taken_from` is the chat of the person who was using it (their turn was stopped).
///
/// A helper the person has open or is using is never handed over with its session: the task gets `fresh` (no `item`; the start
/// opens a new session with clean memory) and the person's chat keeps its own session. `person_pane` is that chat.
#[derive(Debug)]
pub struct Claimed<T> {
    pub item: Option<T>,
    pub meta: HelperMeta,
    pub taken_from: Option<String>,
    pub fresh: bool,
    pub person_pane: Option<String>,
}

/// A chat that never ran a turn is given this long before its helper goes back to standby.
const IDLE_CLAIM_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperState {
    /// Started and waiting; the next matching task takes it.
    Ready,
    /// A task is running on it.
    Busy,
    #[default]
    Starting,
    /// Closed after sitting unused; it starts again when a matching task asks, or on "Start".
    Asleep,
    /// It could not start (`note` says why).
    Problem,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct HelperStatus {
    pub state: HelperState,
    /// A short code for the problem (`did_not_start`, `needs_sign_in`), when there is one.
    pub note: Option<String>,
    /// The chat running the task, while busy.
    pub pane_id: Option<String>,
    /// Who has it while busy.
    pub used_by: Option<HelperUser>,
    /// An agent took it over while the person was using it.
    pub taken_over: bool,
    /// The chat the person has open on this helper, while it is ready or "with you".
    pub open_pane: Option<String>,
    /// While `taken_over`: the person's chat (its turn was stopped). Cleared when the task ends.
    pub person_pane: Option<String>,
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
        slot.busy.is_none() && self.fits_busy_or_not(key, slot, model, None)
    }

    /// Whether the helper is for this task, whoever has it right now.
    fn fits_busy_or_not<T>(&self, key: &WarmKey, slot: &Slot<T>, model: Option<&str>, name: Option<&str>) -> bool {
        key.slot.is_some()
            && key.agent == self.agent
            && key.project == self.project
            && key.account == self.account
            && slot.helper.as_ref().is_some_and(|meta| model_fits(model, &meta.model) && name.is_none_or(|n| meta.name.eq_ignore_ascii_case(n.trim())))
    }
}

impl<H: WarmHost> Pool<H> {
    /// Ends the busy state of helpers whose task is over (or whose chat is gone).
    pub(super) fn release_finished(inner: &mut Inner<H::Item>, host: &H, now: i64) {
        for slot in inner.slots.values_mut() {
            let Some(busy) = slot.busy.as_mut() else { continue };
            if busy.awaiting_pane {
                // The task's chat is being started; only a start that never says where it is gives the helper back (in time).
                if now - busy.since >= IDLE_CLAIM_MS {
                    slot.busy = None;
                }
                continue;
            }
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
        let claimed = self.claim_helper_for(&HelperClaim { agent, folder, account, model, caller: None, name: None }, now)?;
        Some((claimed.item?, claimed.meta))
    }

    /// The order a task looks in: a free helper before one the person is using, and among those the caller's own first.
    fn claim_order(inner: &Inner<H::Item>, wanted: &Wanted, claim: &HelperClaim) -> Vec<WarmKey> {
        let mut keys: Vec<(u8, u8, WarmKey)> = inner
            .slots
            .iter()
            .filter(|(k, s)| wanted.fits_busy_or_not(k, s, claim.model, claim.name))
            .filter(|(_, s)| s.busy.as_ref().is_none_or(|b| b.by == HelperUser::Person))
            .map(|(k, s)| {
                let held = u8::from(s.busy.is_some() || s.opened.is_some());
                let own = s.helper.as_ref().and_then(|m| m.home.as_deref()).zip(claim.caller).is_some_and(|(home, caller)| home == caller);
                (held, u8::from(!own), k.clone())
            })
            .collect();
        keys.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
        keys.into_iter().map(|(_, _, k)| k).collect()
    }

    /// `claim_helper` with who asks (see `HelperClaim`). A helper the person is using is taken only when no free one fits: the
    /// person's turn is stopped, and the result says whose chat it was.
    pub fn claim_helper_for(&self, claim: &HelperClaim, now: i64) -> Option<Claimed<H::Item>> {
        self.claim_helper_inner(claim, now, false)
    }

    /// `claim_helper_for`; `awaiting`: the claim is for a chat start that will say where its chat is (`set_helper_task_pane`), so the
    /// helper is not given back before that (the chat is not registered yet).
    fn claim_helper_inner(&self, claim: &HelperClaim, now: i64, awaiting: bool) -> Option<Claimed<H::Item>> {
        let wanted = Wanted::new(claim.agent, claim.folder, claim.account);
        let mut dead = None;
        let hit = {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            if inner.shut {
                return None;
            }
            let keys = Self::claim_order(inner, &wanted, claim);
            let mut hit = None;
            for key in keys {
                let Some(slot) = inner.slots.get_mut(&key) else { continue };
                slot.cold = false;
                slot.last_use = Some(now);
                if !matches!(slot.state, State::Ready { .. }) {
                    continue;
                }
                let Some(meta) = slot.helper.clone() else { continue };
                let State::Ready { item, .. } = std::mem::replace(&mut slot.state, State::Empty) else { continue };
                if slot.busy.is_some() || slot.opened.is_some() {
                    // The person has it open or is using it: the task never gets their session. Their chat keeps it (it stays
                    // readable as a plain chat; an item dropped here is not closed) and the task starts a fresh one.
                    drop(item);
                    let taken_from = slot.busy.take().filter(|b| b.by == HelperUser::Person).map(|b| b.pane).filter(|p| !p.is_empty());
                    let person_pane = slot.opened.take().or_else(|| taken_from.clone());
                    slot.busy = Some(Busy { pane: String::new(), since: now, by: HelperUser::Agent, taken_over: true, saw_work: false, person_pane: person_pane.clone(), awaiting_pane: true });
                    slot.cold = meta.close_after_use;
                    hit = Some(Claimed { item: None, meta, taken_from, fresh: true, person_pane });
                    break;
                }
                if !self.host.alive(&item) {
                    slot.fails += 1;
                    slot.backoff_until = now + super::backoff_ms(slot.fails, false);
                    dead = Some(item);
                    continue;
                }
                slot.busy = Some(Busy { pane: self.host.pane_of(&item).unwrap_or_default(), since: now, by: HelperUser::Agent, taken_over: false, saw_work: false, person_pane: None, awaiting_pane: awaiting });
                // "Close after one task": it is not started again until a task asks for it (or the person presses Start).
                slot.cold = meta.close_after_use;
                hit = Some(Claimed { item: Some(item), meta, taken_from: None, fresh: false, person_pane: None });
                break;
            }
            hit
        };
        if let Some(item) = dead {
            self.host.close(item);
        }
        // The person's turn is stopped outside the lock.
        if let Some(pane) = hit.as_ref().and_then(|h| h.taken_from.as_deref()) {
            self.host.cancel_turn(pane);
        }
        hit
    }

    /// The person opened helper `helper_id` and is using it like any chat. It stays in the pool (a free match is taken before
    /// it) and is busy until their turn is over. False: the helper is not ready, or an agent has it.
    pub fn begin_person_use(&self, helper_id: &str, now: i64) -> bool {
        let mut guard = self.inner.lock();
        for (key, slot) in guard.slots.iter_mut() {
            if key.slot.as_deref() != Some(helper_id) || slot.busy.is_some() {
                continue;
            }
            let State::Ready { item, .. } = &slot.state else { return false };
            let pane = self.host.pane_of(item).unwrap_or_default();
            slot.busy = Some(Busy { pane, since: now, by: HelperUser::Person, taken_over: false, saw_work: false, person_pane: None, awaiting_pane: false });
            return true;
        }
        false
    }

    /// A message was sent in chat `pane_id`. When that chat is a standby the person opened (`open_helper`) and nobody has the
    /// helper, it is theirs until the turn ends. A later send while it is theirs changes nothing.
    pub fn person_sent(&self, pane_id: &str, now: i64) -> bool {
        let id = {
            let guard = self.inner.lock();
            guard.slots.iter().find(|(_, slot)| slot.opened.as_deref() == Some(pane_id) && slot.busy.is_none()).and_then(|(key, _)| key.slot.clone())
        };
        id.is_some_and(|id| self.begin_person_use(&id, now))
    }

    /// The task that took helper `helper_id` runs in chat `pane_id` (a fresh start knows its chat only after the claim). The helper
    /// is busy until that chat has finished a turn. An empty `pane_id`: the start failed, so the helper is released at the next pass.
    pub fn set_helper_task_pane(&self, helper_id: &str, pane_id: &str) {
        let mut guard = self.inner.lock();
        for (key, slot) in guard.slots.iter_mut() {
            if key.slot.as_deref() != Some(helper_id) {
                continue;
            }
            if let Some(busy) = slot.busy.as_mut().filter(|b| b.by == HelperUser::Agent) {
                busy.pane = pane_id.to_string();
                busy.awaiting_pane = false;
                busy.saw_work = false;
            }
        }
    }

    /// The person takes helper `helper_id` back from an agent: returns the task's chat, whose turn the caller stops (outside the
    /// lock). The helper goes back to standby when that turn has ended, as after any task. `None`: no agent has it.
    pub fn take_back_helper(&self, helper_id: &str) -> Option<String> {
        let mut guard = self.inner.lock();
        let (_, slot) = guard.slots.iter_mut().find(|(key, _)| key.slot.as_deref() == Some(helper_id))?;
        let busy = slot.busy.as_mut().filter(|b| b.by == HelperUser::Agent && !b.pane.is_empty())?;
        busy.taken_over = false;
        busy.person_pane = None;
        // The turn is being stopped: it is over as soon as the chat is idle again.
        busy.saw_work = true;
        Some(busy.pane.clone())
    }

    /// Stops the turn running in chat `pane_id` through the chat's own cancel (never call this under the lock).
    pub fn cancel_helper_turn(&self, pane_id: &str) {
        self.host.cancel_turn(pane_id);
    }

    /// Opens helper `helper_id` as a chat the person can use. `build` makes the chat around the waiting session (without taking it
    /// from the pool) and returns its pane id; it runs under the pool's lock, so it must not call the pool.
    ///
    /// A helper an agent has returns the agent's task chat; one the person has open returns that chat again. A helper that is
    /// not ready says why in one plain sentence.
    pub fn open_helper(&self, helper_id: &str, build: impl FnOnce(&H::Item, &HelperMeta, &str) -> Result<String, String>) -> Result<String, String> {
        let mut guard = self.inner.lock();
        let Some((key, slot)) = guard.slots.iter_mut().find(|(key, _)| key.slot.as_deref() == Some(helper_id)) else {
            return Err("That standby is gone.".into());
        };
        if let Some(busy) = &slot.busy {
            let pane = match busy.by {
                HelperUser::Agent => Some(busy.pane.clone()),
                HelperUser::Person => slot.opened.clone().or_else(|| Some(busy.pane.clone())),
            };
            return pane.filter(|p| !p.is_empty()).ok_or_else(|| "An agent is starting its task on it. Try again in a moment.".to_string());
        }
        let ready = matches!(slot.state, State::Ready { .. });
        if !ready {
            if matches!(slot.state, State::Empty) && slot.cold {
                slot.cold = false;
                slot.backoff_until = 0;
                return Err("It is asleep. Waking it now: try again in a moment.".into());
            }
            if matches!(slot.state, State::Empty) && slot.fails > 0 {
                return Err(match slot.last_error.as_deref() {
                    Some("needs_sign_in") => "It needs you to sign in first.".to_string(),
                    _ => "It did not start. Press Start to try again.".to_string(),
                });
            }
            return Err("It is still starting. Try again in a moment.".into());
        }
        // A chat the person closed since: the session went with it and the pool starts a new one.
        if let Some(pane) = slot.opened.clone() {
            if self.host.working(&pane).is_some() {
                return Ok(pane);
            }
            slot.opened = None;
        }
        let (Some(meta), State::Ready { item, .. }) = (slot.helper.clone(), &slot.state) else {
            return Err("It is still starting. Try again in a moment.".into());
        };
        if !self.host.alive(item) {
            return Err("It is still starting. Try again in a moment.".into());
        }
        let pane = build(item, &meta, &key.agent)?;
        slot.opened = Some(pane.clone());
        Ok(pane)
    }

    /// `claim_helper_for`, waiting (at most `wait`) for a matching helper that is still starting: it is part of the way.
    pub fn claim_helper_waiting_for(self: &std::sync::Arc<Self>, claim: &HelperClaim, wait: std::time::Duration) -> Option<Claimed<H::Item>> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            let hit = self.claim_helper_inner(claim, crate::event_log::now_ms(), true);
            if hit.is_some() || self.helper_match(claim.agent, claim.folder, claim.account, claim.model) != HelperMatch::Starting || std::time::Instant::now() >= deadline {
                self.tick(crate::event_log::now_ms());
                return hit;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// The person removed helper `helper_id`: it is no longer wanted, so its waiting session is closed now and no new one is
    /// started. A task running on it is not stopped.
    pub fn drop_helper(self: &std::sync::Arc<Self>, helper_id: &str, now: i64) {
        {
            let mut guard = self.inner.lock();
            guard.policy.helpers.retain(|want| want.meta.id != helper_id);
        }
        self.tick(now);
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
                let by_person = busy.by == HelperUser::Person;
                HelperStatus {
                    state: HelperState::Busy,
                    pane_id: Some(busy.pane.clone()).filter(|p| !p.is_empty()),
                    used_by: Some(busy.by),
                    taken_over: busy.taken_over,
                    open_pane: if by_person { slot.opened.clone().or_else(|| Some(busy.pane.clone()).filter(|p| !p.is_empty())) } else { None },
                    person_pane: if busy.taken_over { busy.person_pane.clone() } else { None },
                    ..Default::default()
                }
            } else {
                match &slot.state {
                    State::Ready { .. } => HelperStatus { state: HelperState::Ready, open_pane: slot.opened.clone(), ..Default::default() },
                    State::Starting { .. } => HelperStatus { state: HelperState::Starting, ..Default::default() },
                    State::Empty if slot.cold => HelperStatus { state: HelperState::Asleep, ..Default::default() },
                    State::Empty if slot.fails > 0 => HelperStatus { state: HelperState::Problem, note: slot.last_error.clone(), ..Default::default() },
                    State::Empty => HelperStatus { state: HelperState::Starting, ..Default::default() },
                }
            };
            out.insert(id.clone(), status);
        }
        out
    }
}
