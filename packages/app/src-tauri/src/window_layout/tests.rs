use super::*;
use crate::app_windows::{cascade_position, pane_placement, placement_physical};
use serde_json::json;

const EPS: f64 = 1e-6;
type R = (f64, f64, f64, f64);

/// A 1920x1080 monitor with a 40 px taskbar at the bottom, scale 1.
fn area() -> WorkArea {
    WorkArea { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0, scale: 1.0 }
}

fn grids(n: usize) -> Vec<(u16, u16)> {
    vec![(120, 30); n]
}

fn rects(a: WorkArea, n: usize) -> Vec<R> {
    plan_layout(WindowLayout::SideBySide, Some(a), Some((0.0, 0.0)), 0, &grids(n)).iter().map(|p| placement_physical(p, a.scale).unwrap()).collect()
}

fn overlaps(a: R, b: R) -> bool {
    a.0 < b.0 + b.2 - EPS && b.0 < a.0 + a.2 - EPS && a.1 < b.1 + b.3 - EPS && b.1 < a.1 + a.3 - EPS
}

fn assert_no_overlap(rs: &[R]) {
    for i in 0..rs.len() {
        for j in i + 1..rs.len() {
            assert!(!overlaps(rs[i], rs[j]), "{i} and {j} overlap: {:?} {:?}", rs[i], rs[j]);
        }
    }
}

fn assert_inside(a: WorkArea, rs: &[R]) {
    let top = a.y + mini_bar_band() * a.scale;
    for r in rs {
        assert!(r.0 >= a.x + OUTER_MARGIN * a.scale - 1.0, "left {r:?}");
        assert!(r.1 >= top - 1.0, "below the mini bar band {r:?}");
        assert!(r.0 + r.2 <= a.x + a.w - OUTER_MARGIN * a.scale + 1.0, "right {r:?}");
        assert!(r.1 + r.3 <= a.y + a.h - OUTER_MARGIN * a.scale + 1.0, "bottom {r:?}");
    }
}

#[test]
fn the_band_is_the_mini_bars_margin_height_and_one_more_margin() {
    assert_eq!(mini_bar_band(), crate::mini_bar::TOP_MARGIN + crate::mini_bar::HEIGHT + 8.0);
}

const NORMAL: (f64, f64) = (870.0, 480.0); // pane_window_size(120, 30)

#[test]
fn the_normal_size_is_the_pop_out_default() {
    assert_eq!(crate::app_windows::pane_window_size(120, 30), NORMAL);
}

#[test]
fn no_overlap_and_inside_the_area_for_1_2_3_4_6_9_and_14() {
    for n in [1, 2, 3, 4, 6, 9, 14] {
        let rs = rects(area(), n);
        assert_eq!(rs.len(), n);
        assert_inside(area(), &rs);
        let in_grid = arrange(NORMAL, n, (1904.0, 1040.0 - mini_bar_band() - OUTER_MARGIN)).fitting;
        assert_no_overlap(&rs[..in_grid.min(n)]);
    }
}

#[test]
fn windows_are_never_bigger_than_normal_and_all_the_same_size_when_they_fit() {
    for n in 1..=4 {
        let rs = rects(area(), n);
        for r in &rs {
            assert_eq!((r.2, r.3), NORMAL, "n={n}: normal size, not stretched to a cell");
        }
    }
    for n in [1, 2, 3, 4, 5, 6, 9, 14, 30] {
        for r in rects(area(), n) {
            assert!(r.2 <= NORMAL.0 + 1.0 && r.3 <= NORMAL.1 + 1.0, "n={n}: {r:?} grew");
        }
    }
    // A lone window on a huge screen is still its normal size.
    let huge = WorkArea { x: 0.0, y: 0.0, w: 3840.0, h: 2100.0, scale: 1.0 };
    assert_eq!((rects(huge, 1)[0].2, rects(huge, 1)[0].3), NORMAL);
}

#[test]
fn windows_shrink_only_when_they_do_not_fit_keeping_aspect_and_the_floor() {
    // 1904 wide: two 870s and the gap need 1748, three need 2626. 3 panes shrink (or wrap), 2 do not.
    let two = rects(area(), 2);
    assert_eq!((two[0].2, two[0].3), NORMAL);
    let narrow = WorkArea { x: 0.0, y: 0.0, w: 1100.0, h: 1040.0, scale: 1.0 };
    let one_col = rects(narrow, 2);
    assert_eq!((one_col[0].2, one_col[0].3), NORMAL, "wraps to a second row instead of shrinking when height allows");
    assert!(one_col[1].1 > one_col[0].1);
    // Not enough room even for rows: shrink uniformly, aspect kept, never under the floor.
    let small = WorkArea { x: 0.0, y: 0.0, w: 1100.0, h: 700.0, scale: 1.0 };
    let rs = rects(small, 2);
    for r in &rs {
        assert!(r.2 < NORMAL.0 && r.2 >= FLOOR.0 - 1.0 && r.3 >= FLOOR.1 - 1.0);
        assert!((r.2 / r.3 - NORMAL.0 / NORMAL.1).abs() < 0.01, "aspect kept");
    }
    assert_eq!((rs[0].2, rs[0].3), (rs[1].2, rs[1].3), "the same factor for all");
    assert_no_overlap(&rs);
    // The shrink is the smallest that fits: a slightly bigger factor would not have held both.
    let a = arrange(NORMAL, 2, (1084.0, 700.0 - mini_bar_band() - OUTER_MARGIN));
    assert!(a.factor < 1.0 && a.factor >= FLOOR.0 / NORMAL.0);
    let bigger = arrange(NORMAL, 2, (1084.0, 700.0 - mini_bar_band() - OUTER_MARGIN));
    assert_eq!(a, bigger);
}

#[test]
fn a_window_already_under_the_floor_is_never_grown() {
    let tiny_cell = (300.0, 200.0);
    let a = arrange(tiny_cell, 2, (1900.0, 1000.0));
    assert_eq!(a.factor, 1.0);
}

#[test]
fn the_group_is_centred_horizontally_and_starts_under_the_mini_bar() {
    for n in [2, 3] {
        let rs = rects(area(), n);
        let left = rs.iter().map(|r| r.0).fold(f64::MAX, f64::min);
        let right = rs.iter().map(|r| r.0 + r.2).fold(f64::MIN, f64::max);
        assert!((left - (1920.0 - right)).abs() < 1.0, "n={n}: equal space left and right");
        assert_eq!(rs[0].1, mini_bar_band());
    }
    // Rows run left to right, then the next row; gaps are exactly 8.
    let rs = rects(area(), 4);
    assert_eq!(rs[1].0 - (rs[0].0 + rs[0].2), GAP);
    assert_eq!(rs[0].0, rs[2].0);
    assert_eq!(rs[2].1 - (rs[0].1 + rs[0].3), GAP);
    assert_eq!(rs[0].1, rs[1].1);
}

#[test]
fn one_window_is_its_normal_size_and_centred() {
    let r = rects(area(), 1)[0];
    assert_eq!((r.2, r.3), NORMAL);
    assert!((r.0 + r.2 / 2.0 - 960.0).abs() < 1.0);
    let ah = 1040.0 - mini_bar_band() - OUTER_MARGIN;
    assert!((r.1 + r.3 / 2.0 - (mini_bar_band() + ah / 2.0)).abs() < 1.0);
}

#[test]
fn what_does_not_fit_at_the_floor_cascades_on_top_of_the_grid_from_its_top_left() {
    // 1904 x 1024 usable... at the floor (400x300) windows of 870x480 shrink to 0.625 (544x300): 3 columns x 3 rows.
    let rs = rects(area(), 14);
    let a = arrange(NORMAL, 14, (1904.0, 1040.0 - mini_bar_band() - OUTER_MARGIN));
    assert!(a.fitting < 14 && a.fitting > 0);
    assert_no_overlap(&rs[..a.fitting]);
    let top = mini_bar_band();
    let k0 = rs[a.fitting];
    assert_eq!(k0.1, top, "the first overflow window is at the grid's top");
    assert_eq!(k0.0, OUTER_MARGIN);
    assert!(rs[a.fitting + 1].0 > k0.0 && rs[a.fitting + 1].1 > k0.1);
    for r in &rs[a.fitting..] {
        assert!(r.2 >= FLOOR.0 - 1.0 && r.3 >= FLOOR.1 - 1.0);
    }
    assert_inside(area(), &rs);
}

#[test]
fn a_screen_too_small_for_one_floor_cell_cascades_everything() {
    let tiny = WorkArea { x: 0.0, y: 0.0, w: 500.0, h: 400.0, scale: 1.0 };
    let rs = rects(tiny, 3);
    assert_eq!((rs[0].0, rs[0].1), (OUTER_MARGIN, mini_bar_band()));
    assert!(rs[1].0 >= rs[0].0 && rs[2].0 >= rs[1].0);
    assert_inside(tiny, &rs);
}

#[test]
fn a_scaled_monitor_gives_correct_physical_rects() {
    // 2880x1620 physical at 1.5 (1920x1080 logical), left of the primary, a 60 physical px taskbar.
    let a = WorkArea { x: -2880.0, y: 0.0, w: 2880.0, h: 1560.0, scale: 1.5 };
    let placements = plan_layout(WindowLayout::SideBySide, Some(a), None, 0, &grids(2));
    let rs: Vec<R> = placements.iter().map(|p| placement_physical(p, 1.5).unwrap()).collect();
    assert_inside(a, &rs);
    assert_no_overlap(&rs);
    // Normal size in physical pixels, the logical gap of 8 is 12, the group is centred on the monitor.
    assert_eq!((rs[0].2, rs[0].3), (NORMAL.0 * 1.5, NORMAL.1 * 1.5));
    assert_eq!(rs[1].0 - (rs[0].0 + rs[0].2), 12.0);
    assert!(((rs[0].0 - a.x) - (a.x + a.w - (rs[1].0 + rs[1].2))).abs() <= 1.0);
    assert_eq!(rs[0].1, 1.5 * mini_bar_band());
    let (x, y, w, h) = placements[0].phys.unwrap();
    assert_eq!(placements[0].pos, Some((x / 1.5, y / 1.5)));
    assert_eq!(placements[0].size, (w / 1.5, h / 1.5));
    // Odd sizes: touching neighbours never overlap by a rounding pixel.
    let odd = WorkArea { x: 0.0, y: 0.0, w: 2561.0, h: 1441.0, scale: 1.25 };
    assert_no_overlap(&rects(odd, 6));
    assert_no_overlap(&rects(odd, 4));
}

#[test]
fn cascade_and_no_work_area_are_todays_placements() {
    let anchor = Some((-1660.0, 60.0));
    let g = [(120u16, 30u16), (80, 24), (0, 0)];
    let today = crate::app_windows::plan_placements(anchor, 4, &g);
    assert_eq!(plan_layout(WindowLayout::Cascade, Some(area()), anchor, 4, &g), today);
    assert_eq!(plan_layout(WindowLayout::SideBySide, None, anchor, 4, &g), today);
    assert_eq!(today[1], pane_placement(anchor, 5, 80, 24));
    assert_eq!(today[0].pos, Some(cascade_position((-1660.0, 60.0), 4)));
    assert_eq!(today[0].phys, None);
}

#[test]
fn the_order_is_the_cockpits_then_the_rest_in_registry_order_without_ghosts_or_repeats() {
    let all: Vec<String> = ["a", "b", "c", "d", "e"].iter().map(|s| s.to_string()).collect();
    // active "d", open tiles "b" then "a", sidebar-only "e"; "zz" is gone; "c" was not reported.
    let reported: Vec<String> = ["d", "b", "a", "zz", "e", "b"].iter().map(|s| s.to_string()).collect();
    assert_eq!(order_ids(&all, &reported), ["d", "b", "a", "e", "c"]);
    assert_eq!(order_ids(&all, &[]), ["a", "b", "c", "d", "e"]);
}

#[test]
fn the_setting_reads_from_the_file_and_defaults_to_side_by_side() {
    let file = |v: Value| json!({ "settings": { "individual_window_layout": v } });
    assert_eq!(layout_from_settings(&file(json!("cascade"))), WindowLayout::Cascade);
    assert_eq!(layout_from_settings(&file(json!("side_by_side"))), WindowLayout::SideBySide);
    assert_eq!(layout_from_settings(&file(json!("grid"))), WindowLayout::SideBySide);
    assert_eq!(layout_from_settings(&file(json!(7))), WindowLayout::SideBySide);
    assert_eq!(layout_from_settings(&json!({})), WindowLayout::SideBySide);
    for l in [WindowLayout::SideBySide, WindowLayout::Cascade] {
        assert_eq!(WindowLayout::parse(l.as_str()), Some(l));
    }
}

#[test]
fn a_generic_settings_patch_carries_the_layout_to_the_file_and_back() {
    let patch = json!({ "individual_window_layout": "cascade" });
    let map = crate::settings_patch::sanitize_patch(&patch, false).unwrap();
    assert!(map.contains_key("individual_window_layout"), "not an owned-elsewhere key");
    let file = crate::settings_patch::merge_into_file(&json!({ "settings": { "theme": "dark" } }), &map);
    assert_eq!(layout_from_settings(&file), WindowLayout::Cascade);
    assert_eq!(file["settings"]["theme"], "dark", "other keys are kept");
    let clear = crate::settings_patch::sanitize_patch(&json!({ "individual_window_layout": null }), false).unwrap();
    assert_eq!(layout_from_settings(&crate::settings_patch::merge_into_file(&file, &clear)), WindowLayout::SideBySide);
}

#[test]
fn the_inner_size_makes_the_outer_size_match() {
    assert_eq!(inner_for_outer((960.0, 540.0), (16, 39)), (944, 501));
    assert_eq!(inner_for_outer((10.0, 10.0), (16, 39)), (1, 1), "never zero");
}
