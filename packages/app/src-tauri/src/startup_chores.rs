//! Start-up chores the first screen does not need run on one background thread, after the window is open.
//! `open_then_run` is the ordering rule (window first, then chores) so a test can prove a slow chore never
//! holds the window back.

/// A named piece of work. It runs once, off the main thread.
pub struct Chore {
    pub name: &'static str,
    pub run: Box<dyn FnOnce() + Send>,
}

pub fn chore(name: &'static str, run: impl FnOnce() + Send + 'static) -> Chore {
    Chore { name, run: Box::new(run) }
}

/// Runs `open_window` first, then starts the chores in order on a single thread and returns at once.
/// `on_step(name, ms)` is told how long each chore took; `on_done` runs after the last one.
pub fn open_then_run(
    open_window: impl FnOnce(),
    chores: Vec<Chore>,
    on_step: impl Fn(&'static str, u64) + Send + 'static,
    on_done: impl FnOnce() + Send + 'static,
) -> std::thread::JoinHandle<()> {
    open_window();
    std::thread::Builder::new()
        .name("startup-chores".into())
        .spawn(move || {
            for Chore { name, run } in chores {
                let started = std::time::Instant::now();
                // One chore failing must not stop the ones after it.
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)).is_err() {
                    tracing::warn!(chore = name, "start-up chore panicked");
                }
                on_step(name, started.elapsed().as_millis() as u64);
            }
            on_done();
        })
        .expect("start-up chores thread")
}

/// The chores `setup` hands to `open_then_run`, in the order they ran before: none of them is read by the first
/// screen. (The legacy-data copies stay in `setup`: the bridge and push read the files they copy.)
pub fn chores_for_setup(
    app: tauri::AppHandle,
    registry: std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    bridge_url: Option<String>,
) -> Vec<Chore> {
    // A release build only: a development build must not open the phone tunnel.
    let _ = (&app, &bridge_url);
    vec![
        // What broke it: remove test copies an earlier run left behind (SPEC n33 section 3.4).
        #[cfg(not(test))]
        chore("bisect_sweep", || {
            crate::checkpoints::bisect::live::live().sweep_stale();
        }),
        // An agent that updated itself since the last check gets its free checks again (drift).
        chore("agent_drift_check", crate::agent_caps::drift::spawn_startup_check),
        // Text your agents: starts only if the person turned Telegram on before.
        chore("channels", {
            let app = app.clone();
            move || crate::channels::start(app, registry)
        }),
        chore("discord_alerts", crate::discord_alerts::init),
        #[cfg(not(debug_assertions))]
        chore("phone_tunnel", move || {
            if let Some(url) = bridge_url {
                if let Err(err) = crate::mobile_tunnel::start_mobile_tunnel(&app, url) {
                    tracing::warn!(%err, "mobile tunnel not started");
                }
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};

    #[test]
    fn the_window_opens_while_a_slow_chore_is_still_running() {
        let opened = Arc::new(AtomicBool::new(false));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (started_tx, started_rx) = mpsc::channel::<bool>();
        let opened_for_chore = opened.clone();
        let slow = chore("slow", move || {
            // Reports whether the window was already open when it began, then blocks until released.
            started_tx.send(opened_for_chore.load(Ordering::SeqCst)).unwrap();
            let _ = release_rx.recv();
        });
        let steps = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let steps_for_cb = steps.clone();
        let opened_in_open = opened.clone();
        let began = std::time::Instant::now();
        let handle = open_then_run(
            move || opened_in_open.store(true, Ordering::SeqCst),
            vec![slow, chore("after", || {})],
            move |name, _| steps_for_cb.lock().push(name),
            || {},
        );
        // open_then_run returned although the slow chore is blocked: the caller (setup) is not held.
        assert!(opened.load(Ordering::SeqCst));
        assert!(began.elapsed() < std::time::Duration::from_secs(2));
        assert!(started_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), "chore began after the window opened");
        assert!(steps.lock().is_empty(), "the slow chore has not finished");
        release_tx.send(()).unwrap();
        handle.join().unwrap();
        assert_eq!(*steps.lock(), vec!["slow", "after"]);
    }

    #[test]
    fn a_panicking_chore_does_not_stop_the_next_one() {
        let ran = Arc::new(AtomicBool::new(false));
        let ran2 = ran.clone();
        let handle = open_then_run(
            || {},
            vec![chore("boom", || panic!("x")), chore("next", move || ran2.store(true, Ordering::SeqCst))],
            |_, _| {},
            || {},
        );
        handle.join().unwrap();
        assert!(ran.load(Ordering::SeqCst));
    }
}
