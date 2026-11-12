//! "Speed on this PC": numbers worked out from the app's own log file (`startup_stage` lines).
//!
//! Nothing is measured separately and nothing is uploaded: `startup_timing` already writes one line
//! per stage, and this reads them back. A chat start is the stages of one pane up to
//! `chat_session_ready` (the clock starts at `chat_start_begin`, under a temporary key that
//! `startup_carry` ties to the pane id). Only the last 7 days are counted.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

const WINDOW_MS: u64 = 7 * 24 * 3600 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub count: usize,
    pub median_ms: Option<u64>,
    pub last_ms: Option<u64>,
}

fn stat(samples: &[u64]) -> Stat {
    if samples.is_empty() {
        return Stat::default();
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    Stat { count: samples.len(), median_ms: Some(sorted[sorted.len() / 2]), last_ms: samples.last().copied() }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSummary {
    /// From the program starting to the window being ready to open.
    pub app_start: Stat,
    /// A chat started from a session that was already warmed up.
    pub chat_warm: Stat,
    /// A chat started from nothing.
    pub chat_cold: Stat,
    /// Cold starts only: how long the agent took to answer its first hello.
    pub handshake: Stat,
}

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{name}=");
    line.split_whitespace().find_map(|t| t.strip_prefix(key.as_str())).map(|v| v.trim_matches('"'))
}

fn line_time_ms(line: &str) -> Option<u64> {
    let first = line.split_whitespace().next()?;
    let t = chrono::DateTime::parse_from_rfc3339(first).ok()?;
    u64::try_from(t.timestamp_millis()).ok()
}

/// Work out the summary from log lines, oldest first. `now_ms` is the current time (UTC, ms).
pub fn summarize<'a>(lines: impl Iterator<Item = &'a str>, now_ms: u64) -> PerfSummary {
    let mut stages: HashMap<String, Vec<(String, u64, usize)>> = HashMap::new();
    let mut alias: HashMap<String, String> = HashMap::new();
    for (seq, line) in lines.enumerate() {
        if line_time_ms(line).is_some_and(|t| now_ms.saturating_sub(t) > WINDOW_MS) {
            continue;
        }
        if line.contains("startup_carry") {
            if let (Some(from), Some(to)) = (field(line, "from"), field(line, "to")) {
                alias.insert(from.to_string(), to.to_string());
            }
        } else if line.contains("startup_stage") {
            if let (Some(pane), Some(name), Some(ms)) = (field(line, "pane"), field(line, "name"), field(line, "elapsed_ms")) {
                if let Ok(ms) = ms.parse::<u64>() {
                    stages.entry(pane.to_string()).or_default().push((name.to_string(), ms, seq));
                }
            }
        }
    }
    // Stages logged under a temporary key belong to the pane it was carried to.
    let mut merged: HashMap<String, Vec<(String, u64, usize)>> = HashMap::new();
    for (key, list) in stages {
        let mut target = key.as_str();
        for _ in 0..4 {
            match alias.get(target) {
                Some(next) => target = next.as_str(),
                None => break,
            }
        }
        merged.entry(target.to_string()).or_default().extend(list);
    }
    // (when it finished, value), so "last" is the most recent one.
    let (mut app, mut warm, mut cold, mut handshake) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for list in merged.values() {
        let at = |name: &str| list.iter().find(|(n, _, _)| n == name).map(|(_, ms, seq)| (*ms, *seq));
        if let Some((ms, seq)) = at("app_setup_done") {
            app.push((seq, ms));
        }
        let Some((ready, seq)) = at("chat_session_ready") else { continue };
        if at("chat_warm_hit").is_some() {
            warm.push((seq, ready));
        } else {
            cold.push((seq, ready));
            if let Some((registered, _)) = at("chat_pane_registered") {
                handshake.push((seq, ready.saturating_sub(registered)));
            }
        }
    }
    let by_time = |mut v: Vec<(usize, u64)>| {
        v.sort_unstable();
        v.into_iter().map(|(_, ms)| ms).collect::<Vec<u64>>()
    };
    let (app, warm, cold, handshake) = (by_time(app), by_time(warm), by_time(cold), by_time(handshake));
    PerfSummary { app_start: stat(&app), chat_warm: stat(&warm), chat_cold: stat(&cold), handshake: stat(&handshake) }
}

/// Read every log file in `dir` (oldest file first) and summarize.
pub fn summarize_dir(dir: &Path, now_ms: u64) -> PerfSummary {
    let mut text = String::new();
    for path in super::logfile::files_in(dir).into_iter().rev() {
        if let Ok(bytes) = std::fs::read(&path) {
            text.push_str(&String::from_utf8_lossy(&bytes));
            text.push('\n');
        }
    }
    summarize(text.lines().filter(|l| l.contains("startup_")), now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000; // 2027-01-15

    fn ts(ms_ago: u64) -> String {
        chrono::DateTime::from_timestamp_millis((NOW - ms_ago) as i64).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
    }

    fn stage(ago: u64, pane: &str, name: &str, ms: u64) -> String {
        format!("{}  INFO startup_stage name={name} elapsed_ms={ms} pane={pane}", ts(ago))
    }

    #[test]
    fn warm_and_cold_chat_starts_are_told_apart_and_carried_keys_are_joined() {
        let day = 24 * 3600 * 1000;
        let lines = vec![
            // a cold start: stages 1-2 under a temporary key, the rest under the pane
            stage(day, "chat-start-x-1", "chat_start_begin", 0),
            stage(day, "chat-start-x-1", "chat_warm_miss", 5),
            format!("{}  INFO startup_carry from=chat-start-x-1 to=pane-1", ts(day)),
            stage(day, "pane-1", "chat_pane_registered", 100),
            stage(day, "pane-1", "chat_session_ready", 2100),
            // a warm start
            stage(2000, "chat-start-x-2", "chat_start_begin", 0),
            stage(2000, "chat-start-x-2", "chat_warm_hit", 3),
            format!("{}  INFO startup_carry from=chat-start-x-2 to=pane-2", ts(2000)),
            stage(1000, "pane-2", "chat_pane_registered", 40),
            stage(1000, "pane-2", "chat_session_ready", 400),
            stage(500, "app", "app_setup_done", 1500),
        ];
        let s = summarize(lines.iter().map(String::as_str), NOW);
        assert_eq!(s.chat_cold.median_ms, Some(2100));
        assert_eq!(s.chat_warm.median_ms, Some(400));
        assert_eq!(s.handshake.median_ms, Some(2000));
        assert_eq!(s.app_start.last_ms, Some(1500));
        assert_eq!(s.chat_warm.count, 1);
    }

    #[test]
    fn median_and_last_and_the_seven_day_window() {
        let day = 24 * 3600 * 1000;
        let mut lines: Vec<String> = [3000, 1000, 2000].iter().enumerate().map(|(i, ms)| stage(10_000 - i as u64, &format!("p{i}"), "chat_session_ready", *ms)).collect();
        lines.insert(0, stage(8 * day, "old", "chat_session_ready", 99_999)); // too old
        let s = summarize(lines.iter().map(String::as_str), NOW);
        assert_eq!(s.chat_cold.count, 3);
        assert_eq!(s.chat_cold.median_ms, Some(2000));
        assert_eq!(s.chat_cold.last_ms, Some(2000));
    }

    #[test]
    fn no_log_means_empty_numbers() {
        assert_eq!(summarize(std::iter::empty(), NOW), PerfSummary::default());
    }
}
