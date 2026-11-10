//! The Tauri side of the animated mode switch: the overlay window, the two stages (to Individual, back to
//! Orchestration) and the events. Pure rules and the sequence live in `super`; nothing here runs in unit tests
//! (no window may open there).

use super::*;
use crate::app_windows::{self, PanePlacement, COCKPIT_LABEL};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// ---------------------------------------------------------------- the overlay window

/// The overlay: transparent, undecorated, always on top, out of the taskbar, never focused, over one monitor.
/// Created hidden once (at start) and reused, so the first switch has no startup lag.
fn ensure_overlay(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App(OVERLAY_URL.into()))
        .title("Potato Workspace switch overlay")
        .inner_size(200.0, 200.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Deliberately NOT click-through: set_ignore_cursor_events adds WS_EX_LAYERED, which made the transparent window
    // opaque. It lives under a second and is hidden right after the handoff, so a stray click is swallowed at worst.
    // It never takes focus (focused(false), focusable(false), no set_focus anywhere).
    Ok(window)
}

/// Startup: build the hidden overlay on its own thread (a webview build must not block setup).
pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = ensure_overlay(&app) {
            tracing::warn!(error = %e, "switch overlay could not be created");
        }
    });
}

fn place_overlay(window: &WebviewWindow, monitor: &Monitor) {
    let _ = window.set_position(PhysicalPosition::new(monitor.x as i32, monitor.y as i32));
    let _ = window.set_size(PhysicalSize::new(monitor.w.max(1.0) as u32, monitor.h.max(1.0) as u32));
}

/// Cover `monitor` and show. Placed twice: a monitor with another scale factor may resize the window when it lands on it.
fn show_overlay(app: &AppHandle, monitor: &Monitor) -> bool {
    let Ok(window) = ensure_overlay(app) else { return false };
    place_overlay(&window, monitor);
    if window.show().is_err() {
        return false;
    }
    let _ = window.set_always_on_top(true);
    // Placed a second time a beat later (another scale factor may resize it), without holding the first frame back.
    let (again, monitor) = (window.clone(), *monitor);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(40));
        place_overlay(&again, &monitor);
    });
    true
}

/// Clear what the overlay drew and hide it.
fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = app.emit_to(OVERLAY_LABEL, OVERLAY_CANCEL_EVENT, json!({}));
        let _ = window.hide();
    }
}

/// The real windows are shown while the overlay still covers them; it leaves a beat later, once they have painted,
/// so there is neither a gap (a blank window under a vanished proxy) nor two things on screen at different places
/// (the proxies already sit exactly where the windows are).
fn hand_off_from_overlay(app: &AppHandle, outcome: Outcome) {
    if overlay_was_drawing(outcome) {
        std::thread::sleep(Duration::from_millis(OVERLAY_HANDOFF_MS));
    }
    hide_overlay(app);
}

// ---------------------------------------------------------------- windows read

fn monitor_of(window: &WebviewWindow) -> Option<Monitor> {
    let m = window.current_monitor().ok().flatten()?;
    Some(Monitor { x: f64::from(m.position().x), y: f64::from(m.position().y), w: f64::from(m.size().width), h: f64::from(m.size().height), scale: m.scale_factor() })
}

fn primary_monitor(app: &AppHandle) -> Option<Monitor> {
    let m = app.primary_monitor().ok().flatten()?;
    Some(Monitor { x: f64::from(m.position().x), y: f64::from(m.position().y), w: f64::from(m.size().width), h: f64::from(m.size().height), scale: m.scale_factor() })
}

fn panes_with_windows(app: &AppHandle) -> Vec<crate::pty::PaneInfo> {
    crate::cockpit::panes_for_switch(app)
}

fn window_state(app: &AppHandle) -> WindowState {
    let cockpit = app.get_webview_window(COCKPIT_LABEL);
    let panes = panes_with_windows(app);
    let visible_pop_outs = panes
        .iter()
        .filter(|p| app.get_webview_window(&crate::pane_windows::window_label(&p.id)).is_some_and(|w| w.is_visible().unwrap_or(false)))
        .count();
    WindowState {
        cockpit_exists: cockpit.is_some(),
        cockpit_visible: cockpit.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false)),
        cockpit_minimized: cockpit.as_ref().is_some_and(|w| w.is_minimized().unwrap_or(false)),
        visible_pop_outs,
        panes: panes.len(),
    }
}

/// Whether the switch to `mode` plays the motion right now. Call it once the previous switch has settled (inside a turn).
pub fn can_animate(app: &AppHandle, mode: UiMode) -> bool {
    should_animate(mode, &window_state(app))
}

/// `plan_mode_switch`: where each pane's pop-out would open if the switch happened now, and the mini bar. Takes no cascade slot.
pub fn plan(app: &AppHandle) -> Plan {
    let panes: Vec<PaneGrid> = panes_with_windows(app).into_iter().map(|p| PaneGrid { id: p.id, cols: p.cols, rows: p.rows }).collect();
    let monitor = app.get_webview_window(COCKPIT_LABEL).and_then(|w| monitor_of(&w)).or_else(|| primary_monitor(app));
    let scale = primary_monitor(app).map_or(1.0, |m| m.scale);
    let windows = plan_windows(
        crate::window_layout::current_layout(),
        crate::window_layout::cockpit_work_area(app),
        app_windows::current_anchor(app),
        app_windows::peek_slot(),
        scale,
        &panes,
    );
    Plan { windows, mini_bar: monitor.as_ref().map(mini_bar_rect), monitor }
}

fn emit_prepare(app: &AppHandle, gen: u64, direction: &str, style: AnimStyle, monitor: &Monitor, windows: &[WindowRect], mini_bar: Option<Rect>) {
    let origin = app
        .get_webview_window(COCKPIT_LABEL)
        .and_then(|w| w.inner_position().ok())
        .map_or((monitor.x, monitor.y), |p| (f64::from(p.x), f64::from(p.y)));
    let _ = app.emit_to(
        COCKPIT_LABEL,
        SWITCH_EVENT,
        json!({
            "phase": "prepare", "gen": gen, "direction": direction, "style": style.as_str(),
            "monitor": monitor, "origin": { "x": origin.0, "y": origin.1 }, "windows": windows, "miniBar": mini_bar,
        }),
    );
}

fn emit_finish(app: &AppHandle, gen: u64) {
    let _ = app.emit_to(COCKPIT_LABEL, SWITCH_EVENT, json!({ "phase": "finish", "gen": gen }));
    // The mode may have changed again since this switch started (a newer one cancelled it): say what is true now.
    let _ = app.emit("ui://mode-changed", json!({ "mode": crate::ui_mode::current().as_str() }));
}

fn start_overlay_run(app: &AppHandle, gen: u64, direction: &str, monitor: &Monitor, mini_bar: Option<Rect>, begin: &Begin) {
    if !show_overlay(app, monitor) {
        return;
    }
    let mut spec = begin.spec.clone();
    if let Some(obj) = spec.as_object_mut() {
        obj.insert("gen".into(), json!(gen));
        obj.insert("direction".into(), json!(direction));
        obj.insert("monitor".into(), json!(monitor));
        obj.insert("miniBar".into(), json!(mini_bar));
        obj.insert("totalMs".into(), json!(begin.total_ms));
    }
    let _ = app.emit_to(OVERLAY_LABEL, OVERLAY_RUN_EVENT, spec);
}

// ---------------------------------------------------------------- to Individual

struct PlannedPane {
    pane: crate::pty::PaneInfo,
    placement: Option<PanePlacement>,
}

struct ToIndividual {
    app: AppHandle,
    gen: u64,
    style: AnimStyle,
    panes: Vec<PlannedPane>,
    monitor: Option<Monitor>,
    mini_bar: Option<Rect>,
    /// The pop-outs being created hidden while the motion plays.
    creating: Background,
}

impl ToIndividual {
    fn new(app: &AppHandle, gen: u64, style: AnimStyle) -> Self {
        let panes = panes_with_windows(app).into_iter().map(|pane| PlannedPane { pane, placement: None }).collect();
        ToIndividual { app: app.clone(), gen, style, panes, monitor: None, mini_bar: None, creating: Background::default() }
    }
}

impl Stage for ToIndividual {
    fn direction(&self) -> &'static str {
        "individual"
    }

    fn style(&self) -> Option<AnimStyle> {
        Some(self.style)
    }

    fn announce(&mut self) -> bool {
        let app = self.app.clone();
        // The mini bar sits on the monitor the cockpit is on: read it before anything moves.
        crate::mini_bar::remember_cockpit_monitor(&app);
        let Some(monitor) = app.get_webview_window(COCKPIT_LABEL).and_then(|w| monitor_of(&w)).or_else(|| primary_monitor(&app)) else { return false };
        if self.panes.is_empty() {
            return false;
        }
        // Plan every pop-out first, from the pure layout (no window needed): the cockpit gets the rects at once.
        let first = app_windows::reserve_slots(self.panes.len());
        let grids: Vec<(u16, u16)> = self.panes.iter().map(|p| (p.pane.cols, p.pane.rows)).collect();
        let scale = primary_monitor(&app).map_or(1.0, |m| m.scale);
        let mut windows: Vec<WindowRect> = Vec::new();
        for (planned, placement) in self.panes.iter_mut().zip(crate::window_layout::switch_placements(&app, first, &grids)) {
            planned.placement = Some(placement);
            if let Some(r) = app_windows::placement_physical(&placement, scale) {
                windows.push(WindowRect { id: planned.pane.id.clone(), rect: r.into() });
            }
        }
        let mini_bar = Some(mini_bar_rect(&monitor));
        self.monitor = Some(monitor);
        self.mini_bar = mini_bar;
        emit_prepare(&app, self.gen, "individual", self.style, &monitor, &windows, mini_bar);
        // The pop-outs are created hidden in parallel with the flight (a webview takes a long time to build); the
        // motion does not wait for them, and `finish` joins this before showing them.
        let todo: Vec<(crate::pty::PaneInfo, PanePlacement)> = self.panes.iter().filter_map(|p| p.placement.map(|pl| (p.pane.clone(), pl))).collect();
        self.creating = Background::spawn(move || {
            for (pane, placement) in &todo {
                app_windows::open_pane_window_hidden(&app, &pane.id, &pane.agent_type, pane.cols, pane.rows, *placement);
            }
        });
        true
    }

    fn start_overlay(&mut self, begin: &Begin) {
        if let Some(monitor) = self.monitor {
            start_overlay_run(&self.app, self.gen, "individual", &monitor, self.mini_bar, begin);
        }
    }

    fn after_ready(&mut self) {}

    fn finish(&mut self, outcome: Outcome) {
        tracing::info!(?outcome, "mode switch -> individual");
        // The hidden pop-outs finish being created (they have had the whole flight); a pop-out that is not ready is shown
        // anyway; one that was never made is made now at its planned place.
        self.creating.join();
        for planned in &self.panes {
            app_windows::show_pop_out(&self.app, &planned.pane.id, &planned.pane.agent_type, planned.pane.cols, planned.pane.rows, planned.placement);
        }
        crate::mini_bar::remember_cockpit_monitor(&self.app);
        crate::mini_bar::show(&self.app);
        app_windows::hide_cockpit_window(&self.app);
        hand_off_from_overlay(&self.app, outcome);
        emit_finish(&self.app, self.gen);
    }
}

// ---------------------------------------------------------------- back to Orchestration

struct ToOrchestration {
    app: AppHandle,
    gen: u64,
    style: AnimStyle,
    recorded: Vec<(String, WindowRect)>,
    monitor: Option<Monitor>,
    mini_bar: Option<Rect>,
}

impl ToOrchestration {
    fn new(app: &AppHandle, gen: u64, style: AnimStyle) -> Self {
        ToOrchestration { app: app.clone(), gen, style, recorded: Vec::new(), monitor: None, mini_bar: None }
    }

    /// Each visible pop-out's current outer rect, recorded before anything is destroyed.
    fn record(&mut self) {
        for pane in panes_with_windows(&self.app) {
            let label = crate::pane_windows::window_label(&pane.id);
            let Some(window) = self.app.get_webview_window(&label).filter(|w| w.is_visible().unwrap_or(false)) else { continue };
            if let Some(rect) = app_windows::outer_rect(&window) {
                self.recorded.push((label, WindowRect { id: pane.id.clone(), rect: rect.into() }));
            }
        }
    }
}

impl Stage for ToOrchestration {
    fn direction(&self) -> &'static str {
        "orchestration"
    }

    fn style(&self) -> Option<AnimStyle> {
        Some(self.style)
    }

    fn announce(&mut self) -> bool {
        let app = self.app.clone();
        self.record();
        let Some(cockpit) = app.get_webview_window(COCKPIT_LABEL) else { return false };
        if self.recorded.is_empty() {
            return false;
        }
        // The cockpit's content goes invisible BEFORE the window shows, so it never flashes under the pop-outs.
        let _ = app.emit_to(COCKPIT_LABEL, SWITCH_EVENT, json!({ "phase": "hold", "gen": self.gen }));
        std::thread::sleep(Duration::from_millis(40));
        let _ = cockpit.unminimize();
        let _ = cockpit.show();
        let Some(monitor) = monitor_of(&cockpit).or_else(|| primary_monitor(&app)) else { return false };
        let mini_bar = app
            .get_webview_window(crate::mini_bar::LABEL)
            .filter(|w| w.is_visible().unwrap_or(false))
            .and_then(|w| app_windows::outer_rect(&w))
            .map(Rect::from)
            .or_else(|| Some(mini_bar_rect(&monitor)));
        self.monitor = Some(monitor);
        self.mini_bar = mini_bar;
        let windows: Vec<WindowRect> = self.recorded.iter().map(|(_, w)| w.clone()).collect();
        emit_prepare(&app, self.gen, "orchestration", self.style, &monitor, &windows, mini_bar);
        true
    }

    fn start_overlay(&mut self, begin: &Begin) {
        if let Some(monitor) = self.monitor {
            start_overlay_run(&self.app, self.gen, "orchestration", &monitor, self.mini_bar, begin);
        }
    }

    fn after_ready(&mut self) {
        // The overlay now shows the windows' faces in their place: the real ones can go.
        for (label, _) in &self.recorded {
            if let Some(window) = self.app.get_webview_window(label) {
                let _ = window.hide();
            }
        }
        crate::mini_bar::hide(&self.app);
    }

    fn finish(&mut self, outcome: Outcome) {
        tracing::info!(?outcome, "mode switch -> orchestration");
        crate::mini_bar::hide(&self.app);
        let destroyed = app_windows::destroy_pane_windows(&self.app);
        tracing::info!(destroyed, "ui mode -> orchestration: pop-outs destroyed, panes kept");
        if app_windows::ask_settings_to_move_inline(&self.app) {
            tracing::info!("ui mode -> orchestration: Settings window asked to move into the cockpit");
        }
        app_windows::open_cockpit_window(&self.app, None, true);
        hand_off_from_overlay(&self.app, outcome);
        emit_finish(&self.app, self.gen);
    }
}

// ---------------------------------------------------------------- entry points

/// The switch to `mode`, inside its turn: animated when the windows allow it, the plain way otherwise.
/// `instant` is the plain way (the caller's own code) so nothing is duplicated here.
pub fn run(app: &AppHandle, mode: UiMode, turn: &Turn, instant: impl FnOnce()) {
    if !can_animate(app, mode) {
        // The mode-changed event of the plain path is sent by the caller.
        instant();
        return;
    }
    let style = current_style();
    let timeouts = Timeouts::default();
    let outcome = match mode {
        UiMode::Individual => drive(&mut ToIndividual::new(app, turn.gen, style), &turn.mailbox, &timeouts),
        UiMode::Orchestration => drive(&mut ToOrchestration::new(app, turn.gen, style), &turn.mailbox, &timeouts),
    };
    tracing::debug!(?outcome, ?mode, "animated mode switch ended");
}

/// Settings > Preview: play the chosen motion over the middle of the monitor the Settings window (or the cockpit) is on.
/// Never interrupts a real switch.
pub fn preview(app: &AppHandle, style: AnimStyle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(turn) = try_turn() else { return };
        let monitor = [crate::app_windows::SETTINGS_LABEL, COCKPIT_LABEL]
            .iter()
            .filter_map(|label| app.get_webview_window(label))
            .find(|w| w.is_visible().unwrap_or(false))
            .and_then(|w| monitor_of(&w))
            .or_else(|| primary_monitor(&app));
        let Some(monitor) = monitor else { return };
        if !show_overlay(&app, &monitor) {
            return;
        }
        let _ = app.emit_to(OVERLAY_LABEL, OVERLAY_PREVIEW_EVENT, json!({ "style": style.as_str(), "monitor": monitor }));
        // Forward + pause + back, with room for a slow start; the overlay says done when the way back ends.
        let _ = turn.mailbox.wait_done(Instant::now() + Duration::from_millis(2 * MAX_TOTAL_MS));
        hide_overlay(&app);
    });
}
