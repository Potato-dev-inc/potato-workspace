//! 1.1.6 crew foundations: the wider model, the new checks, the config sections, the template and the views.

use super::config_format;
use super::model::{parse, Budget, Crew, Permissions, Role};
use super::validate::{normalized, validate, validate_with, AgentState};
use super::{starters, templates, view};

fn ready(agent: &str) -> AgentState {
    match agent {
        "claude" | "opencode" | "codex" => AgentState::Ready,
        "shell" => AgentState::NotDispatchable("a plain shell".into()),
        _ => AgentState::Unknown,
    }
}

/// Claude knows three models; every other agent takes any name.
fn model_ok(agent: &str, model: &str) -> bool {
    agent != "claude" || ["opus", "sonnet", "haiku", "fable"].contains(&model)
}

fn codes(crew: &Crew) -> Vec<&'static str> {
    validate_with(&normalized(crew), &ready, &model_ok).iter().map(|e| e.code).collect()
}

fn perms(write: &str, run: &str) -> Permissions {
    Permissions { read: true, write: write.into(), write_scope: None, run: run.into(), start_helpers: false, merge: false }
}

fn role(name: &str, parent: Option<&str>) -> Role {
    Role { name: name.into(), agent_type: "claude".into(), task: format!("Do the {name} job in {{folder}}"), parent: parent.map(String::from), ..Role::default() }
}

fn crew(roles: Vec<Role>) -> Crew {
    Crew { name: "Test crew".into(), roles, ..Crew::default() }
}

fn lead_and(workers: Vec<Role>) -> Crew {
    let mut roles = vec![role("Lead", None)];
    roles.extend(workers);
    crew(roles)
}

#[test]
fn an_older_saved_crew_still_reads_and_passes() {
    for (slug, crew) in starters::all() {
        assert!(validate(&crew, &|_| AgentState::Ready).is_empty(), "{slug}");
        assert!(crew.roles.iter().all(|r| r.model.is_none() && r.permissions.is_none() && r.hands_to.is_empty()));
    }
}

#[test]
fn the_template_our_way_is_valid_with_every_field_filled() {
    let (slug, ours) = templates::all().into_iter().next().expect("one template");
    assert_eq!(slug, "template:our-way");
    assert_eq!(ours.name, "Our way");
    assert_eq!(codes(&ours), Vec::<&str>::new());
    assert_eq!(ours.roles.len(), 7);
    assert_eq!(ours.routing_file.as_deref(), Some("difficulty.md"));
    assert_eq!((ours.max_helpers, ours.fix_loops), (Some(16), Some(2)));
    assert_eq!(ours.budget, Some(Budget { turns: Some(300), minutes: Some(600) }));
    let checker = ours.roles.iter().find(|r| r.id == "checker").unwrap();
    assert!(checker.check && checker.hands_to == ["lead"]);
    // Warm standbys: scout 1, easy 2, medium 1, hard 1, checker 1.
    assert_eq!(ours.roles.iter().map(|r| u32::from(r.standbys)).sum::<u32>(), 6);
    let lead = ours.roles.iter().find(|r| r.id == "lead").unwrap();
    assert!(lead.permissions.as_ref().is_some_and(|p| p.merge && p.start_helpers));
    assert!(ours.roles.iter().filter(|r| r.id != "lead").all(|r| r.permissions.as_ref().is_some_and(|p| !p.merge && !p.start_helpers)));
    // The routing file is shipped and names the same tiers.
    let text = templates::routing_text("template:our-way").expect("the draft difficulty.md");
    assert!(text.starts_with("# How work is routed") && text.contains("worker-hard"));
}

#[test]
fn a_template_is_never_a_starter_and_never_a_saved_name() {
    assert!(starters::all().iter().all(|(slug, _)| !slug.starts_with("template:")));
    assert!(starters::lookup("template:our-way").is_none());
    assert!(!super::store::valid_slug("template:our-way"));
}

#[test]
fn an_unknown_agent_and_a_not_dispatchable_one_are_named_on_their_role() {
    let mut a = role("Scout", Some("Lead"));
    a.agent_type = "mystery".into();
    let mut b = role("Typist", Some("Lead"));
    b.agent_type = "shell".into();
    let errors = validate_with(&lead_and(vec![a, b]), &ready, &model_ok);
    assert!(errors.iter().any(|e| e.code == "CREW_AGENT_UNKNOWN" && e.role.as_deref() == Some("Scout")));
    assert!(errors.iter().any(|e| e.code == "CREW_AGENT_NOT_DISPATCHABLE" && e.role.as_deref() == Some("Typist")));
}

#[test]
fn a_model_is_checked_only_where_the_agent_has_a_list() {
    let mut known = role("Known", Some("Lead"));
    known.model = Some("sonnet".into());
    let mut wrong = role("Wrong", Some("Lead"));
    wrong.model = Some("gpt-9".into());
    let mut free = role("Free", Some("Lead"));
    free.agent_type = "opencode".into();
    free.model = Some("anything/goes".into());
    let mut gone = role("Gone", Some("Lead"));
    gone.agent_type = "mystery".into();
    gone.model = Some("gpt-9".into());
    let errors = validate_with(&lead_and(vec![known, wrong, free, gone]), &ready, &model_ok);
    let model_errors: Vec<_> = errors.iter().filter(|e| e.code == "CREW_MODEL_UNKNOWN").collect();
    assert_eq!(model_errors.len(), 1, "{errors:?}");
    assert_eq!(model_errors[0].role.as_deref(), Some("Wrong"));
    // `validate` (no model lists) never asks.
    let mut wrong = role("Wrong", Some("Lead"));
    wrong.model = Some("gpt-9".into());
    assert!(validate(&lead_and(vec![wrong]), &ready).is_empty());
}

#[test]
fn a_permission_that_is_not_allowed_is_refused() {
    let mut bad_write = role("A", Some("Lead"));
    bad_write.permissions = Some(perms("everywhere", "none"));
    let mut bad_run = role("B", Some("Lead"));
    bad_run.permissions = Some(perms("none", "sudo"));
    let mut scoped_without = role("C", Some("Lead"));
    scoped_without.permissions = Some(perms("scoped", "none"));
    let mut scope_path = role("D", Some("Lead"));
    scope_path.permissions = Some(Permissions { write_scope: Some("..\\etc".into()), ..perms("scoped", "none") });
    let mut stray_scope = role("E", Some("Lead"));
    stray_scope.permissions = Some(Permissions { write_scope: Some("docs".into()), ..perms("worktree", "none") });
    let mut blind = role("F", Some("Lead"));
    blind.permissions = Some(Permissions { read: false, ..perms("worktree", "none") });
    let mut worker_merges = role("G", Some("Lead"));
    worker_merges.permissions = Some(Permissions { merge: true, ..perms("worktree", "worktree") });
    let mut worker_starts = role("H", Some("Lead"));
    worker_starts.permissions = Some(Permissions { start_helpers: true, ..perms("none", "none") });
    let errors = validate_with(&lead_and(vec![bad_write, bad_run, scoped_without, scope_path, stray_scope, blind, worker_merges, worker_starts]), &ready, &model_ok);
    for name in ["A", "B", "C", "D", "E", "F", "G", "H"] {
        assert!(errors.iter().any(|e| e.code == "CREW_PERMISSION" && e.role.as_deref() == Some(name)), "{name}: {errors:?}");
    }
}

#[test]
fn the_lead_may_merge_and_start_helpers_but_a_merge_needs_a_shell() {
    let mut lead = role("Lead", None);
    lead.permissions = Some(Permissions { merge: true, start_helpers: true, write_scope: Some("plans".into()), ..perms("scoped", "ask") });
    assert!(codes(&crew(vec![lead.clone()])).is_empty());
    lead.permissions.as_mut().unwrap().run = "none".into();
    assert_eq!(codes(&crew(vec![lead])), vec!["CREW_PERMISSION"]);
}

#[test]
fn a_hand_off_must_name_another_role_and_every_role_needs_a_route() {
    let mut lead = role("Lead", None);
    lead.hands_to = vec!["Nobody".into(), "Lead".into()];
    let errors = codes(&crew(vec![lead]));
    assert!(errors.contains(&"CREW_EDGE_UNKNOWN") && errors.contains(&"CREW_EDGE_SELF"), "{errors:?}");
    // Two roles that only name each other as parents: nothing reaches them from the lead.
    let errors = codes(&crew(vec![role("Lead", None), role("B", Some("C")), role("C", Some("B"))]));
    assert!(errors.contains(&"CREW_NO_ROUTE"), "{errors:?}");
    // A role under the lead and handed to by an edge has a route.
    let mut lead = role("Lead", None);
    lead.hands_to = vec!["helper-1".into()];
    let mut helper = role("Helper", Some("Lead"));
    helper.id = "helper-1".into();
    assert!(codes(&crew(vec![lead, helper])).is_empty());
}

#[test]
fn the_only_loop_a_crew_may_have_is_the_checker_handing_back_to_the_lead() {
    let build = |checker_flag: bool, target: &str| {
        let mut lead = role("Lead", None);
        lead.hands_to = vec!["Worker".into(), "Checker".into()];
        let mut worker = role("Worker", Some("Lead"));
        worker.hands_to = vec!["Checker".into()];
        let mut checker = role("Checker", Some("Lead"));
        checker.check = checker_flag;
        checker.hands_to = vec![target.into()];
        crew(vec![lead, worker, checker])
    };
    assert!(codes(&build(true, "Lead")).is_empty());
    // The same edge from a role that is not a checker is a loop.
    assert!(codes(&build(false, "Lead")).contains(&"CREW_EDGE_CYCLE"));
    // A checker may hand back to the lead only: back to a worker makes a loop.
    assert!(codes(&build(true, "Worker")).contains(&"CREW_EDGE_CYCLE"));
}

#[test]
fn crew_numbers_and_the_routing_file_are_bounded() {
    let mut c = lead_and(vec![role("W", Some("Lead"))]);
    c.routing_file = Some("..\\difficulty.md".into());
    c.max_helpers = Some(0);
    c.fix_loops = Some(9);
    c.budget = Some(Budget { turns: Some(0), minutes: None });
    let errors = codes(&c);
    for want in ["CREW_ROUTING_FILE", "CREW_MAX_HELPERS", "CREW_FIX_LOOPS", "CREW_BUDGET"] {
        assert!(errors.contains(&want), "{want}: {errors:?}");
    }
    for bad in ["notes.txt", "a/b.md", ".md", ".hidden.md", "x..md"] {
        let mut c = lead_and(vec![]);
        c.routing_file = Some(bad.into());
        assert!(codes(&c).contains(&"CREW_ROUTING_FILE"), "{bad}");
    }
    let mut ok = lead_and(vec![]);
    ok.routing_file = Some("difficulty.md".into());
    assert!(codes(&ok).is_empty());
    // Warm standbys above max_helpers, and too many for one role.
    let mut warm = lead_and(vec![Role { standbys: 5, ..role("W", Some("Lead")) }]);
    warm.max_helpers = Some(3);
    let errors = codes(&warm);
    assert!(errors.contains(&"CREW_STANDBYS") && errors.contains(&"CREW_STANDBYS_OVER"), "{errors:?}");
}

#[test]
fn ids_name_roles_and_may_not_clash() {
    let mut a = role("Lead", None);
    a.id = "lead".into();
    let mut b = role("Second", Some("lead"));
    b.id = "LEAD".into();
    assert!(codes(&crew(vec![a.clone(), b])).contains(&"CREW_DUPLICATE_ROLE"));
    let mut c = role("Third", Some("lead"));
    c.id = "has space".into();
    assert!(codes(&crew(vec![a, c])).contains(&"CREW_ROLE_ID"));
}

#[test]
fn the_plan_cli_config_shape_reads_with_its_own_key_names() {
    let text = r#"
version = 1

[settings]
theme = "dark"

[crew.potato-lead]
route_by = "difficulty.md"
max_helpers = 16
fix_loops = 2
budget = { turns = 300, minutes = 600 }

[[crew.potato-lead.role]]
name = "lead"
agent = "claude"
model = "opus"
job = "Lead the crew in {folder}."
permissions = { read = true, write = "worktree", run = "ask", start_helpers = true, merge = true }
hands_to = ["scout"]

[[crew.potato-lead.role]]
name = "scout"
agent = "claude"
model = "haiku"
parent = "lead"
job = "Look things up."
warm = 1
"#;
    let crews = config_format::parse(text).unwrap();
    assert_eq!(crews.len(), 1);
    let (id, c) = &crews[0];
    assert_eq!((id.as_str(), c.name.as_str()), ("potato-lead", "potato-lead"));
    assert_eq!(c.routing_file.as_deref(), Some("difficulty.md"));
    assert_eq!(c.roles.len(), 2);
    assert_eq!(c.roles[1].standbys, 1);
    assert_eq!(codes(c), Vec::<&str>::new());
}

#[test]
fn a_config_file_round_trips_and_refuses_what_it_cannot_read() {
    let ours: Vec<(String, Crew)> = vec![("our-way".into(), templates::lookup("template:our-way").unwrap())];
    let text = config_format::render(&ours).unwrap();
    assert!(text.contains("version = 1") && text.contains("[[crew.our-way.role]]") && !text.contains("[[crew.our-way.roles]]"));
    assert_eq!(config_format::parse(&text).unwrap(), ours);
    assert_eq!(config_format::parse("version = 2\n[crew.x]\nname = \"X\"\n").unwrap_err().code, "CONFIG_VERSION");
    assert_eq!(config_format::parse("[crew.\"Bad Id\"]\nname = \"X\"\n").unwrap_err().code, "CREW_ID");
    assert_eq!(config_format::parse("[crew.x]\nname = \"X\"\nmystery = 1\n").unwrap_err().code, "CREW_FILE_INVALID");
    assert!(config_format::parse("version = 1\n[settings]\ntheme = \"dark\"\n").unwrap().is_empty());
}

#[test]
fn a_crew_file_in_the_config_spelling_also_reads_as_one_crew() {
    let c = parse("name = \"X\"\n[[role]]\nname = \"Lead\"\nagent = \"claude\"\njob = \"Go\"\n").unwrap();
    assert_eq!(c.roles[0].agent_type, "claude");
    assert_eq!(c.roles[0].task, "Go");
}

#[test]
fn view_validate_reports_every_crew_of_a_config_and_unreadable_text() {
    let good = config_format::render(&[("our-way".into(), templates::lookup("template:our-way").unwrap())]).unwrap();
    let r = view::validate_text(&good, &ready, &model_ok);
    assert_eq!((r["ok"].as_bool(), r["kind"].as_str()), (Some(true), Some("config")));
    assert_eq!(r["crews"][0]["roles"], 7);
    let broken = good.replace("model = \"opus\"", "model = \"gpt-9\"");
    let r = view::validate_text(&broken, &ready, &model_ok);
    assert_eq!(r["ok"], false);
    assert_eq!(r["crews"][0]["problems"][0]["code"], "CREW_MODEL_UNKNOWN");
    let r = view::validate_text("name = ", &ready, &model_ok);
    assert_eq!((r["ok"].as_bool(), r["problems"][0]["code"].as_str()), (Some(false), Some("CREW_FILE_INVALID")));
    let r = view::validate_text("version = 1\n", &ready, &model_ok);
    assert_eq!(r["ok"], false);
    let one = view::validate_text("name = \"Solo\"\n[[roles]]\nname = \"Lead\"\nagent_type = \"claude\"\ntask = \"Go\"\n", &ready, &model_ok);
    assert_eq!((one["ok"].as_bool(), one["kind"].as_str()), (Some(true), Some("crew")));
}

#[test]
fn view_list_and_show_cover_saved_crews_and_templates() {
    let dir = std::env::temp_dir().join(format!("pm-crew-base-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let saved = lead_and(vec![role("W", Some("Lead"))]);
    let slug = super::store::save(&dir, &saved, false, &ready).unwrap();
    let list = view::list(&dir, &ready);
    assert_eq!(list["crews"][0]["slug"], slug.as_str());
    assert_eq!(list["templates"][0]["slug"], "template:our-way");
    let shown = view::show(&dir, &slug, &ready, &model_ok).unwrap();
    assert_eq!((shown["kind"].as_str(), shown["crew"]["name"].as_str()), (Some("saved"), Some("Test crew")));
    assert!(shown["routing_text"].is_null());
    let ours = view::show(&dir, "template:our-way", &ready, &model_ok).unwrap();
    assert_eq!(ours["kind"], "template");
    assert!(ours["routing_text"].as_str().unwrap().contains("routed"));
    assert_eq!(view::show(&dir, "nope", &ready, &model_ok).unwrap_err().code, "CREW_NOT_FOUND");
    assert_eq!(view::show(&dir, "..\\x", &ready, &model_ok).unwrap_err().code, "CREW_NOT_FOUND");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_saved_crew_keeps_its_new_fields_through_the_file() {
    let dir = std::env::temp_dir().join(format!("pm-crew-base-rt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let ours = templates::lookup("template:our-way").unwrap();
    let slug = super::store::save(&dir, &ours, false, &ready).unwrap();
    assert_eq!(super::store::load(&dir, &slug).unwrap(), normalized(&ours));
    let _ = std::fs::remove_dir_all(&dir);
}
