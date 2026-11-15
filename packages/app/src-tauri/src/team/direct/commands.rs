//! Cockpit commands for Pass a task (Tauri `invoke`). Desktop windows only: no bridge route, MCP tool or phone route, so an
//! agent, the companion or a paired phone can never pass, accept or unpack a task.

use std::path::Path;

use super::app::app_service;
use super::model::{RecvTask, SentTask, TasksView};
use super::service::{AcceptInput, PassInput};

const WINDOWS: [&str; 3] = ["cockpit", "main", "settings"];

fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if WINDOWS.contains(&webview.label()) {
        Ok(())
    } else {
        Err("Tasks work only in the app window.".to_string())
    }
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn team_tasks_state(webview: tauri::Webview) -> Result<TasksView, String> {
    guard(&webview)?;
    Ok(app_service().view())
}

#[tauri::command]
pub async fn team_task_pass(webview: tauri::Webview, input: PassInput) -> Result<SentTask, String> {
    guard(&webview)?;
    blocking(move || app_service().pass(input)).await
}

#[tauri::command]
pub async fn team_task_withdraw(webview: tauri::Webview, id: String) -> Result<SentTask, String> {
    guard(&webview)?;
    blocking(move || app_service().withdraw(&id)).await
}

#[tauri::command]
pub async fn team_task_seen(webview: tauri::Webview, id: String) -> Result<(), String> {
    guard(&webview)?;
    blocking(move || app_service().seen(&id)).await
}

#[tauri::command]
pub async fn team_task_accept(webview: tauri::Webview, id: String, input: AcceptInput) -> Result<RecvTask, String> {
    guard(&webview)?;
    blocking(move || app_service().accept(&id, input)).await
}

#[tauri::command]
pub async fn team_task_decline(webview: tauri::Webview, id: String) -> Result<RecvTask, String> {
    guard(&webview)?;
    blocking(move || app_service().decline(&id)).await
}

/// The person pressed Start on the New agent page for a task.
#[tauri::command]
pub async fn team_task_started(webview: tauri::Webview, id: String) -> Result<RecvTask, String> {
    guard(&webview)?;
    blocking(move || app_service().started(&id)).await
}

#[tauri::command]
pub async fn team_task_done(webview: tauri::Webview, id: String, note: String) -> Result<RecvTask, String> {
    guard(&webview)?;
    blocking(move || app_service().done(&id, &note)).await
}

/// Puts a received repo copy into a NEW folder under `parent`. Returns the folder.
#[tauri::command]
pub async fn team_task_unpack(webview: tauri::Webview, id: String, parent: String) -> Result<String, String> {
    guard(&webview)?;
    blocking(move || app_service().unpack(&id, Path::new(&parent))).await
}

#[tauri::command]
pub async fn team_tasks_handover_set(webview: tauri::Webview, on: bool) -> Result<(), String> {
    guard(&webview)?;
    app_service().set_handover(on);
    Ok(())
}

/// Can this folder go along with a task? The branch and the plain reason when not (`Commit or stash first`, no git repo).
#[tauri::command]
pub async fn team_task_repo_check(webview: tauri::Webview, path: String) -> Result<RepoCheck, String> {
    guard(&webview)?;
    blocking(move || Ok(repo_check(&path))).await
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheck {
    pub ok: bool,
    pub name: String,
    pub branch: String,
    pub reason: String,
}

pub fn repo_check(path: &str) -> RepoCheck {
    match super::bundle::check_repo(Path::new(path)) {
        Ok((top, branch)) => RepoCheck { ok: true, name: top.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), branch, reason: String::new() },
        Err(reason) => RepoCheck { ok: false, name: String::new(), branch: String::new(), reason },
    }
}
