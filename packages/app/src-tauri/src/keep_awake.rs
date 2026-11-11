//! Keep the PC awake while agents work, so locking it (Win+L) does not stop them. Locking pauses nothing, but the
//! PC then sleeps by its power settings, and a sleeping PC stops every agent. This holds "system required" only (the
//! screen may still turn off), through the shared keyed holds in `night_shift::power`: Night Shift and a lend each
//! have their own key, so none of the three can cancel another.
//!
//! "Busy" is any pane (terminal or chat) whose status is `running`. A short grace time after the last one goes quiet
//! keeps the hold across the gap between two turns.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::night_shift::power::{AwakePort, KeyedHold};

pub const KEY: &str = "agents:busy";
/// How long the hold stays after the last pane went quiet.
pub const GRACE_MS: u64 = 2 * 60 * 1000;
const POLL: Duration = Duration::from_secs(10);

static ENABLED: AtomicBool = AtomicBool::new(true);

/// The setting arrived (or changed). On unless it is explicitly false.
pub fn apply_settings(public: &Value) {
    ENABLED.store(public.get("keep_awake_while_working").and_then(Value::as_bool).unwrap_or(true), Ordering::SeqCst);
}

#[derive(Default)]
struct State {
    held: bool,
    idle_since: Option<u64>,
}

pub struct Governor {
    awake: Arc<dyn AwakePort>,
    state: Mutex<State>,
}

impl Governor {
    pub fn new(awake: Arc<dyn AwakePort>) -> Self {
        Self { awake, state: Mutex::new(State::default()) }
    }

    /// One look at the world. `now_ms` is any steadily rising clock.
    pub fn tick(&self, enabled: bool, busy: bool, now_ms: u64) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if enabled && busy {
            s.idle_since = None;
            if !s.held {
                match self.awake.hold() {
                    Ok(()) => s.held = true,
                    Err(e) => tracing::warn!(error = %e, "keep awake: could not hold the PC"),
                }
            }
            return;
        }
        if !s.held {
            s.idle_since = None;
            return;
        }
        // Turned off: let go at once. Quiet: after the grace time.
        let since = *s.idle_since.get_or_insert(now_ms);
        if !enabled || now_ms.saturating_sub(since) >= GRACE_MS {
            self.awake.release();
            s.held = false;
            s.idle_since = None;
        }
    }

    #[cfg(test)]
    pub fn held(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).held
    }
}

/// True when any pane is running a turn.
pub fn any_busy(statuses: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    statuses.into_iter().any(|s| s.as_ref() == "running")
}

/// Start the poller (once, at app start).
pub fn spawn(registry: Arc<parking_lot::Mutex<crate::pty::registry::PaneRegistry>>) {
    let governor = Governor::new(Arc::new(KeyedHold::new(KEY, "Potato Workspace agents are working")));
    let started = std::time::Instant::now();
    let _ = std::thread::Builder::new().name("keep-awake-governor".into()).spawn(move || loop {
        std::thread::sleep(POLL);
        let busy = {
            let reg = registry.lock();
            any_busy(reg.list_all().into_iter().map(|p| p.status))
        };
        governor.tick(ENABLED.load(Ordering::SeqCst), busy, started.elapsed().as_millis() as u64);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[derive(Default)]
    struct Fake {
        takes: AtomicU64,
        releases: AtomicU64,
    }
    impl Fake {
        fn held(&self) -> bool {
            self.takes.load(Ordering::SeqCst) > self.releases.load(Ordering::SeqCst)
        }
    }
    impl AwakePort for Fake {
        fn hold(&self) -> Result<(), String> {
            self.takes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn release(&self) {
            self.releases.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn rig() -> (Arc<Fake>, Governor) {
        let fake = Arc::new(Fake::default());
        (fake.clone(), Governor::new(fake))
    }

    #[test]
    fn busy_means_a_running_pane() {
        assert!(any_busy(["idle", "running"]));
        assert!(!any_busy(["idle", "waiting_input", "error"]));
        assert!(!any_busy(Vec::<String>::new()));
    }

    #[test]
    fn taken_when_a_pane_becomes_busy_and_once() {
        let (fake, g) = rig();
        g.tick(true, false, 0);
        assert!(!fake.held());
        g.tick(true, true, 1000);
        g.tick(true, true, 2000);
        assert!(fake.held() && g.held());
        assert_eq!(fake.takes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn released_only_after_the_grace_time() {
        let (fake, g) = rig();
        g.tick(true, true, 0);
        g.tick(true, false, 10_000);
        g.tick(true, false, 10_000 + GRACE_MS - 1);
        assert!(fake.held(), "still inside the grace time");
        g.tick(true, false, 10_000 + GRACE_MS);
        assert!(!fake.held());
    }

    #[test]
    fn work_inside_the_grace_time_restarts_it() {
        let (fake, g) = rig();
        g.tick(true, true, 0);
        g.tick(true, false, 1_000);
        g.tick(true, true, 60_000);
        g.tick(true, false, 61_000);
        g.tick(true, false, 61_000 + GRACE_MS - 1);
        assert!(fake.held());
        assert_eq!(fake.takes.load(Ordering::SeqCst), 1, "one hold across the gap");
    }

    #[test]
    fn not_taken_when_the_setting_is_off_and_dropped_at_once_when_turned_off() {
        let (fake, g) = rig();
        g.tick(false, true, 0);
        assert_eq!(fake.takes.load(Ordering::SeqCst), 0);
        g.tick(true, true, 1);
        assert!(fake.held());
        g.tick(false, true, 2);
        assert!(!fake.held(), "turning it off lets the PC sleep without waiting");
    }

    #[test]
    fn setting_defaults_on_and_follows_the_switch() {
        apply_settings(&serde_json::json!({}));
        assert!(ENABLED.load(Ordering::SeqCst));
        apply_settings(&serde_json::json!({ "keep_awake_while_working": false }));
        assert!(!ENABLED.load(Ordering::SeqCst));
        apply_settings(&serde_json::json!({ "keep_awake_while_working": true }));
        assert!(ENABLED.load(Ordering::SeqCst));
    }

    #[test]
    fn coexists_with_the_lend_and_night_shift_holds() {
        use crate::night_shift::power::{adopt, is_held, keep_awake, release};
        // Three keys in the real shared table: letting go of one leaves the others on.
        let busy = KeyedHold::new("agents:busy-test", "test");
        let lend = KeyedHold::new("lend:out-test2", "test");
        busy.hold().unwrap();
        lend.hold().unwrap();
        adopt("ns-run-test2", keep_awake("test").unwrap());
        assert!(is_held("agents:busy-test") && is_held("lend:out-test2") && is_held("ns-run-test2"));
        busy.release();
        assert!(!is_held("agents:busy-test") && is_held("lend:out-test2") && is_held("ns-run-test2"));
        lend.release();
        assert!(is_held("ns-run-test2"), "Night Shift keeps its hold");
        release("ns-run-test2");
        assert!(!is_held("ns-run-test2"));
    }
}
