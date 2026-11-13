//! "Ask the PC for control": a phone whose agent is watch-only (or switched off) asks the person on the PC
//! to let it type for a while. The PC shows one small notice, "<phone> asks for control", with
//! "Allow 15 min" and "No". Nothing is granted until the person taps Allow; the grant puts the agent's rule
//! to on/full for [`GRANT_MS`] and then puts back what it was.
//!
//! One ask per agent per [`ASK_GAP_MS`] (whoever asks), so a phone cannot keep a notice on the PC's screen.
//! The ask list is in memory only: an ask that nobody answered is gone when the app closes.

use super::pane_rules::{self, Level, PaneRule};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;

/// One ask per agent in this time.
pub const ASK_GAP_MS: u64 = 5 * 60 * 1000;
/// How long an allowed ask lasts.
pub const GRANT_MS: u64 = 15 * 60 * 1000;
/// Asks kept at once; more are refused (a person never has this many).
const MAX_PENDING: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Ask {
    pub id: String,
    pub device_id: String,
    /// The phone's name as the person gave it when pairing.
    pub device_name: String,
    pub pane_id: String,
    pub at_ms: u64,
}

/// Why an ask was not taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The agent already lets this phone do everything.
    AlreadyAllowed,
    /// Asked lately: try again after this many milliseconds.
    TooSoon { retry_after_ms: u64 },
    /// Too many asks wait on the PC.
    Busy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Grant {
    pane_id: String,
    before: PaneRule,
    until_ms: u64,
}

#[derive(Debug, Default)]
pub struct Asks {
    last: HashMap<String, u64>,
    pending: Vec<Ask>,
    grants: Vec<Grant>,
    next: u64,
}

impl Asks {
    /// Take an ask from a phone. `rule` is the agent's rule now.
    pub fn ask(&mut self, device_id: &str, device_name: &str, pane_id: &str, rule: PaneRule, now: u64) -> Result<Ask, Refusal> {
        if rule.remote && rule.level == Level::Full {
            return Err(Refusal::AlreadyAllowed);
        }
        if let Some(&at) = self.last.get(pane_id) {
            let wait = ASK_GAP_MS.saturating_sub(now.saturating_sub(at));
            if wait > 0 {
                return Err(Refusal::TooSoon { retry_after_ms: wait });
            }
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(Refusal::Busy);
        }
        self.next += 1;
        let ask = Ask {
            id: format!("ask-{}-{}", now, self.next),
            device_id: device_id.into(),
            device_name: device_name.into(),
            pane_id: pane_id.into(),
            at_ms: now,
        };
        self.last.insert(pane_id.to_string(), now);
        // Old entries of the gap table go: only the last 5 minutes matter.
        self.last.retain(|_, &mut at| now.saturating_sub(at) < ASK_GAP_MS);
        self.pending.push(ask.clone());
        Ok(ask)
    }

    pub fn pending(&self) -> Vec<Ask> {
        self.pending.clone()
    }

    /// The person answered. Returns the ask, and for Allow the rule to put back later.
    pub fn answer(&mut self, id: &str, allow: bool, rule_now: PaneRule, now: u64) -> Option<(Ask, Option<PaneRule>)> {
        let at = self.pending.iter().position(|ask| ask.id == id)?;
        let ask = self.pending.remove(at);
        if !allow {
            return Some((ask, None));
        }
        // A second allow for the same agent keeps the first "before" (what the person had set) and moves the end.
        let before = self.grants.iter().find(|g| g.pane_id == ask.pane_id).map(|g| g.before).unwrap_or(rule_now);
        self.grants.retain(|g| g.pane_id != ask.pane_id);
        self.grants.push(Grant { pane_id: ask.pane_id.clone(), before, until_ms: now + GRANT_MS });
        Some((ask, Some(before)))
    }

    /// Grants that ended by `now`: the agent and the rule to put back.
    pub fn expired(&mut self, now: u64) -> Vec<(String, PaneRule)> {
        let (done, keep): (Vec<_>, Vec<_>) = self.grants.drain(..).partition(|g| g.until_ms <= now);
        self.grants = keep;
        done.into_iter().map(|g| (g.pane_id, g.before)).collect()
    }

    /// The person set the agent's rule by hand: a running grant for it is over (their choice wins).
    pub fn forget_grant(&mut self, pane_id: &str) {
        self.grants.retain(|g| g.pane_id != pane_id);
    }
}

static ASKS: once_cell::sync::Lazy<Mutex<Asks>> = once_cell::sync::Lazy::new(Default::default);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A phone asks. The notice for the PC is the returned ask.
pub fn request(device_id: &str, device_name: &str, pane_id: &str) -> Result<Ask, Refusal> {
    ASKS.lock().ask(device_id, device_name, pane_id, pane_rules::rule(pane_id), now_ms())
}

pub fn pending() -> Vec<Ask> {
    ASKS.lock().pending()
}

/// The person's answer from the PC. Allow sets the agent to on/full and puts the old rule back after 15 minutes.
pub fn answer(id: &str, allow: bool) -> Result<Ask, String> {
    let now = now_ms();
    let mut asks = ASKS.lock();
    let Some(pane) = asks.pending.iter().find(|ask| ask.id == id).map(|ask| ask.pane_id.clone()) else {
        return Err("That ask is not waiting any more.".into());
    };
    // A grant that already runs (maybe from before a restart) keeps the rule the person had set.
    let rule_now = pane_rules::grant_before(&pane).unwrap_or_else(|| pane_rules::rule(&pane));
    let Some((ask, before)) = asks.answer(id, allow, rule_now, now) else {
        return Err("That ask is not waiting any more.".into());
    };
    drop(asks);
    if before.is_some() {
        // The grant and its end time are kept in the rules file; the timer below only tidies up on time.
        pane_rules::grant(&ask.pane_id, now + GRANT_MS)?;
        schedule_restore();
    }
    Ok(ask)
}

fn schedule_restore() {
    let _ = std::thread::Builder::new().name("pm-control-ask-restore".into()).spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(GRANT_MS + 500));
        restore_expired(now_ms());
    });
}

/// Put back every rule whose 15 minutes are over (kept in the rules file, so this also works after a restart).
pub fn restore_expired(now: u64) {
    ASKS.lock().expired(now);
    pane_rules::settle_at(now);
}

/// The person changed an agent's rule by hand: a running grant for it ends now.
pub fn rule_changed_by_person(pane_id: &str) {
    ASKS.lock().forget_grant(pane_id);
}

#[cfg(test)]
#[path = "control_ask_tests.rs"]
mod tests;
