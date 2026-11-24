//! The docked agent browser (Labs "Browser in the side panel", `dock_browser_enabled`).
//!
//! The page is a child webview of the cockpit window, placed over the page area of the browser pane in the details
//! column. The pane (React, `BrowserPane.tsx`) reports where its page area is; Rust sets the child's bounds to it and
//! hides the child (it does not size it to zero) when the pane is hidden. The tabs, back, forward, reload, the address
//! and the mark-up button are app content drawn by the pane; the agent bar and the mark-up bar stay inside the page.
//!
//! Rules (design: `MINIONS-SPINOFFS-PLAN.md` section 10.4):
//! 1. **Nothing draws over the page.** A native child webview always paints above the app's own page. While a menu, a
//!    sheet or a dialog is open the pane asks for a picture of the page (`dock_browser_snapshot`), shows it, and
//!    freezes the child (`dock_browser_freeze`): hidden, but alive, so an agent step that arrives still runs. When the
//!    overlay closes the child is shown again.
//! 2. **Bounds follow the layout** (`child_bounds`, a pure function that the tests pin).
//! 3. **Pop out and dock back make a new view** at the same address (`point::window::move_view`). Re-parenting a
//!    WebView2 that has had the mouse hangs the app; the lab ran 150 recreate cycles with no hang.
//! 4. **Fallback:** when the pane is not there (the switch is off, no cockpit window, the pane did not answer in time)
//!    the browser opens in its own window, as before.
//!
//! The child webview has no capability, like every preview window: the page cannot call the app.

use crate::point::capture;
use crate::point::window::{self, Move};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Window};

/// The Labs switch (Settings > General > Labs > Browser in the side panel).
pub const SETTING: &str = "dock_browser_enabled";
/// How long a tool waits for the pane to open and say where its page is, before the browser opens in a window.
const PANE_WAIT: Duration = Duration::from_millis(3_000);
const SNAPSHOT_WAIT: Duration = Duration::from_secs(3);

/// The page area of the pane, in the cockpit window's CSS pixels (logical).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the child goes: `(x, y, width, height)` in logical pixels.
pub type Bounds = (f64, f64, f64, f64);

/// The child's bounds for the pane's page rectangle. None (hide it) when the pane is not showing or the rectangle is
/// empty or not a number. Pure.
pub fn child_bounds(rect: Option<Rect>) -> Option<Bounds> {
    let r = rect?;
    if ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite()) || r.width < 1.0 || r.height < 1.0 {
        return None;
    }
    Some((r.x, r.y, r.width, r.height))
}

/// Keeps bounds inside the window's content area `(width, height)` (logical). None when nothing of it is left inside.
/// Pure.
pub fn clamp_bounds(b: Bounds, window: (f64, f64)) -> Option<Bounds> {
    let (x, y) = (b.0.max(0.0), b.1.max(0.0));
    let (w, h) = ((b.0 + b.2).min(window.0) - x, (b.1 + b.3).min(window.1) - y);
    (w >= 1.0 && h >= 1.0 && window.0.is_finite() && window.1.is_finite()).then_some((x, y, w, h))
}

/// Whether a docked child is shown: the pane shows its page area, nothing is drawn over it, and it is the tab in front.
/// Pure.
pub fn should_show(has_page_area: bool, frozen: bool, active: bool) -> bool {
    has_page_area && !frozen && active
}

/// Where the dock is: the window that holds the pane and the pane's page rectangle.
#[derive(Clone)]
pub struct DockHost {
    pub window: Window,
    pub rect: Rect,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TabState {
    id: String,
    url: String,
    title: String,
    error: String,
}

#[derive(Default)]
struct State {
    /// The label of the window whose pane reported last, and the rectangle (None while the pane is hidden).
    host: Option<String>,
    rect: Option<Rect>,
    frozen: bool,
    active: Option<String>,
    tabs: Vec<TabState>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));
/// Until when (ms since the epoch) a page is being opened in the pane. The pane's own "open a start page when there is
/// none" must wait for it, or the person's start page and the agent's page are made together and the wrong one is in front.
static OPENING_UNTIL: AtomicU64 = AtomicU64::new(0);
const OPENING_FOR_MS: u64 = 10_000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Whether the pane may open a start page on its own: no tab yet, and nobody is opening a page.
pub fn may_auto_open(tabs: usize, opening_until_ms: u64, now: u64) -> bool {
    tabs == 0 && now >= opening_until_ms
}

/// What the pane shows for one tab.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    pub error: String,
    pub active: bool,
    /// The page is in a window of its own ("Browser is in its own window").
    pub popped: bool,
}

/// Whether the Labs switch is on now (a development build reads it as on).
pub fn enabled(app: &AppHandle) -> bool {
    // shortcut: on Linux wry packs a child webview into the window's GtkBox, which ignores bounds (the page lands below
    // the app), so the browser opens in its own window there. Upgrade: parent the child in a GtkFixed.
    if cfg!(target_os = "linux") {
        return false;
    }
    crate::settings_store::read_public_settings(app).get(SETTING).and_then(Value::as_bool).unwrap_or(false)
}

/// Where the pane's page area is now, when it is showing.
pub fn current_host(app: &AppHandle) -> Option<DockHost> {
    let (label, rect) = {
        let s = STATE.lock();
        (s.host.clone()?, s.rect?)
    };
    child_bounds(Some(rect))?;
    Some(DockHost { window: app.get_window(&label)?, rect })
}

/// The dock for a page that is about to open. With the Labs switch off, or no cockpit window, it is None (a window of its
/// own, as before). With it on, the pane is asked to open (in the chat of `owner` when known) and the call waits a
/// moment for it to say where its page is. Call from a worker thread.
pub fn host_for_open(app: &AppHandle, owner: Option<&str>) -> Option<DockHost> {
    if !enabled(app) {
        return None;
    }
    OPENING_UNTIL.store(now_ms() + OPENING_FOR_MS, Ordering::Relaxed);
    if let Some(host) = current_host(app) {
        return Some(host);
    }
    ask_pane_to_open(app, owner);
    let until = Instant::now() + PANE_WAIT;
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(host) = current_host(app) {
            return Some(host);
        }
    }
    tracing::warn!("dock browser: the pane did not open in time; the browser opens in its own window");
    None
}

fn ask_pane_to_open(app: &AppHandle, owner: Option<&str>) {
    let _ = app.emit("dock-browser-open", json!({ "paneId": owner }));
}

/// A docked page was made: it is the tab in front.
pub fn added(app: &AppHandle, id: &str) {
    OPENING_UNTIL.store(0, Ordering::Relaxed);
    {
        let mut s = STATE.lock();
        if !s.tabs.iter().any(|t| t.id == id) {
            s.tabs.push(TabState { id: id.to_string(), ..TabState::default() });
        }
        s.active = Some(id.to_string());
    }
    changed(app);
}

/// Brings a tab to the front, and asks the pane to open if it is not showing.
pub fn activate(app: &AppHandle, id: &str, owner: Option<&str>) {
    let showing = STATE.lock().rect.is_some();
    {
        let mut s = STATE.lock();
        if s.tabs.iter().any(|t| t.id == id) {
            s.active = Some(id.to_string());
        }
    }
    if !showing {
        ask_pane_to_open(app, owner);
    }
    changed(app);
}

/// Whether this preview is a tab of the pane (docked now, or popped out from it).
pub fn is_tab(id: &str) -> bool {
    STATE.lock().tabs.iter().any(|t| t.id == id)
}

/// The page's address, title and error word, from the bar loop. Sent to the pane when they change.
pub fn note_state(app: &AppHandle, id: &str, url: &str, title: &str, error: &str) {
    let changed_now = {
        let mut s = STATE.lock();
        let Some(tab) = s.tabs.iter_mut().find(|t| t.id == id) else { return };
        let next = TabState { id: id.to_string(), url: url.to_string(), title: title.chars().take(120).collect(), error: error.to_string() };
        let differs = *tab != next;
        *tab = next;
        differs
    };
    if changed_now {
        emit_tabs(app);
    }
}

/// The tabs, the front one and the bounds changed: forget closed pages, move the children, tell the pane.
pub fn changed(app: &AppHandle) {
    {
        let mut s = STATE.lock();
        s.tabs.retain(|t| window::view_of(app, &t.id).is_some());
        if s.active.as_ref().is_some_and(|a| !s.tabs.iter().any(|t| &t.id == a)) {
            s.active = s.tabs.last().map(|t| t.id.clone());
        }
    }
    apply(app);
    emit_tabs(app);
}

/// Puts every docked child where the pane's page area is, and shows only the tab in front.
pub fn apply(app: &AppHandle) {
    let (rect, frozen, active, ids) = {
        let s = STATE.lock();
        (s.rect, s.frozen, s.active.clone(), s.tabs.iter().map(|t| t.id.clone()).collect::<Vec<_>>())
    };
    let host = STATE.lock().host.clone().and_then(|l| app.get_window(&l));
    let inner = host.and_then(|w| Some((w.inner_size().ok()?, w.scale_factor().ok()?))).map(|(s, f)| (s.width as f64 / f, s.height as f64 / f));
    let bounds = child_bounds(rect).and_then(|b| inner.map_or(Some(b), |i| clamp_bounds(b, i)));
    for id in ids {
        if !window::is_docked(&id) {
            continue;
        }
        let Some(view) = window::view_of(app, &id) else { continue };
        if let Some((x, y, w, h)) = bounds {
            let _ = view.set_position(LogicalPosition::new(x, y));
            let _ = view.set_size(LogicalSize::new(w, h));
        }
        let show = should_show(bounds.is_some(), frozen, active.as_deref() == Some(id.as_str()));
        let _ = if show { view.show() } else { view.hide() };
    }
}

fn tab_list(app: &AppHandle) -> Vec<TabInfo> {
    let s = STATE.lock();
    s.tabs
        .iter()
        .filter(|t| window::view_of(app, &t.id).is_some())
        .map(|t| TabInfo { id: t.id.clone(), title: t.title.clone(), url: t.url.clone(), error: t.error.clone(), active: s.active.as_deref() == Some(t.id.as_str()), popped: !window::is_docked(&t.id) })
        .collect()
}

fn emit_tabs(app: &AppHandle) {
    let _ = app.emit("dock-browser-tabs", tab_list(app));
}

fn active_docked(app: &AppHandle) -> Option<(String, tauri::Webview)> {
    let id = STATE.lock().active.clone()?;
    window::is_docked(&id).then(|| window::view_of(app, &id).map(|v| (id, v))).flatten()
}

// ---------------------------------------------------------------- commands (the pane calls these)

/// The pane says where its page area is (None: it is hidden). Called from the window that shows the pane.
#[tauri::command]
pub async fn dock_browser_rect(app: AppHandle, window: Window, rect: Option<Rect>) -> Result<(), String> {
    {
        let mut s = STATE.lock();
        if rect.is_some() || s.host.as_deref() == Some(window.label()) {
            s.host = Some(window.label().to_string());
            s.rect = rect;
        }
    }
    apply(&app);
    Ok(())
}

/// A picture of the page in front, for the pane to show while something is drawn over it. Empty when there is no page.
#[tauri::command]
pub async fn dock_browser_snapshot(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let Some((_, view)) = active_docked(&app) else { return Ok(tauri::ipc::Response::new(Vec::<u8>::new())) };
    let png = tauri::async_runtime::spawn_blocking(move || capture::viewport_png(&view, SNAPSHOT_WAIT)).await.map_err(|e| e.to_string())?;
    // A page that gives no picture is shown as a plain panel: the freeze still happens.
    Ok(tauri::ipc::Response::new(png.unwrap_or_default()))
}

/// Hide the page (something is drawn over it) or show it again.
#[tauri::command]
pub async fn dock_browser_freeze(app: AppHandle, frozen: bool) -> Result<(), String> {
    STATE.lock().frozen = frozen;
    apply(&app);
    Ok(())
}

#[tauri::command]
pub async fn dock_browser_tabs(app: AppHandle) -> Result<Vec<TabInfo>, String> {
    Ok(tab_list(&app))
}

/// Back, forward, reload, or go to a typed address, in the tab in front.
#[tauri::command]
pub async fn dock_browser_nav(app: AppHandle, kind: String, url: Option<String>) -> Result<(), String> {
    let (_, view) = active_docked(&app).ok_or("No page is showing.")?;
    match kind.as_str() {
        "back" => view.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => view.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => view.eval("location.reload()").map_err(|e| e.to_string()),
        "go" => {
            let dev_port = app.config().build.dev_url.as_ref().and_then(|u| u.port());
            let typed = url.unwrap_or_default();
            // The name lookup can take a moment: do it off the async thread.
            let checked = tauri::async_runtime::spawn_blocking(move || crate::browser::chrome::go_target(&typed, dev_port)).await.map_err(|e| e.to_string())?;
            let address = checked.unwrap_or_else(|word| crate::browser::start::address(Some(word)));
            view.navigate(tauri::Url::parse(&address).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        _ => Err("That is not a browser button.".into()),
    }
}

/// Open the mark-up bar in the page in front (the Labs switch "Mark up pages" must be on).
#[tauri::command]
pub async fn dock_browser_mark_up(app: AppHandle) -> Result<(), String> {
    if !window::markup_on(&app) {
        return Err("Turn on Mark up pages in Settings > Labs first.".into());
    }
    let (id, view) = active_docked(&app).ok_or("No page is showing.")?;
    let (info, _) = window::browser_window(&app, &id).ok_or("No page is showing.")?;
    view.eval(crate::markup::bar::set_script(&info.markup_key, &json!({ "open": true }))).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dock_browser_select(app: AppHandle, id: String) -> Result<(), String> {
    activate(&app, &id, None);
    Ok(())
}

#[tauri::command]
pub async fn dock_browser_close(app: AppHandle, id: String) -> Result<(), String> {
    if is_tab(&id) {
        window::close_preview(&app, &id);
    }
    Ok(())
}

/// The plus: a new tab on the start page.
#[tauri::command]
pub async fn dock_browser_new_tab(app: AppHandle, auto: Option<bool>) -> Result<(), String> {
    // `auto`: the pane has no tab and opens a start page by itself; it steps aside for a page that is being opened.
    if auto.unwrap_or(false) && !may_auto_open(tab_list(&app).len(), OPENING_UNTIL.load(Ordering::Relaxed), now_ms()) {
        return Ok(());
    }
    window::open_dock_tab(&app).map(|_| ())
}

/// Pop out: the page moves to a window of its own (today's browser window).
#[tauri::command]
pub async fn dock_browser_popout(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let id = id.or_else(|| STATE.lock().active.clone()).ok_or("No page is showing.")?;
    window::move_view(&app, &id, Move::ToWindow)
}

/// Dock back: the page in its own window moves into the pane again.
#[tauri::command]
pub async fn dock_browser_dockback(app: AppHandle, id: String) -> Result<(), String> {
    let host = host_for_open(&app, None).ok_or("Open the browser pane first.")?;
    window::move_view(&app, &id, Move::ToDock(host))?;
    STATE.lock().active = Some(id);
    apply(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn the_child_bounds_follow_the_pane_rectangle() {
        assert_eq!(child_bounds(Some(rect(700.0, 450.0, 380.0, 300.0))), Some((700.0, 450.0, 380.0, 300.0)));
        // The sidebar folds and a splitter above moves: the rectangle moves, the bounds move with it.
        assert_eq!(child_bounds(Some(rect(520.0, 380.5, 560.0, 370.0))), Some((520.0, 380.5, 560.0, 370.0)));
        // A drag that makes the page area thinner than a pixel hides it.
        assert_eq!(child_bounds(Some(rect(700.0, 450.0, 380.0, 0.4))), None);
    }

    #[test]
    fn the_child_is_kept_inside_the_window() {
        let win = (1440.0, 445.0);
        assert_eq!(clamp_bounds((700.0, 100.0, 380.0, 300.0), win), Some((700.0, 100.0, 380.0, 300.0)));
        assert_eq!(clamp_bounds((1200.0, 300.0, 600.0, 400.0), win), Some((1200.0, 300.0, 240.0, 145.0)));
        assert_eq!(clamp_bounds((-20.0, -5.0, 100.0, 50.0), win), Some((0.0, 0.0, 80.0, 45.0)));
        assert_eq!(clamp_bounds((0.0, 500.0, 100.0, 100.0), win), None, "below the window");
        assert_eq!(clamp_bounds((1500.0, 0.0, 100.0, 100.0), win), None, "right of the window");
    }

    #[test]
    fn a_hidden_or_broken_rectangle_hides_the_child() {
        assert_eq!(child_bounds(None), None);
        assert_eq!(child_bounds(Some(rect(f64::NAN, 0.0, 100.0, 100.0))), None);
        assert_eq!(child_bounds(Some(rect(0.0, 0.0, f64::INFINITY, 100.0))), None);
        assert_eq!(child_bounds(Some(rect(0.0, 0.0, 0.0, 100.0))), None);
    }

    #[test]
    fn the_child_shows_only_when_it_is_the_front_tab_with_nothing_over_it() {
        assert!(should_show(true, false, true));
        assert!(!should_show(false, false, true), "the pane is hidden");
        assert!(!should_show(true, true, true), "a menu is open over it");
        assert!(!should_show(true, false, false), "another tab is in front");
    }

    #[test]
    fn the_pane_opens_a_start_page_by_itself_only_when_nothing_is_open_or_opening() {
        assert!(may_auto_open(0, 0, 1_000));
        assert!(!may_auto_open(1, 0, 1_000), "a tab is there");
        assert!(!may_auto_open(0, 5_000, 1_000), "an agent is opening a page right now");
        assert!(may_auto_open(0, 5_000, 6_000), "the wait ran out");
    }

    #[test]
    fn the_rectangle_comes_from_the_pane_as_the_pane_writes_it() {
        let r: Rect = serde_json::from_value(json!({ "x": 700, "y": 450, "width": 380, "height": 300 })).unwrap();
        assert_eq!(r, rect(700.0, 450.0, 380.0, 300.0));
    }
}
