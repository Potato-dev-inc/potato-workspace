use super::*;

#[test]
fn a_device_keeps_the_persons_name_when_it_tells_us_its_own_again() {
    let r = Registry::in_memory();
    r.observe("p1", DeviceKind::Phone, "OPPO Reno13");
    assert_eq!(r.display_name("p1").unwrap(), "OPPO Reno13");
    assert!(r.rename("p1", "  Ren's   phone "));
    assert_eq!(r.display_name("p1").unwrap(), "Ren's phone");
    r.observe("p1", DeviceKind::Phone, "OPPO Reno13 Pro");
    assert_eq!(r.display_name("p1").unwrap(), "Ren's phone");
    assert_eq!(r.get("p1").unwrap().auto_name, "OPPO Reno13 Pro");
    // An empty name goes back to the device's own.
    assert!(r.rename("p1", "  "));
    assert_eq!(r.display_name("p1").unwrap(), "OPPO Reno13 Pro");
    assert!(!r.rename("nobody", "x"));
}

#[test]
fn names_are_one_clean_short_line_and_an_empty_report_keeps_the_old_name() {
    assert_eq!(clean_name("a\nb\t c"), "a b c");
    assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 60);
    let r = Registry::in_memory();
    r.observe("pc", DeviceKind::Pc, "Ren's Mac");
    r.observe("pc", DeviceKind::Pc, "   ");
    assert_eq!(r.display_name("pc").unwrap(), "Ren's Mac");
}

#[test]
fn the_names_map_always_lists_this_pc_and_the_account_field_is_reserved() {
    let r = Registry::in_memory();
    r.observe("link:ab", DeviceKind::Pc, "Work PC");
    let names = r.names();
    assert_eq!(names["link:ab"]["name"], "Work PC");
    assert_eq!(names["link:ab"]["kind"], "pc");
    assert_eq!(names[LOCAL_ID]["kind"], "this_pc");
    assert!(r.set_account("link:ab", Some("acct-1")));
    assert_eq!(r.get("link:ab").unwrap().account_id.as_deref(), Some("acct-1"));
}

#[test]
fn records_survive_a_restart_and_a_broken_file_starts_empty() {
    let dir = std::env::temp_dir().join(format!("pm-identity-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("device-identity.json");
    let a = Registry::at(path.clone());
    a.observe("p1", DeviceKind::Phone, "Pixel 9");
    a.rename("p1", "Mum's phone");
    let b = Registry::at(path.clone());
    assert_eq!(b.display_name("p1").unwrap(), "Mum's phone");
    std::fs::write(&path, "not json").unwrap();
    assert!(Registry::at(path).get("p1").is_none());
}
