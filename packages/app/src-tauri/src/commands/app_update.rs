//! One-click update (Tauri updater v2). The page asks `app_update_check`; a press on Update calls `app_update_install`.
//!
//! - Nothing is installed without a press. A check only reads `latest.json` (the GitHub release) and keeps the answer.
//! - The download is checked against the public key in `tauri.conf.json` before anything else happens; a file that does not
//!   verify is refused and the app goes on as it was.
//! - If an agent is working, the install is refused until the page says the person was warned (`confirm_running`).
//! - Only then the running agents are asked to stop (each one is checkpointed first, the way the panic button does it), the
//!   panes are closed, and the installer runs. The installer is the MSI of the next version: same upgrade code, so it
//!   replaces the old one in place. The app's data folder is not touched by it.
//! - Any failure is a plain sentence; the version that is running keeps working.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::AppState;

static FOUND: Mutex<Option<Update>> = Mutex::new(None);

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBusy {
    /// Agent types with a pane that is working now (for example "claude" or "codex").
    pub agents: Vec<String>,
}

/// A plain sentence for what went wrong (the page shows it as it is). Pure, so tests can pin the words.
pub fn plain_update_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("signature") || lower.contains("minisign") || lower.contains("verif") {
        "The update did not pass its safety check, so it was not installed. Your current version keeps working.".to_string()
    } else if lower.contains("dns") || lower.contains("connect") || lower.contains("network") || lower.contains("timed out") || lower.contains("error sending request") || lower.contains("unreachable") {
        "Could not reach the update server. Check your internet and try again. Your current version keeps working.".to_string()
    } else if lower.contains("404") || lower.contains("not found") || lower.contains("status") {
        "No update information was found right now. Try again later.".to_string()
    } else {
        "The update could not be installed. Your current version keeps working.".to_string()
    }
}

/// The agent types of the panes that are working now, each named once. Pure: the caller passes `(agent_type, status)`.
pub fn working_agents<'a>(panes: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (agent_type, status) in panes {
        if status == "running" && !names.iter().any(|n| n == agent_type) {
            names.push(agent_type.to_string());
        }
    }
    names
}

fn busy_agents(app: &AppHandle) -> Vec<String> {
    match app.try_state::<AppState>() {
        Some(state) => {
            let panes = state.registry.lock().list();
            working_agents(panes.iter().map(|p| (p.agent_type.as_str(), p.status.as_str())))
        }
        None => Vec::new(),
    }
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<Option<UpdateOffer>, String> {
    let updater = app.updater().map_err(|e| plain_update_error(&e.to_string()))?;
    match updater.check().await {
        Ok(Some(update)) => {
            let offer = UpdateOffer { current_version: update.current_version.clone(), version: update.version.clone(), notes: update.body.clone().filter(|n| !n.trim().is_empty()) };
            *FOUND.lock().unwrap_or_else(|p| p.into_inner()) = Some(update);
            Ok(Some(offer))
        }
        Ok(None) => {
            *FOUND.lock().unwrap_or_else(|p| p.into_inner()) = None;
            Ok(None)
        }
        Err(e) => Err(plain_update_error(&e.to_string())),
    }
}

/// Which agents are working: the page warns before it asks to install.
#[tauri::command]
pub fn app_update_busy(app: AppHandle) -> UpdateBusy {
    UpdateBusy { agents: busy_agents(&app) }
}

/// The press on Update: download and verify, then stop the agents and close their panes, then install.
#[tauri::command]
pub async fn app_update_install(app: AppHandle, confirm_running: bool) -> Result<(), String> {
    let busy = busy_agents(&app);
    if !busy.is_empty() && !confirm_running {
        return Err(format!("UPDATE_RUNNING: {} is working. Confirm to update anyway; its work is saved before the restart.", busy.join(", ")));
    }
    let update = FOUND.lock().unwrap_or_else(|p| p.into_inner()).take();
    let update = match update {
        Some(update) => update,
        None => {
            let updater = app.updater().map_err(|e| plain_update_error(&e.to_string()))?;
            updater.check().await.map_err(|e| plain_update_error(&e.to_string()))?.ok_or_else(|| "There is no update to install.".to_string())?
        }
    };
    // Download first and check the signature; nothing has been stopped yet, so a failure here changes nothing.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| plain_update_error(&e.to_string()))?;
    stop_for_update(&app);
    update.install(bytes).map_err(|e| plain_update_error(&e.to_string()))?;
    // On Windows the installer ends this process; if it is still here, it is not going to run.
    Ok(())
}

/// What the app's own exit does for the agents and the panes, done before the installer closes the app (it ends the
/// process without the usual exit event).
fn stop_for_update(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let _ = crate::panic::stop_all(&state.registry, app);
        crate::pty::registry_kill_all_and_wait(&state.registry);
    }
}

/// With `PM_UPDATE_PROBE=<file>` set: at start-up, check, download and verify (never install) and write what happened
/// to the file. It is how a build is shown to find, fetch and verify an update; off unless the variable is set.
pub fn startup_probe(app: AppHandle) {
    let Some(file) = std::env::var_os("PM_UPDATE_PROBE").filter(|f| !f.is_empty()) else { return };
    tauri::async_runtime::spawn(async move {
        let report = match app_update_check(app.clone()).await {
            Ok(Some(offer)) => {
                let found = FOUND.lock().unwrap_or_else(|p| p.into_inner()).take();
                match found {
                    Some(update) => match update.download(|_, _| {}, || {}).await {
                        Ok(bytes) => serde_json::json!({ "result": "verified", "current": offer.current_version, "version": offer.version, "notes": offer.notes, "bytes": bytes.len() }),
                        Err(e) => serde_json::json!({ "result": "refused", "version": offer.version, "plain": plain_update_error(&e.to_string()), "raw": e.to_string() }),
                    },
                    None => serde_json::json!({ "result": "no update kept" }),
                }
            }
            Ok(None) => serde_json::json!({ "result": "none" }),
            Err(plain) => serde_json::json!({ "result": "check failed", "plain": plain }),
        };
        let _ = std::fs::write(file, report.to_string());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bad_signature_is_said_as_a_safety_check_and_nothing_is_installed() {
        let s = plain_update_error("the signature could not be verified: Invalid signature");
        assert!(s.contains("safety check") && s.contains("keeps working"), "{s}");
    }

    #[test]
    fn a_network_failure_is_said_in_plain_words() {
        for raw in ["error sending request for url (https://github.com/x): dns error", "operation timed out", "Could not connect"] {
            assert!(plain_update_error(raw).contains("Could not reach the update server"), "{raw}");
        }
    }

    #[test]
    fn any_other_failure_keeps_the_old_version_working() {
        assert!(plain_update_error("weird").contains("keeps working"));
        assert!(plain_update_error("HTTP status client error (404 Not Found)").contains("No update information"));
    }

    #[test]
    fn the_raw_error_text_is_never_shown() {
        let s = plain_update_error("C:\\Users\\someone\\secret path failed: signature mismatch");
        assert!(!s.contains("someone") && !s.contains("C:"), "{s}");
    }

    #[test]
    fn only_running_panes_count_and_each_agent_is_named_once() {
        let panes = [("claude", "running"), ("codex", "idle"), ("claude", "running"), ("shell", "exited")];
        assert_eq!(working_agents(panes), vec!["claude".to_string()]);
        assert!(working_agents([("codex", "idle")]).is_empty());
    }
}
