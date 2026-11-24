//! One `wait_until` for every test, with all waits stretched by `PM_TEST_SLOW` (a whole number, default 1).
//!
//! On a busy PC (a build running beside the tests) a process starts, answers and exits several times slower, so a
//! test that waits a fixed wall-clock time fails for no reason. Run `PM_TEST_SLOW=3 cargo test --lib` there: every
//! wait here, every short product timeout a test sets through [`slow_secs`], and every "pid is gone" wait grows 3x.
//! Waits return as soon as the condition is true, so a bigger factor never makes a passing run slower.

use parking_lot::{Condvar, Mutex};
use std::cell::Cell;
use std::sync::OnceLock;
use std::thread::ThreadId;
use std::time::{Duration, Instant};

/// How many times longer tests wait. `PM_TEST_SLOW` unset, empty, 0 or not a number is 1.
pub fn factor() -> u64 {
    static FACTOR: OnceLock<u64> = OnceLock::new();
    *FACTOR.get_or_init(|| parse_factor(std::env::var("PM_TEST_SLOW").ok().as_deref()))
}

fn parse_factor(text: Option<&str>) -> u64 {
    text.and_then(|t| t.trim().parse::<u64>().ok()).filter(|n| *n >= 1).unwrap_or(1).min(100)
}

/// `secs` stretched by the factor.
pub fn slow_secs(secs: u64) -> u64 {
    secs.saturating_mul(factor())
}

/// `ms` stretched by the factor.
pub fn slow_ms(ms: u64) -> u64 {
    ms.saturating_mul(factor())
}

/// `d` stretched by the factor.
pub fn slow(d: Duration) -> Duration {
    d.saturating_mul(factor() as u32)
}

/// Waits up to `secs` (times the factor) for `condition`; true as soon as it holds. Checks once more at the end.
pub fn wait_until(secs: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(slow_secs(secs));
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    condition()
}

/// Like [`wait_until`] but panics with "timed out waiting for ..." instead of returning false.
pub fn wait_for(what: &str, secs: u64, condition: impl FnMut() -> bool) {
    assert!(wait_until(secs, condition), "timed out waiting for: {what}");
}

/// A counting gate. Tests that start real processes take a permit so a busy suite never runs more than `N` at once.
pub struct Gate {
    free: Mutex<usize>,
    wake: Condvar,
}

thread_local! {
    /// Permits this thread already holds. A test that builds two rigs takes the gate once, so two tests that each
    /// hold one permit can never wait on each other for a second.
    static HELD: Cell<usize> = const { Cell::new(0) };
}

/// Holding it keeps one permit (or nothing, when this thread already holds one); dropping it gives it back.
pub struct Permit<'a> {
    gate: &'a Gate,
    real: bool,
    thread: ThreadId,
}

impl Gate {
    pub const fn new(permits: usize) -> Self {
        Gate { free: parking_lot::const_mutex(permits), wake: Condvar::new() }
    }

    /// Blocks until a permit is free. A thread that already holds a permit gets a second one without waiting.
    pub fn take(&self) -> Permit<'_> {
        let thread = std::thread::current().id();
        if HELD.with(|h| h.get()) > 0 {
            return Permit { gate: self, real: false, thread };
        }
        let mut free = self.free.lock();
        while *free == 0 {
            self.wake.wait(&mut free);
        }
        *free -= 1;
        HELD.with(|h| h.set(1));
        Permit { gate: self, real: true, thread }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if !self.real {
            return;
        }
        if std::thread::current().id() == self.thread {
            HELD.with(|h| h.set(0));
        }
        *self.gate.free.lock() += 1;
        self.gate.wake.notify_one();
    }
}

static PROCESS_GATE: Gate = Gate::new(2);

/// The process-wide gate (2 permits) for rigs that start real processes. A rig keeps the permit until it is dropped.
pub fn process_permit() -> Permit<'static> {
    PROCESS_GATE.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn the_factor_reads_a_whole_number_and_falls_back_to_one() {
        assert_eq!(parse_factor(None), 1);
        assert_eq!(parse_factor(Some("")), 1);
        assert_eq!(parse_factor(Some("0")), 1);
        assert_eq!(parse_factor(Some("abc")), 1);
        assert_eq!(parse_factor(Some(" 3 ")), 3);
        assert_eq!(parse_factor(Some("100000")), 100, "capped");
    }

    #[test]
    fn the_scale_applies_to_seconds_and_durations() {
        let f = factor();
        assert_eq!(slow_secs(2), 2 * f);
        assert_eq!(slow(Duration::from_millis(50)), Duration::from_millis(50 * f));
    }

    #[test]
    fn a_true_condition_returns_at_once_whatever_the_factor() {
        let started = Instant::now();
        assert!(wait_until(60, || true));
        wait_for("nothing", 60, || true);
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    }

    #[test]
    fn a_condition_that_turns_true_later_is_waited_for() {
        let flag = Arc::new(AtomicUsize::new(0));
        let setter = {
            let flag = flag.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(60));
                flag.store(1, Ordering::SeqCst);
            })
        };
        assert!(wait_until(10, || flag.load(Ordering::SeqCst) == 1));
        setter.join().unwrap();
    }

    #[test]
    fn a_condition_that_never_holds_gives_up_after_the_scaled_time() {
        let started = Instant::now();
        assert!(!wait_until(0, || false), "0 s means one last look only");
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn the_gate_lets_only_its_permits_run_at_once() {
        static GATE: Gate = Gate::new(2);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..6)
            .map(|_| {
                let (running, peak) = (running.clone(), peak.clone());
                std::thread::spawn(move || {
                    let _permit = GATE.take();
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(30));
                    running.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }
}
