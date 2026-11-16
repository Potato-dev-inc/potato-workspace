//! The OpenTunnel client the app owns (Labs `opentunnel_stable_link`, off by default).
//!
//! OpenTunnel is a third-party relay that gives this computer a fixed public address with its own certificate:
//! the relay never sees what is sent. This file starts exactly one client for one route and points it at the
//! tunnel listener (`pwa_server/tunnel_listener.rs`), never at the bridge or the phone server's own port.
//!
//! The relay's token and key live in the library's store, in the app data folder (an explicit path, never the
//! library's own home or temp fallback), locked to the current user on Windows. They stay in Rust: nothing here
//! reads, logs, mirrors or returns them. The settings file holds no secret either (`tunnel_config.rs`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use opentunnel::{Client, ClientOptions, ProxyProtocol, Route, Routes, State, Storage, Tunnel};
use parking_lot::Mutex;

use super::{Phase, TunnelState};
use crate::pwa_server::tunnel_listener::{ListenerConfig, TunnelListener};

/// The one profile name in the store.
const PROFILE: &str = "default";
/// Tests and proofs can point the store somewhere else with this; the app itself uses the app data folder.
pub const STORE_ENV: &str = "POTATO_WORKSPACE_OPENTUNNEL_STORE";
const ROUTE_FILE: &str = "route";

/// The pieces of one running OpenTunnel address. Dropping it stops the client and the listener.
pub(super) struct Running {
    _tunnel: Tunnel,
    _listener: TunnelListener,
}

impl std::fmt::Debug for Running {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Running {{ .. }}")
    }
}

/// What a start needs from the tunnel code.
pub(super) struct StartCtx {
    pub dist_root: PathBuf,
    pub bridge_port_file: PathBuf,
    pub dev_info: Arc<dyn Fn() -> crate::pwa_server::DevInfoPayload + Send + Sync>,
}

/// Where the relay's identity is kept.
pub fn store_dir() -> PathBuf {
    match std::env::var_os(STORE_ENV).filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => crate::app_paths::app_data_dir().join("opentunnel"),
    }
}

/// A random route name: 12 characters, lowercase letters and digits, starting with a letter. Never `@`.
pub fn make_route_name() -> String {
    use rand::Rng;
    const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    const ALL: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rngs::OsRng;
    let mut name = String::with_capacity(12);
    name.push(LETTERS[rng.gen_range(0..LETTERS.len())] as char);
    for _ in 1..12 {
        name.push(ALL[rng.gen_range(0..ALL.len())] as char);
    }
    name
}

/// A route name the relay accepts: one lowercase label, never the root route.
pub fn is_good_route(name: &str) -> bool {
    !name.is_empty() && name.len() <= 63 && name != "@" && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) && name.as_bytes()[0].is_ascii_lowercase()
}

/// The saved route name, or a new random one saved next to the identity so the address stays the same.
pub fn route_name(store: &Path) -> Result<String, String> {
    let file = store.join(ROUTE_FILE);
    if let Ok(text) = std::fs::read_to_string(&file) {
        let saved = text.trim();
        if is_good_route(saved) {
            return Ok(saved.to_string());
        }
    }
    let name = make_route_name();
    std::fs::write(&file, format!("{name}\n")).map_err(|err| format!("save the route name: {err}"))?;
    Ok(name)
}

/// Make the store folder and, on Windows, lock it to the current user (no inherited access).
pub fn prepare_store(store: &Path) -> Result<(), String> {
    crate::secure_file::create_private_dir(store).map_err(|err| format!("create the address folder: {err}"))?;
    lock_to_current_user(store)
}

#[cfg(windows)]
fn lock_to_current_user(dir: &Path) -> Result<(), String> {
    let user = std::env::var("USERNAME").map_err(|_| "could not tell which Windows user this is".to_string())?;
    let who = match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{user}"),
        _ => user,
    };
    let output = crate::proc_util::hidden_command("icacls")
        .arg(dir)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{who}:(OI)(CI)F"))
        .output()
        .map_err(|err| format!("lock the address folder: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Could not lock the address folder to your Windows user.".into())
    }
}

#[cfg(not(windows))]
fn lock_to_current_user(_dir: &Path) -> Result<(), String> {
    // Unix: `create_private_dir` made it 0700 and the library writes its files 0600.
    Ok(())
}

fn client() -> Client {
    Client::new(ClientOptions { storage: Some(Storage::at(store_dir())), ..Default::default() })
}

/// The tokio lock that lets only one start run at a time, so a slow older start can never leave a second client.
fn start_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Start the OpenTunnel client in the background. The state moves Starting -> Running (or Error); a newer launch
/// bumps `generation` and this start then quietly gives up.
pub(super) fn begin(state: Arc<Mutex<TunnelState>>, generation: u64, ctx: StartCtx) {
    tauri::async_runtime::spawn(async move {
        let _one_at_a_time = start_lock().lock().await;
        if state.lock().generation != generation {
            return;
        }
        if let Err(message) = run_start(&state, generation, ctx).await {
            let mut guard = state.lock();
            if guard.generation == generation {
                guard.phase = Phase::Error;
                guard.last_error = Some(message);
            }
        }
    });
}

async fn run_start(state: &Arc<Mutex<TunnelState>>, generation: u64, ctx: StartCtx) -> Result<(), String> {
    let store = store_dir();
    prepare_store(&store)?;
    let route = route_name(&store)?;
    let client = client();
    let identity = client.ensure(PROFILE).await.map_err(|err| friendly(&err.to_string()))?;
    if state.lock().generation != generation {
        return Ok(());
    }
    let host = format!("{route}.{}", identity.hostname).to_ascii_lowercase();
    let listener = TunnelListener::start(ListenerConfig {
        dist_root: ctx.dist_root,
        bridge_port_file: ctx.bridge_port_file,
        dev_info: ctx.dev_info,
        allowed_host: host.clone(),
    })?;
    let mut routes = Routes::new();
    routes.insert(route.clone(), Route::new(listener.target()).with_proxy_protocol(Some(ProxyProtocol::V2)));
    let tunnel = client.connect(PROFILE, routes).map_err(|err| friendly(&err.to_string()))?;
    let mut watch = tunnel.status_watch();
    {
        let mut guard = state.lock();
        if guard.generation != generation {
            return Ok(());
        }
        guard.tunnel_url = Some(format!("https://{host}"));
        guard.opentunnel = Some(Running { _tunnel: tunnel, _listener: listener });
    }
    tracing::info!(%host, "OpenTunnel address ready; waiting for the relay to connect");

    // Follow the client's state until a newer launch replaces this one.
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = watch.borrow_and_update().clone();
            {
                let mut guard = state.lock();
                if guard.generation != generation {
                    return;
                }
                match status.state {
                    State::Connected => {
                        guard.phase = Phase::Running;
                        guard.last_error = None;
                    }
                    State::Stopped => {
                        guard.phase = Phase::Error;
                        guard.last_error = Some(friendly(status.last_error.as_deref().unwrap_or("The relay connection stopped.")));
                    }
                    _ => {
                        guard.phase = Phase::Starting;
                        // A relay that cannot be reached shows why, but keeps trying.
                        guard.last_error = status.last_error.as_deref().map(friendly);
                    }
                }
            }
            if watch.changed().await.is_err() {
                return;
            }
        }
    });
    Ok(())
}

/// Plain words for the person; the relay's own text may carry detail that is not for the screen.
fn friendly(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") || lower.contains("network") || lower.contains("unreachable") {
        "Could not reach the OpenTunnel relay. Check your internet connection.".into()
    } else {
        "The OpenTunnel relay did not accept the request.".into()
    }
}

/// Delete the address on the relay and on this computer. `Err` says it could not reach the relay; nothing is
/// left half-done then (the local copy stays, so it can be tried again).
pub async fn forget_address() -> Result<(), String> {
    // Wait for a start that is still talking to the relay: it finds its launch replaced and gives up.
    let _one_at_a_time = start_lock().lock().await;
    let store = store_dir();
    if !store.exists() {
        return Ok(());
    }
    let client = client();
    client.remove(PROFILE).await.map_err(|_| "Could not reach the OpenTunnel relay to delete the address. Try again when you are online.".to_string())?;
    let _ = std::fs::remove_file(store.join(ROUTE_FILE));
    // The library removed the identity folder; take the route name and the empty store folder too.
    let _ = std::fs::remove_dir(&store);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_names_are_random_labels_and_never_the_root_route() {
        for _ in 0..50 {
            let name = make_route_name();
            assert_eq!(name.len(), 12);
            assert!(is_good_route(&name), "{name}");
            assert_ne!(name, "@");
        }
        assert_ne!(make_route_name(), make_route_name());
        for bad in ["", "@", "Abc", "1abc", "a-b", "a.b", &"a".repeat(64)] {
            assert!(!is_good_route(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_route_name_is_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("pm-ot-route-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = route_name(&dir).unwrap();
        assert_eq!(route_name(&dir).unwrap(), first);
        // a damaged file gets a new good name instead of being used
        std::fs::write(dir.join(ROUTE_FILE), "@\n").unwrap();
        let again = route_name(&dir).unwrap();
        assert!(is_good_route(&again));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_store_path_is_explicit() {
        // Never the library's own HOME or temp fallback: without the override it is under the app data folder.
        std::env::remove_var(STORE_ENV);
        assert!(store_dir().ends_with("opentunnel"));
        assert!(store_dir().starts_with(crate::app_paths::app_data_dir()));
    }

    #[test]
    fn what_the_person_reads_carries_no_relay_detail() {
        let text = friendly("error sending request for url (https://relay.example/api/tunnels?token=SECRET): connect timed out");
        assert!(!text.contains("SECRET") && !text.contains("relay.example"), "{text}");
        assert!(!friendly("401 Unauthorized token=SECRET").contains("SECRET"));
    }
}
