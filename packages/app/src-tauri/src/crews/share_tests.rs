//! 1.1.8 sharing a crew as a file: what goes into the file, and that reading one only describes it.

use super::model::{Crew, Permissions, Role};
use super::share::{export, read, MAX_ROUTING_BYTES, MAX_SHARE_BYTES};
use super::templates;
use super::validate::{normalized, validate_with, AgentState};

fn ready(agent: &str) -> AgentState {
    if agent == "claude" || agent == "{default}" { AgentState::Ready } else { AgentState::Unknown }
}
fn any_model(_: &str, _: &str) -> bool {
    true
}
fn keep(text: &str) -> String {
    text.to_string()
}

fn how_we_work() -> (Crew, String) {
    let slug = "template:how-we-work";
    (templates::lookup(slug).unwrap(), templates::routing_text(slug).unwrap().to_string())
}

#[test]
fn how_we_work_is_a_valid_template_of_six_roles() {
    let (crew, rules) = how_we_work();
    assert_eq!(crew.name, "How we work");
    let names: Vec<&str> = crew.roles.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["Lead", "Scout", "Worker (easy)", "Worker (medium)", "Worker (hard)", "Checker"]);
    assert!(rules.contains("worker-easy"));
    let problems = validate_with(&normalized(&crew), &ready, &any_model);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(templates::all().len(), 2);
    assert_eq!(templates::all()[0].0, "template:our-way");
}

#[test]
fn a_shared_file_reads_back_the_same_crew_and_rules() {
    let (crew, rules) = how_we_work();
    let text = export(&crew, &rules, &keep).unwrap();
    let preview = read(&text, &ready, &any_model).unwrap();
    assert_eq!(preview.crew, normalized(&crew));
    assert_eq!(preview.routing_text, rules);
    assert!(preview.problems.is_empty());
    assert_eq!(preview.may_merge, ["Lead"]);
    assert_eq!(preview.may_start_helpers, ["Lead"]);
    assert_eq!(preview.runs_commands, ["Worker (easy)", "Worker (medium)", "Worker (hard)", "Checker"]);
}

#[test]
fn free_text_is_redacted_when_the_file_is_written() {
    let (mut crew, _) = how_we_work();
    crew.roles[0].task = "Use token sk-secret here".into();
    let text = export(&crew, "rule sk-secret", &|t| t.replace("sk-secret", "[hidden]")).unwrap();
    assert!(!text.contains("sk-secret"));
    assert!(text.contains("[hidden]"));
}

#[test]
fn a_file_with_an_unknown_key_or_the_wrong_format_is_refused() {
    let (crew, rules) = how_we_work();
    let good = export(&crew, &rules, &keep).unwrap();
    let extra = good.replacen("\"version\": 1", "\"version\": 1, \"command\": \"rm -rf /\"", 1);
    assert_eq!(read(&extra, &ready, &any_model).unwrap_err().code, "CREW_SHARE_INVALID");
    let role_extra = good.replacen("\"name\": \"Lead\"", "\"name\": \"Lead\", \"api_key\": \"x\"", 1);
    assert_eq!(read(&role_extra, &ready, &any_model).unwrap_err().code, "CREW_SHARE_INVALID");
    let other = good.replacen("potato-crew", "something-else", 1);
    assert_eq!(read(&other, &ready, &any_model).unwrap_err().code, "CREW_SHARE_INVALID");
    let newer = good.replacen("\"version\": 1", "\"version\": 9", 1);
    assert_eq!(read(&newer, &ready, &any_model).unwrap_err().code, "CREW_SHARE_VERSION");
    assert_eq!(read("not json", &ready, &any_model).unwrap_err().code, "CREW_SHARE_INVALID");
}

#[test]
fn a_file_that_is_too_big_or_holds_odd_rules_is_refused() {
    let (crew, _) = how_we_work();
    let long = "a".repeat(MAX_ROUTING_BYTES + 1);
    let text = export(&crew, &long, &keep).unwrap();
    assert_eq!(read(&text, &ready, &any_model).unwrap_err().code, "CREW_ROUTING_TOO_BIG");
    let odd = export(&crew, "rule\u{7}bell", &keep).unwrap();
    assert_eq!(read(&odd, &ready, &any_model).unwrap_err().code, "CREW_SHARE_INVALID");
    assert_eq!(read(&" ".repeat(MAX_SHARE_BYTES + 1), &ready, &any_model).unwrap_err().code, "CREW_FILE_TOO_BIG");
}

#[test]
fn the_validator_decides_what_a_shared_crew_may_hold() {
    let crew = Crew {
        name: "Odd".into(),
        roles: vec![Role {
            name: "Lead".into(),
            agent_type: "ghost-agent".into(),
            task: "Work in {folder} and {home}".into(),
            permissions: Some(Permissions { read: true, write: "scoped".into(), write_scope: Some("C:\\secret".into()), run: "none".into(), start_helpers: false, merge: false }),
            ..Role::default()
        }],
        ..Crew::default()
    };
    let text = export(&crew, "", &keep).unwrap();
    let preview = read(&text, &ready, &any_model).unwrap();
    assert!(preview.problems.len() >= 2, "{:?}", preview.problems);
}
