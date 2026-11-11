//! Time-boxed leases on adopted panes. An agent that adopts a live pane (`run_agent` with
//! `pane_id` / `worker_id`, `take_over`) holds a lease on it; a second agent asking for the same
//! pane gets `PANE_LEASED` (retryable) instead of two callers typing into one terminal.
//!
//! A lease lives 60 s past its owner's last heartbeat. Every MCP call from the owner is a
//! heartbeat (`mcp_sessions::authorize`). The person in the app always wins: nothing in the UI
//! path consults leases, and an explicit `take_over(grant=true)` replaces the lease.

use crate::operations::OperationError;
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub const LEASE_TTL_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub owner_session: String,
    pub acquired_at_ms: u64,
    pub heartbeat_at_ms: u64,
}

static LEASES: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();

fn leases() -> &'static Mutex<HashMap<String, Lease>> {
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A short label for "which other session", stable within this run of the app and not reversible to
/// the session id (keyed by a per-process random salt).
fn opaque_owner_label(session: &str) -> String {
    use std::hash::{BuildHasher, Hash, Hasher};
    static SALT: OnceLock<std::collections::hash_map::RandomState> = OnceLock::new();
    let mut hasher = SALT.get_or_init(std::collections::hash_map::RandomState::new).build_hasher();
    session.hash(&mut hasher);
    format!("other-session-{:04x}", hasher.finish() & 0xffff)
}

fn expires_in(lease: &Lease, now: u64) -> u64 {
    lease
        .heartbeat_at_ms
        .saturating_add(LEASE_TTL_MS)
        .saturating_sub(now)
}

/// Take (or refresh) the lease on `pane_id` for `owner`. Fails with `PANE_LEASED` while another
/// session holds an unexpired lease.
pub fn acquire(pane_id: &str, owner: &str) -> Result<(), OperationError> {
    acquire_at(pane_id, owner, now_ms())
}

pub(crate) fn acquire_at(pane_id: &str, owner: &str, now: u64) -> Result<(), OperationError> {
    let mut map = leases().lock();
    if let Some(held) = map.get_mut(pane_id) {
        if held.owner_session == owner {
            held.heartbeat_at_ms = now;
            return Ok(());
        }
        let remaining = expires_in(held, now);
        if remaining > 0 {
            let mut error = OperationError::new(
                "PANE_LEASED",
                format!("this pane is in use by another agent session; retry in {} s", remaining.div_ceil(1000)),
                true,
            );
            error.retry_after_ms = Some(remaining);
            error.context = json!({
                "pane_id": pane_id,
                // An opaque label, never the session id: the id is the holder's only credential.
                "owner": opaque_owner_label(&held.owner_session),
                "expires_in_ms": remaining,
            });
            return Err(error);
        }
    }
    map.insert(
        pane_id.to_string(),
        Lease { owner_session: owner.to_string(), acquired_at_ms: now, heartbeat_at_ms: now },
    );
    Ok(())
}

/// Explicit preemption (`take_over` with `grant=true`): the lease moves to `owner` unconditionally.
pub fn force(pane_id: &str, owner: &str) {
    let now = now_ms();
    leases().lock().insert(
        pane_id.to_string(),
        Lease { owner_session: owner.to_string(), acquired_at_ms: now, heartbeat_at_ms: now },
    );
}

/// Any call from `owner` keeps every lease it holds alive.
pub fn heartbeat(owner: &str) {
    heartbeat_at(owner, now_ms());
}

pub(crate) fn heartbeat_at(owner: &str, now: u64) {
    let mut map = leases().lock();
    for lease in map.values_mut().filter(|lease| lease.owner_session == owner) {
        lease.heartbeat_at_ms = now;
    }
}

/// Free `pane_id` when `owner` holds it (the `release` tool). A lease held by someone else is untouched.
pub fn release(pane_id: &str, owner: &str) {
    let mut map = leases().lock();
    if map.get(pane_id).is_some_and(|lease| lease.owner_session == owner) {
        map.remove(pane_id);
    }
}


/// How often a blocked owner's leases are refreshed.
pub const KEEPALIVE_INTERVAL_MS: u64 = 20_000;

/// One keep-alive step: refresh the owner's leases when `KEEPALIVE_INTERVAL_MS` has passed since
/// `last_beat`; returns the new last-beat time. Pure in `now`, so tests drive it without sleeping.
pub(crate) fn keepalive_tick(owner: &str, now: u64, last_beat: u64) -> u64 {
    if now.saturating_sub(last_beat) >= KEEPALIVE_INTERVAL_MS {
        heartbeat_at(owner, now);
        now
    } else {
        last_beat
    }
}

/// Routes that block the caller for a long time (waits up to 300 s).
pub fn is_long_call(path: &str) -> bool {
    matches!(path, "/agents/wait" | "/agents/run" | "/agents/followup" | "/agents/send")
        || (path.starts_with("/operations/") && path.ends_with("/wait"))
}

/// Keeps `owner`'s leases alive while a long call is in flight. Dropping it stops the refresh.
pub struct KeepAlive {
    stop: std::sync::Arc<(Mutex<bool>, parking_lot::Condvar)>,
}

impl KeepAlive {
    pub fn start(owner: &str) -> Self {
        let stop = std::sync::Arc::new((Mutex::new(false), parking_lot::Condvar::new()));
        let shared = stop.clone();
        let owner = owner.to_string();
        std::thread::spawn(move || {
            let (flag, cv) = &*shared;
            let mut last = now_ms();
            let mut stopped = flag.lock();
            while !*stopped {
                cv.wait_for(&mut stopped, std::time::Duration::from_millis(KEEPALIVE_INTERVAL_MS));
                if *stopped {
                    break;
                }
                last = keepalive_tick(&owner, now_ms(), last);
            }
        });
        Self { stop }
    }
}

impl Drop for KeepAlive {
    fn drop(&mut self) {
        *self.stop.0.lock() = true;
        self.stop.1.notify_all();
    }
}

/// A run on `pane_id` reached a terminal state: free the lease its owner held.
pub fn release_on_terminal(pane_id: &str, owner: Option<&str>) {
    if let Some(owner) = owner {
        release(pane_id, owner);
    }
}
/// The unexpired lease on `pane_id`, if any.
#[cfg(test)]
pub fn current(pane_id: &str) -> Option<Lease> {
    let now = now_ms();
    leases().lock().get(pane_id).filter(|lease| expires_in(lease, now) > 0).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_caller_gets_pane_leased_with_owner_and_expiry() {
        let pane = "lease-test-conflict";
        acquire_at(pane, "session-a", 1_000).unwrap();
        let error = acquire_at(pane, "session-b", 11_000).unwrap_err();
        assert_eq!(error.code, "PANE_LEASED");
        assert!(error.recoverable);
        assert!(error.context.get("owner_session").is_none(), "the holder's session id is a credential");
        let label = error.context["owner"].as_str().unwrap().to_string();
        assert!(label.starts_with("other-session-") && !label.contains("session-a"), "{label}");
        assert!(!error.message.contains("session-a") && !error.context.to_string().contains("\"session-a\""));
        let again = acquire_at(pane, "session-b", 11_500).unwrap_err();
        assert_eq!(again.context["owner"], label.as_str(), "the label is stable");
        assert_eq!(error.context["expires_in_ms"], 50_000);
        assert_eq!(error.retry_after_ms, Some(50_000));
        // The owner re-adopting its own pane is fine.
        acquire_at(pane, "session-a", 12_000).unwrap();
    }

    #[test]
    fn lease_expires_sixty_seconds_after_the_last_heartbeat() {
        let pane = "lease-test-expiry";
        acquire_at(pane, "session-a", 0).unwrap();
        assert!(acquire_at(pane, "session-b", LEASE_TTL_MS - 1).is_err());
        acquire_at(pane, "session-b", LEASE_TTL_MS).unwrap();
        assert_eq!(leases().lock().get(pane).unwrap().owner_session, "session-b");
    }

    #[test]
    fn owner_heartbeat_extends_the_lease() {
        let pane = "lease-test-heartbeat";
        acquire_at(pane, "session-hb", 0).unwrap();
        heartbeat_at("session-hb", 50_000);
        // 70 s after acquisition, but only 20 s after the heartbeat: still held.
        let error = acquire_at(pane, "session-other", 70_000).unwrap_err();
        assert_eq!(error.context["expires_in_ms"], 40_000);
        // A heartbeat from a different session changes nothing.
        heartbeat_at("session-other", 70_000);
        assert!(acquire_at(pane, "session-other", 110_000).is_ok());
    }

    #[test]
    fn release_frees_only_the_owners_lease() {
        let pane = "lease-test-release";
        acquire(pane, "session-a").unwrap();
        release(pane, "session-b");
        assert!(acquire(pane, "session-b").is_err());
        release(pane, "session-a");
        acquire(pane, "session-b").unwrap();
        release(pane, "session-b");
    }


    #[test]
    fn a_simulated_ninety_second_wait_keeps_the_lease() {
        let pane = "lease-test-longwait";
        acquire_at(pane, "waiter", 0).unwrap();
        let mut last = 0;
        let mut t = 0;
        while t < 90_000 {
            t += 1_000;
            last = keepalive_tick("waiter", t, last);
            // A rival at every step still finds the lease held.
            assert!(acquire_at(pane, "rival", t).is_err(), "lapsed at {t} ms");
        }
        assert_eq!(last, 80_000);
        // Without keep-alive the same 90 s would have lapsed.
        acquire_at("lease-test-nowait", "waiter", 0).unwrap();
        assert!(acquire_at("lease-test-nowait", "rival", 90_000).is_ok());
    }

    #[test]
    fn terminal_state_frees_only_the_owners_lease() {
        let pane = "lease-test-terminal";
        acquire_at(pane, "owner", now_ms()).unwrap();
        release_on_terminal(pane, Some("someone-else"));
        assert!(current(pane).is_some());
        release_on_terminal(pane, None);
        assert!(current(pane).is_some());
        release_on_terminal(pane, Some("owner"));
        assert!(current(pane).is_none());
    }
    #[test]
    fn grant_take_over_replaces_the_lease() {
        let pane = "lease-test-force";
        acquire(pane, "session-a").unwrap();
        force(pane, "session-b");
        assert_eq!(current(pane).unwrap().owner_session, "session-b");
        release(pane, "session-b");
    }
}
