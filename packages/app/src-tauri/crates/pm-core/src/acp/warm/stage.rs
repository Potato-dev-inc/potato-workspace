//! Where a standby's start is, in words: `starting program`, `connecting`, `opening session`, `setting model`. The host
//! tells it as the start goes (`LiveHost::start_for`); the row reads it (`Pool::helper_statuses`) so it can say more than
//! "Starting". Kept by helper id; gone as soon as the start ends.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

static STAGES: Lazy<Mutex<HashMap<String, (String, i64)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The start of `helper_id` is at `stage` now.
pub fn note(helper_id: &str, stage: &str) {
    STAGES.lock().insert(helper_id.to_string(), (stage.to_string(), crate::event_log::now_ms()));
}

/// The start ended (it worked or it did not).
pub fn clear(helper_id: &str) {
    STAGES.lock().remove(helper_id);
}

/// The stage and when it began (unix milliseconds).
pub fn get(helper_id: &str) -> Option<(String, i64)> {
    STAGES.lock().get(helper_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stage_is_kept_until_the_start_ends() {
        note("sb-stage-test", "opening session");
        assert_eq!(get("sb-stage-test").map(|s| s.0).as_deref(), Some("opening session"));
        note("sb-stage-test", "setting model");
        assert_eq!(get("sb-stage-test").map(|s| s.0).as_deref(), Some("setting model"));
        clear("sb-stage-test");
        assert_eq!(get("sb-stage-test"), None);
    }
}
