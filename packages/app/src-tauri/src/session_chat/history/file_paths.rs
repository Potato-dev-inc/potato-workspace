//! Remembers which file holds which chat, so reading one old chat does not walk the whole store again. `list` already
//! knows every (chat, file) pair it identified; `read` asks here first and trusts an answer only after checking the
//! file (see `FileHistory::locate`). Only paths are kept, never chat text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// The most chats remembered. At the cap the memory starts again, so it can never grow without bound.
const MAX_REMEMBERED: usize = 20_000;

type Key = (String, String);

fn memory() -> MutexGuard<'static, HashMap<Key, PathBuf>> {
    static MEMORY: OnceLock<Mutex<HashMap<Key, PathBuf>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The store is identified by its real root folders.
pub(super) fn roots_key(roots: &[PathBuf]) -> String {
    roots.iter().map(|root| root.to_string_lossy()).collect::<Vec<_>>().join("\n")
}

pub(super) fn remember(roots: &str, session: &str, path: &Path) {
    let mut memory = memory();
    let key = (roots.to_string(), session.to_string());
    if memory.len() >= MAX_REMEMBERED && !memory.contains_key(&key) {
        memory.clear();
    }
    memory.insert(key, path.to_path_buf());
}

pub(super) fn lookup(roots: &str, session: &str) -> Option<PathBuf> {
    memory().get(&(roots.to_string(), session.to_string())).cloned()
}

pub(super) fn forget(roots: &str, session: &str) {
    memory().remove(&(roots.to_string(), session.to_string()));
}

#[cfg(test)]
thread_local! {
    static WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Counts one walk of a store, on this thread (tests only).
#[cfg(test)]
pub(super) fn count_walk() {
    WALKS.with(|walks| walks.set(walks.get() + 1));
}

/// The walks made on this thread so far (tests only).
#[cfg(test)]
pub(super) fn walks() -> usize {
    WALKS.with(|walks| walks.get())
}
