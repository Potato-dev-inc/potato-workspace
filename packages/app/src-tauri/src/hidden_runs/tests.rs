use super::*;
use crate::operations::{DelegateWorkRequest, StateSource};

/// A real headless-style operation in its own project folder.
fn hidden_run(task: &str) -> OperationSnapshot {
    let project = std::env::temp_dir().join(format!("pm-hidden-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&project).unwrap();
    let request = DelegateWorkRequest {
        project_path: project.to_string_lossy().into_owned(),
        task: task.into(),
        agent_type: "claude".into(),
        pane_id: None,
        idempotency_key: uuid::Uuid::new_v4().to_string(),
        acceptance_criteria: None,
        task_id: None,
        exclusive: false,
        locks: vec![],
        timeout_ms: 900_000,
        read_only: true,
        keep_pane: false,
        placement: None,
        owner_session_id: None,
        parent_pane_id: None,
        worker_has_mcp_tools: false,
        agent_run_id: Some(format!("hid-{}", &uuid::Uuid::new_v4().to_string()[..8])),
        turn_index: 0,
        worker: Default::default(),
        context_policy: None,
        checks: Vec::new(),
    };
    operations::create_operation(request).unwrap().0
}

fn ours<'a>(rows: &'a [HiddenRunView], run: &OperationSnapshot) -> Option<&'a HiddenRunView> {
    rows.iter().find(|row| row.handle == run.agent_run_id)
}

#[test]
fn a_hidden_run_is_listed_with_its_task_and_follows_the_run_to_its_end() {
    let run = hidden_run("count the   files\nin src");
    note_started(&run, None);
    let rows = list();
    let row = ours(&rows, &run).expect("listed");
    assert_eq!(row.task, "count the files in src", "one line");
    assert_eq!(row.agent_type, "claude");
    assert_eq!(row.status, "running");
    assert_eq!(row.finished_at_ms, None);

    for status in [OperationStatus::Starting, OperationStatus::Running] {
        operations::mark_operation_state(&run.project_path, &run.operation_id, status, StateSource::Native, None, None, None).unwrap();
    }
    operations::mark_operation_completed(&run.project_path, &run.operation_id, "42 files", true).unwrap();
    let rows = list();
    let row = ours(&rows, &run).unwrap();
    assert_eq!(row.status, "done");
    assert!(row.finished_at_ms.is_some());
}

#[test]
fn a_dismissed_row_leaves_and_a_second_turn_does_not_list_the_run_twice() {
    let run = hidden_run("first");
    note_started(&run, None);
    note_started(&run, None);
    assert_eq!(list().iter().filter(|row| row.handle == run.agent_run_id).count(), 1);
    assert!(dismiss(&run.agent_run_id, None));
    assert!(ours(&list(), &run).is_none());
    assert!(!dismiss(&run.agent_run_id, None), "nothing left to dismiss");
}

#[test]
fn a_long_task_is_cut_for_the_row() {
    let run = hidden_run(&"word ".repeat(100));
    note_started(&run, None);
    let rows = list();
    let row = ours(&rows, &run).unwrap();
    assert!(row.task.chars().count() <= TASK_CHARS + 1 && row.task.ends_with('…'), "{}", row.task);
}
