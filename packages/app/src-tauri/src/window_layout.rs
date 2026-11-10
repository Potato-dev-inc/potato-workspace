//! "Window layout in Individual": where the pop-outs go when the mode switches to Individual.
//! Side by side (default) splits the work area of the cockpit's monitor evenly, like Windows Snap;
//! Cascade is the old step-down-and-right. Everything here is pure (no window is touched) except the
//! small `runtime` block at the end that reads the monitor and the settings file.
//!
//! One function, `plan_layout`, decides the placements. The animated switch (`switch_anim`), the
//! `plan_mode_switch` command and the instant switch all call it, so the rect the animation flies to
//! is the rect the window gets.

use crate::app_windows::{plan_placements, Anchor, PanePlacement, CASCADE_SLOTS, CASCADE_STEP};
use serde_json::Value;

/// Space between the screen edge (work area) and the windows, and between two windows (logical px).
pub const OUTER_MARGIN: f64 = 8.0;
pub const GAP: f64 = 8.0;
/// Windows keep their normal pop-out size; only when they do not fit are they shrunk (aspect kept), never below this.
pub const FLOOR: (f64, f64) = (400.0, 300.0);

/// Band kept free at the top for the mini bar: its margin, its real height, and one more margin.
pub fn mini_bar_band() -> f64 {
    crate::mini_bar::TOP_MARGIN + crate::mini_bar::HEIGHT + OUTER_MARGIN
}

/// `settings.individual_window_layout`: SideBySide (default) or Cascade (the old behaviour).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowLayout {
    #[default]
    SideBySide,
    Cascade,
}

impl WindowLayout {
    #[cfg(test)]
    pub fn as_str(self) -> &'static str {
        match self {
            WindowLayout::SideBySide => "side_by_side",
            WindowLayout::Cascade => "cascade",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "side_by_side" => Some(WindowLayout::SideBySide),
            "cascade" => Some(WindowLayout::Cascade),
            _ => None,
        }
    }
}

/// The setting from the parsed `settings.json` (`{"settings": {...}}`); missing or unknown is Side by side.
pub fn layout_from_settings(file: &Value) -> WindowLayout {
    file.get("settings")
        .and_then(|s| s.get("individual_window_layout"))
        .and_then(Value::as_str)
        .and_then(WindowLayout::parse)
        .unwrap_or_default()
}

/// A monitor's work area (the screen minus the taskbar) in PHYSICAL pixels, with the monitor's scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

impl WorkArea {
    fn factor(&self) -> f64 {
        if self.scale.is_finite() && self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }
}

/// A rect in logical pixels: x, y, w, h.
pub type LRect = (f64, f64, f64, f64);

/// The usable box (logical) inside `area` (the work area): left, top, width, height.
fn usable(area: LRect) -> LRect {
    let top = area.1 + mini_bar_band();
    (area.0 + OUTER_MARGIN, top, (area.2 - 2.0 * OUTER_MARGIN).max(0.0), (area.1 + area.3 - OUTER_MARGIN - top).max(0.0))
}

/// How the windows are arranged: the shrink factor (1 = normal size), the columns, and how many fit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Arrangement {
    pub factor: f64,
    pub cols: usize,
    pub fitting: usize,
}

/// The cell all windows share: the largest normal size among them.
fn cell_of(sizes: &[(f64, f64)]) -> (f64, f64) {
    sizes.iter().fold((0.0, 0.0), |m, s| (f64::max(m.0, s.0), f64::max(m.1, s.1)))
}

/// Decide the factor for `n` windows of `cell` size in a box of `avail`: the biggest one (never above 1) at which all
/// fit in rows; if even the floor does not hold them all, the floor, with only the ones that fit in the grid.
pub fn arrange(cell: (f64, f64), n: usize, avail: (f64, f64)) -> Arrangement {
    let fit_at = |f: f64| {
        let (cw, ch) = (cell.0 * f, cell.1 * f);
        let cols = (((avail.0 + GAP) / (cw + GAP)).floor().max(0.0)) as usize;
        let rows = (((avail.1 + GAP) / (ch + GAP)).floor().max(0.0)) as usize;
        (cols, cols * rows)
    };
    // Never shrink below the floor, and never grow: a window already under the floor stays as it is.
    let min_f = (FLOOR.0 / cell.0).max(FLOOR.1 / cell.1).min(1.0);
    let mut f = 1.0;
    loop {
        let (cols, cap) = fit_at(f);
        if cap >= n {
            return Arrangement { factor: f, cols: cols.min(n).max(1), fitting: n };
        }
        if f <= min_f + 1e-9 {
            return Arrangement { factor: f, cols, fitting: cap };
        }
        f = (f - 0.01).max(min_f);
    }
}

/// The rects (logical px) of side-by-side windows of the given normal `sizes` in `area` (the work area, logical):
/// each keeps its size (scaled by one common factor only when they do not fit, aspect kept), laid out in rows left to
/// right then next row, `GAP` apart, the whole group centred horizontally and starting under the mini bar band. One
/// window is centred in the box. Only the first `result.len()` panes are in the grid; the rest cascade (`overflow_rect`).
pub fn side_by_side_rects(area: LRect, sizes: &[(f64, f64)]) -> Vec<LRect> {
    let (left, top, aw, ah) = usable(area);
    let n = sizes.len();
    if n == 0 {
        return Vec::new();
    }
    let cell = cell_of(sizes);
    let arr = arrange(cell, n, (aw, ah));
    if arr.fitting == 0 {
        return Vec::new();
    }
    let (cw, ch) = (cell.0 * arr.factor, cell.1 * arr.factor);
    let placed = n.min(arr.fitting);
    let cols = arr.cols.min(placed).max(1);
    if n == 1 {
        let (w, h) = (sizes[0].0 * arr.factor, sizes[0].1 * arr.factor);
        return vec![(left + (aw - w) / 2.0, top + (ah - h) / 2.0, w, h)];
    }
    let group_w = cols as f64 * cw + (cols as f64 - 1.0) * GAP;
    let x0 = left + (aw - group_w).max(0.0) / 2.0;
    (0..placed)
        .map(|i| {
            let (row, col) = (i / cols, i % cols);
            (x0 + col as f64 * (cw + GAP), top + row as f64 * (ch + GAP), sizes[i].0 * arr.factor, sizes[i].1 * arr.factor)
        })
        .collect()
}

/// Where the `k`-th pane that did not fit goes: cascaded from the grid's top-left at `size` (the shrunk size), kept
/// on the area.
pub fn overflow_rect(area: LRect, k: usize, size: (f64, f64)) -> LRect {
    let (left, top, aw, ah) = usable(area);
    let step = (k % CASCADE_SLOTS) as f64 * CASCADE_STEP;
    let (w, h) = (size.0.min(aw), size.1.min(ah));
    (left + step.min((aw - w).max(0.0)), top + step.min((ah - h).max(0.0)), w, h)
}

/// A logical rect as a placement on a monitor of `scale`. Physical EDGES are rounded (not widths), so neighbours that
/// touch logically never overlap physically.
fn placement_from_logical(r: LRect, scale: f64) -> PanePlacement {
    let (x0, y0) = ((r.0 * scale).round(), (r.1 * scale).round());
    let (x1, y1) = (((r.0 + r.2) * scale).round(), ((r.1 + r.3) * scale).round());
    PanePlacement { pos: Some((x0 / scale, y0 / scale)), size: ((x1 - x0) / scale, (y1 - y0) / scale), phys: Some((x0, y0, x1 - x0, y1 - y0)) }
}

/// The placements of a run of pop-outs opened by the switch to Individual, in the order given (first = top-left).
/// `grids` is each pane's terminal grid (Cascade uses it for the size); `first_slot` is the cascade slot the first takes.
/// Cascade, or no known work area, is exactly today's `plan_placements`.
pub fn plan_layout(layout: WindowLayout, area: Option<WorkArea>, anchor: Option<Anchor>, first_slot: usize, grids: &[(u16, u16)]) -> Vec<PanePlacement> {
    let (WindowLayout::SideBySide, Some(area)) = (layout, area) else { return plan_placements(anchor, first_slot, grids) };
    let scale = area.factor();
    let logical = (area.x / scale, area.y / scale, area.w / scale, area.h / scale);
    let sizes: Vec<(f64, f64)> = grids.iter().map(|(c, r)| crate::app_windows::pane_window_size(*c, *r)).collect();
    let cells = side_by_side_rects(logical, &sizes);
    // Panes that did not fit cascade at the size the grid ones were shrunk to.
    let factor = arrange(cell_of(&sizes), sizes.len(), { let u = usable(logical); (u.2, u.3) }).factor;
    (0..grids.len())
        .map(|i| {
            let rect = cells.get(i).copied().unwrap_or_else(|| overflow_rect(logical, i - cells.len(), (sizes[i].0 * factor, sizes[i].1 * factor)));
            placement_from_logical(rect, scale)
        })
        .collect()
}

/// The order windows are laid out in. `reported` is the cockpit's order (active pane, then the panes open in its grid
/// in grid order, then the sidebar-only ones in sidebar order); ids it does not know follow in `all` (registry) order,
/// and ids that are gone or repeated are dropped.
pub fn order_ids(all: &[String], reported: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(all.len());
    for id in reported.iter().filter(|id| all.contains(id)).chain(all.iter()) {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// A window's inner size such that its OUTER size (frame and title bar included) is `outer`, given the frame it has.
pub fn inner_for_outer(outer: (f64, f64), frame: (u32, u32)) -> (u32, u32) {
    let (w, h) = (outer.0.round().max(1.0) as u32, outer.1.round().max(1.0) as u32);
    (w.saturating_sub(frame.0).max(1), h.saturating_sub(frame.1).max(1))
}

pub use runtime::*;

mod runtime {
    use super::*;
    use parking_lot::Mutex;
    use tauri::{AppHandle, Manager};

    static REPORTED_ORDER: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// The cockpit tells Rust its pane order (it alone knows the active pane, the open tiles and the sidebar order).
    pub fn set_reported_order(ids: Vec<String>) {
        *REPORTED_ORDER.lock() = ids;
    }

    /// Sort panes into layout order using the cockpit's reported order.
    pub fn order_panes<T>(panes: Vec<T>, id_of: impl Fn(&T) -> &str) -> Vec<T> {
        let all: Vec<String> = panes.iter().map(|p| id_of(p).to_string()).collect();
        let order = order_ids(&all, &REPORTED_ORDER.lock());
        let mut slots: Vec<Option<T>> = panes.into_iter().map(Some).collect();
        order.iter().filter_map(|id| all.iter().position(|a| a == id)).filter_map(|i| slots[i].take()).collect()
    }

    pub fn current_layout() -> WindowLayout {
        std::fs::read_to_string(crate::app_paths::app_data_dir().join("settings.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|file| layout_from_settings(&file))
            .unwrap_or_default()
    }

    /// The work area of the monitor the cockpit is on (the one the mini bar uses), else the primary monitor.
    pub fn cockpit_work_area(app: &AppHandle) -> Option<WorkArea> {
        let monitor = app
            .get_webview_window(crate::app_windows::COCKPIT_LABEL)
            .and_then(|w| w.current_monitor().ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten())?;
        let wa = monitor.work_area();
        Some(WorkArea { x: f64::from(wa.position.x), y: f64::from(wa.position.y), w: f64::from(wa.size.width), h: f64::from(wa.size.height), scale: monitor.scale_factor() })
    }

    /// Placements for the pop-outs of `grids` (already in layout order) from the real setting and monitor.
    pub fn switch_placements(app: &AppHandle, first_slot: usize, grids: &[(u16, u16)]) -> Vec<PanePlacement> {
        plan_layout(current_layout(), cockpit_work_area(app), crate::app_windows::current_anchor(app), first_slot, grids)
    }

    /// Whether the switch to Individual lays windows out in a grid right now.
    pub fn grid_active(app: &AppHandle) -> bool {
        current_layout() == WindowLayout::SideBySide && cockpit_work_area(app).is_some()
    }
}

#[cfg(test)]
mod tests;
