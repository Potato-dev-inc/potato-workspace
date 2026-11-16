//! Production mobile tunnel — bundled cloudflared + loopback PWA server.
//!
//! Which tunnel runs is decided by `tunnel_config` (quick | named | custom), with the
//! `POTATO_WORKSPACE_PUBLIC_URL` env var winning over the saved setting.
#![allow(dead_code)]

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::OnceCell;
use tauri::{AppHandle, Manager};

use crate::app_paths;
use crate::pwa_server::{self, DevInfoPayload};
use crate::tunnel_config::{self, TunnelConfigInput, TunnelConfigView};

pub(crate) mod opentunnel;
pub(crate) mod stable_link;
use stable_link::LinkState;

static TUNNEL_STATE: OnceCell<Arc<Mutex<TunnelState>>> = OnceCell::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Nothing is running (disabled, or a dev build that never starts the tunnel).
    Stopped,
    Starting,
    Running,
    Error,
}

struct TunnelState {
    tunnel_url: Option<String>,
    tunnel_provider: Option<String>,
    bridge_direct_url: Option<String>,
    cloudflared_child: Option<Child>,
    /// The OpenTunnel client and its listener (Labs). At most one: a launch drops the old one first.
    opentunnel: Option<opentunnel::Running>,
    pwa_server: Option<pwa_server::PwaServerHandle>,
    /// Effective mode after the env override: env | quick | named | custom | stable.
    mode: &'static str,
    /// `stable` mode only: the Worker and where this computer is registered on it.
    stable: Option<StableInfo>,
    phase: Phase,
    last_error: Option<String>,
    /// Bumped on every (re)launch so a dead tunnel's log readers cannot overwrite the new state.
    generation: u64,
}

struct StableInfo {
    worker_url: String,
    /// The trycloudflare address cloudflared printed last (never advertised to phones).
    quick_url: Option<String>,
    link: LinkState,
}

/// `stable` mode as the Settings tab shows it: "Stable link: <worker> -> linked / not linked yet (<error>)".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StableStatus {
    pub worker_url: String,
    pub quick_url: Option<String>,
    /// waiting | linking | linked | failed
    pub link: &'static str,
    pub error: Option<String>,
}

impl StableInfo {
    fn view(&self) -> StableStatus {
        let (link, error) = match &self.link {
            LinkState::Waiting => ("waiting", None),
            LinkState::Registering => ("linking", None),
            LinkState::Linked => ("linked", None),
            LinkState::Failed(why) => ("failed", Some(why.clone())),
        };
        StableStatus { worker_url: self.worker_url.clone(), quick_url: self.quick_url.clone(), link, error }
    }
}

/// A secret sent to the UI once (when made, or on "Show secret"). Debug never prints it.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RevealedSecret(String);

impl std::fmt::Debug for RevealedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RevealedSecret(<redacted>)")
    }
}

/// What the Settings tab and the status command show.
#[derive(Debug, Clone, Serialize)]
pub struct TunnelStatus {
    pub mode: &'static str,
    pub public_url: Option<String>,
    pub state: Phase,
    pub error: Option<String>,
    pub config: TunnelConfigView,
    /// `stable` mode: the Worker, the quick-tunnel address behind it and whether they are linked.
    pub stable: Option<StableStatus>,
    /// Set only on the answer to a save that made the secret or asked to show it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_once: Option<RevealedSecret>,
}

/// Result of "Test connection".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub url: String,
    pub http_status: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
}

impl TunnelState {
    fn new() -> Self {
        Self {
            tunnel_url: None,
            tunnel_provider: None,
            bridge_direct_url: None,
            cloudflared_child: None,
            opentunnel: None,
            pwa_server: None,
            mode: "quick",
            stable: None,
            phase: Phase::Stopped,
            last_error: None,
            generation: 0,
        }
    }

    fn dev_info_payload(&self) -> DevInfoPayload {
        // Empty while the phone server is not running: the page treats an empty address as "none".
        let local_url = local_phone_url().unwrap_or_default();
        let tunnel_url = self.tunnel_url.clone();
        let bridge_proxy_url = match (&tunnel_url, local_url.is_empty()) {
            (Some(url), _) => format!("{}/bridge", url.trim_end_matches('/')),
            (None, false) => format!("{local_url}/bridge"),
            (None, true) => String::new(),
        };

        DevInfoPayload {
            local_url: local_url.clone(),
            pwa_url: local_url,
            tunnel_url: tunnel_url.clone(),
            tunnel_provider: self.tunnel_provider.clone(),
            bridge_proxy_url,
            bridge_direct_url: self.bridge_direct_url.clone(),
            updated_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }
    }

    fn kill_child(&mut self) {
        if let Some(mut child) = self.cloudflared_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Stops the OpenTunnel client and its listener too.
        self.opentunnel = None;
    }
}

/// Where the phone server answers on this computer, or `None` when it is not running (it never bound a port).
fn local_phone_url() -> Option<String> {
    pwa_server::bound_pwa_port().map(|port| format!("http://127.0.0.1:{port}"))
}

/// The Labs switch `opentunnel_stable_link` (off by default; on in a development build like every Labs switch).
pub const OPENTUNNEL_SWITCH: &str = "opentunnel_stable_link";

fn switch_in(settings: &serde_json::Value) -> bool {
    settings.get(OPENTUNNEL_SWITCH).and_then(serde_json::Value::as_bool).unwrap_or(false)
}

fn opentunnel_switch_on(app: &AppHandle) -> bool {
    switch_in(&crate::settings_store::read_public_settings(app))
}

/// What a settings change means for the OpenTunnel address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettingsAction {
    Nothing,
    /// The Labs switch went off: close the client and its listener.
    Stop,
    /// The Labs switch is on and the saved setting asks for the fixed address, but it is not running: start it.
    Start,
}

fn settings_action(switch_on: bool, wants_open_tunnel: bool, has_opentunnel: bool, mode: &str, phase: Phase, phone_server_up: bool) -> SettingsAction {
    if !switch_on {
        return if has_opentunnel || mode == "open_tunnel" && phase != Phase::Stopped { SettingsAction::Stop } else { SettingsAction::Nothing };
    }
    // Running, starting or failed with this mode: leave it. A failed start is retried by "Restart", not by every setting.
    let running_as_open_tunnel = mode == "open_tunnel" && phase != Phase::Stopped;
    if wants_open_tunnel && phone_server_up && !running_as_open_tunnel {
        SettingsAction::Start
    } else {
        SettingsAction::Nothing
    }
}

/// Kept so a settings change (which has no app handle) can start the address again.
static APP: OnceCell<AppHandle> = OnceCell::new();

/// Settings changed. With the Labs switch off, a running OpenTunnel address stops (the client and its listener
/// close). With it on again and the fixed address saved as the choice, it starts again in this same run.
pub fn apply_settings(effective: &serde_json::Value) {
    let switch_on = switch_in(effective);
    let wants = tunnel_config::load(&tunnel_config::tunnel_file()) == tunnel_config::TunnelConfig::OpenTunnel;
    let state = tunnel_state();
    let action = {
        let mut guard = state.lock();
        let action = settings_action(switch_on, wants, guard.opentunnel.is_some(), guard.mode, guard.phase, guard.pwa_server.is_some());
        if action == SettingsAction::Stop {
            guard.opentunnel = None;
            guard.generation += 1;
            guard.tunnel_url = None;
            guard.phase = Phase::Stopped;
            guard.last_error = None;
            tracing::info!("the fixed phone address was switched off in Early features; its client stopped");
        }
        action
    };
    if action == SettingsAction::Start && is_tunnel_enabled() && custom_public_url().is_none() {
        if let Some(app) = APP.get().cloned() {
            tracing::info!("the fixed phone address was switched on in Early features; starting it");
            // Off the settings thread: the start reads settings itself.
            thread::spawn(move || {
                if let Err(err) = launch_tunnel(&app) {
                    tracing::warn!(%err, "could not start the fixed phone address");
                }
            });
        }
    }
}

/// What the person reads when a tunnel is asked for while the phone server is not running.
const PHONE_SERVER_DOWN: &str = "The phone server is not running, so there is nothing to share yet.";

fn tunnel_state() -> Arc<Mutex<TunnelState>> {
    TUNNEL_STATE
        .get_or_init(|| Arc::new(Mutex::new(TunnelState::new())))
        .clone()
}

/// Stop the tunnel program (cloudflared) so an uninstall can delete it. Own child only.
pub fn stop_for_uninstall() {
    tunnel_state().lock().kill_child();
}

/// "Forget this address": stop the OpenTunnel client, delete the address on the relay and on this computer, and go
/// back to the automatic address. When the relay cannot be reached nothing is deleted and the answer says so.
pub async fn forget_open_tunnel_address(app: AppHandle) -> Result<TunnelStatus, String> {
    {
        let state = tunnel_state();
        let mut guard = state.lock();
        guard.opentunnel = None;
        guard.generation += 1;
        guard.tunnel_url = None;
        guard.phase = Phase::Stopped;
    }
    opentunnel::forget_address().await?;
    tauri::async_runtime::spawn_blocking(move || apply_tunnel_config(&app, TunnelConfigInput::Quick))
        .await
        .map_err(|err| err.to_string())?
}

pub fn is_tunnel_enabled() -> bool {
    match std::env::var("POTATO_WORKSPACE_TUNNEL") {
        Ok(value) => value.trim() != "0",
        Err(_) => true,
    }
}

pub fn custom_public_url() -> Option<String> {
    let raw = std::env::var("POTATO_WORKSPACE_PUBLIC_URL").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_bridge = trimmed.trim_end_matches('/').trim_end_matches("/bridge");
    Some(without_bridge.to_string())
}

pub fn get_mobile_tunnel_info() -> DevInfoPayload {
    tunnel_state().lock().dev_info_payload()
}

/// Current mode, public URL and running/error state (`get_tunnel_status`).
pub fn tunnel_status() -> TunnelStatus {
    let state = tunnel_state();
    let guard = state.lock();
    TunnelStatus {
        mode: guard.mode,
        public_url: guard.tunnel_url.clone(),
        state: guard.phase,
        error: guard.last_error.clone(),
        config: tunnel_config::load(&tunnel_config::tunnel_file()).view(),
        stable: guard.stable.as_ref().map(StableInfo::view),
        secret_once: None,
    }
}

pub fn start_mobile_tunnel(app: &AppHandle, bridge_direct_url: String) -> Result<(), String> {
    if !is_tunnel_enabled() {
        tracing::info!("mobile tunnel disabled (POTATO_WORKSPACE_TUNNEL=0)");
        return Ok(());
    }

    let _ = APP.set(app.clone());
    let dist_root = resolve_pwa_dist_root(app)?;
    let bridge_port_file = app_paths::bridge_port_file();
    let state = tunnel_state();

    {
        let mut guard = state.lock();
        guard.bridge_direct_url = Some(bridge_direct_url.clone());
    }

    let dev_info_supplier: Arc<dyn Fn() -> DevInfoPayload + Send + Sync> =
        Arc::new(|| get_mobile_tunnel_info());
    let pwa_server = pwa_server::start_pwa_server(dist_root, bridge_port_file, dev_info_supplier)?;
    {
        let mut guard = state.lock();
        guard.pwa_server = Some(pwa_server);
    }

    // A second app on this computer (`POTATO_WORKSPACE_PROFILE`) opens no public address unless asked.
    if crate::app_paths::profile().is_some() && std::env::var("POTATO_WORKSPACE_TUNNEL").ok().as_deref() != Some("1") {
        tracing::info!("profile: public tunnel off (set POTATO_WORKSPACE_TUNNEL=1 to open one)");
        return Ok(());
    }

    launch_tunnel(app)
}

/// Stop the current tunnel process (if any) and start whatever the saved setting asks for.
/// The loopback PWA server keeps running; only the public side changes.
pub fn restart_mobile_tunnel(app: &AppHandle) -> Result<TunnelStatus, String> {
    if !is_tunnel_enabled() {
        return Err("The mobile tunnel is turned off (POTATO_WORKSPACE_TUNNEL=0).".into());
    }
    if tunnel_state().lock().pwa_server.is_none() {
        return Err("The tunnel only runs in the installed app, not in a dev build.".into());
    }
    launch_tunnel(app)?;
    Ok(tunnel_status())
}

/// Persist a new setting from the UI, then restart the tunnel so it takes effect.
pub fn apply_tunnel_config(
    app: &AppHandle,
    input: TunnelConfigInput,
) -> Result<TunnelStatus, String> {
    let path = tunnel_config::tunnel_file();
    let current = tunnel_config::load(&path);
    if matches!(input, TunnelConfigInput::OpenTunnel) && !opentunnel_switch_on(app) {
        return Err("Turn on \"Fixed phone address\" in Early features first.".into());
    }
    let next = tunnel_config::config_from_input(input.clone(), &current)?;
    let reveal = secret_to_reveal(&input, &current, &next);
    // A new secret replaces the old one: ask the Worker to forget the old one first (best effort).
    if let (tunnel_config::TunnelConfig::Stable { worker_url, secret: old }, true) = (&current, replaces_secret(&current, &next)) {
        if !old.is_empty() {
            stable_link::reset_once(worker_url, old);
        }
    }
    tunnel_config::save(&path, &next)?;
    // "Show secret" changes nothing: do not drop the tunnel (and its address) just to read a secret.
    let only_showing = matches!(&input, TunnelConfigInput::Stable { secret_action: tunnel_config::SecretAction::Show, secret: None, .. }) && next == current;
    let restarted = if only_showing { Ok(tunnel_status()) } else { restart_mobile_tunnel(app) };
    let mut status = tunnel_status();
    status.secret_once = reveal.map(RevealedSecret);
    if let Err(err) = restarted {
        // The setting is saved; say why it is not live yet.
        status.error = Some(err);
    }
    Ok(status)
}

fn launch_tunnel(app: &AppHandle) -> Result<(), String> {
    let state = tunnel_state();
    let config = tunnel_config::load(&tunnel_config::tunnel_file());
    let plan = tunnel_config::resolve_plan(custom_public_url(), &config, opentunnel_switch_on(app));

    let generation = {
        let mut guard = state.lock();
        guard.kill_child();
        guard.generation += 1;
        guard.mode = plan.mode();
        guard.tunnel_url = plan.known_public_url();
        guard.last_error = None;
        guard.stable = match &plan {
            tunnel_config::TunnelPlan::Stable { worker_url } => {
                Some(StableInfo { worker_url: worker_url.clone(), quick_url: None, link: LinkState::Waiting })
            }
            _ => None,
        };
        guard.tunnel_provider = Some(
            match &plan {
                tunnel_config::TunnelPlan::Quick => "cloudflared",
                tunnel_config::TunnelPlan::Named { .. } => "cloudflared-named",
                tunnel_config::TunnelPlan::Stable { .. } => "cloudflared-stable",
                tunnel_config::TunnelPlan::OpenTunnel => "opentunnel",
                _ => "custom",
            }
            .into(),
        );
        if plan.runs_cloudflared() || plan.runs_opentunnel() {
            guard.phase = Phase::Starting;
        } else {
            guard.phase = Phase::Running;
            tracing::info!(
                mode = plan.mode(),
                url = %guard.tunnel_url.as_deref().unwrap_or(""),
                "using a fixed public URL for the mobile tunnel"
            );
            return Ok(());
        }
        guard.generation
    };

    let fail = |message: String| -> String {
        let mut guard = state.lock();
        guard.phase = Phase::Error;
        guard.last_error = Some(message.clone());
        message
    };

    if plan.runs_opentunnel() {
        let dist_root = resolve_pwa_dist_root(app).map_err(&fail)?;
        opentunnel::begin(
            state.clone(),
            generation,
            opentunnel::StartCtx {
                dist_root,
                bridge_port_file: app_paths::bridge_port_file(),
                dev_info: Arc::new(|| get_mobile_tunnel_info()),
            },
        );
        tracing::info!("starting the OpenTunnel fixed phone address");
        return Ok(());
    }

    let cloudflared_bin = resolve_cloudflared_bin(app).map_err(&fail)?;
    let local_target = local_phone_url().ok_or_else(|| fail(PHONE_SERVER_DOWN.into()))?;
    let mut command = crate::proc_util::hidden_command(&cloudflared_bin);
    command
        .args(tunnel_config::cloudflared_args(&plan, &local_target))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match (&plan, &config) {
        (
            tunnel_config::TunnelPlan::Named { .. },
            tunnel_config::TunnelConfig::Named { token, .. },
        ) => {
            command.env(tunnel_config::TUNNEL_TOKEN_ENV, token);
        }
        _ => {
            command.env_remove(tunnel_config::TUNNEL_TOKEN_ENV);
        }
    }
    let named = matches!(plan, tunnel_config::TunnelPlan::Named { .. });
    // The Worker address and secret travel into the reader thread, which registers each new quick-tunnel URL.
    let stable = match (&plan, &config) {
        (tunnel_config::TunnelPlan::Stable { worker_url }, tunnel_config::TunnelConfig::Stable { secret, .. }) => {
            Some(StableCtx { worker_url: worker_url.clone(), secret: secret.clone() })
        }
        _ => None,
    };
    let mut child = command.spawn().map_err(|err| {
        fail(format!(
            "spawn cloudflared {}: {err}",
            cloudflared_bin.display()
        ))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| fail("cloudflared stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| fail("cloudflared stderr unavailable".into()))?;

    let readers: [(&str, Box<dyn std::io::Read + Send>); 2] = [
        ("cloudflared-stdout", Box::new(stdout)),
        ("cloudflared-stderr", Box::new(stderr)),
    ];
    for (name, reader) in readers {
        let state_for_reader = state.clone();
        let stable_for_reader = stable.clone();
        thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                watch_cloudflared_stream(BufReader::new(reader), state_for_reader, generation, named, stable_for_reader)
            })
            .map_err(|err| fail(format!("spawn {name} reader: {err}")))?;
    }

    state.lock().cloudflared_child = Some(child);
    tracing::info!(mode = plan.mode(), target = %local_target, "started cloudflared for the mobile PWA");
    Ok(())
}

/// What a reader thread needs to register a quick-tunnel URL with the person's Worker.
#[derive(Clone)]
struct StableCtx {
    worker_url: String,
    secret: String,
}

fn watch_cloudflared_stream(
    reader: BufReader<impl std::io::Read>,
    state: Arc<Mutex<TunnelState>>,
    generation: u64,
    named: bool,
    stable: Option<StableCtx>,
) {
    let url_re = Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").expect("url regex");
    for line in reader.lines().map_while(Result::ok) {
        let mut guard = state.lock();
        if guard.generation != generation {
            return; // a newer launch owns the state
        }
        if named {
            match tunnel_config::classify_named_line(&line) {
                tunnel_config::NamedLine::Connected => {
                    guard.phase = Phase::Running;
                    guard.last_error = None;
                }
                tunnel_config::NamedLine::Failed(message) => {
                    guard.phase = Phase::Error;
                    guard.last_error = Some(message);
                }
                tunnel_config::NamedLine::Other => {}
            }
        } else if let Some(found) = url_re.find(&line) {
            let url = found.as_str().to_string();
            if let Some(ctx) = &stable {
                // Phones keep the Worker address; only the Worker is told the new quick-tunnel address.
                let is_new = guard.stable.as_ref().is_some_and(|s| s.quick_url.as_deref() != Some(url.as_str()));
                if is_new {
                    if let Some(info) = guard.stable.as_mut() {
                        info.quick_url = Some(url.clone());
                        info.link = LinkState::Registering;
                    }
                    guard.phase = Phase::Running;
                    tracing::info!("cloudflared quick URL ready; registering it with the stable-link Worker");
                    spawn_registration(state.clone(), generation, ctx.clone(), url);
                }
            } else if guard.tunnel_url.as_deref() != Some(url.as_str()) {
                guard.tunnel_url = Some(url.clone());
                guard.phase = Phase::Running;
                tracing::info!(%url, "cloudflared public URL ready");
            }
        }
    }
    // Stream closed: cloudflared exited. A restart bumps the generation first, so this is a crash.
    let mut guard = state.lock();
    if guard.generation == generation && guard.phase != Phase::Error {
        guard.phase = Phase::Error;
        guard.last_error = Some("cloudflared stopped. Press Restart tunnel.".into());
    }
}

/// Register `quick_url` with the Worker in the background, retrying with a growing wait. Stops when a newer
/// launch or a newer quick-tunnel URL replaced this one.
fn spawn_registration(state: Arc<Mutex<TunnelState>>, generation: u64, ctx: StableCtx, quick_url: String) {
    let is_current = {
        let (state, quick_url) = (state.clone(), quick_url.clone());
        move || {
            let guard = state.lock();
            guard.generation == generation && guard.stable.as_ref().and_then(|s| s.quick_url.as_deref()) == Some(quick_url.as_str())
        }
    };
    let report = {
        let state = state.clone();
        let quick_url = quick_url.clone();
        move |link: LinkState| {
            let mut guard = state.lock();
            if guard.generation != generation {
                return;
            }
            if let Some(info) = guard.stable.as_mut().filter(|s| s.quick_url.as_deref() == Some(quick_url.as_str())) {
                if link == LinkState::Linked {
                    tracing::info!("stable link registered");
                }
                info.link = link;
            }
        }
    };
    let spawned = thread::Builder::new().name("stable-link-register".into()).spawn(move || {
        stable_link::register_until_done(
            || stable_link::register_once(&ctx.worker_url, &ctx.secret, &quick_url),
            thread::sleep,
            is_current,
            report,
        );
    });
    if let Err(err) = spawned {
        tracing::warn!(%err, "could not start the stable-link registration thread");
    }
}

/// The secret to send back to the UI once: a freshly made one, or the stored one when asked to show it.
fn secret_to_reveal(
    input: &TunnelConfigInput,
    before: &tunnel_config::TunnelConfig,
    after: &tunnel_config::TunnelConfig,
) -> Option<String> {
    let TunnelConfigInput::Stable { secret, secret_action, .. } = input else {
        return None;
    };
    let typed_by_person = secret.as_deref().is_some_and(|s| !s.trim().is_empty());
    let made_now = !typed_by_person && after.stable_secret() != before.stable_secret();
    let asked = *secret_action == tunnel_config::SecretAction::Show;
    (made_now || asked).then(|| after.stable_secret().map(str::to_string)).flatten()
}

/// Whether saving `after` over `before` swaps one stable secret for another.
fn replaces_secret(before: &tunnel_config::TunnelConfig, after: &tunnel_config::TunnelConfig) -> bool {
    match (before.stable_secret(), after.stable_secret()) {
        (Some(old), Some(new)) => old != new,
        _ => false,
    }
}

/// Interpret the answer of `<public>/bridge/health`. Pure so it is testable without a network.
pub fn interpret_health(
    url: &str,
    http_status: Option<u16>,
    body: &str,
    latency_ms: u64,
    transport_error: Option<&str>,
) -> ConnectionTest {
    let (ok, message) = match (http_status, transport_error) {
        (_, Some(err)) => (false, format!("Could not reach {url}: {err}")),
        (Some(200), None) => {
            let looks_like_pm = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .is_some_and(|v| v.get("ok").and_then(serde_json::Value::as_bool) == Some(true));
            if looks_like_pm {
                (true, format!("Connected in {latency_ms} ms."))
            } else {
                (
                    false,
                    "The address answered, but it is not Potato Workspace. Check the proxy target."
                        .to_string(),
                )
            }
        }
        (Some(502 | 503 | 504 | 530), None) => (
            false,
            "The address is up, but it cannot reach Potato Workspace. Is the tunnel running?"
                .to_string(),
        ),
        (Some(code), None) => (
            false,
            format!("The address answered with HTTP {code}, not Potato Workspace's health check."),
        ),
        (None, None) => (false, "No answer.".to_string()),
    };
    ConnectionTest {
        ok,
        url: url.to_string(),
        http_status,
        latency_ms,
        message,
    }
}

/// Fetch `<public>/bridge/health` (blocking). `None` tests the tunnel's current public URL.
pub fn test_connection(public_url: Option<String>) -> Result<ConnectionTest, String> {
    // Stable link: the Worker must answer and say it is linked before the bridge behind it is tried.
    let stable_worker = tunnel_state().lock().stable.as_ref().map(|s| s.worker_url.clone());
    if let Some(worker) = stable_worker.filter(|w| public_url.as_deref().is_none_or(|u| u.trim().is_empty() || u.trim().trim_end_matches('/') == w)) {
        let started = std::time::Instant::now();
        if let Err(message) = stable_link::check_worker(&worker) {
            return Ok(ConnectionTest {
                ok: false,
                url: stable_link::health_url(&worker),
                http_status: None,
                latency_ms: started.elapsed().as_millis() as u64,
                message,
            });
        }
        return test_origin(&worker);
    }
    let origin = match public_url.filter(|u| !u.trim().is_empty()) {
        Some(raw) => tunnel_config::normalize_origin(&raw, false)?,
        None => tunnel_state()
            .lock()
            .tunnel_url
            .clone()
            .ok_or_else(|| "No public address yet. Start the tunnel first.".to_string())?,
    };
    test_origin(&origin)
}

/// `GET <origin>/bridge/health` and what it says.
fn test_origin(origin: &str) -> Result<ConnectionTest, String> {
    let url = tunnel_config::health_url(origin);
    let started = std::time::Instant::now();
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let result = agent.get(&url).call();
    let latency = started.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().unwrap_or_default();
            interpret_health(&url, Some(status), &body, latency, None)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            interpret_health(&url, Some(code), &body, latency, None)
        }
        Err(err) => interpret_health(&url, None, "", latency, Some(&err.to_string())),
    })
}

/// The folders an installed copy and a dev run may keep the bundled files in (see `mcp_runtime::installed_resource`:
/// the installer keeps the `resources/` folder name, so `<resource dir>/pwa-dist` is not where an MSI puts it).
fn resource_bases(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from));
    (app.path().resource_dir().ok(), exe_dir)
}

fn resolve_pwa_dist_root(app: &AppHandle) -> Result<PathBuf, String> {
    let (resource_dir, exe_dir) = resource_bases(app);
    pwa_dist_root(resource_dir.as_deref(), exe_dir.as_deref(), &PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn pwa_dist_root(resource_dir: Option<&Path>, exe_dir: Option<&Path>, manifest_dir: &Path) -> Result<PathBuf, String> {
    if let Some(path) = crate::mcp_runtime::installed_resource_dir(resource_dir, exe_dir, "pwa-dist") {
        return Ok(path);
    }
    let dev = manifest_dir.join("../dist");
    if dev.is_dir() {
        return Ok(dev);
    }
    Err("PWA dist not found — rebuild with stage-pwa-dist".into())
}

fn resolve_cloudflared_bin(app: &AppHandle) -> Result<PathBuf, String> {
    let (resource_dir, exe_dir) = resource_bases(app);
    cloudflared_bin(resource_dir.as_deref(), exe_dir.as_deref(), std::env::var("CLOUDFLARED_BIN").ok().as_deref())
}

fn cloudflared_bin(resource_dir: Option<&Path>, exe_dir: Option<&Path>, from_env: Option<&str>) -> Result<PathBuf, String> {
    // The one tools resolver first: the install folder, or the staged copy after an app-only update.
    if let Some(path) = exe_dir.and_then(crate::tools_home::resolve_for_exe_dir).map(|home| home.cloudflared_bin()).filter(|p| p.is_file()) {
        return Ok(path);
    }
    let bundled_name = if cfg!(target_os = "windows") { "bin/cloudflared.exe" } else { "bin/cloudflared" };
    if let Some(path) = crate::mcp_runtime::installed_resource(resource_dir, exe_dir, bundled_name) {
        return Ok(path);
    }
    if let Some(from_env) = from_env {
        let path = PathBuf::from(from_env);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("bundled cloudflared not found — run bundle-cloudflared during build".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_the_fixed_address_off_and_on_starts_it_again_without_a_restart() {
        use SettingsAction::{Nothing, Start, Stop};
        // Running, switch goes off: stop.
        assert_eq!(settings_action(false, true, true, "open_tunnel", Phase::Running, true), Stop);
        // Off already and stopped: nothing to do on later settings changes.
        assert_eq!(settings_action(false, true, false, "open_tunnel", Phase::Stopped, true), Nothing);
        // Switch back on: the saved choice is the fixed address and it is stopped, so start it.
        assert_eq!(settings_action(true, true, false, "open_tunnel", Phase::Stopped, true), Start);
        // While off, the saved choice ran as the automatic address; on again must start the fixed one.
        assert_eq!(settings_action(true, true, false, "quick", Phase::Running, true), Start);
        // Already starting, running or failed as the fixed address: later settings changes leave it alone.
        for phase in [Phase::Starting, Phase::Running, Phase::Error] {
            assert_eq!(settings_action(true, true, true, "open_tunnel", phase, true), Nothing);
        }
        // Not chosen, or no phone server (dev build): never start.
        assert_eq!(settings_action(true, false, false, "quick", Phase::Running, true), Nothing);
        assert_eq!(settings_action(true, true, false, "open_tunnel", Phase::Stopped, false), Nothing);
    }

    #[test]
    fn custom_public_url_strips_bridge_suffix() {
        std::env::set_var("POTATO_WORKSPACE_PUBLIC_URL", "https://example.com/bridge/");
        assert_eq!(custom_public_url().as_deref(), Some("https://example.com"));
        std::env::remove_var("POTATO_WORKSPACE_PUBLIC_URL");
    }

    fn stable_input(secret: Option<&str>, action: tunnel_config::SecretAction) -> TunnelConfigInput {
        TunnelConfigInput::Stable { worker_url: "https://w.dev".into(), secret: secret.map(Into::into), secret_action: action }
    }

    fn stable_cfg(secret: &str) -> tunnel_config::TunnelConfig {
        tunnel_config::TunnelConfig::Stable { worker_url: "https://w.dev".into(), secret: secret.into() }
    }

    #[test]
    fn the_secret_goes_back_to_the_ui_only_when_made_or_asked_for() {
        use tunnel_config::SecretAction::{Keep, Regenerate, Show};
        use tunnel_config::TunnelConfig::Quick;
        let old = stable_cfg("old-secret-0123456789");
        let new = stable_cfg("new-secret-0123456789");
        // first time: made now
        assert_eq!(secret_to_reveal(&stable_input(None, Keep), &Quick, &new).as_deref(), Some("new-secret-0123456789"));
        // kept: nothing to show
        assert_eq!(secret_to_reveal(&stable_input(None, Keep), &old, &old), None);
        // asked
        assert_eq!(secret_to_reveal(&stable_input(None, Show), &old, &old).as_deref(), Some("old-secret-0123456789"));
        // regenerated
        assert_eq!(secret_to_reveal(&stable_input(None, Regenerate), &old, &new).as_deref(), Some("new-secret-0123456789"));
        // a secret the person typed is not echoed back
        assert_eq!(secret_to_reveal(&stable_input(Some("new-secret-0123456789"), Keep), &old, &new), None);
        // other modes never reveal
        assert_eq!(secret_to_reveal(&TunnelConfigInput::Quick, &old, &Quick), None);
        assert!(replaces_secret(&old, &new) && !replaces_secret(&old, &old) && !replaces_secret(&Quick, &new));
    }

    #[test]
    fn a_revealed_secret_is_redacted_in_debug_but_serializes_for_the_ui() {
        let secret = RevealedSecret("super-secret-value-0123".into());
        assert!(!format!("{secret:?}").contains("super-secret"));
        assert_eq!(serde_json::to_string(&secret).unwrap(), "\"super-secret-value-0123\"");
    }

    #[test]
    fn stable_status_says_waiting_linking_linked_or_why_not() {
        let mut info = StableInfo { worker_url: "https://w.dev".into(), quick_url: None, link: LinkState::Waiting };
        assert_eq!(info.view().link, "waiting");
        info.link = LinkState::Registering;
        assert_eq!(info.view().link, "linking");
        info.link = LinkState::Linked;
        assert_eq!((info.view().link, info.view().error), ("linked", None));
        info.link = LinkState::Failed("The secret does not match the one the Worker has.".into());
        let view = info.view();
        assert_eq!(view.link, "failed");
        assert!(view.error.unwrap().contains("secret does not match"));
    }

    #[test]
    fn test_connection_in_stable_mode_checks_the_worker_before_the_bridge() {
        // A loopback "Worker" that says it is not linked: the answer names the Worker, not the bridge.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = s.read(&mut buf).unwrap();
            let body = r#"{"linked":false,"updated_at":null}"#;
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        {
            let state = tunnel_state();
            let mut guard = state.lock();
            guard.stable = Some(StableInfo { worker_url: url.clone(), quick_url: None, link: LinkState::Waiting });
        }
        let result = test_connection(None).unwrap();
        tunnel_state().lock().stable = None;
        assert!(!result.ok, "{result:?}");
        assert!(result.message.contains("not linked"), "{result:?}");
        assert!(result.url.ends_with("/_pm/link/health"));
        assert!(server.join().unwrap().starts_with("GET /_pm/link/health "));
    }

    #[test]
    fn health_interpretation() {
        let u = "https://pm.example.com/bridge/health";
        assert!(interpret_health(u, Some(200), r#"{"ok":true,"version":"1"}"#, 40, None).ok);
        assert!(!interpret_health(u, Some(200), "<html>hi</html>", 40, None).ok);
        let down = interpret_health(u, Some(530), "", 40, None);
        assert!(!down.ok && down.message.contains("tunnel"));
        assert!(!interpret_health(u, None, "", 5, Some("dns error")).ok);
        assert!(interpret_health(u, Some(404), "", 5, None).message.contains("404"));
    }

    #[test]
    fn test_connection_hits_a_live_health_endpoint() {
        // A tiny loopback server standing in for `<public>/bridge/health`.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = s.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = r#"{"ok":true}"#;
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            request
        });
        let result = test_connection(Some(format!("http://127.0.0.1:{port}"))).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(server.join().unwrap().starts_with("GET /bridge/health "));
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-tunnel-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_installed_copy_finds_pwa_dist_under_the_resources_folder() {
        let install = scratch("pwa");
        std::fs::create_dir_all(install.join("resources/pwa-dist/assets")).unwrap();
        let nowhere = install.join("no-such-manifest");
        assert_eq!(pwa_dist_root(Some(&install), Some(&install), &nowhere), Ok(install.join("resources/pwa-dist")));
        assert!(pwa_dist_root(None, None, &nowhere).is_err());
        std::fs::remove_dir_all(&install).ok();
    }

    #[test]
    fn an_installed_copy_finds_cloudflared_under_the_resources_folder() {
        let install = scratch("cf");
        let name = if cfg!(target_os = "windows") { "cloudflared.exe" } else { "cloudflared" };
        std::fs::create_dir_all(install.join("resources/bin")).unwrap();
        std::fs::write(install.join("resources/bin").join(name), "x").unwrap();
        assert_eq!(cloudflared_bin(Some(&install), Some(&install), None), Ok(install.join("resources/bin").join(name)));
        assert!(cloudflared_bin(None, None, None).is_err());
        // The environment override still works when nothing is bundled.
        let own = install.join("mine.exe");
        std::fs::write(&own, "x").unwrap();
        assert_eq!(cloudflared_bin(None, None, own.to_str()), Ok(own.clone()));
        std::fs::remove_dir_all(&install).ok();
    }

    #[test]
    fn after_an_app_only_update_cloudflared_comes_from_the_staged_tools_folder() {
        let install = scratch("cf-staged");
        let local = install.join("local-tools");
        let staged = local.join("1");
        std::fs::create_dir_all(staged.join("bin")).unwrap();
        std::fs::write(staged.join("tools-manifest.json"), r#"{"toolsVersion":1}"#).unwrap();
        let name = if cfg!(target_os = "windows") { "cloudflared.exe" } else { "cloudflared" };
        std::fs::write(staged.join("bin").join(name), "x").unwrap();
        let manifest = crate::tools_home::ToolsManifest { tools_version: 1, node: String::new(), git: String::new(), cloudflared: String::new(), counts: Default::default(), files: Vec::new() };
        let found = crate::tools_home::with_test_home(manifest, Some(local), || cloudflared_bin(Some(&install), Some(&install), None));
        assert_eq!(found, Ok(staged.join("bin").join(name)));
        std::fs::remove_dir_all(&install).ok();
    }
}
