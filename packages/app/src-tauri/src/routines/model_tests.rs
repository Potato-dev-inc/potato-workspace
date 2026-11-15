use super::model::*;

fn agent() -> Step {
    Step::StartAgent { agent: "claude".into(), project: "C:/p".into(), task: "t".into(), separate_copy: false }
}

fn routine() -> NewWorkflow {
    NewWorkflow { name: "Morning".into(), trigger: Trigger::Schedule { days: vec![1, 2], time: "09:00".into() }, steps: vec![agent(), Step::Wait] }
}

#[test]
fn a_good_routine_passes() {
    assert_eq!(validate(&routine()), Ok(()));
}

#[test]
fn the_form_gets_a_plain_sentence_for_each_mistake() {
    let mut w = routine();
    w.name = "  ".into();
    assert_eq!(validate(&w), Err("Give it a name.".into()));
    let mut w = routine();
    w.trigger = Trigger::Schedule { days: vec![], time: "9am".into() };
    assert_eq!(validate(&w), Err("Pick a time like 09:00.".into()));
    let mut w = routine();
    w.trigger = Trigger::Schedule { days: vec![0], time: "09:00".into() };
    assert!(validate(&w).is_err());
    let mut w = routine();
    w.steps.clear();
    assert!(validate(&w).is_err());
    let mut w = routine();
    w.steps = vec![Step::StartAgent { agent: "claude".into(), project: " ".into(), task: "t".into(), separate_copy: false }];
    assert_eq!(validate(&w), Err("Pick a project.".into()));
    let mut w = routine();
    w.steps = vec![Step::Notify { text: "x".repeat(TEXT_MAX + 1) }];
    assert!(validate(&w).is_err());
}

#[test]
fn a_step_that_needs_an_agent_needs_one_first() {
    let mut w = routine();
    w.steps = vec![Step::Wait, agent()];
    assert!(validate(&w).is_err());
    // A chain has its chat, so it may follow up at once.
    w.trigger = Trigger::ChatFinished { pane_id: "p1".into(), only_if_ok: false };
    w.steps = vec![Step::FollowUp { text: "go".into() }];
    assert_eq!(validate(&w), Ok(()));
    w.trigger = Trigger::ChatFinished { pane_id: " ".into(), only_if_ok: false };
    assert!(validate(&w).is_err());
}

#[test]
fn too_many_steps_are_refused() {
    let mut w = routine();
    w.steps = (0..=STEPS_MAX).map(|_| Step::Notify { text: "n".into() }).collect();
    assert!(validate(&w).is_err());
}

#[test]
fn times_are_two_digit_hours_and_minutes() {
    assert_eq!(parse_hhmm("09:30"), Some(570));
    assert_eq!(parse_hhmm("23:59"), Some(1439));
    assert_eq!(parse_hhmm("9:30"), None);
    assert_eq!(parse_hhmm("24:00"), None);
    assert_eq!(parse_hhmm("12:60"), None);
}

#[test]
fn ids_have_the_shape_the_engine_makes() {
    assert!(valid_id("rt-", &new_workflow_id()));
    assert!(valid_id("rr-", &new_run_id()));
    assert!(!valid_id("rt-", "rt-../../etc"));
    assert!(!valid_id("rr-", &new_workflow_id()));
}

#[test]
fn the_saved_json_has_a_version_and_readable_tags() {
    let wf = Workflow {
        v: WORKFLOW_VERSION,
        id: "rt-00000001".into(),
        name: "n".into(),
        enabled: true,
        trigger: Trigger::Schedule { days: vec![1], time: "09:00".into() },
        steps: vec![agent(), Step::Notify { text: "x".into() }],
        created_ms: 1,
        last_due_ms: 0,
        last_run_ms: None,
        last_result: None,
        fail_streak: 0,
        paused_note: None,
        seen_turns: 0,
    };
    let json = serde_json::to_value(&wf).unwrap();
    assert_eq!(json["v"], 1);
    assert_eq!(json["trigger"]["kind"], "schedule");
    assert_eq!(json["steps"][0]["kind"], "start_agent");
    assert_eq!(json["steps"][1]["kind"], "notify");
    let back: Workflow = serde_json::from_value(json).unwrap();
    assert_eq!(back, wf);
}

#[test]
fn an_older_file_with_fewer_fields_still_loads() {
    let json = r#"{"id":"rt-00000001","name":"n","trigger":{"kind":"manual"}}"#;
    let wf: Workflow = serde_json::from_str(json).unwrap();
    assert!(wf.enabled);
    assert_eq!(wf.v, WORKFLOW_VERSION);
    assert!(wf.steps.is_empty());
}
