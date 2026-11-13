use super::*;
use serde_json::json;

fn on() -> PetSettings {
    PetSettings::from_settings(&json!({ "desktop_pet_enabled": true }))
}

#[test]
fn the_pet_is_off_by_default_and_no_window_is_planned() {
    let off = PetSettings::from_settings(&crate::settings_store::default_public_settings());
    assert!(!off.enabled);
    assert_eq!(plan(&off, 1_000, false), Plan::Close);
    assert_eq!(plan(&PetSettings::default(), 1_000, false), Plan::Close);
}

#[test]
fn the_window_is_built_only_when_the_switch_is_on() {
    assert_eq!(plan(&on(), 1_000, false), Plan::Create);
    assert_eq!(plan(&on(), 1_000, true), Plan::Resize);
    let off = PetSettings { enabled: false, ..on() };
    assert_eq!(plan(&off, 1_000, true), Plan::Close);
}

#[test]
fn hide_for_an_hour_closes_the_window_until_the_time_passes() {
    let hidden = PetSettings { hidden_until_ms: 5_000, ..on() };
    assert_eq!(plan(&hidden, 4_999, true), Plan::Close);
    assert_eq!(hidden_for_ms(&hidden, 4_000), Some(1_000));
    assert_eq!(plan(&hidden, 5_000, false), Plan::Create);
    assert_eq!(hidden_for_ms(&hidden, 5_000), None);
    // Off wins over "hidden": nothing is scheduled for a pet that is switched off.
    assert_eq!(hidden_for_ms(&PetSettings { enabled: false, ..hidden }, 4_000), None);
}

#[test]
fn the_window_is_transparent_frameless_on_top_out_of_the_taskbar_and_never_takes_focus() {
    let spec = window_spec(PetSize::Medium);
    assert!(spec.transparent && !spec.decorations && spec.always_on_top && spec.skip_taskbar);
    assert!(!spec.focused, "must not take focus when it appears");
    assert!(!spec.focusable, "must never be activated by a click or by showing");
    assert!(!spec.resizable && !spec.shadow);
    assert!(!spec.visible, "placed first, then shown without activating");
    assert_eq!(spec.label, "pet");
    assert_eq!(spec.url, "index.html?pet=1");
}

#[test]
fn the_medium_window_is_about_140_by_160_and_the_others_scale() {
    assert_eq!(compact_size(PetSize::Medium), (140.0, 160.0));
    assert!(compact_size(PetSize::Small).0 < compact_size(PetSize::Medium).0);
    assert!(compact_size(PetSize::Large).1 > compact_size(PetSize::Medium).1);
    let (w, h) = expanded_size(PetSize::Medium);
    assert!(w >= EXPANDED_MIN_WIDTH && h > compact_size(PetSize::Medium).1);
}

#[test]
fn settings_are_read_with_safe_defaults() {
    let s = PetSettings::from_settings(&json!({ "desktop_pet_enabled": true, "desktop_pet_size": "large", "desktop_pet_hidden_until_ms": 9 }));
    assert_eq!((s.enabled, s.size, s.hidden_until_ms), (true, PetSize::Large, 9));
    let odd = PetSettings::from_settings(&json!({ "desktop_pet_enabled": "yes", "desktop_pet_size": 3 }));
    assert_eq!((odd.enabled, odd.size, odd.hidden_until_ms), (false, PetSize::Medium, 0));
}

#[test]
fn the_default_spot_is_the_bottom_right_of_the_work_area() {
    let work = Rect::new(0.0, 0.0, 1920.0, 1040.0);
    assert_eq!(default_position(work, 140.0, 160.0, 12.0), (1768.0, 868.0));
    // A second monitor to the right: its own corner.
    let right = Rect::new(1920.0, 0.0, 1280.0, 1000.0);
    assert_eq!(default_position(right, 140.0, 160.0, 12.0), (3048.0, 828.0));
}

#[test]
fn a_position_is_clamped_to_the_work_area() {
    let work = Rect::new(0.0, 0.0, 1000.0, 600.0);
    assert_eq!(clamp((-50.0, -50.0), work, 140.0, 160.0), (0.0, 0.0));
    assert_eq!(clamp((990.0, 590.0), work, 140.0, 160.0), (860.0, 440.0));
    assert_eq!(clamp((100.0, 100.0), work, 140.0, 160.0), (100.0, 100.0));
    assert_eq!(clamp((f64::NAN, 100.0), work, 140.0, 160.0), (0.0, 100.0));
    // Smaller than the window: pinned to the top-left, never a negative range.
    assert_eq!(clamp((50.0, 50.0), Rect::new(10.0, 20.0, 100.0, 100.0), 140.0, 160.0), (10.0, 20.0));
}

#[test]
fn opening_a_bubble_keeps_the_bottom_right_corner_and_stays_on_screen() {
    let work = Rect::new(0.0, 0.0, 1000.0, 600.0);
    let compact = compact_size(PetSize::Medium);
    let big = expanded_size(PetSize::Medium);
    let pos = (860.0, 440.0);
    let grown = anchored_resize(pos, compact, big, work);
    assert_eq!((grown.0 + big.0, grown.1 + big.1), (pos.0 + compact.0, pos.1 + compact.1));
    // Near the left edge the corner cannot be kept: it is pulled back inside.
    let near_left = anchored_resize((0.0, 440.0), compact, big, work);
    assert_eq!(near_left.0, 0.0);
    // Giving the room back returns to where it was.
    assert_eq!(anchored_resize(grown, big, compact, work), pos);
}

#[test]
fn positions_are_remembered_per_monitor_and_clamped_when_the_screen_changed() {
    let a = Rect::new(0.0, 0.0, 1920.0, 1040.0);
    let b = Rect::new(1920.0, 0.0, 1280.0, 1000.0);
    let monitors = vec![(monitor_key(a), a), (monitor_key(b), b)];
    let mut saved = Saved::default();
    // Nothing saved: the primary monitor's corner.
    assert_eq!(saved.start_position(&monitors, 0, 140.0, 160.0), Some((1768.0, 868.0)));
    saved.remember(&monitor_key(b), (2000.0, 100.0));
    assert_eq!(saved.start_position(&monitors, 0, 140.0, 160.0), Some((2000.0, 100.0)), "the monitor it was last on");
    saved.remember(&monitor_key(a), (400.0, 300.0));
    assert_eq!(saved.spots.len(), 2, "one spot per monitor");
    // That monitor was unplugged: back to the primary one, at its own saved spot.
    assert_eq!(saved.start_position(&monitors[..1], 0, 140.0, 160.0), Some((400.0, 300.0)));
    // A resolution change moved the edge in: the spot is pulled inside.
    let smaller = Rect::new(0.0, 0.0, 800.0, 600.0);
    let shrunk = vec![(monitor_key(a), smaller)];
    assert_eq!(saved.start_position(&shrunk, 0, 140.0, 160.0), Some((400.0, 300.0)));
    saved.remember(&monitor_key(a), (1900.0, 1000.0));
    assert_eq!(saved.start_position(&shrunk, 0, 140.0, 160.0), Some((660.0, 440.0)));
    assert_eq!(saved.start_position(&[], 0, 140.0, 160.0), None);
}

#[test]
fn saved_spots_survive_a_round_trip_and_garbage_is_ignored() {
    let mut saved = Saved::default();
    saved.remember("0,0,1920x1080", (10.5, 20.0));
    assert_eq!(Saved::parse(&saved.to_json()), saved);
    assert_eq!(Saved::parse("not json"), Saved::default());
    assert_eq!(Saved::parse(r#"{"spots":{"a":["x",1],"b":[1,2]}}"#).spots.len(), 1);
}

#[test]
fn a_full_screen_app_is_told_apart_from_a_normal_desktop() {
    for busy in [2, 3, 4] {
        assert!(fullscreen_from_notification_state(busy), "{busy}");
    }
    for ok in [1, 5, 6, 7] {
        assert!(!fullscreen_from_notification_state(ok), "{ok}");
    }
}
