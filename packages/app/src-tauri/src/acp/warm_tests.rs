//! The warm chat pool's rules, against a fake host (no process is started).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::warm::*;
use crate::standby::config::{PreloadConfig, StandbyConfig};

#[derive(Default)]
struct Fake {
    next: AtomicU32,
    started: Mutex<Vec<(String, u32)>>,
    closed: Mutex<Vec<u32>>,
    dead: Mutex<BTreeSet<u32>>,
    /// Starts fail while this holds a message.
    fail: Mutex<Option<WarmFail>>,
}

impl WarmHost for Fake {
    type Item = u32;
    fn start(&self, key: &WarmKey, _folder: &Path) -> Result<u32, WarmFail> {
        if let Some(fail) = self.fail.lock().clone() {
            return Err(fail);
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.started.lock().push((key.agent.clone(), id));
        Ok(id)
    }
    fn alive(&self, item: &u32) -> bool {
        !self.dead.lock().contains(item)
    }
    fn close(&self, item: u32) {
        self.closed.lock().push(item);
    }
}

fn key(agent: &str) -> WarmKey {
    WarmKey::new(agent, "C:/work/app", None)
}

fn want(agent: &str) -> WarmWant {
    WarmWant { key: key(agent), folder: PathBuf::from("C:/work/app") }
}

fn policy(agents: &[&str], cap: usize) -> Policy {
    Policy { wanted: agents.iter().map(|a| want(a)).collect(), reusable_agents: agents.iter().map(|a| a.to_string()).collect(), cap, idle_ms: 20 * 60_000, recent_ms: 6 * 3_600_000 }
}

fn pool(policy: Policy) -> (Arc<Pool<Fake>>, Arc<Fake>) {
    let host = Arc::new(Fake::default());
    let pool = Pool::new(host.clone());
    pool.set_policy(policy);
    (pool, host)
}

/// One pass at `now`, with the starts run to the end at the same time.
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

fn wait_until(secs: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    condition()
}

#[test]
fn a_wanted_key_gets_one_warm_session_and_no_more() {
    let (pool, host) = pool(policy(&["claude"], 4));
    assert_eq!(settle(&pool, &host, 0), 1);
    assert_eq!(pool.ready_counts().get("claude"), Some(&1));
    assert_eq!(settle(&pool, &host, 1_000), 0, "one per key");
    assert_eq!(settle(&pool, &host, 2_000), 0);
    assert_eq!(host.started.lock().len(), 1);
}

#[test]
fn a_claim_takes_the_session_and_a_second_claim_before_the_refill_misses() {
    let (pool, host) = pool(policy(&["claude"], 4));
    settle(&pool, &host, 0);
    let first = pool.claim_without_refill(&key("claude"), Path::new("C:/work/app"), 10);
    assert_eq!(first, Some(1));
    assert_eq!(pool.claim_without_refill(&key("claude"), Path::new("C:/work/app"), 11), None, "the refill has not run yet");
    assert_eq!(settle(&pool, &host, 12), 1, "the next pass refills");
    assert_eq!(pool.claim_without_refill(&key("claude"), Path::new("C:/work/app"), 13), Some(2));
    assert!(host.closed.lock().is_empty(), "a claimed session is the claimant's, not closed");
}

#[test]
fn a_claim_refills_in_the_background() {
    let (pool, host) = pool(policy(&["claude"], 4));
    settle(&pool, &host, 0);
    assert_eq!(pool.claim(&key("claude"), Path::new("C:/work/app"), 10), Some(1));
    assert!(wait_until(5, || pool.ready_counts().get("claude") == Some(&1)), "refilled");
    assert_eq!(host.started.lock().len(), 2);
}

#[test]
fn a_claim_of_a_different_folder_or_account_misses() {
    let (pool, host) = pool(policy(&["claude"], 4));
    settle(&pool, &host, 0);
    assert_eq!(pool.claim_without_refill(&WarmKey::new("claude", "C:/other", None), Path::new("C:/other"), 1), None);
    assert_eq!(pool.claim_without_refill(&WarmKey::new("claude", "C:/work/app", Some("work")), Path::new("C:/work/app"), 1), None);
    assert_eq!(pool.claim_without_refill(&WarmKey::new("codex", "C:/work/app", None), Path::new("C:/work/app"), 1), None, "an agent the policy never named");
    // The spelling of the folder does not matter.
    assert_eq!(pool.claim_without_refill(&WarmKey::new("Claude", "c:\\work\\app\\", None), Path::new("C:/work/app"), 2), Some(1));
}

#[test]
fn an_idle_session_is_closed_and_its_key_stays_cold_until_used() {
    let mut p = policy(&["claude"], 4);
    p.idle_ms = 1_000;
    let (pool, host) = pool(p);
    settle(&pool, &host, 0);
    settle(&pool, &host, 999);
    assert!(host.closed.lock().is_empty(), "not idle yet");
    assert_eq!(settle(&pool, &host, 1_000), 0);
    assert_eq!(*host.closed.lock(), vec![1], "idle: closed");
    assert_eq!(settle(&pool, &host, 60_000), 0, "cold: not started again by itself");
    assert_eq!(pool.claim_without_refill(&key("claude"), Path::new("C:/work/app"), 70_000), None, "a use finds nothing warm");
    assert_eq!(settle(&pool, &host, 70_001), 1, "but warms it for the next one");
}

#[test]
fn a_dead_session_is_dropped_on_claim_and_on_a_pass() {
    let (pool, host) = pool(policy(&["claude", "codex"], 4));
    settle(&pool, &host, 0);
    host.dead.lock().extend([1, 2]);
    assert_eq!(pool.claim_without_refill(&key("claude"), Path::new("C:/work/app"), 10), None, "a dead session is not handed out");
    assert_eq!(host.closed.lock().len(), 1);
    settle(&pool, &host, 20);
    assert_eq!(host.closed.lock().len(), 2, "a pass drops the other dead one");
    assert_eq!(pool.ready_counts().len(), 0);
    // After the wait a replacement starts.
    assert_eq!(settle(&pool, &host, 20 + 30_000), 2);
}

#[test]
fn the_cap_holds_across_keys() {
    let (pool, host) = pool(policy(&["a", "b", "c", "d"], 2));
    assert_eq!(settle(&pool, &host, 0), 2);
    assert_eq!(settle(&pool, &host, 1), 0);
    assert_eq!(pool.len(), 2);
    // Never above the preload maximum whatever the policy says.
    let (pool, host) = self::pool(policy(&["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], 100));
    assert_eq!(settle(&pool, &host, 0), crate::standby::config::MAX_PRELOAD_TOTAL);
}

#[test]
fn a_failed_start_waits_longer_each_time_and_a_sign_in_problem_waits_the_longest() {
    assert_eq!(backoff_ms(1, false), 30_000);
    assert_eq!(backoff_ms(2, false), 60_000);
    assert_eq!(backoff_ms(3, false), 120_000);
    assert_eq!(backoff_ms(20, false), 600_000, "at most ten minutes");
    assert_eq!(backoff_ms(1, true), 600_000);

    let (pool, host) = pool(policy(&["claude"], 4));
    *host.fail.lock() = Some(WarmFail { message: "boom".into(), auth: false });
    assert_eq!(settle(&pool, &host, 0), 1);
    assert_eq!(settle(&pool, &host, 29_999), 0, "waiting");
    assert_eq!(settle(&pool, &host, 30_000), 1, "tries again");
    assert_eq!(settle(&pool, &host, 30_000 + 59_999), 0, "twice as long now");
    *host.fail.lock() = None;
    assert_eq!(settle(&pool, &host, 30_000 + 60_000), 1);
    assert_eq!(pool.ready_counts().get("claude"), Some(&1), "a success starts over");

    let (pool, host) = self::pool(policy(&["claude"], 4));
    *host.fail.lock() = Some(WarmFail { message: "sign in".into(), auth: true });
    settle(&pool, &host, 0);
    *host.fail.lock() = None;
    assert_eq!(settle(&pool, &host, 599_999), 0);
    assert_eq!(settle(&pool, &host, 600_000), 1);
}

#[test]
fn a_used_key_stays_wanted_for_the_recent_window_and_then_goes() {
    let mut p = policy(&[], 4);
    p.reusable_agents.insert("claude".into());
    p.recent_ms = 10_000;
    let (pool, host) = pool(p);
    let elsewhere = WarmKey::new("claude", "C:/elsewhere", None);
    assert_eq!(pool.claim_without_refill(&elsewhere, Path::new("C:/elsewhere"), 0), None);
    assert_eq!(settle(&pool, &host, 1), 1, "a use warms the key for the next start");
    assert_eq!(settle(&pool, &host, 9_000), 0);
    assert_eq!(pool.claim_without_refill(&elsewhere, Path::new("C:/elsewhere"), 9_500), Some(1));
    assert_eq!(settle(&pool, &host, 9_501), 1, "refilled: the use moved the window");
    // Not used again: the window ends and the session goes.
    settle(&pool, &host, 9_500 + 10_001);
    assert_eq!(host.closed.lock().len(), 1);
    assert!(pool.is_empty());
    // An agent the policy does not allow is never warmed by a use.
    assert_eq!(pool.claim_without_refill(&WarmKey::new("other", "C:/elsewhere", None), Path::new("C:/elsewhere"), 30_000), None);
    assert_eq!(settle(&pool, &host, 30_001), 0);
}

#[test]
fn a_key_the_policy_drops_is_closed() {
    let (pool, host) = pool(policy(&["claude", "codex"], 4));
    settle(&pool, &host, 0);
    pool.set_policy(policy(&["claude"], 4));
    settle(&pool, &host, 1);
    assert_eq!(host.closed.lock().len(), 1);
    assert_eq!(pool.ready_counts().keys().cloned().collect::<Vec<_>>(), vec!["claude".to_string()]);
    pool.set_policy(Policy::default());
    settle(&pool, &host, 2);
    assert!(pool.is_empty());
}

#[test]
fn shutdown_closes_everything_and_a_start_that_ends_later_is_closed_too() {
    let (pool, host) = pool(policy(&["claude", "codex"], 4));
    let (_, jobs) = pool.plan(0);
    let mut jobs = jobs.into_iter();
    pool.run(jobs.next().unwrap(), || 0);
    pool.shutdown();
    assert_eq!(host.closed.lock().len(), 1);
    pool.run(jobs.next().unwrap(), || 1);
    assert_eq!(host.closed.lock().len(), 2, "the late one never joins the pool");
    assert!(pool.is_empty());
    assert_eq!(pool.claim_without_refill(&key("claude"), Path::new("C:/work/app"), 5), None);
}

// ---- the policy from the settings -----------------------------------------------------------------------------

struct Probe(BTreeSet<&'static str>);
impl AgentProbe for Probe {
    fn runs_as_chat(&self, agent: &str) -> bool {
        self.0.contains(agent)
    }
}

fn standby(enabled: bool, counts: &[(&str, u8)]) -> StandbyConfig {
    StandbyConfig { preload: PreloadConfig { enabled, providers: counts.iter().map(|(a, n)| (a.to_string(), *n)).collect() }, ..StandbyConfig::default() }
}

#[test]
fn with_keep_agents_ready_off_nothing_is_wanted() {
    let dir = std::env::temp_dir();
    let probe = Probe(["claude", "codex"].into_iter().collect());
    let off = compute_policy(&standby(false, &[("claude", 1), ("codex", 1)]), Some(&dir), &probe);
    assert!(off.wanted.is_empty() && off.reusable_agents.is_empty(), "{off:?}");
    let (pool, host) = pool(off);
    assert_eq!(settle(&pool, &host, 0), 0);
    assert_eq!(pool.claim_without_refill(&key("claude"), &dir, 1), None);
    assert_eq!(settle(&pool, &host, 2), 0, "a use does not warm anything either");
}

#[test]
fn only_agents_with_a_count_whose_helper_runs_as_a_chat_are_wanted() {
    let dir = std::env::temp_dir();
    let probe = Probe(["claude", "codex"].into_iter().collect());
    // claude 1, codex 0, cursor 1 (its helper is a terminal: not a chat).
    let policy = compute_policy(&standby(true, &[("claude", 1), ("codex", 0), ("cursor", 1)]), Some(&dir), &probe);
    let agents: Vec<&str> = policy.wanted.iter().map(|w| w.key.agent.as_str()).collect();
    assert_eq!(agents, vec!["claude"]);
    assert_eq!(policy.reusable_agents.iter().cloned().collect::<Vec<_>>(), vec!["claude".to_string()]);
    assert_eq!(policy.wanted[0].key.account, None);
    assert!(policy.cap >= 1 && policy.cap <= 8);
    assert_eq!(policy.idle_ms, 20 * 60_000);
    // No usable project folder: nothing is warmed ahead, but a start in a folder still warms the next one.
    let none = compute_policy(&standby(true, &[("claude", 1)]), Some(Path::new("Z:/does/not/exist")), &probe);
    assert!(none.wanted.is_empty());
    assert!(none.reusable_agents.contains("claude"));
}
