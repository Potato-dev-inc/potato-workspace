use super::model::{parse, to_toml, Crew, Role};
use super::validate::{normalized, validate, AgentState};
use super::start::StartGuard;
use super::workflow::{first_message, front_brief, front_of, horde_note, horde_task, plan, refuse_horde_start, refuse_off, ReplyStyle};

fn ready(_: &str) -> AgentState {
    AgentState::Ready
}

fn role(name: &str, parent: Option<&str>) -> Role {
    Role { name: name.into(), agent_type: "claude".into(), task: format!("Do the {name} job in {{folder}}"), parent: parent.map(String::from), ..Role::default() }
}

fn helper(name: &str, model: &str, when: &str, kind: Option<&str>) -> Role {
    Role { model: Some(model.into()), when_to_use: Some(when.into()), kind: kind.map(String::from), ..role(name, Some("Front")) }
}

fn workflow() -> Crew {
    Crew {
        name: "Haiku router".into(),
        roles: vec![
            Role { front: true, model: Some("haiku".into()), task: "Answer short questions yourself in {folder}.".into(), ..role("Front", None) },
            helper("Hard", "sonnet", "hard coding tasks", None),
            helper("Easy", "deepseek", "easy tasks", Some("spin_off")),
        ],
        how_i_work: Some("Keep answers short.".into()),
        ..Crew::default()
    }
}

fn codes(c: &Crew) -> Vec<&'static str> {
    validate(&normalized(c), &ready).into_iter().map(|e| e.code).collect()
}

#[test]
fn a_workflow_is_valid_and_round_trips_through_the_crew_file() {
    let c = workflow();
    assert_eq!(codes(&c), Vec::<&str>::new());
    let back = parse(&to_toml(&c).unwrap()).unwrap();
    assert_eq!(back, c);
    assert_eq!(front_of(&back).unwrap().name, "Front");
}

#[test]
fn an_old_crew_has_no_front_and_nothing_about_it_changes() {
    let old = Crew { name: "Old".into(), roles: vec![role("Lead", None), role("Worker", Some("Lead"))], ..Crew::default() };
    assert_eq!(codes(&old), Vec::<&str>::new());
    assert!(front_of(&old).is_none());
    assert!(plan(&old, "C:/p", ReplyStyle::default(), "hi").is_none());
    let text = to_toml(&old).unwrap();
    for word in ["front", "kind", "when_to_use", "how_i_work", "start_mode", "helper_cap"] {
        assert!(!text.contains(word), "{word} must not be written for a plain crew");
    }
    assert_eq!(parse(&text).unwrap(), old);
}

#[test]
fn the_rules_of_a_workflow_are_checked() {
    let mut two = workflow();
    two.roles[1].front = true;
    assert!(codes(&two).contains(&"CREW_FRONTS"));

    let mut chain = workflow();
    chain.roles[2].parent = Some("Hard".into());
    assert!(codes(&chain).contains(&"CREW_WORKFLOW_CHAIN"));

    let mut no_when = workflow();
    no_when.roles[1].when_to_use = None;
    assert!(codes(&no_when).contains(&"CREW_WHEN_TO_USE"));

    let mut bad_kind = workflow();
    bad_kind.roles[1].kind = Some("boss".into());
    assert!(codes(&bad_kind).contains(&"CREW_KIND"));

    let mut mode = workflow();
    mode.start_mode = Some("everything".into());
    mode.helper_cap = Some(0);
    let found = codes(&mode);
    assert!(found.contains(&"CREW_START_MODE") && found.contains(&"CREW_HELPER_CAP"));
}

#[test]
fn the_front_brief_lists_helpers_how_to_start_them_and_the_limits() {
    let brief = front_brief(&workflow(), "C:/proj", ReplyStyle::Translator).unwrap();
    assert!(brief.contains("Answer short questions yourself in C:/proj."));
    assert!(brief.contains("Keep answers short."));
    assert!(brief.contains("Hard - use for: hard coding tasks. Start it with run_agent (as: minion, agent_type: claude, model: sonnet)"));
    assert!(brief.contains("Easy - use for: easy tasks. Start it with run_agent (as: spin_off, agent_type: claude, model: deepseek)"));
    assert!(brief.contains("at most 3 helper runs for each message"));
    assert!(brief.contains("Never answer a helper's question or approval yourself"));
    assert!(brief.contains("Do not let helpers start other helpers"));
}

#[test]
fn the_cap_is_the_workflows_own_number() {
    let mut c = workflow();
    c.helper_cap = Some(1);
    assert!(front_brief(&c, "C:/p", ReplyStyle::Translator).unwrap().contains("at most 1 helper run for each message"));
}

#[test]
fn translator_is_the_default_and_router_quotes_the_helper() {
    assert_eq!(ReplyStyle::default(), ReplyStyle::Translator);
    assert_eq!(ReplyStyle::parse(""), ReplyStyle::Translator);
    assert_eq!(ReplyStyle::parse("nonsense"), ReplyStyle::Translator);
    assert_eq!(ReplyStyle::parse("router"), ReplyStyle::Router);
    let translator = front_brief(&workflow(), "C:/p", ReplyStyle::Translator).unwrap();
    let router = front_brief(&workflow(), "C:/p", ReplyStyle::Router).unwrap();
    assert!(translator.contains("in your own words") && translator.contains("one click away"));
    assert!(router.contains("quote it") && !router.contains("in your own words"));
}

#[test]
fn the_plan_and_first_message_carry_the_brief_and_the_request() {
    let p = plan(&workflow(), "C:/p", ReplyStyle::Router, "  fix the login bug ").unwrap();
    assert_eq!((p.front_agent.as_str(), p.front_model.as_deref(), p.start_mode.as_str(), p.helper_cap), ("claude", Some("haiku"), "front", 3));
    assert_eq!(p.helpers.len(), 2);
    assert_eq!(p.helpers[1].kind, "spin_off");
    assert_eq!(p.reply_style, "router");
    let msg = p.first_message.clone();
    assert_eq!(msg, first_message(&p.brief, "fix the login bug"));
    assert!(msg.starts_with("You are the front of the workflow"));
    assert!(msg.ends_with("The person's request:\nfix the login bug"));
}

#[test]
fn a_horde_helper_waits_for_the_front() {
    let c = workflow();
    let task = horde_task(&c, &c.roles[1], "C:/p");
    assert!(task.contains("Wait now") && task.contains("hard coding tasks") && task.contains("Keep answers short."));
}

fn horde() -> Crew {
    Crew { start_mode: Some("horde".into()), ..workflow() }
}

#[test]
fn in_horde_mode_the_brief_says_the_helpers_are_started_and_not_to_start_new_ones() {
    let brief = front_brief(&horde(), "C:/p", ReplyStyle::Translator).unwrap();
    assert!(brief.contains("starts all of them right after this message"));
    assert!(brief.contains("Do not start new ones for these roles"));
    assert!(brief.contains("run_agent with its pane_id"));
    assert!(!brief.contains("Start it with run_agent"), "no start recipe in horde mode");
    assert!(front_brief(&workflow(), "C:/p", ReplyStyle::Translator).unwrap().contains("Start it with run_agent"));
}

#[test]
fn the_horde_note_names_each_started_pane() {
    let note = horde_note(&[("Hard".into(), "pane-7".into()), ("Easy".into(), "pane-8".into())]);
    assert!(note.contains("- Hard: pane_id pane-7") && note.contains("- Easy: pane_id pane-8"));
    assert!(note.contains("Do not start new ones"));
}

#[test]
fn the_brief_is_honest_about_standbys_and_small_prompts() {
    let brief = front_brief(&workflow(), "C:/p", ReplyStyle::Translator).unwrap();
    assert!(brief.contains("When you name a model, a fresh agent starts"));
    assert!(!brief.contains("is taken by run_agent by itself"));
    assert!(brief.contains("do not use answer_prompt for a helper"));
}

#[test]
fn each_refusal_of_the_workflow_commands() {
    assert_eq!(refuse_off(false).unwrap().code, "WORKFLOWS_OFF");
    assert!(refuse_off(true).is_none());
    let plain = Crew { name: "x".into(), roles: vec![role("Lead", None)], ..Crew::default() };
    assert_eq!(refuse_horde_start(&plain, true).unwrap().code, "WORKFLOW_NOT_FOUND");
    assert_eq!(refuse_horde_start(&workflow(), true).unwrap().code, "WORKFLOW_NOT_HORDE");
    assert_eq!(refuse_horde_start(&horde(), false).unwrap().code, "WORKFLOW_NO_FRONT");
    assert!(refuse_horde_start(&horde(), true).is_none());
}

#[test]
fn a_workflow_cannot_start_twice_at_once() {
    let first = StartGuard::claim("wf-double-start-test").unwrap();
    assert_eq!(StartGuard::claim("wf-double-start-test").unwrap_err().code, "CREW_STARTING");
    drop(first);
    assert!(StartGuard::claim("wf-double-start-test").is_ok());
}

#[test]
fn a_plain_crew_is_not_a_workflow_even_if_a_role_has_a_when_line() {
    let plain = Crew { name: "p".into(), roles: vec![role("Lead", None), Role { when_to_use: Some("x".into()), ..role("W", Some("Lead")) }], ..Crew::default() };
    assert!(!super::workflow::is_workflow(&plain));
}

#[test]
fn a_crew_without_a_front_reads_as_a_workflow_led_by_its_lead() {
    use super::workflow::{helpers_of, is_workflow, with_default_front};
    let old = Crew { name: "Old".into(), roles: vec![role("Lead", None), role("Worker", Some("Lead")), role("Checker", Some("Lead"))], ..Crew::default() };
    let before = to_toml(&old).unwrap();
    let derived = with_default_front(&old);
    assert!(is_workflow(&derived));
    assert_eq!(front_of(&derived).unwrap().name, "Lead");
    assert_eq!(helpers_of(&derived).len(), 2);
    let p = plan(&derived, "C:/p", ReplyStyle::default(), "hi").unwrap();
    assert_eq!((p.helpers.len(), p.start_mode.as_str()), (2, "horde"));
    assert!(p.helpers.iter().all(|h| h.kind == "minion" && h.when_to_use.is_empty()));
    let brief = front_brief(&derived, "C:/p", ReplyStyle::default()).unwrap();
    assert!(brief.contains("- Worker - use for:"));
    // the saved crew is untouched, byte for byte
    assert!(!is_workflow(&old));
    assert_eq!(to_toml(&old).unwrap(), before);
    assert!(!to_toml(&derived).unwrap().is_empty());
}

#[test]
fn a_real_front_is_kept_and_an_empty_crew_stays_empty() {
    use super::workflow::with_default_front;
    let w = workflow();
    assert_eq!(with_default_front(&w), w);
    let empty = Crew { name: "None".into(), ..Crew::default() };
    assert_eq!(with_default_front(&empty), empty);
    assert!(plan(&with_default_front(&empty), "C:/p", ReplyStyle::default(), "").is_none());
}

#[test]
fn a_derived_front_starts_the_whole_crew_and_a_real_front_keeps_its_mode() {
    use super::workflow::with_default_front;
    let flat = Crew { name: "Flat".into(), roles: vec![role("Lead", None), role("Worker", Some("Lead"))], ..Crew::default() };
    let p = plan(&with_default_front(&flat), "C:/p", ReplyStyle::default(), "").unwrap();
    assert_eq!(p.start_mode, "horde");
    // a start mode the crew saved is kept
    let mut front_only = flat.clone();
    front_only.start_mode = Some("front".into());
    assert_eq!(plan(&with_default_front(&front_only), "C:/p", ReplyStyle::default(), "").unwrap().start_mode, "front");
    // a real front keeps its own mode (the default is `front`), and nothing is added to it
    assert_eq!(plan(&workflow(), "C:/p", ReplyStyle::default(), "").unwrap().start_mode, "front");
    assert_eq!(with_default_front(&workflow()), workflow());
    // the saved crew has no start mode
    assert!(flat.start_mode.is_none());
}

#[test]
fn a_deeper_crew_or_one_that_hands_work_on_is_not_read_as_a_workflow() {
    use super::workflow::{is_workflow, with_default_front};
    let deep = Crew { name: "Deep".into(), roles: vec![role("Lead", None), role("Worker", Some("Lead")), role("Checker", Some("Worker"))], ..Crew::default() };
    assert!(!is_workflow(&with_default_front(&deep)));
    let mut hands = Crew { name: "Hands".into(), roles: vec![role("Lead", None), role("Worker", Some("Lead"))], ..Crew::default() };
    hands.roles[1].hands_to = vec!["Lead".into()];
    assert!(!is_workflow(&with_default_front(&hands)));
    let two_roots = Crew { name: "Two".into(), roles: vec![role("A", None), role("B", None)], ..Crew::default() };
    assert!(!is_workflow(&with_default_front(&two_roots)));
}
