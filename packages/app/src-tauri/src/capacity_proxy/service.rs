//! "Lend through my PC": profiles, requests, grants and the live parts (gates, links, shims), in one place.
//!
//! - **Lender:** `answer` makes a grant: a `Gate` (deadline, limits, counts), a `Forwarder` with the lender's own
//!   auth (a lend sign-in the app manages, or an API key from the OS credential store), and the lend endpoint.
//!   The grant item (lender node + link secret) goes to the asking device over the team relay. `revoke` ends the
//!   gate at once: open streams are cut, links closed, a revoke item is sent.
//! - **Borrower:** a grant item that matches an open request starts a `Shim` on 127.0.0.1. A pane started on the
//!   sign-in `lend:<grant id>` (`borrowed_launch_env`) talks to the shim. When the grant ends the shim stays and
//!   answers "This lend ended": a pane is never switched to another sign-in.
//!
//! Every message from another PC is untrusted: it is opened and checked in `wire`, then matched against what this
//! PC itself asked or granted.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::env::{hookup_env, set_home, write_home};
use super::forward::{AuthSource, Forwarder, InjectedAuth};
use super::frame::{SigninNote, UsageNote};
use super::gate::{EndReason, Gate, Limits};
use super::link::{node_from_hex, BorrowerGrant, ConnectError, LendNet, LenderBook, LenderGrant, LinkOpener, Probe, CLOSE_LEND_ENDED};
use super::ping::Pinger;
use super::shim::Shim;
use super::signin::SigninFile;
use super::spec::{ProxySpec, RefreshSpec};
use super::wire::{self, Body, Guard, Item, NodeHint, WireReject};
use crate::p2p::endpoint::{Link, NodeId};
use crate::secrets::SecretBackend;
use crate::secure_core::crypto::{b64, random_bytes, unb64};
use crate::team::secure::{CapacityIn, Payload, Session};
use crate::tui::LaunchEnv;

pub const HOUR: u64 = 3600;
pub const CAP_SECS: u64 = 7 * 24 * HOUR;
pub const CAP_OTHER_SECS: u64 = 24 * HOUR;
/// The shortest lend (one minute; one second in tests, so expiry can be watched).
pub const MIN_SECS: u64 = if cfg!(test) { 1 } else { 60 };
/// A borrowed sign-in's account id: `lend:<grant id>`.
pub const ACCOUNT_PREFIX: &str = "lend:";
pub const MODE: &str = "proxy";
pub const NOT_IN_THIS_MODE: &str = "Not available in this mode";
pub const ENDED: &str = "This lend ended";
/// Why a chat cannot start on a borrowed sign-in of an agent whose spec has no `[chat]` hookup. The chat lane gives it its own
/// code (`LEND_CHAT_UNSUPPORTED`), not "sign-in not found".
pub const NO_CHAT: &str = "Chat can't be borrowed through a PC for this agent yet. Open it in a terminal.";
/// What both PCs show on a grant whose lend sign-in can't be used.
pub const SIGNIN_PROBLEM: &str = "The lender's sign-in expired. Ask them to sign in again.";

/// How often an active lend sign-in's expiry is looked at, and the least time between two refreshes of it.
const REFRESH_TICK: Duration = if cfg!(test) { Duration::from_millis(100) } else { Duration::from_secs(60) };
const REFRESH_GAP_MS: u64 = if cfg!(test) { 800 } else { 5 * 60 * 1000 };

fn cap_for(other_person: bool) -> u64 {
    if other_person {
        CAP_OTHER_SECS
    } else {
        CAP_SECS
    }
}

// ------------------------------------------------------------------------------------------- the shapes lend.ts reads

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LendAccount {
    Main,
    Account { id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LendWho {
    MyPcs,
    Teammates,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Each,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LendProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub agent_ids: Vec<String>,
    pub account: LendAccount,
    pub who: LendWho,
    #[serde(default)]
    pub member_ids: Vec<String>,
    pub default_secs: u64,
    pub max_secs: u64,
    pub approval: Approval,
    #[serde(default)]
    pub sign_out_on_end: bool,
    /// Optional caps per grant (Lend through my PC): requests and tokens (input + output). None: no cap.
    #[serde(default)]
    pub max_requests: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// Keep this PC awake while a lend from this profile is active. On unless turned off.
    #[serde(default = "default_keep_awake")]
    pub keep_awake: bool,
    /// Shown only: a pasted API key is kept for this profile (it is never sent to the screen). Set by `state`,
    /// ignored on save.
    #[serde(default)]
    pub has_key: bool,
}

fn default_keep_awake() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Out,
    In,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantState {
    Requested,
    Active,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantEnd {
    Expired,
    Revoked,
    Returned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    pub direction: Direction,
    pub agent_id: String,
    pub peer_member_id: String,
    pub peer_name: String,
    pub peer_device_name: String,
    pub started_ms: u64,
    pub ends_ms: u64,
    pub state: GrantState,
    pub end_reason: Option<GrantEnd>,
    pub for_other_person: bool,
    pub pane_ids: Vec<String>,
    /// Usage through this grant: the lender counts it at the gate, the borrower from the replies that went through its shim.
    #[serde(default)]
    pub requests: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    /// Something is wrong with the lender's sign-in right now (shown on both PCs). None: all fine.
    #[serde(default)]
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    Open,
    Accepted,
    Declined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LendRequest {
    pub id: String,
    pub direction: Direction,
    pub member_id: String,
    pub member_name: String,
    pub device_name: String,
    pub agent_id: String,
    pub secs: u64,
    pub reason: String,
    pub at_ms: u64,
    pub for_other_person: bool,
    pub state: RequestState,
}

/// What a chat on a borrowed sign-in is started with.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BorrowedChat {
    pub env: LaunchEnv,
    /// Added to the adapter's arguments.
    pub args: Vec<String>,
    /// The adapter's `authenticate` method to call before a session opens.
    pub authenticate: Option<String>,
}

/// A grant id as a folder name (letters, digits, `-` and `_` only).
fn safe_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Driver {
    pub agent_id: String,
    pub label: String,
    pub support: &'static str,
    /// The lender can paste an API key for this agent.
    pub api_key: bool,
    /// The lender can lend a signed-in account of this agent (a lend sign-in).
    pub account: bool,
    /// A borrowed chat (not only a terminal) works for this agent.
    pub chat: bool,
    /// A sign-in this agent has that cannot be lent yet, in plain words (shown, never offered).
    pub account_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LendState {
    pub enabled: bool,
    pub profiles: Vec<LendProfile>,
    pub grants: Vec<Grant>,
    pub requests_in: Vec<LendRequest>,
    pub requests_out: Vec<LendRequest>,
    pub drivers: Vec<Driver>,
    /// This PC is being held awake right now for an outgoing lend.
    #[serde(default)]
    pub keeping_awake: bool,
}

// ------------------------------------------------------------------------------------------------- saved records

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GrantRec {
    view: Grant,
    lender_device: String,
    borrower_device: String,
    /// Hex node id the lender lets in (out) / my own node (in).
    borrower_node: String,
    /// In: where the lender is.
    #[serde(default)]
    node: Option<NodeHint>,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RequestRec {
    view: LendRequest,
    /// Out: the devices it went to. In: the device it came from.
    devices: Vec<String>,
    #[serde(default)]
    node_hint: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    profiles: Vec<LendProfile>,
    #[serde(default)]
    grants: Vec<GrantRec>,
    #[serde(default)]
    requests: Vec<RequestRec>,
    #[serde(default)]
    guard: Guard,
    /// Revokes still to send after a restart (see `Lend::resume`): ids only, never a secret.
    #[serde(default)]
    pending_revokes: Vec<PendingRevoke>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PendingRevoke {
    grant_id: String,
    /// The borrower's device.
    device: String,
}

/// The reason the borrower sees when this PC lost its lends by restarting.
pub const RESTARTED: &str = "lender restarted";
/// How often a revoke that could not go out yet is tried again (the team may not be connected right after launch).
const REVOKE_RETRY: Duration = if cfg!(test) { Duration::from_millis(200) } else { Duration::from_secs(15) };
const REVOKE_TRIES: u32 = 80;

/// What Test link found, in words for the row it was pressed on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkTest {
    pub ok: bool,
    pub ms: Option<u64>,
    /// `direct`, `relay` (the PC link) or `mailbox` (the team relay).
    pub via: Option<String>,
    pub message: String,
}

// ------------------------------------------------------------------------------------------------- the seams

/// The team relay, as the lend service needs it.
pub trait TeamPort: Send + Sync {
    fn session(&self) -> Result<Session, String>;
    fn send(&self, payload: &Payload) -> Result<(), String>;
}

pub use crate::night_shift::power::AwakePort;

/// The key of the lend hold among Night Shift's keyed holds (run ids never look like this).
pub const AWAKE_KEY: &str = "lend:out";

/// The lend hold: shares Night Shift's keyed holds, so ending a lend never lets go of a Night Shift hold and the reverse.
pub fn app_awake() -> crate::night_shift::power::KeyedHold {
    crate::night_shift::power::KeyedHold::new(AWAKE_KEY, "Potato Workspace is lending an agent")
}

/// The real team service.
pub struct AppTeam;

impl TeamPort for AppTeam {
    fn session(&self) -> Result<Session, String> {
        crate::team::service::capacity_session()
    }
    fn send(&self, payload: &Payload) -> Result<(), String> {
        crate::team::service::capacity_send(payload)
    }
}

pub type Spawn = Arc<dyn Fn(Pin<Box<dyn Future<Output = ()> + Send>>) + Send + Sync>;

/// One renewal of a lend sign-in's token by the agent's own CLI.
#[derive(Debug, Clone)]
pub struct RefreshJob {
    pub agent_id: String,
    pub account_id: String,
    pub args: Vec<String>,
    pub timeout_secs: u64,
    /// A folder to run in (not a project).
    pub scratch: PathBuf,
}

pub type Refresh = Arc<dyn Fn(RefreshJob) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

/// What the lender keeps fresh for one grant on a lend sign-in.
struct RefreshPlan {
    agent_id: String,
    account_id: String,
    signin: SigninFile,
    refresh: RefreshSpec,
}

pub struct Deps {
    pub dir: PathBuf,
    pub secrets: Arc<dyn SecretBackend>,
    pub team: Arc<dyn TeamPort>,
    pub net: Arc<LendNet>,
    pub accounts: crate::accounts::Store,
    pub specs: Vec<ProxySpec>,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub awake: Arc<dyn AwakePort>,
    pub changed: Arc<dyn Fn() + Send + Sync>,
    pub spawn: Spawn,
    /// Team page pings (shared with the code that answers them; it works without Lend on).
    pub pinger: Arc<Pinger>,
    /// Renews a lend sign-in's token (the real one runs the agent's CLI, hidden).
    pub refresh: Refresh,
    /// Inherited environment variable names (for the pane env: which provider variables to remove).
    pub env_names: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    /// Tests only: forward to a fake upstream on this machine instead of the spec's host.
    #[cfg(test)]
    pub test_upstream: Option<String>,
}

// ------------------------------------------------------------------------------------------------- live parts

struct LenderLive {
    gate: Arc<Gate>,
    forwarder: Arc<Forwarder>,
    borrower_node: NodeId,
    secret: Vec<u8>,
    links: Vec<Arc<dyn Link>>,
}

struct BorrowerLive {
    shim: Arc<Shim>,
    opener: Arc<LinkOpener>,
}

/// What the borrower's opener sees of its grant.
struct InGrant {
    svc: Weak<Lend>,
    grant_id: String,
    hint: NodeHint,
    secret: Vec<u8>,
    ended: AtomicBool,
}

impl BorrowerGrant for InGrant {
    fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }
    fn lender_ended(&self) {
        self.ended.store(true, Ordering::SeqCst);
        if let Some(svc) = self.svc.upgrade() {
            svc.finish_in(&self.grant_id, None);
        }
    }
    fn hint(&self) -> NodeHint {
        self.hint.clone()
    }
    fn grant_id(&self) -> String {
        self.grant_id.clone()
    }
    fn secret(&self) -> Vec<u8> {
        self.secret.clone()
    }
}

struct Inner {
    saved: Saved,
    out: HashMap<String, LenderLive>,
    inn: HashMap<String, BorrowerLive>,
    in_grants: HashMap<String, Arc<InGrant>>,
}

pub struct Lend {
    deps: Deps,
    inner: Mutex<Inner>,
    /// Whether the awake hold is on (taken once for all outgoing lends, not per grant).
    awake_on: Mutex<bool>,
    me: Weak<Lend>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn short_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

fn link_slot(grant_id: &str) -> String {
    format!("lend:link:{grant_id}")
}

fn key_slot(profile_id: &str) -> String {
    format!("lend:key:{profile_id}")
}

impl Lend {
    pub fn new(deps: Deps) -> Arc<Self> {
        let saved = std::fs::read_to_string(deps.dir.join("state.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Saved>(&t).ok())
            .unwrap_or_default();
        let svc = Arc::new_cyclic(|me| Self {
            deps,
            inner: Mutex::new(Inner { saved, out: HashMap::new(), inn: HashMap::new(), in_grants: HashMap::new() }),
            awake_on: Mutex::new(false),
            me: me.clone(),
        });
        let book: Weak<dyn LenderBook> = svc.me.clone();
        svc.deps.net.set_book(book);
        svc
    }

    pub fn net(&self) -> Arc<LendNet> {
        self.deps.net.clone()
    }

    fn now(&self) -> u64 {
        (self.deps.now)()
    }

    fn save(&self, inner: &Inner) {
        let _ = std::fs::create_dir_all(&self.deps.dir);
        if let Ok(text) = serde_json::to_string_pretty(&inner.saved) {
            let path = self.deps.dir.join("state.json");
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn changed(&self) {
        self.sync_awake();
        (self.deps.changed)()
    }

    /// Hold the computer awake while at least one outgoing grant is active and its profile asks for it; let go
    /// when the last one ends. Cheap to call after any change. Never called with `inner` locked.
    fn sync_awake(&self) {
        let want = {
            let inner = lock(&self.inner);
            inner.saved.grants.iter().any(|g| {
                g.view.direction == Direction::Out
                    && g.view.state == GrantState::Active
                    && g.profile_id
                        .as_ref()
                        .and_then(|id| inner.saved.profiles.iter().find(|p| &p.id == id))
                        .is_none_or(|p| p.keep_awake)
            })
        };
        let mut on = lock(&self.awake_on);
        if want && !*on {
            match self.deps.awake.hold() {
                Ok(()) => *on = true,
                Err(e) => tracing::warn!(error = %e, "lend: could not keep the PC awake"),
            }
        } else if !want && *on {
            self.deps.awake.release();
            *on = false;
        }
    }

    fn spec(&self, agent_id: &str) -> Option<&ProxySpec> {
        self.deps.specs.iter().find(|s| s.agent_id.eq_ignore_ascii_case(agent_id))
    }

    // ------------------------------------------------------------------------------------------------- the view

    pub fn state(&self, enabled: bool) -> LendState {
        let inner = lock(&self.inner);
        let grants = inner
            .saved
            .grants
            .iter()
            .map(|g| {
                let mut v = g.view.clone();
                if let Some(live) = inner.out.get(&v.id) {
                    let u = live.gate.usage();
                    (v.requests, v.input_tokens, v.output_tokens) = (u.requests, u.input_tokens, u.output_tokens);
                }
                v
            })
            .collect();
        let pick = |d: Direction| inner.saved.requests.iter().filter(|r| r.view.direction == d).map(|r| r.view.clone()).collect();
        LendState {
            enabled,
            profiles: inner
                .saved
                .profiles
                .iter()
                .cloned()
                .map(|mut p| {
                    p.has_key = self.deps.secrets.get(&key_slot(&p.id)).ok().flatten().is_some_and(|k| !k.is_empty());
                    p
                })
                .collect(),
            grants,
            requests_in: pick(Direction::In),
            requests_out: pick(Direction::Out),
            drivers: self.drivers(),
            keeping_awake: *lock(&self.awake_on),
        }
    }

    pub fn drivers(&self) -> Vec<Driver> {
        self.deps
            .specs
            .iter()
            .map(|s| Driver {
                agent_id: s.agent_id.clone(),
                label: crate::tui::descriptors().into_iter().find(|d| d.id == s.agent_id).map(|d| d.label).unwrap_or_else(|| s.agent_id.clone()),
                support: s.support.as_str(),
                api_key: s.auth.api_key.is_some(),
                account: s.auth.account.is_some(),
                chat: s.chat.is_some(),
                account_note: s.auth.account_not_yet.clone(),
            })
            .collect()
    }

    /// Whether a signed-in account of `agent_id` can be lent. Not when the spec has no account auth: the reason is the
    /// spec's own plain sentence (for example Codex signed in with ChatGPT, which is not proven).
    pub fn account_lendable(&self, agent_id: &str) -> Result<(), String> {
        let spec = self.spec(agent_id).ok_or_else(|| format!("{agent_id} can't be lent through this PC."))?;
        if spec.auth.account.is_some() {
            return Ok(());
        }
        Err(spec.auth.account_not_yet.clone().unwrap_or_else(|| "A sign-in of this agent can't be lent yet. Use an API key.".to_string()))
    }

    // ------------------------------------------------------------------------------------------------- profiles

    pub fn profile_save(&self, mut p: LendProfile) -> Result<LendProfile, String> {
        p.name = p.name.trim().to_string();
        p.has_key = false;
        if p.name.is_empty() || p.name.chars().count() > 60 {
            return Err("A lend profile needs a name (60 characters at most).".into());
        }
        p.agent_ids.retain(|a| !a.trim().is_empty());
        if p.agent_ids.is_empty() {
            return Err("Pick at least one agent.".into());
        }
        for a in &p.agent_ids {
            if self.spec(a).is_none() {
                return Err(format!("{a} can't be lent through this PC."));
            }
        }
        if p.max_secs < MIN_SECS || p.max_secs > CAP_SECS || p.default_secs < MIN_SECS || p.default_secs > p.max_secs {
            return Err("Pick a length between one minute and 7 days.".into());
        }
        if let LendAccount::Account { id } = &p.account {
            for a in &p.agent_ids {
                self.account_lendable(a)?;
            }
            let acc = self.deps.accounts.get(id).ok_or("That lend sign-in no longer exists.")?;
            if !acc.lend_only {
                return Err("Only a lend sign-in can be lent. Add one with \"New lend sign-in\".".into());
            }
            if !p.agent_ids.iter().any(|a| a.eq_ignore_ascii_case(&acc.agent_id)) {
                return Err("That sign-in belongs to another agent.".into());
            }
        }
        let mut inner = lock(&self.inner);
        if p.id.is_empty() {
            p.id = short_id("lp");
            inner.saved.profiles.push(p.clone());
        } else if let Some(slot) = inner.saved.profiles.iter_mut().find(|x| x.id == p.id) {
            *slot = p.clone();
        } else {
            return Err("That lend profile no longer exists.".into());
        }
        self.save(&inner);
        drop(inner);
        self.changed();
        Ok(p)
    }

    pub fn profile_delete(&self, id: &str) -> Result<(), String> {
        let mut inner = lock(&self.inner);
        inner.saved.profiles.retain(|p| p.id != id);
        self.save(&inner);
        drop(inner);
        let _ = self.deps.secrets.delete(&key_slot(id));
        self.changed();
        Ok(())
    }

    /// The pasted API key of a profile, into the OS credential store (empty removes it). Never returned.
    pub fn key_set(&self, profile_id: &str, key: &str) -> Result<(), String> {
        if !lock(&self.inner).saved.profiles.iter().any(|p| p.id == profile_id) {
            return Err("That lend profile no longer exists.".into());
        }
        let key = key.trim();
        if key.is_empty() {
            return self.deps.secrets.delete(&key_slot(profile_id));
        }
        if key.len() > 512 || !key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("That doesn't look like an API key.".into());
        }
        self.deps.secrets.set(&key_slot(profile_id), key)
    }

    /// The lender's auth for `agent_id` from `profile`: the pasted key first, else the lend sign-in's token file
    /// (read again on every request, so a renewed token is picked up).
    fn auth_for(&self, profile: &LendProfile, spec: &ProxySpec) -> Result<AuthSource, String> {
        if let Some(key) = self.deps.secrets.get(&key_slot(&profile.id))?.filter(|k| !k.is_empty()) {
            let a = spec.auth.api_key.as_ref().ok_or("This agent can't use a pasted key.")?;
            return Ok(InjectedAuth::from_spec(a, &key).into());
        }
        let LendAccount::Account { id } = &profile.account else {
            return Err("Pick a lend sign-in or paste an API key in this profile first.".into());
        };
        let acc = self.deps.accounts.get(id).filter(|a| a.lend_only).ok_or("That lend sign-in no longer exists.")?;
        let a = spec.auth.account.as_ref().ok_or("This agent can't lend a sign-in through this PC.")?;
        let file = SigninFile::new(&acc.home, a)?;
        // There must be a token to start with (its expiry is looked after later).
        file.token(0).map_err(|_| "Sign in to the lend sign-in first.".to_string())?;
        AuthSource::account(&acc.home, a)
    }

    /// What to keep fresh while a grant on a lend sign-in is active. None for a pasted key or a spec with no refresh.
    fn refresh_plan(&self, profile: &LendProfile, spec: &ProxySpec, auth: &AuthSource) -> Option<RefreshPlan> {
        let (AuthSource::Account { file, spec: auth_spec }, LendAccount::Account { id }) = (auth, &profile.account) else { return None };
        auth_spec.expires_pointer.as_ref()?;
        let refresh = auth_spec.refresh.clone()?;
        Some(RefreshPlan { agent_id: spec.agent_id.clone(), account_id: id.clone(), signin: file.clone(), refresh })
    }

    /// Shows (or clears) the sign-in problem on a grant, on this PC. Told by the forwarder, the shim and the refresher.
    fn set_problem(&self, grant_id: &str, bad: bool) {
        let want = bad.then(|| SIGNIN_PROBLEM.to_string());
        {
            let mut inner = lock(&self.inner);
            let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id && g.view.state == GrantState::Active) else { return };
            if g.view.problem == want {
                return;
            }
            g.view.problem = want;
        }
        self.changed();
    }

    /// Counts what a borrowed grant used on this PC (each good reply is one request), for the pane chip.
    fn usage_note(&self, grant_id: &str) -> Option<(String, UsageNote)> {
        let shape = self.grant_rec(grant_id).and_then(|r| self.spec(&r.view.agent_id).map(|s| s.shape.clone()))?;
        let (me, id) = (self.me.clone(), grant_id.to_string());
        let note: UsageNote = Arc::new(move |input, output| {
            if let Some(svc) = me.upgrade() {
                svc.add_borrowed_usage(&id, input, output);
            }
        });
        Some((shape, note))
    }

    fn add_borrowed_usage(&self, grant_id: &str, input: u64, output: u64) {
        {
            let mut inner = lock(&self.inner);
            let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id && g.view.direction == Direction::In) else { return };
            g.view.requests += 1;
            g.view.input_tokens += input;
            g.view.output_tokens += output;
            self.save(&inner);
        }
        self.changed();
    }

    fn signin_note(&self, grant_id: &str) -> SigninNote {
        let (me, id) = (self.me.clone(), grant_id.to_string());
        Arc::new(move |bad| {
            if let Some(svc) = me.upgrade() {
                svc.set_problem(&id, bad);
            }
        })
    }

    // ------------------------------------------------------------------------------------------------- asking

    pub fn request(&self, member_id: &str, device_id: Option<&str>, agent_id: &str, secs: u64, reason: &str) -> Result<LendRequest, String> {
        if self.spec(agent_id).is_none() {
            return Err(format!("{agent_id} can't be borrowed through a PC."));
        }
        let reason = reason.trim();
        if reason.chars().count() > wire::MAX_REASON {
            return Err("The reason is too long (280 characters at most).".into());
        }
        let session = self.deps.team.session()?;
        let me_member = session.my_member()?;
        let me_device = session.my_device()?;
        let member = session.roster.member(member_id).ok_or("That person is not on the team.")?.clone();
        let other = member.id != me_member;
        if secs < MIN_SECS || secs > cap_for(other) {
            return Err(if other { "Another person can lend it for 24 hours at most." } else { "The most is 7 days." }.into());
        }
        let devices: Vec<String> = match device_id {
            Some(d) => {
                if !member.devices.iter().any(|x| x.id == d) || d == me_device {
                    return Err("That PC is not one of theirs.".into());
                }
                vec![d.to_string()]
            }
            None => member.devices.iter().map(|d| d.id.clone()).filter(|d| *d != me_device).collect(),
        };
        if devices.is_empty() {
            return Err("They have no other PC on the team.".into());
        }
        let node = self.deps.net.my_node()?.to_hex();
        let my_name = session.roster.device(&me_device).map(|(_, d)| d.name.clone()).unwrap_or_default();
        let now = self.now();
        let request_id = short_id("lr");
        for d in &devices {
            let body = Body::Request {
                request_id: request_id.clone(),
                agent_id: agent_id.to_string(),
                mode: MODE.into(),
                duration_ms: secs * 1000,
                reason: reason.to_string(),
                device_name: my_name.clone(),
                node_hint: node.clone(),
            };
            let (payload, _) = wire::seal(&session, d, body, now)?;
            self.deps.team.send(&payload)?;
        }
        let device_name = match device_id {
            Some(d) => member.devices.iter().find(|x| x.id == d).map(|x| x.name.clone()).unwrap_or_default(),
            None => String::new(),
        };
        let view = LendRequest {
            id: request_id,
            direction: Direction::Out,
            member_id: member.id.clone(),
            member_name: member.display.clone(),
            device_name,
            agent_id: agent_id.to_string(),
            secs,
            reason: reason.to_string(),
            at_ms: now,
            for_other_person: other,
            state: RequestState::Open,
        };
        let mut inner = lock(&self.inner);
        inner.saved.requests.push(RequestRec { view: view.clone(), devices, node_hint: node });
        self.save(&inner);
        drop(inner);
        self.changed();
        Ok(view)
    }

    // ------------------------------------------------------------------------------------------------- lending

    /// Yes or no to a request that came in. Yes makes the grant and sends it to the device that asked.
    pub async fn answer(&self, request_id: &str, accept: bool, profile_id: Option<&str>, secs: Option<u64>) -> Result<Option<Grant>, String> {
        let req = {
            let inner = lock(&self.inner);
            inner.saved.requests.iter().find(|r| r.view.id == request_id && r.view.direction == Direction::In).cloned()
        }
        .ok_or("That request is gone.")?;
        if req.view.state != RequestState::Open {
            return Err("That request was already answered.".into());
        }
        let session = self.deps.team.session()?;
        let to = req.devices.first().cloned().ok_or("That request is gone.")?;
        if !accept {
            let (payload, _) = wire::seal(&session, &to, Body::Decline { request_id: request_id.into() }, self.now())?;
            self.deps.team.send(&payload)?;
            self.set_request_state(request_id, Direction::In, RequestState::Declined);
            return Ok(None);
        }
        let spec = self.spec(&req.view.agent_id).cloned().ok_or("This agent can't be lent through this PC.")?;
        let profile = {
            let inner = lock(&self.inner);
            match profile_id {
                Some(id) => inner.saved.profiles.iter().find(|p| p.id == id).cloned(),
                None => inner.saved.profiles.iter().find(|p| p.agent_ids.iter().any(|a| a.eq_ignore_ascii_case(&req.view.agent_id))).cloned(),
            }
        }
        .ok_or("Pick a lend profile first.")?;
        if !profile.agent_ids.iter().any(|a| a.eq_ignore_ascii_case(&req.view.agent_id)) {
            return Err("That profile doesn't lend this agent.".into());
        }
        let secs = secs.unwrap_or(req.view.secs);
        let cap = cap_for(req.view.for_other_person).min(profile.max_secs);
        if secs < MIN_SECS || secs > cap {
            return Err(if req.view.for_other_person { "Another person can borrow it for 24 hours at most." } else { "That is longer than this profile allows." }.into());
        }
        let borrower_node = node_from_hex(&req.node_hint).ok_or("That request has no PC address.")?;
        let auth = self.auth_for(&profile, &spec)?;
        let plan = self.refresh_plan(&profile, &spec, &auth);
        let grant_id = short_id("lg");
        #[allow(unused_mut)]
        let mut forwarder = Forwarder::new(Arc::new(spec.clone()), auth)?.with_signin(self.deps.now.clone(), self.signin_note(&grant_id));
        #[cfg(test)]
        if let Some(up) = &self.deps.test_upstream {
            forwarder = forwarder.with_test_upstream(up);
        }
        let hint = self.deps.net.start().await.map_err(|e| format!("The PC link could not start: {e}"))?;
        let now = self.now();
        let secret = random_bytes::<32>().to_vec();
        let limits = Limits { max_requests: profile.max_requests, max_tokens: profile.max_tokens };
        let gate = Gate::new(tokio::time::Instant::now() + Duration::from_secs(secs), limits);
        let peer = session.roster.member(&req.view.member_id);
        let view = Grant {
            id: grant_id.clone(),
            direction: Direction::Out,
            agent_id: req.view.agent_id.clone(),
            peer_member_id: req.view.member_id.clone(),
            peer_name: peer.map(|m| m.display.clone()).unwrap_or_else(|| req.view.member_name.clone()),
            peer_device_name: req.view.device_name.clone(),
            started_ms: now,
            ends_ms: now + secs * 1000,
            state: GrantState::Active,
            end_reason: None,
            for_other_person: req.view.for_other_person,
            pane_ids: Vec::new(),
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            problem: None,
        };
        let body = Body::Grant {
            request_id: request_id.into(),
            grant_id: grant_id.clone(),
            agent_id: req.view.agent_id.clone(),
            mode: MODE.into(),
            duration_ms: secs * 1000,
            not_after_ms: now + secs * 1000,
            limits,
            node: hint,
            link_secret: b64(&secret),
            device_name: session.roster.device(&session.my_device()?).map(|(_, d)| d.name.clone()).unwrap_or_default(),
        };
        let (payload, _) = wire::seal(&session, &to, body, now)?;
        // The grant is live before it is sent, so the borrower's first dial finds it.
        {
            let mut inner = lock(&self.inner);
            let _ = self.deps.secrets.set(&link_slot(&grant_id), &b64(&secret));
            inner.out.insert(
                grant_id.clone(),
                LenderLive { gate: gate.clone(), forwarder: Arc::new(forwarder), borrower_node, secret, links: Vec::new() },
            );
            inner.saved.grants.push(GrantRec {
                view: view.clone(),
                lender_device: session.my_device()?,
                borrower_device: to.clone(),
                borrower_node: borrower_node.to_hex(),
                node: None,
                profile_id: Some(profile.id.clone()),
                limits,
            });
            if let Some(r) = inner.saved.requests.iter_mut().find(|r| r.view.id == request_id) {
                r.view.state = RequestState::Accepted;
            }
            self.save(&inner);
        }
        self.watch_gate(&grant_id, gate);
        if let Some(plan) = plan {
            self.keep_fresh(&grant_id, plan);
        }
        if let Err(e) = self.deps.team.send(&payload) {
            self.finish_out(&grant_id, EndReason::Stopped);
            return Err(e);
        }
        self.changed();
        Ok(Some(view))
    }

    fn watch_gate(&self, grant_id: &str, gate: Arc<Gate>) {
        let (me, id) = (self.me.clone(), grant_id.to_string());
        (self.deps.spawn)(Box::pin(async move {
            let reason = gate.wait_end().await;
            if let Some(svc) = me.upgrade() {
                svc.finish_out(&id, reason);
            }
        }));
    }

    /// While the grant is active: every tick, look at the token's expiry and have the agent renew it when it is close.
    fn keep_fresh(&self, grant_id: &str, plan: RefreshPlan) {
        let (me, id) = (self.me.clone(), grant_id.to_string());
        (self.deps.spawn)(Box::pin(async move {
            let mut last: Option<u64> = None;
            loop {
                let Some(svc) = me.upgrade() else { return };
                if !lock(&svc.inner).out.contains_key(&id) {
                    return;
                }
                svc.refresh_tick(&id, &plan, &mut last).await;
                drop(svc);
                tokio::time::sleep(REFRESH_TICK).await;
            }
        }));
    }

    async fn read_expiry(plan: &RefreshPlan) -> Option<Option<u64>> {
        let signin = plan.signin.clone();
        tokio::task::spawn_blocking(move || signin.expiry()).await.ok().flatten()
    }

    /// One look: reads only the expiry. Close to it (or past it): one refresh, at most once per `REFRESH_GAP_MS`.
    async fn refresh_tick(&self, grant_id: &str, plan: &RefreshPlan, last: &mut Option<u64>) {
        let now = self.now();
        let at = match Self::read_expiry(plan).await {
            None => return self.set_problem(grant_id, true),
            Some(None) => return,
            Some(Some(at)) => at,
        };
        if at > now.saturating_add(plan.refresh.before_secs.saturating_mul(1000)) {
            return self.set_problem(grant_id, false);
        }
        if at <= now {
            self.set_problem(grant_id, true);
        }
        if last.is_some_and(|t| now.saturating_sub(t) < REFRESH_GAP_MS) {
            return;
        }
        *last = Some(now);
        let job = RefreshJob {
            agent_id: plan.agent_id.clone(),
            account_id: plan.account_id.clone(),
            args: plan.refresh.args.clone(),
            timeout_secs: plan.refresh.timeout_secs,
            scratch: self.deps.dir.join("refresh"),
        };
        let wait = Duration::from_secs(plan.refresh.timeout_secs + 10);
        let ran = tokio::time::timeout(wait, (self.deps.refresh)(job)).await;
        tracing::info!(grant = grant_id, ran_ok = matches!(ran, Ok(Ok(()))), "lend: sign-in refresh");
        let fine = matches!(Self::read_expiry(plan).await, Some(Some(at)) if at > self.now());
        self.set_problem(grant_id, !fine);
    }

    /// A grant I lend ended (any reason): the record says so, links close, the secret goes.
    fn finish_out(&self, grant_id: &str, reason: EndReason) {
        let (live, none_left) = {
            let mut inner = lock(&self.inner);
            let Some(live) = inner.out.remove(grant_id) else { return };
            live.gate.end(reason);
            let usage = live.gate.usage();
            if let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id) {
                g.view.state = GrantState::Ended;
                g.view.problem = None;
                g.view.end_reason = Some(end_of(reason));
                (g.view.requests, g.view.input_tokens, g.view.output_tokens) = (usage.requests, usage.input_tokens, usage.output_tokens);
            }
            self.save(&inner);
            (live, inner.out.is_empty())
        };
        for link in &live.links {
            link.close(CLOSE_LEND_ENDED, "lend_ended");
        }
        let _ = self.deps.secrets.delete(&link_slot(grant_id));
        tracing::info!(grant = grant_id, reason = reason.as_str(), "lend: grant ended");
        if none_left && lock(&self.inner).inn.is_empty() {
            let net = self.deps.net.clone();
            (self.deps.spawn)(Box::pin(async move { net.stop().await }));
        }
        self.changed();
    }

    /// Revoke now: streams cut, links closed at once, the borrower told.
    pub fn revoke(&self, grant_id: &str) -> Result<(), String> {
        let rec = self.grant_rec(grant_id).filter(|g| g.view.direction == Direction::Out).ok_or("That lend is gone.")?;
        if rec.view.state == GrantState::Active {
            self.finish_out(grant_id, EndReason::Revoked);
        }
        let session = self.deps.team.session()?;
        let (payload, _) = wire::seal(&session, &rec.borrower_device, Body::Revoke { grant_id: grant_id.into(), reason: String::new() }, self.now())?;
        self.deps.team.send(&payload)
    }

    /// Give back now (borrower).
    pub fn give_back(&self, grant_id: &str) -> Result<(), String> {
        let rec = self.grant_rec(grant_id).filter(|g| g.view.direction == Direction::In).ok_or("That lend is gone.")?;
        self.finish_in(grant_id, Some(GrantEnd::Returned));
        let session = self.deps.team.session()?;
        let (payload, _) = wire::seal(&session, &rec.lender_device, Body::Return { grant_id: grant_id.into() }, self.now())?;
        self.deps.team.send(&payload)
    }

    fn grant_rec(&self, grant_id: &str) -> Option<GrantRec> {
        lock(&self.inner).saved.grants.iter().find(|g| g.view.id == grant_id).cloned()
    }

    fn set_request_state(&self, id: &str, dir: Direction, state: RequestState) {
        let mut inner = lock(&self.inner);
        if let Some(r) = inner.saved.requests.iter_mut().find(|r| r.view.id == id && r.view.direction == dir) {
            r.view.state = state;
        }
        self.save(&inner);
        drop(inner);
        self.changed();
    }

    // ------------------------------------------------------------------------------------------------- borrowing

    /// A borrowed grant ended here (time, revoke, given back, the lender said so). The shim stays and answers
    /// "This lend ended"; panes on it are never switched to another sign-in.
    fn finish_in(&self, grant_id: &str, why: Option<GrantEnd>) {
        let opener = {
            let mut inner = lock(&self.inner);
            if let Some(g) = inner.in_grants.get(grant_id) {
                g.ended.store(true, Ordering::SeqCst);
            }
            let now = self.now();
            let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id && g.view.direction == Direction::In) else { return };
            if g.view.state == GrantState::Ended {
                return;
            }
            g.view.state = GrantState::Ended;
            g.view.problem = None;
            // The lender said it is over without saying why: near the end (clocks differ a little) it is the time.
            g.view.end_reason = Some(why.unwrap_or(if now + 5_000 >= g.view.ends_ms { GrantEnd::Expired } else { GrantEnd::Revoked }));
            self.save(&inner);
            inner.inn.get(grant_id).map(|b| {
                b.shim.end();
                b.opener.clone()
            })
        };
        let _ = self.deps.secrets.delete(&link_slot(grant_id));
        if let Some(opener) = opener {
            (self.deps.spawn)(Box::pin(async move { opener.close().await }));
        }
        self.changed();
    }

    /// Starts the shim of an incoming grant (on the async runtime).
    fn start_shim(&self, grant_id: &str, hint: NodeHint, secret: Vec<u8>, ends_ms: u64) {
        let g = Arc::new(InGrant { svc: self.me.clone(), grant_id: grant_id.to_string(), hint, secret, ended: AtomicBool::new(false) });
        lock(&self.inner).in_grants.insert(grant_id.to_string(), g.clone());
        let (me, net, id) = (self.me.clone(), self.deps.net.clone(), grant_id.to_string());
        let note = self.signin_note(grant_id);
        let usage = self.usage_note(grant_id);
        let left = ends_ms.saturating_sub(self.now());
        let max_body = self.grant_rec(grant_id).and_then(|r| self.spec(&r.view.agent_id).map(|s| s.max_body_bytes)).unwrap_or(super::spec::MAX_BODY_CAP);
        (self.deps.spawn)(Box::pin(async move {
            let opener = LinkOpener::new(net, g.clone());
            let shim = match Shim::start_with(opener.clone(), max_body, Some(note), usage).await {
                Ok(s) => s,
                Err(error) => {
                    tracing::warn!(%error, "lend: the local shim could not start");
                    return;
                }
            };
            if g.ended() {
                shim.end();
            }
            if let Some(svc) = me.upgrade() {
                lock(&svc.inner).inn.insert(id.clone(), BorrowerLive { shim, opener });
                svc.changed();
            }
            tokio::time::sleep(Duration::from_millis(left)).await;
            if let Some(svc) = me.upgrade() {
                svc.finish_in(&id, Some(GrantEnd::Expired));
            }
        }));
    }

    /// The sign-in `lend:<grant id>`: the pane env that points `agent_id` at the shim. An ended grant is refused
    /// for new panes (a pane that is already running keeps the shim, which answers "This lend ended").
    pub fn borrowed_launch_env(&self, agent_id: &str, grant_id: &str) -> Result<LaunchEnv, String> {
        self.borrowed_env(agent_id, grant_id, false).map(|c| c.env)
    }

    /// The same for a chat (ACP) session: the spec's `[chat]` table, with the adapter's extra arguments and the
    /// `authenticate` method it must be told to use. Refused when the agent's spec has no chat table.
    pub fn borrowed_chat(&self, agent_id: &str, grant_id: &str) -> Result<BorrowedChat, String> {
        self.borrowed_env(agent_id, grant_id, true)
    }

    fn borrowed_env(&self, agent_id: &str, grant_id: &str, chat: bool) -> Result<BorrowedChat, String> {
        let inner = lock(&self.inner);
        let rec = inner.saved.grants.iter().find(|g| g.view.id == grant_id && g.view.direction == Direction::In).ok_or("That borrowed sign-in is gone.")?;
        if !rec.view.agent_id.eq_ignore_ascii_case(agent_id) {
            return Err(format!("That borrowed sign-in is for {}, not {agent_id}.", rec.view.agent_id));
        }
        if rec.view.state != GrantState::Active || rec.view.ends_ms <= self.now() {
            return Err(ENDED.into());
        }
        let live = inner.inn.get(grant_id).ok_or("The borrowed sign-in is still starting. Try again in a moment.")?;
        let spec = self.spec(agent_id).ok_or("This agent can't be borrowed through a PC.")?;
        let hookup = if chat { spec.chat.as_ref().ok_or(NO_CHAT)? } else { &spec.hookup };
        let base_url = live.shim.base_url();
        let mut env = hookup_env(hookup, &base_url, &(self.deps.env_names)());
        // The agent's own config folder for THIS lend (a fresh one, never the borrower's real one).
        let folder = self.deps.dir.join("lend-homes").join(safe_name(grant_id)).join(if chat { "chat" } else { "terminal" });
        set_home(&mut env, write_home(hookup, &base_url, &folder)?);
        Ok(BorrowedChat { env, args: hookup.args.clone(), authenticate: hookup.authenticate.clone() })
    }

    pub fn note_pane(&self, grant_id: &str, pane_id: &str) {
        let mut inner = lock(&self.inner);
        if let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id) {
            if !g.view.pane_ids.iter().any(|p| p == pane_id) {
                g.view.pane_ids.push(pane_id.to_string());
            }
        }
        self.save(&inner);
        drop(inner);
        self.changed();
    }

    /// Active borrowed grants as extra sign-ins for the pickers.
    pub fn borrowed_rows(&self) -> Vec<serde_json::Value> {
        let now = self.now();
        lock(&self.inner)
            .saved
            .grants
            .iter()
            .filter(|g| g.view.direction == Direction::In && g.view.state == GrantState::Active && g.view.ends_ms > now)
            .map(|g| {
                serde_json::json!({
                    "id": format!("{ACCOUNT_PREFIX}{}", g.view.id),
                    "agent_id": g.view.agent_id,
                    "label": format!("{}'s PC (lent)", g.view.peer_name),
                    "ends_ms": g.view.ends_ms,
                    "grant_id": g.view.id,
                    "chat": self.spec(&g.view.agent_id).is_some_and(|s| s.chat.is_some()),
                })
            })
            .collect()
    }

    pub fn borrowed_label(&self, grant_id: &str) -> Option<String> {
        self.grant_rec(grant_id).filter(|g| g.view.direction == Direction::In).map(|g| format!("{}'s PC (lent)", g.view.peer_name))
    }

    pub fn grant_agent(&self, grant_id: &str) -> Option<(String, GrantState, Direction)> {
        self.grant_rec(grant_id).map(|g| (g.view.agent_id, g.view.state, g.view.direction))
    }

    /// Lender: usage so far (tests and the view).
    #[cfg(test)]
    pub fn usage(&self, grant_id: &str) -> Option<super::gate::Usage> {
        lock(&self.inner).out.get(grant_id).map(|l| l.gate.usage())
    }

    // ------------------------------------------------------------------------------------------------- inbound

    /// One item from the team relay. Anything that fails a check is dropped (and logged without its content).
    pub fn on_item(&self, cin: &CapacityIn) -> Result<(), WireReject> {
        let session = self.deps.team.session().map_err(|_| WireReject::Undecryptable)?;
        let kem = session.keys.device_kem().map_err(|_| WireReject::Undecryptable)?;
        let now = self.now();
        let item = wire::open(&session, &kem, cin, now)?;
        {
            let mut inner = lock(&self.inner);
            inner.saved.guard.fresh(&item.msg_id, now)?;
            self.save(&inner);
        }
        self.apply(&session, item, now)
    }

    fn apply(&self, session: &Session, item: Item, now: u64) -> Result<(), WireReject> {
        let me_member = session.my_member().map_err(|_| WireReject::Undecryptable)?;
        let names = |member: &str, device: &str| {
            let m = session.roster.member(member).map(|m| m.display.clone()).unwrap_or_default();
            let d = session.roster.device(device).map(|(_, d)| d.name.clone()).unwrap_or_default();
            (m, d)
        };
        match item.body {
            Body::Request { request_id, agent_id, mode, duration_ms, reason, device_name, node_hint } => {
                if mode != MODE || self.spec(&agent_id).is_none() || node_from_hex(&node_hint).is_none() {
                    return Err(WireReject::BadItem);
                }
                let (member_name, roster_device) = names(&item.from_member, &item.from_device);
                let mut inner = lock(&self.inner);
                if inner.saved.requests.iter().any(|r| r.view.id == request_id) {
                    return Err(WireReject::Replay);
                }
                let other = item.from_member != me_member;
                let view = LendRequest {
                    id: request_id,
                    direction: Direction::In,
                    member_id: item.from_member.clone(),
                    member_name,
                    device_name: if roster_device.is_empty() { device_name } else { roster_device },
                    agent_id,
                    secs: (duration_ms / 1000).clamp(MIN_SECS, cap_for(other)),
                    reason,
                    at_ms: now,
                    for_other_person: other,
                    state: RequestState::Open,
                };
                inner.saved.requests.push(RequestRec { view, devices: vec![item.from_device.clone()], node_hint });
                self.save(&inner);
            }
            Body::Grant { request_id, grant_id, agent_id, mode, duration_ms, not_after_ms, limits, node, link_secret, device_name } => {
                let secret = unb64(&link_secret).filter(|s| s.len() == 32).ok_or(WireReject::BadItem)?;
                if mode != MODE || node_from_hex(&node.id).is_none() {
                    return Err(WireReject::BadItem);
                }
                let ends_ms = {
                    let mut inner = lock(&self.inner);
                    let req = inner
                        .saved
                        .requests
                        .iter()
                        .find(|r| r.view.id == request_id && r.view.direction == Direction::Out)
                        .cloned()
                        .ok_or(WireReject::BadItem)?;
                    let matches = wire::rules::grant_matches(
                        req.view.state == RequestState::Open,
                        &req.view.member_id,
                        &req.devices,
                        &item.from_member,
                        &item.from_device,
                    );
                    if !matches || !req.view.agent_id.eq_ignore_ascii_case(&agent_id) {
                        return Err(WireReject::BadItem);
                    }
                    if !inner.saved.guard.accept_grant(&grant_id) {
                        return Err(WireReject::Replay);
                    }
                    // Lasts from arrival: received + min(duration, not_after - sent), and never past the cap.
                    let left = duration_ms.min(not_after_ms.saturating_sub(item.sent_ms)).min(cap_for(req.view.for_other_person) * 1000);
                    let ends_ms = now + left;
                    let (peer_name, roster_device) = names(&item.from_member, &item.from_device);
                    let my_device = session.my_device().unwrap_or_default();
                    inner.saved.grants.push(GrantRec {
                        view: Grant {
                            id: grant_id.clone(),
                            direction: Direction::In,
                            agent_id,
                            peer_member_id: item.from_member.clone(),
                            peer_name,
                            peer_device_name: if roster_device.is_empty() { device_name } else { roster_device },
                            started_ms: now,
                            ends_ms,
                            state: GrantState::Active,
                            end_reason: None,
                            for_other_person: req.view.for_other_person,
                            pane_ids: Vec::new(),
                            requests: 0,
                            input_tokens: 0,
                            output_tokens: 0,
                            problem: None,
                        },
                        lender_device: item.from_device.clone(),
                        borrower_device: my_device,
                        borrower_node: req.node_hint.clone(),
                        node: Some(node.clone()),
                        profile_id: None,
                        limits,
                    });
                    if let Some(r) = inner.saved.requests.iter_mut().find(|r| r.view.id == request_id) {
                        r.view.state = RequestState::Accepted;
                    }
                    self.save(&inner);
                    ends_ms
                };
                let _ = self.deps.secrets.set(&link_slot(&grant_id), &b64(&secret));
                self.start_shim(&grant_id, node, secret, ends_ms);
                if let Ok((payload, _)) = wire::seal(session, &item.from_device, Body::Ack { of: item.msg_id.clone() }, now) {
                    let _ = self.deps.team.send(&payload);
                }
            }
            Body::Decline { request_id } => {
                let ok = lock(&self.inner).saved.requests.iter().any(|r| {
                    r.view.id == request_id && r.view.direction == Direction::Out && r.view.member_id == item.from_member && r.devices.contains(&item.from_device)
                });
                if !ok {
                    return Err(WireReject::BadItem);
                }
                self.set_request_state(&request_id, Direction::Out, RequestState::Declined);
                return Ok(());
            }
            Body::Revoke { grant_id, .. } => {
                let rec = self.grant_rec(&grant_id).filter(|g| g.view.direction == Direction::In).ok_or(WireReject::BadItem)?;
                if !wire::rules::revoke_allowed(&rec.lender_device, &item.from_device) {
                    return Err(WireReject::Impersonation);
                }
                self.finish_in(&grant_id, Some(GrantEnd::Revoked));
            }
            Body::Return { grant_id } => {
                let rec = self.grant_rec(&grant_id).filter(|g| g.view.direction == Direction::Out).ok_or(WireReject::BadItem)?;
                if !wire::rules::return_allowed(&rec.borrower_device, &item.from_device) {
                    return Err(WireReject::Impersonation);
                }
                self.finish_out(&grant_id, EndReason::Returned);
            }
            // Pings are answered before the lend service (`ping`); one that gets here is not for it.
            Body::Ack { .. } | Body::Ping { .. } | Body::Pong { .. } => return Ok(()),
        }
        self.changed();
        Ok(())
    }

    /// After a restart: grants I lend can't be served again, so they end and the borrower is told (a revoke with the
    /// reason "lender restarted"); grants I borrow get their shim back until their time is up.
    ///
    /// Why not resume serving them: the forwarder, the gate and its usage counts, and the refresh job live in
    /// memory only. Serving again after a restart would restart the request and token counts from zero, so a limit
    /// could be dodged by restarting. A revoke needs only the grant id and the borrower's device, which the saved
    /// state has already; nothing secret is added to the disk.
    pub fn resume(&self) {
        let now = self.now();
        let (ended_out, live_in): (Vec<String>, Vec<GrantRec>) = {
            let inner = lock(&self.inner);
            let out = inner.saved.grants.iter().filter(|g| g.view.direction == Direction::Out && g.view.state == GrantState::Active).map(|g| g.view.id.clone()).collect();
            let inn = inner.saved.grants.iter().filter(|g| g.view.direction == Direction::In && g.view.state == GrantState::Active).cloned().collect();
            (out, inn)
        };
        {
            let mut inner = lock(&self.inner);
            let mut told = Vec::new();
            for g in inner.saved.grants.iter_mut().filter(|g| ended_out.contains(&g.view.id)) {
                g.view.state = GrantState::Ended;
                g.view.end_reason = Some(if now >= g.view.ends_ms { GrantEnd::Expired } else { GrantEnd::Revoked });
                // The borrower knows an expired lend ended by itself; one cut short needs telling.
                if now < g.view.ends_ms {
                    told.push(PendingRevoke { grant_id: g.view.id.clone(), device: g.borrower_device.clone() });
                }
            }
            for p in told {
                if !inner.saved.pending_revokes.iter().any(|x| x.grant_id == p.grant_id) {
                    inner.saved.pending_revokes.push(p);
                }
            }
            self.save(&inner);
        }
        for id in &ended_out {
            let _ = self.deps.secrets.delete(&link_slot(id));
        }
        self.send_pending_revokes();
        for g in live_in {
            let secret = self.deps.secrets.get(&link_slot(&g.view.id)).ok().flatten().and_then(|s| unb64(&s));
            match (g.node.clone(), secret) {
                (Some(node), Some(secret)) if g.view.ends_ms > now => self.start_shim(&g.view.id, node, secret, g.view.ends_ms),
                _ => self.finish_in(&g.view.id, Some(GrantEnd::Expired)),
            }
        }
    }
}

impl Lend {
    /// Sends the revokes saved by `resume` off the calling thread, and tries again while the team is not reachable.
    fn send_pending_revokes(&self) {
        if lock(&self.inner).saved.pending_revokes.is_empty() {
            return;
        }
        let me = self.me.clone();
        (self.deps.spawn)(Box::pin(async move {
            for _ in 0..REVOKE_TRIES {
                let Some(svc) = me.upgrade() else { return };
                let worker = svc.clone();
                let left = tokio::task::spawn_blocking(move || worker.flush_revokes()).await.unwrap_or(1);
                if left == 0 {
                    return;
                }
                drop(svc);
                tokio::time::sleep(REVOKE_RETRY).await;
            }
        }));
    }

    /// One pass over the saved revokes. Returns how many are still to send.
    fn flush_revokes(&self) -> usize {
        let pending = lock(&self.inner).saved.pending_revokes.clone();
        if pending.is_empty() {
            return 0;
        }
        let Ok(session) = self.deps.team.session() else { return pending.len() };
        let mut done = Vec::new();
        for p in &pending {
            let body = Body::Revoke { grant_id: p.grant_id.clone(), reason: RESTARTED.into() };
            match wire::seal(&session, &p.device, body, self.now()) {
                Ok((payload, _)) => {
                    if self.deps.team.send(&payload).is_ok() {
                        done.push(p.grant_id.clone());
                    }
                }
                // The device is no longer on the team: nobody to tell.
                Err(_) => done.push(p.grant_id.clone()),
            }
        }
        let mut inner = lock(&self.inner);
        inner.saved.pending_revokes.retain(|p| !done.contains(&p.grant_id));
        self.save(&inner);
        inner.saved.pending_revokes.len()
    }

    /// Test link on one lend row, either side.
    ///
    /// Borrower: the real `pm/lend/1` handshake with the lender (nothing is forwarded), timed. Lender: this PC's
    /// own side (is the lend live, is the PC link up), and the borrower's PC pinged through the team relay.
    pub async fn test_link(&self, grant_id: &str) -> Result<LinkTest, String> {
        let rec = self.grant_rec(grant_id).ok_or("That lend is gone.")?;
        let fail = |message: &str| Ok(LinkTest { ok: false, ms: None, via: None, message: message.to_string() });
        if rec.view.state != GrantState::Active {
            return fail(ENDED);
        }
        match rec.view.direction {
            Direction::In => {
                let hint = rec.node.clone().ok_or("This lend has no PC address.")?;
                let Some(secret) = self.deps.secrets.get(&link_slot(grant_id)).ok().flatten().and_then(|s| unb64(&s)) else {
                    return fail("The lender's PC no longer has this lend; ask again");
                };
                match self.deps.net.probe(&hint, grant_id, &secret).await {
                    Ok(p) => Ok(link_ok(p)),
                    Err(e) => {
                        if e == ConnectError::Ended {
                            self.finish_in(grant_id, None);
                        }
                        fail(&e.plain(!hint.relay.is_empty()))
                    }
                }
            }
            Direction::Out => {
                let links = {
                    let inner = lock(&self.inner);
                    match inner.out.get(grant_id) {
                        Some(l) if l.gate.ended().is_none() => l.links.len(),
                        _ => return fail("This PC is no longer serving this lend."),
                    }
                };
                if let Err(e) = self.deps.net.start().await {
                    return fail(&format!("The PC link could not start: {e}"));
                }
                let r = self.deps.pinger.ping_device(&rec.borrower_device).await;
                let Some(ms) = r.ms.filter(|_| r.ok) else {
                    return fail("The borrower's PC isn't answering (is the app open?)");
                };
                let link = if links > 0 { "a link is open" } else { "no link open yet" };
                Ok(LinkTest { ok: true, ms: Some(ms), via: r.via, message: format!("OK. The borrower's PC answers in {ms} ms through the team relay; {link}.") })
            }
        }
    }

    /// The PC link round trip to every lender I am borrowing from right now, by lender device. A lender that does
    /// not answer in time is left out (the Team page then shows the relay mailbox figure).
    pub async fn probe_lenders(&self, within: Duration) -> HashMap<String, Probe> {
        let now = self.now();
        let targets: Vec<(String, NodeHint, String, Vec<u8>)> = {
            let inner = lock(&self.inner);
            inner
                .saved
                .grants
                .iter()
                .filter(|g| g.view.direction == Direction::In && g.view.state == GrantState::Active && g.view.ends_ms > now)
                .filter_map(|g| {
                    let secret = self.deps.secrets.get(&link_slot(&g.view.id)).ok().flatten().and_then(|s| unb64(&s))?;
                    Some((g.lender_device.clone(), g.node.clone()?, g.view.id.clone(), secret))
                })
                .collect()
        };
        let mut tasks = Vec::new();
        for (device, hint, id, secret) in targets {
            let net = self.deps.net.clone();
            tasks.push(tokio::spawn(async move {
                let probe = tokio::time::timeout(within, net.probe(&hint, &id, &secret)).await.ok().and_then(Result::ok);
                (device, probe)
            }));
        }
        let mut out = HashMap::new();
        for t in tasks {
            if let Ok((device, Some(p))) = t.await {
                out.insert(device, p);
            }
        }
        out
    }
}

fn link_ok(p: Probe) -> LinkTest {
    let direct = p.path == crate::p2p::endpoint::PathKind::Direct;
    let ms = p.rtt.as_millis() as u64;
    LinkTest {
        ok: true,
        ms: Some(ms),
        via: Some(if direct { super::ping::VIA_DIRECT } else { super::ping::VIA_RELAY }.into()),
        message: format!("OK. The link answers in {ms} ms{}.", if direct { ", direct" } else { " via relay" }),
    }
}

fn end_of(reason: EndReason) -> GrantEnd {
    match reason {
        EndReason::Revoked | EndReason::Stopped => GrantEnd::Revoked,
        EndReason::Returned => GrantEnd::Returned,
        EndReason::Expired => GrantEnd::Expired,
    }
}

impl LenderBook for Lend {
    fn borrower_allowed(&self, peer: &NodeId) -> bool {
        lock(&self.inner).out.values().any(|l| l.borrower_node == *peer && l.gate.ended().is_none())
    }

    fn lookup(&self, grant_id: &str) -> Option<LenderGrant> {
        lock(&self.inner).out.get(grant_id).map(|l| LenderGrant {
            borrower_node: l.borrower_node,
            secret: l.secret.clone(),
            gate: l.gate.clone(),
            forwarder: l.forwarder.clone(),
        })
    }

    fn add_link(&self, grant_id: &str, link: Arc<dyn Link>) {
        if let Some(l) = lock(&self.inner).out.get_mut(grant_id) {
            l.links.retain(|x| !x.peer().eq(&link.peer()) || !Arc::ptr_eq(x, &link));
            l.links.push(link);
        }
    }
}
