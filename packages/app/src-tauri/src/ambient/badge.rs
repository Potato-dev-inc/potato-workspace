//! The taskbar overlay badge on the cockpit window: the one attention count (`attention::counts().blocking`,
//! the same number the Inbox, the phone and the tray tooltip show). Windows only; other platforms ignore it.
//!
//! The tray icon itself is a plain static icon (`tray.rs`): nothing here draws it, and nothing animates.
//! A small thread sleeps on a condvar until something may have changed (a pane status, the pane list, the
//! attention list), with a slow safety refresh. It also drops titles of panes that no longer exist.

use crate::AppState;
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use tauri::image::Image;

#[cfg(windows)]
const BADGE_PX: u32 = 32;
const SAFETY_REFRESH: Duration = Duration::from_secs(30);

static DIRTY: Lazy<(Mutex<bool>, Condvar)> = Lazy::new(|| (Mutex::new(false), Condvar::new()));

/// Something that may change the badge happened (pane status, pane list, attention list).
pub fn notify_changed() {
    let (flag, cv) = &*DIRTY;
    *flag.lock() = true;
    cv.notify_all();
}

/// Forgets the titles of panes that are gone.
fn retain_live_titles(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let live: Vec<String> = state.registry.lock().list().iter().map(|p| p.id.clone()).collect();
    super::store::retain_live(&live);
}

/// Taskbar overlay badge on the cockpit window. Uses Tauri's `set_overlay_icon`, which is
/// `ITaskbarList3::SetOverlayIcon` on Windows; other platforms ignore it.
fn set_badge(app: &AppHandle, count: u32) {
    #[cfg(windows)]
    if let Some(window) = app.get_webview_window(crate::app_windows::COCKPIT_LABEL) {
        let icon = (count > 0).then(|| Image::new_owned(badge_rgba(count, BADGE_PX), BADGE_PX, BADGE_PX));
        let _ = window.set_overlay_icon(icon);
    }
    #[cfg(not(windows))]
    let _ = (app, count);
}

/// Start the badge thread (once).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("ambient-badge".into()).spawn(move || run(app));
}

fn run(app: AppHandle) {
    let mut last: Option<(u32, bool)> = None;
    notify_changed();
    loop {
        {
            let (flag, cv) = &*DIRTY;
            let mut dirty = flag.lock();
            if !*dirty {
                cv.wait_for(&mut dirty, SAFETY_REFRESH);
            }
            *dirty = false;
        }
        retain_live_titles(&app);
        let count = crate::attention::counts().blocking;
        let cockpit_present = app.get_webview_window(crate::app_windows::COCKPIT_LABEL).is_some();
        if last != Some((count, cockpit_present)) {
            set_badge(&app, count);
            last = Some((count, cockpit_present));
        }
    }
}

/// 3x5 pixel font, `#` = on. Digits 0-9.
const FONT: [[&str; 5]; 10] = [
    ["###", "#.#", "#.#", "#.#", "###"],
    [".#.", "##.", ".#.", ".#.", "###"],
    ["###", "..#", "###", "#..", "###"],
    ["###", "..#", "###", "..#", "###"],
    ["#.#", "#.#", "###", "..#", "..#"],
    ["###", "#..", "###", "..#", "###"],
    ["###", "#..", "###", "#.#", "###"],
    ["###", "..#", "..#", "..#", "..#"],
    ["###", "#.#", "###", "#.#", "###"],
    ["###", "#.#", "###", "..#", "###"],
];

/// Taskbar overlay badge, `size`x`size` RGBA. count 0 is fully transparent. Counts above 99 show "99".
pub fn badge_rgba(count: u32, size: u32) -> Vec<u8> {
    let s = size as i32;
    let mut out = vec![0u8; (s * s * 4) as usize];
    if count == 0 {
        return out;
    }
    let mut put = |x: i32, y: i32, px: [u8; 4]| {
        if x >= 0 && y >= 0 && x < s && y < s {
            let o = ((y * s + x) * 4) as usize;
            out[o..o + 4].copy_from_slice(&px);
        }
    };

    // White disc with a one-pixel anti-aliased edge.
    let c = size as f32 / 2.0;
    let rad = c - 0.5;
    for y in 0..s {
        for x in 0..s {
            let d = ((x as f32 + 0.5 - c).powi(2) + (y as f32 + 0.5 - c).powi(2)).sqrt();
            let a = ((rad + 0.5 - d).clamp(0.0, 1.0) * 255.0).round() as u8;
            if a > 0 {
                put(x, y, [255, 255, 255, a]);
            }
        }
    }

    // Dark digits, centred, integer scale k, one k-wide gap between glyphs.
    let digits: Vec<usize> = match count {
        1..=9 => vec![count as usize],
        10..=99 => vec![(count / 10) as usize, (count % 10) as usize],
        _ => vec![9, 9],
    };
    let k = (s / 16).max(1);
    let n = digits.len() as i32;
    let (w, h) = (n * 3 * k + (n - 1) * k, 5 * k);
    let (x0, y0) = ((s - w) / 2, (s - h) / 2);
    for (i, &dg) in digits.iter().enumerate() {
        let gx = x0 + i as i32 * 4 * k;
        for (row, line) in FONT[dg].iter().enumerate() {
            for (col, _) in line.bytes().enumerate().filter(|(_, ch)| *ch == b'#') {
                for dy in 0..k {
                    for dx in 0..k {
                        put(gx + col as i32 * k + dx, y0 + row as i32 * k + dy, [20, 20, 20, 255]);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(img: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let o = ((y * size + x) * 4) as usize;
        [img[o], img[o + 1], img[o + 2], img[o + 3]]
    }

    #[test]
    fn badge_has_disc_and_digit() {
        let three = badge_rgba(3, 16);
        assert_eq!(pixel(&three, 16, 8, 8)[3], 255, "disc centre");
        let dark = three.chunks_exact(4).any(|px| px[3] == 255 && px[..3].iter().all(|&v| v < 60));
        assert!(dark, "no dark digit pixel");
        assert_eq!(pixel(&three, 16, 0, 0)[3], 0, "corner must be transparent");
        assert!(badge_rgba(0, 16).chunks_exact(4).all(|px| px[3] == 0));
        assert_ne!(badge_rgba(12, 16), three);
    }
}
