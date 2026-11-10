use super::*;
use crate::app_windows::{cascade_position, pane_placement, pane_window_size, placement_physical};
use crate::window_layout::{plan_layout, WindowLayout, WorkArea};
use serde_json::json;
use std::sync::Arc;

// ---- the setting

#[test]
fn the_style_round_trips_through_serde_in_lowercase() {
    for (style, text) in [(AnimStyle::Domino, "\"domino\""), (AnimStyle::Ink, "\"ink\""), (AnimStyle::Off, "\"off\"")] {
        assert_eq!(serde_json::to_string(&style).unwrap(), text);
        assert_eq!(serde_json::from_str::<AnimStyle>(text).unwrap(), style);
        assert_eq!(AnimStyle::parse(style.as_str()), Some(style));
    }
    assert!(serde_json::from_str::<AnimStyle>("\"sparkle\"").is_err());
}

#[test]
fn the_setting_reads_from_the_settings_file_and_defaults_to_domino() {
    let file = |v: Value| json!({ "settings": { "mode_switch_animation": v } });
    assert_eq!(style_from_settings(&file(json!("ink"))), AnimStyle::Ink);
    assert_eq!(style_from_settings(&file(json!("off"))), AnimStyle::Off);
    assert_eq!(style_from_settings(&file(json!("domino"))), AnimStyle::Domino);
    assert_eq!(style_from_settings(&file(json!("sparkle"))), AnimStyle::Domino, "unknown reads as the default");
    assert_eq!(style_from_settings(&file(json!(3))), AnimStyle::Domino);
    assert_eq!(style_from_settings(&json!({ "settings": {} })), AnimStyle::Domino);
    assert_eq!(style_from_settings(&json!({})), AnimStyle::Domino);
}

#[test]
fn a_generic_settings_patch_carries_the_setting_to_the_file_and_back() {
    // The setting has no command of its own: it travels in `settings_patch` like any other key.
    let patch = json!({ "mode_switch_animation": "ink" });
    let map = crate::settings_patch::sanitize_patch(&patch, false).unwrap();
    assert!(map.contains_key("mode_switch_animation"), "not an owned-elsewhere key");
    let file = crate::settings_patch::merge_into_file(&json!({ "settings": { "theme": "dark", "ui_mode": "individual" } }), &map);
    assert_eq!(style_from_settings(&file), AnimStyle::Ink);
    assert_eq!(file["settings"]["theme"], "dark", "other keys are kept");
    // Removing it (null) returns to the default.
    let cleared = crate::settings_patch::merge_into_file(&file, &crate::settings_patch::sanitize_patch(&json!({ "mode_switch_animation": null }), false).unwrap());
    assert_eq!(style_from_settings(&cleared), AnimStyle::Domino);
}

// ---- the plan

fn grids() -> Vec<PaneGrid> {
    vec![
        PaneGrid { id: "a".into(), cols: 120, rows: 30 },
        PaneGrid { id: "b".into(), cols: 80, rows: 24 },
        PaneGrid { id: "c".into(), cols: 0, rows: 0 },
    ]
}

#[test]
fn the_plan_uses_the_rects_open_pane_window_would_place() {
    let anchor = Some((-1660.0, 60.0));
    let scale = 1.5;
    let plan = plan_windows(WindowLayout::Cascade, None, anchor, 6, scale, &grids());
    assert_eq!(plan.len(), 3);
    for (i, pane) in grids().iter().enumerate() {
        // open_pane_window places pane i in the next cascade slot with the grid-sized window: exactly `pane_placement`.
        let placed = pane_placement(anchor, 6 + i, pane.cols, pane.rows);
        let (x, y, w, h) = placement_physical(&placed, scale).unwrap();
        assert_eq!(plan[i], WindowRect { id: pane.id.clone(), rect: Rect { x, y, w, h } });
        assert_eq!(placed.pos, Some(cascade_position((-1660.0, 60.0), 6 + i)));
        assert_eq!(placed.size, pane_window_size(pane.cols, pane.rows));
    }
}

#[test]
fn a_pane_without_a_known_position_is_left_out_of_the_plan() {
    assert!(plan_windows(WindowLayout::Cascade, None, None, 0, 1.0, &grids()).is_empty());
}

#[test]
fn the_mini_bar_rect_is_centred_along_the_top_of_the_monitor() {
    let monitor = Monitor { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0, scale: 1.0 };
    let r = mini_bar_rect(&monitor);
    assert_eq!((r.x, r.y, r.w, r.h), (580.0, crate::mini_bar::TOP_MARGIN, crate::mini_bar::WIDTH, crate::mini_bar::HEIGHT));
    // On a 150% monitor to the left everything is in physical pixels.
    let left = Monitor { x: -2880.0, y: 0.0, w: 2880.0, h: 1620.0, scale: 1.5 };
    let r = mini_bar_rect(&left);
    assert_eq!(r.w, crate::mini_bar::WIDTH * 1.5);
    assert_eq!(r.x, (-1920.0 + 580.0) * 1.5);
}

#[test]
fn the_plan_serialises_the_way_the_cockpit_reads_it() {
    let plan = Plan { windows: vec![WindowRect { id: "a".into(), rect: Rect { x: 1.0, y: 2.0, w: 3.0, h: 4.0 } }], mini_bar: None, monitor: None };
    let v = serde_json::to_value(&plan).unwrap();
    assert_eq!(v["windows"][0]["rect"]["w"], 3.0);
    assert!(v.get("miniBar").is_some());
}

// ---- when to animate

#[test]
fn only_a_visible_cockpit_with_panes_animates_to_individual() {
    let ok = WindowState { cockpit_exists: true, cockpit_visible: true, panes: 2, ..Default::default() };
    assert!(should_animate(UiMode::Individual, &ok));
    assert!(!should_animate(UiMode::Individual, &WindowState { cockpit_visible: false, ..ok }), "tray-only: instant");
    assert!(!should_animate(UiMode::Individual, &WindowState { cockpit_minimized: true, ..ok }));
    assert!(!should_animate(UiMode::Individual, &WindowState { cockpit_exists: false, ..ok }));
    assert!(!should_animate(UiMode::Individual, &WindowState { panes: 0, ..ok }), "nothing to move");
}

#[test]
fn coming_back_animates_only_when_pop_outs_are_on_screen() {
    let ok = WindowState { cockpit_exists: true, visible_pop_outs: 3, ..Default::default() };
    assert!(should_animate(UiMode::Orchestration, &ok));
    assert!(!should_animate(UiMode::Orchestration, &WindowState { visible_pop_outs: 0, ..ok }));
    assert!(!should_animate(UiMode::Orchestration, &WindowState { cockpit_exists: false, ..ok }));
}

#[test]
fn the_hard_timeout_is_the_animation_plus_150_ms_and_never_more_than_the_cap() {
    let slack = Duration::from_millis(HARD_TIMEOUT_SLACK_MS);
    assert_eq!(hard_timeout(770, slack), Duration::from_millis(920));
    assert_eq!(hard_timeout(720, slack), Duration::from_millis(870));
    assert_eq!(hard_timeout(0, slack), Duration::from_millis(150));
    assert_eq!(hard_timeout(60_000, slack), Duration::from_millis(MAX_TOTAL_MS + 150), "a bogus length is not believed");
}

#[test]
fn what_the_cockpit_hands_over_is_read_defensively() {
    let b = Begin::from_spec(json!({ "motion": "domino", "totalMs": 770, "proxies": [{}, {}, {}] }));
    assert_eq!((b.total_ms, b.animated), (770, 3));
    let b = Begin::from_spec(json!({ "totalMs": 99999, "proxies": (0..20).map(|_| json!({})).collect::<Vec<_>>() }));
    assert_eq!((b.total_ms, b.animated), (MAX_TOTAL_MS, MAX_ANIMATED));
    let b = Begin::from_spec(json!("garbage"));
    assert_eq!((b.total_ms, b.animated), (0, 0));
    let b = Begin::from_spec(json!({ "totalMs": -5, "proxies": [] }));
    assert_eq!((b.total_ms, b.animated), (0, 0));
}

// ---- how long the motion lasts

#[test]
fn the_motion_lengths_match_the_frontends() {
    // domino: 530 ms flight + 80 ms per later pane, capped at 240 ms of stagger.
    assert_eq!(expected_total_ms("domino", 1), 530);
    assert_eq!(expected_total_ms("domino", 2), 610);
    assert!(expected_total_ms("domino", 2) >= 530);
    assert_eq!(expected_total_ms("domino", 4), 770);
    assert_eq!(expected_total_ms("domino", 8), 770, "the stagger is capped");
    assert_eq!(expected_total_ms("ink", 1), 720);
    assert_eq!(expected_total_ms("ink", 8), 720);
    assert_eq!(expected_total_ms("fade", 3), 120);
    assert_eq!(expected_total_ms("domino", 0), 0);
}

#[test]
fn a_missing_or_zero_length_from_the_cockpit_is_never_believed_over_the_motion() {
    let proxies = json!([{}, {}]);
    for spec in [
        json!({ "motion": "domino", "proxies": proxies }),
        json!({ "motion": "domino", "totalMs": 0, "proxies": proxies }),
        json!({ "motion": "domino", "totalMs": 3, "proxies": proxies }),
    ] {
        let b = Begin::from_spec(spec);
        assert_eq!((b.total_ms, b.animated), (610, 2));
        // the hard timeout is then the motion plus the slack, not 150 ms
        assert_eq!(hard_timeout(b.total_ms, Duration::from_millis(HARD_TIMEOUT_SLACK_MS)), Duration::from_millis(760));
    }
    assert_eq!(Begin::from_spec(json!({ "motion": "ink", "proxies": [{}] })).total_ms, 720);
}

#[test]
fn the_log_names_the_motion_and_every_proxy() {
    let b = Begin::from_spec(json!({
        "motion": "domino",
        "proxies": [{ "id": "acp-65b2aaaaaaaa", "start": { "x": 10.4, "y": 20.0, "w": 300.0, "h": 200.0 }, "end": { "x": 100.0, "y": 120.0, "w": 640.0, "h": 480.0 } }, {}],
    }));
    assert_eq!(b.motion(), "domino");
    let text = b.proxy_summary();
    assert!(text.contains("acp-65b2aaaa (10,20,300x200)->(100,120,640x480)"), "{text}");
    assert!(text.contains("? (none)->(none)"), "{text}");
}

#[test]
fn a_fade_under_a_motion_setting_is_flagged_as_reduced_motion() {
    assert!(!motion_overridden(AnimStyle::Domino, "domino"));
    assert!(!motion_overridden(AnimStyle::Ink, "ink"));
    assert!(motion_overridden(AnimStyle::Domino, "fade"), "reduced motion in the cockpit");
    assert!(motion_overridden(AnimStyle::Ink, "fade"));
    assert!(!motion_overridden(AnimStyle::Off, "fade"), "Off is meant to fade");
}

#[test]
fn the_overlay_hands_over_to_the_real_windows_only_when_it_was_drawing() {
    assert!(overlay_was_drawing(Outcome::Animated));
    assert!(overlay_was_drawing(Outcome::DoneTimeout));
    for o in [Outcome::Skipped, Outcome::BeginTimeout, Outcome::NoProxies, Outcome::ReadyTimeout, Outcome::Cancelled] {
        assert!(!overlay_was_drawing(o));
    }
}

#[test]
fn what_the_overlay_reports_is_kept_for_the_log() {
    let mb = Mailbox::new();
    assert!(mb.ready_info().is_none() && mb.done_info().is_none());
    mb.post_ready_with(Some(json!({ "reducedMotion": false })));
    mb.post_done_with(Some(json!({ "elapsedMs": 612 })));
    assert_eq!(mb.ready_info().unwrap()["reducedMotion"], json!(false));
    assert_eq!(mb.done_info().unwrap()["elapsedMs"], json!(612));
}

// ---- the sequence

#[derive(Default)]
struct Recorder {
    calls: Vec<String>,
    announces: bool,
    finish_outcome: Option<Outcome>,
}

impl Recorder {
    fn new() -> Self {
        Recorder { announces: true, ..Default::default() }
    }
}

impl Stage for Recorder {
    fn announce(&mut self) -> bool {
        self.calls.push("announce".into());
        self.announces
    }
    fn start_overlay(&mut self, begin: &Begin) {
        self.calls.push(format!("overlay:{}", begin.animated));
    }
    fn after_ready(&mut self) {
        self.calls.push("ready".into());
    }
    fn finish(&mut self, outcome: Outcome) {
        self.calls.push(format!("finish:{outcome:?}"));
        assert!(self.finish_outcome.replace(outcome).is_none(), "finish runs exactly once");
    }
}

/// A recorder for the way back: same sequence, the other direction.
struct BackRecorder(Recorder);

impl Stage for BackRecorder {
    fn direction(&self) -> &'static str {
        "orchestration"
    }
    fn announce(&mut self) -> bool {
        self.0.announce()
    }
    fn start_overlay(&mut self, begin: &Begin) {
        self.0.start_overlay(begin)
    }
    fn after_ready(&mut self) {
        self.0.after_ready()
    }
    fn finish(&mut self, outcome: Outcome) {
        self.0.finish(outcome)
    }
}

fn quick() -> Timeouts {
    Timeouts { begin: Duration::from_millis(60), ready: Duration::from_millis(60), slack: Duration::from_millis(40) }
}

fn begin_with(animated: usize, total_ms: u64) -> Begin {
    Begin { total_ms, animated, spec: json!({}) }
}

#[test]
fn a_full_switch_shows_the_overlay_then_finishes_on_the_overlays_done() {
    let mb = Arc::new(Mailbox::new());
    let poster = {
        let mb = mb.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            mb.post_begin(begin_with(3, 200));
            std::thread::sleep(Duration::from_millis(10));
            mb.post_ready_with(None);
            std::thread::sleep(Duration::from_millis(10));
            mb.post_done_with(None);
        })
    };
    let mut stage = Recorder::new();
    let started = Instant::now();
    let timeouts = Timeouts { begin: Duration::from_millis(500), ready: Duration::from_millis(500), slack: Duration::from_millis(150) };
    assert_eq!(drive(&mut stage, &mb, &timeouts), Outcome::Animated);
    let took = started.elapsed();
    // done arrives ~25 ms in, but the motion is 200 ms: the switch holds to its end, and never sits out the 350 ms timeout.
    assert!(took >= Duration::from_millis(200) && took < Duration::from_millis(340), "{took:?}");
    assert_eq!(stage.calls, ["announce", "overlay:3", "ready", "finish:Animated"]);
    poster.join().unwrap();
}

#[test]
fn an_overlay_that_says_done_at_once_does_not_end_the_motion_early() {
    // The bug to catch: done lands right after ready, the switch used to finish in microseconds.
    let mb = Mailbox::new();
    mb.post_begin(Begin::from_spec(json!({ "motion": "domino", "totalMs": 0, "proxies": [{}, {}] })));
    mb.post_ready_with(None);
    mb.post_done_with(None);
    let mut stage = Recorder::new();
    let started = Instant::now();
    let timeouts = Timeouts { begin: Duration::from_millis(500), ready: Duration::from_millis(500), slack: Duration::from_millis(150) };
    assert_eq!(drive(&mut stage, &mb, &timeouts), Outcome::Animated);
    let took = started.elapsed();
    assert!(took >= Duration::from_millis(530), "domino with 2 panes lasts at least 530 ms, took {took:?}");
    assert_eq!(stage.calls, ["announce", "overlay:2", "ready", "finish:Animated"]);
}

#[test]
fn the_way_back_runs_through_the_overlay_too() {
    let mb = Mailbox::new();
    mb.post_begin(begin_with(2, 80));
    mb.post_ready_with(None);
    mb.post_done_with(None);
    let mut stage = BackRecorder(Recorder::new());
    let started = Instant::now();
    assert_eq!(drive(&mut stage, &mb, &quick()), Outcome::Animated);
    assert!(started.elapsed() >= Duration::from_millis(80), "not finished in 0.4 ms");
    assert_eq!(stage.0.calls, ["announce", "overlay:2", "ready", "finish:Animated"]);
}

#[test]
fn the_end_is_timed_from_when_the_overlay_started_not_from_when_it_was_shown() {
    // ready comes 60 ms after the overlay was shown; the motion is 80 ms; done 85 ms after ready is on time,
    // although it is 145 ms after the show (the old deadline: 80 + 40 slack = 120 ms from the show).
    let mb = Arc::new(Mailbox::new());
    mb.post_begin(begin_with(1, 80));
    let poster = {
        let mb = mb.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(45));
            mb.post_ready_with(None);
            std::thread::sleep(Duration::from_millis(85));
            mb.post_done_with(None);
        })
    };
    let mut stage = Recorder::new();
    let timeouts = Timeouts { begin: Duration::from_millis(500), ready: Duration::from_millis(500), slack: Duration::from_millis(40) };
    // ready limit is min(500, 80+40=120): 45 ms is inside it.
    assert_eq!(drive(&mut stage, &mb, &timeouts), Outcome::Animated);
    poster.join().unwrap();
}

#[test]
fn the_switch_still_completes_when_the_overlay_never_says_done() {
    let mb = Arc::new(Mailbox::new());
    mb.post_begin(begin_with(2, 50));
    mb.post_ready_with(None);
    let mut stage = Recorder::new();
    let started = Instant::now();
    assert_eq!(drive(&mut stage, &mb, &quick()), Outcome::DoneTimeout);
    let took = started.elapsed();
    // animation (50 ms) + slack (40 ms): not forever, and not before the animation could end.
    assert!(took >= Duration::from_millis(85) && took < Duration::from_millis(400), "{took:?}");
    assert_eq!(stage.calls, ["announce", "overlay:2", "ready", "finish:DoneTimeout"]);
}

#[test]
fn the_switch_completes_without_an_overlay_at_all() {
    // Nobody ever answers: no begin, no ready, no done.
    let mut stage = Recorder::new();
    assert_eq!(drive(&mut stage, &Mailbox::new(), &quick()), Outcome::BeginTimeout);
    assert_eq!(stage.calls, ["announce", "finish:BeginTimeout"]);
}

#[test]
fn an_overlay_that_never_draws_ends_the_switch_at_its_ready_timeout() {
    let mb = Mailbox::new();
    mb.post_begin(begin_with(1, 700));
    let mut stage = Recorder::new();
    let started = Instant::now();
    assert_eq!(drive(&mut stage, &mb, &quick()), Outcome::ReadyTimeout);
    assert!(started.elapsed() < Duration::from_millis(300), "ready is not waited for the whole animation");
    assert_eq!(stage.calls, ["announce", "overlay:1", "finish:ReadyTimeout"]);
}

#[test]
fn a_cockpit_with_nothing_to_animate_switches_at_once() {
    let mb = Mailbox::new();
    mb.post_begin(begin_with(0, 0));
    let mut stage = Recorder::new();
    assert_eq!(drive(&mut stage, &mb, &quick()), Outcome::NoProxies);
    assert_eq!(stage.calls, ["announce", "finish:NoProxies"]);
}

#[test]
fn a_stage_with_nothing_to_move_is_skipped() {
    let mut stage = Recorder { announces: false, ..Recorder::new() };
    assert_eq!(drive(&mut stage, &Mailbox::new(), &quick()), Outcome::Skipped);
    assert_eq!(stage.calls, ["announce", "finish:Skipped"]);
}

#[test]
fn a_switch_cancelled_before_it_starts_only_jumps_to_its_end_state() {
    let mb = Mailbox::new();
    mb.cancel();
    let mut stage = Recorder::new();
    assert_eq!(drive(&mut stage, &mb, &quick()), Outcome::Cancelled);
    assert_eq!(stage.calls, ["finish:Cancelled"]);
}

#[test]
fn a_cancel_while_waiting_wakes_the_switch_and_ends_it_at_once() {
    let mb = Arc::new(Mailbox::new());
    mb.post_begin(begin_with(2, 2000));
    mb.post_ready_with(None);
    let canceller = {
        let mb = mb.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            mb.cancel();
        })
    };
    let mut stage = Recorder::new();
    let started = Instant::now();
    let timeouts = Timeouts { begin: Duration::from_millis(500), ready: Duration::from_millis(500), slack: Duration::from_millis(150) };
    assert_eq!(drive(&mut stage, &mb, &timeouts), Outcome::Cancelled);
    assert!(started.elapsed() < Duration::from_millis(500), "does not wait out the 2 s animation");
    assert_eq!(stage.calls.last().unwrap(), "finish:Cancelled");
    canceller.join().unwrap();
}

// ---- one switch at a time (these use the process-wide turn lock, so they live in one test)

#[test]
fn a_second_switch_cancels_the_first_and_waits_for_it_to_settle() {
    let first = take_turn();
    let first_gen = first.gen;
    let first_box = first.mailbox.clone();
    assert!(!first_box.is_cancelled());
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let second = {
        let order = order.clone();
        std::thread::spawn(move || {
            let turn = take_turn();
            order.lock().push("second starts");
            assert!(turn.gen > first_gen);
            drop(turn);
        })
    };
    // The second one cancels the first right away, but cannot start until the first lets go.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !first_box.is_cancelled() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(first_box.is_cancelled(), "the newer switch cancels the one in flight");
    std::thread::sleep(Duration::from_millis(30));
    assert!(order.lock().is_empty(), "it waits for the first to reach its end state");
    // Messages for the old switch are ignored once a newer one is current.
    assert!(!post_done(first_gen + 100, None));
    order.lock().push("first settled");
    drop(first);
    second.join().unwrap();
    assert_eq!(*order.lock(), ["first settled", "second starts"]);
    // Nothing is left registered.
    assert!(!post_begin(first_gen, json!({})));
}

#[test]
fn the_overlay_window_is_not_click_through_and_never_takes_focus() {
    // Click-through means WS_EX_LAYERED, which turned the transparent window opaque: it must not come back.
    assert!(!OVERLAY_CLICK_THROUGH);
    let glue = include_str!("glue.rs");
    let code: String = glue.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("
");
    assert!(!code.contains("set_ignore_cursor_events"));
    assert!(!code.contains("set_focus"));
    assert!(code.contains(".transparent(true)") && code.contains(".focused(false)") && code.contains(".focusable(false)"));
    // hidden right after the handoff
    assert!(code.contains("fn hand_off_from_overlay") && code.contains("hide_overlay(app)"));
}

#[test]
fn plan_mode_switch_returns_the_rects_the_real_pop_outs_get() {
    // `plan_mode_switch` is `plan_windows`; the switch itself (animated or instant) opens each pop-out at
    // `plan_layout(...)[i]`, and `placement_physical` of it is the window's outer rect. Same inputs, same rects.
    let area = Some(WorkArea { x: -2880.0, y: 0.0, w: 2880.0, h: 1560.0, scale: 1.5 });
    for layout in [WindowLayout::SideBySide, WindowLayout::Cascade] {
        for n in [1usize, 3, 6, 11] {
            let panes: Vec<PaneGrid> = (0..n).map(|i| PaneGrid { id: format!("p{i}"), cols: 120, rows: 30 }).collect();
            let anchor = Some((-2880.0 / 1.5, 0.0));
            let planned = plan_windows(layout, area, anchor, 2, 1.5, &panes);
            let grids: Vec<(u16, u16)> = panes.iter().map(|p| (p.cols, p.rows)).collect();
            let real = plan_layout(layout, area, anchor, 2, &grids);
            assert_eq!(planned.len(), n);
            for (i, w) in planned.iter().enumerate() {
                let (x, y, ww, hh) = placement_physical(&real[i], 1.5).unwrap();
                assert_eq!(w, &WindowRect { id: format!("p{i}"), rect: Rect { x, y, w: ww, h: hh } }, "{layout:?} n={n} pane {i}");
            }
        }
    }
}

/// A stage whose pop-outs take 400 ms to create, like a slow webview build. It starts the creation in `announce` (as the
/// real stage does) and joins it in `finish`.
struct SlowCreate {
    creating: Background,
    began: Instant,
    overlay_at: Option<Duration>,
    finished_at: Option<Duration>,
    created: Arc<std::sync::atomic::AtomicBool>,
}

impl Stage for SlowCreate {
    fn announce(&mut self) -> bool {
        let created = self.created.clone();
        self.creating = Background::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            created.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        true
    }
    fn start_overlay(&mut self, _begin: &Begin) {
        self.overlay_at = Some(self.began.elapsed());
    }
    fn after_ready(&mut self) {}
    fn finish(&mut self, _outcome: Outcome) {
        self.creating.join();
        self.finished_at = Some(self.began.elapsed());
    }
}

#[test]
fn the_motion_starts_without_waiting_for_the_pop_outs_to_be_created() {
    let mb = Mailbox::new();
    mb.post_begin(begin_with(2, 50));
    mb.post_ready_with(None);
    mb.post_done_with(None);
    let created = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut stage = SlowCreate { creating: Background::default(), began: Instant::now(), overlay_at: None, finished_at: None, created: created.clone() };
    let timeouts = Timeouts { begin: Duration::from_millis(500), ready: Duration::from_millis(500), slack: Duration::from_millis(150) };
    assert_eq!(drive(&mut stage, &mb, &timeouts), Outcome::Animated);
    let overlay_at = stage.overlay_at.unwrap();
    assert!(overlay_at < Duration::from_millis(100), "the overlay started after {overlay_at:?}: it waited on window creation");
    // The windows are only shown once they exist: finish joined the creation.
    assert!(created.load(std::sync::atomic::Ordering::SeqCst));
    assert!(stage.finished_at.unwrap() >= Duration::from_millis(400));
}

#[test]
fn the_click_clock_measures_from_the_click() {
    note_click(Some(30));
    assert!(since_click_ms().unwrap() >= 30);
    note_click(None);
    assert!(since_click_ms().unwrap() < 30);
}
