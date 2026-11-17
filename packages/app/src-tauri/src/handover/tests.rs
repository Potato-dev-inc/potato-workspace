use super::*;
use std::cell::RefCell;

/// A world of panes: `owner` per pane, who is a minion, what each task was asked and said, and every notice told.
#[derive(Default)]
struct Fake {
    owners: RefCell<HashMap<String, Option<String>>>,
    minions: Vec<&'static str>,
    done: RefCell<HashMap<String, String>>,
    told: RefCell<Vec<(String, String)>>,
    deaf: Vec<&'static str>,
}

impl Fake {
    fn new() -> Self {
        let f = Fake { minions: vec!["task"], ..Default::default() };
        {
            let mut o = f.owners.borrow_mut();
            o.insert("claude1".into(), None);
            o.insert("claude2".into(), None);
            o.insert("task".into(), Some("claude1".into()));
        }
        f
    }
    fn finish(&self, task: &str, result: &str) {
        self.done.borrow_mut().insert(task.into(), result.into());
    }
    fn told_to(&self, pane: &str) -> Vec<String> {
        self.told.borrow().iter().filter(|(p, _)| p == pane).map(|(_, t)| t.clone()).collect()
    }
    fn owner(&self, pane: &str) -> Option<String> {
        self.owners.borrow().get(pane).cloned().flatten()
    }
}

impl World for Fake {
    fn owner_of(&self, pane: &str) -> Option<Option<String>> {
        self.owners.borrow().get(pane).cloned()
    }
    fn is_minion(&self, pane: &str) -> bool {
        self.minions.contains(&pane)
    }
    fn is_chat(&self, _pane: &str) -> bool {
        true
    }
    fn exists(&self, pane: &str) -> bool {
        self.owners.borrow().contains_key(pane)
    }
    fn name_of(&self, pane: &str) -> String {
        match pane {
            "claude1" => "Claude 1".into(),
            "claude2" => "Claude 2".into(),
            "task" => "Reviewer".into(),
            other => other.into(),
        }
    }
    fn asked(&self, _task: &str) -> String {
        "Review the diff and list risky changes".into()
    }
    fn so_far(&self, _task: &str) -> String {
        "I looked at 3 files so far".into()
    }
    fn finished(&self, task: &str) -> Option<String> {
        self.done.borrow().get(task).cloned()
    }
    fn move_to(&self, task: &str, to: &str) {
        self.owners.borrow_mut().insert(task.into(), Some(to.into()));
    }
    fn tell(&self, pane: &str, text: &str) -> bool {
        if self.deaf.contains(&pane) {
            return false;
        }
        self.told.borrow_mut().push((pane.into(), text.into()));
        true
    }
}

fn new_book() -> Mutex<Book> {
    Mutex::new(Book::default())
}

#[test]
fn dropping_a_task_on_the_agent_that_has_it_does_nothing() {
    let w = Fake::new();
    let b = new_book();
    assert_eq!(hand_over(&w, &b, "task", "claude1", Mode::Now), Err(Refused(SAME)));
    assert!(w.told.borrow().is_empty());
    assert_eq!(w.owner("task").as_deref(), Some("claude1"));
    assert!(!b.lock().is_handed("task"));
}

#[test]
fn hand_over_now_moves_it_and_tells_both_agents_plainly() {
    let w = Fake::new();
    let b = new_book();
    let out = hand_over(&w, &b, "task", "claude2", Mode::Now).unwrap();
    assert_eq!((out.from.as_str(), out.to.as_str(), out.mode), ("claude1", "claude2", Mode::Now));
    assert!(out.told_new && out.told_old);
    assert_eq!(w.owner("task").as_deref(), Some("claude2"));
    // The new agent: name, what it was asked, its work so far, the handle.
    let new = w.told_to("claude2");
    assert_eq!(new.len(), 1);
    for part in ["Reviewer", "Claude 1 started it", "Review the diff and list risky changes", "I looked at 3 files so far", "task"] {
        assert!(new[0].contains(part), "{part} missing in {}", new[0]);
    }
    // The first agent: one plain note, so it does not wait for it.
    let old = w.told_to("claude1");
    assert_eq!(old.len(), 1);
    assert!(old[0].contains("handed the task \"Reviewer\" to Claude 2") && old[0].contains("do not wait"), "{}", old[0]);
    assert_eq!(b.lock().note_of("task").map(|n| (n.to.as_str(), n.state)), Some(("Claude 2", "now")));
}

#[test]
fn hand_over_now_ends_the_first_agents_wait() {
    let w = Fake::new();
    let b = new_book();
    let before = b.lock().generation_of("task");
    hand_over(&w, &b, "task", "claude2", Mode::Now).unwrap();
    assert!(b.lock().generation_of("task") > before);
}

#[test]
fn after_hand_over_now_the_result_goes_to_the_new_agent_only_and_once() {
    let w = Fake::new();
    let b = new_book();
    hand_over(&w, &b, "task", "claude2", Mode::Now).unwrap();
    assert!(turn_ended(&w, &b, "task").is_empty(), "still running: nothing to tell");
    w.finish("task", "Found two risky changes");
    let told = turn_ended(&w, &b, "task");
    assert_eq!(told, vec!["claude2".to_string()]);
    assert!(w.told_to("claude2").last().unwrap().contains("Found two risky changes"));
    // The first agent got only the hand-over note, never the result.
    assert_eq!(w.told_to("claude1").len(), 1);
    // A second ended turn does not tell again.
    assert!(turn_ended(&w, &b, "task").is_empty());
}

#[test]
fn when_it_finishes_nothing_moves_and_nobody_is_told_until_it_ends() {
    let w = Fake::new();
    let b = new_book();
    let out = hand_over(&w, &b, "task", "claude2", Mode::WhenFinished).unwrap();
    assert_eq!(out.mode, Mode::WhenFinished);
    assert_eq!(w.owner("task").as_deref(), Some("claude1"), "the first agent keeps it");
    assert!(w.told.borrow().is_empty());
    assert_eq!(b.lock().note_of("task").map(|n| n.state), Some("pending"));
    // A turn that ends while it still runs changes nothing.
    assert!(turn_ended(&w, &b, "task").is_empty());
    assert_eq!(w.owner("task").as_deref(), Some("claude1"));
}

#[test]
fn when_it_finishes_both_agents_get_the_result_and_the_first_is_told_who_owns_it() {
    let w = Fake::new();
    let b = new_book();
    hand_over(&w, &b, "task", "claude2", Mode::WhenFinished).unwrap();
    w.finish("task", "All good, 0 problems");
    let told = turn_ended(&w, &b, "task");
    assert_eq!(told.len(), 2);
    assert_eq!(w.owner("task").as_deref(), Some("claude2"));
    let new = w.told_to("claude2");
    let old = w.told_to("claude1");
    assert!(new[0].contains("All good, 0 problems") && new[0].contains("handed it to you"), "{}", new[0]);
    assert!(old[0].contains("All good, 0 problems"), "{}", old[0]);
    assert!(old[0].contains("finished and was handed to Claude 2") && old[0].contains("follow-up goes to Claude 2"), "{}", old[0]);
    assert_eq!(b.lock().note_of("task").map(|n| n.state), Some("finished"));
    // Done: nothing more is owed.
    assert!(!b.lock().is_handed("task"));
    assert!(turn_ended(&w, &b, "task").is_empty());
}

#[test]
fn a_task_that_already_ended_hands_over_at_once_and_both_get_the_result() {
    let w = Fake::new();
    let b = new_book();
    w.finish("task", "Done earlier");
    let out = hand_over(&w, &b, "task", "claude2", Mode::WhenFinished).unwrap();
    assert!(out.told_new && out.told_old);
    assert_eq!(w.owner("task").as_deref(), Some("claude2"));
    assert!(w.told_to("claude2")[0].contains("Done earlier"));
    assert!(w.told_to("claude1")[0].contains("Done earlier"));
    assert!(!b.lock().is_handed("task"));
}

#[test]
fn hand_over_now_of_an_ended_task_gives_the_new_agent_the_result_and_owes_nothing_more() {
    let w = Fake::new();
    let b = new_book();
    w.finish("task", "Done earlier");
    hand_over(&w, &b, "task", "claude2", Mode::Now).unwrap();
    assert!(w.told_to("claude2")[0].contains("Done earlier"));
    assert!(!b.lock().is_handed("task"));
}

#[test]
fn changing_your_mind_before_it_finishes_cancels_the_wait() {
    let w = Fake::new();
    let b = new_book();
    hand_over(&w, &b, "task", "claude2", Mode::WhenFinished).unwrap();
    assert!(b.lock().cancel("task"));
    w.finish("task", "x");
    assert!(turn_ended(&w, &b, "task").is_empty());
    assert_eq!(w.owner("task").as_deref(), Some("claude1"));
    assert!(w.told.borrow().is_empty());
    assert!(b.lock().note_of("task").is_none());
}

#[test]
fn it_can_be_handed_back_which_is_the_undo() {
    let w = Fake::new();
    let b = new_book();
    hand_over(&w, &b, "task", "claude2", Mode::Now).unwrap();
    hand_over(&w, &b, "task", "claude1", Mode::Now).unwrap();
    assert_eq!(w.owner("task").as_deref(), Some("claude1"));
    // Dropping it on the agent that has it now does nothing again.
    assert_eq!(hand_over(&w, &b, "task", "claude1", Mode::Now), Err(Refused(SAME)));
}

#[test]
fn it_says_so_when_an_agent_cannot_be_told() {
    let mut w = Fake::new();
    w.deaf = vec!["claude2"];
    let b = new_book();
    let out = hand_over(&w, &b, "task", "claude2", Mode::Now).unwrap();
    assert!(!out.told_new && out.told_old);
}

#[test]
fn it_refuses_what_cannot_be_handed_over() {
    let w = Fake::new();
    let b = new_book();
    assert_eq!(hand_over(&w, &b, "nope", "claude2", Mode::Now), Err(Refused(GONE)));
    assert_eq!(hand_over(&w, &b, "task", "nope", Mode::Now), Err(Refused(NO_AGENT)));
    // Not a minion: an agent the person talks to.
    assert_eq!(hand_over(&w, &b, "claude2", "claude1", Mode::Now), Err(Refused(NOT_A_MINION)));
    // A minion cannot take a task.
    w.owners.borrow_mut().insert("other".into(), Some("claude2".into()));
    let mut w2 = Fake::new();
    w2.minions = vec!["task", "other"];
    w2.owners.borrow_mut().insert("other".into(), Some("claude2".into()));
    assert_eq!(hand_over(&w2, &b, "task", "other", Mode::Now), Err(Refused(NOT_AN_AGENT)));
    assert_eq!(hand_over(&w, &b, "task", "task", Mode::Now), Err(Refused(LOOP)));
    assert!(w.told.borrow().is_empty() && w2.told.borrow().is_empty());
}

#[test]
fn a_closed_agent_drops_what_waited_on_it() {
    let w = Fake::new();
    let b = new_book();
    hand_over(&w, &b, "task", "claude2", Mode::WhenFinished).unwrap();
    forget(&b, "claude2");
    assert!(!b.lock().is_handed("task"));
    w.finish("task", "x");
    assert!(turn_ended(&w, &b, "task").is_empty());
    assert_eq!(w.owner("task").as_deref(), Some("claude1"));
}
