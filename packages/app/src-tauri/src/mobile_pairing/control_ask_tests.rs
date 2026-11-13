use super::*;

fn watch() -> PaneRule {
    PaneRule { remote: true, level: Level::Watch }
}

#[test]
fn one_ask_per_agent_per_five_minutes() {
    let mut asks = Asks::default();
    let first = asks.ask("d1", "Phone A", "p1", watch(), 1_000).unwrap();
    assert_eq!(first.pane_id, "p1");
    // The same agent, even from another phone, waits.
    assert_eq!(asks.ask("d2", "Phone B", "p1", watch(), 1_000 + 60_000), Err(Refusal::TooSoon { retry_after_ms: ASK_GAP_MS - 60_000 }));
    // Another agent is its own ask.
    assert!(asks.ask("d1", "Phone A", "p2", watch(), 2_000).is_ok());
    // After the gap it is allowed again.
    assert!(asks.ask("d1", "Phone A", "p1", watch(), 1_000 + ASK_GAP_MS).is_ok());
}

#[test]
fn an_agent_that_is_already_open_takes_no_ask() {
    let mut asks = Asks::default();
    assert_eq!(asks.ask("d", "n", "p", PaneRule::default(), 1), Err(Refusal::AlreadyAllowed));
    // A switched-off agent can be asked for.
    assert!(asks.ask("d", "n", "p", PaneRule { remote: false, level: Level::Full }, 1).is_ok());
}

#[test]
fn allow_lasts_fifteen_minutes_and_puts_the_old_rule_back() {
    let mut asks = Asks::default();
    let ask = asks.ask("d", "n", "p", watch(), 10).unwrap();
    let (_, before) = asks.answer(&ask.id, true, watch(), 100).unwrap();
    assert_eq!(before, Some(watch()));
    assert!(asks.expired(100 + GRANT_MS - 1).is_empty());
    assert_eq!(asks.expired(100 + GRANT_MS), vec![("p".to_string(), watch())]);
    assert!(asks.expired(100 + 2 * GRANT_MS).is_empty());
}

#[test]
fn no_changes_nothing_and_an_answered_ask_is_gone() {
    let mut asks = Asks::default();
    let ask = asks.ask("d", "n", "p", watch(), 10).unwrap();
    let (_, before) = asks.answer(&ask.id, false, watch(), 20).unwrap();
    assert_eq!(before, None);
    assert!(asks.expired(u64::MAX).is_empty());
    assert!(asks.answer(&ask.id, true, watch(), 30).is_none());
    assert!(asks.pending().is_empty());
}

#[test]
fn a_second_allow_keeps_what_the_person_had_set() {
    let mut asks = Asks::default();
    let a = asks.ask("d", "n", "p", watch(), 10).unwrap();
    asks.answer(&a.id, true, watch(), 100).unwrap();
    // Later (after the gap) another ask while the grant runs: the rule now is full, but "before" stays watch.
    let b = asks.ask("d", "n", "p", PaneRule { remote: true, level: Level::Answer }, 10 + ASK_GAP_MS).unwrap();
    let (_, before) = asks.answer(&b.id, true, PaneRule::default(), 200 + ASK_GAP_MS).unwrap();
    assert_eq!(before, Some(watch()));
}

#[test]
fn the_person_changing_the_rule_ends_a_grant() {
    let mut asks = Asks::default();
    let a = asks.ask("d", "n", "p", watch(), 10).unwrap();
    asks.answer(&a.id, true, watch(), 100).unwrap();
    asks.forget_grant("p");
    assert!(asks.expired(u64::MAX).is_empty());
}

#[test]
fn too_many_waiting_asks_are_refused() {
    let mut asks = Asks::default();
    for n in 0..20 {
        asks.ask("d", "n", &format!("p{n}"), watch(), 1).unwrap();
    }
    assert_eq!(asks.ask("d", "n", "p-extra", watch(), 1), Err(Refusal::Busy));
}
