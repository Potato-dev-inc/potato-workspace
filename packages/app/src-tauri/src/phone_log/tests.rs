use super::*;
use crate::device_link::route::MemoryPrefs;
use crate::mobile_pairing::Caller;

fn fresh() -> Arc<ActivityLog> {
    ActivityLog::new(MemoryPrefs::new())
}

fn kinds(log: &ActivityLog, node: &str) -> Vec<String> {
    // Oldest first.
    let mut rows: Vec<String> = log.list(Some(node)).iter().map(|r| r["kind"].as_str().unwrap_or("").to_string()).collect();
    rows.reverse();
    rows
}

#[test]
fn a_phones_first_action_is_preceded_by_an_opened_line() {
    let log = fresh();
    record_at(&log, 1000, "aa", "Pixel 8", Kind::Messaged);
    assert_eq!(kinds(&log, "aa"), ["connected", "messaged"]);
}

#[test]
fn a_run_of_the_same_kind_within_seconds_is_one_line() {
    let log = fresh();
    for s in 0..5 {
        record_at(&log, 1000 + s, "aa", "Pixel 8", Kind::Typed);
    }
    assert_eq!(kinds(&log, "aa"), ["connected", "typed"], "five keystrokes in five seconds");
    record_at(&log, 1000 + MERGE_SECS + 5, "aa", "Pixel 8", Kind::Typed);
    assert_eq!(kinds(&log, "aa"), ["connected", "typed", "typed"], "later it is a new line");
    record_at(&log, 1020, "aa", "Pixel 8", Kind::Answered);
    assert_eq!(kinds(&log, "aa").last().map(String::as_str), Some("answered"), "another kind is its own line");
}

#[test]
fn a_phone_that_was_quiet_for_a_while_opens_again() {
    let log = fresh();
    record_at(&log, 1000, "aa", "Pixel 8", Kind::Stopped);
    record_at(&log, 1000 + SESSION_SECS + 1, "aa", "Pixel 8", Kind::Stopped);
    assert_eq!(kinds(&log, "aa"), ["connected", "stopped", "connected", "stopped"]);
}

#[test]
fn phones_have_their_own_lines() {
    let log = fresh();
    record_at(&log, 1000, "aa", "Pixel 8", Kind::Messaged);
    record_at(&log, 1001, "bb", "iPhone", Kind::Messaged);
    assert_eq!(kinds(&log, "aa"), ["connected", "messaged"]);
    assert_eq!(kinds(&log, "bb"), ["connected", "messaged"]);
}

#[test]
fn a_line_is_a_time_a_device_and_a_kind_only() {
    let log = fresh();
    record_at(&log, 5, "aa", "Pixel 8", Kind::Messaged);
    for row in log.list(None) {
        let mut keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["at", "dir", "kind", "name", "node"], "{row}");
    }
}

#[test]
fn clear_empties_the_list() {
    let log = fresh();
    record_at(&log, 5, "aa", "Pixel 8", Kind::Messaged);
    assert!(!log.list(None).is_empty());
    log.clear();
    assert!(log.list(None).is_empty());
}

#[test]
fn only_a_paired_phones_actions_leave_a_line_and_only_real_actions() {
    use crate::mobile_pairing::Caps;
    let phone = |id: &str| Caller::Device { device_id: id.to_string(), caps: Caps::default() };
    let mine = |node: &str| list().into_iter().filter(|r| r["node"] == node).map(|r| r["kind"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();

    // The unique ids keep this test apart from the others that share the app's one list.
    note_authorized(&phone("phone-log-t1"), "GET", &["panes"]);
    note_authorized(&phone("phone-log-t1"), "POST", &["panes", "p1", "draft"]);
    note_authorized(&phone("phone-log-t1"), "POST", &["acp", "sessions", "p1", "typing"]);
    assert!(mine("phone-log-t1").is_empty(), "reads and housekeeping are not actions");

    note_authorized(&phone("phone-log-t1"), "POST", &["panes", "p1", "messages"]);
    assert_eq!(mine("phone-log-t1").len(), 2, "opened + messaged: {:?}", mine("phone-log-t1"));

    // The desktop's own tools are not a phone.
    note_authorized(&Caller::Local, "POST", &["panes", "p1", "messages"]);
    note_authorized(&Caller::Public, "POST", &["panes", "p1", "messages"]);
    assert_eq!(list().iter().filter(|r| r["node"] == "").count(), 0);
}

#[test]
fn a_bridge_prefix_from_a_proxy_is_looked_through() {
    use crate::mobile_pairing::Caps;
    let caller = Caller::Device { device_id: "phone-log-t2".to_string(), caps: Caps::default() };
    note_authorized(&caller, "POST", &["bridge", "questions", "q1", "answer"]);
    let kinds: Vec<String> = list().into_iter().filter(|r| r["node"] == "phone-log-t2").map(|r| r["kind"].as_str().unwrap_or("").to_string()).collect();
    assert!(kinds.contains(&"answered".to_string()), "{kinds:?}");
}
