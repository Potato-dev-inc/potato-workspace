//! Where the pet sits: bottom-right of the primary work area by default, remembered per monitor, always inside the
//! work area. Pure functions on logical pixels.

use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
}

/// Bottom-right corner of the work area, `margin` away from both edges. Top-left of the window, logical px.
pub fn default_position(work: Rect, w: f64, h: f64, margin: f64) -> (f64, f64) {
    clamp((work.x + work.w - w - margin, work.y + work.h - h - margin), work, w, h)
}

/// Keep a `w` x `h` window fully inside the work area. A work area smaller than the window pins it to the top-left.
pub fn clamp(pos: (f64, f64), work: Rect, w: f64, h: f64) -> (f64, f64) {
    let fix = |v: f64, lo: f64, hi: f64| {
        if !v.is_finite() || hi < lo {
            lo
        } else {
            v.clamp(lo, hi)
        }
    };
    (fix(pos.0, work.x, work.x + work.w - w), fix(pos.1, work.y, work.y + work.h - h))
}

/// New top-left after the window changes size, keeping its bottom-right corner where it was (the bubble grows
/// upward and to the left), then clamped to the work area.
pub fn anchored_resize(pos: (f64, f64), old: (f64, f64), new: (f64, f64), work: Rect) -> (f64, f64) {
    clamp((pos.0 + old.0 - new.0, pos.1 + old.1 - new.1), work, new.0, new.1)
}

/// A stable name for a monitor from its logical rectangle.
pub fn monitor_key(m: Rect) -> String {
    format!("{},{},{}x{}", m.x.round() as i64, m.y.round() as i64, m.w.round() as i64, m.h.round() as i64)
}

/// The remembered spots: one per monitor, plus the monitor the pet was last on.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Saved {
    pub last: Option<String>,
    pub spots: BTreeMap<String, (f64, f64)>,
}

impl Saved {
    pub fn parse(text: &str) -> Self {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return Self::default() };
        let last = v.get("last").and_then(Value::as_str).map(str::to_string);
        let mut spots = BTreeMap::new();
        if let Some(map) = v.get("spots").and_then(Value::as_object) {
            for (k, p) in map {
                if let (Some(x), Some(y)) = (p.get(0).and_then(Value::as_f64), p.get(1).and_then(Value::as_f64)) {
                    if x.is_finite() && y.is_finite() {
                        spots.insert(k.clone(), (x, y));
                    }
                }
            }
        }
        Self { last, spots }
    }

    pub fn to_json(&self) -> String {
        let spots: serde_json::Map<String, Value> = self.spots.iter().map(|(k, (x, y))| (k.clone(), json!([x, y]))).collect();
        json!({ "last": self.last, "spots": spots }).to_string()
    }

    pub fn remember(&mut self, monitor: &str, pos: (f64, f64)) {
        self.last = Some(monitor.to_string());
        self.spots.insert(monitor.to_string(), pos);
    }

    /// The window's top-left on start: the last used monitor if it is still there, else the primary one; a saved
    /// spot is clamped to that monitor's work area, no saved spot means the bottom-right corner.
    /// `monitors` are (key, work area); `primary` is the index of the primary one.
    pub fn start_position(&self, monitors: &[(String, Rect)], primary: usize, w: f64, h: f64) -> Option<(f64, f64)> {
        let pick = self
            .last
            .as_ref()
            .and_then(|k| monitors.iter().find(|(key, _)| key == k))
            .or_else(|| monitors.get(primary))
            .or_else(|| monitors.first())?;
        Some(match self.spots.get(&pick.0) {
            Some(p) => clamp(*p, pick.1, w, h),
            None => default_position(pick.1, w, h, super::EDGE_MARGIN),
        })
    }
}
