//! The readers behind `Reader`: small parsers named by the shape of the data, never by an agent.
//!
//! Privacy: only numbers, times and the plan name leave this file. A matched line is parsed as
//! JSON only to take those fields; nothing else from it is kept or logged.

use super::source::WindowSpec;
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How much of the end of a file is read first.
const TAIL_BYTES: u64 = 512 * 1024;
/// A file larger than this is only read from its tail.
const MAX_FULL_BYTES: u64 = 32 * 1024 * 1024;
/// The newest files looked at, at most.
const MAX_FILES: usize = 8;
/// How deep below the folder files are looked for (`sessions/2026/11/10/x.jsonl` is 4).
const MAX_DEPTH: usize = 5;

/// One limit window as shown.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Window {
    /// "5-hour", "Weekly", "Monthly"... from the window's length.
    pub name: String,
    /// 0-100 (above 100 once over).
    pub used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<u64>,
    /// The reset time has passed since the agent last reported: the window started again (0 %).
    pub reset_since: bool,
}

/// What a reader found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reading {
    pub windows: Vec<Window>,
    pub plan: Option<String>,
    pub observed_at_ms: Option<u64>,
    /// The agent said it is stopped at a limit.
    pub reached: bool,
}

/// A window's name from its length in minutes.
pub fn window_name(minutes: Option<u64>, key: &str) -> String {
    match minutes {
        Some(300) => "5-hour".into(),
        Some(1440) => "Daily".into(),
        Some(10080) => "Weekly".into(),
        Some(m) if (40320..=44640).contains(&m) => "Monthly".into(),
        Some(m) if m > 0 && m % 1440 == 0 => format!("{}-day", m / 1440),
        Some(m) if m > 0 && m % 60 == 0 => format!("{}-hour", m / 60),
        Some(m) if m > 0 => format!("{m}-minute"),
        _ => key.to_string(),
    }
}

/// The fields of one rate-limit object, by the table's field names.
pub fn parse_object(
    object: &Value,
    windows: &[WindowSpec],
    plan: Option<&str>,
    reached: Option<&str>,
    now_ms: u64,
) -> Option<Reading> {
    let object = object.as_object()?;
    let mut out = Reading::default();
    for spec in windows {
        let Some(window) = object.get(&spec.key).and_then(Value::as_object) else { continue };
        let Some(used) = window.get(&spec.used).and_then(Value::as_f64) else { continue };
        if !used.is_finite() || used < 0.0 {
            continue;
        }
        let minutes = spec.minutes.as_ref().and_then(|f| window.get(f)).and_then(Value::as_u64);
        let resets_at_ms = spec
            .resets_at
            .as_ref()
            .and_then(|f| window.get(f))
            .and_then(Value::as_u64)
            .and_then(|secs| secs.checked_mul(1000));
        let reset_since = resets_at_ms.is_some_and(|at| at <= now_ms);
        out.windows.push(Window {
            name: window_name(minutes, &spec.key),
            used_percent: if reset_since { 0.0 } else { used },
            minutes,
            resets_at_ms: if reset_since { None } else { resets_at_ms },
            reset_since,
        });
    }
    out.plan = plan.and_then(|f| object.get(f)).and_then(Value::as_str).map(clean_plan);
    out.reached = reached.and_then(|f| object.get(f)).is_some_and(|v| !v.is_null() && v != &Value::Bool(false));
    if out.windows.is_empty() && out.plan.is_none() {
        return None;
    }
    Some(out)
}

/// Plan names are short words (`plus`, `pro`); anything else is dropped rather than shown.
fn clean_plan(plan: &str) -> String {
    let plan = plan.trim();
    if plan.len() <= 24 && plan.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ' ') {
        plan.to_string()
    } else {
        String::new()
    }
}

/// RFC 3339 to Unix milliseconds.
fn parse_time_ms(text: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(text).ok().and_then(|t| u64::try_from(t.timestamp_millis()).ok())
}

/// The last JSON segment of a pointer, quoted, to skip lines quickly (`/payload/rate_limits` -> `"rate_limits"`).
fn needle(pointer: &str) -> String {
    format!("\"{}\"", pointer.rsplit('/').next().unwrap_or(pointer))
}

/// The newest line of `text` whose `object` pointer is a non-null object, as a reading.
pub struct LineSpec<'a> {
    pub object: &'a str,
    pub observed_at: Option<&'a str>,
    pub plan: Option<&'a str>,
    pub reached: Option<&'a str>,
    pub windows: &'a [WindowSpec],
}

pub fn newest_in_text(text: &str, spec: &LineSpec<'_>, now_ms: u64) -> Option<Reading> {
    let needle = needle(spec.object);
    for line in text.lines().rev() {
        if !line.contains(&needle) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(object) = value.pointer(spec.object).filter(|v| v.is_object()) else { continue };
        let Some(mut reading) = parse_object(object, spec.windows, spec.plan, spec.reached, now_ms) else { continue };
        reading.observed_at_ms = spec.observed_at.and_then(|p| value.pointer(p)).and_then(Value::as_str).and_then(parse_time_ms);
        return Some(reading);
    }
    None
}

/// `.jsonl` files under `dir` (to `MAX_DEPTH`), newest first, changed within `max_age`.
pub fn newest_files(dir: &Path, prefix: Option<&str>, max_age: Duration, now: SystemTime) -> Vec<PathBuf> {
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((folder, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") || prefix.is_some_and(|p| !name.starts_with(p)) {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
            if now.duration_since(modified).map(|age| age > max_age).unwrap_or(false) {
                continue;
            }
            found.push((modified, path));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    found.into_iter().take(MAX_FILES).map(|(_, p)| p).collect()
}

/// The end of a file (whole lines only), then the whole file if the end held nothing and it is not too big.
fn read_tail(path: &Path, bytes: u64) -> Option<(String, bool)> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut raw = Vec::new();
    file.read_to_end(&mut raw).ok()?;
    let mut text = String::from_utf8_lossy(&raw).into_owned();
    if start > 0 {
        // The first line is cut; drop it.
        text = text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default();
    }
    Some((text, start == 0))
}

/// The newest reading in the newest files under `<home>/<dir>`.
pub fn read_jsonl(dir: &Path, prefix: Option<&str>, max_age_days: u64, spec: &LineSpec<'_>, now: SystemTime) -> Option<Reading> {
    let now_ms = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let max_age = Duration::from_secs(max_age_days.saturating_mul(86_400));
    for path in newest_files(dir, prefix, max_age, now) {
        let Some((tail, whole)) = read_tail(&path, TAIL_BYTES) else { continue };
        if let Some(reading) = newest_in_text(&tail, spec, now_ms) {
            return Some(reading);
        }
        if !whole {
            if let Some((all, _)) = read_tail(&path, MAX_FULL_BYTES) {
                if let Some(reading) = newest_in_text(&all, spec, now_ms) {
                    return Some(reading);
                }
            }
        }
    }
    None
}

/// What a status command said about the login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignIn {
    SignedIn,
    /// A login existed but no longer works.
    Expired,
    SignedOut,
}

/// Parse a status command's output: the first `{` starts the JSON (some CLIs print a banner first).
pub fn parse_status(output: &str, signed_in: &str, had_login: Option<&str>) -> Option<SignIn> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    let value: Value = serde_json::from_str(output.get(start..=end)?).ok()?;
    let on = value.pointer(signed_in)?.as_bool()?;
    if on {
        return Some(SignIn::SignedIn);
    }
    let had = had_login.and_then(|p| value.pointer(p)).and_then(Value::as_bool).unwrap_or(false);
    Some(if had { SignIn::Expired } else { SignIn::SignedOut })
}
