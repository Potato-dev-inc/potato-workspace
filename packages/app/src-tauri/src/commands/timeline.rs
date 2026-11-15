//! Tauri commands for the Today page (see `docs/features/time-machine.md`). Errors are plain strings.

use crate::checkpoints::day::NowDiff;
use crate::checkpoints::{self, FileChange, RestoreReport};
use crate::timeline::{self, DayView};

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, timeline::TimelineError> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work().map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

/// One day of the line (`YYYY-MM-DD`).
#[tauri::command]
pub async fn timeline_day(date: String) -> Result<DayView, String> {
    blocking(move || timeline::day_view(checkpoints::live(), &date)).await
}

/// What the turn at a point changed.
#[tauri::command]
pub async fn timeline_point_diff(project: String, key: String, id: String) -> Result<Vec<FileChange>, String> {
    blocking(move || timeline::point_diff(checkpoints::live(), &project, &key, &id)).await
}

/// What going back to a point would change in the folder (writes nothing).
#[tauri::command]
pub async fn timeline_now_diff(project: String, key: String, id: String) -> Result<NowDiff, String> {
    blocking(move || timeline::now_diff(checkpoints::live(), &project, &key, &id)).await
}

/// One file's patch for a point. `side` is `"now"` for what going back would do, else the turn's own patch.
#[tauri::command]
pub async fn timeline_file_patch(project: String, key: String, id: String, path: String, side: Option<String>) -> Result<(String, bool), String> {
    blocking(move || timeline::file_patch(checkpoints::live(), &project, &key, &id, &path, side.as_deref().unwrap_or(""))).await
}

/// Go back to a point in one folder.
#[tauri::command]
pub async fn timeline_go_back(project: String, key: String, id: String) -> Result<RestoreReport, String> {
    blocking(move || timeline::go_back(checkpoints::live(), &project, &key, &id)).await
}
