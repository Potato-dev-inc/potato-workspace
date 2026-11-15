use super::shot::*;
use super::store;
use crate::point::shot::{decode, encode};
use std::path::PathBuf;

fn picture(w: u32, h: u32) -> Vec<u8> {
    let mut px = Vec::new();
    for y in 0..h {
        for x in 0..w {
            px.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 7, 255]);
        }
    }
    encode(w, h, &px).unwrap()
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-markup-shot-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_picture_is_cropped_to_the_page_area_with_dpi_handled() {
    // A 200 x 100 window picture of a 100 CSS px wide window (device ratio 2).
    let png = picture(200, 100);
    let (cropped, w, h) = crop_area(&png, Area { x: 10.0, y: 5.0, w: 40.0, h: 20.0 }, 100.0).unwrap();
    assert_eq!((w, h), (80, 40));
    let pic = decode(&cropped).unwrap();
    assert_eq!((pic.w, pic.h), (80, 40));
    // The first pixel is the one at (20, 10) of the window picture.
    assert_eq!(&pic.rgba[0..4], &[20, 10, 7, 255]);
}

#[test]
fn an_area_outside_or_without_size_or_with_bad_numbers_is_refused() {
    let png = picture(100, 100);
    for area in [
        Area { x: 0.0, y: 0.0, w: 0.0, h: 10.0 },
        Area { x: f64::NAN, y: 0.0, w: 10.0, h: 10.0 },
        Area { x: 500.0, y: 0.0, w: 10.0, h: 10.0 },
        Area { x: 0.0, y: 0.0, w: f64::INFINITY, h: 10.0 },
    ] {
        assert!(crop_area(&png, area, 100.0).is_err(), "{area:?}");
    }
    assert!(crop_area(&png, Area { x: 0.0, y: 0.0, w: 10.0, h: 10.0 }, 0.0).is_err());
    assert!(crop_area(b"not a png", Area { x: 0.0, y: 0.0, w: 10.0, h: 10.0 }, 100.0).is_err());
}

#[test]
fn the_thumbnail_is_small() {
    let thumb = thumbnail(&picture(1200, 800)).unwrap();
    let pic = decode(&thumb).unwrap();
    assert!(pic.w <= 360 && pic.w >= 200 && pic.h > 0, "{}x{}", pic.w, pic.h);
    assert!(data_url(&thumb).starts_with("data:image/png;base64,"));
    assert!(thumbnail(b"nope").is_none());
}

#[test]
fn a_picture_is_saved_under_a_name_made_here_and_only_mark_files_are_pruned() {
    let project = folder("save");
    let png = picture(10, 10);
    let (abs, rel) = save(&project, &png, 1_700_000_000_000, 3).unwrap();
    assert!(abs.is_file());
    assert!(rel.starts_with(".potato-workspace/shots/mark-") && rel.ends_with("-3.png"), "{rel}");
    let dir = abs.parent().unwrap().to_path_buf();
    // A Point picture and an unrelated file are never touched.
    std::fs::write(dir.join("pick-20260101-000000-1.png"), b"x").unwrap();
    std::fs::write(dir.join("notes.txt"), b"x").unwrap();
    for n in 0..5 {
        std::fs::write(dir.join(format!("mark-20260101-00000{n}-1.png")), b"x").unwrap();
    }
    assert_eq!(prune(&dir, 3), 3);
    assert!(dir.join("pick-20260101-000000-1.png").is_file() && dir.join("notes.txt").is_file());
    let left = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| is_mark_name(&e.file_name().to_string_lossy())).count();
    assert_eq!(left, 3);
}

#[test]
fn only_our_own_names_count_as_mark_pictures() {
    assert!(is_mark_name("mark-20261117-100000-1.png"));
    for bad in ["pick-1.png", "mark-.png", "mark-1.jpg", "mark-../x.png", "mark-a\\b.png", "xmark-1.png"] {
        assert!(!is_mark_name(bad), "{bad}");
    }
}

#[test]
fn a_picture_id_works_only_for_the_pane_it_was_taken_for_and_only_once_kept() {
    let id = store::keep("pane-a", PathBuf::from("C:/p/a.png"), ".potato-workspace/shots/mark-1.png".into());
    assert!(store::get("pane-a", &id).is_some());
    assert!(store::get("pane-b", &id).is_none());
    assert!(store::get("pane-a", "mk-0000000000000000").is_none());
    // A newer picture of the same pane replaces the older one.
    let newer = store::keep("pane-a", PathBuf::from("C:/p/b.png"), "x".into());
    assert!(store::get("pane-a", &id).is_none());
    assert!(store::get("pane-a", &newer).is_some());
    store::drop_id(&newer);
    assert!(store::get("pane-a", &newer).is_none());
}
