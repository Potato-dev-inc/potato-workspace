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
fn a_claimed_helper_is_busy_then_goes_back_to_standby_after_its_task() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    let (item, _) = claim(&pool, "codex", None, 1).unwrap();
    assert_eq!(state(&pool, "a"), HelperState::Busy);
    assert_eq!(pool.helper_statuses()["a"].pane_id.as_deref(), Some(format!("chat-{item}").as_str()));
    assert!(claim(&pool, "codex", None, 2).is_none(), "a busy helper is not taken twice");
    // The chat has not run a turn yet: still busy, nothing refilled.
    host.chats.lock().insert("chat-1".into(), false);
    assert_eq!(settle(&pool, &host, 3), 0);
    assert_eq!(state(&pool, "a"), HelperState::Busy);
    // A turn runs.
    host.chats.lock().insert("chat-1".into(), true);
    assert_eq!(settle(&pool, &host, 4), 0);
    assert_eq!(state(&pool, "a"), HelperState::Busy);
    // The turn ends: the helper is refilled and ready again.
    host.chats.lock().insert("chat-1".into(), false);
    assert_eq!(settle(&pool, &host, 5), 1);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
    assert!(host.closed.lock().is_empty(), "the claimed chat belongs to the task, the pool never closes it");
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
    assert_eq!(settle(&pool, &host, 9 * 60_000), 0);
    assert_eq!(settle(&pool, &host, 11 * 60_000), 1);
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
fn a_free_helper_goes_before_one_the_person_is_using() {
    let (pool, host) = pool(vec![want("a", "codex", None, false), want("b", "codex", None, false)], 4);
    settle(&pool, &host, 0);
    host.chats.lock().insert("chat-1".into(), true);
    assert!(pool.begin_person_use("a", 1), "the person opens helper a and sends a message");
    assert_eq!(pool.helper_statuses()["a"].used_by, Some(HelperUser::Person));
    let claim = HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller: None, name: None };
    let first = pool.claim_helper_for(&claim, 2).unwrap();
    assert_eq!(first.meta.id, "b", "the free one first");
    assert!(first.taken_from.is_none());
    assert!(host.cancelled.lock().is_empty(), "the person's turn is untouched");
}

#[test]
fn run_agent_takes_over_a_helper_the_person_is_using_and_stops_their_turn() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    host.chats.lock().insert("chat-1".into(), true);
    assert!(pool.begin_person_use("a", 1));
    let claim = HelperClaim { agent: "codex", folder: Path::new(FOLDER), account: None, model: None, caller: Some("pane-A"), name: None };
    let taken = pool.claim_helper_for(&claim, 2).expect("the only match is taken over");
    assert_eq!(taken.taken_from.as_deref(), Some("chat-1"), "it says whose chat it was");
    assert!(taken.fresh && taken.item.is_none(), "the person's session is never handed to the task");
    assert_eq!(host.cancelled.lock().clone(), vec!["chat-1".to_string()], "the person's turn was stopped");
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.state, status.used_by, status.taken_over), (HelperState::Busy, Some(HelperUser::Agent), true));
    assert!(pool.claim_helper_for(&claim, 3).is_none(), "never claimed twice");
    // The task's chat is started: the helper is busy until that chat has had a turn.
    pool.set_helper_task_pane("a", "chat-9");
    host.chats.lock().insert("chat-9".into(), true);
    settle(&pool, &host, 4);
    host.chats.lock().insert("chat-9".into(), false);
    settle(&pool, &host, 5);
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.state, status.taken_over), (HelperState::Ready, false));
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
fn a_task_takes_an_opened_helper_with_a_fresh_session_and_never_the_persons() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    let person_chat = open(&pool, &host, "a").unwrap();
    let taken = pool.claim_helper_for(&any_claim(Some("pane-A")), 1).expect("the only match is taken over, even before the person typed");
    assert!(taken.fresh && taken.item.is_none());
    assert_eq!(taken.person_pane.as_deref(), Some(person_chat.as_str()));
    assert!(taken.taken_from.is_none(), "no turn was running, so none was stopped");
    assert!(host.cancelled.lock().is_empty());
    assert!(host.closed.lock().is_empty(), "the person's chat keeps its session: nothing was closed");
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.state, status.used_by, status.taken_over), (HelperState::Busy, Some(HelperUser::Agent), true));
    assert_eq!((status.person_pane.as_deref(), status.open_pane.as_deref()), (Some("chat-1"), None));
    assert!(pool.claim_helper_for(&any_claim(None), 2).is_none(), "the same helper is never claimed twice");
    // Nothing else happens until the task chat exists; then the helper is refilled with a new session after the task.
    assert_eq!(settle(&pool, &host, 3), 0);
    pool.set_helper_task_pane("a", "task-1");
    host.chats.lock().insert("task-1".into(), true);
    assert_eq!(settle(&pool, &host, 4), 0);
    host.chats.lock().insert("task-1".into(), false);
    assert_eq!(settle(&pool, &host, 5), 1, "a new session");
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.state, status.taken_over, status.person_pane.clone(), status.open_pane.clone()), (HelperState::Ready, false, None, None));
    assert!(host.closed.lock().is_empty());
}

#[test]
fn sending_in_the_opened_chat_makes_the_helper_with_you_and_a_takeover_stops_that_turn() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    let chat = open(&pool, &host, "a").unwrap();
    assert!(!pool.person_sent("elsewhere", 1), "another chat is not the helper's");
    assert!(pool.person_sent(&chat, 1));
    host.chats.lock().insert(chat.clone(), true);
    let status = pool.helper_statuses()["a"].clone();
    assert_eq!((status.state, status.used_by, status.open_pane.as_deref()), (HelperState::Busy, Some(HelperUser::Person), Some("chat-1")));
    assert!(!pool.person_sent(&chat, 2), "a later send while it is theirs changes nothing");
    let taken = pool.claim_helper_for(&any_claim(None), 3).unwrap();
    assert!(taken.fresh);
    assert_eq!((taken.taken_from.as_deref(), taken.person_pane.as_deref()), (Some("chat-1"), Some("chat-1")));
    assert_eq!(host.cancelled.lock().clone(), vec!["chat-1".to_string()], "their running turn was stopped");
    assert!(host.closed.lock().is_empty());
    // The person chat is no longer the helper's: a send there changes nothing.
    assert!(!pool.person_sent(&chat, 4));
    assert_eq!(pool.helper_statuses()["a"].used_by, Some(HelperUser::Agent));
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
fn the_busy_check_follows_the_new_chat_not_the_persons_old_one() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    let old = open(&pool, &host, "a").unwrap();
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    // The old chat gone does not free the helper while the task chat is not known yet.
    host.chats.lock().remove(&old);
    assert_eq!(settle(&pool, &host, 2), 0);
    assert_eq!(state(&pool, "a"), HelperState::Busy);
    pool.set_helper_task_pane("a", "task-1");
    host.chats.lock().insert("task-1".into(), true);
    host.chats.lock().insert(old.clone(), false);
    assert_eq!(settle(&pool, &host, 3), 0);
    assert_eq!(state(&pool, "a"), HelperState::Busy, "the new chat is working");
    assert_eq!(pool.helper_statuses()["a"].pane_id.as_deref(), Some("task-1"));
    host.chats.lock().insert("task-1".into(), false);
    assert_eq!(settle(&pool, &host, 4), 1);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn a_start_that_failed_gives_the_helper_back() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    open(&pool, &host, "a").unwrap();
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    pool.set_helper_task_pane("a", "");
    assert_eq!(settle(&pool, &host, 2), 1, "no chat, so the helper is ready again");
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn taking_a_helper_back_stops_the_task_turn_and_clears_the_takeover() {
    let (pool, host) = pool_one();
    settle(&pool, &host, 0);
    open(&pool, &host, "a").unwrap();
    assert_eq!(pool.take_back_helper("a"), None, "nothing to take back from a free helper");
    pool.claim_helper_for(&any_claim(None), 1).unwrap();
    pool.set_helper_task_pane("a", "task-1");
    host.chats.lock().insert("task-1".into(), true);
    settle(&pool, &host, 2);
    let pane = pool.take_back_helper("a").expect("an agent has it");
    assert_eq!(pane, "task-1");
    pool.cancel_helper_turn(&pane);
    assert_eq!(host.cancelled.lock().clone(), vec!["task-1".to_string()]);
    let status = &pool.helper_statuses()["a"];
    assert_eq!((status.taken_over, status.person_pane.clone()), (false, None));
    // The cancelled turn ends: the helper goes back to standby as after any task.
    host.chats.lock().insert("task-1".into(), false);
    settle(&pool, &host, 3);
    assert_eq!(state(&pool, "a"), HelperState::Ready);
}

#[test]
fn a_free_helper_still_goes_first_and_no_helper_is_claimed_twice() {
    let (pool, host) = pool(vec![want("a", "codex", None, false), want("b", "codex", None, false)], 4);
    settle(&pool, &host, 0);
    open(&pool, &host, "a").unwrap();
    let first = pool.claim_helper_for(&any_claim(None), 1).unwrap();
    assert_eq!((first.meta.id.as_str(), first.fresh), ("b", false), "the free one first, with its own session");
    let second = pool.claim_helper_for(&any_claim(None), 2).unwrap();
    assert_eq!((second.meta.id.as_str(), second.fresh), ("a", true), "then the opened one, fresh");
    assert!(pool.claim_helper_for(&any_claim(None), 3).is_none(), "both are taken");
}
