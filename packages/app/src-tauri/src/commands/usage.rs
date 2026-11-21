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

/// How each agent's own login stands (signed in, signed out, can't tell) for the cards in Settings > Agents.
/// An agent with no way to be checked is left out; the card then says it cannot tell.
#[tauri::command]
pub async fn agent_login_states(fresh: Option<bool>) -> Result<Vec<crate::usage::OwnSignIn>, String> {
    tauri::async_runtime::spawn_blocking(move || login_states(fresh.unwrap_or(false))).await.map_err(|e| format!("INTERNAL: {e}"))
}

/// The body of `agent_login_states` (blocking); a paired PC's call runs the same one.
pub(crate) fn login_states(fresh: bool) -> Vec<crate::usage::OwnSignIn> {
    let env = |key: &str| std::env::var(key).ok();
    let probe = crate::usage::HiddenProbe { reuse: !fresh };
    crate::usage::own_sign_ins(&crate::usage::live_agents(), &env, crate::project_path::home_dir().as_deref(), &probe)
}
