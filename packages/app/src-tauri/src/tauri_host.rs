//! The app's [`pm_core::host::Host`]: Tauri's window events and Tauri's runtime. Set once in `lib.rs` setup.

use std::sync::Arc;

use pm_core::host::{Host, Task};
use serde_json::Value;
use tauri::Emitter;

struct TauriHost(tauri::AppHandle);

impl Host for TauriHost {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
    fn spawn(&self, task: Task) {
        tauri::async_runtime::spawn(task);
    }
    fn spawn_blocking(&self, job: Box<dyn FnOnce() + Send + 'static>) {
        tauri::async_runtime::spawn_blocking(job);
    }
}

static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// The app handle set at start; `None` in unit tests.
pub fn app() -> Option<tauri::AppHandle> {
    APP.get().cloned()
}

pub fn install(app: tauri::AppHandle) {
    let _ = APP.set(app.clone());
    pm_core::host::set(Arc::new(TauriHost(app)));
}
