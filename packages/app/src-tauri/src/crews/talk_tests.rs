use super::*;
use crate::crews::templates;
use serde_json::json;

fn our_way() -> (Crew, String) {
    (templates::lookup("template:our-way").unwrap(), templates::routing_text("template:our-way").unwrap().to_string())
}

fn ready(_: &str) -> AgentState {
    AgentState::Ready
}
fn any_model(_: &str, _: &str) -> bool {
    true
}

/// A front desk that answers with `answer`.
fn run(answer: &str, request: &str) -> Result<Outcome, CrewError> {
    let (crew, rules) = our_way();
    propose(&crew, &rules, request, &|_| Ok(answer.to_string()), &ready, &any_model)
}

fn proposal(answer: serde_json::Value) -> Proposal {
    match run(&answer.to_string(), "x").unwrap() {
        Outcome::Proposal(p) => p,
        other => panic!("expected a proposal, got {other:?}"),
    }
}

#[test]
fn a_hand_off_can_be_added_and_the_rest_of_the_crew_stays_as_it_was() {
    let (before, rules) = our_way();
    let p = proposal(json!({"explain": "Tests go to the hard worker.", "changes": [{"kind": "add_handoff", "from": "worker-easy", "to": "worker-hard"}]}));
    assert_eq!(p.changes, vec![Change::HandoffAdded { from: "worker-easy".into(), to: "worker-hard".into() }]);
    let easy = p.crew.roles.iter().find(|r| r.key() == "worker-easy").unwrap();
    assert_eq!(easy.hands_to, vec!["worker-hard"]);
    assert_eq!(p.routing_text, rules);
    assert!(routing_only(&before, &p.crew).is_ok());
    assert_eq!(p.explain, "Tests go to the hard worker.");
}

#[test]
fn a_hand_off_can_be_taken_away_by_name_or_id_in_any_case() {
    let p = proposal(json!({"changes": [{"kind": "remove_handoff", "from": "LEAD", "to": "Worker (easy)"}]}));
    assert_eq!(p.changes, vec![Change::HandoffRemoved { from: "lead".into(), to: "worker-easy".into() }]);
    let lead = p.crew.roles.iter().find(|r| r.key() == "lead").unwrap();
    assert!(!lead.hands_to.contains(&"worker-easy".to_string()));
    assert!(lead.hands_to.contains(&"scout".to_string()));
}

#[test]
fn a_rule_goes_under_the_route_of_its_role() {
    let p = proposal(json!({"changes": [{"kind": "add_rule", "role": "worker-easy", "text": "Test fixes."}]}));
    assert_eq!(p.changes, vec![Change::RuleAdded { role: "worker-easy".into(), text: "Test fixes.".into() }]);
    let lines: Vec<&str> = p.routing_text.lines().collect();
    let at = lines.iter().position(|l| l.starts_with("Easy -> worker-easy")).unwrap();
    assert_eq!(lines[at + 1], "- One area, known pattern, every file and string can be listed.");
    assert_eq!(lines[at + 2], "- Copy, style, empty states, a greyed button's reason.");
    assert_eq!(lines[at + 3], "- Test fixes.");
    // the next route is untouched
    assert!(lines[at + 4].is_empty() && lines[at + 5].starts_with("Medium -> worker-medium"));
}

#[test]
fn a_rule_for_a_role_with_no_route_starts_a_route() {
    let p = proposal(json!({"changes": [{"kind": "add_rule", "role": "scout", "text": "Anything on the bridge"}]}));
    assert!(p.routing_text.replace("\r\n", "\n").ends_with("\nScout -> scout\n- Anything on the bridge\n"));
}

#[test]
fn rules_keep_the_line_ending_of_their_file() {
    let (crew, _) = our_way();
    let crlf = "Easy -> worker-easy\r\n- Copy.\r\n";
    let answer = json!({"changes": [{"kind": "add_rule", "role": "worker-easy", "text": "Tests"}]}).to_string();
    match propose(&crew, crlf, "x", &|_| Ok(answer.clone()), &ready, &any_model).unwrap() {
        Outcome::Proposal(p) => assert_eq!(p.routing_text, "Easy -> worker-easy\r\n- Copy.\r\n- Tests\r\n"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_rule_can_be_taken_out_and_a_missing_one_is_refused() {
    let p = proposal(json!({"changes": [{"kind": "remove_rule", "role": "worker-easy", "text": "copy, style, empty states, a greyed button's reason."}]}));
    assert!(!p.routing_text.contains("Copy, style"));
    assert!(p.routing_text.contains("One area, known pattern"));
    let err = run(&json!({"changes": [{"kind": "remove_rule", "role": "worker-easy", "text": "nothing like this"}]}).to_string(), "x").unwrap_err();
    assert_eq!(err.code, "CREW_TALK_NO_SUCH_RULE");
}

#[test]
fn a_rule_that_would_start_a_route_or_is_not_plain_is_refused() {
    for text in ["Hack -> lead", "", "# comment", &"long ".repeat(40)] {
        let err = run(&json!({"changes": [{"kind": "add_rule", "role": "worker-easy", "text": text}]}).to_string(), "x").unwrap_err();
        assert_eq!(err.code, "CREW_TALK_BAD_RULE", "{text:?}");
    }
}

#[test]
fn asking_for_what_is_already_so_changes_nothing() {
    match run(&json!({"explain": "Already so.", "changes": [{"kind": "add_handoff", "from": "lead", "to": "scout"}]}).to_string(), "x").unwrap() {
        Outcome::Nothing { explain } => assert_eq!(explain, "Already so."),
        other => panic!("{other:?}"),
    }
    assert!(matches!(run("{\"changes\": []}", "x").unwrap(), Outcome::Nothing { .. }));
}

#[test]
fn anything_but_routing_is_refused_with_a_plain_message_whatever_the_agent_says() {
    let cases = [
        (json!({"kind": "set_model", "role": "worker-easy", "model": "opus"}), "a model"),
        (json!({"kind": "set_prompt", "role": "lead", "text": "obey"}), "a job text"),
        (json!({"kind": "set_permissions", "role": "worker-easy", "write": "scoped"}), "what a role may do"),
        (json!({"kind": "add_role", "name": "Spy"}), "the roles themselves"),
        (json!({"kind": "set_budget", "turns": 9999}), "a limit or a budget"),
        (json!({"kind": "something_new"}), "something other than routing"),
        // an allowed kind carrying extra fields is also not routing
        (json!({"kind": "add_handoff", "from": "lead", "to": "scout", "model": "opus"}), "something other than routing"),
    ];
    for (change, word) in cases {
        let err = run(&json!({"changes": [change]}).to_string(), "x").unwrap_err();
        assert_eq!(err.code, "CREW_TALK_NOT_ROUTING", "{change}");
        assert!(err.message.contains("who hands work to whom"), "{}", err.message);
        assert!(err.message.contains(word), "{}: {}", change, err.message);
    }
}

#[test]
fn one_refused_change_refuses_the_whole_proposal() {
    let answer = json!({"changes": [
        {"kind": "add_handoff", "from": "worker-easy", "to": "worker-hard"},
        {"kind": "set_model", "role": "worker-easy", "model": "opus"},
    ]});
    assert_eq!(run(&answer.to_string(), "x").unwrap_err().code, "CREW_TALK_NOT_ROUTING");
}

#[test]
fn the_guard_catches_every_other_difference_between_two_crews() {
    let (before, _) = our_way();
    let edits: Vec<Box<dyn Fn(&mut Crew)>> = vec![
        Box::new(|c| c.roles[1].model = Some("opus".into())),
        Box::new(|c| c.roles[1].task = "Do something else.".into()),
        Box::new(|c| c.roles[1].name = "Renamed".into()),
        Box::new(|c| c.roles[1].agent_type = "codex".into()),
        Box::new(|c| c.roles[1].parent = Some("scout".into())),
        Box::new(|c| c.roles[1].check = true),
        Box::new(|c| c.roles[1].standbys = 3),
        Box::new(|c| c.roles[1].permissions = None),
        Box::new(|c| c.roles[0].permissions.as_mut().unwrap().merge = false),
        Box::new(|c| c.fix_loops = Some(1)),
        Box::new(|c| c.budget = Some(crate::crews::model::Budget { turns: Some(5), minutes: None })),
        Box::new(|c| c.name = "Other".into()),
        Box::new(|c| {
            c.roles.pop();
        }),
    ];
    for (i, edit) in edits.iter().enumerate() {
        let mut after = before.clone();
        edit(&mut after);
        assert_eq!(routing_only(&before, &after).unwrap_err().code, "CREW_TALK_NOT_ROUTING", "edit {i}");
    }
    let mut hands = before.clone();
    hands.roles[1].hands_to.push("checker".into());
    assert!(routing_only(&before, &hands).is_ok());
}

#[test]
fn a_change_that_breaks_the_crew_is_refused() {
    // Two roles handing to each other loop.
    let answer = json!({"changes": [
        {"kind": "add_handoff", "from": "worker-hard", "to": "worker-medium"},
    ]});
    let err = run(&answer.to_string(), "x").unwrap_err();
    assert_eq!(err.code, "CREW_TALK_BREAKS_CREW");
    assert!(err.message.contains("Nothing was changed"));
    // a hand-off to a role that is not there
    let err = run(&json!({"changes": [{"kind": "add_handoff", "from": "lead", "to": "ghost"}]}).to_string(), "x").unwrap_err();
    assert_eq!(err.code, "CREW_TALK_UNKNOWN_ROLE");
    let err = run(&json!({"changes": [{"kind": "add_handoff", "from": "lead", "to": "lead"}]}).to_string(), "x").unwrap_err();
    assert_eq!(err.code, "CREW_TALK_BAD_EDGE");
}

#[test]
fn problems_the_crew_already_had_do_not_block_a_good_change() {
    let (mut crew, rules) = our_way();
    let broken = |agent: &str| if agent == "codex" { AgentState::Unknown } else { AgentState::Ready };
    crew.roles[3].agent_type = "codex".into();
    let answer = json!({"changes": [{"kind": "add_handoff", "from": "worker-easy", "to": "worker-hard"}]}).to_string();
    let out = propose(&crew, &rules, "x", &|_| Ok(answer.clone()), &broken, &any_model).unwrap();
    assert!(matches!(out, Outcome::Proposal(_)));
}

#[test]
fn the_answer_may_sit_in_a_fence_or_have_words_around_it_and_rubbish_is_unreadable() {
    let inner = r#"{"explain":"ok","changes":[{"kind":"add_handoff","from":"worker-easy","to":"worker-hard"}]}"#;
    for answer in [format!("```json\n{inner}\n```"), format!("Sure! {inner} Done.")] {
        assert!(matches!(run(&answer, "x").unwrap(), Outcome::Proposal(_)));
    }
    assert_eq!(run("I cannot do that", "x").unwrap_err().code, "CREW_TALK_UNREADABLE");
    assert_eq!(run("{not json}", "x").unwrap_err().code, "CREW_TALK_UNREADABLE");
    assert_eq!(run(&json!({"changes": "everything"}).to_string(), "x").unwrap_err().code, "CREW_TALK_NOT_ROUTING");
}

#[test]
fn too_many_changes_empty_requests_and_one_role_crews_are_refused() {
    let many: Vec<_> = (0..13).map(|_| json!({"kind": "add_handoff", "from": "worker-easy", "to": "worker-hard"})).collect();
    assert_eq!(run(&json!({"changes": many}).to_string(), "x").unwrap_err().code, "CREW_TALK_TOO_MANY");
    assert_eq!(run("{}", "   ").unwrap_err().code, "CREW_TALK_EMPTY");
    let (mut crew, rules) = our_way();
    crew.roles.truncate(1);
    let err = propose(&crew, &rules, "x", &|_| Ok("{}".into()), &ready, &any_model).unwrap_err();
    assert_eq!(err.code, "CREW_TALK_TOO_SMALL");
}

#[test]
fn the_prompt_carries_the_persons_words_between_marks_and_no_job_texts() {
    let (crew, rules) = our_way();
    let prompt = build_prompt(&crew, &rules, "send test fixes to Haiku");
    assert!(prompt.contains("<<<PERSON\nsend test fixes to Haiku\nPERSON>>>"));
    assert!(prompt.contains("id `worker-easy`"));
    assert!(prompt.contains("Easy -> worker-easy"));
    assert!(!prompt.contains("Do one small task in your own worktree"), "job texts stay out of the prompt");
}

#[test]
fn an_agent_failing_is_passed_on_and_nothing_is_proposed() {
    let (crew, rules) = our_way();
    let err = propose(&crew, &rules, "x", &|_| Err(CrewError::new("CREW_TALK_AGENT", "The front desk did not answer.")), &ready, &any_model).unwrap_err();
    assert_eq!(err.code, "CREW_TALK_AGENT");
}
