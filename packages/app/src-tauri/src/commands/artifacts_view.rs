//! The artifact card and tab: look for new pages, list them, read a version, open one in the browser. Every call names
//! the pane, and the project folder is the pane's own (`artifacts` never takes a path from the window).

use super::AppState;
use crate::artifacts::{self, Artifact};
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

fn project_of(state: &AppState, pane_id: &str) -> Result<PathBuf, String> {
    let registry = state.registry.lock();
    let cwd = registry.get(pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone());
    if cwd.trim().is_empty() {
        return Err("ARTIFACT_NO_PROJECT: This agent has no project folder.".into());
    }
    Ok(PathBuf::from(cwd))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// One version of one page, with where its file is (for "Copy file path").
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub artifact: Artifact,
    pub version: u32,
    pub content: String,
    pub path: String,
}

/// Looks for pages the agent dropped into `.potato/artifacts/` (each new one gets a card in the chat), then lists the
/// project's pages. Called when a turn ends and when the tab reloads.
#[tauri::command]
pub async fn artifacts_sync(state: State<'_, AppState>, pane_id: String) -> Result<Vec<Artifact>, String> {
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        artifacts::announce_folder(&project, &pane_id);
        Ok(artifacts::list(&project))
    })
    .await
}

/// One version of a page (`version` empty: the latest).
#[tauri::command]
pub async fn artifacts_read(state: State<'_, AppState>, pane_id: String, id: String, version: Option<u32>) -> Result<ArtifactPage, String> {
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        let page = artifacts::read(&project, &id, version).map_err(|e| e.to_string())?;
        let path = artifacts::file_of(&project, &id, Some(page.version)).map_err(|e| e.to_string())?;
        Ok(ArtifactPage { artifact: page.artifact, version: page.version, content: page.content, path: path.to_string_lossy().trim_start_matches(r"\?\").to_string() })
    })
    .await
}

/// Opens a version in the system's own browser. Only pages the browser can show by themselves (HTML, SVG) open.
#[tauri::command]
pub async fn artifacts_open_in_browser(state: State<'_, AppState>, pane_id: String, id: String, version: Option<u32>) -> Result<(), String> {
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        let page = artifacts::read(&project, &id, version).map_err(|e| e.to_string())?;
        if !matches!(page.artifact.kind, artifacts::ArtifactKind::Html | artifacts::ArtifactKind::Svg) {
            return Err("ARTIFACT_NOT_OPENABLE: Only HTML and SVG pages open in the browser.".into());
        }
        let path = artifacts::file_of(&project, &id, Some(page.version)).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let program = "explorer";
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let program = "xdg-open";
        let plain = path.to_string_lossy().trim_start_matches(r"\?\").to_string();
        crate::proc_util::hidden_command(program).arg(plain).spawn().map(|_| ()).map_err(|e| format!("ARTIFACT_IO: Could not open the page: {e}."))
    })
    .await
}
