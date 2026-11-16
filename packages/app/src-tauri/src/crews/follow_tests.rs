//! 1.1.8 "Follow a task": tasks and hand-overs are read from the turns the panes were given.

use super::follow::{build, PaneFact, TurnFact, MAX_WORDS};
use super::model::{Crew, Role};

fn role(name: &str, parent: Option<&str>) -> Role {
    Role { name: name.into(), agent_type: "claude".into(), task: "Do it".into(), parent: parent.map(String::from), ..Role::default() }
}

fn crew() -> Crew {
    Crew { name: "Test".into(), roles: vec![role("Lead", None), role("Scout", Some("Lead")), role("Checker", Some("Lead"))], ..Crew::default() }
}

fn turn(index: u32, task: &str, at_ms: u64, status: &str, result: Option<&str>) -> TurnFact {
    TurnFact { index, task: task.into(), at_ms, status: status.into(), result: result.map(String::from) }
}

fn pane(id: &str, parent: Option<&str>, title: &str, turns: Vec<TurnFact>) -> PaneFact {
    PaneFact { pane_id: id.into(), parent: parent.map(String::from), title: title.into(), turns }
}

#[test]
fn a_task_lists_the_lead_then_each_hand_over_inside_its_window() {
    let panes = vec![
        pane("p1", None, "Lead", vec![turn(0, "job", 10, "completed", None), turn(1, "Fix the copy", 100, "completed", Some("done")), turn(2, "Second task", 500, "running", None)]),
        pane("p2", Some("p1"), "Scout", vec![turn(0, "scout job", 11, "completed", None), turn(1, "Where is the copy?", 110, "completed", Some("In a.ts"))]),
        pane("p3", Some("p1"), "Checker", vec![turn(0, "check job", 12, "completed", None), turn(1, "Check it", 300, "failed", Some("Broke"))]),
        pane("p4", Some("p1"), "Scout", vec![turn(1, "Later question", 600, "running", None)]),
    ];
    let tasks = build(&crew(), &panes);
    assert_eq!(tasks.len(), 2);
    // newest first
    assert_eq!(tasks[0].words, "Second task");
    assert_eq!(tasks[0].status, "running");
    assert_eq!(tasks[0].steps.iter().map(|s| s.role.as_str()).collect::<Vec<_>>(), ["Lead", "Scout"]);
    let first = &tasks[1];
    assert_eq!(first.words, "Fix the copy");
    assert_eq!(first.status, "failed");
    let steps: Vec<(&str, Option<&str>, &str)> = first.steps.iter().map(|s| (s.role.as_str(), s.from.as_deref(), s.words.as_str())).collect();
    assert_eq!(steps, [("Lead", None, "Fix the copy"), ("Scout", Some("Lead"), "Where is the copy?"), ("Checker", Some("Lead"), "Check it")]);
    assert_eq!(first.steps[1].came_back.as_deref(), Some("In a.ts"));
}

#[test]
fn the_start_jobs_are_not_hand_overs() {
    let panes = vec![
        pane("p1", None, "Lead", vec![turn(0, "job", 10, "completed", None), turn(1, "Task", 100, "completed", None)]),
        pane("p2", Some("p1"), "Scout", vec![turn(0, "scout job", 11, "completed", None)]),
    ];
    let tasks = build(&crew(), &panes);
    assert_eq!(tasks[0].steps.len(), 1);
    assert_eq!(tasks[0].status, "done");
}

#[test]
fn work_handed_over_without_a_lead_task_is_one_task_with_no_words() {
    let panes = vec![
        pane("p1", None, "Lead", vec![turn(0, "job", 10, "completed", None)]),
        pane("p2", Some("p1"), "Scout", vec![turn(0, "job", 11, "completed", None), turn(1, "Look here", 50, "completed", Some("ok"))]),
    ];
    let tasks = build(&crew(), &panes);
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].words, "");
    assert_eq!(tasks[0].steps[0].role, "Scout");
}

#[test]
fn panes_that_are_not_roles_of_the_crew_and_other_crews_are_left_out() {
    let panes = vec![
        pane("p1", None, "Lead", vec![turn(1, "Task", 100, "completed", None)]),
        pane("p2", Some("p1"), "My own helper", vec![turn(1, "Secret", 110, "completed", None)]),
        pane("p9", None, "Someone else", vec![turn(1, "Other", 120, "completed", None)]),
    ];
    let tasks = build(&crew(), &panes);
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].steps.len(), 1);
}

#[test]
fn long_words_are_capped_and_a_crew_without_a_lead_has_no_tasks() {
    let long = "x".repeat(MAX_WORDS + 50);
    let panes = vec![pane("p1", None, "Lead", vec![turn(1, &long, 100, "completed", None)])];
    let tasks = build(&crew(), &panes);
    assert_eq!(tasks[0].words.chars().count(), MAX_WORDS + 1);
    assert!(tasks[0].words.ends_with('…'));
    let headless = Crew { name: "No lead".into(), roles: vec![role("A", Some("B")), role("B", Some("A"))], ..Crew::default() };
    assert!(build(&headless, &panes).is_empty());
}
