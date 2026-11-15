//! The artifact card and tab: look for new pages, list them, read a version, open one in the browser. Every call names
//! the pane, and the project folder is the pane's own (`artifacts` never takes a path from the window).

use super::AppState;
use crate::artifacts::{self, Artifact};
use serde::Serialize;
use std::path::PathBuf;
use tauri::http::{Request, Response};
use tauri::{Runtime, State, UriSchemeContext, UriSchemeResponder};

pub(super) fn project_of(state: &AppState, pane_id: &str) -> Result<PathBuf, String> {
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

/// A share link just made. `link` is `None` when this PC has no public address (then `reason` says so).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMade {
    pub link: Option<String>,
    pub version: u32,
    pub expires_at: u64,
    pub reason: Option<String>,
}

/// Makes a read-only link to one version of a page (`version` empty: the newest) that ends after `ttl_hours` (a day by
/// default, at most seven days). The secret is in the link, shown once.
#[tauri::command]
pub async fn artifacts_share_make(state: State<'_, AppState>, pane_id: String, id: String, version: Option<u32>, ttl_hours: Option<u64>) -> Result<ShareMade, String> {
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        let made = artifacts::create_link(&artifacts::share_index_file(), &project, &id, version, ttl_hours.map(|h| h.saturating_mul(3600)), artifacts::now_ms()).map_err(|e| format!("{}: {}", e.code(), e.message()))?;
        let link = artifacts::share_address(&made.token);
        let reason = link.is_none().then(|| "This PC has no public address yet. Turn one on in Settings, then share again.".to_string());
        Ok(ShareMade { link, version: made.version, expires_at: made.expires_at, reason })
    })
    .await
}

/// The links of a page that have not ended (never the secrets).
#[tauri::command]
pub async fn artifacts_share_list(state: State<'_, AppState>, pane_id: String, id: String) -> Result<Vec<artifacts::ShareView>, String> {
    let project = project_of(&state, &pane_id)?;
    blocking(move || Ok(artifacts::active_links(&project, &id, artifacts::now_ms()))).await
}

/// Stops every link of a page. Returns how many were stopped.
#[tauri::command]
pub async fn artifacts_share_stop(state: State<'_, AppState>, pane_id: String, id: String) -> Result<usize, String> {
    let project = project_of(&state, &pane_id)?;
    blocking(move || artifacts::revoke_links(&artifacts::share_index_file(), &project, &id).map_err(|e| format!("{}: {}", e.code(), e.message()))).await
}

/// Opens a page in its own window. The window reads it through the same calls as the side panel.
#[tauri::command]
pub async fn artifacts_pop_out(app: tauri::AppHandle, state: State<'_, AppState>, pane_id: String, id: String, title: String) -> Result<(), String> {
    // The pane must exist and have a project: the window is only ever for a page of that agent's own project.
    project_of(&state, &pane_id)?;
    crate::app_windows::open_artifact_window(&app, &pane_id, &id, &title)
}

/// Opens a page as a tab of the agent browser, at its app-only address (`artifacts::serve`). The agent browser must be
/// on (Labs). The page keeps its lock (the address is served with a sandbox policy) and the person's window stays theirs:
/// every agent joins it, as with any page in that browser.
#[tauri::command]
pub async fn artifacts_open_in_agent_browser(app: tauri::AppHandle, state: State<'_, AppState>, pane_id: String, id: String) -> Result<(), String> {
    if !crate::browser::live::enabled(&app) {
        return Err("BROWSER_OFF: Turn on the agent browser in Settings > Labs first.".into());
    }
    let project = project_of(&state, &pane_id)?;
    blocking(move || {
        let address = artifacts::open_tab_address(project, &id, &pane_id)?;
        crate::point::window::open_person_browser(&app, Some(&address)).map(|_| ())
    })
    .await
}

/// The reply to one request for an artifact tab's address (`potato-artifact`). Only agent browser windows may ask (the
/// app's own windows never load it), only GET is answered, and the token in the path is the only credential.
pub fn artifact_serve_protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let from_browser = ctx.webview_label().starts_with("preview-");
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let page = if from_browser { artifacts::respond_to_tab(&method, &path) } else { artifacts::respond_to_tab("GET", "/x/") };
        let mut builder = Response::builder().status(page.status);
        for (name, value) in &page.headers {
            builder = builder.header(*name, value.as_str());
        }
        responder.respond(builder.body(page.body).unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).expect("empty response")));
    });
}
