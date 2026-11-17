use super::*;
use crate::crews::templates;

fn crew() -> Crew {
    templates::lookup("template:our-way").unwrap()
}

fn helper(name: &str, agent: &str, project: &str) -> StandbyHelper {
    StandbyHelper { id: "sb-1".into(), name: name.into(), agent: agent.into(), model: None, project: project.into(), after_task: AfterTask::Wait, home: None, warm: false, kind: Default::default() }
}

#[test]
fn our_way_gets_six_one_time_helpers_ready_and_the_designer_none() {
    let p = plan(&crew(), "D:/work", &[], &|_| true);
    assert_eq!(p.to_add.len(), 6);
    assert_eq!(p.already, 0);
    assert!(p.to_add.iter().all(|h| h.project == "D:/work" && h.after_task == AfterTask::Close));
    assert!(p.to_add.iter().any(|h| h.name == "Our way · Worker (easy) 2"));
    assert!(p.to_add.iter().any(|h| h.name == "Our way · Scout" && h.model.as_deref() == Some("haiku")));
}

#[test]
fn applying_twice_adds_nothing_new() {
    let first = plan(&crew(), "D:/work", &[], &|_| true);
    let existing: Vec<StandbyHelper> = first.to_add.iter().map(|h| helper(&h.name, &h.agent, &h.project)).collect();
    let again = plan(&crew(), "D:/work", &existing, &|_| true);
    assert!(again.to_add.is_empty());
    assert_eq!(again.already, 6);
}

#[test]
fn the_same_crew_in_another_folder_is_new() {
    let first = plan(&crew(), "D:/work", &[], &|_| true);
    let existing: Vec<StandbyHelper> = first.to_add.iter().map(|h| helper(&h.name, &h.agent, &h.project)).collect();
    assert_eq!(plan(&crew(), "D:/other", &existing, &|_| true).to_add.len(), 6);
}

#[test]
fn an_agent_that_cannot_wait_is_skipped_and_named() {
    let p = plan(&crew(), "D:/work", &[], &|agent| agent != "opencode");
    assert_eq!(p.to_add.len(), 5);
    assert_eq!(p.skipped.len(), 1);
    assert_eq!(p.skipped[0].role, "Worker (medium)");
}

#[test]
fn a_long_name_is_cut_to_the_limit_and_keeps_its_number() {
    let name = helper_name("A very long crew name that goes on and on", "Worker", 2, 3);
    assert!(name.chars().count() <= 40);
    assert!(name.ends_with(" 2"));
}
