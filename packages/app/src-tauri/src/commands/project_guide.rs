//! The Project guide, as the window uses it. Every call names a pane; the project folder is the pane's own (a path is
//! never taken from the window). Gated by Labs `project_guide_enabled`. A run starts only with the token that
//! `guide_estimate` gave (the consent sheet), and the person can always stop it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::project_guide::consent::{estimate_for, issue_token, Estimate, Size};
use crate::project_guide::dry::{dry_run_allowed, DryRunAgent, DRY_RUN_AGENT};
use crate::project_guide::helper::HelperAgent;
use crate::project_guide::read::{self, DiagramView, PageView, Structure};
use crate::project_guide::run::{self, GuideAgent, Progress, ProgressState, RunOptions};
use crate::project_guide::{scan, store};

const OFF: &str = "GUIDE_OFF: Project guide is off. Turn it on in Settings, under Labs.";

struct Active {
    progress: Progress,
    stop: Arc<AtomicBool>,
    kind: &'static str,
}

static ACTIVE: Mutex<Option<HashMap<String, Active>>> = Mutex::new(None);

fn key_of(project: &std::path::Path) -> String {
    std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf()).to_string_lossy().to_string()
}

fn project_of(state: &AppState, pane_id: &str) -> Result<PathBuf, String> {
    let registry = state.registry.lock();
    let cwd = registry.get(pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone());
    if cwd.trim().is_empty() {
        return Err("GUIDE_NO_PROJECT: This agent has no project folder.".into());
    }
    Ok(PathBuf::from(cwd))
}

fn labs_on(app: &AppHandle) -> bool {
    let public = crate::settings_store::read_public_settings(app);
    public.get(crate::project_guide::LABS_KEY).and_then(serde_json::Value::as_bool).unwrap_or(false)
}

fn gate(app: &AppHandle) -> Result<(), String> {
    if labs_on(app) { Ok(()) } else { Err(OFF.into()) }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("INTERNAL: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    /// `make` | `refresh`
    pub kind: String,
    #[serde(flatten)]
    pub progress: ProgressState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideState {
    pub enabled: bool,
    pub has_guide: bool,
    pub structure: Option<Structure>,
    pub run: Option<RunView>,
    /// The last finished run's end state (`done`, `stopped`, `failed`) with its error, until the next run starts.
    pub last: Option<RunView>,
    /// The dry-run agent can be chosen on the sheet (development builds).
    pub dry_run: bool,
}

static LAST: Mutex<Option<HashMap<String, (String, ProgressState)>>> = Mutex::new(None);

fn run_view(project: &std::path::Path) -> Option<RunView> {
    let guard = ACTIVE.lock();
    guard.as_ref()?.get(&key_of(project)).map(|a| RunView { kind: a.kind.into(), progress: a.progress.snapshot() })
}

fn last_view(project: &std::path::Path) -> Option<RunView> {
    let guard = LAST.lock();
    guard.as_ref()?.get(&key_of(project)).map(|(kind, p)| RunView { kind: kind.clone(), progress: p.clone() })
}

#[tauri::command]
pub async fn guide_state(app: AppHandle, state: State<'_, AppState>, pane_id: String) -> Result<GuideState, String> {
    let enabled = labs_on(&app);
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        if !enabled {
            return Ok(GuideState { enabled, has_guide: false, structure: None, run: None, last: None, dry_run: false });
        }
        Ok(GuideState {
            enabled,
            has_guide: store::has_guide(&project),
            structure: read::structure(&project),
            run: run_view(&project),
            last: last_view(&project),
            dry_run: dry_run_allowed(),
        })
    })
    .await
}

/// What the consent sheet shows, and the token that lets one run start. Looks at the folder only (no model, no usage).
#[tauri::command]
pub async fn guide_estimate(app: AppHandle, state: State<'_, AppState>, pane_id: String, size: Option<Size>) -> Result<Estimate, String> {
    gate(&app)?;
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        let scanned = scan::scan(&project);
        Ok(estimate_for(&scanned, size.unwrap_or_default(), issue_token(&project)))
    })
    .await
}

fn finish(app: &AppHandle, project: &std::path::Path, kind: &'static str, progress: &Progress) {
    let key = key_of(project);
    if let Some(map) = ACTIVE.lock().as_mut() {
        map.remove(&key);
    }
    LAST.lock().get_or_insert_with(HashMap::new).insert(key, (kind.to_string(), progress.snapshot()));
    let _ = app.emit("guide://changed", project.to_string_lossy().to_string());
}

/// Starts a run. `mode`: `make` (a new guide, or a resume of an unfinished one) or `refresh` (stale pages only).
/// Needs the token from `guide_estimate`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn guide_start(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    token: String,
    mode: String,
    size: Option<Size>,
    agent: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    gate(&app)?;
    let project = project_of(&state, &pane_id)?;
    let registry = state.registry.clone();
    let refresh = mode == "refresh";
    if !refresh && mode != "make" {
        return Err("GUIDE_BAD_MODE: The mode must be make or refresh.".into());
    }
    let started = {
        let project = project.clone();
        let app = app.clone();
        blocking(move || {
            run::start_checked(&project, &token)?;
            let key = key_of(&project);
            let mut guard = ACTIVE.lock();
            let map = guard.get_or_insert_with(HashMap::new);
            if map.contains_key(&key) {
                return Err("GUIDE_BUSY: A guide run is already going in this project.".into());
            }
            let who: Arc<dyn GuideAgent> = match agent.as_deref() {
                Some(DRY_RUN_AGENT) if dry_run_allowed() => Arc::new(DryRunAgent),
                Some(DRY_RUN_AGENT) => return Err("GUIDE_NO_DRY_RUN: The dry run is only in development builds.".into()),
                other => Arc::new(HelperAgent::new(app.clone(), registry, other.map(str::to_string).filter(|a| !a.trim().is_empty()), model)),
            };
            let progress = Progress::new();
            let stop = Arc::new(AtomicBool::new(false));
            let kind: &'static str = if refresh { "refresh" } else { "make" };
            map.insert(key, Active { progress: progress.clone(), stop: stop.clone(), kind });
            drop(guard);
            let opts = RunOptions { size: size.unwrap_or_default(), resume: store::read_manifest(&project).is_some_and(|m| !m.complete), ..Default::default() };
            let (project2, app2) = (project.clone(), app.clone());
            std::thread::Builder::new()
                .name("project-guide-run".into())
                .spawn(move || {
                    if refresh {
                        let _ = run::refresh(&project2, who.as_ref(), &opts, &progress, &stop);
                    } else {
                        let _ = run::generate(&project2, who.as_ref(), &opts, &progress, &stop);
                    }
                    finish(&app2, &project2, kind, &progress);
                })
                .map_err(|e| format!("GUIDE_THREAD: {e}"))?;
            Ok(())
        })
        .await
    };
    let _ = app.emit("guide://changed", project.to_string_lossy().to_string());
    started
}

#[tauri::command]
pub async fn guide_stop(state: State<'_, AppState>, pane_id: String) -> Result<bool, String> {
    let project = project_of(&state, &pane_id)?;
    Ok(ACTIVE.lock().as_ref().and_then(|m| m.get(&key_of(&project))).map(|a| a.stop.store(true, Ordering::SeqCst)).is_some())
}

#[tauri::command]
pub async fn guide_read_page(app: AppHandle, state: State<'_, AppState>, pane_id: String, id: String) -> Result<PageView, String> {
    gate(&app)?;
    let project = project_of(&state, &pane_id)?;
    blocking(move || read::page(&project, &id).ok_or_else(|| "GUIDE_NO_PAGE: There is no such page.".to_string())).await
}

#[tauri::command]
pub async fn guide_read_diagram(app: AppHandle, state: State<'_, AppState>, pane_id: String) -> Result<DiagramView, String> {
    gate(&app)?;
    let project = project_of(&state, &pane_id)?;
    blocking(move || read::diagram(&project).ok_or_else(|| "GUIDE_NO_DIAGRAM: This guide has no diagram.".to_string())).await
}

#[tauri::command]
pub async fn guide_delete(app: AppHandle, state: State<'_, AppState>, pane_id: String) -> Result<bool, String> {
    gate(&app)?;
    let project = project_of(&state, &pane_id)?;
    if run_view(&project).is_some() {
        return Err("GUIDE_BUSY: Stop the run first.".into());
    }
    let done = blocking({
        let project = project.clone();
        move || store::delete_guide(&project)
    })
    .await?;
    if let Some(map) = LAST.lock().as_mut() {
        map.remove(&key_of(&project));
    }
    let _ = app.emit("guide://changed", project.to_string_lossy().to_string());
    Ok(done)
}
