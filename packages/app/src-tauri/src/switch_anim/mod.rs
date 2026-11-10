//! The animated Orchestration <-> Individual switch. Rust drives it; the cockpit window and a transparent,
//! click-through "switch overlay" window only make it pretty.
//!
//! Going to Individual: the cockpit collects where each pane starts (tile, sidebar row ...), Rust plans the pop-out
//! rects and creates the pop-outs HIDDEN, the overlay draws the motion, and when it is done (or after the animation
//! length + 150 ms, whichever comes first) Rust shows the pop-outs and the mini bar and hides the cockpit.
//! Coming back is the same in the other direction, from the recorded pop-out rects to the cockpit's tiles and rows.
//!
//! Nothing here depends on the cockpit or the overlay answering: every wait has a timeout, and a timeout finishes
//! the switch the plain way. Everything that decides something is pure and tested here; `glue.rs` holds the windows.
//!
//! Rectangles are physical screen pixels everywhere.

pub mod glue;

use crate::ui_mode::UiMode;
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex, MutexGuard};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Event to the cockpit (`hold`, `prepare`, `finish` phases) and the overlay's events and commands.
pub const SWITCH_EVENT: &str = "ui://mode-switch";
pub const OVERLAY_LABEL: &str = "switch-overlay";
pub const OVERLAY_URL: &str = "index.html?switchoverlay=1";
pub const OVERLAY_RUN_EVENT: &str = "switch-overlay://run";
pub const OVERLAY_CANCEL_EVENT: &str = "switch-overlay://cancel";
pub const OVERLAY_PREVIEW_EVENT: &str = "switch-overlay://preview";

/// The active pane plus the next 7 animate; the rest just appear (the cockpit enforces it, this is the bound Rust accepts).
pub const MAX_ANIMATED: usize = 8;
/// Rust finishes the switch itself this long after the animation should have ended.
pub const HARD_TIMEOUT_SLACK_MS: u64 = 150;
/// No animation is allowed to hold a switch longer than this, whatever the cockpit claims.
pub const MAX_TOTAL_MS: u64 = 3000;
/// How long Rust waits for the cockpit to hand over its proxies.
pub const BEGIN_WAIT_MS: u64 = 700;
/// The overlay is built like the askbar's transparent window: no click-through (that needs WS_EX_LAYERED, which broke
/// transparency). Logged with the overlay's phases.
pub const OVERLAY_CLICK_THROUGH: bool = false;
/// The overlay stays up this long after the real windows are shown, so they have painted before it leaves.
pub const OVERLAY_HANDOFF_MS: u64 = 70;
/// How long Rust waits for the overlay to say its first frame is up.
pub const READY_WAIT_MS: u64 = 500;

// ---------------------------------------------------------------- the setting

/// `settings.mode_switch_animation`: Domino (default), Ink, or Off (a quick fade, no motion).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimStyle {
    #[default]
    Domino,
    Ink,
    Off,
}

impl AnimStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            AnimStyle::Domino => "domino",
            AnimStyle::Ink => "ink",
            AnimStyle::Off => "off",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "domino" => Some(AnimStyle::Domino),
            "ink" => Some(AnimStyle::Ink),
            "off" => Some(AnimStyle::Off),
            _ => None,
        }
    }
}

/// `settings.mode_switch_animation` from the parsed `settings.json` (`{"settings": {...}}`); missing or unknown is Domino.
pub fn style_from_settings(file: &Value) -> AnimStyle {
    file.get("settings")
        .and_then(|s| s.get("mode_switch_animation"))
        .and_then(Value::as_str)
        .and_then(AnimStyle::parse)
        .unwrap_or_default()
}

pub fn current_style() -> AnimStyle {
    std::fs::read_to_string(crate::app_paths::app_data_dir().join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|file| style_from_settings(&file))
        .unwrap_or_default()
}

// ---------------------------------------------------------------- geometry

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl From<(f64, f64, f64, f64)> for Rect {
    fn from((x, y, w, h): (f64, f64, f64, f64)) -> Self {
        Rect { x, y, w, h }
    }
}

/// A monitor in physical pixels and its scale factor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Monitor {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

/// A pane's pop-out window: where it will open, or where it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowRect {
    pub id: String,
    pub rect: Rect,
}

/// What `plan_mode_switch` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub windows: Vec<WindowRect>,
    pub mini_bar: Option<Rect>,
    pub monitor: Option<Monitor>,
}

/// A pane that gets a pop-out on the switch, with the grid its window is sized from.
#[derive(Debug, Clone, PartialEq)]
pub struct PaneGrid {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

/// The pop-out rect of each pane, from the SAME placement code `open_pane_window` uses (`window_layout::plan_layout`,
/// which is today's cascade for `Cascade`), for panes in layout order opened from cascade slot `first_slot`. A pane with
/// no known position is left out.
pub fn plan_windows(
    layout: crate::window_layout::WindowLayout,
    area: Option<crate::window_layout::WorkArea>,
    anchor: Option<crate::app_windows::Anchor>,
    first_slot: usize,
    scale: f64,
    panes: &[PaneGrid],
) -> Vec<WindowRect> {
    let grids: Vec<(u16, u16)> = panes.iter().map(|p| (p.cols, p.rows)).collect();
    let placements = crate::window_layout::plan_layout(layout, area, anchor, first_slot, &grids);
    panes
        .iter()
        .zip(placements)
        .filter_map(|(pane, placement)| {
            crate::app_windows::placement_physical(&placement, scale).map(|r| WindowRect { id: pane.id.clone(), rect: r.into() })
        })
        .collect()
}

/// Where the mini bar sits on `monitor` (physical px): centred along the top, `mini_bar::WIDTH` x `HEIGHT` logical.
pub fn mini_bar_rect(monitor: &Monitor) -> Rect {
    let scale = if monitor.scale.is_finite() && monitor.scale > 0.0 { monitor.scale } else { 1.0 };
    let (x, y) = crate::mini_bar::top_center_for(monitor.x, monitor.y, monitor.w, scale, crate::mini_bar::WIDTH);
    Rect { x: x * scale, y: y * scale, w: crate::mini_bar::WIDTH * scale, h: crate::mini_bar::HEIGHT * scale }
}

// ---------------------------------------------------------------- when to animate

/// What the windows look like at the moment of a switch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WindowState {
    pub cockpit_exists: bool,
    pub cockpit_visible: bool,
    pub cockpit_minimized: bool,
    /// Pop-outs on screen right now.
    pub visible_pop_outs: usize,
    /// Live panes that get a window on the switch.
    pub panes: usize,
}

/// Whether the switch to `mode` can play the motion. A cockpit nobody can see (tray-only, minimized, hidden) or nothing
/// to move means an instant switch: the animation never depends on a window being there.
pub fn should_animate(mode: UiMode, state: &WindowState) -> bool {
    match mode {
        UiMode::Individual => state.cockpit_exists && state.cockpit_visible && !state.cockpit_minimized && state.panes > 0,
        UiMode::Orchestration => state.cockpit_exists && state.visible_pop_outs > 0,
    }
}

/// The longest the switch waits for the overlay after it started: the animation plus the slack, never more than
/// `MAX_TOTAL_MS` of animation (a cockpit that claims more is not believed).
/// Whether the overlay was on screen drawing proxies when the switch ended (so it must hand over to the real windows).
pub fn overlay_was_drawing(outcome: Outcome) -> bool {
    matches!(outcome, Outcome::Animated | Outcome::DoneTimeout)
}

pub fn hard_timeout(total_ms: u64, slack: Duration) -> Duration {
    Duration::from_millis(total_ms.min(MAX_TOTAL_MS)) + slack
}

// ---------------------------------------------------------------- the rendezvous

/// What the cockpit handed over (`mode_switch_begin`).
#[derive(Debug, Clone)]
pub struct Begin {
    /// How long the motion lasts, as the cockpit computed it (clamped to `MAX_TOTAL_MS`).
    pub total_ms: u64,
    /// How many panes animate. 0: nothing to draw, switch at once.
    pub animated: usize,
    /// The whole spec (motion, proxies), forwarded to the overlay.
    pub spec: Value,
}

/// Motion lengths, the same numbers as `lib/mode-switch/model.ts` (DOMINO_MS ...).
pub const DOMINO_MS: u64 = 530;
pub const INK_MS: u64 = 720;
pub const FADE_MS: u64 = 120;
pub const STEP_MS: u64 = 80;
pub const STEP_CAP_MS: u64 = 240;

/// How long the motion `motion` ("domino", "ink", "fade") lasts for `count` panes: the last proxy has landed.
/// Mirrors `totalMs` in `model.ts`; an unknown motion counts as the fade.
pub fn expected_total_ms(motion: &str, count: usize) -> u64 {
    if count == 0 {
        return 0;
    }
    match motion {
        "ink" => INK_MS,
        "domino" => DOMINO_MS + (count as u64 - 1).saturating_mul(STEP_MS).min(STEP_CAP_MS),
        _ => FADE_MS,
    }
}

impl Begin {
    /// From the JSON the cockpit sent. Anything unreadable is "nothing to animate". The length is never shorter than
    /// the motion needs, whatever `totalMs` says (a missing or zero `totalMs` would make the hard timeout 150 ms).
    pub fn from_spec(spec: Value) -> Begin {
        let animated = spec.get("proxies").and_then(Value::as_array).map_or(0, |a| a.len().min(MAX_ANIMATED));
        let claimed = spec.get("totalMs").and_then(Value::as_f64).map_or(0, |t| t.max(0.0) as u64);
        let needed = expected_total_ms(spec.get("motion").and_then(Value::as_str).unwrap_or(""), animated);
        Begin { total_ms: claimed.max(needed).min(MAX_TOTAL_MS), animated, spec }
    }

    /// The motion the cockpit chose ("domino", "ink", "fade").
    pub fn motion(&self) -> &str {
        self.spec.get("motion").and_then(Value::as_str).unwrap_or("?")
    }

    /// One entry per proxy for the log: `id (x,y,WxH)->(x,y,WxH)`, physical px.
    pub fn proxy_summary(&self) -> String {
        let rect = |v: Option<&Value>| match v {
            Some(r) => {
                let n = |k: &str| r.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN).round();
                format!("({},{},{}x{})", n("x"), n("y"), n("w"), n("h"))
            }
            None => "(none)".into(),
        };
        self.spec
            .get("proxies")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|p| {
                        let id = p.get("id").and_then(Value::as_str).unwrap_or("?");
                        let short: String = id.chars().take(12).collect();
                        format!("{short} {}->{}", rect(p.get("start")), rect(p.get("end")))
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default()
    }
}

/// True when the cockpit played something other than the style Rust asked for: it saw reduced motion
/// (Windows animation effects off, or prefers-reduced-motion) and fell back to the fade.
pub fn motion_overridden(style: AnimStyle, motion: &str) -> bool {
    match style {
        AnimStyle::Domino => motion != "domino",
        AnimStyle::Ink => motion != "ink",
        AnimStyle::Off => false,
    }
}

#[derive(Debug, Default)]
struct MailState {
    begin: Option<Begin>,
    ready: bool,
    done: bool,
    cancelled: bool,
    /// What the overlay reported with its messages (for the log only).
    ready_info: Option<Value>,
    done_info: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wait<T> {
    Got(T),
    TimedOut,
    /// A newer switch took over: finish this one at once.
    Cancelled,
}

/// The messages of one switch from the cockpit (begin) and the overlay (ready, done), and the cancel from a newer switch.
#[derive(Debug, Default)]
pub struct Mailbox {
    state: Mutex<MailState>,
    cv: Condvar,
}

impl Mailbox {
    pub fn new() -> Self {
        Self::default()
    }

    fn post(&self, f: impl FnOnce(&mut MailState)) {
        f(&mut self.state.lock());
        self.cv.notify_all();
    }

    pub fn post_begin(&self, begin: Begin) {
        self.post(|s| s.begin = Some(begin));
    }

    pub fn post_ready_with(&self, info: Option<Value>) {
        self.post(|s| {
            s.ready = true;
            s.ready_info = info;
        });
    }

    pub fn post_done_with(&self, info: Option<Value>) {
        self.post(|s| {
            s.done = true;
            s.done_info = info;
        });
    }

    pub fn ready_info(&self) -> Option<Value> {
        self.state.lock().ready_info.clone()
    }

    pub fn done_info(&self) -> Option<Value> {
        self.state.lock().done_info.clone()
    }

    pub fn cancel(&self) {
        self.post(|s| s.cancelled = true);
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.lock().cancelled
    }

    fn wait<T>(&self, until: Instant, pick: impl Fn(&MailState) -> Option<T>) -> Wait<T> {
        let mut state = self.state.lock();
        loop {
            if state.cancelled {
                return Wait::Cancelled;
            }
            if let Some(got) = pick(&state) {
                return Wait::Got(got);
            }
            if Instant::now() >= until || self.cv.wait_until(&mut state, until).timed_out() {
                // One last look: a message may have landed as the clock ran out.
                if state.cancelled {
                    return Wait::Cancelled;
                }
                return pick(&state).map_or(Wait::TimedOut, Wait::Got);
            }
        }
    }

    pub fn wait_begin(&self, until: Instant) -> Wait<Begin> {
        self.wait(until, |s| s.begin.clone())
    }

    pub fn wait_ready(&self, until: Instant) -> Wait<()> {
        self.wait(until, |s| s.ready.then_some(()))
    }

    pub fn wait_done(&self, until: Instant) -> Wait<()> {
        self.wait(until, |s| s.done.then_some(()))
    }
}

// ---------------------------------------------------------------- work in parallel with the motion

/// Work started on its own thread while the motion plays (creating the pop-outs hidden). The switch never waits for it
/// to START the motion; `finish` joins it before the windows are shown.
#[derive(Default)]
pub struct Background(Option<std::thread::JoinHandle<()>>);

impl Background {
    pub fn spawn(work: impl FnOnce() + Send + 'static) -> Self {
        Background(Some(std::thread::spawn(work)))
    }

    /// Wait for the work to end (a panic in it is not the switch's problem: the windows are then built at show time).
    pub fn join(&mut self) {
        if let Some(handle) = self.0.take() {
            let _ = handle.join();
        }
    }
}

// ---------------------------------------------------------------- the click clock

static CLICK: Mutex<Option<Instant>> = parking_lot::const_mutex(None);

/// The moment the person clicked (the cockpit sends its own timestamp; without one, now).
pub fn note_click(ago_ms: Option<u64>) {
    let ago = Duration::from_millis(ago_ms.unwrap_or(0).min(5000));
    *CLICK.lock() = Some(Instant::now().checked_sub(ago).unwrap_or_else(Instant::now));
}

/// Milliseconds since the click, for the log.
pub fn since_click_ms() -> Option<u64> {
    CLICK.lock().map(|t| t.elapsed().as_millis() as u64)
}

// ---------------------------------------------------------------- the sequence

/// How a switch ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The overlay said it was done.
    Animated,
    /// The stage could not play (no windows to move): switched at once.
    Skipped,
    /// The cockpit did not hand over proxies in time (not listening, hidden ...): switched at once.
    BeginTimeout,
    /// The cockpit had nothing to animate.
    NoProxies,
    /// The overlay never showed a first frame: switched at once.
    ReadyTimeout,
    /// The overlay never said done: the hard timeout finished the switch.
    DoneTimeout,
    /// A newer switch took over: this one jumped to its end state.
    Cancelled,
}

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub begin: Duration,
    pub ready: Duration,
    pub slack: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            begin: Duration::from_millis(BEGIN_WAIT_MS),
            ready: Duration::from_millis(READY_WAIT_MS),
            slack: Duration::from_millis(HARD_TIMEOUT_SLACK_MS),
        }
    }
}

/// The window work of one direction. `glue.rs` implements it with real windows; the tests with a recorder.
pub trait Stage {
    /// "individual" or "orchestration", for the log.
    fn direction(&self) -> &'static str {
        ""
    }
    /// The style the setting asked for, for the log and the reduced-motion check.
    fn style(&self) -> Option<AnimStyle> {
        None
    }
    /// Plan and prepare (pop-outs created hidden, the cockpit told). False: nothing to animate.
    fn announce(&mut self) -> bool;
    /// Show the overlay and start the motion.
    fn start_overlay(&mut self, begin: &Begin);
    /// The overlay drew its first frame: the real windows may hide behind it (coming back).
    fn after_ready(&mut self);
    /// The end state of the direction: windows shown or destroyed, overlay hidden, the cockpit told. Always called once.
    fn finish(&mut self, outcome: Outcome);
}

/// Run one switch to its end. Every branch ends in `stage.finish` exactly once, whatever the cockpit or the overlay do.
/// Each phase is logged at INFO with the time since the switch began, so one live run explains itself.
pub fn drive<S: Stage>(stage: &mut S, mailbox: &Mailbox, timeouts: &Timeouts) -> Outcome {
    let t0 = Instant::now();
    let ms = |since: Instant| since.elapsed().as_millis() as u64;
    let direction = stage.direction();
    let end = |stage: &mut S, outcome: Outcome| {
        tracing::info!(direction, ?outcome, elapsed_ms = ms(t0), "switch finishing");
        stage.finish(outcome);
        outcome
    };
    if mailbox.is_cancelled() {
        return end(stage, Outcome::Cancelled);
    }
    if !stage.announce() {
        return end(stage, Outcome::Skipped);
    }
    tracing::info!(direction, style = ?stage.style(), elapsed_ms = ms(t0), "switch announced, waiting for the cockpit's proxies");
    let begin = match mailbox.wait_begin(Instant::now() + timeouts.begin) {
        Wait::Got(b) if b.animated > 0 => b,
        Wait::Got(_) => return end(stage, Outcome::NoProxies),
        Wait::TimedOut => return end(stage, Outcome::BeginTimeout),
        Wait::Cancelled => return end(stage, Outcome::Cancelled),
    };
    tracing::info!(
        direction, click_through = OVERLAY_CLICK_THROUGH, style = ?stage.style(), motion = begin.motion(), total_ms = begin.total_ms, animated = begin.animated,
        proxies = %begin.proxy_summary(), elapsed_ms = ms(t0), "switch begin from the cockpit"
    );
    if let Some(style) = stage.style() {
        if motion_overridden(style, begin.motion()) {
            tracing::warn!(?style, motion = begin.motion(), "the cockpit played a different motion than the setting (reduced motion there?)");
        }
    }
    let started = Instant::now();
    stage.start_overlay(&begin);
    let ready_at = match mailbox.wait_ready(started + timeouts.ready.min(hard_timeout(begin.total_ms, timeouts.slack))) {
        Wait::Got(()) => {
            tracing::info!(direction, click_to_first_frame_ms = since_click_ms(), "switch click->first frame");
            tracing::info!(direction, click_through = OVERLAY_CLICK_THROUGH, ready_ms = ms(started), info = %info_text(mailbox.ready_info()), "overlay ready");
            stage.after_ready();
            Instant::now()
        }
        Wait::TimedOut => {
            tracing::warn!(direction, waited_ms = ms(started), "overlay never reported ready");
            return end(stage, Outcome::ReadyTimeout);
        }
        Wait::Cancelled => return end(stage, Outcome::Cancelled),
    };
    // The overlay starts the motion when it says ready, so the end is timed from there, not from showing the window.
    match mailbox.wait_done(ready_at + hard_timeout(begin.total_ms, timeouts.slack)) {
        Wait::Got(()) => {
            tracing::info!(direction, done_after_ms = ms(ready_at), expected_ms = begin.total_ms, info = %info_text(mailbox.done_info()), "overlay done");
            // An overlay that says it is done before the motion could have ended is not believed: hold to the end.
            let floor = ready_at + Duration::from_millis(begin.total_ms);
            if Instant::now() < floor {
                tracing::warn!(direction, early_by_ms = floor.saturating_duration_since(Instant::now()).as_millis() as u64, "overlay done early, holding to the end of the motion");
                if let Wait::Cancelled = mailbox.wait(floor, |_| None::<()>) {
                    return end(stage, Outcome::Cancelled);
                }
            }
            end(stage, Outcome::Animated)
        }
        Wait::TimedOut => {
            tracing::warn!(direction, waited_ms = ms(ready_at), "overlay never reported done, hard timeout");
            end(stage, Outcome::DoneTimeout)
        }
        Wait::Cancelled => end(stage, Outcome::Cancelled),
    }
}

fn info_text(info: Option<Value>) -> String {
    info.map_or_else(|| "none".into(), |v| v.to_string())
}

// ---------------------------------------------------------------- one switch at a time

static GEN: AtomicU64 = AtomicU64::new(0);
static CURRENT: Lazy<Mutex<Option<(u64, Arc<Mailbox>)>>> = Lazy::new(|| Mutex::new(None));
static RUN_LOCK: Mutex<()> = Mutex::new(());

/// A switch's turn. Holding it means no other switch is moving windows.
pub struct Turn {
    pub gen: u64,
    pub mailbox: Arc<Mailbox>,
    _guard: MutexGuard<'static, ()>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut current = CURRENT.lock();
        if current.as_ref().is_some_and(|(gen, _)| *gen == self.gen) {
            *current = None;
        }
    }
}

/// Start a switch. A switch still in flight is cancelled (it jumps to its end state), and this waits for it to
/// finish before returning, so the new one starts from a settled set of windows.
pub fn take_turn() -> Turn {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let mailbox = Arc::new(Mailbox::new());
    if let Some((_, older)) = CURRENT.lock().replace((gen, mailbox.clone())) {
        older.cancel();
    }
    let guard = RUN_LOCK.lock();
    Turn { gen, mailbox, _guard: guard }
}

/// A turn only if no switch is running (the Settings preview must never cut a real switch short).
pub fn try_turn() -> Option<Turn> {
    let guard = RUN_LOCK.try_lock()?;
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let mailbox = Arc::new(Mailbox::new());
    *CURRENT.lock() = Some((gen, mailbox.clone()));
    Some(Turn { gen, mailbox, _guard: guard })
}

fn mailbox_for(gen: u64) -> Option<Arc<Mailbox>> {
    let current = CURRENT.lock();
    // gen 0 is the overlay's preview, which has no number of its own: it belongs to whatever turn is running.
    current.as_ref().filter(|(g, _)| gen == 0 || *g == gen).map(|(_, mb)| mb.clone())
}

/// `mode_switch_begin`: the cockpit hands over its proxies. A stale generation is ignored.
pub fn post_begin(gen: u64, spec: Value) -> bool {
    mailbox_for(gen).map(|mb| mb.post_begin(Begin::from_spec(spec))).is_some()
}

pub fn post_ready(gen: u64, info: Option<Value>) -> bool {
    mailbox_for(gen).map(|mb| mb.post_ready_with(info)).is_some()
}

pub fn post_done(gen: u64, info: Option<Value>) -> bool {
    mailbox_for(gen).map(|mb| mb.post_done_with(info)).is_some()
}

#[cfg(test)]
mod tests;
