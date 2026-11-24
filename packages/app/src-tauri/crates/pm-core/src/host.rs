//! The seam between the engine and whatever runs it: the desktop app (Tauri, `src/tauri_host.rs`) or the screen-less
//! `potato-host`. Engine code says "tell the screen", "run this in the background" through here instead of holding a Tauri
//! `AppHandle`, so it can leave the app crate. One host per process, set once at start.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde_json::Value;

pub type Task = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

pub trait Host: Send + Sync {
    /// An event for the window(s), as the app's frontend listens for it (`listen("lend://changed")`). No window: nothing.
    fn emit(&self, event: &str, payload: Value);
    /// Run `task` on the host's async runtime.
    fn spawn(&self, task: Task);
    /// Run `job` on the host's blocking pool.
    fn spawn_blocking(&self, job: Box<dyn FnOnce() + Send + 'static>);
}

static HOST: OnceLock<Arc<dyn Host>> = OnceLock::new();

/// Set the process's host. A second call is ignored (the first host stays).
pub fn set(host: Arc<dyn Host>) {
    let _ = HOST.set(host);
}

/// The process's host, once it is set (the app sets it in its setup; unit tests mostly never do).
pub fn get() -> Option<&'static Arc<dyn Host>> {
    HOST.get()
}

/// `emit` on the host; nothing before one is set.
pub fn emit(event: &str, payload: Value) {
    if let Some(host) = get() {
        host.emit(event, payload);
    }
}

/// `emit` for a payload that serialises (an event struct).
pub fn emit_ser<T: serde::Serialize>(event: &str, payload: &T) {
    if let Ok(value) = serde_json::to_value(payload) {
        emit(event, value);
    }
}

/// `spawn` on the host; before one is set, on the Tokio runtime this thread is in (if any).
pub fn spawn(task: Task) {
    match get() {
        Some(host) => host.spawn(task),
        None => match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(task);
            }
            Err(_) => tracing::warn!("no host and no runtime: a background task was not started"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Rec(Mutex<Vec<String>>);

    impl Host for Rec {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push(format!("{event} {payload}"));
        }
        fn spawn(&self, _: Task) {}
        fn spawn_blocking(&self, job: Box<dyn FnOnce() + Send + 'static>) {
            job();
        }
    }

    #[test]
    fn events_reach_the_one_host_and_a_second_set_is_ignored() {
        emit("before", Value::Null);
        let first = Arc::new(Rec(Mutex::new(Vec::new())));
        set(first.clone());
        set(Arc::new(Rec(Mutex::new(Vec::new()))));
        emit("lend://changed", Value::Null);
        assert_eq!(*first.0.lock().unwrap(), vec!["lend://changed null".to_string()]);
    }
}
