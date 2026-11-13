//! The window code. Reached only through `super::plan`, so it runs only while the Labs switch is on.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use super::place::{anchored_resize, clamp, monitor_key, Rect, Saved};
use super::{compact_size, expanded_size, hidden_for_ms, plan, window_spec, PetSettings, PetSize, Plan, LABEL};

static APP: OnceLock<AppHandle> = OnceLock::new();
static WANT: Mutex<Option<PetSettings>> = Mutex::new(None);
/// Bumped on every settings change so an old "show again after the hour" timer does nothing.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static EXPANDED: Mutex<bool> = Mutex::new(false);
static LAST_PROGRAMMATIC_MOVE_MS: AtomicU64 = AtomicU64::new(0);
static LAST_MOVE_MS: AtomicU64 = AtomicU64::new(0);

/// A move this long after our own `set_position` is ours, not the person dragging.
const PROGRAMMATIC_QUIET_MS: u64 = 500;
/// The drag counts as finished when the window has not moved for this long.
const DRAG_SETTLE_MS: u64 = 350;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn spots_path() -> std::path::PathBuf {
    crate::app_paths::app_data_dir().join("desktop-pet.json")
}

fn expanded_now() -> bool {
    *EXPANDED.lock().unwrap_or_else(|e| e.into_inner())
}

/// The effective settings arrived (start, or a change). Remembered; applied now if the app is up, else at `init`.
pub fn apply_settings(public: &Value) {
    let settings = PetSettings::from_settings(public);
    *WANT.lock().unwrap_or_else(|e| e.into_inner()) = Some(settings);
    if let Some(app) = APP.get() {
        reconcile(app.clone());
    }
}

/// Called once when the app is up (end of setup).
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    reconcile(app.clone());
}

fn wanted() -> PetSettings {
    WANT.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or_default()
}

/// Make the window match the settings. The window work happens on its own thread (as the mini bar does).
fn reconcile(app: AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let settings = wanted();
        let now = now_ms();
        let existing = app.get_webview_window(LABEL);
        match plan(&settings, now, existing.is_some()) {
            Plan::Close => {
                if let Some(window) = existing {
                    let _ = window.destroy();
                }
                if let Some(wait) = hidden_for_ms(&settings, now) {
                    std::thread::sleep(Duration::from_millis(wait.min(24 * 3600 * 1000) + 500));
                    if GENERATION.load(Ordering::SeqCst) == generation {
                        reconcile(app);
                    }
                }
            }
            Plan::Create => create(&app, settings.size),
            Plan::Resize => {
                if let Some(window) = existing {
                    resize(&window, settings.size, expanded_now());
                }
            }
        }
    });
}

fn monitors_of(app: &AppHandle) -> (Vec<(String, Rect)>, usize) {
    let mut out = Vec::new();
    let mut primary = 0;
    let primary_key = app.primary_monitor().ok().flatten().map(|m| monitor_key_of(&m));
    for m in app.available_monitors().unwrap_or_default() {
        let key = monitor_key_of(&m);
        if Some(&key) == primary_key.as_ref() {
            primary = out.len();
        }
        out.push((key, work_area_of(&m)));
    }
    (out, primary)
}

fn work_area_of(m: &tauri::Monitor) -> Rect {
    let scale = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
    let a = m.work_area();
    Rect::new(f64::from(a.position.x) / scale, f64::from(a.position.y) / scale, f64::from(a.size.width) / scale, f64::from(a.size.height) / scale)
}

fn monitor_key_of(m: &tauri::Monitor) -> String {
    let scale = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
    monitor_key(Rect::new(f64::from(m.position().x) / scale, f64::from(m.position().y) / scale, f64::from(m.size().width) / scale, f64::from(m.size().height) / scale))
}

fn create(app: &AppHandle, size: PetSize) {
    let spec = window_spec(size);
    let saved = std::fs::read_to_string(spots_path()).map(|t| Saved::parse(&t)).unwrap_or_default();
    let (monitors, primary) = monitors_of(app);
    let pos = saved.start_position(&monitors, primary, spec.width, spec.height);
    *EXPANDED.lock().unwrap_or_else(|e| e.into_inner()) = false;
    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .resizable(spec.resizable)
        .decorations(spec.decorations)
        .transparent(spec.transparent)
        .always_on_top(spec.always_on_top)
        .skip_taskbar(spec.skip_taskbar)
        .shadow(spec.shadow)
        .focused(spec.focused)
        .focusable(spec.focusable)
        .visible(spec.visible);
    if let Some((x, y)) = pos {
        builder = builder.position(x, y);
    }
    match builder.build() {
        Ok(window) => {
            watch_moves(app, &window);
            // Shown without activating: the window cannot take focus (`focusable(false)`).
            let _ = window.show();
            tracing::info!("desktop potato opened");
        }
        Err(e) => tracing::warn!(error = %e, "desktop potato failed to open"),
    }
}

/// Remember where the person drops it, and tell the page when a drag has settled.
fn watch_moves(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(_) = event {
            let at = now_ms();
            LAST_MOVE_MS.store(at, Ordering::SeqCst);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(DRAG_SETTLE_MS));
                if LAST_MOVE_MS.load(Ordering::SeqCst) != at {
                    return;
                }
                let ours = is_programmatic_move(at);
                save_position(&app);
                if !ours {
                    let _ = app.emit_to(LABEL, "pet://moved", serde_json::json!({}));
                }
            });
        }
    });
}

/// Our own walking and resizing set the position too; the page must not read that as a drag.
fn note_programmatic_move() {
    LAST_PROGRAMMATIC_MOVE_MS.store(now_ms(), Ordering::SeqCst);
}

fn is_programmatic_move(at_ms: u64) -> bool {
    let last = LAST_PROGRAMMATIC_MOVE_MS.load(Ordering::SeqCst);
    last != 0 && at_ms.saturating_sub(last) < PROGRAMMATIC_QUIET_MS
}

type Geometry = ((f64, f64), (f64, f64), Rect, String);

/// (top-left, size, work area, monitor key) of the window, all logical px.
fn window_geometry(window: &WebviewWindow) -> Option<Geometry> {
    let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = window.scale_factor().ok().filter(|s| *s > 0.0).unwrap_or(1.0);
    let p = window.outer_position().ok()?;
    let s = window.outer_size().ok()?;
    Some((
        (f64::from(p.x) / scale, f64::from(p.y) / scale),
        (f64::from(s.width) / scale, f64::from(s.height) / scale),
        work_area_of(&monitor),
        monitor_key_of(&monitor),
    ))
}

/// Save the spot of the compact window (its corner is what is remembered, so an open bubble does not move it).
fn save_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let Some((pos, size, _, key)) = window_geometry(&window) else { return };
    let compact = compact_size(wanted().size);
    let pos = if expanded_now() { (pos.0 + size.0 - compact.0, pos.1 + size.1 - compact.1) } else { pos };
    let path = spots_path();
    let mut saved = std::fs::read_to_string(&path).map(|t| Saved::parse(&t)).unwrap_or_default();
    saved.remember(&key, pos);
    let _ = std::fs::write(path, saved.to_json());
}

fn resize(window: &WebviewWindow, size: PetSize, expanded: bool) {
    let Some((pos, old, work, _)) = window_geometry(window) else { return };
    let new = if expanded { expanded_size(size) } else { compact_size(size) };
    let next = anchored_resize(pos, old, new, work);
    note_programmatic_move();
    let _ = crate::window_layout::own_window::set_size(window, tauri::LogicalSize::new(new.0, new.1));
    let _ = crate::window_layout::own_window::set_position(window, tauri::LogicalPosition::new(next.0, next.1));
}

/// The page asks for room for a bubble or the menu (`true`), or gives it back.
pub fn set_expanded(app: &AppHandle, expanded: bool) {
    *EXPANDED.lock().unwrap_or_else(|e| e.into_inner()) = expanded;
    if let Some(window) = app.get_webview_window(LABEL) {
        resize(&window, wanted().size, expanded);
    }
}

/// Walk: move by `dx` logical px along the work area, never off it. Returns true when an edge stopped it.
pub fn move_by(app: &AppHandle, dx: f64) -> bool {
    let Some(window) = app.get_webview_window(LABEL) else { return true };
    let Some((pos, size, work, _)) = window_geometry(&window) else { return true };
    let target = clamp((pos.0 + dx, pos.1), work, size.0, size.1);
    note_programmatic_move();
    crate::window_layout::own_window::set_position(&window, tauri::LogicalPosition::new(target.0, target.1));
    (target.0 - (pos.0 + dx)).abs() > 0.5
}

/// Whether a full-screen app, a game or a presentation is in front. `None`: cannot tell (the page then does not walk).
#[cfg(windows)]
pub fn fullscreen_busy() -> Option<bool> {
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    // SAFETY: a plain query with no arguments.
    let state = unsafe { SHQueryUserNotificationState() }.ok()?;
    Some(super::fullscreen_from_notification_state(state.0))
}

#[cfg(not(windows))]
pub fn fullscreen_busy() -> Option<bool> {
    None
}
