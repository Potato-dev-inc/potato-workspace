//! The app's own wiring of Devices: the real trust file, the real bridge, the real network, the app's window events.
//! Built only while the Labs switch is on, and then at once (a PC that lets another run agents has to be reachable
//! after a restart, before anybody opens the page). Desktop commands (`commands/devices.rs`) get the service here.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tauri::Emitter;

use super::route::PrefsStore;
use super::serve::HostBridge;
use super::web::{self, WebCall, WebGrant};
use super::{Deps, DeviceLink, Options, OFF};
use crate::keys::KeyStore;
use crate::p2p::discovery::NoDiscovery;
use super::far_http::HttpPairRelay;
use crate::p2p::iroh_net::IrohFactory;
use crate::p2p::pairing::SystemClock;
use crate::p2p::trust::TrustStorage;

static ENABLED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static SERVICE: OnceLock<Arc<DeviceLink>> = OnceLock::new();
static LAST_SETTINGS: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// One line in `lib.rs` setup: keeps the handle for the page's events. Builds nothing.
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// One small file, written whole through a temporary file next to it.
struct FileStore {
    path: PathBuf,
}

impl FileStore {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

impl TrustStorage for FileStore {
    fn load(&self) -> Option<Vec<u8>> {
        std::fs::read(&self.path).ok()
    }
    fn save(&self, bytes: &[u8]) -> Result<(), String> {
        self.write(bytes)
    }
}

impl PrefsStore for FileStore {
    fn load(&self) -> Option<String> {
        std::fs::read_to_string(&self.path).ok()
    }
    fn save(&self, text: &str) -> Result<(), String> {
        self.write(text.as_bytes())
    }
}

/// The door into this PC's own routes: the bridge's link entry, on a blocking thread (the routes are synchronous).
pub struct AppBridge;

#[async_trait]
impl HostBridge for AppBridge {
    async fn call(&self, node: &str, method: &str, target: &str, body: Vec<u8>) -> (u16, Vec<u8>) {
        let (node, method, target) = (node.to_string(), method.to_string(), target.to_string());
        let done = tokio::task::spawn_blocking(move || crate::bridge::link_call(&node, &method, &target, &body)).await;
        match done {
            Ok((status, value)) => (status, serde_json::to_vec(&value).unwrap_or_default()),
            Err(_) => (500, br#"{"error":"the request failed"}"#.to_vec()),
        }
    }

    async fn poll(&self, node: &str, cursor: Option<u64>, wait: Duration) -> Option<(u64, String)> {
        let node = node.to_string();
        tokio::task::spawn_blocking(move || crate::bridge::link_poll_events(&node, cursor, wait)).await.ok().flatten()
    }
}

/// The address a device can reach this PC's bridge at from anywhere: the stable link (or the tunnel) the phone uses.
/// `None` while no tunnel is up.
pub fn web_address() -> Option<String> {
    let url = crate::mobile_tunnel::tunnel_status().public_url?;
    Some(format!("{}/bridge", url.trim_end_matches('/'))).filter(|u| web::address_ok(u))
}

/// The key that may open far-away pairing boxes on this person's own Worker (its own key in the credential store).
pub fn pair_owner_key() -> Option<ed25519_dalek::SigningKey> {
    KeyStore::app_scoped("far-pairing").pair_owner().ok()
}

/// Its public half: what a deployed Worker is told as `PAIR_OWNER`. Made on first use, only while the Labs switch is on.
pub fn pair_owner_id() -> Option<String> {
    far_pcs_on().then(|| pair_owner_key().map(|k| pm_relay_protocol::key_id(&k))).flatten()
}

/// Labs `far_pcs_enabled`, from the last settings the app applied.
pub fn far_pcs_on() -> bool {
    LAST_SETTINGS.lock().ok().and_then(|l| l.as_ref().and_then(|v| v.get("far_pcs_enabled").and_then(Value::as_bool))).unwrap_or(false)
}

/// This person's own Worker (the one saved for the phone's fixed address), as a plain host name. None: none set up.
pub fn my_worker_host() -> Option<String> {
    match crate::tunnel_config::load(&crate::tunnel_config::tunnel_file()) {
        crate::tunnel_config::TunnelConfig::Stable { worker_url, .. } => {
            let host = worker_url.trim().trim_start_matches("https://").trim_end_matches('/').to_string();
            crate::p2p::far::clean_worker_host(&host, false).filter(|h| h.ends_with(".workers.dev"))
        }
        _ => None,
    }
}

/// What only the person at this PC can fix, for a device that asks "who are you": agents whose saved sign-ins are all
/// signed out, and panes stopped at a prompt only this screen may answer (a folder trust question, a sign-in).
/// Words and ids only: no prompt text, no paths.
pub fn app_health() -> Value {
    use crate::attention::model::{Kind, State};
    let store = crate::accounts::Store::default_location();
    let signed_out: Vec<String> = crate::accounts::supporting_agents()
        .into_iter()
        .filter(|agent| {
            let rows = crate::accounts::capability_rows(&store, &agent.agent_id);
            !rows.is_empty() && rows.iter().all(|r| r["login_state"] == "signed_out")
        })
        .map(|agent| agent.agent_id)
        .collect();
    let needs_person: Vec<Value> = crate::attention::snapshot()
        .items
        .iter()
        .filter(|i| i.kind == Kind::TrustGate && i.state == State::Open)
        .filter_map(|i| Some(serde_json::json!({ "pane": i.pane.as_ref()?.id, "what": i.title })))
        .take(8)
        .collect();
    serde_json::json!({ "signed_out": signed_out, "needs_person": needs_person })
}

/// Room left on this PC's own sign-ins, for a device that asks "who are you": numbers and labels from the last usage
/// read (the cache only: this never asks an agent or a provider).
pub fn app_room() -> Value {
    let rooms = crate::usage::cached().map(|s| crate::usage::room::rooms_of(&s)).unwrap_or_default();
    crate::usage::room::payload(&rooms)
}

/// The OS credential store, as the one `SecretBackend` the web route keeps its addresses and tokens in.
struct GlobalSecrets;

impl crate::secrets::SecretBackend for GlobalSecrets {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        crate::secrets::backend().get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        crate::secrets::backend().set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        crate::secrets::backend().delete(name)
    }
    fn label(&self) -> &'static str {
        crate::secrets::backend().label()
    }
    fn available(&self) -> bool {
        crate::secrets::backend().available()
    }
}

/// The far side of the web route: a device token for a paired device, minted the way a phone's is (so it is listed
/// with the paired phones, can be revoked there, and is checked by the same bridge rules). The device id behind each
/// token is kept in a small file next to the trust list; the token itself is never kept here.
pub struct AppWebGrant {
    index: FileStore,
}

impl AppWebGrant {
    fn read(&self) -> serde_json::Map<String, Value> {
        std::fs::read_to_string(&self.index.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn write(&self, map: &serde_json::Map<String, Value>) {
        let _ = self.index.write(Value::Object(map.clone()).to_string().as_bytes());
    }
}

impl WebGrant for AppWebGrant {
    fn mint(&self, node: &str, name: &str, full: bool) -> Result<(String, String), String> {
        use base64::Engine as _;
        let base = web_address().ok_or_else(|| "This PC has no web address yet. Set one up in Settings > Phone.".to_string())?;
        let store = crate::mobile_pairing::pairing_store().ok_or_else(|| "Pairing is not ready yet.".to_string())?;
        self.revoke(node);
        let mut guard = store.lock();
        if guard.has_live_pending_code() {
            return Err("A phone pairing is open right now. Try again in a minute.".into());
        }
        let caps = if full { crate::mobile_pairing::Caps::all() } else { crate::mobile_pairing::Caps::watch_and_answer() };
        let session = guard.create_pairing_session_with_caps(base.clone(), caps);
        let key = crate::keys::crypto::new_signing_key().verifying_key().to_bytes();
        let paired = guard.pair_device(crate::mobile_pairing::PairRequestBody {
            pairing_code: session.pairing_code,
            device_name: format!("{name} (PC)"),
            device_public_key: base64::engine::general_purpose::STANDARD.encode(key),
        })?;
        drop(guard);
        let mut map = self.read();
        map.insert(node.to_string(), Value::String(paired.device_id));
        self.write(&map);
        Ok((base, paired.device_token))
    }

    fn revoke(&self, node: &str) {
        let mut map = self.read();
        let Some(id) = map.remove(node).and_then(|v| v.as_str().map(str::to_string)) else { return };
        if let Some(store) = crate::mobile_pairing::pairing_store() {
            let _ = store.lock().revoke_device(&id);
        }
        self.write(&map);
    }
}

/// This side of the web route: one HTTPS request on the device's web address, with the token it gave this PC. No
/// redirects, a short time limit, and an error text that never holds the token.
pub struct AppWebCall;

#[async_trait]
impl WebCall for AppWebCall {
    async fn call(&self, base: &str, token: &str, method: &str, target: &str, body: Vec<u8>) -> Result<(u16, Vec<u8>), String> {
        use std::io::Read as _;
        let (url, token, method) = (web::url_for(base, target), token.to_string(), method.to_string());
        tokio::task::spawn_blocking(move || {
            let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(25)).redirects(0).build();
            let req = agent.request(&method, &url).set("Authorization", &format!("Bearer {token}")).set("Accept-Encoding", "identity");
            let result = if body.is_empty() { req.call() } else { req.set("Content-Type", "application/json").send_bytes(&body) };
            let read = |resp: ureq::Response| {
                let status = resp.status();
                let mut out = Vec::new();
                let _ = resp.into_reader().take(super::wire::REPLY_MAX as u64).read_to_end(&mut out);
                (status, out)
            };
            match result {
                Ok(resp) => Ok(read(resp)),
                Err(ureq::Error::Status(_, resp)) => Ok(read(resp)),
                Err(e) => Err(e.kind().to_string()),
            }
        })
        .await
        .map_err(|_| "The request failed".to_string())?
    }
}

/// The project folders this PC knows (the ones a device may open by default). Folders that are gone are left out.
pub fn project_folders() -> Vec<PathBuf> {
    let others = crate::operations::indexed_project_paths();
    let store = crate::app_paths::app_data_dir();
    crate::worktrees::folder::recent_light(&store, &others, 12).into_iter().filter(|p| p.state != "missing").map(|p| PathBuf::from(p.path)).collect()
}

/// Where received files land: the person's Downloads folder.
pub fn downloads_dir() -> PathBuf {
    crate::project_path::home_dir().map(|h| h.join("Downloads")).unwrap_or_else(|| std::env::temp_dir().join("pm-downloads"))
}

pub fn computer_name() -> String {
    crate::device_identity::computer_name()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Settings changed (the effective settings, the development override included).
pub fn apply_settings(public: &Value) {
    let on = crate::p2p::labs_on_for(public, crate::p2p::capability::AGENTS_REMOTE);
    ENABLED.store(on, Ordering::SeqCst);
    if let Ok(mut last) = LAST_SETTINGS.lock() {
        *last = Some(public.clone());
    }
    if let Some(svc) = SERVICE.get() {
        svc.apply_settings(public);
        if on {
            let svc = svc.clone();
            tauri::async_runtime::spawn(async move {
                let _ = svc.start().await;
            });
        }
    } else if on && APP.get().is_some() {
        tauri::async_runtime::spawn(async {
            if let Ok(svc) = app_service() {
                let _ = svc.start().await;
            }
        });
    }
}

/// The app's service, built the first time it is needed while the switch is on. Never while it is off.
pub fn app_service() -> Result<Arc<DeviceLink>, String> {
    if !enabled() {
        return Err(OFF.into());
    }
    if let Some(svc) = SERVICE.get() {
        return Ok(svc.clone());
    }
    let dir = crate::app_paths::app_data_dir().join("devices");
    let store = |name: &str| Arc::new(FileStore { path: dir.join(name) });
    let prefs: Arc<dyn PrefsStore> = store("route.txt");
    let options = Options {
        route_overrides: store("route-overrides.json"),
        activity_store: store("activity.json"),
        secrets: Arc::new(GlobalSecrets),
        web_grant: Arc::new(AppWebGrant { index: FileStore { path: dir.join("web-grants.json") } }),
        web_call: Arc::new(AppWebCall),
        web_address: Arc::new(web_address),
        health: Arc::new(app_health),
        room: Arc::new(app_room),
        send_work_store: store("send-work.json"),
        folders_store: store("files-folders.json"),
        project_folders: Arc::new(project_folders),
        downloads: Arc::new(downloads_dir),
        deny_paths: vec![crate::app_paths::app_data_dir()],
        far_relay: Some(Arc::new(HttpPairRelay::new(
            Arc::new(pair_owner_key),
            Arc::new(my_worker_host),
        ))),
    };
    let deps = Deps {
        keys: KeyStore::app_scoped("devices"),
        factory: Arc::new(IrohFactory),
        trust_storage: store("trust.json"),
        prefs,
        addr_store: store("addrs.json"),
        bridge: Arc::new(AppBridge),
        clock: Arc::new(SystemClock),
        discovery: Arc::new(NoDiscovery),
        name: computer_name(),
        loopback_only: false,
        timeouts: Default::default(),
        now_secs: Arc::new(now_secs),
        options,
    };
    let svc = DeviceLink::new(deps)?;
    crate::agent_dispatch::set_sender(Arc::new(AppSender));
    if SERVICE.set(svc.clone()).is_err() {
        return SERVICE.get().cloned().ok_or_else(|| "Devices could not start.".to_string());
    }
    if let Some(app) = APP.get().cloned() {
        let changed_app = app.clone();
        svc.set_notifier(Arc::new(move |view: &Value| {
            let _ = changed_app.emit("devices://changed", view);
        }));
        let screen_app = app.clone();
        svc.set_event_sink(Arc::new(move |node: &str, frame: &str| {
            let _ = app.emit("device://event", serde_json::json!({ "node": node, "frame": frame }));
        }));
        svc.set_screen_sink(Arc::new(move |node: &str, pane: &str, content: &str| {
            let _ = screen_app.emit("device://screen", serde_json::json!({ "node": node, "pane_id": pane, "content": content }));
        }));
    }
    if let Some(public) = LAST_SETTINGS.lock().ok().and_then(|l| l.clone()) {
        svc.apply_settings(&public);
    }
    Ok(svc)
}

/// App quit: grants withdrawn, links closed.
pub fn shutdown() {
    if let Some(svc) = SERVICE.get() {
        svc.shutdown();
    }
}



/// What `agent_dispatch` (MCP `run_agent` with account `device:<name>`) uses to reach the service. Sync: the bridge
/// route is sync, so the async request runs on its own thread with a bounded wait.
struct AppSender;

impl crate::agent_dispatch::DeviceSender for AppSender {
    fn resolve(&self, wanted: &str) -> Result<crate::agent_dispatch::Target, String> {
        let svc = SERVICE.get().ok_or(OFF)?;
        svc.resolve_device(wanted).map(|(node, name)| crate::agent_dispatch::Target { node, name })
    }
    fn may_send(&self, node: &str) -> bool {
        SERVICE.get().is_some_and(|s| s.agents_may_send(node))
    }
    fn request(&self, node: &str, method: &str, path: &str, body: Value) -> Result<(u16, Value), String> {
        let svc = SERVICE.get().cloned().ok_or(OFF)?;
        let (node, method, path) = (node.to_string(), method.to_string(), path.to_string());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(tauri::async_runtime::block_on(svc.request(&node, &method, &path, Some(body))));
        });
        rx.recv_timeout(Duration::from_secs(150)).map_err(|_| "That device did not answer in time.".to_string())?
    }
}

/// What lending between my own PCs uses to reach the device link (`capacity_proxy::service::OwnPort`). Sync: lend's own calls
/// are sync, so the async request runs on its own thread with a bounded wait.
pub struct AppOwn;

impl crate::capacity_proxy::service::OwnPort for AppOwn {
    fn send(&self, node: &str, item: &crate::capacity_proxy::service::OwnItem) -> Result<(), String> {
        let svc = SERVICE.get().cloned().ok_or(OFF)?;
        let name = svc.own_peers().into_iter().find(|(n, _)| n == node).map(|(_, name)| name).unwrap_or_else(|| "That PC".into());
        let body = serde_json::to_value(item).map_err(|e| e.to_string())?;
        let node = node.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(tauri::async_runtime::block_on(svc.request(&node, "POST", "/lend/item", Some(body))));
        });
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok((200, _))) => Ok(()),
            Ok(Ok((403, _))) => Err(format!("{name} does not let this PC borrow yet. Turn on Borrow my agent sign-ins for this PC there: Settings > Devices.")),
            Ok(Ok((_, v))) => Err(v["error"].as_str().unwrap_or("That PC refused it.").to_string()),
            Ok(Err(_)) | Err(_) => Err(format!("{name} did not answer.")),
        }
    }
    fn peers(&self) -> Vec<(String, String)> {
        SERVICE.get().map(|s| s.own_peers()).unwrap_or_default()
    }
    fn my_node(&self) -> Option<String> {
        SERVICE.get().and_then(|s| s.p2p().node_id()).map(|n| n.to_hex())
    }
    fn my_name(&self) -> String {
        SERVICE.get().map(|s| s.self_name()).unwrap_or_default()
    }
}
