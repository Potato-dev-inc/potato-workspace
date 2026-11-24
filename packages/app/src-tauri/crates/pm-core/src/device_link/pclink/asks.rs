//! "Ask <PC> to allow agents": the request for Full, held on the far PC until its person answers.
//!
//! Asking changes nothing by itself. One ask per PC per [`ASK_GAP_MS`] (a "No" does not shorten the wait), a few at a time, and
//! an ask nobody answers fades after [`ASK_LIFE_MS`]. In memory only: an ask that was not answered is gone when the app closes.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

pub const ASK_GAP_MS: u64 = 5 * 60 * 1000;
pub const ASK_LIFE_MS: u64 = 10 * 60 * 1000;
const MAX_PENDING: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Ask {
    pub id: String,
    /// The asking PC's node id in hex.
    pub node: String,
    /// The person's name for it on this PC.
    pub name: String,
    pub at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// That PC already has a card waiting.
    Pending,
    TooSoon { retry_after_ms: u64 },
    Busy,
}

#[derive(Default)]
struct State {
    pending: Vec<Ask>,
    last: HashMap<String, u64>,
    next: u64,
}

#[derive(Default)]
pub struct Asks {
    state: Mutex<State>,
}

impl Asks {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn fade(state: &mut State, now: u64) {
        state.pending.retain(|a| now.saturating_sub(a.at_ms) < ASK_LIFE_MS);
    }

    pub fn request(&self, node: &str, name: &str, now: u64) -> Result<Ask, Refusal> {
        let mut state = self.lock();
        Self::fade(&mut state, now);
        if state.pending.iter().any(|a| a.node == node) {
            return Err(Refusal::Pending);
        }
        if let Some(&at) = state.last.get(node) {
            let wait = ASK_GAP_MS.saturating_sub(now.saturating_sub(at));
            if wait > 0 {
                return Err(Refusal::TooSoon { retry_after_ms: wait });
            }
        }
        if state.pending.len() >= MAX_PENDING {
            return Err(Refusal::Busy);
        }
        state.next += 1;
        let ask = Ask { id: format!("full-{now}-{}", state.next), node: node.to_string(), name: name.to_string(), at_ms: now };
        state.last.insert(node.to_string(), now);
        if state.last.len() > 200 {
            state.last.retain(|_, at| now.saturating_sub(*at) < ASK_GAP_MS);
        }
        state.pending.push(ask.clone());
        Ok(ask)
    }

    /// The cards waiting on this PC's screen.
    pub fn pending(&self, now: u64) -> Vec<Ask> {
        let mut state = self.lock();
        Self::fade(&mut state, now);
        state.pending.clone()
    }

    /// Whether that PC has a card waiting (the asking side shows "Waiting for a yes at <PC>").
    pub fn pending_for(&self, node: &str, now: u64) -> bool {
        self.pending(now).iter().any(|a| a.node == node)
    }

    /// The person answered: the card is removed and returned (`None`: no such card). The caller does the granting.
    pub fn take(&self, id: &str, now: u64) -> Option<Ask> {
        let mut state = self.lock();
        Self::fade(&mut state, now);
        let at = state.pending.iter().position(|a| a.id == id)?;
        Some(state.pending.remove(at))
    }

    /// A PC was unpaired or turned off: its card goes away.
    pub fn drop_node(&self, node: &str) {
        self.lock().pending.retain(|a| a.node != node);
    }
}
