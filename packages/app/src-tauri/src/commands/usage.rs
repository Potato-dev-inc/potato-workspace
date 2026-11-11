//! Tauri command behind the "Used" strip at the bottom of the sidebar (`crate::usage`).

use tauri::{AppHandle, Emitter};

/// Every signed-in agent's plan usage. `refresh: true` (the refresh button) reads everything again;
/// otherwise a snapshot younger than two minutes is answered from the cache. `login_reads` is the Settings
/// switch for reads that use the agent's own login (default on). The first call also starts the
/// background refresh, which emits `usage://changed` when the rows change.
#[tauri::command]
pub async fn usage_snapshot(app: AppHandle, refresh: Option<bool>, login_reads: Option<bool>) -> Result<crate::usage::UsageSnapshot, String> {
    crate::usage::start_refresher(app.clone());
    if crate::usage::set_login_reads(login_reads.unwrap_or(true)) {
        crate::usage::invalidate();
    }
    let when = if refresh.unwrap_or(false) { crate::usage::Refresh::Now } else { crate::usage::Refresh::IfStale };
    let (snap, changed) = tauri::async_runtime::spawn_blocking(move || crate::usage::snapshot(when, true))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))?;
    if changed {
        let _ = app.emit(crate::usage::EVENT, &snap);
    }
    Ok(snap)
}
