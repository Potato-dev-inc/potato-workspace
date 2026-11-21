use super::sessions_rows::*;
use serde_json::{json, Value};

fn pane(extra: Value) -> crate::pty::PaneInfo {
    let mut v = json!({ "id": "p1", "agent_type": "opencode", "pid": 0, "status": "idle", "created_at": 0, "cwd": "/home/ren/pm-night", "cols": 80, "rows": 24 });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn row(info: &crate::pty::PaneInfo) -> Value {
    let mut r = json!({ "id": info.id });
    extend(&mut r, info, |p| format!("id:{p}"), |p| p.rsplit('/').next().unwrap_or("").to_string());
    r
}

// The marks are process-wide: a test holds this lock from start to end.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn rows_carry_what_the_local_sidebar_builds_from_and_nothing_with_a_path() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_marks(&json!({
        "front": { "slug": "wf", "role": "Front", "front": true, "name": "Research + Write" },
        "p1": { "slug": "wf", "role": "Writer" },
        "bad": { "slug": 5 },
    }));

    // A plain chat: nothing extra, no workflow.
    let plain = row(&pane(json!({ "id": "plain" })));
    assert_eq!(plain, json!({ "id": "plain" }));

    // A helper under the front: its parent, its kind, its crew box, never `front`.
    let helper = row(&pane(json!({ "parent_pane_id": "front", "started_as": "spin_off", "lane": "acp" })));
    assert_eq!(helper["helper_of"], "front");
    assert_eq!(helper["started_as"], "spin_off");
    assert_eq!(helper["lane"], "acp");
    assert_eq!(helper["workflow"], json!({ "slug": "wf", "role": "Writer", "front": false }));

    // The front: the workflow mark with the crew's name.
    let front = row(&pane(json!({ "id": "front", "lane": "acp" })));
    assert_eq!(front["workflow"], json!({ "slug": "wf", "role": "Front", "front": true, "name": "Research + Write" }));

    // A standby's own chat is flagged (the sidebar hides it), a made-up kind is dropped.
    let standby = row(&pane(json!({ "id": "s", "standby_seat": "seat1", "started_as": "bogus" })));
    assert_eq!(standby["standby"], true);
    assert!(standby.get("started_as").is_none());

    // A chat on a separate copy sits under its REAL project, and says it is on a copy.
    let copy = row(&pane(json!({ "id": "c", "cwd": "/home/ren/shop/.potato-workspace/worktrees/fix-1/src" })));
    assert_eq!(copy["copy"], true);
    assert_eq!(copy["project"], "id:/home/ren/shop");
    assert_eq!(copy["folder"], "shop");

    // No row of any shape holds a path.
    for r in [&plain, &helper, &front, &standby] {
        assert!(!r.to_string().contains("/home/"), "{r}");
    }
}

#[test]
fn marks_are_capped_cleaned_and_replaced_whole() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let many: serde_json::Map<String, Value> = (0..500).map(|i| (format!("p{i}"), json!({ "slug": "s", "role": "r" }))).collect();
    set_marks(&Value::Object(many));
    assert_eq!(MARKS.lock().unwrap().len(), MAX_MARKS);
    set_marks(&json!({ "x": { "slug": "a\u{202e}b", "role": "r", "front": true, "name": "\u{200b}" } }));
    let r = row(&pane(json!({ "id": "x" })));
    assert_eq!(r["workflow"]["slug"], "ab");
    assert!(r["workflow"].get("name").is_none(), "{r}");
    set_marks(&Value::Null);
    assert!(MARKS.lock().unwrap().is_empty());
}
