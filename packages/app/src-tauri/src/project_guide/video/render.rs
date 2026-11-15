//! Making the tour: plan (our code), then frames (a headless browser) into a video (ffmpeg). Three tools are needed
//! for a video: Node (the one bundled with the app, or one on the PATH), a Chromium-based browser (Edge or Chrome) and
//! ffmpeg. When one is missing the person still gets the captioned slideshow (`tour.html`), which needs none of them.
//!
//! Output, in `<project>/.potato/guide/video/`: `tour.mp4`, `tour-vertical.mp4` (when asked), `tour.html`, `spec.json`.
//! Nothing is uploaded and no model is called.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;

use super::super::store;
use super::beats::{self, GuideInput};
use super::spec::{self, Spec};
use super::stage;
use super::video_dir;

#[derive(Debug, Clone)]
pub struct Tools {
    pub node: PathBuf,
    pub browser: PathBuf,
    pub ffmpeg: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
    /// Also make the tall (phone) video.
    pub vertical: bool,
    /// The language of the fixed phrases (the guide's own language setting wins when this is empty).
    pub lang_hint: String,
    /// The folders the app keeps its bundled files in (see `mcp_runtime::installed_resource`).
    pub resource_dir: Option<PathBuf>,
    pub exe_dir: Option<PathBuf>,
    /// Picture size as a fraction of 1920x1080 (tests use a small one). 0 means 1.
    pub scale: f32,
    /// Frames a second (tests use a low one). 0 means the spec's.
    pub fps: u32,
    /// Use these tools instead of looking for them.
    pub tools: Option<Tools>,
    /// Pretend the tools are missing (the slideshow path).
    pub force_slideshow: bool,
    /// Only the first N beats (a quick check render). 0 means all.
    pub max_beats: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoState {
    /// `plan` | `frames` | `done` | `stopped` | `failed`
    pub phase: String,
    pub frames_done: u32,
    pub frames_total: u32,
    pub beats: usize,
    pub seconds: f32,
    pub error: Option<String>,
    /// When done: `video` or `slideshow`.
    pub outcome: Option<String>,
    /// Files made, relative to the project.
    pub files: Vec<String>,
    /// Plain words about what happened (for example why only a slideshow was made).
    pub notes: Vec<String>,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
}

#[derive(Clone, Default)]
pub struct VideoProgress(Arc<Mutex<VideoState>>);

impl VideoProgress {
    pub fn new() -> Self {
        let p = Self::default();
        p.0.lock().started_ms = store::now_ms();
        p.0.lock().phase = "plan".into();
        p
    }
    pub fn snapshot(&self) -> VideoState {
        self.0.lock().clone()
    }
    fn set(&self, f: impl FnOnce(&mut VideoState)) {
        f(&mut self.0.lock());
    }
    fn end(&self, phase: &str, error: Option<String>) {
        self.set(|s| {
            s.phase = phase.into();
            s.error = error;
            s.finished_ms = Some(store::now_ms());
        });
    }
}

// ------------------------------------------------------------------------------------------------ finding tools

fn on_path(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) { vec![".exe".into(), ".cmd".into(), ".bat".into(), String::new()] } else { vec![String::new()] };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| exts.iter().map(|e| dir.join(format!("{name}{e}"))).find(|p| p.is_file()))
}

fn first_file(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|p| p.is_file())
}

fn from_env(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_file())
}

pub fn find_ffmpeg(resource_dir: Option<&Path>, exe_dir: Option<&Path>) -> Option<PathBuf> {
    from_env("PM_FFMPEG")
        .or_else(|| crate::mcp_runtime::installed_resource(resource_dir, exe_dir, if cfg!(windows) { "bin/ffmpeg.exe" } else { "bin/ffmpeg" }))
        .or_else(|| on_path("ffmpeg"))
        .or_else(|| first_file(&["C:/ffmpeg/bin/ffmpeg.exe", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]))
}

pub fn find_browser() -> Option<PathBuf> {
    from_env("PM_GUIDE_BROWSER")
        .or_else(|| {
            first_file(&[
                "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
                "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
                "C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            ])
        })
        .or_else(|| ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].iter().find_map(|n| on_path(n)))
}

pub fn find_node(resource_dir: Option<&Path>, exe_dir: Option<&Path>) -> Option<PathBuf> {
    from_env("PM_NODE")
        .or_else(|| crate::mcp_runtime::installed_resource(resource_dir, exe_dir, if cfg!(windows) { "node/node.exe" } else { "node/bin/node" }))
        .or_else(|| on_path("node"))
}

/// The tools, or the names of the ones that are missing.
pub fn find_tools(resource_dir: Option<&Path>, exe_dir: Option<&Path>) -> Result<Tools, Vec<&'static str>> {
    let (node, browser, ffmpeg) = (find_node(resource_dir, exe_dir), find_browser(), find_ffmpeg(resource_dir, exe_dir));
    match (node, browser, ffmpeg) {
        (Some(node), Some(browser), Some(ffmpeg)) => Ok(Tools { node, browser, ffmpeg }),
        (n, b, f) => Err([(n.is_none(), "Node"), (b.is_none(), "a browser (Edge or Chrome)"), (f.is_none(), "ffmpeg")].into_iter().filter(|(m, _)| *m).map(|(_, name)| name).collect()),
    }
}

// ------------------------------------------------------------------------------------------------ the work

/// Builds the spec for a project's guide (also the checks). No files are written.
pub fn plan(project: &Path, name: &str, lang_hint: &str) -> Result<(GuideInput, Spec), String> {
    let input = beats::load(project, name, lang_hint)?;
    let spec = beats::spec_of(&input);
    let problems = spec::check(&spec, Some(project));
    if !problems.is_empty() {
        return Err(format!("VIDEO_BAD_SPEC: {}", problems.join("; ")));
    }
    Ok((input, spec))
}

fn rel(project: &Path, file: &Path) -> String {
    file.strip_prefix(project).unwrap_or(file).to_string_lossy().replace('\\', "/")
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("VIDEO_IO: Could not write {}: {e}", path.display()))
}

/// Runs the render script once. Returns Ok(true) when the video was made, Ok(false) when it was stopped.
fn run_script(tools: &Tools, script: &Path, stage_file: &Path, out: &Path, vertical: bool, opts: &RenderOptions, progress: &VideoProgress, base_done: u32, stop: &AtomicBool) -> Result<bool, String> {
    let mut cmd = crate::proc_util::hidden_command(&tools.node);
    cmd.arg(script)
        .arg("--stage")
        .arg(stage_file)
        .arg("--out")
        .arg(out)
        .arg("--browser")
        .arg(&tools.browser)
        .arg("--ffmpeg")
        .arg(&tools.ffmpeg)
        .arg("--aspect")
        .arg(if vertical { "vertical" } else { "landscape" })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    if opts.scale > 0.0 {
        cmd.arg("--scale").arg(opts.scale.to_string());
    }
    if opts.fps > 0 {
        cmd.arg("--fps").arg(opts.fps.to_string());
    }
    let mut child = cmd.spawn().map_err(|e| format!("VIDEO_SPAWN: Could not start Node: {e}"))?;
    let stdout = child.stdout.take().ok_or("VIDEO_SPAWN: no output from the render")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("guide-video-read".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| format!("VIDEO_SPAWN: {e}"))?;
    let mut error: Option<String> = None;
    let mut finished = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            crate::pty::proc_tree::kill_process_tree(child.id());
            let _ = child.wait();
            let _ = std::fs::remove_file(format!("{}.part", out.display()));
            return Ok(false);
        }
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(line) => {
                if let Some(rest) = line.strip_prefix("P ") {
                    let mut it = rest.split_whitespace().filter_map(|x| x.parse::<u32>().ok());
                    if let (Some(done), Some(_)) = (it.next(), it.next()) {
                        progress.set(|s| s.frames_done = base_done + done);
                    }
                } else if let Some(e) = line.strip_prefix("ERR ") {
                    error = Some(e.to_string());
                } else if line.trim() == "DONE" {
                    finished = true;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child.wait().map_err(|e| format!("VIDEO_SPAWN: {e}"))?;
    if finished && status.success() && out.is_file() {
        Ok(true)
    } else {
        Err(error.unwrap_or_else(|| "the render stopped without a video".into()))
    }
}

/// Plans, writes the slideshow, and (when the tools are there) renders the video(s). Returns the final state.
pub fn make(project: &Path, name: &str, opts: &RenderOptions, progress: &VideoProgress, stop: &AtomicBool) -> VideoState {
    let result = make_inner(project, name, opts, progress, stop);
    match result {
        Ok(true) => progress.end("done", None),
        Ok(false) => progress.end("stopped", None),
        Err(e) => progress.end("failed", Some(e)),
    }
    progress.snapshot()
}

fn make_inner(project: &Path, name: &str, opts: &RenderOptions, progress: &VideoProgress, stop: &AtomicBool) -> Result<bool, String> {
    let (_, mut spec) = plan(project, name, &opts.lang_hint)?;
    if opts.max_beats > 0 {
        spec.beats.truncate(opts.max_beats);
    }
    let dir = video_dir(project);
    store::ensure_dir(project)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("VIDEO_IO: Could not make the video folder: {e}"))?;
    let fps = if opts.fps > 0 { opts.fps } else { spec.fps };
    let passes = if opts.vertical { 2 } else { 1 };
    let per_pass = (spec.total_seconds() * fps as f32).ceil() as u32;
    progress.set(|s| {
        s.beats = spec.beats.len();
        s.seconds = spec.total_seconds();
        s.frames_total = per_pass * passes;
    });
    write(&dir.join("spec.json"), &serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?)?;
    // The slideshow is cheap and needs nothing, so it is always written.
    let slideshow = dir.join("tour.html");
    write(&slideshow, &stage::html(&spec, true))?;
    let mut files = vec![rel(project, &slideshow)];
    if stop.load(Ordering::SeqCst) {
        return Ok(false);
    }

    let tools = if opts.force_slideshow {
        Err(vec!["tools (switched off)"])
    } else if let Some(t) = &opts.tools {
        Ok(t.clone())
    } else {
        find_tools(opts.resource_dir.as_deref(), opts.exe_dir.as_deref())
    };
    let tools = match tools {
        Ok(t) => t,
        Err(missing) => {
            progress.set(|s| {
                s.outcome = Some("slideshow".into());
                s.notes.push(format!("No video was made because this PC has no {}. A captioned slideshow is ready instead.", missing.join(" and ")));
                s.files = files;
            });
            return Ok(true);
        }
    };

    progress.set(|s| s.phase = "frames".into());
    let stage_file = dir.join("stage.html");
    let script = dir.join("render.mjs");
    write(&stage_file, &stage::html(&spec, false))?;
    write(&script, stage::RENDER_SCRIPT)?;
    let mut outcome: Result<bool, String> = Ok(true);
    let mut made: Vec<PathBuf> = Vec::new();
    for (k, vertical) in [false, true].into_iter().take(passes as usize).enumerate() {
        let out = dir.join(if vertical { "tour-vertical.mp4" } else { "tour.mp4" });
        match run_script(&tools, &script, &stage_file, &out, vertical, opts, progress, per_pass * k as u32, stop) {
            Ok(true) => made.push(out),
            Ok(false) => {
                outcome = Ok(false);
                break;
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }
    let _ = std::fs::remove_file(&stage_file);
    let _ = std::fs::remove_file(&script);
    files.splice(0..0, made.iter().map(|p| rel(project, p)));
    match outcome {
        Ok(true) => progress.set(|s| {
            s.outcome = Some("video".into());
            s.files = files;
        }),
        Ok(false) => return Ok(false),
        Err(e) => progress.set(|s| {
            s.outcome = Some("slideshow".into());
            s.notes.push(format!("The video could not be made ({e}). A captioned slideshow is ready instead."));
            s.files = files.into_iter().filter(|f| f.ends_with(".html") || f.ends_with(".mp4")).collect();
        }),
    }
    Ok(true)
}
