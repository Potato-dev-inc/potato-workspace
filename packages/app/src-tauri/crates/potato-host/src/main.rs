//! `potato-host`: Potato Workspace without a window, for a machine with no screen (an SSH box). It serves the PC link
//! (`pm/agents/1`, through the relay when needed, end-to-end encrypted) with the SAME rights code as the app
//! (`pm_core::device_link::pclink`). v0: the routes answer, the chat engine is not here yet (see `services.rs`).
//!
//!   potato-host run           serve until `potato-host stop` (run it under systemd --user or nohup)
//!   potato-host pair --stdio  print this machine's ids as one JSON line, read the other PC's on stdin, trust it at Full
//!   potato-host install-service  write and start a systemd --user unit (no root)
//!   potato-host stop          ask a running `run` to stop
//!   potato-host link --stdio  the PC link over the SSH pipe (stdin/stdout), for boxes with no outbound network
//!
//! Data and keys: the app's own paths under the profile `host` (`~/.local/share/com.potatodev.workspace.profile-host`), keys in
//! the OS keyring or, when there is none, the private 0600 file (`secrets_file.rs`, plan D3).

mod projects;
mod service;
mod services;

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pm_core::device_link::activity::ActivityLog;
use pm_core::device_link::pclink::{Asks, Door, Level};
use pm_core::device_link::route::PrefsStore;
use pm_core::device_link::serve::{AgentsHandler, Extras, HostBridge, Live, SelfInfo};
use pm_core::device_link::web::WebGrant;
use pm_core::keys::KeyStore;
use pm_core::p2p::capability::{self, Capability, CapabilityHandler, Registry, RelayPolicy};
use pm_core::p2p::endpoint::{Link, NodeId};
use pm_core::p2p::identity::DeviceIdentity;
use pm_core::p2p::iroh_net::IrohFactory;
use pm_core::p2p::trust::{KeyStoreSigner, TrustList, TrustStorage};
use pm_core::p2p::pipe::PipeLink;
use pm_core::p2p::{alpn, P2p};
use serde_json::{json, Value};

const PROFILE: &str = "host";

fn main() {
    // Before anything reads a path or a key: this program is its own profile, never the desktop app's data or keys.
    if std::env::var_os(pm_core::app_paths::PROFILE_ENV).is_none() {
        std::env::set_var(pm_core::app_paths::PROFILE_ENV, PROFILE);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = match words.as_slice() {
        ["run"] => run(),
        ["pair", "--stdio"] => pair_stdio(&mut std::io::stdin().lock(), &mut std::io::stdout()),
        ["stop"] => stop(),
        ["install-service"] => service::install(),
        ["link", "--stdio"] => link_stdio(),
        _ => {
            eprintln!("usage: potato-host run | pair --stdio | install-service | stop | link --stdio");
            64
        }
    };
    std::process::exit(code);
}

fn data_dir() -> PathBuf {
    pm_core::app_paths::app_data_dir()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn machine_name() -> String {
    let raw = std::env::var("HOSTNAME").ok().or_else(|| std::fs::read_to_string("/etc/hostname").ok()).or_else(|| std::env::var("COMPUTERNAME").ok());
    let name = pm_core::p2p::trust::clean_name(raw.as_deref().unwrap_or("").trim());
    if name.is_empty() {
        "Linux computer".into()
    } else {
        name
    }
}

/// One small file, written whole through a temporary file next to it.
struct FileStore(PathBuf);

impl FileStore {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if let Some(dir) = self.0.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.0.with_extension("tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.0).map_err(|e| e.to_string())
    }
}

impl TrustStorage for FileStore {
    fn load(&self) -> Option<Vec<u8>> {
        std::fs::read(&self.0).ok()
    }
    fn save(&self, bytes: &[u8]) -> Result<(), String> {
        self.write(bytes)
    }
}

impl PrefsStore for FileStore {
    fn load(&self) -> Option<String> {
        std::fs::read_to_string(&self.0).ok()
    }
    fn save(&self, text: &str) -> Result<(), String> {
        self.write(text.as_bytes())
    }
}

fn keys() -> KeyStore {
    KeyStore::app_scoped("devices")
}

fn trust(keys: &KeyStore) -> Arc<TrustList> {
    TrustList::open(Arc::new(FileStore(data_dir().join("trust.json"))), Arc::new(KeyStoreSigner::new(keys.clone())))
}

fn hex32(text: &str) -> Option<[u8; 32]> {
    let text = text.trim();
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ----- pair --stdio -----

/// SSH already proved both ends (strict host key, the person's own key), so no number is compared: this machine prints its
/// ids, reads the other PC's on stdin, and trusts it at Full. Nothing else is read, and no login or token crosses.
fn pair_stdio(input: &mut dyn BufRead, output: &mut dyn Write) -> i32 {
    let keys = keys();
    let id = match DeviceIdentity::load(&keys) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("potato-host: this machine's keys could not be read or made: {e}");
            return 1;
        }
    };
    let mine = json!({ "potato_host": 1, "node": id.id().to_hex(), "device_pub": hex(&id.binding().device_pub), "name": machine_name() });
    if writeln!(output, "{mine}").and_then(|_| output.flush()).is_err() {
        return 1;
    }
    let mut line = String::new();
    // At most 4 KB: the answer is one short JSON line.
    if std::io::Read::take(input, 4096).read_line(&mut line).is_err() {
        eprintln!("potato-host: no answer from the other PC.");
        return 1;
    }
    match accept_peer(&trust(&keys), &line, now_secs()) {
        Ok(name) => {
            let _ = writeln!(output, "{}", json!({ "paired": true, "name": name }));
            0
        }
        Err(e) => {
            eprintln!("potato-host: {e}");
            let _ = writeln!(output, "{}", json!({ "paired": false, "error": e }));
            1
        }
    }
}

/// The other PC's line: `{ node, device_pub, name }`. Checked here (it is the trust boundary), then trusted at Full.
fn accept_peer(trust: &TrustList, line: &str, now: u64) -> Result<String, String> {
    let peer: Value = serde_json::from_str(line.trim()).map_err(|_| "The other PC's answer was not understood.".to_string())?;
    let node = peer["node"].as_str().and_then(hex32).ok_or("The other PC's id is not valid.")?;
    let device_pub = peer["device_pub"].as_str().and_then(hex32).ok_or("The other PC's key is not valid.")?;
    let name = pm_core::p2p::trust::clean_name(peer["name"].as_str().unwrap_or("").chars().take(64).collect::<String>().as_str());
    let name = if name.is_empty() { "My PC".to_string() } else { name };
    let node = NodeId(node);
    trust.add(node, device_pub, &name, now).map_err(|e| format!("This PC could not be trusted: {e:?}"))?;
    // Full plus the ssh marker: the person who holds the SSH key owns this box.
    trust.grant_ssh_full(&node).map_err(|e| format!("This PC could not be given rights: {e:?}"))?;
    Ok(name)
}

// ----- link --stdio -----

/// What a pipe-only host says about itself: no addresses and no relay (nothing is reachable except through the pipe).
struct PipeInfo(String);

impl SelfInfo for PipeInfo {
    fn name(&self) -> String {
        self.0.clone()
    }
    fn addrs(&self) -> Vec<String> {
        Vec::new()
    }
    fn relay(&self) -> Option<String> {
        None
    }
}

/// The first line from the PC: `{ "potato_link": 1, "node": "<64 hex>" }`. The node must already be paired here (`pair --stdio`);
/// SSH proved who holds the key, the trust list says that this node id is the one that was paired. Rights are read per request.
fn link_hello(trust: &TrustList, line: &str) -> Result<NodeId, String> {
    let hello: Value = serde_json::from_str(line.trim()).map_err(|_| "The first line was not understood.".to_string())?;
    let node = NodeId(hello["node"].as_str().and_then(hex32).ok_or("The PC's id is not valid.")?);
    if trust.remote_level(&node).is_none() {
        return Err("That PC is not paired here, or is not let in.".into());
    }
    Ok(node)
}

fn link_stdio() -> i32 {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("potato-host: could not start: {e}");
            return 1;
        }
    };
    let code = rt.block_on(async {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let trust = trust(&keys());
        let name = machine_name();
        let mut input = tokio::io::BufReader::new(tokio::io::stdin());
        let mut output = tokio::io::stdout();
        let mut line = String::new();
        // At most 4 KB: the first line is one short JSON line.
        if tokio::io::AsyncReadExt::take(&mut input, 4096).read_line(&mut line).await.is_err() {
            return 1;
        }
        let peer = match link_hello(&trust, &line) {
            Ok(p) => p,
            Err(e) => {
                let _ = output.write_all(format!("{}
", json!({ "ok": false, "error": e })).as_bytes()).await;
                eprintln!("potato-host: {e}");
                return 1;
            }
        };
        let id = match DeviceIdentity::load(&keys()) {
            Ok(id) => id.id().to_hex(),
            Err(e) => {
                eprintln!("potato-host: this machine's keys could not be read or made: {e}");
                return 1;
            }
        };
        if output.write_all(format!("{}
", json!({ "ok": true, "node": id, "name": name })).as_bytes()).await.is_err() || output.flush().await.is_err() {
            return 1;
        }
        let handler = agents_handler(&trust, Arc::new(PipeInfo(name.clone())), &name, &data_dir(), false);
        let link = PipeLink::start(input, output, peer, alpn::AGENTS, false);
        handler.serve(peer, link.clone()).await;
        link.close(pm_core::p2p::endpoint::CLOSE_GOODBYE, "goodbye");
        // Let the goodbye frame leave before the process ends.
        tokio::time::sleep(Duration::from_millis(200)).await;
        0
    });
    // tokio's stdin reads on a blocking thread that only ends when the pipe does: do not wait for it when the host ends the link first.
    rt.shutdown_background();
    code
}

// ----- run / stop -----

fn pid_file() -> PathBuf {
    data_dir().join("potato-host.pid")
}

fn stop_file() -> PathBuf {
    data_dir().join("potato-host.stop")
}

/// A `run` that is still going: its pid file names a live process (Linux reads /proc; elsewhere the file alone counts).
fn running_pid(path: &Path) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(path).ok()?.trim().parse().ok()?;
    if cfg!(target_os = "linux") && !Path::new(&format!("/proc/{pid}")).exists() {
        return None;
    }
    Some(pid)
}

fn stop() -> i32 {
    if running_pid(&pid_file()).is_none() {
        println!("potato-host is not running.");
        return 0;
    }
    if let Err(e) = std::fs::write(stop_file(), b"stop") {
        eprintln!("potato-host: could not ask it to stop: {e}");
        return 1;
    }
    for _ in 0..40 {
        if running_pid(&pid_file()).is_none() {
            println!("potato-host stopped.");
            return 0;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!("potato-host: it did not stop within 10 seconds.");
    1
}

/// The two older PC-to-PC doors (`/agents/run`, `/lend/item`) need the app's bridge: not on this machine.
struct NoLegacy;

#[async_trait]
impl HostBridge for NoLegacy {
    async fn call(&self, _: &str, _: &str, _: &str, _: Vec<u8>) -> (u16, Vec<u8>) {
        let (status, body) = services::not_here();
        (status, serde_json::to_vec(&body).unwrap_or_default())
    }
    async fn poll(&self, _: &str, _: Option<u64>, _: Duration) -> Option<(u64, String)> {
        None
    }
}

/// No web address on a host: no PC is ever handed a token.
struct NoWeb;

impl WebGrant for NoWeb {
    fn mint(&self, _: &str, _: &str, _: bool) -> Result<(String, String), String> {
        Err("This machine has no web address.".into())
    }
    fn revoke(&self, _: &str) {}
}

struct Info {
    p2p: Arc<P2p>,
    name: String,
}

impl SelfInfo for Info {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn addrs(&self) -> Vec<String> {
        self.p2p.local_addrs().iter().map(|a| a.to_string()).collect()
    }
    fn relay(&self) -> Option<String> {
        self.p2p.home_relay()
    }
}

fn node_of(hex_id: &str) -> Option<NodeId> {
    hex32(hex_id).map(NodeId)
}

fn run() -> i32 {
    if let Some(pid) = running_pid(&pid_file()) {
        eprintln!("potato-host is already running (process {pid}).");
        return 1;
    }
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::remove_file(stop_file());
    if let Err(e) = std::fs::write(pid_file(), std::process::id().to_string()) {
        eprintln!("potato-host: could not write its process file: {e}");
        return 1;
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("potato-host: could not start: {e}");
            return 1;
        }
    };
    let code = rt.block_on(serve());
    let _ = std::fs::remove_file(pid_file());
    let _ = std::fs::remove_file(stop_file());
    code
}

/// The same handler for the iroh link (`run`) and the SSH pipe (`link --stdio`): rights come from the trust list at every request.
fn agents_handler(trust: &Arc<TrustList>, info: Arc<dyn SelfInfo>, name: &str, dir: &Path, restore_chats: bool) -> AgentsHandler {
    let name_of: Arc<dyn Fn(&NodeId) -> String + Send + Sync> = {
        let trust = trust.clone();
        Arc::new(move |peer: &NodeId| trust.get(peer).map(|d| d.name).unwrap_or_default())
    };
    let host_services = services::HostServices::new(name.to_string(), projects::Projects::open(dir, std::env::var_os("HOME").map(PathBuf::from)));
    if restore_chats {
        let back = host_services.restore_chats();
        eprintln!("potato-host: {back} earlier chat(s) restored.");
    }
    // The same door the app builds (`device_link/mod.rs`), over this machine's Services.
    let door = Door {
        legacy: Arc::new(NoLegacy),
        services: Arc::new(host_services),
        asks: Arc::new(Asks::new()),
        level_of: {
            let trust = trust.clone();
            Arc::new(move |node: &str| Level::of(trust.remote_level(&node_of(node)?)))
        },
        name_of: {
            let trust = trust.clone();
            Arc::new(move |node: &str| node_of(node).and_then(|n| trust.get(&n)).map(|d| d.name).unwrap_or_default())
        },
        marked_of: {
            let trust = trust.clone();
            Arc::new(move |node: &str| node_of(node).is_some_and(|n| trust.own_pc(&n)))
        },
        lend_ok: Arc::new(|_| false),
        now_ms: Arc::new(now_ms),
    };
    AgentsHandler {
        bridge: Arc::new(door),
        info,
        live: Arc::new(Live::default()),
        still_allowed: {
            let trust = trust.clone();
            Arc::new(move |peer: &NodeId| trust.remote_level(peer).is_some())
        },
        now: Arc::new(now_secs),
        extras: Extras {
            activity: ActivityLog::new(Arc::new(FileStore(dir.join("activity.json")))),
            name_of,
            web: Arc::new(NoWeb),
            web_allowed: Arc::new(|_| None),
        },
    }
}

async fn serve() -> i32 {
    let keys = keys();
    let trust = trust(&keys);
    let registry = Arc::new(Registry::new());
    let p2p = Arc::new(P2p::new(keys.clone(), Arc::new(IrohFactory), registry.clone(), trust.clone()));
    let name = machine_name();
    // `run` is the one long-lived process: the chats that were open when it last stopped come back as panes. (`link --stdio` is one
    // connection long, so it leaves the stored conversations to `run`.)
    let handler = agents_handler(&trust, Arc::new(Info { p2p: p2p.clone(), name: name.clone() }), &name, &data_dir(), true);
    if let Err(e) = registry.register(Capability::new(capability::AGENTS_REMOTE, alpn::AGENTS, RelayPolicy::Allowed, Arc::new(handler))) {
        eprintln!("potato-host: could not start the PC link: {e}");
        return 1;
    }
    // The host exists to be reached by its paired PCs: the Devices switch is on (its Labs gate in `P2p`).
    let mut on = serde_json::Map::new();
    on.insert(pm_core::p2p::DEVICES_LABS_KEY.into(), Value::Bool(true));
    p2p.apply_settings(&Value::Object(on));
    if let Err(e) = p2p.want(capability::AGENTS_REMOTE).await {
        eprintln!("potato-host: could not open the PC link: {e}");
        return 1;
    }
    let node = p2p.node_id().map(|n| n.to_hex()).unwrap_or_default();
    println!("potato-host: ready. node {node}, {} paired PC(s).", trust.list().len());
    while !stop_file().exists() {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    p2p.stop();
    println!("potato-host: stopped.");
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use pm_core::p2p::trust::{MemoryTrustStorage, RemoteLevel};

    fn list() -> Arc<TrustList> {
        let keys = KeyStore::with_backend(Arc::new(pm_core::secrets::MemoryBackend::new()), "t");
        TrustList::open(MemoryTrustStorage::new(), Arc::new(KeyStoreSigner::new(keys)))
    }

    #[test]
    fn a_valid_peer_is_trusted_at_full_and_a_bad_line_is_refused() {
        let t = list();
        let line = json!({ "node": "ab".repeat(32), "device_pub": "cd".repeat(32), "name": "Work PC\u{202e}" }).to_string();
        assert_eq!(accept_peer(&t, &line, 1).as_deref(), Ok("Work PC"));
        assert_eq!(t.remote_level(&NodeId([0xab; 32])), Some(RemoteLevel::Full));
        assert!(t.ssh_marked(&NodeId([0xab; 32])) && !t.account_marked(&NodeId([0xab; 32])));
        // The marker is not a right anyone can set or clear through the permission call (no route, phone or window).
        assert!(t.set_permission(&NodeId([0xab; 32]), capability::AGENTS_REMOTE_SSH, false).is_err());
        // Lowering the level keeps the marker.
        t.set_permission(&NodeId([0xab; 32]), capability::AGENTS_REMOTE_FULL, false).unwrap();
        assert!(t.ssh_marked(&NodeId([0xab; 32])) && t.remote_level(&NodeId([0xab; 32])) == Some(RemoteLevel::Answer));
        t.grant_ssh_full(&NodeId([0xab; 32])).unwrap();
        for bad in ["", "not json", r#"{"node":"zz","device_pub":"cd"}"#, &json!({ "node": "ab".repeat(32) }).to_string()] {
            assert!(accept_peer(&t, bad, 1).is_err(), "{bad}");
        }
        // The same node with another device key is not silently re-trusted.
        let other = json!({ "node": "ab".repeat(32), "device_pub": "ef".repeat(32), "name": "x" }).to_string();
        assert!(accept_peer(&t, &other, 2).is_err());
    }

    #[test]
    fn only_a_paired_pc_may_open_the_pipe() {
        let t = list();
        let line = |node: &str| json!({ "potato_link": 1, "node": node }).to_string();
        assert!(link_hello(&t, &line(&"ab".repeat(32))).is_err(), "unknown node");
        accept_peer(&t, &json!({ "node": "ab".repeat(32), "device_pub": "cd".repeat(32), "name": "PC" }).to_string(), 1).unwrap();
        assert_eq!(link_hello(&t, &line(&"ab".repeat(32))), Ok(NodeId([0xab; 32])));
        for bad in ["", "x", r#"{"node":"zz"}"#] {
            assert!(link_hello(&t, bad).is_err(), "{bad}");
        }
        // Switch off: the pipe is refused like the iroh link.
        t.set_permission(&NodeId([0xab; 32]), capability::AGENTS_REMOTE, false).unwrap();
        assert!(link_hello(&t, &line(&"ab".repeat(32))).is_err());
    }

    /// A PC asks `GET /pclink/me` through the multiplexed pipe and gets the host's own answer, with the rights from the trust list.
    #[tokio::test]
    async fn the_pc_link_is_served_over_a_pipe_with_rights_per_request() {
        use pm_core::device_link::wire::{self, Head, ReplyHead};
        use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};
        let t = list();
        accept_peer(&t, &json!({ "node": "ab".repeat(32), "device_pub": "cd".repeat(32), "name": "My PC" }).to_string(), 1).unwrap();
        // Its own data folder beside the test exe (cargo target folder): a test never touches the real app data.
        let dir = std::env::current_exe().unwrap().parent().unwrap().join("host-main-tests");
        let _ = std::fs::remove_dir_all(&dir);
        let handler = agents_handler(&t, Arc::new(PipeInfo("box".into())), "box", &dir, false);
        let (a_to_b, b_from_a) = duplex(1 << 20);
        let (b_to_a, a_from_b) = duplex(1 << 20);
        let host = PipeLink::start(b_from_a, b_to_a, NodeId([0xab; 32]), alpn::AGENTS, false);
        let pc = PipeLink::start(a_from_b, a_to_b, NodeId([9; 32]), alpn::AGENTS, true);
        let served = tokio::spawn({
            let host = host.clone();
            async move { handler.serve(NodeId([0xab; 32]), host).await }
        });
        async fn ask(pc: &PipeLink, target: &str) -> (u16, Value) {
            let mut s = pc.open_bi().await.unwrap();
            wire::write_frame(&mut s.send, &Head::request("GET", target, 0), &[]).await.unwrap();
            s.send.shutdown().await.unwrap();
            let head: ReplyHead = wire::read_head(&mut s.recv).await.unwrap();
            let mut body = vec![0u8; head.body_len as usize];
            s.recv.read_exact(&mut body).await.unwrap();
            (head.status, serde_json::from_slice(&body).unwrap_or(Value::Null))
        }
        let (status, me) = ask(&pc, "/pclink/me").await;
        assert_eq!((status, me["name"].as_str(), me["level"].as_str()), (200, Some("box"), Some("full")));
        assert_eq!(ask(&pc, "/pclink/sessions").await.0, 200);
        // The far Files rows, over the same pipe, on a project this box knows: the folder is named by its id, never a path.
        async fn post(pc: &PipeLink, target: &str, body: &Value) -> (u16, Value) {
            let bytes = serde_json::to_vec(body).unwrap();
            let mut s = pc.open_bi().await.unwrap();
            wire::write_frame(&mut s.send, &Head::request("POST", target, bytes.len()), &bytes).await.unwrap();
            s.send.shutdown().await.unwrap();
            let head: ReplyHead = wire::read_head(&mut s.recv).await.unwrap();
            let mut out = vec![0u8; head.body_len as usize];
            s.recv.read_exact(&mut out).await.unwrap();
            (head.status, serde_json::from_slice(&out).unwrap_or(Value::Null))
        }
        let project = dir.join("project");
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();
        // A real git folder with one commit and one edit, so the git rows have something to say.
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .current_dir(&project)
                .args(["-c", "user.name=PM", "-c", "user.email=pm@example.invalid", "-c", "commit.gpgsign=false"])
                .args(args)
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        std::fs::write(project.join("a.txt"), "hello").unwrap();
        git(&["init", "-q"]);
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "base"]);
        std::fs::write(project.join("a.txt"), "hello, changed").unwrap();
        let listed = project.to_string_lossy().to_string();
        std::fs::write(dir.join("projects.json"), serde_json::to_string(&vec![listed.clone()]).unwrap()).unwrap();
        let id = projects::Projects::open(&dir, None).id(&listed);
        let (status, files) = post(&pc, "/pclink/call/files_list", &json!({ "paneId": id, "path": "" })).await;
        assert_eq!(status, 200);
        assert!(files.to_string().contains("a.txt"), "the far PC sees the project's files");
        let (status, branch) = post(&pc, "/pclink/call/pane_git_branch", &json!({ "paneId": id })).await;
        assert_eq!(status, 200);
        assert!(branch.as_str().is_some_and(|b| !b.is_empty()), "the folder's branch: {branch}");
        // Git status for the Files tree: the edited file is marked.
        let (status, marks) = post(&pc, "/pclink/call/files_marks", &json!({ "paneId": id })).await;
        assert_eq!(status, 200);
        assert!(marks.to_string().contains("a.txt"), "the edited file is marked: {marks}");
        assert_eq!(post(&pc, "/pclink/call/files_list", &json!({ "paneId": "0000000000000000", "path": "" })).await.0, 404, "an unknown project id is refused");
        assert_ne!(post(&pc, "/pclink/call/files_read", &json!({ "paneId": id, "path": "../x" })).await.0, 200, "a path out of the project is refused");
        assert_eq!(post(&pc, "/pclink/call/checkpoints_list", &json!({ "paneId": id })).await.1["code"], "NOT_ON_THIS_MACHINE");
        // The person (on the box) switches it off: the next request on the same pipe closes the link with the not-allowed code.
        t.set_permission(&NodeId([0xab; 32]), capability::AGENTS_REMOTE, false).unwrap();
        let mut s = pc.open_bi().await.unwrap();
        wire::write_frame(&mut s.send, &Head::request("GET", "/pclink/me", 0), &[]).await.unwrap();
        assert!(wire::read_head::<_, ReplyHead>(&mut s.recv).await.is_err(), "no answer");
        assert_eq!(pc.closed().await, pm_core::p2p::endpoint::CLOSE_NOT_ALLOWED, "the host closes the door, as on the iroh link");
        served.await.unwrap();
    }

    #[test]
    fn ids_are_64_hex_characters() {
        assert_eq!(hex32(&"0f".repeat(32)), Some([0x0f; 32]));
        assert_eq!(hex(&[0x0f, 0xa0]), "0fa0");
        assert!(hex32("0f").is_none() && hex32(&"zz".repeat(32)).is_none());
    }
}

/// The fake agent's child entry: its config starts the test program again with this test's path (`pm_core::acp::fake_agent::HARNESS_ARGS`).
#[cfg(test)]
mod acp {
    pub mod fake_agent {
        pub mod tests {
            #[test]
            fn child_entry() {
                pm_core::acp::fake_agent::child_main();
            }
        }
    }
}

/// Every unit test of this program is its own data profile, set before any test starts (a start-up function the loader runs, as the app's
/// `engine_hooks` does): the profile is read once per process, so a test that reached a path first would pin the desktop app's own folder.
#[cfg(test)]
mod profile_before_tests {
    extern "C" fn init() {
        if std::env::var_os(pm_core::app_paths::PROFILE_ENV).is_none() {
            std::env::set_var(pm_core::app_paths::PROFILE_ENV, "host-test");
        }
    }
    #[cfg(target_os = "windows")]
    #[link_section = ".CRT$XCU"]
    #[used]
    static INIT: extern "C" fn() = init;
    #[cfg(target_os = "linux")]
    #[link_section = ".init_array"]
    #[used]
    static INIT: extern "C" fn() = init;
    #[cfg(target_os = "macos")]
    #[link_section = "__DATA,__mod_init_func"]
    #[used]
    static INIT: extern "C" fn() = init;
}
