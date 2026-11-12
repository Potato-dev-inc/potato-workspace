//! The Tauri commands of Settings > Danger zone. This is the only place real folders are looked up.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::os_real::{RealHost, RealLauncher};
use super::roots::Roots;
use super::{Plan, Selection, DEV_ALLOW_ENV, NOT_IN_DEV, PROGRESS_EVENT};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Allowed {
    pub allowed: bool,
    /// What the button says when it is not allowed.
    pub reason: Option<String>,
}

fn allowed_now() -> bool {
    let flag = std::env::var(DEV_ALLOW_ENV).ok();
    super::run_allowed(cfg!(debug_assertions), flag.as_deref(), crate::app_lifecycle::is_packaged_install())
}

fn real_roots(app: &AppHandle) -> Result<Roots, String> {
    let install_dir = if crate::app_lifecycle::is_packaged_install() {
        std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
    } else {
        None
    };
    Roots::real(app.path().document_dir().ok(), install_dir)
}

/// Whether "Uninstall everything" may run in this build.
#[tauri::command]
pub fn uninstall_allowed() -> Allowed {
    let ok = allowed_now();
    Allowed { allowed: ok, reason: (!ok).then(|| NOT_IN_DEV.to_string()) }
}

/// The dry run. Reads only; fine in a dev build.
#[tauri::command]
pub async fn uninstall_plan(app: AppHandle) -> Result<Plan, String> {
    let roots = real_roots(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let host = RealHost { app };
        let scan = super::plan::Scan::new(&roots, &host);
        scan.plan(&roots, &host)
    })
    .await
    .map_err(|e| format!("the scan stopped: {e}"))
}

/// Run it. Emits `uninstall://progress` per step. On success the cleanup helper is already running and
/// the app exits.
#[tauri::command]
pub async fn uninstall_run(app: AppHandle, selection: Selection) -> Result<(), String> {
    if !allowed_now() {
        return Err(NOT_IN_DEV.to_string());
    }
    let roots = real_roots(&app)?;
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let host = RealHost { app: handle.clone() };
        let plan = super::plan::Scan::new(&roots, &host).plan(&roots, &host);
        let mut emit = |p: super::Progress| {
            let _ = handle.emit(PROGRESS_EVENT, p);
        };
        super::run::run(&roots, &host, &RealLauncher, &plan, &selection, std::process::id(), &mut emit)
    })
    .await
    .map_err(|e| format!("the uninstall stopped: {e}"))?;
    if let Some(why) = outcome.aborted {
        return Err(why);
    }
    if outcome.handed_off {
        // Let the last progress line reach the window, then end the app so the helper can delete it.
        std::thread::sleep(std::time::Duration::from_millis(600));
        app.exit(0);
    }
    Ok(())
}

/// Put every setting back to its default. Agents, chats and keys stay.
#[tauri::command]
pub fn settings_reset(app: AppHandle) -> Result<serde_json::Value, String> {
    let current = crate::settings_patch::current_settings(&app);
    let patch = super::reset::reset_patch(&current);
    crate::settings_patch::apply(&app, &serde_json::Value::Object(patch))
}
