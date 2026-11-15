//! The PATH-after-install problem.
//!
//! A Windows process keeps the PATH it was born with. After `winget install`, the installer has
//! written the new folder to the registry (`HKLM\...\Environment` and `HKCU\Environment`), but
//! Potato Workspace, and every pane it spawns from now on, still sees the old list. So the doctor
//! would report "not installed" until the app restarts. Here we read the registry PATH, add the
//! folders the process does not have yet, and set them on Potato Workspace's own environment; panes
//! and headless runs copy that environment when they start.
//!
//! Only additions are made: nothing is reordered or removed, so an existing tool never gets
//! shadowed by a refresh.

use std::collections::HashMap;

const MACHINE_KEY: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
const USER_KEY: &str = r"HKCU\Environment";

/// The `Path` value out of `reg query <key> /v Path` output
/// (`    Path    REG_EXPAND_SZ    C:\a;%SystemRoot%\b`). `None` when the value is absent.
pub fn parse_reg_query(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim_start();
        let rest = trimmed.strip_prefix("Path").or_else(|| trimmed.strip_prefix("PATH"))?;
        let rest = rest.trim_start();
        let rest = rest.strip_prefix("REG_EXPAND_SZ").or_else(|| rest.strip_prefix("REG_SZ"))?;
        let value = rest.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Expands `%NAME%` references the way the Windows shell does. Unknown names stay as written.
/// `lookup` gets the name upper-cased.
pub fn expand_vars(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(&name.to_ascii_uppercase()) {
                    Some(found) => out.push_str(&found),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn normal(entry: &str) -> String {
    entry.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase()
}

/// `current` plus every folder of `fresh` (machine list first, then the user list) that `current`
/// lacks, compared without regard to case or a trailing slash. Returns the new PATH text and the
/// folders that were added.
pub fn merge_path(current: &str, fresh: &[&str]) -> (String, Vec<String>) {
    let mut seen: Vec<String> = current.split(';').filter(|e| !e.trim().is_empty()).map(normal).collect();
    let mut merged: Vec<String> = current.split(';').filter(|e| !e.trim().is_empty()).map(str::to_string).collect();
    let mut added = Vec::new();
    for list in fresh {
        for entry in list.split(';') {
            let entry = entry.trim();
            // An unexpanded `%VAR%` would be a literal folder name: skip it rather than add junk.
            if entry.is_empty() || entry.contains('%') {
                continue;
            }
            let key = normal(entry);
            if !seen.contains(&key) {
                seen.push(key);
                merged.push(entry.to_string());
                added.push(entry.to_string());
            }
        }
    }
    (merged.join(";"), added)
}

/// What a refresh did.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Refresh {
    pub added: Vec<String>,
}

/// The `Path` value of one registry key, unexpanded. Windows only; elsewhere there is nothing to read.
#[cfg(windows)]
pub(crate) fn read_registry_path(key: &str) -> Option<String> {
    let out = crate::proc_util::hidden_command("reg")
        .args(["query", key, "/v", "Path"])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_reg_query(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
pub(crate) fn read_registry_path(_key: &str) -> Option<String> {
    None
}

/// The machine folders then the user folders from the registry, with `%VAR%` references expanded
/// from this process's environment. Empty when neither key has a `Path` value.
pub(crate) fn registry_folders() -> Vec<String> {
    let env: HashMap<String, String> =
        std::env::vars().map(|(k, v)| (k.to_ascii_uppercase(), v)).collect();
    let lookup = |name: &str| env.get(name).cloned();
    [MACHINE_KEY, USER_KEY]
        .iter()
        .filter_map(|key| read_registry_path(key))
        .map(|value| expand_vars(&value, &lookup))
        .collect()
}

/// Re-reads the registry PATH and adds what is missing to this process's PATH. Panes spawned
/// afterwards inherit it, and `PATH` lookups (the doctor's installed check) see it at once.
pub fn refresh_process_path() -> Refresh {
    let current = std::env::var("PATH").unwrap_or_default();
    let fresh = registry_folders();
    let fresh: Vec<&str> = fresh.iter().map(String::as_str).collect();
    let (merged, added) = merge_path(&current, &fresh);
    if !added.is_empty() {
        std::env::set_var("PATH", &merged);
        tracing::info!(?added, "agent install: added folders to this process's PATH");
    }
    Refresh { added }
}

/// How long a "not found" answer is trusted before the registry PATH is read again.
const RECHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(20);

/// Whether a refresh is due: never done, or the last one is older than `every`.
pub(crate) fn refresh_due(last: Option<std::time::Instant>, now: std::time::Instant, every: std::time::Duration) -> bool {
    last.is_none_or(|at| now.saturating_duration_since(at) >= every)
}

/// Called when an agent's program was not found on PATH: a program the person installed after the app started (by its
/// own installer, outside the app) sits in a folder this process was never told about. Reads the registry PATH again,
/// at most once per `RECHECK_EVERY`, and says whether a folder was added (so the caller looks once more).
pub fn refresh_if_stale() -> bool {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let now = std::time::Instant::now();
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if !refresh_due(*last, now, RECHECK_EVERY) {
            return false;
        }
        *last = Some(now);
    }
    !refresh_process_path().added.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refresh_is_due_the_first_time_and_then_only_after_the_wait() {
        let t0 = std::time::Instant::now();
        let every = std::time::Duration::from_secs(20);
        assert!(refresh_due(None, t0, every));
        assert!(!refresh_due(Some(t0), t0 + std::time::Duration::from_secs(5), every));
        assert!(refresh_due(Some(t0), t0 + std::time::Duration::from_secs(20), every));
    }

    const REG_OUT: &str = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\a\\.local\\bin;%USERPROFILE%\\AppData\\Local\\Microsoft\\WinGet\\Links\r\n\r\n";

    #[test]
    fn reg_query_output_gives_the_path_value() {
        assert_eq!(
            parse_reg_query(REG_OUT).as_deref(),
            Some(r"C:\Users\a\.local\bin;%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links")
        );
        assert_eq!(parse_reg_query("ERROR: The system was unable to find the specified registry key or value."), None);
        assert_eq!(parse_reg_query("    PathExt    REG_SZ    .EXE"), None);
    }

    #[test]
    fn percent_variables_are_expanded_case_insensitively() {
        let lookup = |n: &str| (n == "USERPROFILE").then(|| r"C:\Users\a".to_string());
        assert_eq!(expand_vars(r"%userprofile%\bin;%Nope%\x;100%", &lookup), r"C:\Users\a\bin;%Nope%\x;100%");
        assert_eq!(expand_vars("no vars", &lookup), "no vars");
        assert_eq!(expand_vars("%%", &lookup), "%%");
    }

    #[test]
    fn a_folder_the_process_lacks_is_added_at_the_end() {
        let (merged, added) = merge_path(r"C:\Windows;C:\Tools", &[r"C:\Windows;C:\Users\a\.local\bin"]);
        assert_eq!(merged, r"C:\Windows;C:\Tools;C:\Users\a\.local\bin");
        assert_eq!(added, [r"C:\Users\a\.local\bin"]);
    }

    #[test]
    fn existing_folders_are_never_reordered_or_duplicated() {
        let current = r"C:\B;C:\A\";
        let (merged, added) = merge_path(current, &[r"c:\a;C:\B\;C:\C"]);
        assert_eq!(merged, r"C:\B;C:\A\;C:\C");
        assert_eq!(added, [r"C:\C"]);
    }

    #[test]
    fn nothing_new_means_nothing_added() {
        let (merged, added) = merge_path(r"C:\A", &[r"C:\A", ""]);
        assert_eq!(merged, r"C:\A");
        assert!(added.is_empty());
    }

    #[test]
    fn unexpanded_variables_are_not_added_as_folders() {
        let (merged, added) = merge_path(r"C:\A", &[r"%NOPE%\bin;C:\New"]);
        assert_eq!(merged, r"C:\A;C:\New");
        assert_eq!(added, [r"C:\New"]);
    }

    #[test]
    fn the_registry_machine_list_comes_before_the_user_list() {
        let (merged, _) = merge_path("", &[r"C:\M", r"C:\U"]);
        assert_eq!(merged, r"C:\M;C:\U");
    }
}
