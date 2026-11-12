//! `log_ui_error`: the screen reports an error it caught (a thrown error, a rejected promise) and it
//! lands in the same log file as the app's own messages (redacted there, like every line).
//!
//! A screen stuck in a loop could flood the log, so at most `MAX_PER_MINUTE` are taken per minute;
//! the rest are dropped and counted.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_PER_MINUTE: usize = 20;
const MAX_MESSAGE: usize = 1_000;
const MAX_SOURCE: usize = 120;
const MAX_STACK: usize = 2_000;

/// Allows `limit` hits in any sliding `window`.
pub struct RateLimit {
    hits: VecDeque<Instant>,
    limit: usize,
    window: Duration,
}

impl RateLimit {
    pub fn new(limit: usize, window: Duration) -> Self {
        Self { hits: VecDeque::new(), limit, window }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        while self.hits.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            self.hits.pop_front();
        }
        if self.hits.len() >= self.limit {
            return false;
        }
        self.hits.push_back(now);
        true
    }
}

static LIMIT: Lazy<Mutex<RateLimit>> = Lazy::new(|| Mutex::new(RateLimit::new(MAX_PER_MINUTE, Duration::from_secs(60))));

fn one_line(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() <= max {
        return flat;
    }
    let mut cut = max;
    while !flat.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{} ...", &flat[..cut])
}

/// The log line for a screen error (one line, bounded).
pub fn ui_error_line(message: &str, source: &str, stack: &str) -> String {
    let mut line = format!("ui_error source={} message={}", one_line(source, MAX_SOURCE), one_line(message, MAX_MESSAGE));
    let stack = one_line(stack, MAX_STACK);
    if !stack.is_empty() {
        line.push_str(&format!(" stack={stack}"));
    }
    line
}

/// Returns false when the report was dropped by the rate limit.
pub fn log_with(limit: &mut RateLimit, now: Instant, message: &str, source: &str, stack: &str) -> bool {
    if !limit.allow(now) {
        return false;
    }
    tracing::error!("{}", ui_error_line(message, source, stack));
    true
}

#[tauri::command]
pub fn log_ui_error(message: String, source: Option<String>, stack: Option<String>) -> bool {
    log_with(&mut LIMIT.lock(), Instant::now(), &message, source.as_deref().unwrap_or("ui"), stack.as_deref().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_twenty_a_minute_get_through() {
        let mut limit = RateLimit::new(MAX_PER_MINUTE, Duration::from_secs(60));
        let t0 = Instant::now();
        let taken = (0..50).filter(|i| limit.allow(t0 + Duration::from_millis(*i))).count();
        assert_eq!(taken, 20);
        assert!(limit.allow(t0 + Duration::from_secs(61)), "the window slides");
    }

    #[test]
    fn a_report_is_one_bounded_line() {
        let long = "boom\nsecond line ".repeat(500);
        let line = ui_error_line(&long, "unhandledrejection", "at a\n at b");
        assert!(!line.contains('\n'));
        assert!(line.starts_with("ui_error source=unhandledrejection message=boom second line"));
        assert!(line.len() < MAX_MESSAGE + MAX_STACK + 200);
        assert!(line.ends_with("stack=at a at b"));
    }
}
