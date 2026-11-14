//! The hidden pane behind the sign-in step of a lend profile.
//!
//! Signing in to a lend sign-in means running the agent once, in its own sign-in folder, and finishing the agent's sign-in
//! screens. That used to be a normal pane (`new_pane`): it went to the sidebar, was selected, took the main area away from
//! Settings and cut the create flow in half. Here the pane belongs to the sheet instead:
//!
//! - it is marked hidden (`pty::hidden`) BEFORE it is spawned, so no pane list, session save, bridge route, helper list
//!   or MCP tool ever sees it (the spawn announces a panes change, and the first refresh must already leave it out);
//! - it is never presented: this file does not call `cockpit::present_pane` or send `cockpit://select`
//!   (`this_file_never_presents_a_pane` below keeps it that way), so the view never leaves Settings;
//! - the sheet shows its terminal by pane id (the data events are global, not part of any list);
//! - it is stopped when the sheet finishes or cancels, and after `TIMEOUT` with no one finishing it.
//!
//! The pane runs in an app-owned folder, never in a project.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::accounts::{Account, Store};
use crate::capacity_proxy::signin::{self, SigninFile, SigninState};
use crate::capacity_proxy::spec::ProxySpec;
use crate::pty::SpawnPaneArgs;

/// A sign-in nobody finished is stopped after this long (10 seconds' worth of milliseconds in tests).
pub const TIMEOUT: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(10 * 60) };

/// What the pane needs from the app: start one, stop one, ask whether it still runs. The real one is `registry_spawn_pane`
/// and friends; tests use a fake.
pub trait Ports: Send + Sync {
    fn spawn(&self, args: SpawnPaneArgs) -> Result<String, String>;
    fn kill(&self, pane_id: &str);
    fn alive(&self, pane_id: &str) -> bool;
}

struct Entry {
    pane_id: String,
    ports: Arc<dyn Ports>,
    /// Told apart from an older pane of the same account whose timer is still waiting.
    generation: u64,
}

/// The hidden sign-in panes, one per lend sign-in account.
#[derive(Default)]
pub struct SigninPanes {
    map: Mutex<HashMap<String, Entry>>,
    next: Mutex<u64>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The lend sign-in `account_id` of the store: it must exist, be a lend-only account and not be a borrowed id
/// (`lend:<grant id>`). Anything else is refused, so this can never open a person's own login folder.
pub fn check_account(store: &Store, account_id: &str) -> Result<Account, String> {
    if account_id.starts_with(crate::capacity_proxy::ACCOUNT_PREFIX) {
        return Err("A borrowed sign-in can't be signed in to here.".into());
    }
    let acc = store.get(account_id).ok_or("That lend sign-in no longer exists.")?;
    if !acc.lend_only {
        return Err("Only a lend sign-in can be signed in to from here.".into());
    }
    Ok(acc)
}

/// Where the sign-in state of `acc` is: the spec's token file inside its folder.
pub fn signin_file(spec: &ProxySpec, acc: &Account) -> Result<SigninFile, String> {
    let auth = spec.auth.account.as_ref().ok_or("This agent can't lend a sign-in through this PC.")?;
    SigninFile::new(&acc.home, auth)
}

/// The lend sign-in's state and who is signed in (read on this PC only).
pub fn status_of(spec: &ProxySpec, acc: &Account, now_ms: u64) -> Result<(SigninState, Option<String>), String> {
    let file = signin_file(spec, acc)?;
    let state = file.state(now_ms);
    let who = if state == SigninState::SignedIn { spec.auth.account.as_ref().and_then(|a| signin::identity(&acc.home, a)) } else { None };
    Ok((state, who))
}

/// A lend sign-in is "empty" when no sign-in file is in its folder (the folder may hold the agent's other first-run files).
pub fn holds_no_signin(spec: &ProxySpec, acc: &Account) -> bool {
    signin_file(spec, acc).map(|f| f.state(u64::MAX / 2) == SigninState::SignedOut).unwrap_or(true)
}

/// `lend_account_add` with "reuse": a draft that already holds an account which still exists, is a lend sign-in of the same
/// agent and is not signed in gets that account back, not a second "Lend Claude".
pub fn add_or_reuse(store: &Store, spec: &ProxySpec, agent_id: &str, label: &str, reuse: Option<&str>, now_ms: u64) -> Result<Account, String> {
    if let Some(id) = reuse.filter(|r| !r.is_empty()) {
        if let Ok(acc) = check_account(store, id) {
            if acc.agent_id.eq_ignore_ascii_case(agent_id) && signin_file(spec, &acc).map(|f| f.state(now_ms) != SigninState::SignedIn).unwrap_or(false) {
                return Ok(acc);
            }
        }
    }
    store.add_lend(agent_id, &free_label(store, agent_id, label))
}

/// A label no other account of this agent has (the store refuses two with the same name): "Lend Claude", "Lend Claude 2", ...
fn free_label(store: &Store, agent_id: &str, label: &str) -> String {
    let taken = |l: &str| store.list().iter().any(|a| a.agent_id.eq_ignore_ascii_case(agent_id) && a.label.eq_ignore_ascii_case(l));
    let base: String = label.chars().take(36).collect();
    if !taken(label) {
        return label.to_string();
    }
    (2..100).map(|n| format!("{base} {n}")).find(|l| !taken(l)).unwrap_or_else(|| label.to_string())
}

/// Stops the pane and, when asked, forgets the account if it holds no sign-in (the person backed out before signing in).
/// Returns whether the account was removed.
pub fn remove_if_empty(store: &Store, spec: &ProxySpec, acc: &Account) -> Result<bool, String> {
    if !holds_no_signin(spec, acc) {
        return Ok(false);
    }
    store.remove(&acc.id, true)?;
    Ok(true)
}

impl SigninPanes {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Starts the hidden sign-in pane of `acc` in `cwd`, or returns the one that already runs. The pane id is hidden before
    /// the spawn. Nothing is presented and nothing is selected.
    pub fn start(self: &Arc<Self>, ports: Arc<dyn Ports>, acc: &Account, cwd: PathBuf) -> Result<String, String> {
        {
            let map = lock(&self.map);
            if let Some(e) = map.get(&acc.id) {
                if e.ports.alive(&e.pane_id) {
                    return Ok(e.pane_id.clone());
                }
            }
        }
        // A pane that died (or was never really there) is dropped; a fresh one takes its place.
        self.stop(&acc.id);
        let _ = std::fs::create_dir_all(&cwd);
        let pane_id = uuid::Uuid::new_v4().to_string();
        crate::pty::hidden::hide(&pane_id);
        let spawned = ports.spawn(SpawnPaneArgs {
            agent_type: acc.agent_id.clone(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            cols: None,
            rows: None,
            extra_args: None,
            pane_id: Some(pane_id.clone()),
            read_only: false,
            account: Some(acc.id.clone()),
            guard_env: None,
        });
        let pane_id = match spawned {
            Ok(id) => id,
            Err(e) => {
                crate::pty::hidden::forget(&pane_id);
                return Err(e);
            }
        };
        let generation = {
            let mut n = lock(&self.next);
            *n += 1;
            *n
        };
        lock(&self.map).insert(acc.id.clone(), Entry { pane_id: pane_id.clone(), ports, generation });
        let (me, account) = (Arc::downgrade(self), acc.id.clone());
        let _ = std::thread::Builder::new().name("lend-signin-timeout".into()).spawn(move || {
            std::thread::sleep(TIMEOUT);
            if let Some(panes) = me.upgrade() {
                panes.stop_generation(&account, generation);
            }
        });
        Ok(pane_id)
    }

    fn stop_generation(&self, account_id: &str, generation: u64) {
        let entry = {
            let mut map = lock(&self.map);
            if map.get(account_id).is_some_and(|e| e.generation == generation) {
                map.remove(account_id)
            } else {
                None
            }
        };
        if let Some(e) = entry {
            e.ports.kill(&e.pane_id);
        }
    }

    /// Stops the pane of this sign-in (nothing happens when there is none).
    pub fn stop(&self, account_id: &str) {
        let entry = lock(&self.map).remove(account_id);
        if let Some(e) = entry {
            e.ports.kill(&e.pane_id);
        }
    }

    /// Every sign-in pane, on app exit.
    pub fn stop_all(&self) {
        let all: Vec<Entry> = lock(&self.map).drain().map(|(_, e)| e).collect();
        for e in all {
            e.ports.kill(&e.pane_id);
        }
    }

    #[cfg(test)]
    pub fn pane_of(&self, account_id: &str) -> Option<String> {
        lock(&self.map).get(account_id).map(|e| e.pane_id.clone())
    }

    /// Whether the account's pane still runs.
    pub fn alive(&self, account_id: &str) -> bool {
        lock(&self.map).get(account_id).is_some_and(|e| e.ports.alive(&e.pane_id))
    }
}

/// The app's single set of sign-in panes.
pub fn app_panes() -> Arc<SigninPanes> {
    static PANES: std::sync::OnceLock<Arc<SigninPanes>> = std::sync::OnceLock::new();
    PANES.get_or_init(SigninPanes::new).clone()
}

/// The real pane host: the pane registry of the app.
pub struct AppPorts {
    pub registry: Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    pub app: tauri::AppHandle,
}

impl Ports for AppPorts {
    fn spawn(&self, args: SpawnPaneArgs) -> Result<String, String> {
        crate::pty::registry_spawn_pane(&self.registry, &self.app, args)
    }
    fn kill(&self, pane_id: &str) {
        let _ = crate::pty::registry_kill_pane(&self.registry, pane_id);
    }
    fn alive(&self, pane_id: &str) -> bool {
        self.registry.lock().list_all().iter().any(|p| p.id == pane_id && p.status != "error")
    }
}

#[cfg(test)]
#[path = "signin_pane_tests.rs"]
mod tests;
