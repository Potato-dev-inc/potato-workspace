//! Cloudflare limits for free quick addresses: spotting the "too many requests" refusal in cloudflared's output,
//! the start-up timeout, and the back-off that stops tight restart loops (each restart asks Cloudflare for a new address).

use std::time::{Duration, Instant};

/// How long a quick tunnel may stay on "starting" before the app says so instead of waiting silently.
pub const START_TIMEOUT: Duration = Duration::from_secs(45);
/// The shortest wait before cloudflared is started again after a failed start.
const MIN_GAP: Duration = Duration::from_secs(120);
/// The longest wait that grows by doubling; after `MAX_FAILURES` failures in a row the wait is `LONG_GAP`.
const MAX_GAP: Duration = Duration::from_secs(30 * 60);
const MAX_FAILURES: u32 = 6;
/// Cloudflare's own block lasts about an hour.
const LONG_GAP: Duration = Duration::from_secs(60 * 60);

pub const PROBLEM_RATE_LIMITED: &str = "rate_limited";
pub const PROBLEM_SLOW_START: &str = "slow_start";
pub const PROBLEM_TOO_SOON: &str = "too_soon";

/// The plain sentence for the CLI and logs (the app screen shows its own en / zh-TW wording for the same code).
pub fn problem_sentence(problem: &str) -> &'static str {
    match problem {
        PROBLEM_RATE_LIMITED => "Cloudflare is limiting new quick addresses from this network. Wait about an hour, or use your own Worker address / a named tunnel.",
        PROBLEM_SLOW_START => "Cloudflare has not given a quick address yet. Press Restart tunnel in a few minutes, or use your own Worker address / a named tunnel.",
        _ => "Starting again so soon would make Cloudflare limit this network for longer. Wait a few minutes first.",
    }
}

/// True when a cloudflared output line says Cloudflare refused to make a quick tunnel (HTTP 429, error 1015, rate limit).
pub fn is_rate_limited(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    line.contains("429 too many requests")
        || line.contains("error code: 1015")
        || line.contains("error 1015")
        || line.contains("rate limit")
        || line.contains("rate-limit")
        || (line.contains("429") && line.contains("quick tunnel"))
}

/// Failed starts of a quick tunnel, and when cloudflared was last started.
#[derive(Debug, Default)]
pub struct Backoff {
    failures: u32,
    last_start: Option<Instant>,
    last_failed_generation: Option<u64>,
    /// The last failure was Cloudflare's own limit: the long wait applies at once and cannot be skipped.
    rate_limited: bool,
}

impl Backoff {
    /// How long to wait after the last start, given the failures so far (zero failures: no wait).
    fn gap(&self) -> Duration {
        match self.failures {
            0 => Duration::ZERO,
            _ if self.rate_limited => LONG_GAP,
            n if n >= MAX_FAILURES => LONG_GAP,
            n => (MIN_GAP * 2u32.pow(n - 1)).min(MAX_GAP),
        }
    }

    /// `Ok` when cloudflared may start now, else how long to wait.
    pub fn check(&self, now: Instant) -> Result<(), Duration> {
        let Some(last) = self.last_start else { return Ok(()) };
        let wait = self.gap().saturating_sub(now.saturating_duration_since(last));
        if wait.is_zero() { Ok(()) } else { Err(wait) }
    }

    pub fn started(&mut self, now: Instant) {
        self.last_start = Some(now);
    }

    /// Counts one failure per launch, however many lines or timers report it. True the first time.
    pub fn failed(&mut self, generation: u64) -> bool {
        if self.last_failed_generation == Some(generation) {
            return false;
        }
        self.last_failed_generation = Some(generation);
        self.failures = self.failures.saturating_add(1);
        true
    }

    /// Cloudflare refused with its limit (429 / 1015): its block lasts about an hour, so no short first step.
    pub fn failed_rate_limited(&mut self, generation: u64) {
        self.failed(generation);
        self.rate_limited = true;
    }

    /// "Try anyway": drop the wait once. Refused (false) after Cloudflare's own limit, where asking again only extends it.
    pub fn skip_wait(&mut self) -> bool {
        if self.rate_limited {
            return false;
        }
        self.last_start = None;
        true
    }

    /// An address came up: the next restart is free again.
    pub fn succeeded(&mut self) {
        self.failures = 0;
        self.rate_limited = false;
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_the_cloudflare_refusal_in_cloudflared_output() {
        assert!(is_rate_limited(r#"ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": 429 Too Many Requests"#));
        assert!(is_rate_limited("error code: 1015"));
        assert!(is_rate_limited("You are being rate limited"));
        assert!(is_rate_limited("Error 1015: You are being rate limited"));
        assert!(!is_rate_limited("INF Registered tunnel connection connIndex=0 port 14290"));
        assert!(!is_rate_limited("INF Requesting new quick Tunnel on trycloudflare.com..."));
    }

    #[test]
    fn a_first_start_and_a_start_after_success_are_never_held_back() {
        let t0 = Instant::now();
        let mut b = Backoff::default();
        assert!(b.check(t0).is_ok());
        b.started(t0);
        assert!(b.check(t0).is_ok());
        b.failed(1);
        b.succeeded();
        assert!(b.check(t0).is_ok());
    }

    #[test]
    fn after_a_failure_a_restart_waits_two_minutes_then_longer() {
        let t0 = Instant::now();
        let mut b = Backoff::default();
        b.started(t0);
        b.failed(1);
        assert_eq!(b.check(t0 + Duration::from_secs(30)), Err(Duration::from_secs(90)));
        assert!(b.check(t0 + Duration::from_secs(120)).is_ok());
        b.started(t0 + Duration::from_secs(120));
        b.failed(2);
        assert_eq!(b.check(t0 + Duration::from_secs(121)), Err(Duration::from_secs(239)));
    }

    #[test]
    fn the_wait_stops_growing_and_attempts_are_capped_at_one_an_hour() {
        let t0 = Instant::now();
        let mut b = Backoff::default();
        b.started(t0);
        for g in 1..=5 {
            b.failed(g);
        }
        assert_eq!(b.check(t0), Err(MAX_GAP)); // 120 * 2^4 = 1920 s, capped at 30 minutes
        b.failed(6);
        assert_eq!(b.check(t0), Err(LONG_GAP));
        assert!(b.check(t0 + LONG_GAP).is_ok());
    }

    #[test]
    fn a_cloudflare_limit_goes_straight_to_the_long_wait_and_cannot_be_skipped() {
        let t0 = Instant::now();
        let mut b = Backoff::default();
        b.started(t0);
        b.failed_rate_limited(1);
        assert_eq!(b.check(t0), Err(LONG_GAP));
        assert!(!b.skip_wait());
        assert_eq!(b.check(t0), Err(LONG_GAP));
        b.succeeded();
        assert!(b.check(t0).is_ok());
    }

    #[test]
    fn an_ordinary_failure_can_be_tried_anyway_once() {
        let t0 = Instant::now();
        let mut b = Backoff::default();
        b.started(t0);
        b.failed(1);
        assert!(b.check(t0).is_err());
        assert!(b.skip_wait());
        assert!(b.check(t0).is_ok());
    }

    #[test]
    fn one_launch_counts_as_one_failure_however_many_things_report_it() {
        let mut b = Backoff::default();
        assert!(b.failed(7));
        assert!(!b.failed(7));
        assert_eq!(b.failures(), 1);
    }
}
