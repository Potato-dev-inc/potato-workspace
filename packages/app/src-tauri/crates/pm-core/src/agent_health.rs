//! Asking a CLI for its `--version` (a hard timeout, one short line back). The window-free half of the app's agent health:
//! the app re-exports these and keeps the checks that start a deep test or read the hook health.

use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::tui::VersionCommand;

/// Longest a `--version` call may take before the agent counts as broken.
pub const VERSION_TIMEOUT: Duration = Duration::from_millis(4000);

/// How long a good `--version` answer is reused. The doctor, first-run and the Agents settings all
/// ask on every visit, one process per agent each time (nine PowerShells for Cursor-style launchers).
const VERSION_TTL: Duration = Duration::from_secs(30);

/// [`run_version`], but a successful answer for the same program and arguments is remembered for
/// [`VERSION_TTL`]. Failures and time-outs are never remembered, so Recheck after a fix always asks again.
pub fn run_version_cached(command: &VersionCommand, timeout: Duration) -> VersionOutcome {
    static VERSIONS: once_cell::sync::Lazy<crate::proc_util::TtlCache<(String, Vec<String>), String>> =
        once_cell::sync::Lazy::new(|| crate::proc_util::TtlCache::new(VERSION_TTL));
    let mut fresh = None;
    let cached = VERSIONS.get_or_probe((command.program.clone(), command.args.clone()), || {
        let outcome = run_version(command, timeout);
        let version = match &outcome {
            VersionOutcome::Version(version) => Some(version.clone()),
            _ => None,
        };
        fresh = Some(outcome);
        version
    });
    match (fresh, cached) {
        (Some(outcome), _) => outcome,
        (None, Some(version)) => VersionOutcome::Version(version),
        (None, None) => VersionOutcome::Failed("no answer".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum VersionOutcome {
    Version(String),
    Failed(String),
    TimedOut,
}

/// Runs the version command with a hard timeout and returns its first non-empty line.
pub fn run_version(command: &VersionCommand, timeout: Duration) -> VersionOutcome {
    let mut process = crate::proc_util::hidden_command(&command.program);
    process
        .args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return VersionOutcome::Failed(short(&error.to_string())),
    };
    // Drain both pipes on threads so a chatty CLI cannot block on a full pipe before the deadline.
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return VersionOutcome::TimedOut;
            }
            Err(error) => return VersionOutcome::Failed(short(&error.to_string())),
        }
    };
    let stdout = out.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err.and_then(|h| h.join().ok()).unwrap_or_default();
    if !status.success() {
        let why = first_line(&stderr)
            .or_else(|| first_line(&stdout))
            .map(|l| short(&l))
            .unwrap_or_else(|| format!("exit code {}", status.code().unwrap_or(-1)));
        return VersionOutcome::Failed(why);
    }
    match first_line(&stdout).or_else(|| first_line(&stderr)) {
        Some(line) => VersionOutcome::Version(short(&line)),
        None => VersionOutcome::Failed("it printed no version".into()),
    }
}

fn drain<R: Read + Send + 'static>(mut pipe: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = pipe.read_to_string(&mut text);
        text
    })
}

pub fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

/// One short line: control characters dropped, at most 120 characters.
pub fn short(text: &str) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    let clean = clean.trim();
    if clean.chars().count() > 120 {
        format!("{}...", clean.chars().take(117).collect::<String>())
    } else {
        clean.to_string()
    }
}
