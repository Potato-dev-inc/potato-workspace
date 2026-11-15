//! Today's number of model calls (the brain's replies and the model gate's questions) and the daily cap. The
//! brain uses the person's own key, so the count is shown on the Discord card and the cap cannot be passed.
//!
//! The count lives in a small file next to the settings (`discord-calls.json`), so a restart does not reset a
//! day. A new local day starts at zero.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{FixedOffset, TimeZone, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::companion::social::llm::{CompleteError, Completer};

/// A day's allowance when the person has not chosen another.
pub const DEFAULT_CAP: u32 = 200;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
struct Saved {
    date: String,
    count: u32,
}

pub struct DailyCalls {
    path: Option<PathBuf>,
    cap: u32,
    offset_secs: i32,
    state: Mutex<Saved>,
}

fn day_of(ms: i64, offset_secs: i32) -> String {
    let zone = FixedOffset::east_opt(offset_secs).unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero offset"));
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&zone).format("%Y-%m-%d").to_string()
}

impl DailyCalls {
    /// `path` is where the count is kept; `None` keeps it in memory only (tests).
    pub fn open(path: Option<PathBuf>, cap: u32, offset_secs: i32) -> Self {
        let saved = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Saved>(&t).ok())
            .unwrap_or_default();
        Self { path, cap, offset_secs, state: Mutex::new(saved) }
    }

    pub fn cap(&self) -> u32 {
        self.cap
    }

    /// Calls used today.
    pub fn used(&self, now_ms: i64) -> u32 {
        let today = day_of(now_ms, self.offset_secs);
        let state = self.state.lock();
        if state.date == today {
            state.count
        } else {
            0
        }
    }

    /// Takes one call. False (and nothing counted) when today's cap is used up.
    pub fn take(&self, now_ms: i64) -> bool {
        let today = day_of(now_ms, self.offset_secs);
        let mut state = self.state.lock();
        if state.date != today {
            *state = Saved { date: today, count: 0 };
        }
        if state.count >= self.cap {
            return false;
        }
        state.count += 1;
        if let Some(path) = &self.path {
            if let Ok(text) = serde_json::to_string(&*state) {
                let _ = crate::companion::store::write_private_text(path, &text);
            }
        }
        true
    }
}

/// A model gate whose every question uses one of today's calls. When the allowance is gone it cannot tell, and
/// the chain falls to the rules.
pub struct CountedCompleter {
    pub inner: Arc<dyn Completer>,
    pub calls: Arc<DailyCalls>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Completer for CountedCompleter {
    fn complete(&self, prompt: &str, timeout: Duration) -> Result<String, CompleteError> {
        if !self.calls.take((self.clock)()) {
            return Err(CompleteError::Capped);
        }
        self.inner.complete(prompt, timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    #[test]
    fn it_counts_up_to_the_cap_then_refuses_without_counting() {
        let calls = DailyCalls::open(None, 3, 0);
        assert_eq!(calls.used(1_000), 0);
        assert!(calls.take(1_000) && calls.take(2_000) && calls.take(3_000));
        assert!(!calls.take(4_000));
        assert_eq!(calls.used(4_000), 3);
    }

    #[test]
    fn a_new_day_starts_at_zero_in_the_local_zone() {
        let calls = DailyCalls::open(None, 2, 8 * 3600);
        assert!(calls.take(0) && calls.take(1));
        assert!(!calls.take(2));
        // 16:00 UTC is midnight in UTC+8: a new local day.
        let next = 16 * 3_600_000;
        assert_eq!(calls.used(next), 0);
        assert!(calls.take(next));
        assert_eq!(calls.used(next + DAY - 1), 1, "still the same local day");
        assert_eq!(calls.used(next + DAY), 0, "the day after");
    }

    #[test]
    fn the_count_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("pm-discord-calls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("discord-calls.json");
        let first = DailyCalls::open(Some(path.clone()), 5, 0);
        assert!(first.take(1_000) && first.take(2_000));
        let again = DailyCalls::open(Some(path), 5, 0);
        assert_eq!(again.used(3_000), 2);
    }

    struct Ok1;
    impl Completer for Ok1 {
        fn complete(&self, _prompt: &str, _timeout: Duration) -> Result<String, CompleteError> {
            Ok("YES".into())
        }
    }

    #[test]
    fn a_counted_completer_uses_a_call_and_stops_at_the_cap() {
        let calls = Arc::new(DailyCalls::open(None, 1, 0));
        let counted = CountedCompleter { inner: Arc::new(Ok1), calls: calls.clone(), clock: Arc::new(|| 5_000) };
        assert_eq!(counted.complete("q", Duration::from_secs(1)), Ok("YES".into()));
        assert_eq!(counted.complete("q", Duration::from_secs(1)), Err(CompleteError::Capped));
        assert_eq!(calls.used(5_000), 1);
    }
}
