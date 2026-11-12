//! Tauri commands for Settings > General > Discord alerts. Only the app's own window calls these. None of them
//! returns the webhook link: the window gets whether one is saved and its last four characters.
//!
//! They are async, so the credential store and the network never run on the window's thread.

use crate::discord_alerts::service::{Kinds, Service, Status, TestOutcome};

#[tauri::command]
pub async fn discord_alerts_status() -> Status {
    svc().status()
}

/// Checks the pasted link and keeps it in the OS credential store.
#[tauri::command]
pub async fn discord_alerts_set_url(url: String) -> Result<Status, String> {
    svc().set_url(&url)
}

/// Removes the saved link. Alerts stop.
#[tauri::command]
pub async fn discord_alerts_clear() -> Result<Status, String> {
    svc().clear()
}

/// Which alerts to post: needs you, finished, failed.
#[tauri::command]
pub async fn discord_alerts_set_kinds(kinds: Kinds) -> Result<Status, String> {
    svc().set_kinds(kinds)
}

/// Sends one test message to the saved link.
#[tauri::command]
pub async fn discord_alerts_test() -> TestOutcome {
    match tauri::async_runtime::spawn_blocking(|| svc().test(crate::push::now_ms())).await {
        Ok(outcome) => outcome,
        Err(_) => TestOutcome { ok: false, message: "The test did not run. Try again.".into() },
    }
}

fn svc() -> &'static Service {
    crate::discord_alerts::service()
}
