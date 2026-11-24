//! Windows the Rust side opens by itself (panes-first PF2): the Settings window and pop-out pane
//! windows. Neither depends on the main webview. Window creation runs on a helper thread because
//! building a webview window from a non-main thread must not block an event-loop callback.

pub const SETTINGS_LABEL: &str = "settings";
pub const SETTINGS_TITLE: &str = "Potato Workspace Settings";
pub const COCKPIT_LABEL: &str = crate::ui_mode::COCKPIT_LABEL;
pub const COCKPIT_TITLE: &str = "Potato Workspace";
/// Emitted when a tab's own window closes: `{ paneId, tab }`. The cockpit puts the tab back.
pub const TAB_CLOSED_EVENT: &str = "tabwin://closed";

/// `index.html?cockpit=1`: the route `src/main.tsx` renders as the cockpit. A window created for a
/// "show this pane" request also carries `&select=<pane id>` so the selection survives the webview
/// not listening yet when `cockpit://select` is emitted.
pub fn cockpit_url(select: Option<&str>) -> String {
    match select.filter(|id| !id.is_empty()) {
        Some(id) => format!("index.html?cockpit=1&select={}", url_encode(id)),
        None => "index.html?cockpit=1".to_string(),
    }
}

/// `index.html?cockpit=1&view=settings&tab=bridge`: the cockpit window opened straight onto its inline Settings
/// view (Orchestration mode, window created by a "Settings" request). Not `settings=1`: that is the standalone
/// Settings window's route. The tab is sanitised like `settings_url`; a missing one lets the view choose.
pub fn cockpit_settings_url(tab: Option<&str>) -> String {
    let tab = tab.map(str::trim).filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    match tab {
        Some(tab) => format!("index.html?cockpit=1&view=settings&tab={tab}"),
        None => "index.html?cockpit=1&view=settings".to_string(),
    }
}

/// `index.html?settings=1&tab=agents`: the route `src/main.tsx` renders as the standalone Settings.
pub fn settings_url(tab: Option<&str>) -> String {
    let tab = tab.map(str::trim).filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    format!("index.html?settings=1&tab={}", tab.unwrap_or("agents"))
}

/// `index.html?artifactwin=1&pane=..&id=..`: the route `src/main.tsx` renders as one artifact in its own window.
pub fn artifact_url(pane_id: &str, id: &str) -> String {
    format!("index.html?artifactwin=1&pane={}&id={}", url_encode(pane_id), url_encode(id))
}

/// The label of an artifact's own window: letters, digits and dashes only (an artifact id is already that), so the
/// label matches the `artifact-window-*` capability and one artifact has one window.
pub fn artifact_label(id: &str) -> Option<String> {
    let ok = !id.is_empty() && id.len() <= 48 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    ok.then(|| format!("artifact-window-{id}"))
}

/// One tab of a pane that lives in its own window: the chat, or one file of the project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabKind {
    Chat,
    File(String),
}

/// `chat` or `file:<path>` as the frontend names a tab. Anything else (an empty path, a `..`, a page or guide) is refused.
pub fn parse_tab(tab: &str) -> Option<TabKind> {
    if tab == "chat" {
        return Some(TabKind::Chat);
    }
    let path = tab.strip_prefix("file:")?;
    let bad = path.is_empty() || path.len() > 500 || path.split(['/', '\\']).any(|part| part == ".." || part.is_empty()) || path.contains('\0');
    (!bad).then(|| TabKind::File(path.to_string()))
}

/// `index.html?tabwin=1&pane=..&tab=..`: the route `src/main.tsx` renders as one tab of a pane in its own window.
pub fn tab_url(pane_id: &str, tab: &str) -> String {
    format!("index.html?tabwin=1&pane={}&tab={}", url_encode(pane_id), url_encode(tab))
}

/// The label of a tab's own window (`tab-window-*`, the capability): one tab has one window. A file's name is hashed so
/// the label stays short and has only letters, digits and dashes after the pane part.
pub fn tab_label(pane_id: &str, tab: &str) -> Option<String> {
    let kind = match parse_tab(tab)? {
        TabKind::Chat => "chat".to_string(),
        TabKind::File(path) => {
            let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
            for b in path.bytes() {
                hash = (hash ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
            }
            format!("f{hash:016x}")
        }
    };
    let safe: String = pane_id.chars().map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') { ch } else { '_' }).collect();
    (!safe.is_empty() && safe.len() <= 96).then(|| format!("tab-window-{safe}-{kind}"))
}

/// Same URL the frontend builds in `detachedPaneUrl` (`src/lib/detached-pane-window.ts`).
pub fn pane_url(pane_id: &str) -> String {
    let safe: String = url_encode(pane_id);
    format!("index.html?terminal=1&pane={safe}&detached=1")
}

/// URL of a pre-created (hidden) warm pane window: same route plus `warm=1`, which tells the window
/// its pane is not in any list yet (a warm worker is unlisted until a run or the tray claims it), so
/// it must not close itself as "pane gone".
pub fn warm_pane_url(pane_id: &str) -> String {
    format!("{}&warm=1", pane_url(pane_id))
}

/// The pane window URL Rust builds windows with: `sized=1` tells the page the window already has its final size and
/// place, so it must not resize itself (that was a visible jump after the window was shown).
pub fn sized_url(url: &str) -> String {
    format!("{url}&sized=1")
}

/// Whether a pane window is visible the moment it is built. A window with an exact rect to fit is built hidden and
/// shown after the fit (`build_pane_window`), so it never appears at one size and jumps to another.
pub fn visible_at_build(warm: bool, hidden: bool, has_exact_rect: bool) -> bool {
    !warm && !hidden && !has_exact_rect
}

/// What opening a pane's window has to do, given the window that may already exist (a Preload warm
/// window is created hidden and only needs placing and showing when its pane is claimed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenPlan {
    /// No window yet: build one (placed and shown at creation).
    Create,
    /// A window exists but is hidden (warm): place it like a new window and show it.
    PlaceAndShow,
    /// A visible window exists: just bring it forward.
    Show,
}

pub fn open_plan(window_exists: bool, window_visible: bool) -> OpenPlan {
    match (window_exists, window_visible) {
        (false, _) => OpenPlan::Create,
        (true, false) => OpenPlan::PlaceAndShow,
        (true, true) => OpenPlan::Show,
    }
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Logical window size for a terminal of `cols` x `rows` (mirrors `detachedWindowSizeFromGrid`).
pub fn pane_window_size(cols: u16, rows: u16) -> (f64, f64) {
    let cols = if cols == 0 { 120 } else { cols };
    let rows = if rows == 0 { 32 } else { rows };
    (
        (f64::from(cols) * 7.25).ceil().max(260.0),
        (f64::from(rows) * 16.0).ceil().max(140.0),
    )
}

/// Top-left corner (logical pixels) new windows are placed relative to.
pub type Anchor = (f64, f64);

/// Horizontal/vertical offset between consecutive windows, and how many steps before wrapping.
pub const CASCADE_STEP: f64 = 28.0;
pub const CASCADE_SLOTS: usize = 8;
const CASCADE_ORIGIN: (f64, f64) = (40.0, 60.0);

/// Parse `"x,y"` (the dev anchor in `PM_WINDOW_ANCHOR`). Negative values are valid (a monitor to
/// the left of the primary one).
pub fn parse_anchor(text: &str) -> Option<Anchor> {
    let (x, y) = text.split_once(',')?;
    let (x, y) = (x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?);
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// `settings.pane_window_position` = `{ "x": n, "y": n }` from the app's `settings.json`
/// (`{"settings": {...}}`, written by the frontend store plugin).
pub fn anchor_from_settings(file: &serde_json::Value) -> Option<Anchor> {
    let pos = file.get("settings")?.get("pane_window_position")?;
    let (x, y) = (pos.get("x")?.as_f64()?, pos.get("y")?.as_f64()?);
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// Where windows go: the dev anchor wins (it keeps dev windows on the secondary monitor), then
/// the user's setting, then the primary monitor's origin. `None` means "OS default".
pub fn resolve_anchor(dev: Option<Anchor>, setting: Option<Anchor>, primary: Option<Anchor>) -> Option<Anchor> {
    dev.or(setting).or(primary)
}

/// Position of the `slot`-th window opened from `anchor`: just inside the anchor, each next window
/// offset by `CASCADE_STEP`, wrapping after `CASCADE_SLOTS` so a long session never walks off screen.
pub fn cascade_position(anchor: Anchor, slot: usize) -> Anchor {
    let step = (slot % CASCADE_SLOTS) as f64 * CASCADE_STEP;
    (anchor.0 + CASCADE_ORIGIN.0 + step, anchor.1 + CASCADE_ORIGIN.1 + step)
}

/// Where (and how big) a pop-out opens, in logical pixels. `pos` is `None` when no anchor is known: the OS chooses.
/// ONE function (`pane_placement`) decides this, for the window code and for the animated mode switch's plan, so the
/// rect the animation flies to is the rect the window really gets.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanePlacement {
    pub pos: Option<Anchor>,
    pub size: (f64, f64),
    /// The exact OUTER rect in physical screen pixels, when the layout knows it (Side by side). The window is fitted to
    /// it after it is built, so a scaled monitor cannot shift it. `None` (Cascade): `pos` and `size` are all there is.
    pub phys: Option<(f64, f64, f64, f64)>,
}

/// The placement of the pop-out in cascade `slot` from `anchor`, for a terminal of `cols` x `rows`.
pub fn pane_placement(anchor: Option<Anchor>, slot: usize, cols: u16, rows: u16) -> PanePlacement {
    PanePlacement { pos: anchor.map(|a| cascade_position(a, slot)), size: pane_window_size(cols, rows), phys: None }
}

/// A placement as physical screen pixels `(x, y, w, h)`; `None` without a known position.
pub fn placement_physical(placement: &PanePlacement, scale: f64) -> Option<(f64, f64, f64, f64)> {
    if let Some(phys) = placement.phys {
        return Some(phys);
    }
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let (x, y) = placement.pos?;
    Some((x * scale, y * scale, placement.size.0 * scale, placement.size.1 * scale))
}

/// Placements for a run of panes opened one after another from `first_slot` (what `open_pane_window` would do
/// for each, in order).
pub fn plan_placements(anchor: Option<Anchor>, first_slot: usize, grids: &[(u16, u16)]) -> Vec<PanePlacement> {
    grids.iter().enumerate().map(|(i, (cols, rows))| pane_placement(anchor, first_slot + i, *cols, *rows)).collect()
}

/// Where the cockpit window was last (physical pixels), kept in the app's data folder so a restart opens it the same size and place.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SavedWindow {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// The saved place if it is still on a screen that exists (a monitor is `(x, y, w, h)` in physical pixels): its top-left corner is on one, and it is no bigger than that one.
pub fn usable_saved(saved: SavedWindow, monitors: &[(i32, i32, u32, u32)]) -> Option<SavedWindow> {
    monitors
        .iter()
        .any(|&(mx, my, mw, mh)| saved.x >= mx && saved.y >= my && saved.x < mx + mw as i32 && saved.y < my + mh as i32 && saved.w <= mw && saved.h <= mh && saved.w >= 400 && saved.h >= 300)
        .then_some(saved)
}

/// What the X on one of the app's own windows does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainClose {
    /// Not one of these windows: close as usual.
    PassThrough,
    /// Hide the window; the app keeps running in the tray.
    HideToTray,
    /// Quit the app, after asking when an agent is still working.
    AskToQuit,
}

/// Settings always hides. The main window quits unless `close_to_tray` is on.
pub fn main_close_action(label: &str, close_to_tray: bool) -> MainClose {
    if label == SETTINGS_LABEL {
        MainClose::HideToTray
    } else if label == COCKPIT_LABEL {
        if close_to_tray {
            MainClose::HideToTray
        } else {
            MainClose::AskToQuit
        }
    } else {
        MainClose::PassThrough
    }
}

mod runtime {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

    static STAGGER: AtomicUsize = AtomicUsize::new(0);

    /// Where windows are anchored: the dev anchor, the user's setting, then the primary monitor's origin.
    pub fn current_anchor(app: &AppHandle) -> Option<Anchor> {
        let dev = std::env::var("PM_WINDOW_ANCHOR").ok().and_then(|v| parse_anchor(&v));
        let setting = std::fs::read_to_string(crate::app_paths::app_data_dir().join("settings.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|json| anchor_from_settings(&json));
        let primary = app.primary_monitor().ok().flatten().map(|m| {
            let scale = m.scale_factor();
            (f64::from(m.position().x) / scale, f64::from(m.position().y) / scale)
        });
        resolve_anchor(dev, setting, primary)
    }

    /// Logical x/y for the next window (cascaded), or `None` to let the OS choose.
    fn next_position(app: &AppHandle) -> Option<(f64, f64)> {
        let anchor = current_anchor(app)?;
        Some(cascade_position(anchor, STAGGER.fetch_add(1, Ordering::Relaxed)))
    }

    /// The cascade slot the next window gets, without taking it.
    pub fn peek_slot() -> usize {
        STAGGER.load(Ordering::Relaxed)
    }

    /// Take `count` cascade slots at once (the animated switch plans all its pop-outs before opening them); the first.
    pub fn reserve_slots(count: usize) -> usize {
        STAGGER.fetch_add(count, Ordering::Relaxed)
    }

    fn saved_path() -> std::path::PathBuf {
        crate::app_paths::app_data_dir().join("cockpit-window.json")
    }

    /// Puts the cockpit window back where it was, when that place is still on a screen. Never moves it when a dev anchor is set.
    fn restore_saved(window: &tauri::WebviewWindow) {
        if std::env::var("PM_WINDOW_ANCHOR").is_ok() {
            return;
        }
        let Some(saved) = std::fs::read_to_string(saved_path()).ok().and_then(|t| serde_json::from_str::<SavedWindow>(&t).ok()) else { return };
        let monitors: Vec<(i32, i32, u32, u32)> = window.available_monitors().unwrap_or_default().iter().map(|m| (m.position().x, m.position().y, m.size().width, m.size().height)).collect();
        let Some(saved) = usable_saved(saved, &monitors) else { return };
        let _ = window.set_size(tauri::PhysicalSize::new(saved.w, saved.h));
        let _ = window.set_position(tauri::PhysicalPosition::new(saved.x, saved.y));
        if saved.maximized {
            let _ = window.maximize();
        }
    }

    /// Keeps the cockpit window's size and place as it changes (a moment after the last change, so a drag writes once).
    fn remember_window(window: &tauri::WebviewWindow) {
        static LATEST: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let w = window.clone();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)) {
                return;
            }
            let mine = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
            let w = w.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                if LATEST.load(Ordering::SeqCst) != mine || w.is_minimized().unwrap_or(false) {
                    return;
                }
                let maximized = w.is_maximized().unwrap_or(false);
                let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
                let mut saved = SavedWindow { x: pos.x, y: pos.y, w: size.width, h: size.height, maximized };
                if maximized {
                    // Keep the size it had before it was maximised.
                    if let Some(old) = std::fs::read_to_string(saved_path()).ok().and_then(|t| serde_json::from_str::<SavedWindow>(&t).ok()) {
                        saved = SavedWindow { maximized: true, ..old };
                    }
                }
                if let Ok(text) = serde_json::to_string(&saved) {
                    let _ = std::fs::write(saved_path(), text);
                }
            });
        });
    }

    fn show(window: &tauri::WebviewWindow, focus: bool) {
        let _ = window.unminimize();
        let _ = window.show();
        if focus {
            let _ = window.set_focus();
        }
    }

    /// Open the Settings window, or show the one that exists. `focus` is true when a person asked
    /// for it (tray click, second launch).
    pub fn open_settings_window(app: &AppHandle, tab: Option<&str>, focus: bool) {
        let app = app.clone();
        let tab = tab.map(str::to_string);
        std::thread::spawn(move || {
            if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
                show(&window, focus);
                // The window was hidden, not destroyed: tell it to reload its state and go to `tab`.
                let _ = tauri::Emitter::emit_to(&app, SETTINGS_LABEL, "settings://show", serde_json::json!({ "tab": tab }));
                return;
            }
            let mut builder = WebviewWindowBuilder::new(&app, SETTINGS_LABEL, WebviewUrl::App(settings_url(tab.as_deref()).into()))
                .title(SETTINGS_TITLE)
                .inner_size(1100.0, 760.0)
                .min_inner_size(720.0, 480.0)
                .resizable(true)
                .focused(focus);
            if let Some((x, y)) = next_position(&app) {
                builder = builder.position(x, y);
            }
            match builder.build() {
                Ok(window) => {
                    show(&window, focus);
                    tracing::info!("settings window opened");
                }
                Err(e) => tracing::warn!(error = %e, "settings window failed to open"),
            }
        });
    }

    /// Opens one artifact in its own window (or brings that window to the front). The window only shows the page and its
    /// own tools (Point, Share); the chat and the app stay where they are.
    pub fn open_artifact_window(app: &AppHandle, pane_id: &str, id: &str, title: &str) -> Result<(), String> {
        let label = artifact_label(id).ok_or_else(|| "That page id is not valid.".to_string())?;
        let (app, pane_id, id, title) = (app.clone(), pane_id.to_string(), id.to_string(), title.to_string());
        std::thread::spawn(move || {
            if let Some(window) = app.get_webview_window(&label) {
                show(&window, true);
                return;
            }
            let title = if title.trim().is_empty() { id.clone() } else { title.chars().take(80).collect() };
            let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(artifact_url(&pane_id, &id).into()))
                .title(title)
                .inner_size(960.0, 720.0)
                .min_inner_size(480.0, 360.0)
                .resizable(true)
                .focused(true);
            if let Some((x, y)) = next_position(&app) {
                builder = builder.position(x, y);
            }
            match builder.build() {
                Ok(window) => show(&window, true),
                Err(e) => tracing::warn!(error = %e, "artifact window failed to open"),
            }
        });
        Ok(())
    }

    /// Opens one tab of a pane (its chat, or a file) in its own window, or brings that window to the front. The window
    /// shows the same pane live: no second agent starts. When it closes, `tabwin://closed` tells the cockpit.
    pub fn open_tab_window(app: &AppHandle, pane_id: &str, tab: &str, title: &str) -> Result<(), String> {
        let label = tab_label(pane_id, tab).ok_or_else(|| "That tab cannot open in a window.".to_string())?;
        let (app, pane_id, tab, title) = (app.clone(), pane_id.to_string(), tab.to_string(), title.to_string());
        std::thread::spawn(move || {
            if let Some(window) = app.get_webview_window(&label) {
                show(&window, true);
                return;
            }
            let title = if title.trim().is_empty() { "Potato Workspace".to_string() } else { title.chars().take(80).collect() };
            let (event_app, event_pane, event_tab) = (app.clone(), pane_id.clone(), tab.clone());
            let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(tab_url(&pane_id, &tab).into()))
                .title(title)
                .inner_size(960.0, 720.0)
                .min_inner_size(480.0, 360.0)
                .resizable(true)
                .focused(true);
            if let Some((x, y)) = next_position(&app) {
                builder = builder.position(x, y);
            }
            match builder.build() {
                Ok(window) => {
                    window.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            let _ = tauri::Emitter::emit(&event_app, TAB_CLOSED_EVENT, serde_json::json!({ "paneId": event_pane, "tab": event_tab }));
                        }
                    });
                    show(&window, true);
                }
                Err(e) => tracing::warn!(error = %e, "tab window failed to open"),
            }
        });
        Ok(())
    }

    /// Closes a tab's window (the "Put back" button). The close tells the cockpit through `tabwin://closed`.
    pub fn close_tab_window(app: &AppHandle, pane_id: &str, tab: &str) {
        if let Some(window) = tab_label(pane_id, tab).and_then(|label| app.get_webview_window(&label)) {
            let _ = window.close();
        }
    }

    /// Build the cockpit window at `url`. False when it could not be created.
    fn build_cockpit_window(app: &AppHandle, url: String, focus: bool) -> bool {
        let mut builder = WebviewWindowBuilder::new(app, COCKPIT_LABEL, WebviewUrl::App(url.into()))
            .title(COCKPIT_TITLE)
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 560.0)
            .resizable(true)
            .focused(focus);
        if let Some((x, y)) = next_position(app) {
            builder = builder.position(x, y);
        }
        match builder.build() {
            Ok(window) => {
                restore_saved(&window);
                remember_window(&window);
                show(&window, focus);
                tracing::info!("cockpit window opened");
                true
            }
            Err(e) => {
                tracing::warn!(error = %e, "cockpit window failed to open");
                false
            }
        }
    }

    /// Orchestration mode: show Settings INSIDE the cockpit (its inline view), on `tab` when given. The
    /// separate Settings window is hidden if it is up, so a person never sees two Settings surfaces. A new
    /// cockpit window carries the request in its URL; an existing one is told with `cockpit://settings`.
    pub fn open_cockpit_settings(app: &AppHandle, tab: Option<&str>) {
        use tauri::Emitter;
        let app = app.clone();
        let tab = tab.map(str::to_string);
        std::thread::spawn(move || {
            hide_settings_window(&app);
            let payload = serde_json::json!({ "tab": tab });
            if let Some(window) = app.get_webview_window(COCKPIT_LABEL) {
                show(&window, true);
                let _ = app.emit("cockpit://settings", payload);
                return;
            }
            if !build_cockpit_window(&app, cockpit_settings_url(tab.as_deref()), true) && app.get_webview_window(COCKPIT_LABEL).is_some() {
                // Another request created the window a moment ago; its page may not be listening yet.
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let _ = app.emit("cockpit://settings", payload);
            }
        });
    }

    /// Hide the Settings window if there is one (it is hidden, never destroyed, so it reloads fast next time).
    pub fn hide_settings_window(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
            let _ = window.hide();
        }
    }

    /// The mode switched to Orchestration: if the Settings window is on screen, ask it to move into the cockpit
    /// (it knows which page it shows). Nothing happens for a hidden or missing window. Returns whether it asked.
    pub fn ask_settings_to_move_inline(app: &AppHandle) -> bool {
        match app.get_webview_window(SETTINGS_LABEL) {
            Some(window) if window.is_visible().unwrap_or(false) => {
                let _ = tauri::Emitter::emit_to(app, SETTINGS_LABEL, "settings://to-inline", serde_json::json!({}));
                true
            }
            _ => false,
        }
    }

    /// Open the cockpit window, or show the one that exists (unminimized). `select` also selects that
    /// pane (`cockpit://select`). `focus` is true when a person asked for it.
    pub fn open_cockpit_window(app: &AppHandle, select: Option<&str>, focus: bool) {
        use tauri::Emitter;
        let app = app.clone();
        let select = select.map(str::to_string);
        std::thread::spawn(move || {
            let mut created = false;
            if let Some(window) = app.get_webview_window(COCKPIT_LABEL) {
                show(&window, focus);
            } else if build_cockpit_window(&app, cockpit_url(select.as_deref()), focus) {
                created = true;
            } else {
                return;
            }
            if let Some(pane_id) = select {
                if created {
                    // The page is still loading; the URL carries the selection, this covers a
                    // listener that is already up.
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                }
                let _ = app.emit("cockpit://select", serde_json::json!({ "pane_id": pane_id }));
            }
        });
    }

    /// Hide the cockpit (individual mode); its panes keep running.
    pub fn hide_cockpit_window(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(COCKPIT_LABEL) {
            let _ = window.hide();
        }
    }

    /// Destroy every pop-out pane window WITHOUT touching the panes. `destroy` skips the close
    /// request, so the "closing a pop-out kills its pane" hook never runs. Returns how many.
    pub fn destroy_pane_windows(app: &AppHandle) -> usize {
        let labels: Vec<String> =
            app.webview_windows().keys().filter(|l| l.starts_with("detached-pane-")).cloned().collect();
        let mut destroyed = 0;
        for label in labels {
            if let Some(window) = app.get_webview_window(&label) {
                if window.destroy().is_ok() {
                    destroyed += 1;
                }
            }
        }
        destroyed
    }

    /// Open (or show) the pop-out window of a pane. Does not take focus unless `focus`. A hidden
    /// warm window (Preload) is placed like a new one and shown: that is the whole cost of a claim.
    pub fn open_pane_window(app: &AppHandle, pane_id: &str, agent: &str, cols: u16, rows: u16, focus: bool) {
        let label = crate::pane_windows::window_label(pane_id);
        let existing = app.get_webview_window(&label);
        let visible = existing.as_ref().map(|w| w.is_visible().unwrap_or(true)).unwrap_or(false);
        match (open_plan(existing.is_some(), visible), existing) {
            (OpenPlan::Show, Some(window)) => show(&window, focus),
            (OpenPlan::PlaceAndShow, Some(window)) => {
                if let Some((x, y)) = next_position(app) {
                    let _ = crate::window_layout::own_window::set_position(&window, tauri::LogicalPosition::new(x, y));
                }
                show(&window, focus);
                tracing::info!(pane = %pane_id, focus, "warm pane window shown");
            }
            _ => build_pane_window(app, &label, pane_id, agent, cols, rows, PaneWindowOpts { focus, ..PaneWindowOpts::default() }),
        }
    }

    /// The animated switch: create the pop-out of a pane HIDDEN at `placement`, so it loads while the motion plays.
    /// A hidden window that exists (a warm one) is moved there; a visible one is left alone.
    pub fn open_pane_window_hidden(app: &AppHandle, pane_id: &str, agent: &str, cols: u16, rows: u16, placement: PanePlacement) {
        let label = crate::pane_windows::window_label(pane_id);
        match app.get_webview_window(&label) {
            Some(window) => {
                if !window.is_visible().unwrap_or(true) {
                    if let Some((x, y)) = placement.pos {
                        let _ = crate::window_layout::own_window::set_position(&window, tauri::LogicalPosition::new(x, y));
                    }
                    if let Some(phys) = placement.phys {
                        fit_outer(&window, phys);
                    }
                }
            }
            None => build_pane_window(app, &label, pane_id, agent, cols, rows, PaneWindowOpts { hidden: true, placement: Some(placement), ..PaneWindowOpts::default() }),
        }
    }

    /// The end of an animated switch: show a pop-out made hidden by `open_pane_window_hidden` (never moved, never
    /// focused). If it does not exist (the switch was cut short), build it now at its planned place.
    pub fn show_pop_out(app: &AppHandle, pane_id: &str, agent: &str, cols: u16, rows: u16, placement: Option<PanePlacement>) {
        let label = crate::pane_windows::window_label(pane_id);
        match app.get_webview_window(&label) {
            Some(window) => show(&window, false),
            None => build_pane_window(app, &label, pane_id, agent, cols, rows, PaneWindowOpts { placement, ..PaneWindowOpts::default() }),
        }
    }

    /// The outer rect of a window in physical screen pixels `(x, y, w, h)`.
    pub fn outer_rect(window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
        let pos = window.outer_position().ok()?;
        let size = window.outer_size().ok()?;
        Some((f64::from(pos.x), f64::from(pos.y), f64::from(size.width), f64::from(size.height)))
    }

    /// Put a window's OUTER rect (frame included) exactly on `phys` (physical screen px): position first, then the
    /// inner size that makes the outer size match. Physical on purpose: a logical position is converted with one
    /// monitor's scale, which is wrong on a window headed for another.
    fn fit_outer(window: &tauri::WebviewWindow, (x, y, w, h): (f64, f64, f64, f64)) {
        let _ = crate::window_layout::own_window::set_position(&window, tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        let frame = match (window.outer_size(), window.inner_size()) {
            (Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
            _ => (0, 0),
        };
        let (iw, ih) = crate::window_layout::inner_for_outer((w, h), frame);
        let _ = crate::window_layout::own_window::set_size(&window, tauri::PhysicalSize::new(iw, ih));
    }

    /// Create the hidden window of a warm worker. Nothing is shown and nothing is placed yet.
    pub fn open_warm_pane_window(app: &AppHandle, pane_id: &str, agent: &str, cols: u16, rows: u16) {
        // Orchestration shows panes in the cockpit: a pop-out would only ever be destroyed on claim.
        if crate::ui_mode::current() == crate::ui_mode::UiMode::Orchestration {
            return;
        }
        let label = crate::pane_windows::window_label(pane_id);
        if app.get_webview_window(&label).is_none() {
            build_pane_window(app, &label, pane_id, agent, cols, rows, PaneWindowOpts { warm: true, ..PaneWindowOpts::default() });
        }
    }

    /// Destroy the window of a warm worker that is shut down unused (a window already shown belongs
    /// to a run and is left to the normal pane-removed sweep).
    pub fn close_warm_pane_window(app: &AppHandle, pane_id: &str) {
        let label = crate::pane_windows::window_label(pane_id);
        if let Some(window) = app.get_webview_window(&label) {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.destroy();
            }
        }
    }

    /// How `build_pane_window` differs from "a normal pop-out, placed next in the cascade, shown, no focus".
    #[derive(Default)]
    struct PaneWindowOpts {
        focus: bool,
        /// Preload's hidden, unplaced window (its page knows its pane is not listed yet).
        warm: bool,
        /// Created hidden (placed): the animated switch shows it when the motion ends.
        hidden: bool,
        /// Place it here instead of taking the next cascade slot.
        placement: Option<PanePlacement>,
    }

    fn build_pane_window(app: &AppHandle, label: &str, pane_id: &str, agent: &str, cols: u16, rows: u16, opts: PaneWindowOpts) {
        let warm = opts.warm;
        let (w, h) = opts.placement.map_or_else(|| pane_window_size(cols, rows), |p| p.size);
        let title = crate::ambient::window_title(agent, pane_id, crate::ambient::store::get(pane_id).as_deref());
        let url = sized_url(&if warm { warm_pane_url(pane_id) } else { pane_url(pane_id) });
        let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(w, h)
            .min_inner_size(260.0, 140.0)
            .resizable(true)
            .focused(opts.focus && !warm && !opts.hidden)
            .visible(visible_at_build(warm, opts.hidden, opts.placement.and_then(|p| p.phys).is_some()));
        if !warm {
            if let Some((x, y)) = opts.placement.and_then(|p| p.pos).or_else(|| next_position(app)) {
                builder = builder.position(x, y);
            }
        }
        match builder.build() {
            Ok(window) => {
                if let Some(phys) = opts.placement.and_then(|p| p.phys).filter(|_| !warm) {
                    // The exact rect is applied while the window is still hidden; only then is it shown.
                    fit_outer(&window, phys);
                    if !opts.hidden {
                        let _ = window.show();
                        if opts.focus {
                            let _ = window.set_focus();
                        }
                    }
                }
                tracing::info!(pane = %pane_id, warm, hidden = opts.hidden, "pane window opened");
            }
            Err(e) => tracing::warn!(pane = %pane_id, warm, error = %e, "pane window failed to open"),
        }
    }

    /// The standalone worker host (`--worker`) window, label `main` (the frontend routes it to the
    /// worker-host bootstrap). Only created in worker mode; the normal app's window is the cockpit or Settings.
    pub fn open_worker_host_window(app: &AppHandle) {
        if app.get_webview_window("main").is_some() {
            return;
        }
        let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Potato Workspace")
            .inner_size(1000.0, 700.0)
            .resizable(true)
            .build();
        if let Err(e) = built {
            tracing::warn!(error = %e, "worker host window failed to open");
        }
    }

    /// Closing the Settings window only hides it. The main window's X quits the app (asking first when an agent is
    /// working), unless the person chose "Keep running in the tray" (`close_to_tray`): then it hides, as before.
    pub fn on_close_requested(app: &AppHandle, label: &str) -> bool {
        let close_to_tray = crate::settings_store::read_public_settings(app).get("close_to_tray").and_then(|v| v.as_bool()).unwrap_or(false);
        match main_close_action(label, close_to_tray) {
            MainClose::PassThrough => false,
            MainClose::HideToTray => {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.hide();
                }
                true
            }
            MainClose::AskToQuit => {
                crate::pane_windows::request_quit(app);
                true
            }
        }
    }
}

pub use runtime::{
    ask_settings_to_move_inline, close_warm_pane_window, current_anchor, destroy_pane_windows, hide_cockpit_window, on_close_requested, open_cockpit_settings, open_cockpit_window, open_pane_window,
    open_artifact_window, open_tab_window, close_tab_window, open_pane_window_hidden, open_settings_window, open_warm_pane_window, open_worker_host_window, outer_rect, peek_slot, reserve_slots, show_pop_out,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_window_comes_back_only_onto_a_screen_that_exists() {
        let screens = [(0, 0, 1920, 1080)];
        let ok = SavedWindow { x: 100, y: 50, w: 1900, h: 1009, maximized: false };
        assert_eq!(usable_saved(ok, &screens), Some(ok));
        // The second screen is gone: its corner is off every screen.
        assert_eq!(usable_saved(SavedWindow { x: 2500, ..ok }, &screens), None);
        // Bigger than the screen it is on, or tiny: not trusted.
        assert_eq!(usable_saved(SavedWindow { w: 4000, ..ok }, &screens), None);
        assert_eq!(usable_saved(SavedWindow { w: 100, ..ok }, &screens), None);
    }

    #[test]
    fn the_main_window_x_quits_unless_close_to_tray_is_on() {
        assert_eq!(main_close_action(COCKPIT_LABEL, false), MainClose::AskToQuit);
        assert_eq!(main_close_action(COCKPIT_LABEL, true), MainClose::HideToTray);
        assert_eq!(main_close_action(SETTINGS_LABEL, false), MainClose::HideToTray);
        assert_eq!(main_close_action("detached-pane-1", false), MainClose::PassThrough);
    }

    #[test]
    fn settings_url_defaults_to_the_agents_tab_and_rejects_odd_tab_names() {
        assert_eq!(settings_url(None), "index.html?settings=1&tab=agents");
        assert_eq!(settings_url(Some("mcp")), "index.html?settings=1&tab=mcp");
        assert_eq!(settings_url(Some("a&b=c")), "index.html?settings=1&tab=agents");
        assert_eq!(settings_url(Some("")), "index.html?settings=1&tab=agents");
    }

    #[test]
    fn cockpit_settings_url_is_the_cockpit_route_not_the_settings_window_route() {
        assert_eq!(cockpit_settings_url(None), "index.html?cockpit=1&view=settings");
        assert_eq!(cockpit_settings_url(Some("bridge")), "index.html?cockpit=1&view=settings&tab=bridge");
        // `settings=1` would make main.tsx render the standalone Settings window instead of the cockpit.
        assert!(!cockpit_settings_url(Some("agents")).contains("settings=1"));
        // Anything that is not a plain page id is dropped, like `settings_url`.
        assert_eq!(cockpit_settings_url(Some("a&b=c")), "index.html?cockpit=1&view=settings");
        assert_eq!(cockpit_settings_url(Some("  ")), "index.html?cockpit=1&view=settings");
    }

    #[test]
    fn cockpit_url_matches_the_frontend_route() {
        assert_eq!(cockpit_url(None), "index.html?cockpit=1");
        assert_eq!(cockpit_url(Some("")), "index.html?cockpit=1");
        assert_eq!(cockpit_url(Some("a b")), "index.html?cockpit=1&select=a%20b");
        assert_eq!(COCKPIT_LABEL, "cockpit");
    }

    #[test]
    fn anchors_parse_from_dev_env_and_settings_file() {
        assert_eq!(parse_anchor("-1660,60"), Some((-1660.0, 60.0)));
        assert_eq!(parse_anchor(" 10 , 20.5 "), Some((10.0, 20.5)));
        assert_eq!(parse_anchor("10"), None);
        assert_eq!(parse_anchor("a,b"), None);
        let file = serde_json::json!({"settings": {"pane_window_position": {"x": -100, "y": 5}}});
        assert_eq!(anchor_from_settings(&file), Some((-100.0, 5.0)));
        assert_eq!(anchor_from_settings(&serde_json::json!({"settings": {}})), None);
        assert_eq!(anchor_from_settings(&serde_json::json!({"settings": {"pane_window_position": {"x": 1}}})), None);
    }

    #[test]
    fn anchor_priority_is_dev_then_setting_then_primary() {
        let (d, s, p) = (Some((1.0, 1.0)), Some((2.0, 2.0)), Some((3.0, 3.0)));
        assert_eq!(resolve_anchor(d, s, p), d);
        assert_eq!(resolve_anchor(None, s, p), s);
        assert_eq!(resolve_anchor(None, None, p), p);
        assert_eq!(resolve_anchor(None, None, None), None);
    }

    #[test]
    fn cascade_offsets_each_window_and_wraps() {
        let anchor = (-1660.0, 60.0);
        assert_eq!(cascade_position(anchor, 0), (-1620.0, 120.0));
        assert_eq!(cascade_position(anchor, 1), (-1592.0, 148.0));
        assert_eq!(cascade_position(anchor, CASCADE_SLOTS), cascade_position(anchor, 0));
        let all: std::collections::HashSet<_> =
            (0..CASCADE_SLOTS).map(|i| format!("{:?}", cascade_position(anchor, i))).collect();
        assert_eq!(all.len(), CASCADE_SLOTS);
    }

    #[test]
    fn a_window_with_an_exact_rect_is_built_hidden_and_shown_after_the_fit() {
        assert!(!visible_at_build(false, false, true), "rect first, then show");
        assert!(visible_at_build(false, false, false), "cascade windows open as before");
        assert!(!visible_at_build(false, true, true) && !visible_at_build(true, false, false));
    }

    #[test]
    fn rust_built_windows_tell_the_page_not_to_resize_itself() {
        assert_eq!(sized_url(&pane_url("p1")), "index.html?terminal=1&pane=p1&detached=1&sized=1");
        assert_eq!(sized_url(&warm_pane_url("p1")), "index.html?terminal=1&pane=p1&detached=1&warm=1&sized=1");
    }

    #[test]
    fn pane_url_matches_the_frontend_route() {
        assert_eq!(pane_url("abc-123"), "index.html?terminal=1&pane=abc-123&detached=1");
        assert_eq!(pane_url("a b/c"), "index.html?terminal=1&pane=a%20b%2Fc&detached=1");
    }

    #[test]
    fn an_artifact_window_has_its_own_route_and_a_label_the_capability_matches() {
        assert_eq!(artifact_url("a b", "plan-1"), "index.html?artifactwin=1&pane=a%20b&id=plan-1");
        assert_eq!(artifact_label("plan-1").as_deref(), Some("artifact-window-plan-1"));
        for bad in ["", "A", "a b", "a/b", "../x", &"x".repeat(49)] {
            assert_eq!(artifact_label(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_tab_window_has_its_own_route_and_a_label_the_capability_matches() {
        assert_eq!(tab_url("p 1", "chat"), "index.html?tabwin=1&pane=p%201&tab=chat");
        assert_eq!(tab_url("p1", "file:src/a.ts"), "index.html?tabwin=1&pane=p1&tab=file%3Asrc%2Fa.ts");
        assert_eq!(tab_label("p1", "chat").as_deref(), Some("tab-window-p1-chat"));
        let a = tab_label("p1", "file:src/a.ts").unwrap();
        assert!(a.starts_with("tab-window-p1-f") && a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "{a}");
        assert_ne!(a, tab_label("p1", "file:src/b.ts").unwrap(), "one file, one window");
        assert_eq!(a, tab_label("p1", "file:src/a.ts").unwrap(), "the same file always has the same window");
        assert_eq!(tab_label("p/1:x", "chat").as_deref(), Some("tab-window-p_1_x-chat"));
    }

    #[test]
    fn only_the_chat_and_a_plain_file_path_open_in_a_tab_window() {
        assert_eq!(parse_tab("chat"), Some(TabKind::Chat));
        assert_eq!(parse_tab("file:a/b.txt"), Some(TabKind::File("a/b.txt".into())));
        for bad in ["", "terminal", "changes", "file:", "file:../x", "file:a/../x", "file:/abs", "file:a//b", "file:a\\..\\b", "chat2"] {
            assert_eq!(parse_tab(bad), None, "{bad}");
            assert_eq!(tab_label("p1", bad), None, "{bad}");
        }
        assert_eq!(tab_label("", "chat"), None);
        assert_eq!(tab_label(&"x".repeat(97), "chat"), None);
    }

    #[test]
    fn warm_windows_use_the_pane_route_with_a_warm_flag() {
        assert_eq!(warm_pane_url("abc-123"), "index.html?terminal=1&pane=abc-123&detached=1&warm=1");
    }

    #[test]
    fn claiming_a_warm_pane_places_and_shows_its_hidden_window_instead_of_building_one() {
        assert_eq!(open_plan(false, false), OpenPlan::Create);
        assert_eq!(open_plan(true, false), OpenPlan::PlaceAndShow, "hidden warm window: show only");
        assert_eq!(open_plan(true, true), OpenPlan::Show);
    }

    #[test]
    fn a_placement_is_the_cascade_slot_and_the_grid_size() {
        let anchor = Some((-1660.0, 60.0));
        let p = pane_placement(anchor, 1, 120, 30);
        assert_eq!(p.pos, Some(cascade_position((-1660.0, 60.0), 1)));
        assert_eq!(p.size, pane_window_size(120, 30));
        assert_eq!(pane_placement(None, 3, 120, 30).pos, None, "no anchor: the OS chooses");
    }

    #[test]
    fn a_planned_run_matches_opening_the_panes_one_by_one() {
        let anchor = Some((10.0, 20.0));
        let grids = [(120, 30), (80, 24), (0, 0), (200, 50)];
        let plan = plan_placements(anchor, 5, &grids);
        for (i, (cols, rows)) in grids.iter().enumerate() {
            assert_eq!(plan[i], pane_placement(anchor, 5 + i, *cols, *rows), "pane {i}");
        }
        // The cascade wraps like it does for single opens.
        let wrapped = plan_placements(anchor, CASCADE_SLOTS - 1, &[(120, 30), (120, 30)]);
        assert_eq!(wrapped[1].pos, pane_placement(anchor, CASCADE_SLOTS, 120, 30).pos);
        assert_eq!(wrapped[1].pos, pane_placement(anchor, 0, 120, 30).pos);
    }

    #[test]
    fn a_placement_in_physical_pixels_scales_position_and_size() {
        let p = pane_placement(Some((100.0, 50.0)), 0, 120, 30);
        let (x, y, w, h) = placement_physical(&p, 1.5).unwrap();
        assert_eq!((x, y), ((100.0 + CASCADE_ORIGIN.0) * 1.5, (50.0 + CASCADE_ORIGIN.1) * 1.5));
        assert_eq!((w, h), (870.0 * 1.5, 480.0 * 1.5));
        assert_eq!(placement_physical(&pane_placement(None, 0, 120, 30), 1.5), None);
        // A broken scale factor does not zero the rect.
        assert_eq!(placement_physical(&p, 0.0).unwrap().2, 870.0);
    }

    #[test]
    fn pane_window_size_follows_the_grid_with_a_floor() {
        assert_eq!(pane_window_size(120, 30), (870.0, 480.0));
        assert_eq!(pane_window_size(0, 0), (870.0, 512.0));
        assert_eq!(pane_window_size(10, 2), (260.0, 140.0));
    }
}
