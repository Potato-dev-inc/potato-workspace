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
}

const FOLDER: &str = "C:/work/app";

fn meta(id: &str, model: Option<&str>, close: bool) -> HelperMeta {
    HelperMeta { id: id.into(), name: format!("Helper {id}"), model: model.map(str::to_string), close_after_use: close }
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
