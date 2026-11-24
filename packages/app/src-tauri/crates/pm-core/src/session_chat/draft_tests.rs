use super::*;

#[test]
fn the_last_writer_wins_and_blank_text_clears() {
    let d = Drafts::default();
    assert_eq!(d.get("p1"), None);
    d.set("p1", "half a mess", 10);
    d.set("p1", "half a message", 20);
    assert_eq!(d.get("p1").unwrap().text, "half a message");
    assert_eq!(d.get("p1").unwrap().at, 20);
    d.set("p1", "   \n", 30);
    assert_eq!(d.get("p1"), None);
    assert_eq!(answer(d.get("p1"))["text"], "");
}

#[test]
fn a_long_draft_is_cut_and_old_drafts_make_room() {
    let d = Drafts::default();
    let kept = d.set("p1", &"x".repeat(MAX_CHARS + 500), 1).unwrap();
    assert_eq!(kept.text.chars().count(), MAX_CHARS);
    for n in 0..(MAX_DRAFTS + 5) {
        d.set(&format!("q{n}"), "hello", 100 + n as u64);
    }
    assert_eq!(d.get("p1"), None, "the oldest draft went first");
    assert!(d.get(&format!("q{}", MAX_DRAFTS + 4)).is_some());
    assert!(lock(&d.by_pane).len() <= MAX_DRAFTS);
}

#[test]
fn a_closed_chat_forgets_its_draft() {
    let d = Drafts::default();
    d.set("p1", "hello", 1);
    d.forget("p1");
    assert_eq!(d.get("p1"), None);
}
