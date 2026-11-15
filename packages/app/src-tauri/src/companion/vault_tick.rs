//! The vault side of the service tick (P2 of the fishd port), behind the Labs switch `companion_vault_enabled`.
//!
//! Each tick, for a companion whose switch is on, `update_vault`:
//! 1. looks at the persona files every 5 s and, when what a brief would say changed, writes the brief again
//!    and tells the running companion once (hot reload, no restart);
//! 2. copies the companion's chat into the journal (what the person said, what it answered), once per line;
//! 3. every minute moves the body (mood, self, drives, presence) and saves it, and turns a drive wake into
//!    one check-in that obeys the same gates as a scheduled one (2 h rule, daily cap, not at night);
//! and `diary_gate` makes the nap wait once for the day's diary.
//!
//! With the switch off nothing here runs: no folder is made, no file written, no message sent, and a view
//! carries no body. A companion whose home folder does not exist yet is left alone until it starts.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::body::{self, tip, BodyState};
use super::host::ChatLine;
use super::model::{CompanionError, CompanionProfile, CompanionResult, JournalView};
use super::schedule;
use super::service::{pane_id_of, OutKind, Outgoing, Service, Slot, CHECKIN_PREFIX};
use super::vault::{self, diary, journal};
use super::{brief, memory, persona, today};

/// How often the persona files are looked at.
const PERSONA_EVERY_MS: i64 = 5_000;
/// How often the chat is copied into the journal.
const CHAT_EVERY_MS: i64 = 3_000;
/// How often the body moves and is saved.
const BODY_EVERY_MS: i64 = 60_000;
/// A drive wake sends at most one message in this time.
pub const DRIVE_WAKE_GAP_MS: i64 = 2 * 60 * 60 * 1000;
/// The nap waits this long for a diary it asked for.
const DIARY_WAIT_MS: i64 = 10 * 60 * 1000;
/// Local hours when a drive never wakes the person's phone: 01:00 up to 07:00.
const QUIET_HOURS: std::ops::Range<f64> = 1.0..7.0;
/// Chat ids remembered so a line is journaled once, across restarts.
const SEEN_CAP: usize = 400;
const SEEN_FILE: &str = "journaled.json";
/// Texts the app itself sent: they are not conversation and are not journaled.
const OWN_PREFIXES: [&str; 5] = [CHECKIN_PREFIX, "[Diary:", "Potato Workspace note:", "Please read SOUL.md", "Your notes are full"];

/// What the vault keeps in memory for one companion while its switch is on.
pub(super) struct VaultSlot {
    pub body: BodyState,
    pub state_dir: PathBuf,
    pub tracker: persona::Tracker,
    pub persona_ms: i64,
    pub chat_ms: i64,
    pub body_ms: i64,
    /// Chat ids already journaled, oldest first.
    pub seen: Vec<String>,
    pub seen_set: HashSet<String>,
    /// The seen list was read from a file (not a first run): older lines are not skipped then.
    pub had_seen_file: bool,
    pub last_assistant_ms: Option<i64>,
}

impl VaultSlot {
    fn new(body: BodyState, state_dir: PathBuf, now: i64) -> Self {
        let seen: Vec<String> = std::fs::read_to_string(state_dir.join(SEEN_FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let had = state_dir.join(SEEN_FILE).is_file();
        VaultSlot {
            body,
            state_dir,
            tracker: persona::Tracker::default(),
            persona_ms: i64::MIN / 2,
            chat_ms: i64::MIN / 2,
            body_ms: now,
            seen_set: seen.iter().cloned().collect(),
            seen,
            had_seen_file: had,
            last_assistant_ms: None,
        }
    }

    fn mark(&mut self, id: &str) -> bool {
        if !self.seen_set.insert(id.to_string()) {
            return false;
        }
        self.seen.push(id.to_string());
        if self.seen.len() > SEEN_CAP {
            let drop: Vec<String> = self.seen.drain(..self.seen.len() - SEEN_CAP).collect();
            for old in drop {
                self.seen_set.remove(&old);
            }
        }
        true
    }

    fn save_seen(&self) {
        if let Ok(text) = serde_json::to_string(&self.seen) {
            let _ = super::store::write_private_text(&self.state_dir.join(SEEN_FILE), &text);
        }
    }
}

fn is_own(text: &str) -> bool {
    OWN_PREFIXES.iter().any(|p| text.trim_start().starts_with(p))
}

impl Service {
    /// The tip for a message to this companion, or nothing while the switch is off.
    pub(super) fn vault_tip(&self, slot: &Slot, now: i64, offset: i32) -> String {
        match &slot.vault {
            Some(v) => tip::appended(&v.body, now, offset, slot.runtime.sleeping),
            None => String::new(),
        }
    }

    /// What the vault adds to a brief: the persona files and the tip. Nothing while the switch is off.
    pub(super) fn vault_brief(&self, profile: &CompanionProfile, slot: Option<&Slot>, now: i64, offset: i32) -> brief::VaultBrief {
        if !self.host.vault_on() {
            return brief::VaultBrief::default();
        }
        let extras = persona::load_extras(Path::new(&profile.folder));
        let tip = slot
            .and_then(|s| s.vault.as_ref().map(|v| tip::render(&v.body, now, offset, s.runtime.sleeping)))
            .unwrap_or_default();
        brief::VaultBrief { on: true, rules: extras.rules, notes: extras.notes, tip }
    }

    /// The hash of what a brief says about the persona right now.
    fn persona_hash(&self, profile: &CompanionProfile) -> Option<String> {
        let home = Path::new(&profile.folder);
        let texts = memory::snapshot(&self.root, &profile.id, home).ok()?;
        Some(persona::hash(&texts.soul, &persona::load_extras(home)))
    }

    /// A brief was just written for a start: what it says about the persona is not a change.
    pub(super) fn vault_accept_persona(&self, profile: &CompanionProfile, slot: &mut Slot) {
        if let (Some(v), Some(hash)) = (slot.vault.as_mut(), self.persona_hash(profile)) {
            v.tracker.accept(hash);
        }
    }

    /// One pass of the vault for one companion. Returns true when `runtime` changed.
    pub(super) fn update_vault(&self, profile: &CompanionProfile, slot: &mut Slot, now: i64, offset: i32) -> bool {
        if !self.host.vault_on() {
            slot.vault = None;
            return false;
        }
        let home = Path::new(&profile.folder);
        if slot.vault.is_none() {
            // A home that is not there yet is made by the first start; nothing is created before that.
            if !home.is_dir() {
                return false;
            }
            let Ok(dir) = body::state_dir(&self.root, &profile.id) else { return false };
            if let Err(e) = vault::ensure_dirs(home) {
                tracing::warn!(companion = %profile.id, error = %e, "could not make the vault folders");
                return false;
            }
            let state = BodyState::open(&dir, now);
            let mut v = VaultSlot::new(state, dir, now);
            if let Some(hash) = self.persona_hash(profile) {
                v.tracker.accept(hash);
            }
            slot.vault = Some(v);
        }
        let mut runtime_dirty = false;
        self.vault_persona(profile, slot, now);
        self.vault_chat(profile, slot, now, offset);
        runtime_dirty |= self.vault_body(profile, slot, now, offset);
        runtime_dirty
    }

    // ---- 1. persona hot reload ------------------------------------------------------------------

    fn vault_persona(&self, profile: &CompanionProfile, slot: &mut Slot, now: i64) {
        let Some(v) = slot.vault.as_mut() else { return };
        if now - v.persona_ms < PERSONA_EVERY_MS {
            return;
        }
        v.persona_ms = now;
        let Some(hash) = self.persona_hash(profile) else { return };
        let changed = {
            let v = slot.vault.as_mut().expect("checked above");
            v.tracker.observe(hash) == persona::Seen::Changed
        };
        // A companion with no pane reads the new persona at its next start; there is nothing to tell now.
        if !changed || !slot.pane_there || !slot.keeper.want() {
            return;
        }
        if let Err(reason) = self.write_brief(profile) {
            tracing::warn!(companion = %profile.id, %reason, "could not write the brief again after a persona change");
            return;
        }
        if !slot.outgoing.iter().any(|o| o.kind == OutKind::Notice && o.text == persona::CHANGED_NOTICE) {
            slot.outgoing.push(Outgoing { kind: OutKind::Notice, text: persona::CHANGED_NOTICE.to_string(), queued_ms: now });
        }
    }

    // ---- 2. the chat into the journal -----------------------------------------------------------

    fn vault_chat(&self, profile: &CompanionProfile, slot: &mut Slot, now: i64, offset: i32) {
        if !slot.pane_there {
            return;
        }
        let Some(v) = slot.vault.as_mut() else { return };
        if now - v.chat_ms < CHAT_EVERY_MS {
            return;
        }
        v.chat_ms = now;
        let lines: Vec<ChatLine> = self.host.chat_lines(&pane_id_of(&profile.id), &profile.id);
        let day_start = today::day_start_ms(now, offset);
        let home = Path::new(&profile.folder);
        let sleeping = slot.runtime.sleeping;
        let v = slot.vault.as_mut().expect("checked above");
        let mut changed = false;
        for line in lines {
            if !v.mark(&line.id) {
                continue;
            }
            changed = true;
            // The first time ever, an old chat is not copied in: only today's lines are.
            if !v.had_seen_file && line.at_ms.is_some_and(|at| at < day_start) {
                continue;
            }
            let at = line.at_ms.unwrap_or(now);
            if is_own(&line.text) {
                continue;
            }
            let entry = if line.from_person {
                journal::Entry { at_ms: at, offset_secs: offset, kind: journal::Kind::Heard, who: "Person", place: "chat", text: &line.text }
            } else {
                journal::Entry { at_ms: at, offset_secs: offset, kind: journal::Kind::Said, who: &profile.name, place: "chat", text: &line.text }
            };
            if let Err(e) = journal::append(home, &entry) {
                tracing::warn!(companion = %profile.id, error = %e, "could not write the journal");
            }
            if line.from_person {
                let latency = v.last_assistant_ms.map(|last| at - last);
                v.body.heard_person(at, offset, sleeping, latency, line.text.chars().count() as u32);
            } else {
                v.last_assistant_ms = Some(at);
            }
        }
        if changed {
            v.had_seen_file = true;
            v.save_seen();
            let _ = v.body.save(&v.state_dir);
        }
    }

    // ---- 3. the body ----------------------------------------------------------------------------

    fn vault_body(&self, profile: &CompanionProfile, slot: &mut Slot, now: i64, offset: i32) -> bool {
        let sleeping = slot.runtime.sleeping || !slot.keeper.want();
        let Some(v) = slot.vault.as_mut() else { return false };
        if now - v.body_ms < BODY_EVERY_MS {
            return false;
        }
        v.body_ms = now;
        v.body.tick(now, offset, sleeping);
        if let Err(e) = v.body.save(&v.state_dir) {
            tracing::warn!(companion = %profile.id, error = %e, "could not save the body state");
        }
        self.drive_wake(profile, slot, now, offset)
    }

    /// A drive that is waiting becomes one check-in, through the same gates as a scheduled one. Returns true
    /// when `runtime` changed.
    fn drive_wake(&self, profile: &CompanionProfile, slot: &mut Slot, now: i64, offset: i32) -> bool {
        let waiting: Vec<String> = slot.vault.as_ref().map(|v| v.body.drives.pending_wake.clone()).unwrap_or_default();
        if waiting.is_empty() || !slot.keeper.want() || !slot.pane_there || slot.state != super::model::CompanionState::Idle {
            return false;
        }
        if QUIET_HOURS.contains(&body::local_hour(now, offset)) {
            return false;
        }
        if slot.runtime.last_drive_wake_ms.is_some_and(|last| now - last < DRIVE_WAKE_GAP_MS) {
            return false;
        }
        let today = schedule::today_key(now, offset);
        if !schedule::under_cap(&slot.runtime.sent_today, &today) {
            return false;
        }
        let pane_id = pane_id_of(&profile.id);
        let queued = self.host.waiting(&pane_id).iter().any(|t| t.starts_with(CHECKIN_PREFIX) || t.starts_with("[Diary:"))
            || slot.outgoing.iter().any(|o| matches!(o.kind, OutKind::Checkin(_)));
        if queued {
            return false;
        }
        schedule::note_send(&mut slot.runtime.sent_today, &today);
        slot.runtime.last_drive_wake_ms = Some(now);
        let tip = self.vault_tip(slot, now, offset);
        slot.outgoing.push(Outgoing {
            kind: OutKind::Checkin("Drive".to_string()),
            text: format!(
                "{CHECKIN_PREFIX} Drive] You feel {} building up. If now is a good moment, say one short thing to your person. If not, stay quiet. This is not a request.{tip}",
                waiting.join(" and ")
            ),
            queued_ms: now,
        });
        if let Some(v) = slot.vault.as_mut() {
            v.body.reached_out(&waiting, now);
            let _ = v.body.save(&v.state_dir);
        }
        true
    }

    // ---- the diary before a nap -------------------------------------------------------------------

    /// Called when the nap is due. `None`: nap now. `Some(dirty)`: not yet, the diary is being written (`dirty`:
    /// `runtime` changed). One ask per day, and the nap waits at most ten minutes for the file.
    pub(super) fn diary_gate(&self, profile: &CompanionProfile, slot: &mut Slot, now: i64, offset: i32) -> Option<bool> {
        if !self.host.vault_on() || slot.vault.is_none() {
            return None;
        }
        let home = Path::new(&profile.folder);
        let day = diary::needed_day(home, schedule::local_date(now, offset))?;
        let key = day.format("%Y-%m-%d").to_string();
        if slot.runtime.diary_asked_day.as_deref() == Some(key.as_str()) {
            let asked = slot.runtime.diary_asked_ms.unwrap_or(now);
            return (now - asked < DIARY_WAIT_MS).then_some(false);
        }
        let today = schedule::today_key(now, offset);
        if !schedule::under_cap(&slot.runtime.sent_today, &today) {
            return None;
        }
        schedule::note_send(&mut slot.runtime.sent_today, &today);
        slot.runtime.diary_asked_day = Some(key);
        slot.runtime.diary_asked_ms = Some(now);
        slot.outgoing.push(Outgoing { kind: OutKind::Checkin("Diary".to_string()), text: diary::request_text(day), queued_ms: now });
        Some(true)
    }

    // ---- what the desktop asks for ----------------------------------------------------------------

    /// The journal, the diary and the people of one companion (desktop only; the switch must be on).
    pub fn journal(&self, id: &str) -> CompanionResult<JournalView> {
        let folder = {
            let inner = self.inner.lock();
            inner
                .profiles
                .iter()
                .find(|p| p.id == id && !p.archived)
                .map(|p| p.folder.clone())
                .ok_or_else(|| CompanionError::new("COMPANION_NOT_FOUND", "No companion has that id."))?
        };
        if !self.host.vault_on() {
            return Err(CompanionError::new("COMPANION_VAULT_OFF", "The journal is off. Turn on Companion memory and mood in Settings."));
        }
        Ok(vault::view(Path::new(&folder), 2))
    }

    /// A companion's journal lines that match `query`, for `companion_recall`: (date, time, text), newest first.
    pub(super) fn journal_hits(&self, folder: &str, query: &str, limit: usize) -> Vec<(String, String, String)> {
        if !self.host.vault_on() {
            return Vec::new();
        }
        journal::search(Path::new(folder), query, limit, 60)
            .into_iter()
            .map(|hit| {
                let date = hit.date.format("%Y-%m-%d").to_string();
                let rest = hit.line.trim_start_matches("- ").trim_start();
                let (time, text) = match rest.split_once(' ') {
                    Some((t, r)) if t.len() == 5 && t.as_bytes()[2] == b':' => (t.to_string(), r.to_string()),
                    _ => (String::new(), rest.to_string()),
                };
                (date, time, text)
            })
            .collect()
    }

}
