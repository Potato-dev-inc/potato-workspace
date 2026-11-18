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
use super::shim::{NotingOpener, Shim};
use super::signin::SigninFile;
use super::spec::{ProxySpec, RefreshSpec};
use super::wire::{self, Body, Guard, Item, NodeHint, Offer, WireReject};
use crate::p2p::endpoint::{Link, NodeId};
use crate::secrets::SecretBackend;
use crate::secure_core::crypto::{b64, random_bytes, unb64};
use crate::team::secure::{CapacityIn, Payload, Session};
use crate::tui::LaunchEnv;

/// Pass a task (`team::direct`): the sender's earlier click, "run it through my lent usage", kept as one bound promise.
/// `claim` is true at most once for a request that names the task, comes from the member it was promised to, asks for the
/// promised profile and no more time than promised. Anything else is left for the lender's own card.
pub trait OfferGate: Send + Sync {
    fn claim(&self, offer_ref: &str, member_id: &str, device_id: &str, profile_id: Option<&str>, secs: u64) -> bool;
}

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
/// What the borrower shows on a grant whose lending PC does not answer (asleep or offline).
pub const UNREACHABLE_PROBLEM: &str = "The lending PC is not answering. It may be asleep or offline.";

/// Why a grant has a problem right now (`Grant.problem_kind`): so each screen picks words that fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProblemKind {
    /// The lender's sign-in is out or can't be renewed.
    Signin,
    /// The borrower can't reach the lender's PC.
    Unreachable,
}

impl ProblemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Signin => "signin",
            Self::Unreachable => "unreachable",
        }
    }

    fn words(self) -> &'static str {
        match self {
            Self::Signin => SIGNIN_PROBLEM,
            Self::Unreachable => UNREACHABLE_PROBLEM,
        }
    }
}

/// The longest profile name kept from another PC.
pub const MAX_PROFILE_NAME: usize = 60;

/// A profile name that came from another PC (or goes to one): plain text only. Control characters become spaces, runs of
/// space collapse, the ends are trimmed and it is cut to 60 characters. Never used as HTML or as a file name.
pub fn clean_profile_name(raw: &str) -> String {
    let plain: String = raw.chars().map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect();
    plain.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_PROFILE_NAME).collect()
}

/// The borrowed sign-in's name in pickers: "Ren's Work account (borrowed)". A profile name that already starts with the
/// owner ("Ren's work account") is not prefixed again; from my own other PC it is "Work account on Desk-PC (borrowed)";
/// with no name (an older lender) it is "Ren's PC (borrowed)".
pub fn borrowed_name(owner: &str, device: &str, profile: &str, mine: bool) -> String {
    let profile = clean_profile_name(profile);
    if profile.is_empty() {
        return format!("{owner}'s PC (borrowed)");
    }
    if mine && !device.is_empty() {
        return format!("{profile} on {device} (borrowed)");
    }
    if !owner.is_empty() && profile.to_lowercase().starts_with(&owner.to_lowercase()) {
        return format!("{profile} (borrowed)");
    }
    format!("{owner}'s {profile} (borrowed)")
}

/// How often an active lend sign-in's expiry is looked at, and the least time between two refreshes of it.
const REFRESH_TICK: Duration = if cfg!(test) { Duration::from_millis(100) } else { Duration::from_secs(60) };
const REFRESH_GAP_MS: u64 = if cfg!(test) { 800 } else { 5 * 60 * 1000 };

/// Whether `profile` may be lent to `member`: my own PCs for my own PCs; a teammates profile for the people it names
/// (none named: anyone on the team). The one rule behind the offers, the Lend card and the answer.
pub fn profile_allows(profile: &LendProfile, member_id: &str, other_person: bool) -> bool {
    if other_person {
        profile.who == LendWho::Teammates && (profile.member_ids.is_empty() || profile.member_ids.iter().any(|m| m == member_id))
    } else {
        profile.who == LendWho::MyPcs
    }
}

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
    /// "Show usage in the usage bar": this profile's own sign-in is a row in the lender's usage bar and its numbers are
    /// shared with a borrower. Off unless turned on.
    #[serde(default)]
    pub show_usage: bool,
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
    /// What kind of problem (`signin`, `unreachable`), so the words fit. None while there is none.
    #[serde(default)]
    pub problem_kind: Option<String>,
    /// The lender's name for the profile this lend comes from. Borrower: as the lender sent it, cleaned (empty from an
    /// older lender). Lender: the profile's own name.
    #[serde(default)]
    pub profile_name: String,
    /// When it ended (any reason). None while it runs, and for a grant saved by an older build (then `ends_ms` is used).
    #[serde(default)]
    pub ended_ms: Option<u64>,
    /// Lender only: which of my profiles this lend comes from (so the screen can say a profile is lent right now).
    #[serde(default)]
    pub profile_id: String,
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
    /// The lender's profile the borrower asked for (picked from the offers). None: the lender chooses.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Incoming only: that profile's name on this PC (filled when the state is read).
    #[serde(default)]
    pub profile_name: String,
}

/// One offer as the borrower's screen sees it: the lender's words plus which of their PCs said it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OfferView {
    #[serde(flatten)]
    pub offer: Offer,
    pub device_id: String,
    pub device_name: String,
}

/// What `offers` found: `answered` false means no PC of theirs answered in time (an older build, or asleep).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OffersResult {
    pub answered: bool,
    pub offers: Vec<OfferView>,
}

/// An `OffersAsk` of mine that is waiting for answers.
struct PendingOffers {
    member: String,
    asked: Vec<String>,
    got: HashMap<String, Vec<Offer>>,
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

/// What the sign-in step reads about one lend sign-in. The identity is shown on this PC only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SigninStatus {
    /// `signed_in`, `signed_out` or `expired`.
    pub state: &'static str,
    pub identity: Option<String>,
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

/// One lend control item between two of the person's OWN paired PCs. The sender is never named here: the far side takes it
/// from the device link that carried it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnItem {
    pub msg_id: String,
    pub sent_ms: u64,
    pub body: Body,
}

/// The device link, as the lend service needs it for items between my own PCs (no Team needed).
pub trait OwnPort: Send + Sync {
    /// Delivers `item` to the paired PC `node` (64 hex). A refusal or an unreachable PC is an error in plain words.
    fn send(&self, node: &str, item: &OwnItem) -> Result<(), String>;
    /// The paired PCs that may be used for lending: `(node hex, name)`.
    fn peers(&self) -> Vec<(String, String)>;
    /// This PC's node id on the device link, when it is up.
    fn my_node(&self) -> Option<String>;
    fn my_name(&self) -> String;
}

/// No device link: lending between my own PCs is not available (the Team path is unchanged).
#[cfg(test)]
pub struct NoOwn;

#[cfg(test)]
impl OwnPort for NoOwn {
    fn send(&self, _node: &str, _item: &OwnItem) -> Result<(), String> {
        Err("Devices is off, so this PC cannot reach your other PCs.".into())
    }
    fn peers(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    fn my_node(&self) -> Option<String> {
        None
    }
    fn my_name(&self) -> String {
        String::new()
    }
}

/// Own PCs have no team member id: the person is always "me".
pub const OWN_MEMBER: &str = "me";
/// An own device id is `node:<64 hex>` (the device-link node), so it can never be mistaken for a team device id.
pub const OWN_PREFIX: &str = "node:";

/// The node hex of an own device id, when it is one.
pub fn own_node(device: &str) -> Option<&str> {
    device.strip_prefix(OWN_PREFIX).filter(|h| crate::own_lend::is_node_hex(h))
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
    /// The device link for items between my own PCs.
    pub own: Arc<dyn OwnPort>,
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
    /// Borrower: the numbers each lender shared for a grant. In memory only.
    shared: HashMap<String, crate::usage::Shared>,
}

pub struct Lend {
    deps: Deps,
    inner: Mutex<Inner>,
    /// Whether the awake hold is on (taken once for all outgoing lends, not per grant).
    awake_on: Mutex<bool>,
    /// Offers I asked for and have not finished collecting (nonce -> who and what came back).
    offers_wait: Mutex<HashMap<String, PendingOffers>>,
    offer_gate: Mutex<Option<Arc<dyn OfferGate>>>,
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
        // Older builds named a lend sign-in "Lend Claude 3"; it now carries the name of the profile that uses it.
        for p in &saved.profiles {
            if let LendAccount::Account { id } = &p.account {
                let shared = saved.profiles.iter().any(|x| x.id != p.id && matches!(&x.account, LendAccount::Account { id: other } if other == id));
                if !shared {
                    super::signin_pane::relabel_for_profile(&deps.accounts, id, &p.name);
                }
            }
        }
        let svc = Arc::new_cyclic(|me| Self {
            deps,
            inner: Mutex::new(Inner { saved, out: HashMap::new(), inn: HashMap::new(), in_grants: HashMap::new(), shared: HashMap::new() }),
            awake_on: Mutex::new(false),
            offers_wait: Mutex::new(HashMap::new()),
            offer_gate: Mutex::new(None),
            me: me.clone(),
        });
        let book: Weak<dyn LenderBook> = svc.me.clone();
        svc.deps.net.set_book(book);
        svc
    }

    pub fn net(&self) -> Arc<LendNet> {
        self.deps.net.clone()
    }

    /// Pass a task: the one place a lend can be answered without a click (see [`OfferGate`]).
    pub fn set_offer_gate(&self, gate: Arc<dyn OfferGate>) {
        *lock(&self.offer_gate) = Some(gate);
    }

    /// A profile of mine that may be promised to `member_id` with a task: its name and agents (words only).
    pub fn profile_for_task(&self, member_id: &str, profile_id: &str, secs: u64) -> Result<(String, Vec<String>), String> {
        let inner = lock(&self.inner);
        let p = inner.saved.profiles.iter().find(|p| p.id == profile_id).ok_or("That lend profile is gone.")?;
        if !profile_allows(p, member_id, true) {
            return Err("That lend profile is not for this person.".into());
        }
        if secs < MIN_SECS || secs > p.max_secs.min(CAP_OTHER_SECS) {
            return Err("That is longer than this profile allows.".into());
        }
        Ok((clean_profile_name(&p.name), p.agent_ids.clone()))
    }

    fn now(&self) -> u64 {
        (self.deps.now)()
    }

    /// This PC's id among my own devices (`node:<hex>`), when the device link is up.
    fn my_own_device(&self) -> String {
        self.deps.own.my_node().map(|h| format!("{OWN_PREFIX}{h}")).unwrap_or_default()
    }

    /// The name I gave a paired PC, for a row.
    fn own_name(&self, node_hex: &str) -> String {
        self.deps.own.peers().into_iter().find(|(n, _)| n == node_hex).map(|(_, name)| name).unwrap_or_default()
    }

    /// The team session, unless every device named is one of my own PCs (those need no Team).
    fn session_for(&self, devices: &[&str]) -> Result<Option<Session>, String> {
        if !devices.is_empty() && devices.iter().all(|d| own_node(d).is_some()) {
            return Ok(None);
        }
        self.deps.team.session().map(Some)
    }

    /// Sends one item to a device: a `node:` id goes over the device link, any other over the team relay.
    fn send_to(&self, session: Option<&Session>, to: &str, body: Body) -> Result<(), String> {
        let now = self.now();
        if let Some(node) = own_node(to) {
            let item = OwnItem { msg_id: wire::new_msg_id(now), sent_ms: now, body };
            return self.deps.own.send(node, &item);
        }
        let session = session.ok_or("The team is not connected.")?;
        let (payload, _) = wire::seal(session, to, body, now)?;
        self.deps.team.send(&payload)
    }

    /// An item from one of my own PCs, over the device link. `from_node` is the sender the link proved (never from the
    /// body); the body is an [`OwnItem`]. It goes through the same checks and rules as a team item.
    pub fn on_own_item(&self, from_node: &str, raw: serde_json::Value) -> Result<serde_json::Value, String> {
        if !crate::own_lend::is_node_hex(from_node) || !self.deps.own.peers().iter().any(|(n, _)| n == from_node) {
            return Err("That PC is not one of yours.".into());
        }
        let own: OwnItem = serde_json::from_value(raw).map_err(|_| "That is not a lend item.".to_string())?;
        let now = self.now();
        if own.sent_ms > now.saturating_add(wire::MAX_FUTURE_MS) || own.msg_id.is_empty() || own.msg_id.len() > 64 {
            return Err("That item was refused.".into());
        }
        if let Body::Request { reason, .. } = &own.body {
            if reason.chars().count() > wire::MAX_REASON {
                return Err("That item was refused.".into());
            }
        }
        let me = self.my_own_device();
        let item = Item {
            v: wire::VERSION,
            msg_id: own.msg_id,
            team: String::new(),
            from_member: OWN_MEMBER.into(),
            from_device: format!("{OWN_PREFIX}{from_node}"),
            to: me,
            sent_ms: own.sent_ms,
            body: own.body,
        };
        {
            let mut inner = lock(&self.inner);
            inner.saved.guard.fresh(&item.msg_id, now).map_err(|_| "That item was already received.".to_string())?;
            self.save(&inner);
        }
        self.apply(None, item, now).map(|_| serde_json::json!({ "ok": true })).map_err(|r| match r {
            WireReject::Replay => "That item was already received.".to_string(),
            _ => "That item was refused.".to_string(),
        })
    }

    /// Ask one of my own PCs (a paired device with Borrow switched on there) to lend an agent. No Team needed.
    pub fn request_own(&self, node_hex: &str, agent_id: &str, secs: u64, reason: &str, profile_id: Option<&str>, profile_name: Option<&str>) -> Result<LendRequest, String> {
        if self.spec(agent_id).is_none() {
            return Err(format!("{agent_id} can't be borrowed through a PC."));
        }
        let reason = reason.trim();
        if reason.chars().count() > wire::MAX_REASON {
            return Err("The reason is too long (280 characters at most).".into());
        }
        if !crate::own_lend::is_node_hex(node_hex) {
            return Err("That PC is not one of yours.".into());
        }
        let peer_name = self.deps.own.peers().into_iter().find(|(n, _)| n == node_hex).map(|(_, name)| name).ok_or("That PC is not one of yours.")?;
        if secs < MIN_SECS || secs > cap_for(false) {
            return Err("The most is 7 days.".into());
        }
        let node = self.deps.net.my_node()?.to_hex();
        let now = self.now();
        let request_id = short_id("lr");
        let device = format!("{OWN_PREFIX}{node_hex}");
        let body = Body::Request {
            request_id: request_id.clone(),
            agent_id: agent_id.to_string(),
            mode: MODE.into(),
            duration_ms: secs * 1000,
            reason: reason.to_string(),
            device_name: self.deps.own.my_name(),
            node_hint: node.clone(),
            profile_id: profile_id.map(str::to_string),
            offer_ref: None,
        };
        let view = LendRequest {
            id: request_id,
            direction: Direction::Out,
            member_id: OWN_MEMBER.into(),
            member_name: String::new(),
            device_name: peer_name,
            agent_id: agent_id.to_string(),
            secs,
            reason: reason.to_string(),
            at_ms: now,
            for_other_person: false,
            state: RequestState::Open,
            profile_id: profile_id.map(str::to_string),
            profile_name: profile_name.map(clean_profile_name).unwrap_or_default(),
        };
        let mut inner = lock(&self.inner);
        inner.saved.requests.push(RequestRec { view: view.clone(), devices: vec![device.clone()], node_hint: node });
        self.save(&inner);
        drop(inner);
        // The record exists before the item leaves: an answer may come back at once.
        if let Err(e) = self.send_to(None, &device, body) {
            let mut inner = lock(&self.inner);
            inner.saved.requests.retain(|r| r.view.id != view.id);
            self.save(&inner);
            return Err(e);
        }
        self.changed();
        Ok(view)
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
        self.sync_usage_view();
        (self.deps.changed)()
    }

    /// What the usage bar needs of the lend side: the profiles' sign-ins (and whether each is shown) and the grants
    /// lent to this PC, named by the lender's profile name.
    pub fn usage_view(&self) -> crate::usage::LendView {
        let now = self.now();
        let inner = lock(&self.inner);
        let profiles = inner
            .saved
            .profiles
            .iter()
            .filter_map(|p| match &p.account {
                LendAccount::Account { id } => Some(crate::usage::LendProfileView { account_id: id.clone(), name: p.name.clone(), show_usage: p.show_usage }),
                LendAccount::Main => None,
            })
            .collect();
        let borrowed = inner
            .saved
            .grants
            .iter()
            .filter(|g| g.view.direction == Direction::In && g.view.state == GrantState::Active && g.view.ends_ms > now)
            .map(|g| crate::usage::BorrowedView {
                grant_id: g.view.id.clone(),
                agent_id: g.view.agent_id.clone(),
                name: borrowed_name(&g.view.peer_name, &g.view.peer_device_name, &g.view.profile_name, !g.view.for_other_person),
                shared: inner.shared.get(&g.view.id).cloned(),
            })
            .collect();
        crate::usage::LendView { profiles, borrowed }
    }

    /// Renews an idle lend sign-in for the usage bar: the access token of a sign-in nobody uses runs out every few hours, and
    /// only the agent's own CLI renews it. Runs that CLI once, hidden (the same renewal the refresher does for a lent
    /// sign-in), at most once in 30 minutes per sign-in. BLOCKING (the usage read runs on a blocking thread). Returns
    /// whether the CLI ran and finished fine; the caller reads the token again to see.
    pub fn renew_signin_blocking(&self, account_id: &str) -> bool {
        static LAST: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);
        let Ok((acc, spec)) = self.signin_target(account_id) else { return false };
        let Some(refresh) = spec.auth.account.as_ref().and_then(|a| a.refresh.clone()) else { return false };
        let now = self.now();
        {
            let mut last = lock(&LAST);
            let map = last.get_or_insert_with(HashMap::new);
            if map.get(account_id).is_some_and(|t| now.saturating_sub(*t) < 30 * 60_000) {
                return false;
            }
            map.insert(account_id.to_string(), now);
        }
        let job = RefreshJob {
            agent_id: acc.agent_id.clone(),
            account_id: account_id.to_string(),
            args: refresh.args.clone(),
            timeout_secs: refresh.timeout_secs,
            scratch: self.deps.dir.join("refresh"),
        };
        let wait = Duration::from_secs(refresh.timeout_secs + 10);
        let ran = tauri::async_runtime::block_on(tokio::time::timeout(wait, (self.deps.refresh)(job)));
        tracing::info!(ran_ok = matches!(ran, Ok(Ok(()))), "lend: idle sign-in renewed for the usage bar");
        matches!(ran, Ok(Ok(())))
    }

    pub fn sync_usage_view_pub(&self) {
        self.sync_usage_view();
    }

    /// Tells the usage bar when the lend side changed (a profile saved, a grant started or ended, numbers arrived).
    fn sync_usage_view(&self) {
        let view = self.usage_view();
        if crate::usage::set_lend_view(view) {
            crate::usage::invalidate();
        }
    }

    /// Past lends and borrows older than this are dropped from the saved state (not only hidden).
    pub const PAST_KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;

    /// Drops ended grants older than a week. Returns whether anything went.
    pub fn prune_past(&self) -> bool {
        let now = self.now();
        let mut inner = lock(&self.inner);
        let before = inner.saved.grants.len();
        inner.saved.grants.retain(|g| {
            g.view.state != GrantState::Ended || now.saturating_sub(g.view.ended_ms.unwrap_or(g.view.ends_ms)) < Self::PAST_KEEP_MS
        });
        let gone = inner.saved.grants.len() != before;
        if gone {
            self.save(&inner);
        }
        gone
    }

    /// Tests: makes every ended row look as if it ended `ms` earlier.
    #[cfg(test)]
    pub fn age_ended_for_test(&self, ms: u64) {
        let mut inner = lock(&self.inner);
        for g in inner.saved.grants.iter_mut().filter(|g| g.view.state == GrantState::Ended) {
            g.view.ended_ms = Some(g.view.ended_ms.unwrap_or(g.view.ends_ms).saturating_sub(ms));
            g.view.ends_ms = g.view.ends_ms.saturating_sub(ms);
        }
    }

    /// Removes one ended row (the X on a past lend or borrow). A lend that still runs is never removed here.
    pub fn dismiss_grant(&self, grant_id: &str) -> bool {
        let mut inner = lock(&self.inner);
        let before = inner.saved.grants.len();
        inner.saved.grants.retain(|g| !(g.view.id == grant_id && g.view.state == GrantState::Ended));
        let gone = inner.saved.grants.len() != before;
        if gone {
            self.save(&inner);
        }
        drop(inner);
        if gone {
            self.changed();
        }
        gone
    }

    /// "Clear" on the past lends (`Out`) or past borrows (`In`). Returns how many went.
    pub fn clear_past(&self, direction: Direction) -> usize {
        let mut inner = lock(&self.inner);
        let before = inner.saved.grants.len();
        inner.saved.grants.retain(|g| !(g.view.direction == direction && g.view.state == GrantState::Ended));
        let n = before - inner.saved.grants.len();
        if n > 0 {
            self.save(&inner);
        }
        drop(inner);
        if n > 0 {
            self.changed();
        }
        n
    }

    /// Lender: send the borrower of each running lend the limit numbers of the account behind it, when the profile says so.
    /// `numbers(account id)` gives the plan name and windows the usage bar read for that sign-in.
    pub fn share_usage(&self, numbers: &dyn Fn(&str) -> Option<(Option<String>, Vec<crate::usage::readers::Window>)>) {
        let session = self.deps.team.session().ok();
        let sends: Vec<(String, String, Option<String>, Vec<wire::WireWindow>)> = {
            let inner = lock(&self.inner);
            inner
                .saved
                .grants
                .iter()
                .filter(|g| g.view.direction == Direction::Out && g.view.state == GrantState::Active)
                .filter_map(|g| {
                    let p = inner.saved.profiles.iter().find(|p| Some(&p.id) == g.profile_id.as_ref())?;
                    let LendAccount::Account { id } = &p.account else { return None };
                    if !p.show_usage {
                        return None;
                    }
                    let (plan, windows) = numbers(id)?;
                    let windows = windows
                        .iter()
                        .filter(|w| !w.reset_since)
                        .take(wire::MAX_WIRE_WINDOWS)
                        .map(|w| wire::WireWindow { name: clean_profile_name(&w.name), used_percent: w.used_percent.clamp(0.0, 1000.0).round() as u32, minutes: w.minutes, resets_at_ms: w.resets_at_ms })
                        .collect::<Vec<_>>();
                    (!windows.is_empty()).then(|| (g.view.id.clone(), g.borrower_device.clone(), plan, windows))
                })
                .collect()
        };
        for (grant_id, device, plan, windows) in sends {
            let body = Body::Usage { grant_id, plan, windows };
            if own_node(&device).is_none() && session.is_none() {
                continue;
            }
            let _ = self.send_to(session.as_ref(), &device, body);
        }
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

    pub fn spec(&self, agent_id: &str) -> Option<&ProxySpec> {
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
        let pick = |d: Direction| {
            inner
                .saved
                .requests
                .iter()
                .filter(|r| r.view.direction == d)
                .map(|r| {
                    let mut v = r.view.clone();
                    if d == Direction::In {
                        v.profile_name = v.profile_id.as_ref().and_then(|id| inner.saved.profiles.iter().find(|p| &p.id == id)).map(|p| p.name.clone()).unwrap_or_default();
                    }
                    v
                })
                .collect()
        };
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

    // ------------------------------------------------------------------------------------------------- sign-in step

    /// The lend sign-in `account_id` (a lend-only account of this PC) and the spec of its agent.
    fn signin_target(&self, account_id: &str) -> Result<(crate::accounts::Account, ProxySpec), String> {
        let acc = super::signin_pane::check_account(&self.deps.accounts, account_id)?;
        self.account_lendable(&acc.agent_id)?;
        let spec = self.spec(&acc.agent_id).cloned().ok_or_else(|| format!("{} can't be lent through this PC.", acc.agent_id))?;
        Ok((acc, spec))
    }

    /// The lend sign-in to start the sign-in step on: a new one, or the draft's own when it is still signed out.
    pub fn signin_account(&self, agent_id: &str, label: &str, reuse: Option<&str>) -> Result<crate::accounts::Account, String> {
        self.account_lendable(agent_id)?;
        let spec = self.spec(agent_id).cloned().ok_or_else(|| format!("{agent_id} can't be lent through this PC."))?;
        super::signin_pane::add_or_reuse(&self.deps.accounts, &spec, agent_id, label, reuse, self.now())
    }

    /// The account to open a hidden sign-in pane for (checked: lend-only, not borrowed, lendable).
    pub fn signin_pane_account(&self, account_id: &str) -> Result<crate::accounts::Account, String> {
        Ok(self.signin_target(account_id)?.0)
    }

    /// Where the lend sign-in stands, and who is signed in (read on this PC only; never sent).
    pub fn signin_status(&self, account_id: &str) -> Result<SigninStatus, String> {
        let (acc, spec) = self.signin_target(account_id)?;
        let (state, identity) = super::signin_pane::status_of(&spec, &acc, self.now())?;
        Ok(SigninStatus { state: state.as_str(), identity })
    }

    /// Forgets the lend sign-in when it holds no sign-in (the person backed out before signing in).
    pub fn signin_remove_if_empty(&self, account_id: &str) -> Result<bool, String> {
        let (acc, spec) = self.signin_target(account_id)?;
        super::signin_pane::remove_if_empty(&self.deps.accounts, &spec, &acc)
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
        // A sign-in shared by several profiles keeps its label: renaming it after one profile would relabel the others'.
        if let LendAccount::Account { id } = &p.account {
            let shared = lock(&self.inner).saved.profiles.iter().any(|x| x.id != p.id && matches!(&x.account, LendAccount::Account { id: other } if other == id));
            if !shared {
                super::signin_pane::relabel_for_profile(&self.deps.accounts, id, &p.name);
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
        // Deleting a profile takes back what is lent from it right now (the screen asks first and says so).
        let lent: Vec<String> = lock(&self.inner)
            .saved
            .grants
            .iter()
            .filter(|g| g.view.direction == Direction::Out && g.view.state == GrantState::Active && g.profile_id.as_deref() == Some(id))
            .map(|g| g.view.id.clone())
            .collect();
        for grant_id in lent {
            let _ = self.revoke(&grant_id);
        }
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
    ///
    /// Each kind clears only itself: a link that works again does not hide a sign-in that is out.
    fn set_problem(&self, grant_id: &str, kind: ProblemKind, bad: bool) {
        {
            let mut inner = lock(&self.inner);
            let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id && g.view.state == GrantState::Active) else { return };
            if bad {
                if g.view.problem_kind.as_deref() == Some(kind.as_str()) {
                    return;
                }
                g.view.problem = Some(kind.words().to_string());
                g.view.problem_kind = Some(kind.as_str().to_string());
            } else {
                if g.view.problem_kind.as_deref() != Some(kind.as_str()) && g.view.problem.is_some() {
                    return;
                }
                if g.view.problem.is_none() {
                    return;
                }
                g.view.problem = None;
                g.view.problem_kind = None;
            }
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
                svc.set_problem(&id, ProblemKind::Signin, bad);
            }
        })
    }

    /// Told by the borrower's opener: the lending PC does not answer (true) or answers again (false).
    fn reach_note(&self, grant_id: &str) -> SigninNote {
        let (me, id) = (self.me.clone(), grant_id.to_string());
        Arc::new(move |bad| {
            if let Some(svc) = me.upgrade() {
                svc.set_problem(&id, ProblemKind::Unreachable, bad);
            }
        })
    }

    // ------------------------------------------------------------------------------------------------- asking

    #[cfg(test)]
    pub fn request(&self, member_id: &str, device_id: Option<&str>, agent_id: &str, secs: u64, reason: &str) -> Result<LendRequest, String> {
        self.request_with_profile(member_id, device_id, agent_id, secs, reason, None, None)
    }

    /// `request`, naming the lender's profile picked from its offers (None: the lender chooses).
    pub fn request_with_profile(&self, member_id: &str, device_id: Option<&str>, agent_id: &str, secs: u64, reason: &str, profile_id: Option<&str>, profile_name: Option<&str>) -> Result<LendRequest, String> {
        self.request_inner(member_id, device_id, agent_id, secs, reason, profile_id, profile_name, None)
    }

    /// `request_with_profile` for a passed task: the request names the task (`offer_ref`), so the sender's promise can match it.
    pub fn request_for_task(&self, member_id: &str, device_id: &str, agent_id: &str, secs: u64, reason: &str, profile_id: &str, profile_name: &str, task_id: &str) -> Result<LendRequest, String> {
        self.request_inner(member_id, Some(device_id), agent_id, secs, reason, Some(profile_id), Some(profile_name), Some(task_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn request_inner(&self, member_id: &str, device_id: Option<&str>, agent_id: &str, secs: u64, reason: &str, profile_id: Option<&str>, profile_name: Option<&str>, offer_ref: Option<&str>) -> Result<LendRequest, String> {
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
                profile_id: profile_id.map(str::to_string),
                offer_ref: offer_ref.map(str::to_string),
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
            profile_id: profile_id.map(str::to_string),
            // The name the lender's offer gave it (words only; cleaned), so my own list can say what I asked for.
            profile_name: profile_name.map(clean_profile_name).unwrap_or_default(),
        };
        let mut inner = lock(&self.inner);
        inner.saved.requests.push(RequestRec { view: view.clone(), devices, node_hint: node });
        self.save(&inner);
        drop(inner);
        self.changed();
        Ok(view)
    }

    // ------------------------------------------------------------------------------------------------- lending

    /// A request that names a passed task: if the sender's own earlier click promised exactly this (same person, same
    /// profile, no more time, not used yet), say yes now. Everything else about the lend is the normal `answer`.
    fn answer_if_promised(&self, request_id: &str, offer_ref: Option<&str>, member_id: &str, device_id: &str, profile_id: Option<&str>, secs: u64) {
        let Some(offer_ref) = offer_ref.filter(|r| !r.is_empty() && r.len() <= 64) else { return };
        let Some(gate) = lock(&self.offer_gate).clone() else { return };
        if !gate.claim(offer_ref, member_id, device_id, profile_id, secs) {
            return;
        }
        let Some(me) = self.me.upgrade() else { return };
        let (id, profile, secs) = (request_id.to_string(), profile_id.map(str::to_string), secs);
        (self.deps.spawn)(Box::pin(async move {
            if let Err(why) = me.answer(&id, true, profile.as_deref(), Some(secs)).await {
                tracing::info!(why, "lend: the promised lend could not start");
            }
        }));
    }

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
        let to = req.devices.first().cloned().ok_or("That request is gone.")?;
        let session = self.session_for(&[to.as_str()])?;
        if !accept {
            self.send_to(session.as_ref(), &to, Body::Decline { request_id: request_id.into() })?;
            self.set_request_state(request_id, Direction::In, RequestState::Declined);
            return Ok(None);
        }
        let spec = self.spec(&req.view.agent_id).cloned().ok_or("This agent can't be lent through this PC.")?;
        // The profile the lender picked on the card, else the one the borrower asked for, else the first that fits.
        let wanted = profile_id.map(str::to_string).or_else(|| req.view.profile_id.clone());
        let profile = {
            let inner = lock(&self.inner);
            match wanted.as_deref() {
                Some(id) => inner.saved.profiles.iter().find(|p| p.id == id).cloned(),
                None => inner.saved.profiles.iter().find(|p| p.agent_ids.iter().any(|a| a.eq_ignore_ascii_case(&req.view.agent_id))).cloned(),
            }
        }
        .ok_or("Pick a lend profile first.")?;
        if !profile.agent_ids.iter().any(|a| a.eq_ignore_ascii_case(&req.view.agent_id)) {
            return Err("That profile doesn't lend this agent.".into());
        }
        // A profile is only for the people it names, whoever picked it (a borrower may name any id it was never offered).
        if !profile_allows(&profile, &req.view.member_id, req.view.for_other_person) {
            return Err("That profile is not for this person.".into());
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
        let peer = session.as_ref().and_then(|s| s.roster.member(&req.view.member_id));
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
            problem_kind: None,
            profile_name: profile.name.clone(),
            ended_ms: None,
            profile_id: profile.id.clone(),
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
            device_name: match &session {
                Some(s) => s.roster.device(&s.my_device()?).map(|(_, d)| d.name.clone()).unwrap_or_default(),
                None => self.deps.own.my_name(),
            },
            profile_name: clean_profile_name(&profile.name),
        };
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
                lender_device: match &session {
                    Some(s) => s.my_device()?,
                    None => self.my_own_device(),
                },
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
        if let Err(e) = self.send_to(session.as_ref(), &to, body) {
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
            None => return self.set_problem(grant_id, ProblemKind::Signin, true),
            Some(None) => return,
            Some(Some(at)) => at,
        };
        if at > now.saturating_add(plan.refresh.before_secs.saturating_mul(1000)) {
            return self.set_problem(grant_id, ProblemKind::Signin, false);
        }
        if at <= now {
            self.set_problem(grant_id, ProblemKind::Signin, true);
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
        self.set_problem(grant_id, ProblemKind::Signin, !fine);
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
                g.view.ended_ms = Some(self.now());
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
        let session = self.session_for(&[rec.borrower_device.as_str()])?;
        self.send_to(session.as_ref(), &rec.borrower_device, Body::Revoke { grant_id: grant_id.into(), reason: String::new() })
    }

    /// Give back now (borrower).
    pub fn give_back(&self, grant_id: &str) -> Result<(), String> {
        let rec = self.grant_rec(grant_id).filter(|g| g.view.direction == Direction::In).ok_or("That lend is gone.")?;
        self.finish_in(grant_id, Some(GrantEnd::Returned));
        let session = self.session_for(&[rec.lender_device.as_str()])?;
        self.send_to(session.as_ref(), &rec.lender_device, Body::Return { grant_id: grant_id.into() })
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
            g.view.ended_ms = Some(now);
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
        let reach = self.reach_note(grant_id);
        let usage = self.usage_note(grant_id);
        let left = ends_ms.saturating_sub(self.now());
        let max_body = self.grant_rec(grant_id).and_then(|r| self.spec(&r.view.agent_id).map(|s| s.max_body_bytes)).unwrap_or(super::spec::MAX_BODY_CAP);
        (self.deps.spawn)(Box::pin(async move {
            let opener = LinkOpener::new(net, g.clone());
            let noting = NotingOpener::new(opener.clone(), reach);
            let shim = match Shim::start_with(noting, max_body, Some(note), usage).await {
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
                    "label": borrowed_name(&g.view.peer_name, &g.view.peer_device_name, &g.view.profile_name, !g.view.for_other_person),
                    "profile_name": g.view.profile_name,
                    "owner": g.view.peer_name,
                    "ends_ms": g.view.ends_ms,
                    "grant_id": g.view.id,
                    "chat": self.spec(&g.view.agent_id).is_some_and(|s| s.chat.is_some()),
                })
            })
            .collect()
    }

    pub fn borrowed_label(&self, grant_id: &str) -> Option<String> {
        self.grant_rec(grant_id)
            .filter(|g| g.view.direction == Direction::In)
            .map(|g| borrowed_name(&g.view.peer_name, &g.view.peer_device_name, &g.view.profile_name, !g.view.for_other_person))
    }

    pub fn grant_agent(&self, grant_id: &str) -> Option<(String, GrantState, Direction)> {
        self.grant_rec(grant_id).map(|g| (g.view.agent_id, g.view.state, g.view.direction))
    }

    /// Lender: usage so far (tests and the view).
    #[cfg(test)]
    pub fn usage(&self, grant_id: &str) -> Option<super::gate::Usage> {
        lock(&self.inner).out.get(grant_id).map(|l| l.gate.usage())
    }

    // ------------------------------------------------------------------------------------------------- offers

    /// What this PC offers `asker`: only profiles that person could really borrow (the same rule as who may ask). Never a
    /// profile that is for my own PCs to a teammate. Names and numbers only.
    fn offers_for(&self, asker_member: &str, me_member: &str) -> Vec<Offer> {
        let other = asker_member != me_member;
        let inner = lock(&self.inner);
        let mut out = Vec::new();
        for p in inner.saved.profiles.iter().filter(|p| profile_allows(p, asker_member, other)) {
            for agent in &p.agent_ids {
                if self.spec(agent).is_none() {
                    continue;
                }
                let max_secs = p.max_secs.min(cap_for(other));
                out.push(Offer {
                    profile_id: p.id.clone(),
                    name: clean_profile_name(&p.name),
                    agent_id: agent.clone(),
                    max_secs,
                    default_secs: p.default_secs.min(max_secs),
                    asks_first: p.approval == Approval::Each,
                });
            }
        }
        out.truncate(wire::MAX_OFFERS);
        out
    }

    /// Asks a member's PC(s) what they can lend me, and waits up to `within` for the answers. `answered` is false when no
    /// PC answered (an older build, asleep, offline): the screen then falls back to asking for an agent.
    pub async fn offers(&self, member_id: &str, device_id: Option<&str>, within: Duration) -> Result<OffersResult, String> {
        let session = self.deps.team.session()?;
        let me_member = session.my_member()?;
        let me_device = session.my_device()?;
        let member = session.roster.member(member_id).ok_or("That person is not on the team.")?.clone();
        let devices: Vec<String> = match device_id {
            Some(d) => {
                if !member.devices.iter().any(|x| x.id == d) || d == me_device {
                    return Err("That PC is not one of theirs.".into());
                }
                vec![d.to_string()]
            }
            None => member.devices.iter().map(|d| d.id.clone()).filter(|d| *d != me_device).collect(),
        };
        if devices.is_empty() || (member.id == me_member && devices.is_empty()) {
            return Err("They have no other PC on the team.".into());
        }
        let nonce = short_id("lo");
        lock(&self.offers_wait).insert(nonce.clone(), PendingOffers { member: member.id.clone(), asked: devices.clone(), got: HashMap::new() });
        for d in &devices {
            let sent = wire::seal(&session, d, Body::OffersAsk { nonce: nonce.clone() }, self.now()).and_then(|(payload, _)| self.deps.team.send(&payload));
            if let Err(e) = sent {
                lock(&self.offers_wait).remove(&nonce);
                return Err(e);
            }
        }
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let done = lock(&self.offers_wait).get(&nonce).is_none_or(|p| p.got.len() >= p.asked.len());
            if done || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        let pending = lock(&self.offers_wait).remove(&nonce);
        let got = pending.map(|p| p.got).unwrap_or_default();
        let mut offers = Vec::new();
        for (device, list) in &got {
            let device_name = session.roster.device(device).map(|(_, d)| d.name.clone()).unwrap_or_default();
            offers.extend(list.iter().cloned().map(|offer| OfferView { offer, device_id: device.clone(), device_name: device_name.clone() }));
        }
        offers.sort_by(|a, b| (a.offer.name.to_lowercase(), &a.device_id).cmp(&(b.offer.name.to_lowercase(), &b.device_id)));
        Ok(OffersResult { answered: !got.is_empty(), offers })
    }

    /// Tests: the nonce of an offers question that is still waiting for answers.
    #[cfg(test)]
    pub fn pending_offers_nonce(&self) -> Option<String> {
        lock(&self.offers_wait).keys().next().cloned()
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
        self.apply(Some(&session), item, now)
    }

    fn apply(&self, session: Option<&Session>, item: Item, now: u64) -> Result<(), WireReject> {
        let me_member = match session {
            Some(s) => s.my_member().map_err(|_| WireReject::Undecryptable)?,
            None => OWN_MEMBER.to_string(),
        };
        let names = |member: &str, device: &str| match session {
            Some(session) => {
                let m = session.roster.member(member).map(|m| m.display.clone()).unwrap_or_default();
                let d = session.roster.device(device).map(|(_, d)| d.name.clone()).unwrap_or_default();
                (m, d)
            }
            None => (String::new(), own_node(device).map(|n| self.own_name(n)).unwrap_or_default()),
        };
        match item.body {
            Body::Request { request_id, agent_id, mode, duration_ms, reason, device_name, node_hint, profile_id, offer_ref } => {
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
                    // An id is opaque: only a short plain one is kept.
                    profile_id: profile_id.filter(|p| !p.is_empty() && p.len() <= 64 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')),
                    profile_name: String::new(),
                };
                let (asked_profile, asked_secs, asked_id) = (view.profile_id.clone(), view.secs, view.id.clone());
                inner.saved.requests.push(RequestRec { view, devices: vec![item.from_device.clone()], node_hint });
                self.save(&inner);
                drop(inner);
                self.answer_if_promised(&asked_id, offer_ref.as_deref(), &item.from_member, &item.from_device, asked_profile.as_deref(), asked_secs);
            }
            Body::Grant { request_id, grant_id, agent_id, mode, duration_ms, not_after_ms, limits, node, link_secret, device_name, profile_name } => {
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
                    let my_device = match session {
                        Some(s) => s.my_device().unwrap_or_default(),
                        None => self.my_own_device(),
                    };
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
                            problem_kind: None,
                            profile_name: clean_profile_name(&profile_name),
                            ended_ms: None,
                            profile_id: String::new(),
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
                let _ = self.send_to(session, &item.from_device, Body::Ack { of: item.msg_id.clone() });
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
            Body::Usage { grant_id, plan, windows } => {
                let rec = self.grant_rec(&grant_id).filter(|g| g.view.direction == Direction::In && g.view.state == GrantState::Active).ok_or(WireReject::BadItem)?;
                if !wire::rules::revoke_allowed(&rec.lender_device, &item.from_device) {
                    return Err(WireReject::Impersonation);
                }
                // Words and numbers from another PC: cut and cleaned, at most 8 windows, a percent is a plain number.
                let windows = windows
                    .into_iter()
                    .take(wire::MAX_WIRE_WINDOWS)
                    .map(|w| crate::usage::readers::Window {
                        name: clean_profile_name(&w.name).chars().take(24).collect(),
                        used_percent: f64::from(w.used_percent.min(1000)),
                        minutes: w.minutes,
                        resets_at_ms: w.resets_at_ms,
                        reset_since: false,
                    })
                    .filter(|w| !w.name.is_empty())
                    .collect();
                let plan = plan.map(|p| clean_profile_name(&p).chars().take(24).collect::<String>()).filter(|p| !p.is_empty());
                lock(&self.inner).shared.insert(grant_id, crate::usage::Shared { plan, windows, at_ms: now });
                self.sync_usage_view();
                return Ok(());
            }
            Body::OffersAsk { nonce } => {
                // Only what THIS asker may use. Nothing changes here, so the screens need no refresh.
                let offers = self.offers_for(&item.from_member, &me_member);
                self.send_to(session, &item.from_device, Body::Offers { nonce, offers }).map_err(|_| WireReject::BadItem)?;
                return Ok(());
            }
            Body::Offers { nonce, offers } => {
                let mut wait = lock(&self.offers_wait);
                let pending = wait.get_mut(&nonce).ok_or(WireReject::BadItem)?;
                // Only a device I asked, once, and for the member I asked.
                if pending.member != item.from_member || !pending.asked.contains(&item.from_device) {
                    return Err(WireReject::BadItem);
                }
                if pending.got.contains_key(&item.from_device) {
                    return Err(WireReject::Replay);
                }
                // Words from another PC: cut and cleaned, at most 20, and only agents this PC can ask for.
                let clean: Vec<Offer> = offers
                    .into_iter()
                    .filter(|o| self.spec(&o.agent_id).is_some() && !o.profile_id.is_empty() && o.profile_id.len() <= 64)
                    .take(wire::MAX_OFFERS)
                    .map(|mut o| {
                        o.name = clean_profile_name(&o.name);
                        o
                    })
                    .filter(|o| !o.name.is_empty())
                    .collect();
                pending.got.insert(item.from_device.clone(), clean);
                return Ok(());
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
        let team = self.deps.team.session().ok();
        let mut done = Vec::new();
        for p in &pending {
            let body = Body::Revoke { grant_id: p.grant_id.clone(), reason: RESTARTED.into() };
            if own_node(&p.device).is_some() {
                if self.send_to(None, &p.device, body).is_ok() {
                    done.push(p.grant_id.clone());
                }
                continue;
            }
            let Some(session) = team.as_ref() else { continue };
            match wire::seal(session, &p.device, body, self.now()) {
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

impl crate::own_lend::Inbox for Lend {
    fn deliver(&self, from_node: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        self.on_own_item(from_node, body)
    }
}
