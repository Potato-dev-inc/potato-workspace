//! Standby helpers in the warm chat pool: who may claim one, what happens after the task, the cap and the idle timeout.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use super::warm::*;

#[derive(Default)]
struct Fake {
    next: AtomicU32,
    closed: Mutex<Vec<u32>>,
    /// Chats by id: `true` working, `false` waiting. A chat not listed is gone.
    chats: Mutex<BTreeMap<String, bool>>,
    dead: Mutex<BTreeSet<u32>>,
    cancelled: Mutex<Vec<String>>,
    /// Finished task chats the pool closed.
    retired: Mutex<Vec<String>>,
}

impl WarmHost for Fake {
    type Item = u32;
    fn start(&self, _key: &WarmKey, _folder: &Path) -> Result<u32, WarmFail> {
        Ok(self.next.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn alive(&self, item: &u32) -> bool {
        !self.dead.lock().contains(item)
    }
    fn close(&self, item: u32) {
        self.closed.lock().push(item);
    }
    fn pane_of(&self, item: &u32) -> Option<String> {
        Some(format!("chat-{item}"))
    }
    fn working(&self, pane_id: &str) -> Option<bool> {
        self.chats.lock().get(pane_id).copied()
    }
    fn cancel_turn(&self, pane_id: &str) {
        self.cancelled.lock().push(pane_id.to_string());
    }
    fn retire(&self, pane_id: &str) {
        self.retired.lock().push(pane_id.to_string());
        self.chats.lock().remove(pane_id);
    }
}

const FOLDER: &str = "C:/work/app";

fn meta(id: &str, model: Option<&str>, close: bool) -> HelperMeta {
    HelperMeta { id: id.into(), name: format!("Helper {id}"), model: model.map(str::to_string), close_after_use: close, home: None }
}

fn want(id: &str, agent: &str, model: Option<&str>, close: bool) -> HelperWant {
    HelperWant::new(meta(id, model, close), agent, &PathBuf::from(FOLDER), None)
}

fn pool(helpers: Vec<HelperWant>, cap: usize) -> (Arc<Pool<Fake>>, Arc<Fake>) {
    let host = Arc::new(Fake::default());
    let pool = Pool::new(host.clone());
    pool.set_policy(Policy { cap, idle_ms: 20 * 60_000, helper_idle_ms: 5 * 60_000, recent_ms: 3_600_000, helpers, ..Policy::default() });
    (pool, host)
}

fn pool_one() -> (Arc<Pool<Fake>>, Arc<Fake>) {
    pool(vec![want("a", "codex", Some("gpt-5"), false)], 4)
}

fn settle(pool: &Arc<Pool<Fake>>, host: &Fake, now: i64) -> usize {
    let (close, jobs) = pool.plan(now);
    for item in close {
        host.close(item);
    }
    for pane in pool.take_retiring() {
        host.retire(&pane);
    }
    let started = jobs.len();
    for job in jobs {
        pool.run(job, || now);
    }
    started
}

fn claim(pool: &Arc<Pool<Fake>>, agent: &str, model: Option<&str>, now: i64) -> Option<(u32, HelperMeta)> {
    pool.claim_helper(agent, Path::new(FOLDER), None, model, now)
}

fn state(pool: &Arc<Pool<Fake>>, id: &str) -> HelperState {
    pool.helper_statuses()[id].state
}

#[test]
fn a_helper_starts_in_its_own_slot_and_a_plain_claim_does_not_take_it() {
    let (pool, host) = pool_one();
    assert_eq!(settle(&pool, &host, 0), 1);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
    assert_eq!(pool.claim_without_refill(&WarmKey::new("codex", FOLDER, None), Path::new(FOLDER), 1), None, "the plain key is another slot");
    assert_eq!(state(&pool, "a"), HelperState::Ready, "still waiting");
}

#[test]
fn a_task_takes_the_helper_that_fits_agent_folder_and_model() {
    let (pool, host) = pool(vec![want("a", "codex", Some("gpt-5"), false), want("b", "claude", None, false)], 4);
    settle(&pool, &host, 0);
    assert!(claim(&pool, "codex", Some("gpt-4"), 1).is_none(), "another model");
    assert!(pool.claim_helper("codex", Path::new("C:/elsewhere"), None, None, 1).is_none(), "another folder");
    assert!(pool.claim_helper("codex", Path::new(FOLDER), Some("acc"), None, 1).is_none(), "another account");
    let (_, got) = claim(&pool, "codex", Some("GPT-5"), 2).expect("same model, any case");
    assert_eq!(got.id, "a");
    assert_eq!(state(&pool, "b"), HelperState::Ready, "the other helper is untouched");
    let (_, got) = claim(&pool, "claude", Some("opus"), 3).expect("a helper with no model takes any model");
    assert_eq!(got.id, "b");
    // A task that names no model takes a helper that has one.
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    assert!(claim(&pool, "codex", None, 1).is_some());
}

#[test]
fn a_helper_whose_chat_was_closed_goes_back_to_standby() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    claim(&pool, "codex", None, 1).unwrap();
    // The chat is not in the list at all: closed.
    assert_eq!(settle(&pool, &host, 2), 1);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn a_chat_that_never_ran_a_turn_frees_its_helper_after_ten_minutes() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    claim(&pool, "codex", None, 1).unwrap();
    host.chats.lock().insert("chat-1".into(), false);
    assert_eq!(settle(&pool, &host, 9 * 60_000), 1, "only the seat's next clean session is prepared meanwhile");
    assert_eq!(state(&pool, "a"), HelperState::Busy, "still held for the task");
    assert_eq!(settle(&pool, &host, 11 * 60_000), 0);
    assert_eq!(state(&pool, "a"), HelperState::Ready, "given back after ten minutes");
    assert_eq!(pool.seat_count(), 1);
}

#[test]
fn a_helper_set_to_close_stays_asleep_until_a_task_asks_for_it() {
    let (pool, host) = pool(vec![want("a", "codex", None, true)], 4);
    settle(&pool, &host, 0);
    claim(&pool, "codex", None, 1).unwrap();
    host.chats.lock().insert("chat-1".into(), true);
    settle(&pool, &host, 2);
    host.chats.lock().insert("chat-1".into(), false);
    assert_eq!(settle(&pool, &host, 3), 0, "not started again");
    assert_eq!(state(&pool, "a"), HelperState::Asleep);
    assert!(claim(&pool, "codex", None, 4).is_none(), "the task that asks finds it asleep");
    assert_eq!(settle(&pool, &host, 5), 1, "and wakes it for the next one");
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn start_wakes_a_sleeping_helper() {
    let (pool, host) = pool(vec![want("a", "codex", None, true)], 4);
    settle(&pool, &host, 0);
    claim(&pool, "codex", None, 1).unwrap();
    host.chats.lock().clear();
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "a"), HelperState::Asleep);
    pool.wake_helper("a");
    assert_eq!(settle(&pool, &host, 4), 1);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn the_cap_holds_helpers_back() {
    let (pool, host) = pool(vec![want("a", "codex", None, false), want("b", "claude", None, false), want("c", "opencode", None, false)], 2);
    assert_eq!(settle(&pool, &host, 0), 2);
    let ready = pool.helper_statuses().values().filter(|s| s.state == HelperState::Ready).count();
    assert_eq!(ready, 2, "only two fit under the cap");
}

#[test]
fn an_unused_helper_is_closed_after_the_idle_time_and_sleeps() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    settle(&pool, &host, 4 * 60_000);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
    settle(&pool, &host, 5 * 60_000 + 1);
    assert_eq!(host.closed.lock().as_slice(), &[1]);
    assert_eq!(state(&pool, "a"), HelperState::Asleep);
    assert_eq!(settle(&pool, &host, 6 * 60_000), 0, "it does not start on its own again");
    // A task that asks wakes it.
    assert!(claim(&pool, "codex", None, 6 * 60_000 + 1).is_none());
    assert_eq!(settle(&pool, &host, 6 * 60_000 + 2), 1);
}

#[test]
fn a_helper_taken_off_the_list_is_closed() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    pool.set_policy(Policy { cap: 4, idle_ms: 1_000_000, ..Policy::default() });
    settle(&pool, &host, 1);
    assert_eq!(host.closed.lock().as_slice(), &[1]);
    assert!(pool.helper_statuses().is_empty());
}

#[test]
fn a_dead_helper_session_is_not_handed_out() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    host.dead.lock().insert(1);
    assert!(claim(&pool, "codex", None, 1).is_none());
    assert_eq!(host.closed.lock().as_slice(), &[1]);
}

#[test]
fn a_removed_standby_is_closed_at_once_and_not_started_again() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
    pool.drop_helper("a", 1);
    assert_eq!(host.closed.lock().clone(), vec![1], "the waiting session was closed");
    assert!(pool.helper_statuses().is_empty(), "nothing is kept for it");
    assert_eq!(settle(&pool, &host, 2), 0, "and it is not refilled");
}

#[test]
fn a_task_from_its_home_agent_takes_its_own_helper_first() {
    let mut mine = meta("mine", None, false);
    mine.home = Some("pane-A".into());
    let (pool, host) = pool(vec![want("other", "codex", None, false), HelperWant::new(mine, "codex", &PathBuf::from(FOLDER), None)], 4);
    settle(&pool, &host, 0);
    let claimed = pool.claim_helper_for(&HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller: Some("pane-A"), name: None }, 1).unwrap();
    assert_eq!(claimed.meta.id, "mine");
    let again = pool.claim_helper_for(&HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller: Some("pane-A"), name: None }, 2).unwrap();
    assert_eq!(again.meta.id, "other", "then any free match");
    assert!(pool.claim_helper_for(&HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller: Some("pane-A"), name: None }, 3).is_none());
}

#[test]
fn a_helper_can_be_asked_for_by_name() {
    let (pool, host) = pool(vec![want("a", "codex", None, false), want("b", "codex", None, false)], 4);
    settle(&pool, &host, 0);
    let by_name = |name| pool.claim_helper_for(&HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller: None, name: Some(name) }, 1);
    assert_eq!(by_name("helper B").unwrap().meta.id, "b");
    assert!(by_name("helper B").is_none(), "the named one is busy");
    assert!(by_name("nobody").is_none());
}

#[test]
fn the_person_using_a_helper_ends_when_their_turn_is_over() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    host.chats.lock().insert("chat-1".into(), true);
    assert!(pool.begin_person_use("a", 1));
    settle(&pool, &host, 2);
    assert_eq!(state(&pool, "a"), HelperState::Busy, "their turn is running");
    host.chats.lock().insert("chat-1".into(), false);
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "a"), HelperState::Ready, "back on standby");
}

// ---- opening a standby as a chat, using it, taking it over, taking it back ---------------------------------------------------

fn any_claim<'a>(caller: Option<&'a str>) -> HelperClaim<'a> {
    HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller, name: None }
}

/// Opens helper `id` the way the app does: a chat around its waiting session (here: a pane named after the session).
fn open(pool: &Arc<Pool<Fake>>, host: &Fake, id: &str) -> Result<String, String> {
    let pane = pool.open_helper(id, |item, _, _| Ok(format!("chat-{item}")))?;
    host.chats.lock().entry(pane.clone()).or_insert(false);
    Ok(pane)
}

#[test]
fn a_ready_helper_opens_as_a_chat_and_stays_in_the_pool() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    let first = open(&pool, &host, "a").unwrap();
    assert_eq!(first, "chat-1");
    // The second call gives the same chat and builds nothing.
    assert_eq!(pool.open_helper("a", |_, _, _| panic!("built twice")).unwrap(), first);
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.state, status.open_pane.as_deref(), status.used_by), (HelperState::Ready, Some("chat-1"), None));
    // An idle pass does not close the session the person has open, and nothing is started in its place.
    assert_eq!(settle(&pool, &host, 30 * 60_000), 0);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
    assert!(host.closed.lock().is_empty());
    assert!(open(&pool, &host, "nobody").is_err());
}

#[test]
fn a_helper_that_is_not_ready_says_so_in_a_sentence() {
    let (pool, host) = pool(vec![want("a", "codex", None, true)], 4);
    settle(&pool, &host, 0);
    claim(&pool, "codex", None, 1).unwrap();
    host.chats.lock().insert("chat-1".into(), true);
    settle(&pool, &host, 2);
    host.chats.lock().insert("chat-1".into(), false);
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "a"), HelperState::Asleep);
    let err = open(&pool, &host, "a").unwrap_err();
    assert!(err.contains("asleep"), "{err}");
    assert_eq!(settle(&pool, &host, 4), 1, "and it was woken");
}

#[test]
fn a_helper_an_agent_has_opens_the_task_chat() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    claim(&pool, "codex", None, 1).unwrap();
    assert_eq!(open(&pool, &host, "a").unwrap(), "chat-1");
}

#[test]
fn the_person_turn_ending_gives_the_opened_helper_back_to_ready() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    let chat = open(&pool, &host, "a").unwrap();
    assert!(pool.person_sent(&chat, 1));
    host.chats.lock().insert(chat.clone(), true);
    settle(&pool, &host, 2);
    assert_eq!(state(&pool, "a"), HelperState::Busy);
    host.chats.lock().insert(chat.clone(), false);
    settle(&pool, &host, 3);
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.state, status.open_pane.as_deref()), (HelperState::Ready, Some("chat-1")), "ready, and the chat is still open");
}

#[test]
fn a_task_that_names_no_model_takes_a_standby_of_its_agent_whatever_its_model_and_its_own_come_first() {
    let mut mine = meta("mine", Some("gpt-5"), false);
    mine.home = Some("pane-A".into());
    let (pool, host) = pool(vec![want("other", "codex", Some("o3"), false), HelperWant::new(mine, "codex", &PathBuf::from(FOLDER), None), want("claude-one", "claude", Some("opus"), false)], 6);
    settle(&pool, &host, 0);
    let ask = |caller, model, now| pool.claim_helper_for(&HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model, caller, name: None }, now);
    assert_eq!(ask(Some("pane-A"), None, 1).unwrap().meta.id, "mine", "the caller's own standby first, on its own model");
    assert_eq!(ask(Some("pane-A"), None, 2).unwrap().meta.id, "other", "then the other standby, whatever its model");
    assert!(ask(Some("pane-A"), None, 3).is_none(), "another agent type is never taken");
    assert_eq!(state(&pool, "claude-one"), HelperState::Ready);
}

#[test]
fn a_task_that_names_a_model_takes_only_a_standby_with_that_model_or_none() {
    let (pool, host) = pool(vec![want("a", "codex", Some("gpt-5"), false), want("b", "codex", None, false)], 4);
    settle(&pool, &host, 0);
    let ask = |model, now| pool.claim_helper_for(&HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model, caller: None, name: None }, now).map(|c| c.meta.id);
    assert_eq!(ask(Some("o3"), 1).as_deref(), Some("b"), "a standby with no model takes any model");
    assert_eq!(ask(Some("o3"), 2), None, "the one with gpt-5 does not take o3");
    assert_eq!(ask(Some("gpt-5"), 3).as_deref(), Some("a"));
}

// ---- the seat: a standby takes the task in its own place, and nothing else is made ------------------------------------

fn seat(id: &str, agent: &str, model: Option<&str>, home: &str) -> HelperWant {
    let mut meta = meta(id, model, false);
    meta.home = Some(home.into());
    HelperWant::new(meta, agent, &PathBuf::from(FOLDER), None)
}

fn ask<'a>(agent: &'a str, caller: Option<&'a str>, model: Option<&'a str>) -> HelperClaim<'a> {
    HelperClaim { agent, folder: Path::new(FOLDER), account: None, model, caller, name: None }
}

/// What the person counts: the seats, and how many sessions the pool holds.
fn counts(pool: &Arc<Pool<Fake>>) -> (usize, usize) {
    (pool.seat_count(), pool.len())
}

#[test]
fn every_spelling_and_lane_wording_of_an_agent_is_one_type() {
    for (spelled, family) in [
        ("opencode", "opencode"),
        ("OpenCode", "opencode"),
        ("opencode_native", "opencode"),
        ("opencode-native", "opencode"),
        ("OpenCode non native", "opencode"),
        ("opencode non-native", "opencode"),
        ("opencode_acp", "opencode"),
        ("OpenCode (terminal)", "opencode"),
        ("opencode chat", "opencode"),
        ("claude", "claude"),
        ("Claude", "claude"),
        ("codex-cli", "codex"),
        (" Codex ", "codex"),
        ("cursor", "cursor"),
    ] {
        assert_eq!(agent_family(spelled), family, "{spelled}");
    }
    assert_ne!(agent_family("opencode"), agent_family("codex"));
    // A word that is all there is, is the name: nothing is cut down to nothing.
    assert_eq!(agent_family("cli"), "cli");
    assert_eq!(agent_family("native"), "native");
}

#[test]
fn a_task_takes_the_seat_and_the_seat_goes_back_to_ready_with_nothing_else_made() {
    let (pool, host) = pool(vec![seat("s1", "opencode", Some("deepseek"), "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    assert_eq!(settle(&pool, &host, 0), 1, "the seat starts once");
    let before = counts(&pool);
    assert_eq!(before, (1, 1));
    assert_eq!(state(&pool, "s1"), HelperState::Ready);

    // The orchestrator asks for a helper of the seat's type, naming no model.
    let claimed = pool.claim_helper_for(&ask("opencode", Some("orch"), None), 1).expect("the seat takes it");
    assert_eq!(claimed.meta.id, "s1");
    assert_eq!(claimed.meta.home.as_deref(), Some("orch"), "the owner is the same");
    assert!(claimed.pane.is_none() && claimed.item.is_some(), "the task gets the seat's own waiting session");
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.used_by, status.pane_id.as_deref()), (HelperState::Busy, Some(HelperUser::Agent), Some("chat-1")));
    assert_eq!(pool.seat_count(), 1, "still one seat");

    // While the task runs: the seat is busy, it is not claimed twice, and only its own next clean session is prepared.
    host.chats.lock().insert("chat-1".into(), true);
    assert_eq!(settle(&pool, &host, 2), 1, "the seat's next clean session, for the same seat");
    assert_eq!(settle(&pool, &host, 3), 0, "and never a second one");
    assert_eq!(counts(&pool), (1, 1), "one seat, one waiting session: nothing extra");
    assert_eq!(state(&pool, "s1"), HelperState::Busy, "busy until the task is over, whatever waits behind it");
    assert!(pool.claim_helper_for(&ask("opencode", Some("orch"), None), 4).is_none(), "a busy seat is not taken twice");

    // The task ends: the same seat is ready again at once, under the same owner.
    host.chats.lock().insert("chat-1".into(), false);
    assert_eq!(settle(&pool, &host, 5), 0, "nothing is started when the task ends");
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.used_by, status.pane_id), (HelperState::Ready, None, None));
    assert_eq!(status.past_panes, vec!["chat-1".to_string()], "the finished chat is still the seat's own for a moment");
    assert_eq!(counts(&pool), before, "the counts are what they were before the task");
    assert!(host.closed.lock().is_empty() && host.cancelled.lock().is_empty());

    // The finished chat is closed after its grace, not before, and the seat stays ready.
    assert_eq!(settle(&pool, &host, 5 + RETIRE_GRACE_MS - 1), 0);
    assert!(host.retired.lock().is_empty(), "not yet");
    assert_eq!(settle(&pool, &host, 5 + RETIRE_GRACE_MS), 0);
    assert_eq!(host.retired.lock().clone(), vec!["chat-1".to_string()]);
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.past_panes.len()), (HelperState::Ready, 0));
    assert_eq!(counts(&pool), before);
}

#[test]
fn the_same_seat_takes_task_after_task_and_the_counts_never_change() {
    let (pool, host) = pool(vec![seat("s1", "claude", Some("haiku"), "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    settle(&pool, &host, 0);
    let before = counts(&pool);
    let mut now = 1;
    for round in 1..=3u32 {
        let claimed = pool.claim_helper_for(&ask("claude", Some("orch"), None), now).unwrap_or_else(|| panic!("round {round}: the seat takes it"));
        assert_eq!((claimed.meta.id.as_str(), claimed.meta.model.as_deref(), claimed.meta.home.as_deref()), ("s1", Some("haiku"), Some("orch")));
        let chat = format!("chat-{}", claimed.item.unwrap());
        host.chats.lock().insert(chat.clone(), true);
        settle(&pool, &host, now + 1);
        assert_eq!(pool.seat_count(), 1, "round {round}: one seat while it works");
        host.chats.lock().insert(chat.clone(), false);
        settle(&pool, &host, now + 2);
        assert_eq!(state(&pool, "s1"), HelperState::Ready, "round {round}: ready again");
        assert_eq!(counts(&pool), before, "round {round}: the counts are unchanged");
        now += 10;
    }
    // Each new task closed the chat of the one before: the seat has one chat at a time.
    assert_eq!(host.retired.lock().clone(), vec!["chat-1".to_string(), "chat-2".to_string()]);
    assert_eq!(host.next.load(Ordering::SeqCst), 4, "one session per task plus the one waiting now, all for the same seat");
}

#[test]
fn the_callers_own_seat_is_found_whatever_lane_wording_the_caller_used() {
    let (pool, host) = pool(vec![seat("s1", "opencode", Some("deepseek"), "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    settle(&pool, &host, 0);
    for spelled in ["opencode", "OpenCode", "opencode_native", "opencode non native", "opencode-acp"] {
        let found = pool.seat_for(&ask(spelled, Some("orch"), None)).unwrap_or_else(|| panic!("{spelled} finds the seat"));
        assert_eq!((found.id.as_str(), found.agent.as_str()), ("s1", "opencode"), "{spelled}");
    }
    assert!(pool.seat_for(&ask("codex", Some("orch"), None)).is_none(), "another agent type");
    assert!(pool.seat_for(&ask("opencode", Some("someone-else"), None)).is_none(), "only the caller's own seat");
    assert!(pool.seat_for(&ask("opencode", None, None)).is_none(), "an unknown caller has no seat of its own");
    assert!(pool.seat_for(&ask("opencode", Some("orch"), Some("deepseek"))).is_some(), "the seat's own model named");
    assert!(pool.seat_for(&ask("opencode", Some("orch"), Some("gpt-5"))).is_none(), "a model the seat does not have");
    // The claim itself takes the family too.
    assert_eq!(pool.claim_helper_for(&ask("opencode_native", Some("orch"), None), 1).unwrap().meta.id, "s1");
    assert!(pool.seat_for(&ask("opencode", Some("orch"), None)).is_none(), "a busy seat is not offered");
}

#[test]
fn a_seat_under_another_agent_is_not_taken_while_that_agent_is_there() {
    let (pool, host) = pool(vec![seat("theirs", "codex", None, "other-orch")], 4);
    host.chats.lock().insert("other-orch".into(), false);
    settle(&pool, &host, 0);
    assert!(pool.claim_helper_for(&ask("codex", Some("me"), None), 1).is_none(), "it sits under another agent");
    assert_eq!(state(&pool, "theirs"), HelperState::Ready, "and it is untouched");
    assert_eq!(pool.claim_helper_for(&ask("codex", Some("other-orch"), None), 2).unwrap().meta.id, "theirs", "its owner takes it");
    // An owner that is gone holds nothing back: the seat serves whoever asks.
    let (pool, host) = pool_with_home_gone();
    assert_eq!(pool.claim_helper_for(&ask("codex", Some("me"), None), 1).unwrap().meta.id, "orphan");
    drop(host);
}

fn pool_with_home_gone() -> (Arc<Pool<Fake>>, Arc<Fake>) {
    let (pool, host) = pool(vec![seat("orphan", "codex", None, "closed-orch")], 4);
    settle(&pool, &host, 0);
    (pool, host)
}

#[test]
fn a_task_runs_in_the_chat_the_person_has_open_on_the_seat() {
    let (pool, host) = pool(vec![seat("s1", "codex", None, "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    settle(&pool, &host, 0);
    // The person clicked the seat's row: its chat is open, the seat is still ready.
    let open_chat = open(&pool, &host, "s1").unwrap();
    assert_eq!(state(&pool, "s1"), HelperState::Ready);
    let claimed = pool.claim_helper_for(&ask("codex", Some("orch"), None), 1).expect("an open seat is still the seat");
    assert_eq!(claimed.pane.as_deref(), Some(open_chat.as_str()), "the task runs in that same chat");
    assert!(claimed.item.is_some(), "with the seat's own session: nothing fresh is started");
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.used_by, status.pane_id.as_deref(), status.open_pane), (HelperState::Busy, Some(HelperUser::Agent), Some("chat-1"), None));
    assert!(host.cancelled.lock().is_empty() && host.closed.lock().is_empty(), "nothing was stopped or closed");
    assert_eq!(pool.seat_count(), 1);
    // After the task the seat is ready again.
    host.chats.lock().insert("chat-1".into(), true);
    settle(&pool, &host, 2);
    host.chats.lock().insert("chat-1".into(), false);
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "s1"), HelperState::Ready);
    assert_eq!(pool.seat_count(), 1);
}

#[test]
fn a_seat_with_the_persons_turn_running_is_never_taken_and_their_turn_is_never_stopped() {
    let (pool, host) = pool(vec![seat("s1", "codex", None, "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    settle(&pool, &host, 0);
    let chat = open(&pool, &host, "s1").unwrap();
    assert!(!pool.person_sent("elsewhere", 1), "another chat is not the seat's");
    assert!(pool.person_sent(&chat, 1));
    host.chats.lock().insert(chat.clone(), true);
    settle(&pool, &host, 2);
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.used_by, status.open_pane.as_deref()), (HelperState::Busy, Some(HelperUser::Person), Some("chat-1")));
    assert!(!pool.person_sent(&chat, 2), "a later send while it is theirs changes nothing");
    assert!(pool.claim_helper_for(&ask("codex", Some("orch"), None), 3).is_none(), "the person is using it");
    assert!(pool.seat_for(&ask("codex", Some("orch"), None)).is_none());
    assert!(host.cancelled.lock().is_empty(), "the person's turn is never stopped");
    assert_eq!(pool.helper_statuses()["s1"].used_by, Some(HelperUser::Person));
    // Their turn ends: the seat is ready again and takes the next task, in its own chat.
    host.chats.lock().insert(chat.clone(), false);
    settle(&pool, &host, 4);
    assert_eq!(state(&pool, "s1"), HelperState::Ready);
    assert_eq!(pool.claim_helper_for(&ask("codex", Some("orch"), None), 5).unwrap().pane.as_deref(), Some("chat-1"));
}

#[test]
fn a_seat_nobody_has_open_goes_before_one_the_person_has_open() {
    let (pool, host) = pool(vec![seat("a", "codex", None, "orch"), seat("b", "codex", None, "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    settle(&pool, &host, 0);
    open(&pool, &host, "a").unwrap();
    let first = pool.claim_helper_for(&ask("codex", Some("orch"), None), 1).unwrap();
    assert_eq!((first.meta.id.as_str(), first.pane.is_none()), ("b", true), "the one nobody is looking at first");
    let second = pool.claim_helper_for(&ask("codex", Some("orch"), None), 2).unwrap();
    assert_eq!((second.meta.id.as_str(), second.pane.is_some()), ("a", true), "then the open one, in its own chat");
    assert!(pool.claim_helper_for(&ask("codex", Some("orch"), None), 3).is_none(), "both are taken: only now would a plain helper be started");
    assert_eq!(pool.seat_count(), 2);
}

#[test]
fn a_task_that_did_not_start_gives_the_seat_back() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    pool.set_helper_task_pane("a", "");
    settle(&pool, &host, 2);
    assert_eq!(state(&pool, "a"), HelperState::Ready, "no chat, so the seat is ready again");
    assert_eq!(pool.seat_count(), 1);
    assert!(host.retired.lock().is_empty(), "there was no chat to close");
}

#[test]
fn the_seat_follows_the_chat_its_task_runs_in() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    pool.set_helper_task_pane("a", "task-1");
    host.chats.lock().insert("task-1".into(), true);
    settle(&pool, &host, 2);
    assert_eq!(state(&pool, "a"), HelperState::Busy, "its chat is working");
    assert_eq!(pool.helper_statuses()["a"].pane_id.as_deref(), Some("task-1"));
    host.chats.lock().insert("task-1".into(), false);
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn taking_a_seat_back_stops_the_task_turn() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    assert_eq!(pool.take_back_helper("a"), None, "nothing to take back from a free seat");
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    pool.set_helper_task_pane("a", "task-1");
    host.chats.lock().insert("task-1".into(), true);
    settle(&pool, &host, 2);
    let pane = pool.take_back_helper("a").expect("an agent has it");
    assert_eq!(pane, "task-1");
    pool.cancel_helper_turn(&pane);
    assert_eq!(host.cancelled.lock().clone(), vec!["task-1".to_string()]);
    // The cancelled turn ends: the seat goes back to ready as after any task.
    host.chats.lock().insert("task-1".into(), false);
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn a_finished_chat_with_a_follow_up_running_is_not_closed_under_it() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    host.chats.lock().insert("chat-1".into(), true);
    settle(&pool, &host, 2);
    host.chats.lock().insert("chat-1".into(), false);
    settle(&pool, &host, 3);
    // The orchestrator sends a follow-up into the finished chat: it stays until that is over.
    host.chats.lock().insert("chat-1".into(), true);
    settle(&pool, &host, 3 + RETIRE_GRACE_MS + 5);
    assert!(host.retired.lock().is_empty(), "a running turn is never closed");
    host.chats.lock().insert("chat-1".into(), false);
    settle(&pool, &host, 3 + RETIRE_GRACE_MS + 6);
    assert_eq!(host.retired.lock().clone(), vec!["chat-1".to_string()]);
}

#[test]
fn every_claim_writes_one_line_that_says_matched_or_skipped_and_why() {
    let (pool, host) = pool(vec![seat("s1", "opencode", Some("deepseek"), "orch"), seat("s2", "claude", None, "elsewhere")], 4);
    host.chats.lock().insert("orch".into(), false);
    host.chats.lock().insert("elsewhere".into(), false);
    settle(&pool, &host, 0);
    let lines = |needle: &str| crate::standby::seat_log::recent(400).into_iter().filter(|l| l.contains(needle)).collect::<Vec<_>>();
    assert!(pool.claim_helper_for(&ask("opencode", Some("orch-log-1"), Some("gpt-5")), 1).is_none());
    let skipped = lines("caller orch-log-1");
    let line = skipped.last().expect("a line for the miss");
    assert!(line.contains("claim SKIPPED") && line.contains("the task asked for model gpt-5 and the seat is on deepseek") && line.contains("it is a claude seat"), "{line}");
    assert!(pool.claim_helper_for(&ask("claude", Some("orch-log-2"), None), 2).is_none());
    let line = lines("caller orch-log-2").last().cloned().expect("a line");
    assert!(line.contains("it sits under another agent"), "{line}");
    assert!(pool.claim_helper_for(&ask("opencode", Some("orch"), None), 3).is_some());
    let line = lines("claim MATCHED").into_iter().filter(|l| l.contains("(s1)")).last().expect("a line for the match");
    assert!(line.contains("nothing new is started") && line.contains("the task runs in the seat's own chat"), "{line}");
}

#[test]
fn a_task_shorter_than_the_seats_restart_never_shows_starting_in_between() {
    let (pool, host) = pool(vec![seat("s1", "opencode", None, "orch")], 4);
    host.chats.lock().insert("orch".into(), false);
    settle(&pool, &host, 0);
    pool.claim_helper_for(&ask("opencode", Some("orch"), None), 1).unwrap();
    host.chats.lock().insert("chat-1".into(), true);
    // The seat's next clean session is started, and is slow: it has not come up when the task ends.
    let (_, jobs) = pool.plan(2);
    assert_eq!(jobs.len(), 1);
    host.chats.lock().insert("chat-1".into(), false);
    assert_eq!(settle(&pool, &host, 3), 0);
    assert_eq!(state(&pool, "s1"), HelperState::Busy, "still Working while its clean session finishes starting, never Starting");
    assert_eq!(settle(&pool, &host, 20_000), 0);
    assert_eq!(state(&pool, "s1"), HelperState::Busy);
    // The session is up: Ready at the next look.
    for job in jobs {
        pool.run(job, || 21_000);
    }
    settle(&pool, &host, 21_001);
    assert_eq!(state(&pool, "s1"), HelperState::Ready);
    assert_eq!(counts(&pool), (1, 1));
    // A session that never comes up does not hold the seat for ever: after a minute the row says what is true.
    pool.claim_helper_for(&ask("opencode", Some("orch"), None), 30_000).unwrap();
    host.chats.lock().insert("chat-2".into(), true);
    let (_, stuck) = pool.plan(30_001);
    assert_eq!(stuck.len(), 1);
    host.chats.lock().insert("chat-2".into(), false);
    settle(&pool, &host, 30_002);
    assert_eq!(state(&pool, "s1"), HelperState::Busy);
    settle(&pool, &host, 30_002 + CLEAN_HOLD_MS);
    assert_eq!(state(&pool, "s1"), HelperState::Starting);
    assert_eq!(pool.seat_count(), 1);
}

/// A host whose next start fails once (a real OpenCode did: "Internal error: Internal service failure").
#[derive(Default)]
struct Flaky {
    inner: Fake,
    fail_next: std::sync::atomic::AtomicBool,
}

impl WarmHost for Flaky {
    type Item = u32;
    fn start(&self, key: &WarmKey, folder: &Path) -> Result<u32, WarmFail> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(WarmFail { message: "Internal error: Internal service failure".into(), auth: false });
        }
        self.inner.start(key, folder)
    }
    fn alive(&self, item: &u32) -> bool {
        self.inner.alive(item)
    }
    fn close(&self, item: u32) {
        self.inner.close(item)
    }
    fn pane_of(&self, item: &u32) -> Option<String> {
        self.inner.pane_of(item)
    }
    fn working(&self, pane_id: &str) -> Option<bool> {
        self.inner.working(pane_id)
    }
}

#[test]
fn a_seat_whose_restart_failed_once_stays_working_until_the_retry_is_up_and_never_says_cannot_start() {
    let host = Arc::new(Flaky::default());
    let pool = Pool::new(host.clone());
    pool.set_policy(Policy { cap: 4, idle_ms: 20 * 60_000, helper_idle_ms: 5 * 60_000, recent_ms: 3_600_000, helpers: vec![seat("s1", "opencode", None, "orch")], ..Policy::default() });
    let pass = |now: i64| {
        let (_, jobs) = pool.plan(now);
        for job in jobs {
            pool.run(job, || now);
        }
        pool.take_retiring();
        pool.helper_statuses()["s1"].state
    };
    host.inner.chats.lock().insert("orch".into(), false);
    assert_eq!(pass(0), HelperState::Ready);
    pool.claim_helper_for(&ask("opencode", Some("orch"), None), 1_000).unwrap();
    host.inner.chats.lock().insert("chat-1".into(), true);
    // The seat's next clean session fails to start while the task runs.
    host.fail_next.store(true, Ordering::SeqCst);
    assert_eq!(pass(2_000), HelperState::Busy);
    // The task ends: the row keeps saying Working, never "Can't start" or "Starting".
    host.inner.chats.lock().insert("chat-1".into(), false);
    for now in [20_000, 25_000, 31_000] {
        assert_eq!(pass(now), HelperState::Busy, "at {now}");
    }
    // The retry (30 s after the failure) comes up, and the seat is Ready at the next look.
    pass(32_500);
    assert_eq!(pass(33_000), HelperState::Ready);
    assert_eq!(host.inner.next.load(Ordering::SeqCst), 2, "one session for the task, one clean one waiting: nothing extra");
    assert_eq!(pool.seat_count(), 1);
}
