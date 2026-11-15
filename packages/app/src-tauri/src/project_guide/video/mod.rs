//! The video tour of a finished guide (Labs `project_guide_enabled`). Captions only: no voice, no upload, no model
//! needed. The tour is made from the guide's own pages and diagram (`.potato/guide/`), never from the code again, so it
//! cannot say anything the guide does not say.
//!
//! * `beats` (the director): the guide -> 20 to 26 short beats, the same every time (no clock, no randomness, no model).
//! * `spec` (the shot language): a beat is a caption and one shot written as JSON; the checks live here.
//! * `layout`: where every box, card and caption goes, computed by code, so nothing overlaps.
//! * `stage` + `assets/`: one page that draws any moment of the tour (`__seek(seconds)`), used both frame by frame
//!   (headless Chromium/Edge -> ffmpeg) and as a captioned slideshow that plays by itself when ffmpeg is missing.
//! * `render`: finds the tools, runs the render, reports progress. Output goes to `.potato/guide/video/`.

pub mod beats;
pub mod layout;
pub mod render;
pub mod spec;
pub mod stage;

use std::path::{Path, PathBuf};

use super::store;

/// `<project>/.potato/guide/video/`
pub fn video_dir(project: &Path) -> PathBuf {
    store::guide_dir(project).join("video")
}

#[cfg(test)]
mod tests;
