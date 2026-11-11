//! Unit tests for the event log: append, replay, project paths.

use super::*;
use crate::events::SystemEvent;

fn temp_event_log_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "potato-workspace-{name}-{}.jsonl",
        uuid::Uuid::new_v4()
    ))
}

fn temp_project_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("potato-workspace-{name}-{}", uuid::Uuid::new_v4()))
}

#[test]
fn jsonl_log_survives_reopen() {
    let path = temp_event_log_path("survives-reopen");
    let log = EventLog::new(path.clone()).unwrap();
    let entry = EventEntry::new(
        ActorId::system(),
        CommandId::new(),
        SystemEvent::PaneKilled {
            pane_id: PaneId("pane-1".to_string()),
            reason: None,
        },
    );
    log.append(&entry).unwrap();
    drop(log);

    let reopened = EventLog::new(path.clone()).unwrap();
    let entries = reopened.read_all().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(matches!(entries[0].payload, SystemEvent::PaneKilled { .. }));
    let _ = fs::remove_file(path);
}

#[test]
fn manager_writes_active_project_events_to_project_storage() {
    let fallback_path = temp_event_log_path("project-fallback");
    let project_dir = temp_project_dir("project-scope");
    fs::create_dir_all(&project_dir).unwrap();
    let manager = EventLogManager::new(fallback_path.clone()).unwrap();
    manager.set_active_project_path(Some(project_dir.clone()));

    let entry = EventEntry::new(
        ActorId::system(),
        CommandId::new(),
        SystemEvent::PaneKilled {
            pane_id: PaneId("pane-1".to_string()),
            reason: None,
        },
    );
    manager.append(&entry).unwrap();

    let project_log = project_event_log_path(&project_dir);
    assert_eq!(manager.current_path(), project_log);
    assert_eq!(read_entries(&project_log).unwrap().len(), 1);
    assert!(read_entries(&fallback_path).unwrap().is_empty());

    let _ = fs::remove_file(project_log);
    let _ = fs::remove_dir_all(project_storage_dir(&project_dir));
    let _ = fs::remove_dir_all(project_dir);
    let _ = fs::remove_file(fallback_path);
}

#[test]
fn replay_reconstructs_pane_timeline() {
    let entries = vec![
        EventEntry::new(
            ActorId::system(),
            CommandId::new(),
            SystemEvent::PaneSpawned {
                pane_id: PaneId("pane-1".to_string()),
                agent_type: "bash".to_string(),
                pid: 100,
                cwd: "/tmp".to_string(),
                cols: 80,
                rows: 24,
            },
        ),
        EventEntry::new(
            ActorId::system(),
            CommandId::new(),
            SystemEvent::PaneStatusChanged {
                pane_id: PaneId("pane-1".to_string()),
                status: "idle".to_string(),
            },
        ),
    ];

    let timeline = replay_pane_timeline_from_entries(entries).unwrap();
    assert_eq!(timeline.len(), 2);
    assert_eq!(timeline[0].event, "spawned");
    assert_eq!(timeline[1].event, "status:idle");
}

fn status_entry(pane: &str, status: &str) -> EventEntry {
    EventEntry::new(
        ActorId::system(),
        CommandId::new(),
        SystemEvent::PaneStatusChanged {
            pane_id: PaneId(pane.to_string()),
            status: status.to_string(),
        },
    )
}

#[test]
fn find_last_entry_returns_the_newest_match_across_chunk_boundaries() {
    let path = temp_event_log_path("find-last");
    let log = EventLog::new(path.clone()).unwrap();
    for index in 0..200 {
        log.append(&status_entry("pane-a", &format!("a{index}"))).unwrap();
        if index % 3 == 0 {
            log.append(&status_entry("pane-b", &format!("b{index}"))).unwrap();
        }
    }
    let wants = |pane: &'static str| {
        move |entry: &EventEntry| {
            matches!(&entry.payload, SystemEvent::PaneStatusChanged { pane_id, .. } if pane_id.0 == pane)
        }
    };
    // A tiny chunk forces lines to straddle chunk boundaries.
    for chunk in [7usize, 64, 1_000, 1 << 20] {
        let a = find_last_entry_in(&path, chunk, wants("pane-a")).unwrap().unwrap();
        assert!(matches!(&a.payload, SystemEvent::PaneStatusChanged { status, .. } if status == "a199"), "chunk {chunk}");
        let b = find_last_entry_in(&path, chunk, wants("pane-b")).unwrap().unwrap();
        assert!(matches!(&b.payload, SystemEvent::PaneStatusChanged { status, .. } if status == "b198"), "chunk {chunk}");
    }
    assert!(find_last_entry_in(&path, 64, wants("pane-missing")).unwrap().is_none());
    let _ = fs::remove_file(path);
}

#[test]
fn find_last_entry_handles_missing_empty_and_unterminated_files() {
    let missing = temp_event_log_path("find-last-missing");
    assert!(find_last_entry_in(&missing, 64, |_| true).unwrap().is_none());
    let empty = temp_event_log_path("find-last-empty");
    fs::write(&empty, "").unwrap();
    assert!(find_last_entry_in(&empty, 64, |_| true).unwrap().is_none());
    // No trailing newline (a writer was interrupted mid-append is not tolerated, but a file that
    // simply lacks the final newline is), and a blank line in the middle.
    let json = serde_json::to_string(&status_entry("p", "x")).unwrap();
    let odd = temp_event_log_path("find-last-odd");
    fs::write(&odd, format!("{json}\n\n{json}")).unwrap();
    assert!(find_last_entry_in(&odd, 16, |_| true).unwrap().is_some());
    let _ = fs::remove_file(empty);
    let _ = fs::remove_file(odd);
}

#[test]
fn concurrent_appends_through_the_shared_writer_never_share_a_line() {
    let path = temp_event_log_path("concurrent");
    let threads: Vec<_> = (0..8)
        .map(|worker| {
            let path = path.clone();
            std::thread::spawn(move || {
                // Each call asks for the writer anew, as the bridge does for every event.
                for index in 0..200 {
                    let log = EventLog::shared(path.clone()).unwrap();
                    log.append(&status_entry(&format!("pane-{worker}"), &format!("s{index}"))).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let text = fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 1600);
    for line in &lines {
        assert!(serde_json::from_str::<EventEntry>(line).is_ok(), "one entry per line: {line}");
    }
    assert_eq!(read_entries(&path).unwrap().len(), 1600);
    assert!(Arc::ptr_eq(&EventLog::shared(path.clone()).unwrap(), &EventLog::shared(path.clone()).unwrap()));
    let _ = fs::remove_file(path);
}

#[test]
fn a_glued_or_damaged_line_is_recovered_or_skipped_not_fatal() {
    let a = serde_json::to_string(&status_entry("pane-a", "first")).unwrap();
    let b = serde_json::to_string(&status_entry("pane-b", "second")).unwrap();
    let c = serde_json::to_string(&status_entry("pane-c", "third")).unwrap();
    let path = temp_event_log_path("damaged");
    // `{A}{B}` is what two interleaved appends used to leave behind; then plain garbage; then a good line.
    fs::write(&path, format!("{a}{b}\nnot json at all\n{{\"half\":\n{c}\n")).unwrap();
    let entries = read_entries(&path).unwrap();
    assert_eq!(entries.len(), 3, "A and B from the glued line, and C");
    let want = |pane: &'static str| {
        move |entry: &EventEntry| {
            matches!(&entry.payload, SystemEvent::PaneStatusChanged { pane_id, .. } if pane_id.0 == pane)
        }
    };
    for chunk in [5usize, 64, 1 << 20] {
        assert!(find_last_entry_in(&path, chunk, want("pane-a")).unwrap().is_some(), "chunk {chunk}");
        assert!(find_last_entry_in(&path, chunk, want("pane-b")).unwrap().is_some(), "chunk {chunk}");
        assert!(find_last_entry_in(&path, chunk, want("pane-c")).unwrap().is_some(), "chunk {chunk}");
    }
    let _ = fs::remove_file(path);
}

#[test]
fn a_log_over_its_size_limit_is_moved_aside_and_restarted() {
    let path = temp_event_log_path("rotate");
    let log = EventLog::with_limit(path.clone(), 4_000).unwrap();
    for index in 0..100 {
        log.append(&status_entry("pane-r", &format!("s{index}"))).unwrap();
    }
    let rotated = rotated_path(&path);
    assert!(rotated.exists(), "the full log was moved aside");
    let current = fs::metadata(&path).unwrap().len();
    assert!(current < 4_000 + 400, "the live file stays near the limit, got {current}");
    let newest = find_last_entry_in(&path, 256, |_| true).unwrap().unwrap();
    assert!(matches!(&newest.payload, SystemEvent::PaneStatusChanged { status, .. } if status == "s99"));
    assert!(!read_entries(&path).unwrap().is_empty());
    let _ = fs::remove_file(rotated);
    let _ = fs::remove_file(path);
}

#[test]
fn walking_the_log_backwards_stops_early_and_goes_newest_first() {
    let path = temp_event_log_path("backwards");
    let log = EventLog::new(path.clone()).unwrap();
    for index in 0..500 {
        log.append(&status_entry("pane-w", &format!("s{index}"))).unwrap();
    }
    let mut seen = Vec::new();
    scan_entries_backwards(&path, 512, |entry| {
        if let SystemEvent::PaneStatusChanged { status, .. } = entry.payload {
            seen.push(status);
        }
        seen.len() >= 3
    })
    .unwrap();
    assert_eq!(seen, vec!["s499", "s498", "s497"]);
    let _ = fs::remove_file(path);
}
