//! The picture of a marked-up page: crop to the page area, make a small thumbnail, save, prune.
//!
//! File names are made here (`mark-<yyyymmdd-hhmmss>-<n>.png`), never taken from the window. Files go only into
//! `<project>/.potato-workspace/shots/`. `prune` touches only `mark-*.png` there (the `pick-*` pictures of Point and Fix
//! keep their own count).

use crate::point::shot::{clamp_px, decode, encode, shots_dir, stamp, write_atomic};
use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX: &str = "mark-";
const EXT: &str = ".png";
/// Marked-up pictures kept per project.
pub const KEEP: usize = 50;
/// The send row's picture is at most this wide, in pixels.
const THUMB_WIDTH: u32 = 360;
/// A thumbnail above this many bytes is not sent to the window.
const MAX_THUMB_BYTES: usize = 400 * 1024;

/// The page area, in CSS pixels of a window `viewport_w` wide.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Crops a window picture to `area`. The scale is the picture width over the viewport width, so zoom and DPI are handled.
/// No outline is drawn: the marks are already in the picture (the window drew them).
pub fn crop_area(png: &[u8], area: Area, viewport_w: f64) -> Result<(Vec<u8>, u32, u32), String> {
    const BAD: &str = "The page area has no size on screen.";
    if ![area.x, area.y, area.w, area.h, viewport_w].iter().all(|v| v.is_finite()) || viewport_w <= 0.0 || area.w <= 0.0 || area.h <= 0.0 {
        return Err(BAD.to_string());
    }
    let pic = decode(png)?;
    let scale = f64::from(pic.w) / viewport_w;
    let x0 = clamp_px((area.x * scale).floor(), pic.w);
    let y0 = clamp_px((area.y * scale).floor(), pic.h);
    let x1 = clamp_px(((area.x + area.w) * scale).ceil(), pic.w);
    let y1 = clamp_px(((area.y + area.h) * scale).ceil(), pic.h);
    if x1 <= x0 || y1 <= y0 {
        return Err("The page area is not on screen any more.".to_string());
    }
    let (w, h) = (x1 - x0, y1 - y0);
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for y in y0..y1 {
        let start = ((y * pic.w + x0) * 4) as usize;
        let end = ((y * pic.w + x1) * 4) as usize;
        out.extend_from_slice(&pic.rgba[start..end]);
    }
    Ok((encode(w, h, &out)?, w, h))
}

/// A small copy for the send row: at most `THUMB_WIDTH` wide, by averaging blocks of pixels. `None` when it is still big.
pub fn thumbnail(png: &[u8]) -> Option<Vec<u8>> {
    let pic = decode(png).ok()?;
    let step = pic.w.div_ceil(THUMB_WIDTH).max(1);
    let (w, h) = (pic.w / step, pic.h / step);
    if w == 0 || h == 0 {
        return None;
    }
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for ty in 0..h {
        for tx in 0..w {
            let mut sum = [0u32; 4];
            for dy in 0..step {
                for dx in 0..step {
                    let i = (((ty * step + dy) * pic.w + tx * step + dx) * 4) as usize;
                    for c in 0..4 {
                        sum[c] += u32::from(pic.rgba[i + c]);
                    }
                }
            }
            let n = step * step;
            out.extend(sum.iter().map(|s| (s / n) as u8));
        }
    }
    let bytes = encode(w, h, &out).ok()?;
    (bytes.len() <= MAX_THUMB_BYTES).then_some(bytes)
}

/// A `data:` address of a PNG for the window.
pub fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

/// Writes one picture into the project's shots folder. Returns (absolute path, relative path with `/`).
pub fn save(project: &Path, png: &[u8], now_ms: u64, seq: u32) -> std::io::Result<(PathBuf, String)> {
    crate::git_exclude::ensure_project_storage_excluded(project);
    let dir = shots_dir(project);
    std::fs::create_dir_all(&dir)?;
    let name = format!("{PREFIX}{}-{seq}{EXT}", stamp(now_ms));
    write_atomic(&dir, &name, png)?;
    prune(&dir, KEEP);
    Ok((dir.join(&name), format!(".potato-workspace/shots/{name}")))
}

/// True for the only names this module writes: `mark-*.png`, one path component.
pub fn is_mark_name(name: &str) -> bool {
    name.starts_with(PREFIX) && name.ends_with(EXT) && name.len() > PREFIX.len() + EXT.len() && !name.contains(['/', '\\'])
}

/// Keeps the newest `keep` marked-up pictures in `dir`; other files are never touched. Returns how many were deleted.
pub fn prune(dir: &Path, keep: usize) -> usize {
    let Ok(read) = std::fs::read_dir(dir) else { return 0 };
    let mut shots: Vec<(SystemTime, String, PathBuf)> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            is_mark_name(&name).then(|| (e.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), name, e.path()))
        })
        .collect();
    if shots.len() <= keep {
        return 0;
    }
    shots.sort();
    let extra = shots.len() - keep;
    shots.into_iter().take(extra).filter(|(_, _, p)| std::fs::remove_file(p).is_ok()).count()
}
