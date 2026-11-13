//! Tauri commands behind Settings > Notifications and the bell: the choices are kept on this computer
//! (`notify_levels`) so the phone, Telegram and Discord alerts obey them too.

use crate::notify_levels::{store, BellLevel, Prefs, QuietHours};
use std::collections::BTreeMap;

#[tauri::command]
pub fn notify_prefs_get() -> Prefs {
    store().get()
}

#[tauri::command]
pub fn notify_bell_set(key: String, level: BellLevel) -> Prefs {
    store().set_bell(&key, level)
}

#[tauri::command]
pub fn notify_quiet_set(quiet: QuietHours) -> Prefs {
    store().set_quiet(quiet)
}

/// Snooze alerts for these keys (the card id, its pane id) for 30 minutes. Returns when the snooze ends.
#[tauri::command]
pub fn notify_snooze(keys: Vec<String>) -> u64 {
    store().snooze(&keys, crate::push::now_ms()).0
}

/// Moves the old browser-storage choices here, once.
#[tauri::command]
pub fn notify_prefs_import(bells: BTreeMap<String, BellLevel>, quiet: QuietHours) -> Prefs {
    store().import_once(bells, quiet)
}
