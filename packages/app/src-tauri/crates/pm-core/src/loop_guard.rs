//! The generic error-like test every agent profile starts from (moved out of the app's `loop_guard`, which re-exports it).

use once_cell::sync::Lazy;
use regex::Regex;

/// Generic error-likeness; profiles extend it (`TuiProfile::is_error_line`).
static ERROR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(error|errors|failed|failure|exception|traceback|panicked|fatal|cannot|can't|could not|couldn't|unable to|not found|undefined|permission denied|access denied|timed out|timeout|enoent|eacces|segmentation fault|unresolved|unexpected)\b|\bTS\d{4}\b|\bE\d{4}\b",
    )
    .expect("error regex")
});
/// Lines that mention errors without being one ("0 failed", "no errors", "fixed the error").
static NOT_ERROR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b0 (errors?|failed|failures?)\b|\bno (errors?|failures?|issues)\b|\bwithout (errors?|failures?)\b|\b(fixed|resolved|fixes|fixing)\b")
        .expect("not error regex")
});
/// The generic error-like test every profile starts from.
pub fn default_error_line(line: &str) -> bool {
    let line = line.trim();
    !line.is_empty() && line.chars().count() <= 400 && ERROR_RE.is_match(line) && !NOT_ERROR_RE.is_match(line)
}

