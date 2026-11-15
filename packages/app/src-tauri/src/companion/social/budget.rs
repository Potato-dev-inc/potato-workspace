//! How often it may speak. Pure: the clock is an argument and the state is returned, not changed. Ported from
//! fishd `burst.ts` (`takeBudget`, `budgetFull`, `inSettle`) and `scope.ts` (`takeToken`, the limits).
//!
//! The order matters: the budget is looked at BEFORE the gate is asked, so a full budget costs no model call.

use super::chain::{Chain, Decision};
use super::gate::GateInput;

/// The result of trying to take one place in the budget.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Taken {
    pub ok: bool,
    pub stamps: Vec<i64>,
}

/// Counts only unprompted replies, so being called by name never uses the budget. `max == 0` means no limit.
pub fn take_budget(stamps: &[i64], now_ms: i64, max: usize, window_ms: i64) -> Taken {
    let kept: Vec<i64> = stamps.iter().copied().filter(|at| now_ms - at < window_ms).collect();
    if max > 0 && kept.len() >= max {
        return Taken { ok: false, stamps: kept };
    }
    let mut next = kept;
    next.push(now_ms);
    Taken { ok: true, stamps: next }
}

/// The read-only twin: is the budget full right now? Never uses a place.
pub fn budget_full(stamps: &[i64], now_ms: i64, max: usize, window_ms: i64) -> bool {
    max > 0 && stamps.iter().filter(|at| now_ms - **at < window_ms).count() >= max
}

/// After it speaks unprompted it stays quiet for a while.
pub fn in_settle(now_ms: i64, settle_until_ms: i64) -> bool {
    now_ms < settle_until_ms
}

/// A bucket of tokens that refills with time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bucket {
    pub tokens: f64,
    pub at_ms: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct Limit {
    pub capacity: f64,
    pub refill_per_ms: f64,
}

/// A person starting turns: 6 per 5 minutes (the owner is exempt, checked by the caller).
pub const TURN_LIMIT: Limit = Limit { capacity: 6.0, refill_per_ms: 6.0 / (5.0 * 60_000.0) };
/// At most this many turns wait (running or queued).
pub const QUEUE_LIMIT: usize = 8;

/// Takes one token. Starts full. Returns whether it worked and the next state.
pub fn take_token(bucket: Option<Bucket>, now_ms: i64, limit: Limit) -> (bool, Bucket) {
    let start = bucket.unwrap_or(Bucket { tokens: limit.capacity, at_ms: now_ms });
    let elapsed = (now_ms - start.at_ms).max(0) as f64;
    let tokens = (start.tokens + elapsed * limit.refill_per_ms).min(limit.capacity);
    if tokens < 1.0 {
        return (false, Bucket { tokens, at_ms: now_ms });
    }
    (true, Bucket { tokens: tokens - 1.0, at_ms: now_ms })
}

pub fn queue_full(pending: usize) -> bool {
    pending >= QUEUE_LIMIT
}

/// Asks the chain only when the budget has room. `None` means the budget was full and nothing was asked.
pub fn gate_if_room(chain: &Chain, input: &GateInput, stamps: &[i64], max: usize, window_ms: i64) -> Option<Decision> {
    if budget_full(stamps, input.now_ms, max, window_ms) {
        return None;
    }
    Some(chain.decide(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::social::gate::{Gate, GateMessage};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn the_budget_lets_so_many_through_per_window_and_forgets_old_ones() {
        let window = 30 * 60_000;
        let mut stamps = Vec::new();
        for n in 0..3 {
            let taken = take_budget(&stamps, n * 1000, 3, window);
            assert!(taken.ok, "{n}");
            stamps = taken.stamps;
        }
        let refused = take_budget(&stamps, 5_000, 3, window);
        assert!(!refused.ok);
        assert_eq!(refused.stamps.len(), 3);
        // After the window the first ones are forgotten.
        let later = take_budget(&stamps, window + 1_500, 3, window);
        assert!(later.ok);
        assert_eq!(later.stamps.len(), 2);
    }

    #[test]
    fn full_is_read_only_and_zero_means_no_limit() {
        let stamps = vec![1_000, 2_000];
        assert!(budget_full(&stamps, 3_000, 2, 10_000));
        assert!(!budget_full(&stamps, 3_000, 3, 10_000));
        assert!(!budget_full(&stamps, 3_000, 0, 10_000));
        assert!(!budget_full(&stamps, 20_000, 2, 10_000));
        assert!(take_budget(&stamps, 3_000, 0, 10_000).ok);
        assert!(in_settle(5, 10) && !in_settle(10, 10));
    }

    #[test]
    fn a_person_gets_six_turns_then_waits_for_the_bucket_to_refill() {
        let mut bucket = None;
        for n in 0..6 {
            let (ok, next) = take_token(bucket, n, TURN_LIMIT);
            assert!(ok, "turn {n}");
            bucket = Some(next);
        }
        let (ok, next) = take_token(bucket, 10, TURN_LIMIT);
        assert!(!ok);
        // One token takes 50 seconds to come back (6 per 5 minutes).
        let (again, _) = take_token(Some(next), 10 + 50_001, TURN_LIMIT);
        assert!(again);
        assert!(queue_full(8) && !queue_full(7));
    }

    struct Counting(AtomicUsize);
    impl Gate for Counting {
        fn name(&self) -> &str {
            "counting"
        }
        fn judge(&self, _input: &GateInput) -> Option<bool> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Some(true)
        }
    }

    #[test]
    fn the_budget_is_checked_before_any_gate_call() {
        let gate = Arc::new(Counting(AtomicUsize::new(0)));
        let chain = Chain::build(crate::companion::social::chain::Choice::Llm, None, Some(gate.clone()));
        let input = GateInput {
            messages: vec![GateMessage { author: "a".into(), text: "some line of text".into(), ..Default::default() }],
            now_ms: 10_000,
            ..Default::default()
        };
        // Full: nothing is asked.
        assert!(gate_if_room(&chain, &input, &[9_000, 9_500], 2, 60_000).is_none());
        assert_eq!(gate.0.load(Ordering::SeqCst), 0);
        // Room: asked once.
        let decision = gate_if_room(&chain, &input, &[9_000], 2, 60_000).unwrap();
        assert_eq!(decision.by, "counting");
        assert_eq!(gate.0.load(Ordering::SeqCst), 1);
    }
}
