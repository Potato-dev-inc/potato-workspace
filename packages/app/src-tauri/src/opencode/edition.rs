//! Which OpenCode is installed: 1.x (the native lane's `serve` + `attach`) or 2.x (chat over ACP only).
//!
//! OpenCode 2.x (checked on 2.2.7) has no `opencode attach`; its `serve` starts a web server and a
//! "v2 API" that answers every GET with the web page (a health check passes) and refuses
//! `POST /session` with 405. Its `opencode acp` works (initialize, session/new, session/prompt,
//! session/load all answered; `acp/fixtures/initialize_opencode_2_2_7.json`). So with 2.x the native
//! terminal agent is switched off and its runs go to the `opencode` chat lane.

use std::io::Read;
use std::time::{Duration, Instant};

/// The major version in `opencode --version` output: `1.19.5` (1.x) or `opencode v2.2.7` (2.x).
pub(crate) fn major_version(text: &str) -> Option<u32> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|word| word.contains('.') && word.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .and_then(|word| word.split('.').next())
        .and_then(|major| major.parse().ok())
}

/// Refuses an OpenCode this lane cannot drive. OpenCode 2.x (checked on 2.2.7) has no
/// `opencode attach`; its `serve` starts a new web server and "v2 API" that answers every GET with the
/// web page (so a health check passes) and refuses `POST /session` with 405.
pub(crate) fn check_supported(version_text: &str) -> Result<(), String> {
    match major_version(version_text) {
        Some(major) if major >= 2 => Err(format!(
            "OpenCode {} is installed, and the native OpenCode lane only supports 1.x (2.x has a different server and no `opencode attach`).              Use the terminal OpenCode agent (agent_type opencode) instead, or install OpenCode 1.x.",
            version_text.trim()
        )),
        _ => Ok(()),
    }
}

/// `exe --version`, or `None` when it does not answer in 5 s. Never opens a window.
pub(crate) fn installed_version(exe: &str) -> Option<String> {
    let mut command = crate::proc_util::hidden_command(exe);
    command.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                crate::pty::proc_tree::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut text = String::new();
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    Some(text.trim().to_string()).filter(|text| !text.is_empty())
}


/// The installed OpenCode's major version, asked of the program at most every 30 s.
pub fn installed_major() -> Option<u32> {
    // Tests never depend on the OpenCode installed on the machine.
    if cfg!(test) {
        return None;
    }
    static CACHE: std::sync::Mutex<Option<(Instant, Option<u32>)>> = std::sync::Mutex::new(None);
    if let Ok(held) = CACHE.lock() {
        if let Some((at, major)) = *held {
            if at.elapsed() < Duration::from_secs(30) {
                return major;
            }
        }
    }
    let major = crate::shell_env::resolve_opencode_executable()
        .ok()
        .and_then(|exe| installed_version(&exe))
        .and_then(|text| major_version(&text));
    if let Ok(mut held) = CACHE.lock() {
        *held = Some((Instant::now(), major));
    }
    major
}

/// What the listing says about the native agent when OpenCode is 2.x.
pub const NOT_FOR_V2: &str = "Not for OpenCode 2 - use the OpenCode chat (agent_type opencode)";

/// A `GET /agents/types` body with `opencode_native` marked not dispatchable when OpenCode is 2.x.
pub fn mark_listing(mut listing: serde_json::Value, major: Option<u32>) -> serde_json::Value {
    if major.is_none_or(|m| m < 2) {
        return listing;
    }
    if let Some(agents) = listing.get_mut("agents").and_then(serde_json::Value::as_array_mut) {
        for agent in agents.iter_mut().filter(|a| a["id"] == "opencode_native") {
            agent["dispatchable"] = serde_json::json!(false);
            agent["not_dispatchable_reason"] = serde_json::json!(NOT_FOR_V2);
        }
    }
    if let Some(ids) = listing.get_mut("dispatchable_ids").and_then(serde_json::Value::as_array_mut) {
        ids.retain(|id| id != "opencode_native");
    }
    listing
}

/// Where a `run_agent` for the native agent goes: `Some(reason)` = the chat lane, `None` = unchanged.
/// A caller who insisted on the terminal gets the error.
pub fn route_native_run(lane: Option<&str>, major: Option<u32>) -> Result<Option<String>, String> {
    if major.is_none_or(|m| m < 2) {
        return Ok(None);
    }
    if lane.map(str::trim) == Some("terminal") {
        return Err("agent_type opencode_native is not available with OpenCode 2.x (it has no terminal attach). Leave lane out, or use agent_type opencode with lane \"acp\".".to_string());
    }
    Ok(Some("OpenCode 2.x has no native terminal agent, so this run went to the OpenCode chat (ACP) lane.".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_two_is_refused_with_a_reason_and_one_point_x_passes() {
        // Recorded `opencode --version` output: 1.19.5 prints the bare number, 2.2.7 prints "opencode v2.2.7".
        assert_eq!(major_version("1.19.5"), Some(1));
        assert_eq!(major_version("opencode v2.2.7"), Some(2));
        assert_eq!(major_version("garbage"), None);
        assert!(check_supported("1.19.5").is_ok());
        assert!(check_supported("1.0.142
").is_ok());
        assert!(check_supported("unknown output").is_ok());
        let err = check_supported("opencode v2.2.7").unwrap_err();
        assert!(err.contains("2.2.7") && err.contains("only supports 1.x"), "{err}");
    }

    #[test]
    fn a_2x_listing_hides_the_native_agent_and_1x_is_untouched() {
        let listing = serde_json::json!({
            "agents": [{"id": "opencode", "dispatchable": true}, {"id": "opencode_native", "dispatchable": true, "not_dispatchable_reason": null}],
            "dispatchable_ids": ["opencode", "opencode_native"],
        });
        assert_eq!(mark_listing(listing.clone(), Some(1)), listing);
        assert_eq!(mark_listing(listing.clone(), None), listing);
        let v2 = mark_listing(listing, Some(2));
        assert_eq!(v2["agents"][0]["dispatchable"], true);
        assert_eq!(v2["agents"][1]["dispatchable"], false);
        assert_eq!(v2["agents"][1]["not_dispatchable_reason"], NOT_FOR_V2);
        assert_eq!(v2["dispatchable_ids"], serde_json::json!(["opencode"]));
    }

    #[test]
    fn a_2x_native_run_goes_to_chat_unless_the_terminal_was_demanded() {
        assert_eq!(route_native_run(None, Some(1)), Ok(None));
        assert_eq!(route_native_run(Some("terminal"), Some(1)), Ok(None));
        assert!(route_native_run(None, Some(2)).unwrap().unwrap().contains("chat (ACP) lane"));
        assert!(route_native_run(Some("acp"), Some(2)).unwrap().is_some());
        assert!(route_native_run(Some("terminal"), Some(2)).unwrap_err().contains("not available with OpenCode 2.x"));
    }

    #[test]
    fn a_program_that_answers_version_is_read() {
        #[cfg(windows)]
        let exe = "hostname";
        #[cfg(not(windows))]
        let exe = "true";
        let _ = installed_version(exe);
        assert!(installed_version("definitely-not-a-program-xyz").is_none());
    }
}
