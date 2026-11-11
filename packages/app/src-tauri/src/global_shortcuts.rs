//! Global shortcuts (the ones that work from any app): the Ask bar, "Stop all agents" and the
//! Orchestration / Individual switch. One place decides which key combination each one gets:
//! the person's own choice (the `keybindings` setting, written by Settings > Shortcuts), else the
//! default for this platform. A choice the OS refuses (another app owns it) falls back to the
//! default and the reason is kept, so Settings can say so.
//!
//! Combos are written the way the UI stores them: `Mod+Alt+Space`, where `Mod` is Ctrl on
//! Windows and Linux and Cmd on a Mac, `Ctrl` is always the Control key, `Meta` is the Windows or
//! Cmd key, then `Alt`, `Shift` and one key. `"none"` turns a shortcut off.
//!
//! The pure parts (`parse_combo`, `plugin_string`, `candidates`) are unit tested; registering with
//! the OS goes through `tauri-plugin-global-shortcut`.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

/// The stored value that turns a shortcut off.
pub const DISABLED: &str = "none";

/// (id, default on Windows and Linux, default on a Mac). The ids match lib/shortcuts.ts in the app.
pub const ACTIONS: [(&str, &str, &str); 3] = [
    ("ask-bar", "Mod+Alt+Space", "Mod+Shift+Space"),
    ("stop-all", "Mod+Alt+Shift+P", "Mod+Alt+Shift+P"),
    ("mode-toggle", "Mod+Alt+M", "Mod+Alt+Shift+M"),
];

pub fn default_combo(id: &str, mac: bool) -> Option<&'static str> {
    ACTIONS.iter().find(|a| a.0 == id).map(|a| if mac { a.2 } else { a.1 })
}

/// A combo as the UI stores it, split into parts. Only produced by `parse_combo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub modifiers: Vec<&'static str>,
    pub key: String,
}

/// Reads `Mod+Alt+Space`-style text. Errors are plain words for the person.
pub fn parse_combo(text: &str) -> Result<Combo, String> {
    let mut modifiers: Vec<&'static str> = Vec::new();
    let mut key: Option<String> = None;
    for part in text.split('+').map(str::trim) {
        if part.is_empty() {
            // "Ctrl++" is Ctrl and the plus key.
            if key.is_some() {
                return Err("That combo has two keys. Use one key with Ctrl, Alt or Shift.".into());
            }
            key = Some("+".into());
            continue;
        }
        let modifier = match part.to_ascii_lowercase().as_str() {
            "mod" | "commandorcontrol" => Some("Mod"),
            "ctrl" | "control" => Some("Ctrl"),
            "meta" | "cmd" | "command" | "super" | "win" => Some("Meta"),
            "alt" | "option" => Some("Alt"),
            "shift" => Some("Shift"),
            _ => None,
        };
        match modifier {
            Some(m) => {
                if !modifiers.contains(&m) {
                    modifiers.push(m);
                }
            }
            None => {
                if key.is_some() {
                    return Err("That combo has two keys. Use one key with Ctrl, Alt or Shift.".into());
                }
                key = Some(part.to_string());
            }
        }
    }
    let key = key.ok_or("Press a key as well as Ctrl, Alt or Shift.")?;
    if !modifiers.iter().any(|m| *m != "Shift") {
        return Err("A shortcut that works from any app needs Ctrl, Alt or the Windows / Cmd key as well.".into());
    }
    Ok(Combo { modifiers, key })
}

/// The text `tauri-plugin-global-shortcut` wants for a combo on this platform.
pub fn plugin_string(combo: &Combo, mac: bool) -> String {
    let mut parts: Vec<String> = combo
        .modifiers
        .iter()
        .map(|m| match *m {
            "Mod" => if mac { "Super" } else { "Ctrl" }.to_string(),
            "Meta" => "Super".to_string(),
            other => other.to_string(),
        })
        .collect();
    parts.push(combo.key.clone());
    parts.join("+")
}

/// Whether the plugin can register this combo at all (its own parser accepts the key and modifiers).
pub fn validate(text: &str, mac: bool) -> Result<String, String> {
    let combo = parse_combo(text)?;
    let plugin = plugin_string(&combo, mac);
    plugin
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|_| "That key cannot be used as a shortcut from any app.".to_string())?;
    Ok(plugin)
}

/// What to try, in order, for an action: the person's choice (unless off), then the default.
/// `Ok(None)` is "turned off". `legacy` is a combo an older setting chose (the Ask bar's list); it
/// stands in for the default until the person records one.
pub fn candidates(overrides: &HashMap<String, String>, id: &str, mac: bool, legacy: Option<&str>) -> Option<Vec<String>> {
    let default = default_combo(id, mac)?;
    let mut out: Vec<String> = Vec::new();
    match overrides.get(id).map(String::as_str) {
        Some(DISABLED) => return Some(Vec::new()),
        Some(own) if !own.trim().is_empty() => out.push(own.to_string()),
        _ => {}
    }
    if let Some(old) = legacy.filter(|l| !l.trim().is_empty()) {
        out.push(old.to_string());
    }
    out.push(default.to_string());
    out.dedup();
    Some(out)
}

// ---------------------------------------------------------------- state

#[derive(Default)]
struct State {
    overrides: HashMap<String, String>,
    /// id -> (combo in UI form, combo in plugin form) while registered with the OS.
    registered: HashMap<String, (String, String)>,
    /// id -> why the person's choice was not used.
    notes: HashMap<String, String>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

pub fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

/// The `keybindings` object of a settings file value (`{"settings": {"keybindings": {...}}}`).
pub fn overrides_from_file(file: &Value) -> HashMap<String, String> {
    file.get("settings")
        .and_then(|s| s.get("keybindings"))
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

/// Startup: read the saved choices. A missing or unreadable file means the defaults.
pub fn load_overrides() {
    let path = crate::app_paths::app_data_dir().join("settings.json");
    let file = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    STATE.lock().overrides = overrides_from_file(&file);
}

/// The combos to try for `id` now, as (UI form, plugin form). Entries the plugin cannot parse are skipped
/// (and noted), so a hand-edited setting never blocks the default.
pub fn plugin_candidates(id: &str, legacy: Option<&str>) -> Vec<(String, String)> {
    let mac = is_mac();
    let list = candidates(&STATE.lock().overrides, id, mac, legacy).unwrap_or_default();
    let mut out = Vec::new();
    for combo in list {
        match validate(&combo, mac) {
            Ok(plugin) => out.push((combo, plugin)),
            Err(why) => {
                STATE.lock().notes.insert(id.to_string(), format!("Could not use {combo}: {why}"));
            }
        }
    }
    out
}

/// Remember what is registered now (or that nothing is) and why a choice was not used.
pub fn record(id: &str, active: Option<(String, String)>, note: Option<String>) {
    let mut state = STATE.lock();
    match active {
        Some(pair) => {
            state.registered.insert(id.to_string(), pair);
        }
        None => {
            state.registered.remove(id);
        }
    }
    match note {
        Some(n) => {
            state.notes.insert(id.to_string(), n);
        }
        None => {
            state.notes.remove(id);
        }
    }
}

pub fn registered_plugin(id: &str) -> Option<String> {
    STATE.lock().registered.get(id).map(|p| p.1.clone())
}

/// Registers `id` with the OS: drops the old registration, tries the person's choice then the default,
/// and keeps the reason when the choice failed. `enabled` false leaves nothing registered.
pub fn apply(app: &AppHandle, id: &str, enabled: bool, legacy: Option<&str>, handler: fn(&AppHandle)) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let shortcuts = app.global_shortcut();
    if let Some(old) = registered_plugin(id) {
        let _ = shortcuts.unregister(old.as_str());
    }
    record(id, None, None);
    let tries = plugin_candidates(id, legacy);
    if !enabled || tries.is_empty() {
        return Ok(());
    }
    let mut first_error: Option<String> = None;
    for (index, (ui, plugin)) in tries.iter().enumerate() {
        let handle = app.clone();
        let result = shortcuts.on_shortcut(plugin.as_str(), move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                handler(&handle);
            }
        });
        match result {
            Ok(()) => {
                let note = first_error.as_ref().map(|_| format!("{} is used by another app, so the default {ui} is on.", tries[0].0));
                record(id, Some((ui.clone(), plugin.clone())), note);
                return if index == 0 { Ok(()) } else { Err(first_error.unwrap_or_default()) };
            }
            Err(e) => {
                tracing::warn!(error = %e, shortcut = %plugin, "global shortcut could not be registered");
                first_error.get_or_insert_with(|| taken_message(&tries[0].0));
            }
        }
    }
    let message = first_error.unwrap_or_default();
    record(id, None, Some(message.clone()));
    Err(message)
}

fn taken_message(combo: &str) -> String {
    format!("{combo} is already used by another app or by Windows. Pick another combination.")
}

// ---------------------------------------------------------------- what is turned on

/// Whether the shortcut for `id` should be registered now (the Ask bar and Stop all have a switch).
fn wanted(id: &str) -> bool {
    match id {
        "ask-bar" => crate::askbar::settings().enabled,
        "stop-all" => crate::loop_guard::settings().panic_shortcut,
        _ => true,
    }
}

/// Registers `id` again from the current choices.
fn resync(app: &AppHandle, id: &str) -> Result<(), String> {
    match id {
        "ask-bar" => crate::askbar::glue::sync_shortcut_now(app, &crate::askbar::settings()),
        "stop-all" => crate::panic::apply_shortcut_result(app, wanted(id)),
        "mode-toggle" => crate::mini_bar::apply_mode_shortcut(app),
        _ => Err("Unknown shortcut".into()),
    }
}

// ---------------------------------------------------------------- commands

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub id: String,
    /// The combo that works now, in the UI's form; null when off or when none could be registered.
    pub active: Option<String>,
    /// Why the person's choice is not the one in use (taken by another app, ...).
    pub note: Option<String>,
    /// The Ask bar and Stop all only register while their switch in Settings is on.
    pub switched_on: bool,
}

fn statuses() -> Vec<Status> {
    let state = STATE.lock();
    ACTIONS
        .iter()
        .map(|a| Status {
            id: a.0.to_string(),
            active: state.registered.get(a.0).map(|p| p.0.clone()),
            note: state.notes.get(a.0).cloned(),
            switched_on: wanted(a.0),
        })
        .collect()
}

/// What is registered right now and any notes, for Settings > Shortcuts.
#[tauri::command]
pub fn global_shortcuts_status() -> Vec<Status> {
    statuses()
}

/// Tries a new combo for one global shortcut (`combo` None: back to the default, `"none"`: off).
/// When the OS refuses it the old choice is restored and the error says why, so Settings can
/// show it and not save it. Saving the setting itself is the UI's job (the `keybindings` patch).
#[tauri::command]
pub fn global_shortcut_set(app: AppHandle, id: String, combo: Option<String>) -> Result<Vec<Status>, String> {
    if default_combo(&id, is_mac()).is_none() {
        return Err("Unknown shortcut".into());
    }
    if let Some(c) = combo.as_deref() {
        if c != DISABLED {
            validate(c, is_mac())?;
        }
    }
    let previous = STATE.lock().overrides.get(&id).cloned();
    {
        let mut state = STATE.lock();
        match combo.clone() {
            Some(c) => {
                state.overrides.insert(id.clone(), c);
            }
            None => {
                state.overrides.remove(&id);
            }
        }
    }
    if let Err(message) = resync(&app, &id) {
        // The new choice failed. Put the old one back, and report.
        {
            let mut state = STATE.lock();
            match previous {
                Some(p) => {
                    state.overrides.insert(id.clone(), p);
                }
                None => {
                    state.overrides.remove(&id);
                }
            }
        }
        let _ = resync(&app, &id);
        return Err(message);
    }
    Ok(statuses())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn parses_modifiers_and_one_key() {
        let c = parse_combo("Mod+Alt+Shift+P").unwrap();
        assert_eq!(c.modifiers, vec!["Mod", "Alt", "Shift"]);
        assert_eq!(c.key, "P");
        assert_eq!(parse_combo("ctrl+option+space").unwrap().modifiers, vec!["Ctrl", "Alt"]);
    }

    #[test]
    fn refuses_combos_that_cannot_work_from_any_app() {
        assert!(parse_combo("P").is_err());
        assert!(parse_combo("Shift+P").is_err());
        assert!(parse_combo("Ctrl").is_err());
        assert!(parse_combo("Ctrl+A+B").is_err());
        assert!(parse_combo("").is_err());
    }

    #[test]
    fn mod_is_ctrl_on_windows_and_super_on_a_mac() {
        let c = parse_combo("Mod+Alt+Space").unwrap();
        assert_eq!(plugin_string(&c, false), "Ctrl+Alt+Space");
        assert_eq!(plugin_string(&c, true), "Super+Alt+Space");
        assert_eq!(plugin_string(&parse_combo("Ctrl+Meta+K").unwrap(), true), "Ctrl+Super+K");
    }

    #[test]
    fn every_default_is_a_combo_the_plugin_accepts_on_both_platforms() {
        for (id, win, mac) in ACTIONS {
            assert!(validate(win, false).is_ok(), "{id} windows default {win}");
            assert!(validate(mac, true).is_ok(), "{id} mac default {mac}");
        }
    }

    #[test]
    fn the_mac_defaults_avoid_the_input_source_switch() {
        // Ctrl+Alt+Space is "Select next input source" on a Mac.
        for (id, _, mac) in ACTIONS {
            assert_ne!(mac, "Ctrl+Alt+Space", "{id}");
        }
        assert_eq!(default_combo("ask-bar", true), Some("Mod+Shift+Space"));
        assert_eq!(default_combo("ask-bar", false), Some("Mod+Alt+Space"));
        assert_eq!(default_combo("nope", false), None);
    }

    #[test]
    fn the_windows_defaults_stay_what_they_were() {
        assert_eq!(plugin_string(&parse_combo(default_combo("ask-bar", false).unwrap()).unwrap(), false), "Ctrl+Alt+Space");
        assert_eq!(plugin_string(&parse_combo(default_combo("stop-all", false).unwrap()).unwrap(), false), "Ctrl+Alt+Shift+P");
        assert_eq!(plugin_string(&parse_combo(default_combo("mode-toggle", false).unwrap()).unwrap(), false), "Ctrl+Alt+M");
    }

    #[test]
    fn candidates_try_the_choice_then_the_default() {
        assert_eq!(candidates(&map(&[]), "stop-all", false, None), Some(vec!["Mod+Alt+Shift+P".to_string()]));
        assert_eq!(
            candidates(&map(&[("stop-all", "Mod+Alt+K")]), "stop-all", false, None),
            Some(vec!["Mod+Alt+K".to_string(), "Mod+Alt+Shift+P".to_string()])
        );
        // Off means nothing is tried.
        assert_eq!(candidates(&map(&[("stop-all", DISABLED)]), "stop-all", false, None), Some(vec![]));
        // An older choice stands in for the default, and the default is still the last resort.
        assert_eq!(
            candidates(&map(&[]), "ask-bar", false, Some("Alt+Space")),
            Some(vec!["Alt+Space".to_string(), "Mod+Alt+Space".to_string()])
        );
        assert_eq!(candidates(&map(&[]), "ask-bar", false, Some("Mod+Alt+Space")), Some(vec!["Mod+Alt+Space".to_string()]));
        assert_eq!(candidates(&map(&[]), "unknown", false, None), None);
    }

    #[test]
    fn reads_the_saved_choices_from_the_settings_file() {
        let file = serde_json::json!({"settings": {"keybindings": {"ask-bar": "Mod+Alt+K", "bad": 3}}});
        assert_eq!(overrides_from_file(&file), map(&[("ask-bar", "Mod+Alt+K")]));
        assert!(overrides_from_file(&serde_json::json!({})).is_empty());
    }
}
