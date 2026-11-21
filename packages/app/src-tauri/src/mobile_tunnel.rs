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

pub(crate) mod limits;
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
    /// "My domain" + Address book: where this PC stands with the person's own Worker (separate from `stable`, which is the Permanent link).
    book: Option<BookInfo>,
    phase: Phase,
    last_error: Option<String>,
    /// Bumped on every (re)launch so a dead tunnel's log readers cannot overwrite the new state.
    generation: u64,
    /// Why the quick address is not coming (a `limits::PROBLEM_*` code the screen turns into words).
    problem: Option<&'static str>,
    /// Failed quick-tunnel starts and when cloudflared was last started: no tight restart loops.
    backoff: limits::Backoff,
    /// What the app is really doing right now, and since when (the screen shows it with a counter).
    step: Option<StepMark>,
    /// The last few real things that happened, oldest first (capped; closed codes only, so nothing secret can be in them).
    events: std::collections::VecDeque<EventView>,
}

/// How many events the Details list keeps.
const EVENT_CAP: usize = 8;

/// One thing that really happened. `code` is from a closed list (the screen has the words); `host` is only ever a bare host name
/// (a trycloudflare or workers.dev name), never a path, a query or a token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventView {
    pub at_ms: u64,
    /// phone_server_up | tunnel_started | tunnel_stopped | tunnel_off | address | relay_linked | relay_failed | outside_ok | outside_failed
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// Only a bare host name survives: scheme, path, query and anything that is not a host character are dropped.
fn clean_host(raw: &str) -> Option<String> {
    let rest = raw.split_once("://").map_or(raw, |(_, r)| r);
    let host: String = rest.split(['/', '?', '#', '@']).next().unwrap_or("").chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == ':').collect();
    (host.contains('.') && host.len() <= 100).then_some(host.to_ascii_lowercase())
}

/// One real step of bringing the phone address up (`TunnelStatus::step` carries it to the screen).
#[derive(Debug, Clone, Copy)]
struct StepMark {
    code: &'static str,
    since: std::time::Instant,
}

/// What the screen reads: the step code, how long it has lasted, and (while telling the relay) which try and when the next one is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepView {
    /// starting_phone_server | starting_tunnel | waiting_for_address | address_ready | registering | checking_outside | connected | not_reached
    pub code: &'static str,
    pub elapsed_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_in_secs: Option<u64>,
}

/// Pure so the counter rules are a unit test.
fn step_view(mark: StepMark, now: std::time::Instant, tries: u32, next_try: Option<std::time::Instant>) -> StepView {
    let registering = mark.code == "registering";
    StepView {
        code: mark.code,
        elapsed_secs: now.saturating_duration_since(mark.since).as_secs(),
        retry: (registering && tries > 0).then_some(tries),
        next_in_secs: next_try.filter(|_| registering).map(|at| at.saturating_duration_since(now).as_secs().max(1)),
    }
}

/// The Address book registration: the name, the quick address that was (being) registered, and how it went.
struct BookInfo {
    domain: String,
    quick_url: String,
    link: LinkState,
    /// Set to make a Linked loop tell the Worker again now (a Check found it reset or holding an older address).
    nudge: Arc<std::sync::atomic::AtomicBool>,
}

/// What `start_book_if_needed` does for the registration that exists now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BookKick {
    /// Already telling the Worker (or it ended for good, and only a new choice or Check restarts it).
    Nothing,
    /// Linked for this name and address, but asked to tell the Worker again: wake the loop.
    Nudge,
    /// No registration for this name and address: start one.
    Spawn,
}

fn book_kick(book: Option<&BookInfo>, domain: &str, quick: &str, force: bool) -> BookKick {
    match book {
        Some(b) if b.domain == domain && b.quick_url == quick => {
            if b.running() {
                BookKick::Nothing
            } else if b.link == LinkState::Linked {
                if force { BookKick::Nudge } else { BookKick::Nothing }
            } else {
                BookKick::Spawn
            }
        }
        _ => BookKick::Spawn,
    }
}

impl BookInfo {
    /// Still telling the Worker (or waiting to try again). A final answer (linked, wrong key, not a Worker, gone) ends it.
    fn running(&self) -> bool {
        match &self.link {
            LinkState::Linked => false,
            LinkState::Failed(why) => !stable_link::reason_of(why).is_some_and(stable_link::reason_is_final),
            LinkState::Waiting | LinkState::Registering => true,
        }
    }
}

/// "My domain" + Address book as the screen shows it. `reason` is a short code the screen has words for:
/// secret_mismatch | worker_gone | over_quota | offline | worker_too_old (here: the name is not an Address book Worker).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BookStatus {
    pub domain: String,
    /// This PC runs a quick tunnel (Named, Custom and OpenTunnel have no quick address to register).
    pub supported: bool,
    /// A quick address exists to register.
    pub has_address: bool,
    /// The name has proven it is the Worker, so this PC may tell it where it is. False: nothing is sent to it yet.
    pub armed: bool,
    /// waiting | linking | linked | failed
    pub link: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

fn book_link_view(link: &LinkState) -> (&'static str, Option<&'static str>) {
    match link {
        LinkState::Waiting => ("waiting", None),
        LinkState::Registering => ("linking", None),
        LinkState::Linked => ("linked", None),
        // The name did not answer this time and the loop keeps trying: that is still linking, not a failure.
        LinkState::Failed(why) if stable_link::reason_of(why) == Some("offline") => ("linking", Some("offline")),
        LinkState::Failed(why) => ("failed", stable_link::reason_of(why)),
    }
}

/// The Details event for a change of the Address book link: `book_linked` once it is linked, `book_failed` (with the reason code,
/// `retry` when there is none) once per change of reason. Offline retries are linking, so they make no event.
fn book_event(old: &LinkState, new: &LinkState) -> Option<(&'static str, Option<&'static str>)> {
    match new {
        LinkState::Linked if !matches!(old, LinkState::Linked) => Some(("book_linked", None)),
        LinkState::Failed(_) => {
            let (view, reason) = book_link_view(new);
            if view != "failed" {
                return None;
            }
            let same = matches!(old, LinkState::Failed(_)) && book_link_view(old) == (view, reason);
            (!same).then_some(("book_failed", Some(reason.unwrap_or("retry"))))
        }
        _ => None,
    }
}

/// The relay's own events (`relay_linked`, `relay_failed`) belong to the Permanent link only: with "My domain" or the Temporary
/// link on, the relay is not what the person is using, so it must not speak in Details.
fn relay_events_on(choice: crate::worker_origins::LinkChoice) -> bool {
    choice == crate::worker_origins::LinkChoice::Permanent
}

struct StableInfo {
    worker_url: String,
    /// The trycloudflare address cloudflared printed last (never advertised to phones).
    quick_url: Option<String>,
    link: LinkState,
    /// Failed register tries so far, and when the next one is (for the step line).
    tries: u32,
    next_try: Option<std::time::Instant>,
}

/// `stable` mode as the Settings tab shows it: "Stable link: <worker> -> linked / not linked yet (<error>)".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StableStatus {
    pub worker_url: String,
    pub quick_url: Option<String>,
    /// waiting | linking | linked | failed
    pub link: &'static str,
    pub error: Option<String>,
    /// The Worker answered 403: it keeps another secret than the one saved here (the screen offers the way out).
    pub secret_mismatch: bool,
    /// Why the link failed, as a short code: secret_mismatch | worker_gone | over_quota | offline | worker_too_old.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

impl StableInfo {
    fn view(&self) -> StableStatus {
        let (link, error) = match &self.link {
            LinkState::Waiting => ("waiting", None),
            LinkState::Registering => ("linking", None),
            LinkState::Linked => ("linked", None),
            LinkState::Failed(why) => ("failed", Some(why.clone())),
        };
        let secret_mismatch = matches!(&self.link, LinkState::Failed(why) if Some(why) == stable_link::Outcome::SecretMismatch.problem().as_ref());
        let reason = match &self.link {
            LinkState::Failed(why) => stable_link::reason_of(why),
            _ => None,
        };
        StableStatus { worker_url: self.worker_url.clone(), quick_url: self.quick_url.clone(), link, error, secret_mismatch, reason }
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
    /// Set when "Make a new secret" was NOT done because the Worker could not forget the old one: a code
    /// (`rejected` | `too_old` | `unreachable`) the screen turns into words. Nothing was changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_not_reset: Option<String>,
    /// Why no quick address is coming: `rate_limited` | `slow_start` | `too_soon` (the screen has the words).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<&'static str>,
    /// What the app is doing right now (a real step with a counter), or none when nothing is in progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<StepView>,
    /// The last few real events with their time (the Details list).
    pub events: Vec<EventView>,
    /// With a `problem`: seconds until cloudflared may be started again (absent when it may start now).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_secs: Option<u64>,
    /// The port the phone server really listens on (what an own domain or a named tunnel must point at), or none when it is not running.
    pub local_port: Option<u16>,
    /// The port the person chose for the phone server (used from the next start), or none for automatic.
    pub chosen_port: Option<u16>,
    /// `moved` (the usual port was busy, another program has it) | `not_running` (the phone server could not start). Absent when all is well.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_problem: Option<&'static str>,
    /// The person chose "Temporary link": phones get the quick address and the Worker is left out (it stays saved and linked).
    pub link_temporary: bool,
    /// Which of the three links is on: `permanent` | `temporary` | `domain`.
    pub link_mode: &'static str,
    /// How the chosen link carries traffic: `book` (the address only says where this PC is) | `direct` (the address carries it).
    pub link_route: &'static str,
    /// The person's own address (https origin), kept saved while another link is on.
    pub own_domain: Option<String>,
    /// The own address passed a Check made by this app, so phones are given it. False: "Not checked yet".
    pub own_domain_verified: bool,
    /// "My domain" + Address book: where this PC stands with the Worker (absent for every other link).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book: Option<BookStatus>,
}

/// Result of "Test connection".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub url: String,
    pub http_status: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
    /// Own address Check only: why it did or did not reach this PC (see `own_domain::domain_reason`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
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
            book: None,
            phase: Phase::Stopped,
            last_error: None,
            generation: 0,
            problem: None,
            backoff: limits::Backoff::default(),
            step: None,
            events: std::collections::VecDeque::new(),
        }
    }

    /// Remember one real event for the Details list; the oldest falls off after `EVENT_CAP`.
    fn push_event(&mut self, code: &'static str, host: Option<&str>, reason: Option<&'static str>) {
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        if self.events.len() >= EVENT_CAP {
            self.events.pop_front();
        }
        self.events.push_back(EventView { at_ms, code, host: host.and_then(clean_host), reason });
    }

    /// Mark what is happening now. The same step again keeps its start time, so the counter does not jump back.
    fn set_step(&mut self, code: &'static str) {
        if self.step.is_some_and(|s| s.code == code) {
            return;
        }
        self.step = Some(StepMark { code, since: std::time::Instant::now() });
    }

    fn step_view(&self) -> Option<StepView> {
        let mark = self.step?;
        let (tries, next) = self.stable.as_ref().map_or((0, None), |s| (s.tries, s.next_try));
        Some(step_view(mark, std::time::Instant::now(), tries, next))
    }

    /// A quick tunnel did not come up: say why (the screen's words and the CLI's sentence) and count it for the back-off.
    fn start_failed(&mut self, generation: u64, problem: &'static str) {
        if problem == limits::PROBLEM_RATE_LIMITED {
            self.backoff.failed_rate_limited(generation);
        } else {
            self.backoff.failed(generation);
        }
        self.phase = Phase::Error;
        self.problem = Some(problem);
        self.last_error = Some(limits::problem_sentence(problem).into());
    }

    /// The start-up timeout fired: true when this launch is still on "starting" (and is now marked failed).
    fn start_overdue(&mut self, generation: u64) -> bool {
        if self.generation == generation && self.phase == Phase::Starting {
            self.start_failed(generation, limits::PROBLEM_SLOW_START);
            true
        } else {
            false
        }
    }

    /// An address came up: forget the problem and the failures.
    fn start_succeeded(&mut self) {
        self.backoff.succeeded();
        if self.problem.take().is_some() {
            self.last_error = None;
        }
    }

    /// This PC's quick-tunnel address right now, when it runs a quick tunnel at all (the Address book registers it).
    fn current_quick_url(&self) -> Option<String> {
        if !matches!(self.mode, "quick" | "stable") {
            return None;
        }
        let url = match &self.stable {
            Some(info) => info.quick_url.clone(),
            None => self.tunnel_url.clone(),
        };
        url.filter(|u| stable_link::is_quick_origin(u))
    }

    fn book_view(&self) -> Option<BookStatus> {
        let domain = crate::worker_origins::book_domain()?;
        let (link, reason) = self.book.as_ref().filter(|b| b.domain == domain).map_or(("waiting", None), |b| book_link_view(&b.link));
        Some(BookStatus { supported: matches!(self.mode, "quick" | "stable"), has_address: self.current_quick_url().is_some(), armed: crate::domain_book::is_armed(&domain), domain, link, reason })
    }

    /// The address other parts (the phone page, the CLI's pair link) may hand to a phone. A stable-link Worker is offered only
    /// once this computer is linked to it: before that the Worker has no idea where this computer is and answers "PC offline".
    fn advertised_url(&self) -> Option<String> {
        if let Some(domain) = crate::worker_origins::own_domain_active() {
            return Some(domain);
        }
        if let Some(info) = self.stable.as_ref().filter(|_| crate::worker_origins::link_temporary()) {
            return temporary_url(info.quick_url.as_deref());
        }
        advertised_url(self.tunnel_url.as_deref(), self.stable.as_ref().map(|s| &s.link))
    }

    fn dev_info_payload(&self) -> DevInfoPayload {
        // Empty while the phone server is not running: the page treats an empty address as "none".
        let local_url = local_phone_url().unwrap_or_default();
        let tunnel_url = self.advertised_url();
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

/// `tunnel_url` as phones may use it: with a stable link, only while linked (see `TunnelState::advertised_url`).
fn advertised_url(tunnel_url: Option<&str>, stable_link: Option<&LinkState>) -> Option<String> {
    match stable_link {
        Some(link) if *link != LinkState::Linked => None,
        _ => tunnel_url.map(str::to_string),
    }
}

/// "Temporary link": the plain quick address, used directly (no Worker in between). It changes on every restart, so a
/// phone paired through it must pair again after one. `None` until cloudflared has printed it.
fn temporary_url(quick_url: Option<&str>) -> Option<String> {
    quick_url.map(str::to_string)
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
        secret_not_reset: None,
        problem: guard.problem,
        step: guard.step_view(),
        events: guard.events.iter().cloned().collect(),
        retry_in_secs: guard
            .problem
            .and_then(|_| guard.backoff.check(std::time::Instant::now()).err())
            .map(|wait| wait.as_secs().max(1)),
        local_port: pwa_server::bound_pwa_port(),
        chosen_port: crate::phone_port::saved(),
        port_problem: pwa_server::pwa_port_problem(),
        link_temporary: crate::worker_origins::link_temporary(),
        link_mode: crate::worker_origins::link_mode().choice.as_str(),
        link_route: crate::worker_origins::link_mode().route.as_str(),
        own_domain: crate::worker_origins::link_mode().domain,
        own_domain_verified: crate::worker_origins::link_mode().proven_domain().is_some(),
        book: guard.book_view(),
    }
}

/// Choose permanent, temporary or the person's own domain (`domain` is typed text, validated here and kept saved). No restart: the
/// saved Worker and its link stay as they are. Returns the new status.
pub fn set_link_mode(choice: &str, domain: Option<String>, route: Option<&str>) -> Result<TunnelStatus, String> {
    let choice = crate::worker_origins::LinkChoice::parse(choice).ok_or_else(|| "Unknown link choice.".to_string())?;
    let route = crate::worker_origins::parse_route_arg(route)?;
    crate::worker_origins::set_link_mode(choice, domain, route)?;
    {
        // Chosen with a tunnel already up: tell the Worker now (no restart is needed), or stop telling it.
        let state = tunnel_state();
        let mut guard = state.lock();
        start_book_if_needed(&mut guard, &state, false);
    }
    Ok(tunnel_status())
}

/// What the Address book Check needs: this PC's quick address (none yet) and whether it runs a quick tunnel at all.
pub fn book_facts() -> (Option<String>, bool) {
    let state = tunnel_state();
    let guard = state.lock();
    (guard.current_quick_url(), matches!(guard.mode, "quick" | "stable"))
}

/// Tell the Worker again now (the Check just proved the name is the Worker, so it is armed): no restart is needed.
pub fn kick_book() {
    let state = tunnel_state();
    let mut guard = state.lock();
    start_book_if_needed(&mut guard, &state, true);
}

/// With "My domain" + Address book on, the name proven to be the Worker ("armed") and a quick address known, tell the Worker
/// (once per name and address; a final failure is tried again only when asked, i.e. when the link is chosen again or a Check
/// proves the name again). A name that has not proven itself is sent NOTHING, so a typo or a look-alike server never gets a key.
/// With the link off, forget it: the running loop stops itself.
fn start_book_if_needed(guard: &mut TunnelState, state: &Arc<Mutex<TunnelState>>, force: bool) {
    let Some(domain) = crate::worker_origins::book_domain() else {
        guard.book = None;
        return;
    };
    if !crate::domain_book::is_armed(&domain) {
        return;
    }
    let Some(quick) = guard.current_quick_url() else { return };
    match book_kick(guard.book.as_ref(), &domain, &quick, force) {
        BookKick::Nothing => return,
        BookKick::Nudge => {
            // Linked, but a Check just heard "not linked" / "stale" from the authentic Worker: tell it again now, not in two minutes.
            if let Some(b) = guard.book.as_ref() {
                b.nudge.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            return;
        }
        BookKick::Spawn => {}
    }
    // ONE key for this name only (derived from the PC's master key): it opens no other Worker.
    let key = match crate::domain_book::key_for(&domain) {
        Ok(key) => key,
        Err(err) => {
            tracing::warn!(%err, "domain book: could not keep the key for the Worker");
            guard.book = Some(BookInfo { domain, quick_url: quick, link: LinkState::Failed("The key for your Worker could not be kept on this PC.".into()), nudge: Arc::default() });
            return;
        }
    };
    let nudge = Arc::new(std::sync::atomic::AtomicBool::new(false));
    guard.book = Some(BookInfo { domain: domain.clone(), quick_url: quick.clone(), link: LinkState::Registering, nudge: nudge.clone() });
    tracing::info!("cloudflared quick URL ready; registering it with the Address book Worker");
    spawn_book_registration(state.clone(), guard.generation, domain, key, quick, nudge);
}

/// One try: the name must make its proof again (it may have moved since the Check), and only then does it get the key.
fn book_attempt(domain: &str, key: &str, key_hash: &str, quick: &str) -> stable_link::Outcome {
    use crate::domain_book::Auth;
    match crate::domain_book::authenticate(domain, key_hash) {
        Auth::Yes => stable_link::register_once_public(domain, key, quick),
        Auth::Foreign => {
            // Not that Worker any more: nothing is sent, the earlier pass is withdrawn and the name must prove itself again.
            let _ = crate::domain_book::disarm(domain);
            // Only an Address book pass: a Direct pass for the same name (Use Direct) is not this loop's to withdraw.
            let _ = crate::worker_origins::unmark_verified_for_route(domain, crate::worker_origins::LinkRoute::Book);
            foreign_outcome(crate::domain_book::is_direct(domain))
        }
        Auth::Down => stable_link::Outcome::Retry(format!("{}: the name did not answer", stable_link::OFFLINE_PREFIX)),
    }
}

/// What a name that is not the Worker any more is: this very PC behind a plain proxy (Direct), or just not the Worker.
fn foreign_outcome(is_direct: bool) -> stable_link::Outcome {
    if is_direct { stable_link::Outcome::NameIsDirect } else { stable_link::Outcome::WorkerTooOld }
}

/// How often a registered Worker is looked at again (is it still pointing at this PC?).
const BOOK_RECHECK: std::time::Duration = std::time::Duration::from_secs(120);

/// Like `spawn_registration`, for the person's own name: public addresses only, it stops when the link is switched off, and once
/// linked it keeps looking: a Worker that was reset or taken over by another address is noticed, the pass withdrawn, and this PC tells it again.
fn spawn_book_registration(state: Arc<Mutex<TunnelState>>, generation: u64, domain: String, key: String, quick: String, nudge: Arc<std::sync::atomic::AtomicBool>) {
    let same = {
        let (domain, quick) = (domain.clone(), quick.clone());
        move |guard: &TunnelState| guard.generation == generation && guard.book.as_ref().is_some_and(|b| b.domain == domain && b.quick_url == quick)
    };
    let is_current = {
        let (state, same, domain) = (state.clone(), same.clone(), domain.clone());
        move || same(&state.lock()) && crate::worker_origins::book_domain().as_deref() == Some(domain.as_str())
    };
    let mut report = {
        let (state, same, domain) = (state.clone(), same, domain.clone());
        move |link: LinkState| {
            let mut guard = state.lock();
            if !same(&guard) {
                return;
            }
            let event = guard.book.as_ref().and_then(|b| book_event(&b.link, &link));
            if let LinkState::Failed(_) = &link {
                let reason = book_link_view(&link).1;
                let changed = guard.book.as_ref().is_some_and(|b| book_link_view(&b.link).1 != reason || !matches!(b.link, LinkState::Failed(_)));
                if changed {
                    tracing::warn!(reason = reason.unwrap_or("retrying"), "domain book: not registered yet");
                }
            }
            if let Some(book) = guard.book.as_mut() {
                book.link = link;
            }
            if let Some((code, why)) = event {
                // The name goes in (clean_host reduces it to a bare host): the Details row says which address this is about.
                guard.push_event(code, Some(&domain), why);
            }
        }
    };
    let spawned = thread::Builder::new().name("domain-book-register".into()).spawn(move || {
        let key_hash = crate::domain_book::sha256_hex(&key);
        // The Worker was reset or re-pointed and the pass withdrawn: once this PC has told it again, the full Check runs and sets the pass back.
        // Every later round of this loop follows a ReRegister.
        let mut first_link = true;
        loop {
            let outcome = stable_link::register_until_done(|| book_attempt(&domain, &key, &key_hash, &quick), thread::sleep, &is_current, &mut report);
            // The last word goes to app.log: no key, no name, no address.
            match stable_link::final_log_line(&outcome) {
                Some((true, _)) => tracing::info!("domain book: registered with the Worker"),
                Some((false, line)) => tracing::warn!("domain book: {}", line.trim_start_matches("stable link: ")),
                None => {}
            }
            if outcome != stable_link::Outcome::Linked {
                return;
            }
            let relinked = !std::mem::replace(&mut first_link, false);
            if relinked && is_current() {
                let passed = crate::domain_book::restore_pass(
                    &|| crate::domain_book::check_armed(&domain, Some(quick.clone()), true, &crate::bridge::identity::own_domain_proof, &|| {}),
                    &|| crate::worker_origins::mark_verified(&domain, crate::worker_origins::LinkRoute::Book),
                );
                tracing::info!(passed, "domain book: checked again after telling the Worker again");
            }
            // Linked: keep looking, so a Worker that was reset or pointed elsewhere is not trusted for ever.
            nudge.store(false, std::sync::atomic::Ordering::SeqCst);
            'watch: loop {
                let mut waited = std::time::Duration::ZERO;
                while waited < BOOK_RECHECK {
                    if !is_current() {
                        return;
                    }
                    // A Check heard "not linked" / "stale" from the authentic Worker: tell it again at once.
                    if nudge.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        tracing::info!("domain book: asked to tell the Worker again now");
                        break 'watch;
                    }
                    thread::sleep(std::time::Duration::from_secs(1));
                    waited += std::time::Duration::from_secs(1);
                }
                if !is_current() {
                    return;
                }
                let (judged, authentic) = crate::domain_book::probe(&domain, &quick, &key_hash);
                match crate::domain_book::monitor_decision(&judged, authentic) {
                    crate::domain_book::Monitor::Fine | crate::domain_book::Monitor::Ignore => {}
                    crate::domain_book::Monitor::ReRegister => {
                        tracing::warn!("domain book: the Worker no longer points at this PC; telling it again");
                        // The probe took seconds: only withdraw an Address book pass, and only if this loop is still the current one.
                        if is_current() {
                            let _ = crate::worker_origins::unmark_verified_for_route(&domain, crate::worker_origins::LinkRoute::Book);
                        }
                        break 'watch;
                    }
                    crate::domain_book::Monitor::Foreign => {
                        tracing::warn!("domain book: the name no longer answers as the Worker; stopped");
                        if !is_current() {
                            return;
                        }
                        let _ = crate::worker_origins::unmark_verified_for_route(&domain, crate::worker_origins::LinkRoute::Book);
                        let _ = crate::domain_book::disarm(&domain);
                        let outcome = foreign_outcome(crate::domain_book::is_direct(&domain));
                        report(LinkState::Failed(outcome.problem().unwrap_or_default()));
                        return;
                    }
                }
            }
        }
    });
    if let Err(err) = spawned {
        tracing::warn!(%err, "could not start the Address book registration thread");
    }
}

/// "Permanent link" (false) or "Temporary link" (true). Takes effect on the next address a phone asks for: no restart, and the
/// saved Worker and its link stay as they are. Returns the new status.
pub fn set_link_temporary(on: bool) -> Result<TunnelStatus, String> {
    crate::worker_origins::set_link_temporary(on)?;
    Ok(tunnel_status())
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
    state.lock().set_step("starting_phone_server");
    let pwa_server = match pwa_server::start_pwa_server(dist_root, bridge_port_file, dev_info_supplier) {
        Ok(handle) => handle,
        Err(err) => {
            state.lock().step = None;
            return Err(err);
        }
    };
    {
        let mut guard = state.lock();
        guard.pwa_server = Some(pwa_server);
        guard.step = None;
        guard.push_event("phone_server_up", None, None);
    }

    // A second app on this computer (`POTATO_WORKSPACE_PROFILE`) opens no public address unless asked.
    if tunnel_off_for_profile(crate::app_paths::profile().is_some(), std::env::var("POTATO_WORKSPACE_TUNNEL").ok().as_deref()) {
        tracing::info!("profile: public tunnel off (set POTATO_WORKSPACE_TUNNEL=1 to open one)");
        // The screen says so instead of waiting for a step that never comes.
        {
            let mut guard = state.lock();
            guard.set_step("tunnel_off");
            guard.push_event("tunnel_off", None, None);
        }
        return Ok(());
    }

    launch_tunnel(app)
}

/// A second profile opens no public address unless `POTATO_WORKSPACE_TUNNEL=1`.
fn tunnel_off_for_profile(has_profile: bool, env: Option<&str>) -> bool {
    has_profile && env != Some("1")
}

/// Stop the current tunnel process (if any) and start whatever the saved setting asks for.
/// The loopback PWA server keeps running; only the public side changes.
pub fn restart_mobile_tunnel(app: &AppHandle) -> Result<TunnelStatus, String> {
    restart_mobile_tunnel_with(app, false)
}

/// `try_anyway`: the person pressed "Try anyway" after a refused restart. The wait is skipped once, unless the
/// failure was Cloudflare's own limit.
pub fn restart_mobile_tunnel_with(app: &AppHandle, try_anyway: bool) -> Result<TunnelStatus, String> {
    if !is_tunnel_enabled() {
        return Err("The mobile tunnel is turned off (POTATO_WORKSPACE_TUNNEL=0).".into());
    }
    if tunnel_state().lock().pwa_server.is_none() {
        return Err("The tunnel only runs in the installed app, not in a dev build.".into());
    }
    if try_anyway {
        tunnel_state().lock().backoff.skip_wait();
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
    let memory = tunnel_config::memory_file(&path);
    // Coming back to the same Worker from another mode: its remembered secret, not a new one that would not match.
    let basis = tunnel_config::basis_with_memory(&input, &current, &memory);
    let next = tunnel_config::config_from_input(input.clone(), &basis)?;
    let reveal = secret_to_reveal(&input, &basis, &next);
    // A new secret replaces the old one: ask the Worker to forget the old one first.
    if let Err(why) = retire_old_secret(&input, &current, &next, stable_link::reset) {
        // "Make a new secret" would strand the link: change nothing and say so.
        tracing::warn!("new secret not made: the Worker could not forget the old one");
        let mut status = tunnel_status();
        status.secret_not_reset = Some(why.into());
        return Ok(status);
    }
    tunnel_config::save(&path, &next)?;
    let origins = crate::worker_origins::origins_file(&path);
    if matches!(input, TunnelConfigInput::ForgetWorker) {
        tunnel_config::forget_stable(&memory);
        crate::worker_origins::forget(&origins);
    } else {
        tunnel_config::remember_stable(&memory, &next);
        // A new address (a domain of their own, or back to workers.dev) is trusted next to the earlier ones.
        if let tunnel_config::TunnelConfig::Stable { worker_url, .. } = &next {
            crate::worker_origins::remember(&origins, worker_url);
        }
    }
    crate::worker_origins::invalidate();
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
        // A quick address that failed to start is not asked for again at once: Cloudflare counts every ask.
        if plan.runs_cloudflared() && !matches!(plan, tunnel_config::TunnelPlan::Named { .. }) {
            if let Err(wait) = guard.backoff.check(std::time::Instant::now()) {
                if guard.problem != Some(limits::PROBLEM_RATE_LIMITED) {
                    guard.problem = Some(limits::PROBLEM_TOO_SOON);
                    guard.last_error = Some(limits::problem_sentence(limits::PROBLEM_TOO_SOON).into());
                }
                tracing::warn!(wait_secs = wait.as_secs(), "not starting cloudflared again yet (back-off after a failed start)");
                return Ok(());
            }
            guard.backoff.started(std::time::Instant::now());
        }
        guard.kill_child();
        guard.generation += 1;
        guard.step = None;
        guard.problem = None;
        guard.mode = plan.mode();
        guard.tunnel_url = plan.known_public_url();
        guard.last_error = None;
        guard.stable = match &plan {
            tunnel_config::TunnelPlan::Stable { worker_url } => {
                Some(StableInfo { worker_url: worker_url.clone(), quick_url: None, link: LinkState::Waiting, tries: 0, next_try: None })
            }
            _ => None,
        };
        guard.book = None;
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
            guard.set_step("starting_tunnel");
        } else {
            guard.phase = Phase::Running;
            guard.set_step("connected");
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

    // The tunnel program dies with the app, even when the app crashes or is killed (it used to stay behind).
    crate::pty::term_job::adopt(child.id());
    {
        let mut guard = state.lock();
        guard.cloudflared_child = Some(child);
        if guard.generation == generation {
            guard.set_step("waiting_for_address");
            guard.push_event("tunnel_started", None, None);
        }
    }
    tracing::info!(mode = plan.mode(), target = %local_target, "started cloudflared for the mobile PWA");
    if !named {
        // Never sit on "starting" silently: if no address comes in time, say so (it may still come; then this clears).
        let watched = state.clone();
        let _ = thread::Builder::new().name("tunnel-start-watch".into()).spawn(move || {
            thread::sleep(limits::START_TIMEOUT);
            if watched.lock().start_overdue(generation) {
                tracing::warn!("cloudflared gave no quick address within the start-up time");
            }
        });
    }
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
        // Only while the tunnel is still coming up: a later line must never take down a healthy tunnel.
        if !named && guard.phase == Phase::Starting && limits::is_rate_limited(&line) {
            // Cloudflare refused a new quick address. Stop cloudflared (it would keep asking) and say why.
            guard.start_failed(generation, limits::PROBLEM_RATE_LIMITED);
            guard.kill_child();
            tracing::warn!("Cloudflare is limiting new quick addresses from this network (HTTP 429 / error 1015)");
            continue;
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
                    guard.start_succeeded();
                    guard.set_step("address_ready");
                    guard.push_event("address", Some(&url), None);
                    tracing::info!("cloudflared quick URL ready; registering it with the stable-link Worker");
                    spawn_registration(state.clone(), generation, ctx.clone(), url.clone());
                    start_book_if_needed(&mut guard, &state, false);
                    if crate::worker_origins::link_temporary() {
                        spawn_outside_check(state.clone(), generation, url);
                    }
                }
            } else if guard.tunnel_url.as_deref() != Some(url.as_str()) {
                guard.tunnel_url = Some(url.clone());
                guard.phase = Phase::Running;
                guard.start_succeeded();
                guard.set_step("address_ready");
                guard.push_event("address", Some(&url), None);
                tracing::info!(%url, "cloudflared public URL ready");
                start_book_if_needed(&mut guard, &state, false);
                spawn_outside_check(state.clone(), generation, url);
            }
        }
    }
    // Stream closed: cloudflared exited. A restart bumps the generation first, so this is a crash.
    let mut guard = state.lock();
    if guard.generation == generation && guard.phase != Phase::Error {
        if guard.phase == Phase::Starting && !named {
            guard.backoff.failed(generation);
        }
        guard.phase = Phase::Error;
        guard.step = None;
        guard.push_event("tunnel_stopped", None, None);
        guard.last_error = Some("cloudflared stopped. Press Restart tunnel.".into());
    }
}

/// Open the new quick address from this computer, like a phone would: "checking it works from outside". The first tries often
/// fail while the new name is still spreading, so it tries for up to 40 s. It only moves the step line; it never changes the
/// tunnel's state. Stops when a newer launch replaced this one.
fn spawn_outside_check(state: Arc<Mutex<TunnelState>>, generation: u64, url: String) {
    let _ = thread::Builder::new().name("tunnel-outside-check".into()).spawn(move || {
        let started = std::time::Instant::now();
        let current = |guard: &TunnelState| guard.generation == generation && guard.phase == Phase::Running;
        {
            let mut guard = state.lock();
            if !current(&guard) {
                return;
            }
            guard.set_step("checking_outside");
        }
        loop {
            let reached = test_origin(&url).map(|r| r.ok).unwrap_or(false);
            let mut guard = state.lock();
            if !current(&guard) {
                return;
            }
            if reached {
                guard.set_step("connected");
                guard.push_event("outside_ok", None, None);
                return;
            }
            if started.elapsed() > std::time::Duration::from_secs(40) {
                guard.set_step("not_reached");
                guard.push_event("outside_failed", None, None);
                tracing::warn!("the new address was not reachable from this computer within 40 s");
                return;
            }
            drop(guard);
            thread::sleep(std::time::Duration::from_secs(3));
        }
    });
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
            let choice = crate::worker_origins::link_mode().choice;
            let temporary = choice == crate::worker_origins::LinkChoice::Temporary;
            let Some(info) = guard.stable.as_mut().filter(|s| s.quick_url.as_deref() == Some(quick_url.as_str())) else { return };
            let reason = match &link {
                LinkState::Failed(why) => stable_link::reason_of(why),
                _ => None,
            };
            let mut event: Option<(&'static str, Option<&'static str>)> = None;
            if let LinkState::Failed(_) = &link {
                // One line per change of reason, so app.log names why without a line per retry.
                let changed = !matches!(&info.link, LinkState::Failed(old) if stable_link::reason_of(old) == reason);
                if changed {
                    tracing::warn!(reason = reason.unwrap_or("retrying"), "stable link: not registered yet");
                    event = Some(("relay_failed", Some(reason.unwrap_or("retry"))));
                }
            }
            let step = match &link {
                LinkState::Registering => Some("registering"),
                LinkState::Linked => Some("connected"),
                LinkState::Failed(_) if reason.is_some_and(stable_link::reason_is_final) => None,
                LinkState::Failed(_) => Some("registering"),
                LinkState::Waiting => None,
            };
            let linked_now = matches!(link, LinkState::Linked) && !matches!(info.link, LinkState::Linked);
            if matches!(link, LinkState::Linked) {
                info.tries = 0;
                info.next_try = None;
            }
            info.link = link;
            if linked_now {
                event = Some(("relay_linked", None));
            }
            if let Some((code, why)) = event.filter(|_| relay_events_on(choice)) {
                guard.push_event(code, None, why);
            }
            // With the temporary link the relay is only a small note: it never drives the step line.
            if !temporary {
                match step {
                    Some(code) => guard.set_step(code),
                    None => guard.step = None,
                }
            }
        }
    };
    let on_wait = {
        let (state, quick_url) = (state.clone(), quick_url.clone());
        move |wait: std::time::Duration| {
            let mut guard = state.lock();
            if guard.generation != generation {
                return;
            }
            if let Some(info) = guard.stable.as_mut().filter(|s| s.quick_url.as_deref() == Some(quick_url.as_str())) {
                info.tries = info.tries.saturating_add(1);
                info.next_try = Some(std::time::Instant::now() + wait);
            }
        }
    };
    let spawned = thread::Builder::new().name("stable-link-register".into()).spawn(move || {
        let outcome = stable_link::register_until_done(
            || stable_link::register_once(&ctx.worker_url, &ctx.secret, &quick_url),
            move |wait| {
                on_wait(wait);
                thread::sleep(wait);
            },
            is_current,
            report,
        );
        // The last word goes to app.log: no secret, no address.
        match stable_link::final_log_line(&outcome) {
            Some((true, line)) => tracing::info!("{line}"),
            Some((false, line)) => tracing::warn!("{line}"),
            None => {}
        }
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

/// Before a new secret replaces the old one, ask the Worker to forget the old one.
/// Only "Make a new secret" is guarded: if the Worker cannot forget the old secret (it holds another one, or it is
/// not reachable) the answer is `Err(plain words)` and nothing may be saved, unless the person already confirmed.
/// A secret the person typed or pasted is the recovery path itself, so it is always best effort.
fn retire_old_secret(
    input: &TunnelConfigInput,
    before: &tunnel_config::TunnelConfig,
    after: &tunnel_config::TunnelConfig,
    mut reset: impl FnMut(&str, &str, &str) -> stable_link::ResetOutcome,
) -> Result<(), &'static str> {
    use stable_link::ResetOutcome;
    let (tunnel_config::TunnelConfig::Stable { worker_url, secret: old }, true) = (before, replaces_secret(before, after)) else {
        return Ok(());
    };
    let Some(new) = after.stable_secret() else { return Ok(()) };
    if old.is_empty() {
        return Ok(());
    }
    let TunnelConfigInput::Stable { secret, secret_action, confirm_strand, .. } = input else {
        let _ = reset(worker_url, old, new);
        return Ok(());
    };
    let typed = secret.as_deref().is_some_and(|s| !s.trim().is_empty());
    let regenerate = *secret_action == tunnel_config::SecretAction::Regenerate && !typed;
    let guarded = regenerate && !*confirm_strand;
    let mut outcome = reset(worker_url, old, new);
    // The answer may have been lost after the Worker took the new secret: ask once more with the NEW secret.
    // 200 means the first call had landed (the Worker holds the new secret); 403 means it still has the old one.
    if matches!(outcome, ResetOutcome::Rejected | ResetOutcome::Unreachable) && reset(worker_url, new, new) == ResetOutcome::Done {
        outcome = ResetOutcome::Done;
    }
    match outcome {
        ResetOutcome::Done => Ok(()),
        // The app cannot make this secret at all (too old) or must wait: never offered as "make it anyway".
        ResetOutcome::UpdateApp if regenerate => Err("update_app"),
        ResetOutcome::TooManyTries if regenerate => Err("too_many"),
        ResetOutcome::Rejected if guarded => Err("rejected"),
        ResetOutcome::TooOld if guarded => Err("too_old"),
        ResetOutcome::Unreachable if guarded => Err("unreachable"),
        _ => Ok(()),
    }
}

/// Whether saving `after` over `before` swaps one stable secret for another on the SAME Worker
/// (another address is another Worker: the old one is left alone).
fn replaces_secret(before: &tunnel_config::TunnelConfig, after: &tunnel_config::TunnelConfig) -> bool {
    match (before, after) {
        (tunnel_config::TunnelConfig::Stable { worker_url: a, secret: old }, tunnel_config::TunnelConfig::Stable { worker_url: b, secret: new }) => {
            a == b && !old.is_empty() && !new.is_empty() && old != new
        }
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
        reason: None,
    }
}

/// Fetch `<public>/bridge/health` (blocking). `None` tests the tunnel's current public URL.
pub fn test_connection(public_url: Option<String>) -> Result<ConnectionTest, String> {
    // Stable link: the Worker must answer and say it is linked before the bridge behind it is tried.
    // Temporary link: phones use the quick address and never the Worker, so the Worker is not what gets tested.
    if public_url.as_deref().is_none_or(|u| u.trim().is_empty()) && crate::worker_origins::link_temporary() {
        let quick = tunnel_state().lock().stable.as_ref().and_then(|s| s.quick_url.clone());
        if let Some(origin) = quick {
            return test_origin(&origin);
        }
    }
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
                reason: None,
            });
        }
        return test_through_worker(&worker, &|w| match stable_link::resolve_tunnel(w, &stable_link::is_quick_origin) {
            stable_link::Where::Tunnel(t) => Some(t),
            _ => None,
        }, &test_origin);
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

/// The Worker only points at this PC, so the bridge is tried where the Worker points: ask `/_pm/where`, then `<tunnel>/bridge/health`.
/// `resolve` and `probe` are passed in so the linked and not-pointing cases are unit tests.
fn test_through_worker(
    worker: &str,
    resolve: &dyn Fn(&str) -> Option<String>,
    probe: &dyn Fn(&str) -> Result<ConnectionTest, String>,
) -> Result<ConnectionTest, String> {
    let started = std::time::Instant::now();
    match resolve(worker) {
        Some(tunnel) => probe(&tunnel),
        None => Ok(ConnectionTest {
            ok: false,
            url: stable_link::where_url(worker),
            http_status: None,
            latency_ms: started.elapsed().as_millis() as u64,
            message: "The Worker is up, but it does not say where this computer is yet. Press Restart tunnel.".into(),
            reason: None,
        }),
    }
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
    fn the_status_names_the_phone_port_or_says_it_is_not_running() {
        // The phone server is not started in a unit test: no port, and the reason is given.
        let status = tunnel_status();
        assert_eq!(status.local_port, pwa_server::bound_pwa_port());
        assert_eq!(status.port_problem, pwa_server::pwa_port_problem());
        if status.local_port.is_none() {
            assert_eq!(status.port_problem, Some("not_running"));
        }
        let json = serde_json::to_value(&status).unwrap();
        assert!(json.get("local_port").is_some(), "the field is always sent: {json}");
    }

    #[test]
    fn a_stable_worker_is_offered_to_phones_only_once_linked() {
        let worker = Some("https://pm-relay.example.workers.dev");
        for link in [LinkState::Waiting, LinkState::Registering, LinkState::Failed("secret does not match".into())] {
            assert_eq!(advertised_url(worker, Some(&link)), None, "{link:?}");
        }
        assert_eq!(advertised_url(worker, Some(&LinkState::Linked)).as_deref(), worker);
        // No stable link: whatever address is known is offered, as before.
        assert_eq!(advertised_url(Some("https://x.trycloudflare.com"), None).as_deref(), Some("https://x.trycloudflare.com"));
        assert_eq!(advertised_url(None, None), None);
    }

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
    fn a_rate_limit_or_a_slow_start_is_a_named_problem_with_a_plain_sentence_and_counts_once() {
        let mut st = TunnelState::new();
        st.generation = 3;
        st.phase = Phase::Starting;
        st.start_failed(3, limits::PROBLEM_RATE_LIMITED);
        assert_eq!(st.phase, Phase::Error);
        assert_eq!(st.problem, Some("rate_limited"));
        assert!(st.last_error.as_deref().unwrap().starts_with("Cloudflare is limiting new quick addresses from this network."));
        // The start-up timer firing later in the same launch does not count a second failure.
        assert!(!st.start_overdue(3));
        assert_eq!(st.backoff.failures(), 1);
        // An address coming up clears it all.
        st.start_succeeded();
        assert_eq!((st.problem, st.last_error.clone(), st.backoff.failures()), (None, None, 0));
    }

    #[test]
    fn a_rate_limit_line_after_the_tunnel_is_up_does_not_touch_it() {
        let state = Arc::new(Mutex::new(TunnelState::new()));
        {
            let mut g = state.lock();
            g.generation = 1;
            g.phase = Phase::Running;
        }
        let output = "ERR request failed: 429 Too Many Requests\nerror code: 1015\n";
        watch_cloudflared_stream(BufReader::new(output.as_bytes()), state.clone(), 1, false, None);
        let g = state.lock();
        // The stream then closes (cloudflared "exited"): that is the only change, and no problem or failure was recorded.
        assert_eq!(g.problem, None);
        assert_eq!(g.backoff.failures(), 0);
    }

    #[test]
    fn the_start_up_timeout_only_marks_a_launch_that_is_still_starting() {
        let mut st = TunnelState::new();
        st.generation = 5;
        st.phase = Phase::Starting;
        assert!(!st.start_overdue(4)); // an older launch's timer
        assert!(st.start_overdue(5));
        assert_eq!(st.problem, Some("slow_start"));
        let mut running = TunnelState::new();
        running.generation = 5;
        running.phase = Phase::Running;
        assert!(!running.start_overdue(5));
        assert_eq!(running.problem, None);
    }

    #[test]
    fn a_rate_limit_line_in_cloudflared_output_stops_the_tunnel_with_the_message() {
        let state = Arc::new(Mutex::new(TunnelState::new()));
        {
            let mut g = state.lock();
            g.generation = 1;
            g.phase = Phase::Starting;
        }
        let output = "INF Requesting new quick Tunnel on trycloudflare.com...\nERR failed to request quick Tunnel: 429 Too Many Requests\n";
        watch_cloudflared_stream(BufReader::new(output.as_bytes()), state.clone(), 1, false, None);
        let g = state.lock();
        assert_eq!(g.phase, Phase::Error);
        assert_eq!(g.problem, Some("rate_limited"));
        assert_eq!(g.backoff.failures(), 1);
    }

    #[test]
    fn custom_public_url_strips_bridge_suffix() {
        std::env::set_var("POTATO_WORKSPACE_PUBLIC_URL", "https://example.com/bridge/");
        assert_eq!(custom_public_url().as_deref(), Some("https://example.com"));
        std::env::remove_var("POTATO_WORKSPACE_PUBLIC_URL");
    }

    fn stable_input(secret: Option<&str>, action: tunnel_config::SecretAction) -> TunnelConfigInput {
        TunnelConfigInput::Stable { worker_url: "https://w.dev".into(), secret: secret.map(Into::into), secret_action: action, confirm_strand: false }
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
        let mut info = StableInfo { worker_url: "https://w.dev".into(), quick_url: None, link: LinkState::Waiting, tries: 0, next_try: None };
        assert_eq!(info.view().link, "waiting");
        info.link = LinkState::Registering;
        assert_eq!(info.view().link, "linking");
        info.link = LinkState::Linked;
        assert_eq!((info.view().link, info.view().error), ("linked", None));
        info.link = LinkState::Failed(stable_link::Outcome::SecretMismatch.problem().unwrap());
        let view = info.view();
        assert_eq!(view.link, "failed");
        assert!(view.secret_mismatch);
        assert!(view.error.unwrap().contains("secret does not match"));
        assert_eq!(info.view().reason, Some("secret_mismatch"));
        info.link = LinkState::Failed("Could not reach the Worker: dns".into());
        assert!(!info.view().secret_mismatch);
        assert_eq!(info.view().reason, Some("offline"));
        info.link = LinkState::Failed(stable_link::Outcome::WorkerGone.problem().unwrap());
        assert_eq!(info.view().reason, Some("worker_gone"));
        info.link = LinkState::Failed(stable_link::Outcome::OverQuota.problem().unwrap());
        assert_eq!(info.view().reason, Some("over_quota"));
        info.link = LinkState::Linked;
        assert_eq!(info.view().reason, None);
    }

    #[test]
    fn the_step_line_counts_from_when_the_step_began_and_names_the_retry() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mark = StepMark { code: "waiting_for_address", since: t0 };
        let view = step_view(mark, t0 + Duration::from_secs(14), 3, Some(t0 + Duration::from_secs(20)));
        assert_eq!((view.code, view.elapsed_secs, view.retry, view.next_in_secs), ("waiting_for_address", 14, None, None));
        let reg = StepMark { code: "registering", since: t0 };
        let view = step_view(reg, t0 + Duration::from_secs(30), 3, Some(t0 + Duration::from_secs(38)));
        assert_eq!((view.retry, view.next_in_secs, view.elapsed_secs), (Some(3), Some(8), 30));
        // no failed try yet: no "retry 0"
        assert_eq!(step_view(reg, t0, 0, None).retry, None);
    }

    #[test]
    fn a_profile_without_the_switch_has_the_tunnel_off_and_says_so_in_the_status() {
        assert!(tunnel_off_for_profile(true, None) && tunnel_off_for_profile(true, Some("0")));
        assert!(!tunnel_off_for_profile(true, Some("1")) && !tunnel_off_for_profile(false, None));
        let mut st = TunnelState::new();
        st.set_step("tunnel_off");
        let v = serde_json::to_value(st.step_view().unwrap()).unwrap();
        assert_eq!(v["code"], "tunnel_off");
    }

    #[test]
    fn the_events_list_keeps_the_last_eight_and_only_ever_a_bare_host() {
        let mut st = TunnelState::new();
        for i in 0..12 {
            st.push_event("address", Some(&format!("https://abc-{i}.trycloudflare.com/bridge?token=SECRET-TOKEN-123")), None);
        }
        assert_eq!(st.events.len(), EVENT_CAP);
        assert_eq!(st.events.front().unwrap().host.as_deref(), Some("abc-4.trycloudflare.com"));
        st.push_event("relay_failed", None, Some("worker_gone"));
        st.push_event("address", Some("not a host SECRET-TOKEN-123"), None);
        st.push_event("address", Some("https://user:SECRET-TOKEN-123@evil"), None);
        let json = serde_json::to_string(&st.events.iter().cloned().collect::<Vec<_>>()).unwrap();
        assert!(!json.contains("SECRET") && !json.contains("token") && !json.contains("bridge"), "{json}");
        assert_eq!(st.events.len(), EVENT_CAP);
        assert_eq!(st.events.back().unwrap().host, None);
        assert_eq!(clean_host("https://x-1.trycloudflare.com/a?b=c").as_deref(), Some("x-1.trycloudflare.com"));
        assert_eq!(clean_host("nodots"), None);
    }

    #[test]
    fn the_same_step_twice_keeps_its_start_and_a_new_launch_clears_it() {
        let mut st = TunnelState::new();
        assert!(st.step_view().is_none());
        st.set_step("starting_tunnel");
        let first = st.step.unwrap().since;
        st.set_step("starting_tunnel");
        assert_eq!(st.step.unwrap().since, first);
        st.set_step("waiting_for_address");
        assert_eq!(st.step_view().unwrap().code, "waiting_for_address");
    }

    #[test]
    fn offline_retries_are_linking_and_only_a_real_reason_is_failed() {
        let offline = LinkState::Failed(format!("{}: dns error", stable_link::OFFLINE_PREFIX));
        assert_eq!(book_link_view(&offline), ("linking", Some("offline")));
        assert_eq!(book_link_view(&LinkState::Failed(stable_link::Outcome::SecretMismatch.problem().unwrap())), ("failed", Some("secret_mismatch")));
        assert_eq!(book_link_view(&LinkState::Failed(stable_link::Outcome::WorkerTooOld.problem().unwrap())), ("failed", Some("worker_too_old")));
        assert_eq!(book_link_view(&LinkState::Failed("The Worker answered HTTP 500.".into())), ("failed", None));
        // the status the screen reads says linking while the name is unreachable
        let info = BookInfo { domain: "https://phone.example.com".into(), quick_url: "https://a-b.trycloudflare.com".into(), link: offline, nudge: Arc::default() };
        assert!(info.running(), "an offline book keeps trying");
    }

    #[test]
    fn the_book_says_linked_once_and_failed_once_per_reason_and_never_for_offline() {
        let reg = LinkState::Registering;
        let linked = LinkState::Linked;
        let offline = LinkState::Failed(format!("{}: x", stable_link::OFFLINE_PREFIX));
        let gone = LinkState::Failed(stable_link::Outcome::WorkerGone.problem().unwrap());
        let mismatch = LinkState::Failed(stable_link::Outcome::SecretMismatch.problem().unwrap());
        let plain = LinkState::Failed("The Worker answered HTTP 500.".into());
        assert_eq!(book_event(&reg, &linked), Some(("book_linked", None)));
        assert_eq!(book_event(&offline, &linked), Some(("book_linked", None)));
        assert_eq!(book_event(&linked, &linked), None, "no event per repeat");
        assert_eq!(book_event(&reg, &offline), None, "offline is linking, not failed");
        assert_eq!(book_event(&offline, &offline), None);
        assert_eq!(book_event(&reg, &gone), Some(("book_failed", Some("worker_gone"))));
        assert_eq!(book_event(&gone, &gone), None, "one line per change of reason");
        assert_eq!(book_event(&gone, &mismatch), Some(("book_failed", Some("secret_mismatch"))));
        assert_eq!(book_event(&offline, &gone), Some(("book_failed", Some("worker_gone"))));
        assert_eq!(book_event(&reg, &plain), Some(("book_failed", Some("retry"))));
        assert_eq!(book_event(&linked, &reg), None);
    }

    #[test]
    fn book_events_land_in_the_details_list_with_a_bare_reason() {
        let mut st = TunnelState::new();
        st.push_event("book_failed", None, Some("worker_gone"));
        st.push_event("book_linked", None, None);
        let json = serde_json::to_value(st.events.iter().cloned().collect::<Vec<_>>()).unwrap();
        assert_eq!(json[0]["code"], "book_failed");
        assert_eq!(json[0]["reason"], "worker_gone");
        assert_eq!(json[1]["code"], "book_linked");
    }

    #[test]
    fn the_relays_own_events_belong_to_the_permanent_link_only() {
        use crate::worker_origins::LinkChoice;
        assert!(relay_events_on(LinkChoice::Permanent));
        assert!(!relay_events_on(LinkChoice::Domain));
        assert!(!relay_events_on(LinkChoice::Temporary));
    }

    #[test]
    fn a_dead_relay_does_not_touch_the_temporary_address_or_the_phase() {
        // The row's state in Temporary comes from the quick address and the phase, never from the relay's link.
        let mut st = TunnelState::new();
        st.phase = Phase::Running;
        st.stable = Some(StableInfo {
            worker_url: "https://w.dev".into(),
            quick_url: Some("https://a-b.trycloudflare.com".into()),
            link: LinkState::Failed(stable_link::Outcome::WorkerGone.problem().unwrap()),
            tries: 0,
            next_try: None,
        });
        assert_eq!(temporary_url(st.stable.as_ref().and_then(|s| s.quick_url.as_deref())), Some("https://a-b.trycloudflare.com".into()));
        assert_eq!(st.phase, Phase::Running);
        assert_eq!(st.stable.as_ref().unwrap().view().reason, Some("worker_gone"));
    }

    fn regen_input(typed: Option<&str>, action: tunnel_config::SecretAction, confirm: bool) -> TunnelConfigInput {
        TunnelConfigInput::Stable { worker_url: "https://w.dev".into(), secret: typed.map(Into::into), secret_action: action, confirm_strand: confirm }
    }

    #[test]
    fn a_new_secret_is_not_made_when_the_worker_cannot_forget_the_old_one_unless_confirmed() {
        use stable_link::ResetOutcome::*;
        let old = stable_cfg("old-secret-0123456789");
        let new = stable_cfg("new-secret-0123456789");
        let regen = tunnel_config::SecretAction::Regenerate;
        let ask = |input: &TunnelConfigInput, answer| {
            let mut calls = 0;
            let r = retire_old_secret(input, &old, &new, |_, _, _| { calls += 1; answer });
            (r, calls)
        };
        // A refused or lost rotate is asked once more (with the new secret), so two calls.
        // 403: warned in plain words, nothing saved.
        let (r, calls) = ask(&regen_input(None, regen, false), Rejected);
        assert_eq!(r.unwrap_err(), "rejected");
        assert_eq!(calls, 2);
        // The app is too old for the Worker, or it is rate limited: never "make it anyway", even when confirmed.
        assert_eq!(ask(&regen_input(None, regen, false), UpdateApp).0.unwrap_err(), "update_app");
        assert_eq!(ask(&regen_input(None, regen, true), UpdateApp).0.unwrap_err(), "update_app");
        assert_eq!(ask(&regen_input(None, regen, true), TooManyTries).0.unwrap_err(), "too_many");
        assert!(ask(&regen_input(Some("first-secret-0123456789"), tunnel_config::SecretAction::Keep, false), TooManyTries).0.is_ok());
        // Worker unreachable: warned too.
        assert_eq!(ask(&regen_input(None, regen, false), Unreachable).0.unwrap_err(), "unreachable");
        assert_eq!(ask(&regen_input(None, regen, false), TooOld).0.unwrap_err(), "too_old");
        // The Worker forgot it: go ahead.
        assert!(ask(&regen_input(None, regen, false), Done).0.is_ok());
        // Confirmed by the person: go ahead even though the reset failed.
        assert!(ask(&regen_input(None, regen, true), Rejected).0.is_ok());
        // A pasted secret is the recovery path: never blocked by a failed reset.
        let paste = regen_input(Some("first-secret-0123456789"), tunnel_config::SecretAction::Keep, false);
        assert!(ask(&paste, Rejected).0.is_ok());
        // The same secret again: nothing to retire.
        let same = retire_old_secret(&regen_input(None, regen, false), &old, &old, |_, _, _| panic!("no reset"));
        assert!(same.is_ok());
    }

    #[test]
    fn a_lost_answer_does_not_lock_the_person_out() {
        use stable_link::ResetOutcome::*;
        let old = stable_cfg("old-secret-0123456789");
        let new = stable_cfg("new-secret-0123456789");
        let input = regen_input(None, tunnel_config::SecretAction::Regenerate, false);
        // The Worker took the new secret but the answer was lost; the second call (new, new) proves it: save the new secret.
        let mut seen: Vec<(String, String)> = Vec::new();
        let r = retire_old_secret(&input, &old, &new, |_, from, to| {
            seen.push((from.into(), to.into()));
            if seen.len() == 1 { Unreachable } else { Done }
        });
        assert!(r.is_ok());
        assert_eq!(seen[1], ("new-secret-0123456789".to_string(), "new-secret-0123456789".to_string()));
        // The Worker still has the old secret (second call 403) and the first was never heard: held back, nothing saved.
        let mut n = 0;
        let r = retire_old_secret(&input, &old, &new, |_, _, _| { n += 1; if n == 1 { Unreachable } else { Rejected } });
        assert_eq!(r.unwrap_err(), "unreachable");
        // A clean first answer needs no second call.
        let r = retire_old_secret(&input, &old, &new, |_, _, _| Done);
        assert!(r.is_ok());
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
            guard.stable = Some(StableInfo { worker_url: url.clone(), quick_url: None, link: LinkState::Waiting, tries: 0, next_try: None });
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

#[cfg(test)]
mod link_choice_tests {
    use super::*;

    #[test]
    fn temporary_uses_the_quick_address_directly_and_nothing_before_it_exists() {
        assert_eq!(temporary_url(Some("https://a-b-c.trycloudflare.com")).as_deref(), Some("https://a-b-c.trycloudflare.com"));
        assert_eq!(temporary_url(None), None);
    }

    #[test]
    fn permanent_still_waits_for_the_link_and_gives_the_phone_the_tunnel_that_serves_the_worker_page() {
        // Unchanged rule: with a Worker, an address is offered only once linked.
        assert_eq!(advertised_url(Some("https://w.dev"), Some(&LinkState::Registering)), None);
        assert_eq!(advertised_url(Some("https://w.dev"), Some(&LinkState::Linked)).as_deref(), Some("https://w.dev"));
    }

    #[test]
    fn test_connection_through_a_linked_worker_probes_the_tunnel_it_names_not_the_worker() {
        let probed = std::cell::RefCell::new(Vec::new());
        let probe = |origin: &str| -> Result<ConnectionTest, String> {
            probed.borrow_mut().push(origin.to_string());
            Ok(ConnectionTest { ok: true, url: format!("{origin}/bridge/health"), http_status: Some(200), latency_ms: 3, message: "ok".into(), reason: None })
        };
        let out = test_through_worker("https://pm.me.workers.dev", &|_| Some("https://a-1.trycloudflare.com".into()), &probe).unwrap();
        assert!(out.ok && out.url == "https://a-1.trycloudflare.com/bridge/health");
        assert_eq!(*probed.borrow(), vec!["https://a-1.trycloudflare.com".to_string()], "the bridge is never asked on the Worker");
    }

    #[test]
    fn test_connection_says_so_when_the_worker_names_no_tunnel() {
        let probe = |_: &str| -> Result<ConnectionTest, String> { panic!("nothing to probe") };
        let out = test_through_worker("https://pm.me.workers.dev", &|_| None, &probe).unwrap();
        assert!(!out.ok && out.url == "https://pm.me.workers.dev/_pm/where" && out.message.contains("does not say where"));
    }

    #[test]
    fn a_book_that_became_a_direct_name_says_is_direct_not_worker_too_old() {
        assert_eq!(foreign_outcome(true), stable_link::Outcome::NameIsDirect);
        assert_eq!(foreign_outcome(false), stable_link::Outcome::WorkerTooOld);
        let direct = LinkState::Failed(foreign_outcome(true).problem().unwrap());
        assert_eq!(book_link_view(&direct), ("failed", Some("is_direct")));
        assert_eq!(book_event(&LinkState::Registering, &direct), Some(("book_failed", Some("is_direct"))));
        // final: the loop is not running, so nothing keeps asking the name
        let info = BookInfo { domain: "https://phone.example.com".into(), quick_url: "https://a-b.trycloudflare.com".into(), link: direct, nudge: Arc::default() };
        assert!(!info.running());
    }

    #[test]
    fn the_book_event_carries_the_bare_host_of_the_name() {
        let mut st = TunnelState::new();
        st.push_event("book_failed", Some("https://Phone.Example.com/path?x=SECRET-TOKEN-123"), Some("is_direct"));
        assert_eq!(st.events[0].host.as_deref(), Some("phone.example.com"));
        assert_eq!(st.events[0].reason, Some("is_direct"));
    }

    #[test]
    fn a_press_on_a_linked_book_wakes_the_loop_instead_of_doing_nothing() {
        let (d, q) = ("https://phone.example.com", "https://a-b.trycloudflare.com");
        let mk = |link| BookInfo { domain: d.into(), quick_url: q.into(), link, nudge: Arc::default() };
        let linked = mk(LinkState::Linked);
        assert_eq!(book_kick(Some(&linked), d, q, false), BookKick::Nothing, "the tunnel's own calls leave a linked book alone");
        assert_eq!(book_kick(Some(&linked), d, q, true), BookKick::Nudge, "a Check that heard not_linked or stale must re-register now");
        // still telling the Worker: nothing to add
        assert_eq!(book_kick(Some(&mk(LinkState::Registering)), d, q, true), BookKick::Nothing);
        // another address or name, nothing yet, or a final failure: start again
        assert_eq!(book_kick(Some(&linked), d, "https://c-d.trycloudflare.com", true), BookKick::Spawn);
        assert_eq!(book_kick(Some(&linked), "https://other.example.com", q, true), BookKick::Spawn);
        assert_eq!(book_kick(None, d, q, true), BookKick::Spawn);
        let failed = mk(LinkState::Failed(stable_link::Outcome::SecretMismatch.problem().unwrap()));
        assert_eq!(book_kick(Some(&failed), d, q, false), BookKick::Spawn);
    }
}
