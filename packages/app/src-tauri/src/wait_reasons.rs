//! The words a wait returns in its `reason` field, in one place so the side that answers a wait and the side that
//! loops on it cannot drift apart again. Terminal runs and chat sessions both end with `matched_state`; `terminal`
//! is kept for operations that end without a matching state.

/// The status the caller asked for was seen (a terminal run or a chat session).
pub const MATCHED_STATE: &str = "matched_state";
/// The work ended on its own: completed, failed or cancelled.
pub const TERMINAL: &str = "terminal";
/// This slice of the wait ended before the work did. The caller may ask again.
pub const TIMEOUT: &str = "timeout";
/// The deadline passed while the agent still reports background work.
pub const BACKGROUND: &str = "background";
/// `wake_on_progress` was asked for and the work changed. This is a wake, not an end: the caller asks again.
pub const REVISION_CHANGED: &str = "revision_changed";

/// The word chat waits used before [`MATCHED_STATE`] was shared with the terminal path. Kept only so a newer tool
/// program still understands an older app.
pub const STATUS_LEGACY: &str = "status";

/// Whether a wait is over and its result is final.
pub fn finished(reason: &str) -> bool {
    matches!(reason, MATCHED_STATE | TERMINAL | STATUS_LEGACY)
}

/// Whether the wait should return to the caller now: it finished, or the caller asked to wake on any change.
pub fn wakes(reason: &str) -> bool {
    finished(reason) || reason == REVISION_CHANGED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_finished_reasons_end_a_wait() {
        for reason in [MATCHED_STATE, TERMINAL, STATUS_LEGACY] {
            assert!(finished(reason), "{reason}");
        }
        for reason in [TIMEOUT, BACKGROUND, "", "revision_changed"] {
            assert!(!finished(reason), "{reason}");
        }
        assert!(wakes(REVISION_CHANGED), "a requested progress wake returns to the caller");
        assert!(!wakes(TIMEOUT) && !wakes(BACKGROUND));
    }
}
