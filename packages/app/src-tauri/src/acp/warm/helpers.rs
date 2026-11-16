//! Standby helpers inside the warm chat pool: sessions the person asked for by name ("Reviewer · Codex · gpt-5").
//!
//! A standby is a **seat** under the agent it was added to (`HelperMeta::home`). The seat is made and removed by the
//! person only. Everything else is the seat changing state:
//!
//! * `Ready`: its session is started and waits, with no tokens spent.
//! * A task that matches takes the seat (`claim_helper_for`): the task runs **in the seat's own chat**. Nothing else is
//!   started, and the seat does not move. A chat the person has open on the seat is that same chat: the task runs there.
//! * While the task runs the seat is `Busy` (the pool starts the seat's next clean session in the background, so the seat
//!   is ready again the moment the task ends).
//! * When the task's turn is over the seat is `Ready` again with clean memory. The finished task's chat is never closed by the
//!   pool: it stays open as an ordinary chat (no standby tag) and the seat is told to the screens (`WarmHost::seat_released`).
//!
//! What matches: the same agent type (`agent_family`: "OpenCode", "opencode" and "opencode_native" are one type), the same
//! folder and account, a model that agrees (a task that names no model takes any; one that names a model takes a seat with
//! that model or with none), and the seat is the caller's own (or belongs to nobody who is still there). A seat is never
//! taken while a turn runs in it, the person's or an agent's. Every decision is written to the seat log (`seat_log`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{local_day, Inner, Pool, SkipReason, Slot, State, WarmHost, WarmKey};
use crate::standby::key::canonical_project;
use crate::standby::seat_log;

/// What the pool knows about a helper besides its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperMeta {
    pub id: String,
    pub name: String,
    /// The model the helper is for; `None`: whatever the agent starts with.
    pub model: Option<String>,
    /// After one task the helper is removed instead of going back to standby.
    pub close_after_use: bool,
    /// The agent (pane id) the seat sits under. Only that agent's tasks take it while that agent is there.
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
    /// A turn was seen running. Until then the chat may simply not have been sent its task yet.
    pub saw_work: bool,
    /// The task's chat is not started yet: the helper is not released until `set_helper_task_pane`.
    pub awaiting_pane: bool,
    /// The chat's turn count that means the task's turn has started (`WarmHost::turns`). A task shorter than one look of
    /// the pool is still seen to be over: the count says a turn ran. `None`: the host does not count turns.
    pub turns_needed: Option<u64>,
    /// When the task's turn was seen to be over, while the seat still waits for its next clean session (`CLEAN_HOLD_MS`).
    pub over_at: Option<i64>,
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
    /// The pane of the agent asking (its own seats go first, and another agent's seat is never taken). `None`: someone
    /// else (a routine, the person).
    pub caller: Option<&'a str>,
    /// Asked for by name (`run_agent({ helper })`).
    pub name: Option<&'a str>,
}

/// A seat a task took. The task runs in the seat's own chat: `pane` is that chat when it exists already (the person had the
/// seat open), otherwise the start makes the chat around `item`, the seat's waiting session.
#[derive(Debug)]
pub struct Claimed<T> {
    pub item: Option<T>,
    pub meta: HelperMeta,
    pub pane: Option<String>,
}

/// A seat that fits a task, found without taking it (`Pool::seat_for`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatLook {
    pub id: String,
    pub name: String,
    /// The seat's agent id, as the chat lane knows it.
    pub agent: String,
}

/// A chat that never ran a turn is given this long before its helper goes back to standby.
const IDLE_CLAIM_MS: i64 = 10 * 60_000;

/// After a task the seat says Working for at most this long while its next clean session finishes starting, so the row
/// goes Ready -> Working -> Ready and never shows "Starting" or "Can't start" in between. A slow agent takes about 20 s
/// to start, and one whose start failed once (a real OpenCode did, with its own "Internal service failure") is tried
/// again after 30 s: both fit.
pub const CLEAN_HOLD_MS: i64 = 90_000;

/// The stage a sleeping standby shows while it wakes.
pub const WAKING_STAGE: &str = "waking up";

/// How long a task waits for a sleeping seat it woke (a cold start of the slowest agent fits). A seat that is not ready by then
/// is left to finish and the task starts its own chat: a claim never fails because a seat slept.
pub const WAKE_WAIT: std::time::Duration = std::time::Duration::from_secs(45);

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
    /// The chat the person has open on this helper, while it is ready or "with you".
    pub open_pane: Option<String>,
    /// While it is starting: where the start is (`starting program`, `connecting`, `opening session`, `setting model`)
    /// and when that stage began (unix milliseconds).
    pub stage: Option<String>,
    pub stage_since_ms: Option<i64>,
    /// Claims by agents' tasks today (the person's local day; starts again at local midnight).
    pub used_today: u32,
    /// The last reason an agent's task passed this standby by (memory only).
    pub skip_reason: Option<SkipReason>,
}

/// What a task finds among the helpers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperMatch {
    None,
    /// A matching helper is still starting (a claim may wait for it).
    Starting,
    Ready,
}

/// One agent type whatever the spelling or the lane wording: "OpenCode", "opencode", "opencode_native", "opencode-acp" and
/// "Open Code (terminal)" are all `opencode`. Only spelling is folded; nothing here names an agent.
pub fn agent_family(agent: &str) -> String {
    let mut text: String = agent.trim().to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    loop {
        let before = text.len();
        for word in ["nonnative", "native", "terminal", "chat", "acp", "cli", "tui"] {
            if text.len() > word.len() && text.ends_with(word) {
                text.truncate(text.len() - word.len());
            }
        }
        if text.len() == before {
            return text;
        }
    }
}

fn model_fits(requested: Option<&str>, helper: &Option<String>) -> bool {
    match (requested.map(str::trim).filter(|m| !m.is_empty()), helper) {
        (None, _) | (Some(_), None) => true,
        (Some(wanted), Some(own)) => own.eq_ignore_ascii_case(wanted),
    }
}

/// Why a seat is not for a task: the words the seat log uses, and the reason a standby row shows for the kinds an agent's
/// task can pass a seat by (`None` for the rest).
struct Miss {
    why: String,
    reason: Option<SkipReason>,
}

impl Miss {
    fn plain(why: impl Into<String>) -> Self {
        Self { why: why.into(), reason: None }
    }
}

struct Wanted {
    family: String,
    project: String,
    account: Option<String>,
}

impl Wanted {
    fn new(agent: &str, folder: &Path, account: Option<&str>) -> Self {
        Self { family: agent_family(agent), project: canonical_project(&folder.to_string_lossy()), account: account.map(str::trim).filter(|a| !a.is_empty()).map(str::to_string) }
    }

    /// Why the seat is not for this task at all (`None`: it is). Says nothing about whether it is free.
    fn not_for<T>(&self, key: &WarmKey, slot: &Slot<T>, claim: &HelperClaim, home_alive: impl Fn(&str) -> bool) -> Option<Miss> {
        let meta = slot.helper.as_ref()?;
        if agent_family(&key.agent) != self.family {
            return Some(Miss::plain(format!("it is a {} seat", key.agent)));
        }
        if !same_project(&key.project, &self.project) {
            return Some(Miss { why: "it is for another project".into(), reason: Some(SkipReason::OtherProject) });
        }
        if key.account != self.account {
            return Some(Miss::plain("it is for another account"));
        }
        if !model_fits(claim.model, &meta.model) {
            let why = format!("the task asked for model {} and the seat is on {}", claim.model.unwrap_or_default().trim(), meta.model.as_deref().unwrap_or("its default"));
            return Some(Miss { why, reason: Some(SkipReason::DifferentModel) });
        }
        if claim.name.is_some_and(|n| !meta.name.eq_ignore_ascii_case(n.trim())) {
            return Some(Miss::plain("another standby was asked for by name"));
        }
        // A standby under another agent is fine when the project is the same: the caller's own seats are tried first.
        let _ = home_alive;
        None
    }
}

/// Whether a standby made for `standby` (a canonical folder) serves a task asked for in `asked` (also canonical): the same
/// folder, the caller's folder inside the standby's project (or the reverse), or two folders of one repository. Only
/// projects that differ are skipped.
pub fn same_project(standby: &str, asked: &str) -> bool {
    if standby == asked || inside(asked, standby) || inside(standby, asked) {
        return true;
    }
    match (repo_root(standby), repo_root(asked)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn inside(child: &str, parent: &str) -> bool {
    child.len() > parent.len() && child.starts_with(parent) && (parent.ends_with('/') || child.as_bytes()[parent.len()] == b'/')
}

/// The nearest folder at or above `canonical` that holds a `.git` (canonical spelling), if any.
fn repo_root(canonical: &str) -> Option<String> {
    let mut dir = PathBuf::from(canonical);
    loop {
        if dir.join(".git").exists() {
            return Some(canonical_project(&dir.to_string_lossy()));
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn own_seat(meta: &HelperMeta, claim: &HelperClaim) -> bool {
    meta.home.as_deref().zip(claim.caller).is_some_and(|(home, caller)| home == caller)
}

impl<H: WarmHost> Pool<H> {
    /// Ends the busy state of helpers whose task is over (or whose chat is gone). The seat goes back to Ready (its next clean
    /// session); a finished task chat is kept open, never closed by the pool.
    pub(super) fn release_finished(inner: &mut Inner<H::Item>, host: &H, now: i64) {
        for (key, slot) in inner.slots.iter_mut() {
            let Some(busy) = slot.busy.as_mut() else { continue };
            if busy.awaiting_pane {
                // The task's chat is being started; only a start that never says where it is gives the helper back (in time).
                if now - busy.since >= IDLE_CLAIM_MS {
                    slot.busy = None;
                    seat_log::line(&format!("seat {} released: its task never started", key.slot.as_deref().unwrap_or("?")));
                }
                continue;
            }
            let state = host.working(&busy.pane);
            let over = match state {
                None => true,
                Some(true) => {
                    busy.saw_work = true;
                    false
                }
                Some(false) => busy.saw_work || busy.turns_needed.zip(host.turns(&busy.pane)).is_some_and(|(needed, turns)| turns >= needed) || now - busy.since >= IDLE_CLAIM_MS,
            };
            if !over {
                continue;
            }
            // The task is over. The seat is handed back the moment its next clean session is ready (it was started when
            // the task began); only a session that is still starting is waited for, a short while.
            let over_at = *busy.over_at.get_or_insert(now);
            // (A start that failed is tried again when its wait is over: that counts while the try still fits the hold.)
            let refilling = matches!(slot.state, State::Starting { .. }) || (matches!(slot.state, State::Empty) && !slot.cold && slot.backoff_until - over_at < CLEAN_HOLD_MS);
            if busy.by == HelperUser::Agent && state.is_some() && refilling && now - over_at < CLEAN_HOLD_MS {
                continue;
            }
            let Some(done) = slot.busy.take() else { continue };
            let id = key.slot.as_deref().unwrap_or("?");
            match done.by {
                HelperUser::Agent => {
                    // The finished task's chat is NOT closed (the person decides): it is kept as a normal chat with its
                    // answer, and it stops being drawn as the standby's row, so no normal chat carries the standby label.
                    if state.is_some() && !done.pane.is_empty() {
                        crate::standby::seat_panes::forget(&done.pane);
                        inner.released.push(done.pane.clone());
                    }
                    let next = match slot.state {
                        State::Ready { .. } => "ready",
                        State::Starting { .. } => "starting its next clean session",
                        State::Empty if slot.cold => "asleep (close after one task)",
                        State::Empty => "starting its next clean session",
                    };
                    seat_log::line(&format!("seat {id} returned: task over in chat {}; the seat is {next}; same seat, same owner, nothing else was made", done.pane));
                }
                HelperUser::Person => seat_log::line(&format!("seat {id} returned: the person's turn is over")),
            }
        }
    }

    /// Whether a helper fits a task, without taking it.
    pub fn helper_match(&self, agent: &str, folder: &Path, account: Option<&str>, model: Option<&str>) -> HelperMatch {
        self.helper_match_for(&HelperClaim { agent, folder, account, model, caller: None, name: None })
    }

    /// `helper_match` with who asks: only a seat this task may take counts.
    pub fn helper_match_for(&self, claim: &HelperClaim) -> HelperMatch {
        let wanted = Wanted::new(claim.agent, claim.folder, claim.account);
        let guard = self.inner.lock();
        let mut found = HelperMatch::None;
        for (key, slot) in &guard.slots {
            if key.slot.is_none() || slot.busy.is_some() || wanted.not_for(key, slot, claim, |home| self.host.working(home).is_some()).is_some() {
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

    /// The caller's own seat that would take this task (ready, or still starting), found by agent *type*: the lane wording
    /// of `agent_type` does not matter. Nothing is taken.
    pub fn seat_for(&self, claim: &HelperClaim) -> Option<SeatLook> {
        let wanted = Wanted::new(claim.agent, claim.folder, claim.account);
        let guard = self.inner.lock();
        guard
            .slots
            .iter()
            .filter(|(key, slot)| key.slot.is_some() && slot.busy.is_none() && !matches!(slot.state, State::Empty))
            .filter(|(_, slot)| slot.helper.as_ref().is_some_and(|meta| own_seat(meta, claim)))
            .find(|(key, slot)| wanted.not_for(key, slot, claim, |_| true).is_none())
            .and_then(|(key, slot)| Some(SeatLook { id: key.slot.clone()?, name: slot.helper.as_ref()?.name.clone(), agent: key.agent.clone() }))
    }

    /// Takes a ready helper that fits the task. It is busy from now until its chat has finished a turn. A matching helper
    /// that is asleep is woken (it starts again) but this call still misses.
    pub fn claim_helper(&self, agent: &str, folder: &Path, account: Option<&str>, model: Option<&str>, now: i64) -> Option<(H::Item, HelperMeta)> {
        let claimed = self.claim_helper_for(&HelperClaim { agent, folder, account, model, caller: None, name: None }, now)?;
        Some((claimed.item?, claimed.meta))
    }

    /// `claim_helper` with who asks (see `HelperClaim`). The caller's own seats go first. A seat with a turn running in it (the
    /// person's or an agent's) is never taken.
    pub fn claim_helper_for(&self, claim: &HelperClaim, now: i64) -> Option<Claimed<H::Item>> {
        self.claim_helper_inner(claim, now, false)
    }

    /// `claim_helper_for`; `awaiting`: the claim is for a chat start that will say where its chat is (`set_helper_task_pane`), so the
    /// helper is not given back before that (the chat is not registered yet).
    fn claim_helper_inner(&self, claim: &HelperClaim, now: i64, awaiting: bool) -> Option<Claimed<H::Item>> {
        let wanted = Wanted::new(claim.agent, claim.folder, claim.account);
        let mut dead = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        // Only a task an agent asked for says why it passed a standby by (a routine or the person's own claim does not).
        let by_agent = claim.caller.is_some();
        let day = local_day(now);
        let (hit, seats) = {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            if inner.shut {
                return None;
            }
            // The caller's own seats first, then the others; among those a seat nobody has open first; each in a stable order.
            let mut keys: Vec<(u8, u8, WarmKey)> = inner
                .slots
                .iter()
                .filter(|(key, slot)| key.slot.is_some() && slot.helper.is_some())
                .map(|(key, slot)| (u8::from(!slot.helper.as_ref().is_some_and(|meta| own_seat(meta, claim))), u8::from(slot.opened.is_some()), key.clone()))
                .collect();
            keys.sort();
            let seats = keys.len();
            let mut hit = None;
            for (_, _, key) in keys {
                let Some(slot) = inner.slots.get_mut(&key) else { continue };
                let Some(meta) = slot.helper.clone() else { continue };
                let label = format!("\"{}\" ({})", meta.name, meta.id);
                if let Some(miss) = wanted.not_for(&key, slot, claim, |home| self.host.working(home).is_some()) {
                    skipped.push(format!("{label}: {}", miss.why));
                    if let (true, Some(reason)) = (by_agent, miss.reason) {
                        inner.tally.note_skip(&meta.id, reason);
                    }
                    continue;
                }
                // It is for this task: asking for it wakes it, whether or not it can be taken now.
                slot.cold = false;
                slot.last_use = Some(now);
                if let Some(busy) = &slot.busy {
                    let (text, reason) = if busy.by == HelperUser::Person {
                        ("the person is using it", SkipReason::YouWereUsingIt)
                    } else {
                        ("it is busy with another task", SkipReason::Busy)
                    };
                    skipped.push(format!("{label}: {text}"));
                    if by_agent {
                        inner.tally.note_skip(&meta.id, reason);
                    }
                    continue;
                }
                if !matches!(slot.state, State::Ready { .. }) {
                    skipped.push(format!("{label}: it is not ready yet"));
                    continue;
                }
                let State::Ready { item, .. } = std::mem::replace(&mut slot.state, State::Empty) else { continue };
                if !self.host.alive(&item) {
                    slot.fails += 1;
                    slot.backoff_until = now + super::backoff_ms(slot.fails, false);
                    slot.opened = None;
                    dead.push(item);
                    skipped.push(format!("{label}: its session had stopped"));
                    continue;
                }
                // The chat the person has open on the seat is the seat's chat: the task runs there. Nothing new is made.
                let open = slot.opened.take().filter(|pane| self.host.working(pane).is_some());
                let pane = open.clone().or_else(|| self.host.pane_of(&item)).unwrap_or_default();
                let turns_needed = self.host.turns(&pane).map(|turns| turns + 1);
                slot.busy = Some(Busy { pane, since: now, by: HelperUser::Agent, saw_work: false, awaiting_pane: awaiting && open.is_none(), turns_needed, over_at: None });
                // "Close after one task": it is not started again until a task asks for it (or the person presses Start).
                slot.cold = meta.close_after_use;
                inner.tally.count_claim(&meta.id, &day);
                hit = Some((key.clone(), Claimed { item: Some(item), meta, pane: open }));
                break;
            }
            (hit.map(|(_, claimed)| claimed), seats)
        };
        for item in dead {
            self.host.close(item);
        }
        let asked = format!(
            "agent {} model {} caller {}{}",
            claim.agent,
            claim.model.map(str::trim).filter(|m| !m.is_empty()).unwrap_or("(none named)"),
            claim.caller.unwrap_or("(unknown)"),
            claim.name.map(|n| format!(" by name \"{}\"", n.trim())).unwrap_or_default()
        );
        match &hit {
            Some(claimed) => seat_log::line(&format!(
                "claim MATCHED: {asked} -> seat \"{}\" ({}); the task runs in the seat's own chat{}; nothing new is started{}",
                claimed.meta.name,
                claimed.meta.id,
                if claimed.pane.is_some() { " (the one the person has open)" } else { "" },
                if skipped.is_empty() { String::new() } else { format!("; passed over: {}", skipped.join("; ")) }
            )),
            None if seats == 0 => seat_log::line(&format!("claim SKIPPED: {asked} -> there are no standbys")),
            None => seat_log::line(&format!("claim SKIPPED: {asked} -> no seat could take it: {}", skipped.join("; "))),
        }
        hit
    }

    /// The person opened helper `helper_id` and is using it like any chat. It stays in the pool and is busy until their turn
    /// is over. False: the helper is not ready, or an agent has it.
    pub fn begin_person_use(&self, helper_id: &str, now: i64) -> bool {
        self.begin_person_use_at(helper_id, now, false)
    }

    /// `sent`: the person's message is already on its way (its turn is counted), so the turn count says when it is over.
    fn begin_person_use_at(&self, helper_id: &str, now: i64, sent: bool) -> bool {
        let mut guard = self.inner.lock();
        for (key, slot) in guard.slots.iter_mut() {
            if key.slot.as_deref() != Some(helper_id) || slot.busy.is_some() {
                continue;
            }
            let State::Ready { item, .. } = &slot.state else { return false };
            let pane = slot.opened.clone().or_else(|| self.host.pane_of(item)).unwrap_or_default();
            let turns_needed = if sent { self.host.turns(&pane) } else { None };
            slot.busy = Some(Busy { pane, since: now, by: HelperUser::Person, saw_work: false, awaiting_pane: false, turns_needed, over_at: None });
            seat_log::line(&format!("seat {helper_id} is with the person (they sent a message in its chat)"));
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
        id.is_some_and(|id| self.begin_person_use_at(&id, now, true))
    }

    /// The task that took helper `helper_id` runs in chat `pane_id` (the start knows its chat only after the claim). The helper
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
                busy.turns_needed = self.host.turns(pane_id).map(|turns| turns + 1);
                seat_log::line(&if pane_id.is_empty() { format!("seat {helper_id}: the task did not start; the seat is given back") } else { format!("seat {helper_id} working: its task runs in chat {pane_id}") });
            }
        }
    }

    /// The person takes helper `helper_id` back from an agent: returns the task's chat, whose turn the caller stops (outside the
    /// lock). The helper goes back to standby when that turn has ended, as after any task. `None`: no agent has it.
    pub fn take_back_helper(&self, helper_id: &str) -> Option<String> {
        let mut guard = self.inner.lock();
        let (_, slot) = guard.slots.iter_mut().find(|(key, _)| key.slot.as_deref() == Some(helper_id))?;
        let busy = slot.busy.as_mut().filter(|b| b.by == HelperUser::Agent && !b.pane.is_empty())?;
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
            return pane.filter(|p| !p.is_empty()).ok_or_else(|| "It is starting a task. Try again in a moment.".to_string());
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
        seat_log::line(&format!("seat {helper_id} opened by the person as chat {pane}; it stays ready in its place"));
        Ok(pane)
    }

    /// Wakes the sleeping seat that fits `claim` best (the caller's own first), when no fitting seat is ready or starting. One
    /// seat only: waking every match would spend the memory the sleep gave back. True: a seat is waking now.
    pub fn wake_for(&self, claim: &HelperClaim, now: i64) -> bool {
        let wanted = Wanted::new(claim.agent, claim.folder, claim.account);
        let mut guard = self.inner.lock();
        let mut keys: Vec<(u8, u8, WarmKey)> = guard
            .slots
            .iter()
            .filter(|(key, slot)| key.slot.is_some() && slot.helper.is_some() && slot.busy.is_none())
            .filter(|(key, slot)| wanted.not_for(key, slot, claim, |_| true).is_none())
            .map(|(key, slot)| (u8::from(!slot.helper.as_ref().is_some_and(|meta| own_seat(meta, claim))), u8::from(slot.opened.is_some()), key.clone()))
            .collect();
        keys.sort();
        // A fitting seat that is ready or already on its way needs no waking.
        if keys.iter().any(|(_, _, key)| guard.slots.get(key).is_some_and(|slot| !matches!(slot.state, State::Empty) || slot.waking_since.is_some())) {
            return keys.iter().any(|(_, _, key)| guard.slots.get(key).is_some_and(|slot| slot.waking_since.is_some()));
        }
        let Some((_, _, key)) = keys.into_iter().find(|(_, _, key)| guard.slots.get(key).is_some_and(|slot| matches!(slot.state, State::Empty) && slot.cold)) else { return false };
        let Some(slot) = guard.slots.get_mut(&key) else { return false };
        slot.cold = false;
        slot.backoff_until = 0;
        slot.last_use = Some(now);
        slot.waking_since = Some(now);
        seat_log::line(&format!("seat {} is asleep: waking it for a task", key.slot.as_deref().unwrap_or("?")));
        true
    }

    /// `claim_helper_for`, waiting (at most `wait`) for a matching helper that is still starting: it is part of the way. A matching
    /// seat that is asleep is woken first and waited for (`WAKE_WAIT` at most), so the task takes the seat rather than missing it.
    pub fn claim_helper_waiting_for(self: &std::sync::Arc<Self>, claim: &HelperClaim, wait: std::time::Duration) -> Option<Claimed<H::Item>> {
        let mut wait = wait;
        if self.helper_match_for(claim) == HelperMatch::None && self.wake_for(claim, crate::event_log::now_ms()) {
            self.tick(crate::event_log::now_ms());
            wait = wait.max(WAKE_WAIT);
        }
        let deadline = std::time::Instant::now() + wait;
        loop {
            // Only the last look writes to the seat log, so a wait is one line.
            let last = self.helper_match_for(claim) != HelperMatch::Starting || std::time::Instant::now() >= deadline;
            if !last {
                std::thread::sleep(std::time::Duration::from_millis(25));
                continue;
            }
            let hit = self.claim_helper_inner(claim, crate::event_log::now_ms(), true);
            self.tick(crate::event_log::now_ms());
            return hit;
        }
    }

    /// The person removed helper `helper_id`: it is no longer wanted, so its waiting session is closed now and no new one is
    /// started. A task running on it is not stopped.
    pub fn drop_helper(self: &std::sync::Arc<Self>, helper_id: &str, now: i64) {
        {
            let mut guard = self.inner.lock();
            guard.policy.helpers.retain(|want| want.meta.id != helper_id);
        }
        self.inner.lock().tally.forget(helper_id);
        seat_log::line(&format!("seat {helper_id} removed by the person"));
        self.tick(now);
    }

    /// A sleeping helper starts again now ("Start").
    pub fn wake_helper(&self, helper_id: &str) {
        let mut guard = self.inner.lock();
        for (key, slot) in guard.slots.iter_mut() {
            if key.slot.as_deref() == Some(helper_id) {
                if slot.cold && matches!(slot.state, State::Empty) {
                    slot.waking_since = Some(crate::event_log::now_ms());
                }
                slot.cold = false;
                slot.backoff_until = 0;
            }
        }
    }

    /// The person picked seat `helper_id`: if it sleeps it wakes now, and this waits (at most `WAKE_WAIT`) until its start has
    /// ended. Returns false at once for a seat that is not asleep.
    pub fn wake_and_wait(self: &std::sync::Arc<Self>, helper_id: &str) -> bool {
        let asleep = self.inner.lock().slots.iter().any(|(key, slot)| key.slot.as_deref() == Some(helper_id) && slot.busy.is_none() && slot.cold && matches!(slot.state, State::Empty));
        if !asleep {
            return false;
        }
        self.wake_helper(helper_id);
        self.tick(crate::event_log::now_ms());
        let deadline = std::time::Instant::now() + WAKE_WAIT;
        while std::time::Instant::now() < deadline {
            let waiting = self.inner.lock().slots.iter().any(|(key, slot)| key.slot.as_deref() == Some(helper_id) && matches!(slot.state, State::Starting { .. }));
            if !waiting {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        true
    }

    /// Every helper the pool has a slot for, by id (with today's local day for the use count).
    pub fn helper_statuses(&self) -> BTreeMap<String, HelperStatus> {
        self.helper_statuses_on(&local_day(crate::event_log::now_ms()))
    }

    /// `helper_statuses` for local day `day` (`YYYY-MM-DD`).
    pub fn helper_statuses_on(&self, day: &str) -> BTreeMap<String, HelperStatus> {
        let guard = self.inner.lock();
        let mut out = BTreeMap::new();
        for (key, slot) in &guard.slots {
            let Some(id) = &key.slot else { continue };
            let staged = super::stage::get(id);
            let status = if let Some(busy) = &slot.busy {
                let by_person = busy.by == HelperUser::Person;
                HelperStatus {
                    state: HelperState::Busy,
                    pane_id: Some(busy.pane.clone()).filter(|p| !p.is_empty()),
                    used_by: Some(busy.by),
                    open_pane: if by_person { slot.opened.clone().or_else(|| Some(busy.pane.clone()).filter(|p| !p.is_empty())) } else { None },
                    ..Default::default()
                }
            } else {
                match &slot.state {
                    State::Ready { .. } => HelperStatus { state: HelperState::Ready, open_pane: slot.opened.clone(), ..Default::default() },
                    State::Starting { .. } if slot.waking_since.is_some() => HelperStatus { state: HelperState::Starting, stage: Some(WAKING_STAGE.to_string()), stage_since_ms: slot.waking_since, ..Default::default() },
                    State::Starting { .. } => HelperStatus { state: HelperState::Starting, stage: staged.as_ref().map(|s| s.0.clone()), stage_since_ms: staged.as_ref().map(|s| s.1), ..Default::default() },
                    State::Empty if slot.last_error.as_deref() == Some(super::WAITING_FOR_MEMORY) => HelperStatus { state: HelperState::Starting, stage: Some(super::MEMORY_STAGE.to_string()), stage_since_ms: None, ..Default::default() },
                    State::Empty if slot.waking_since.is_some() && !slot.cold => HelperStatus { state: HelperState::Starting, stage: Some(WAKING_STAGE.to_string()), stage_since_ms: slot.waking_since, ..Default::default() },
                    State::Empty if slot.cold => HelperStatus { state: HelperState::Asleep, ..Default::default() },
                    State::Empty if slot.fails > 0 => HelperStatus { state: HelperState::Problem, note: slot.last_error.clone(), ..Default::default() },
                    State::Empty => HelperStatus { state: HelperState::Starting, stage: staged.as_ref().map(|s| s.0.clone()), stage_since_ms: staged.as_ref().map(|s| s.1), ..Default::default() },
                }
            };
            let status = HelperStatus { used_today: guard.tally.used_today(id, day), skip_reason: guard.tally.last_skip(id), ..status };
            out.insert(id.clone(), status);
        }
        out
    }

    /// How many seats the pool holds (the person's number: a task never changes it).
    pub fn seat_count(&self) -> usize {
        self.inner.lock().slots.keys().filter(|key| key.slot.is_some()).count()
    }
}
