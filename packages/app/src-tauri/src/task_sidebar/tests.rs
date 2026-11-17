use super::*;

fn row(id: &str, owner: &str, under: Option<&str>) -> Placement {
    Placement { task_id: id.into(), kind: "minion".into(), owner: owner.into(), under: under.map(str::to_string), name: format!("name {id}"), command: None }
}

#[test]
fn a_task_is_shown_once_and_moves_instead_of_doubling() {
    let mut s = Store::default();
    s.show(row("minion:a", "p1", Some("p1"))).unwrap();
    s.show(row("minion:a", "p1", None)).unwrap();
    assert_eq!(s.rows.len(), 1);
    assert_eq!(s.rows[0].under, None);
}

#[test]
fn it_refuses_a_task_id_it_does_not_know() {
    let mut s = Store::default();
    assert!(s.show(row("pane-3", "p1", None)).is_err());
    assert!(s.show(row("minion:", "p1", None)).is_err());
    let mut bad = row("minion:a", "p1", None);
    bad.kind = "other".into();
    assert!(s.show(bad).is_err());
    assert!(s.rows.is_empty());
}

#[test]
fn detach_and_put_back_change_only_where_it_is_nested() {
    let mut s = Store::default();
    s.show(row("minion:a", "p1", Some("p1"))).unwrap();
    assert!(s.place("minion:a", None));
    assert_eq!(s.rows[0].under, None);
    assert_eq!(s.rows[0].owner, "p1");
    assert!(s.place("minion:a", Some("p1")));
    assert_eq!(s.rows[0].under.as_deref(), Some("p1"));
    assert!(!s.place("minion:zzz", None));
}

#[test]
fn back_to_background_tasks_removes_the_row() {
    let mut s = Store::default();
    s.show(row("minion:a", "p1", Some("p1"))).unwrap();
    assert!(s.remove("minion:a"));
    assert!(!s.remove("minion:a"));
    assert!(s.rows.is_empty());
}

#[test]
fn reorder_keeps_unlisted_rows_at_the_end() {
    let mut s = Store::default();
    for id in ["minion:a", "minion:b", "minion:c"] {
        s.show(row(id, "p1", Some("p1"))).unwrap();
    }
    s.reorder(&["minion:c".to_string(), "minion:zz".to_string()]);
    let ids: Vec<&str> = s.rows.iter().map(|r| r.task_id.as_str()).collect();
    assert_eq!(ids, ["minion:c", "minion:a", "minion:b"]);
}

#[test]
fn a_hand_over_moves_a_nested_row_but_not_one_on_its_own() {
    let mut s = Store::default();
    s.show(row("minion:a", "p1", Some("p1"))).unwrap();
    s.show(row("minion:b", "p1", None)).unwrap();
    assert!(s.hand_to("minion:a", "p2"));
    assert!(s.hand_to("minion:b", "p2"));
    assert_eq!((s.rows[0].owner.as_str(), s.rows[0].under.as_deref()), ("p2", Some("p2")));
    assert_eq!((s.rows[1].owner.as_str(), s.rows[1].under.as_deref()), ("p2", None));
}

#[test]
fn a_closed_owner_takes_its_rows_and_a_closed_parent_frees_them() {
    let mut s = Store::default();
    s.show(row("minion:a", "p1", Some("p1"))).unwrap();
    s.show(row("minion:b", "p2", Some("gone"))).unwrap();
    let changed = s.prune(|id| id != "p1" && id != "gone");
    assert!(changed);
    assert_eq!(s.rows.len(), 1);
    assert_eq!(s.rows[0].task_id, "minion:b");
    assert_eq!(s.rows[0].under, None);
    assert!(!s.prune(|_| true));
}

#[test]
fn the_list_is_saved_and_read_back() {
    let dir = std::env::temp_dir().join(format!("task-sidebar-test-{}", uuid::Uuid::new_v4().simple()));
    let path = dir.join("task-sidebar.json");
    let file = File::at(path.clone());
    file.edit(|s| s.show(row("minion:a", "p1", Some("p1")))).unwrap();
    let back = File::at(path.clone());
    assert_eq!(back.snapshot().rows.len(), 1);
    // A refused change leaves the file as it was.
    assert!(back.edit(|s| s.show(row("nope", "p1", None))).is_err());
    assert_eq!(File::at(path).snapshot().rows.len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}
