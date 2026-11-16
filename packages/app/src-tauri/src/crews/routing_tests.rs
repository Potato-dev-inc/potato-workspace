use super::*;
use crate::crews::templates;

fn our_way() -> (Crew, &'static str) {
    (templates::lookup("template:our-way").unwrap(), templates::routing_text("template:our-way").unwrap())
}

#[test]
fn a_small_copy_task_goes_to_the_easy_worker() {
    let (crew, text) = our_way();
    let p = preview(&crew, text, "Fix the copy of an empty state and style the button").unwrap();
    assert_eq!(p.route.role, "worker-easy");
    assert!(!p.route.fallback);
    assert_eq!(p.path, vec!["lead", "worker-easy", "checker"]);
}

#[test]
fn a_task_that_touches_rust_and_the_screen_goes_to_the_hard_worker() {
    let (crew, text) = our_way();
    let p = preview(&crew, text, "Rust and screen together, an unknown cause in security of the bridge").unwrap();
    assert_eq!(p.route.role, "worker-hard");
    assert!(p.others.contains(&"worker-easy".to_string()));
}

#[test]
fn a_task_no_rule_fits_starts_with_the_cheapest_way_and_says_so() {
    let (crew, text) = our_way();
    let p = preview(&crew, text, "xyzzy plugh").unwrap();
    assert!(p.route.fallback);
    assert_eq!(p.route.role, "worker-easy");
    assert!(p.route.why.contains("cheapest"));
}

#[test]
fn words_from_ask_me_first_are_named() {
    let (crew, text) = our_way();
    let p = preview(&crew, text, "Publish a release and empty the trash").unwrap();
    assert!(p.needs_you.contains(&"release".to_string()));
    assert!(p.needs_you.contains(&"trash".to_string()));
}

#[test]
fn a_file_that_names_no_role_of_the_crew_gives_no_route() {
    let (crew, _) = our_way();
    assert!(preview(&crew, "Easy -> nobody\n- copy", "copy").is_none());
    assert!(preview(&crew, "", "copy").is_none());
}
