//! A person closes an agent's pane: its helpers (and theirs) close with it, unless the setting is off
//! or the app is ending. Stub panes only; no agent is started.

use super::helper_cascade::{close_with_helpers, helpers_of};
use super::*;

fn registry_with(panes: &[(&str, Option<&str>)]) -> Mutex<PaneRegistry> {
    let registry = Mutex::new(PaneRegistry::default());
    {
        let mut reg = registry.lock();
        for (id, parent) in panes {
            let mut pane = PaneRegistry::test_pane_stub(id);
            pane.info.parent_pane_id = parent.map(str::to_string);
            reg.panes.insert((*id).to_string(), pane);
        }
    }
    registry
}

fn ids(registry: &Mutex<PaneRegistry>) -> Vec<String> {
    let mut ids: Vec<String> = registry.lock().panes.keys().cloned().collect();
    ids.sort();
    ids
}

#[test]
fn closing_the_orchestrator_closes_its_helpers_and_their_helpers() {
    let registry = registry_with(&[
        ("boss", None),
        ("h1", Some("boss")),
        ("h2", Some("boss")),
        ("h1-sub", Some("h1")),
        ("h1-sub-sub", Some("h1-sub")),
        ("other", None),
        ("other-helper", Some("other")),
    ]);
    close_with_helpers(&registry, "boss", Some("test"), true, false).unwrap();
    assert_eq!(ids(&registry), vec!["other", "other-helper"], "only the unrelated panes are left");
}

#[test]
fn closing_a_helper_leaves_its_orchestrator_and_siblings() {
    let registry = registry_with(&[("boss", None), ("h1", Some("boss")), ("h2", Some("boss")), ("h1-sub", Some("h1"))]);
    close_with_helpers(&registry, "h1", Some("test"), true, false).unwrap();
    assert_eq!(ids(&registry), vec!["boss", "h2"]);
}

#[test]
fn with_the_setting_off_the_helpers_stay() {
    let registry = registry_with(&[("boss", None), ("h1", Some("boss")), ("h1-sub", Some("h1"))]);
    close_with_helpers(&registry, "boss", Some("test"), false, false).unwrap();
    assert_eq!(ids(&registry), vec!["h1", "h1-sub"], "same as today: only the pane itself closes");
}

#[test]
fn while_the_app_is_ending_the_helpers_are_not_closed_one_by_one() {
    let registry = registry_with(&[("boss", None), ("h1", Some("boss")), ("h1-sub", Some("h1"))]);
    close_with_helpers(&registry, "boss", Some("test"), true, true).unwrap();
    assert_eq!(ids(&registry), vec!["h1", "h1-sub"], "the app's own exit closes them (and keeps chats restorable)");
}

#[test]
fn a_loop_in_the_links_ends() {
    let registry = registry_with(&[("a", Some("c")), ("b", Some("a")), ("c", Some("b")), ("self", Some("self"))]);
    assert_eq!(helpers_of(&registry, "a"), vec!["b", "c"]);
    close_with_helpers(&registry, "a", Some("test"), true, false).unwrap();
    assert_eq!(ids(&registry), vec!["self"]);
    close_with_helpers(&registry, "self", Some("test"), true, false).unwrap();
    assert!(ids(&registry).is_empty());
}

#[test]
fn a_pane_without_helpers_or_that_is_gone_closes_fine() {
    let registry = registry_with(&[("alone", None)]);
    close_with_helpers(&registry, "alone", None, true, false).unwrap();
    close_with_helpers(&registry, "alone", None, true, false).unwrap();
    assert!(ids(&registry).is_empty());
}

#[test]
fn the_public_entry_reads_the_setting() {
    use crate::agent_run_mode::{with_test_env, TestEnv};
    let on = registry_with(&[("boss", None), ("h", Some("boss"))]);
    with_test_env(TestEnv::default(), || kill_pane_and_helpers(&on, "boss", None).unwrap());
    assert!(ids(&on).is_empty(), "default: on");
    let off = registry_with(&[("boss", None), ("h", Some("boss"))]);
    with_test_env(TestEnv { close_helpers_with_agent: Some(false), ..TestEnv::default() }, || kill_pane_and_helpers(&off, "boss", None).unwrap());
    assert_eq!(ids(&off), vec!["h"]);
}
