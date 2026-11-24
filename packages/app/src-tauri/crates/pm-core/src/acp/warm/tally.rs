//! What a standby row shows besides its state: how many times an agent's task used the seat today, and the last reason an
//! agent's task passed the seat by. Memory only: a restart clears both. The day is the person's local day, so the count starts
//! again at local midnight.

use std::collections::BTreeMap;

use serde::Serialize;

/// Why a task that asked for this kind of helper did not take a standby.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// The seat is on another model than the task asked for.
    DifferentModel,
    /// The seat is for another project.
    OtherProject,
    /// Another agent's task is running on the seat.
    Busy,
    /// The person is using the seat's chat.
    YouWereUsingIt,
}

#[derive(Debug, Default)]
pub struct Tally {
    /// Helper id -> (local day, claims that day).
    uses: BTreeMap<String, (String, u32)>,
    /// Helper id -> the last reason.
    skips: BTreeMap<String, SkipReason>,
}

impl Tally {
    /// One successful claim of helper `id` on local day `day`. A count from an earlier day starts again at one.
    pub fn count_claim(&mut self, id: &str, day: &str) {
        let entry = self.uses.entry(id.to_string()).or_insert_with(|| (day.to_string(), 0));
        if entry.0 != day {
            *entry = (day.to_string(), 0);
        }
        entry.1 += 1;
    }

    /// Claims of helper `id` on local day `day` (zero on any other day).
    pub fn used_today(&self, id: &str, day: &str) -> u32 {
        self.uses.get(id).filter(|(d, _)| d == day).map_or(0, |(_, n)| *n)
    }

    /// Helper `id` was passed by a task that asked for its kind: this is the reason now.
    pub fn note_skip(&mut self, id: &str, reason: SkipReason) {
        self.skips.insert(id.to_string(), reason);
    }

    pub fn last_skip(&self, id: &str) -> Option<SkipReason> {
        self.skips.get(id).copied()
    }

    /// The helper was removed: nothing is kept for it.
    pub fn forget(&mut self, id: &str) {
        self.uses.remove(id);
        self.skips.remove(id);
    }
}

/// The person's local day (`YYYY-MM-DD`) at `now_ms` (unix milliseconds).
pub fn local_day(now_ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(now_ms).single().map(|t| t.format("%Y-%m-%d").to_string()).unwrap_or_default()
}
