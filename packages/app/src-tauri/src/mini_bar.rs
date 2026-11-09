//! The mini bar: a small always-on-top strip that stays on screen while the UI mode is Individual, so the app
//! never "vanishes" when the cockpit hides. It lists a chip per pane (click = that pane's pop-out), has "New" and
//! "Back to Orchestration", and shows an 8 s Undo after a switch. The pure rules (what a switch or a launch
//! does, where the bar sits, how long the Undo lives) are here and unit tested; the window code is `runtime`.

use crate::ui_mode::UiMode;

pub const LABEL: &str = "mini-bar";
pub const URL: &str = "index.html?minibar=1";
pub const TITLE: &str = "Potato Workspace mini bar";
pub const WIDTH: f64 = 760.0;
pub const HEIGHT: f64 = 44.0;
/// Gap between the top edge of the monitor and the bar (logical px).
pub const TOP_MARGIN: f64 = 8.0;
/// How long the Undo toast lives after a switch to Individual.
pub const TOAST_MS: u64 = 8000;
/// Global shortcut that toggles the mode.
pub const MODE_SHORTCUT: &str = "Ctrl+Alt+M";

/// What switching to `mode` does to the windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwitchPlan {
    pub pop_out_panes: bool,
    pub hide_cockpit: bool,
    pub show_mini_bar: bool,
}

/// Individual: the mini bar is always shown (even with no panes, so something stays on screen); pop-outs only
/// when there are panes. Orchestration: the bar goes away and the cockpit comes back.
pub fn switch_plan(mode: UiMode, pane_count: usize) -> SwitchPlan {
    match mode {
        UiMode::Individual => SwitchPlan { pop_out_panes: pane_count > 0, hide_cockpit: true, show_mini_bar: true },
        UiMode::Orchestration => SwitchPlan { pop_out_panes: false, hide_cockpit: false, show_mini_bar: false },
    }
}

/// What a normal start does, given the saved mode and the number of live panes at that moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// Open the cockpit as always.
    Cockpit,
    /// Saved Individual with panes: pop-outs and the mini bar, no cockpit.
    IndividualWindows,
    /// Saved Individual but no panes: start in Orchestration for this launch only (the saved choice is kept and
    /// the cockpit says so).
    FallBackToOrchestration,
}

pub fn launch_decision(saved: UiMode, pane_count: usize) -> Launch {
    match (saved, pane_count) {
        (UiMode::Orchestration, _) => Launch::Cockpit,
        (UiMode::Individual, 0) => Launch::FallBackToOrchestration,
        (UiMode::Individual, _) => Launch::IndividualWindows,
    }
}

/// The other mode (hotkey, toggles).
pub fn toggled(mode: UiMode) -> UiMode {
    match mode {
        UiMode::Orchestration => UiMode::Individual,
        UiMode::Individual => UiMode::Orchestration,
    }
}

/// Logical top-left of the bar, centred along the top of a monitor given in physical pixels.
pub fn top_center(mon_x: f64, mon_y: f64, mon_w: f64, scale: f64) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let (x, y, w) = (mon_x / scale, mon_y / scale, mon_w / scale);
    (x + ((w - WIDTH) / 2.0).max(0.0), y + TOP_MARGIN)
}

/// Milliseconds of Undo left: `switched_at` is when the person switched (None: no switch to undo, e.g. a launch).
pub fn toast_left_ms(now_ms: u64, switched_at: Option<u64>) -> u64 {
    match switched_at {
        Some(at) => TOAST_MS.saturating_sub(now_ms.saturating_sub(at)),
        None => 0,
    }
}

mod runtime {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

    /// (x, y, width, scale) of the monitor the cockpit was on: physical pixels, then the scale factor.
    type MonitorRect = (f64, f64, f64, f64);

    static MONITOR: Mutex<Option<MonitorRect>> = Mutex::new(None);
    static SWITCHED_AT: AtomicU64 = AtomicU64::new(0);
    static FELL_BACK: AtomicBool = AtomicBool::new(false);

    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    }

    /// Remember the monitor the cockpit is on (call before hiding it).
    pub fn remember_cockpit_monitor(app: &AppHandle) {
        let Some(window) = app.get_webview_window(crate::app_windows::COCKPIT_LABEL) else { return };
        if let Ok(Some(m)) = window.current_monitor() {
            *MONITOR.lock() = Some((f64::from(m.position().x), f64::from(m.position().y), f64::from(m.size().width), m.scale_factor()));
        }
    }

    fn position(app: &AppHandle) -> Option<(f64, f64)> {
        let saved = *MONITOR.lock();
        let rect = saved.or_else(|| {
            app.primary_monitor().ok().flatten().map(|m| {
                (f64::from(m.position().x), f64::from(m.position().y), f64::from(m.size().width), m.scale_factor())
            })
        })?;
        Some(top_center(rect.0, rect.1, rect.2, rect.3))
    }

    /// Note that the person just switched to Individual: the bar offers Undo for `TOAST_MS`.
    pub fn note_switch() {
        SWITCHED_AT.store(now_ms(), Ordering::Relaxed);
    }

    pub fn clear_switch() {
        SWITCHED_AT.store(0, Ordering::Relaxed);
    }

    pub fn toast_left() -> u64 {
        let at = SWITCHED_AT.load(Ordering::Relaxed);
        toast_left_ms(now_ms(), (at != 0).then_some(at))
    }

    pub fn note_fallback() {
        FELL_BACK.store(true, Ordering::Relaxed);
    }

    /// True once after a launch that fell back to Orchestration; the cockpit reads it to say so.
    pub fn take_fallback() -> bool {
        FELL_BACK.swap(false, Ordering::Relaxed)
    }

    /// Show the bar (create it the first time). It never takes focus.
    pub fn show(app: &AppHandle) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Some(window) = app.get_webview_window(LABEL) {
                if let Some((x, y)) = position(&app) {
                    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                }
                let _ = window.show();
                let _ = window.set_always_on_top(true);
                let _ = app.emit_to(LABEL, "mini-bar://shown", serde_json::json!({ "toastMs": toast_left() }));
                return;
            }
            let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(URL.into()))
                .title(TITLE)
                .inner_size(WIDTH, HEIGHT)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .focusable(false)
                .shadow(true);
            if let Some((x, y)) = position(&app) {
                builder = builder.position(x, y);
            }
            match builder.build() {
                Ok(_) => tracing::info!("mini bar opened"),
                Err(e) => tracing::warn!(error = %e, "mini bar failed to open"),
            }
        });
    }

    pub fn hide(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
    }

    /// Tray left-click in Individual: every pop-out and the bar come to the front (the last pop-out takes focus).
    pub fn bring_all_to_front(app: &AppHandle) {
        show(app);
        let labels: Vec<String> = app.webview_windows().keys().filter(|l| l.starts_with("detached-pane-")).cloned().collect();
        let count = labels.len();
        for (i, label) in labels.into_iter().enumerate() {
            if let Some(window) = app.get_webview_window(&label) {
                if !window.is_visible().unwrap_or(true) {
                    continue;
                }
                let _ = window.unminimize();
                let _ = window.show();
                if i + 1 == count {
                    let _ = window.set_focus();
                }
            }
        }
    }

    /// Register Ctrl+Alt+M. A taken shortcut is logged, not fatal.
    pub fn init_mode_shortcut(app: &AppHandle) {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        let handle = app.clone();
        let result = app.global_shortcut().on_shortcut(MODE_SHORTCUT, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    let _ = crate::cockpit::set_mode(&handle, toggled(crate::ui_mode::current()));
                });
            }
        });
        if let Err(e) = result {
            tracing::warn!(error = %e, "mode shortcut could not be registered");
        }
    }
}

pub use runtime::{bring_all_to_front, clear_switch, hide, init_mode_shortcut, note_fallback, note_switch, remember_cockpit_monitor, show, take_fallback, toast_left};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_switch_to_individual_with_no_panes_still_shows_the_mini_bar() {
        let plan = switch_plan(UiMode::Individual, 0);
        assert!(plan.show_mini_bar, "something must stay on screen");
        assert!(!plan.pop_out_panes);
        assert!(plan.hide_cockpit);
    }

    #[test]
    fn a_switch_to_individual_with_panes_pops_them_out_and_shows_the_bar() {
        assert_eq!(switch_plan(UiMode::Individual, 3), SwitchPlan { pop_out_panes: true, hide_cockpit: true, show_mini_bar: true });
    }

    #[test]
    fn orchestration_hides_the_bar_and_keeps_the_cockpit() {
        assert_eq!(switch_plan(UiMode::Orchestration, 2), SwitchPlan { pop_out_panes: false, hide_cockpit: false, show_mini_bar: false });
    }

    #[test]
    fn launch_in_individual_without_panes_falls_back() {
        assert_eq!(launch_decision(UiMode::Individual, 0), Launch::FallBackToOrchestration);
        assert_eq!(launch_decision(UiMode::Individual, 2), Launch::IndividualWindows);
        assert_eq!(launch_decision(UiMode::Orchestration, 0), Launch::Cockpit);
        assert_eq!(launch_decision(UiMode::Orchestration, 5), Launch::Cockpit);
    }

    #[test]
    fn the_hotkey_toggles_and_parses() {
        assert_eq!(toggled(UiMode::Orchestration), UiMode::Individual);
        assert_eq!(toggled(UiMode::Individual), UiMode::Orchestration);
        assert!(MODE_SHORTCUT.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok());
    }

    #[test]
    fn the_bar_is_centred_along_the_top_of_its_monitor() {
        // 1920 wide at scale 1: (1920 - 760) / 2 = 580.
        assert_eq!(top_center(0.0, 0.0, 1920.0, 1.0), (580.0, TOP_MARGIN));
        // A monitor left of the primary one at 150%: physical x -2880, width 2880 -> logical x -1920, width 1920.
        assert_eq!(top_center(-2880.0, 0.0, 2880.0, 1.5), (-1920.0 + 580.0, TOP_MARGIN));
        // A bad scale does not divide by zero.
        assert_eq!(top_center(0.0, 0.0, 1920.0, 0.0).1, TOP_MARGIN);
    }

    #[test]
    fn the_undo_lives_eight_seconds() {
        assert_eq!(toast_left_ms(1000, Some(1000)), 8000);
        assert_eq!(toast_left_ms(5000, Some(1000)), 4000);
        assert_eq!(toast_left_ms(9000, Some(1000)), 0);
        assert_eq!(toast_left_ms(20_000, Some(1000)), 0);
        assert_eq!(toast_left_ms(1000, None), 0);
    }
}
