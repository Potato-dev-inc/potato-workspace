//! Discovery of the running app's bridge endpoint (port file lookup and parsing).

use super::*;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BridgeEndpoint {
    pub(crate) host: String,
    pub(crate) port: u16,
}

impl BridgeEndpoint {
    pub(crate) fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

pub(crate) fn read_bridge_endpoint() -> Result<BridgeEndpoint, String> {
    let candidates = bridge_port_candidates();
    read_bridge_endpoint_from_candidates(&candidates)
}

/// The app writes its per-launch local secret here, beside the port file (S3).
const LOCAL_SECRET_FILE: &str = "potato-workspace.bridge.secret";

/// `X-Potato-Workspace-Local-Secret: <hex>\r\n` for every bridge request, or "" when there is no secret file
/// (an older app). Read from beside the same port file `read_bridge_endpoint` uses, each request,
/// so a restarted app's new secret is picked up. The bridge only logs a missing secret for now.
pub(crate) fn local_secret_header() -> String {
    local_secret_header_from_candidates(&bridge_port_candidates())
}

pub(crate) fn local_secret_header_from_candidates(candidates: &[PathBuf]) -> String {
    candidates
        .iter()
        .find(|path| path.is_file())
        .and_then(|path| fs::read_to_string(path.with_file_name(LOCAL_SECRET_FILE)).ok())
        .map(|raw| raw.trim().to_string())
        .filter(|secret| !secret.is_empty() && secret.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|secret| format!("X-Potato-Workspace-Local-Secret: {secret}\r\n"))
        .unwrap_or_default()
}

pub(crate) fn read_bridge_endpoint_from_candidates(
    candidates: &[PathBuf],
) -> Result<BridgeEndpoint, String> {
    let mut last_error = String::new();
    for candidate in candidates {
        match fs::read_to_string(candidate) {
            Ok(raw) => {
                let endpoint = parse_bridge_endpoint(&raw)?;
                let (endpoint, picked) = resolve_endpoint(endpoint, Some(candidate));
                record_resolution(candidate, &endpoint, picked);
                return Ok(endpoint);
            }
            Err(err) => last_error = format!("{}: {err}", candidate.display()),
        }
    }
    Err(format!(
        "bridge_down: Potato Workspace bridge port file not found (tried: {}). Last error: {last_error}. {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        stale_entry_hint()
    ))
}

/// How the endpoint the shim talks to was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Picked {
    /// The port file's own port answered.
    PortFile,
    /// The port file's port was dead; a live bridge of the same profile was found by scanning.
    ProbeSameProfile,
    /// Nothing of the same profile was live; another profile's app was taken instead.
    ProbeOtherProfile,
}

impl Picked {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Picked::PortFile => "port_file",
            Picked::ProbeSameProfile => "probe_same_profile",
            Picked::ProbeOtherProfile => "probe_other_profile",
        }
    }

    pub(crate) fn describe(self) -> &'static str {
        match self {
            Picked::PortFile => "via port file",
            Picked::ProbeSameProfile => "via probe (the port file was stale; same profile)",
            Picked::ProbeOtherProfile => {
                "via probe (the port file was stale; a DIFFERENT profile's app, check this is the one you want)"
            }
        }
    }
}

/// What the last port-file lookup resolved to (for `bridge_health` and error texts).
#[derive(Debug, Clone)]
pub(crate) struct Resolution {
    pub(crate) port_file: PathBuf,
    pub(crate) port: u16,
    pub(crate) picked: Picked,
}

static LAST_RESOLUTION: std::sync::Mutex<Option<Resolution>> = std::sync::Mutex::new(None);

fn record_resolution(port_file: &Path, endpoint: &BridgeEndpoint, picked: Picked) {
    if let Ok(mut last) = LAST_RESOLUTION.lock() {
        *last = Some(Resolution { port_file: port_file.to_path_buf(), port: endpoint.port, picked });
    }
}

pub(crate) fn last_resolution() -> Option<Resolution> {
    LAST_RESOLUTION.lock().ok().and_then(|last| last.clone())
}

/// The profile a port file belongs to, read from its app-data folder name:
/// `com.potatodev.workspace` is the default profile (`Some(None)`), `...profile-X` is `Some(Some("X"))`,
/// anything else (a custom location) is unknown (`None`).
pub(crate) fn profile_of_port_file(port_file: &Path) -> Option<Option<String>> {
    let folder = port_file.parent()?.file_name()?.to_str()?;
    if folder.eq_ignore_ascii_case(APP_ID) {
        return Some(None);
    }
    let rest = folder.strip_prefix(APP_ID)?.strip_prefix(".profile-")?;
    (!rest.is_empty()).then(|| Some(rest.to_string()))
}

/// The port file can be stale (an instance exited and left it behind). When its port refuses
/// connections, scan the app's bridge port range (`app_paths::bridge_port_range_for`) for a
/// bridge whose `/health` says it is Potato Workspace (`product` marker), preferring one of the
/// profile the port file belongs to. A port that only accepts a connection is not enough: another
/// program may have taken it.
pub(crate) fn resolve_endpoint(endpoint: BridgeEndpoint, port_file: Option<&Path>) -> (BridgeEndpoint, Picked) {
    if accepts_connection(&endpoint.host, endpoint.port) {
        return (endpoint, Picked::PortFile);
    }
    #[cfg(test)]
    if test_endpoint_override().is_some() {
        return (endpoint, Picked::PortFile); // a test's fake bridge: never scan for a real app
    }
    let shim_profile = puppet_master_app_lib::app_paths::profile();
    let expected = port_file.and_then(profile_of_port_file).unwrap_or(shim_profile);
    let (lo, hi) = puppet_master_app_lib::app_paths::bridge_port_range_for(expected.as_deref());
    let Ok(ip) = endpoint.host.parse::<std::net::IpAddr>() else { return (endpoint, Picked::PortFile) };
    match probe_with(lo, hi, expected.as_deref(), &|port| fetch_health(ip, port)) {
        Some((port, picked)) => (BridgeEndpoint { host: endpoint.host, port }, picked),
        None => (endpoint, Picked::PortFile),
    }
}

/// Scan `lo..=hi` through `health_of` (a port's `/health` body when something answers). The first
/// Potato Workspace bridge of the `expected` profile wins; otherwise the first other one is taken.
pub(crate) fn probe_with(
    lo: u16,
    hi: u16,
    expected: Option<&str>,
    health_of: &dyn Fn(u16) -> Option<Value>,
) -> Option<(u16, Picked)> {
    let mut other = None;
    for port in lo..=hi {
        let Some(health) = health_of(port).filter(is_our_product) else { continue };
        if health.get("profile").and_then(Value::as_str) == expected {
            return Some((port, Picked::ProbeSameProfile));
        }
        other.get_or_insert(port);
    }
    other.map(|port| (port, Picked::ProbeOtherProfile))
}

fn is_our_product(health: &Value) -> bool {
    health.get("product").and_then(Value::as_str) == Some(puppet_master_app_lib::bridge_identity::PRODUCT)
}

/// Which app a `/health` body came from and how the shim got there: `bridge_health`'s `connected_to`.
pub(crate) fn connected_to(health: &Value, resolution: Option<&Resolution>) -> Value {
    let text = |key: &str| health.get(key).and_then(Value::as_str).map(str::to_owned);
    json!({
        "product": text("product"),
        "version": text("version"),
        "build_id": text("build_id"),
        "build_kind": text("build_kind"),
        "profile": text("profile"),
        "app_data_dir": text("app_data_dir"),
        "port": resolution.map(|r| r.port),
        "port_file": resolution.map(|r| r.port_file.display().to_string()),
        "picked": resolution.map(|r| r.picked.as_str()),
    })
}

/// "Potato Workspace 1.0.18 (release, default profile) on 127.0.0.1:17421 via port file".
pub(crate) fn connected_to_text(connected: &Value) -> String {
    let text = |key: &str| connected.get(key).and_then(Value::as_str);
    let kind = text("build_kind").unwrap_or("unknown build");
    let profile = text("profile").map_or("default profile".to_string(), |p| format!("profile {p}"));
    let version = text("version").map(|v| format!(" {v}")).unwrap_or_default();
    let on = connected
        .get("port")
        .and_then(Value::as_u64)
        .map(|port| format!(" on 127.0.0.1:{port}"))
        .unwrap_or_default();
    let via = match text("picked") {
        Some("probe_same_profile") => Picked::ProbeSameProfile.describe(),
        Some("probe_other_profile") => Picked::ProbeOtherProfile.describe(),
        Some(_) => Picked::PortFile.describe(),
        None => "",
    };
    format!("Potato Workspace{version} ({kind}, {profile}){on} {via}").trim_end().to_string()
}

/// The legacy variable an old "puppet-master" MCP entry sets. Read only to explain a failure.
const LEGACY_PORT_FILE_ENV: &str = "PUPPET_MASTER_BRIDGE_PORT_FILE";

/// One sentence for every "cannot reach the app" error: a second, stale MCP entry is the usual cause.
pub(crate) fn stale_entry_hint() -> String {
    let mut hint = String::from(
        "If you have more than one Potato Workspace MCP server configured (for example an old \"puppet-master\" entry), remove the stale one.",
    );
    if let Ok(legacy) = env::var(LEGACY_PORT_FILE_ENV) {
        if !legacy.trim().is_empty() {
            hint.push_str(&format!(
                " This process also has {LEGACY_PORT_FILE_ENV}={legacy} set, which belongs to the legacy entry and is ignored."
            ));
        }
    }
    hint
}

/// "Tried port file X (port N)." plus [`stale_entry_hint`], for a connection that failed on `port`.
pub(crate) fn unreachable_detail(port: u16) -> String {
    match last_resolution() {
        Some(last) => format!("Tried port file {} (port {port}). {}", last.port_file.display(), stale_entry_hint()),
        None => format!("Tried port {port}. {}", stale_entry_hint()),
    }
}

const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

pub(crate) fn accepts_connection(host: &str, port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let Ok(ip) = host.parse::<std::net::IpAddr>() else { return false };
    if !ip.is_loopback() {
        return false;
    }
    TcpStream::connect_timeout(&SocketAddr::new(ip, port), PROBE_CONNECT_TIMEOUT).is_ok()
}

/// The first port in `lo..=hi` whose `GET /health` names Potato Workspace as the product.
#[cfg(test)]
pub(crate) fn probe_for_bridge(host: &str, lo: u16, hi: u16) -> Option<u16> {
    let ip = host.parse::<std::net::IpAddr>().ok()?;
    (lo..=hi).find(|port| fetch_health(ip, *port).is_some_and(|health| is_our_product(&health)))
}

/// `GET /health` of a loopback port as JSON, when something there answers with a JSON body.
fn fetch_health(ip: std::net::IpAddr, port: u16) -> Option<Value> {
    use std::net::{SocketAddr, TcpStream};
    if !ip.is_loopback() {
        return None;
    }
    let mut stream = TcpStream::connect_timeout(&SocketAddr::new(ip, port), PROBE_CONNECT_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!("GET /health HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];
    // Read until close or a timeout; the health body is a few KB at most.
    while response.len() < 256 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => response.extend_from_slice(&chunk[..n]),
        }
    }
    let split = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    serde_json::from_slice::<Value>(&response[split + 4..]).ok()
}

/// Tests point one session at a fake bridge's port file without touching process-wide env vars
/// (other tests share them). Keyed by MCP session id, which worker threads inherit.
#[cfg(test)]
pub(crate) static TEST_ENDPOINTS: std::sync::Mutex<Vec<(String, PathBuf)>> = std::sync::Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) fn test_endpoint_override() -> Option<PathBuf> {
    let session = current_mcp_session_id()?;
    TEST_ENDPOINTS.lock().ok()?.iter().find(|(id, _)| *id == session).map(|(_, path)| path.clone())
}

pub(crate) fn bridge_port_candidates() -> Vec<PathBuf> {
    #[cfg(test)]
    if let Some(path) = test_endpoint_override() {
        return vec![path];
    }
    if let Ok(path) = env::var(BRIDGE_PORT_FILE_ENV) {
        return vec![PathBuf::from(expand_env_vars(&path, |name| {
            env::var(name).ok()
        }))];
    }
    // Never the current directory: a repository an agent works in could ship its own port file and
    // redirect MCP traffic (and the local secret) to a server of its choosing.
    vec![default_app_data_bridge_port_file()]
}

/// Expands `%VAR%` references so config files that cannot expand variables
/// themselves (e.g. an MCP client's `env` block) can still use `%APPDATA%`.
/// Unknown variables are left untouched.
pub(crate) fn expand_env_vars(input: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match lookup(&after[..end]) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                }
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn default_app_data_bridge_port_file() -> PathBuf {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "windows") {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join(APP_ID)
            .join(DEFAULT_BRIDGE_PORT_FILE)
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join(APP_ID)
            .join(DEFAULT_BRIDGE_PORT_FILE)
    } else {
        home.join(".local")
            .join("share")
            .join(APP_ID)
            .join(DEFAULT_BRIDGE_PORT_FILE)
    }
}

pub(crate) fn parse_bridge_endpoint(raw: &str) -> Result<BridgeEndpoint, String> {
    let trimmed = raw.trim();
    let (host, port_text) = trimmed
        .split_once(':')
        .map(|(host, port)| (if host.is_empty() { "127.0.0.1" } else { host }, port))
        .unwrap_or(("127.0.0.1", trimmed));
    let port = port_text
        .parse::<u16>()
        .map_err(|err| format!("invalid bridge port file value {trimmed:?}: {err}"))?;
    // The bridge only ever listens on this computer. A port file naming any other host is refused.
    let host = if host.eq_ignore_ascii_case("localhost") { "127.0.0.1" } else { host };
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_loopback() => {}
        _ => return Err(format!("refusing a non-loopback bridge host {host:?} in the port file")),
    }
    Ok(BridgeEndpoint {
        host: host.to_string(),
        port,
    })
}

#[cfg(test)]
mod loopback_tests {
    use super::*;

    #[test]
    fn a_port_file_naming_another_host_is_refused() {
        assert!(parse_bridge_endpoint("evil.example.com:17321").is_err());
        assert!(parse_bridge_endpoint("10.0.0.5:17321").is_err());
        assert!(parse_bridge_endpoint("0.0.0.0:17321").is_err());
        assert_eq!(parse_bridge_endpoint("localhost:17321").unwrap().host, "127.0.0.1");
        assert!(!accepts_connection("10.0.0.5", 17321));
        assert!(!accepts_connection("example.com", 17321));
    }

    #[test]
    fn the_current_directory_is_never_a_port_file_candidate() {
        let candidates = bridge_port_candidates();
        assert!(!candidates.contains(&PathBuf::from(DEFAULT_BRIDGE_PORT_FILE)), "{candidates:?}");
    }
}

#[cfg(test)]
mod env_expansion_tests {
    use super::expand_env_vars;

    fn lookup(name: &str) -> Option<String> {
        (name == "APPDATA").then(|| r"C:\Users\x\AppData\Roaming".to_string())
    }

    #[test]
    fn expands_known_variable() {
        assert_eq!(
            expand_env_vars(r"%APPDATA%\app\bridge.port", lookup),
            r"C:\Users\x\AppData\Roaming\app\bridge.port"
        );
    }

    #[test]
    fn leaves_unknown_and_unpaired_percent_untouched() {
        assert_eq!(expand_env_vars("%NOPE%/a", lookup), "%NOPE%/a");
        assert_eq!(expand_env_vars("100%/a", lookup), "100%/a");
        assert_eq!(expand_env_vars("%%", lookup), "%%");
    }
}

#[cfg(test)]
mod which_app_tests {
    use super::*;

    fn health(profile: Option<&str>) -> Value {
        let mut body = json!({"product": puppet_master_app_lib::bridge_identity::PRODUCT, "version": "1.0.18"});
        if let Some(profile) = profile {
            body["profile"] = json!(profile);
        }
        body
    }

    #[test]
    fn the_profile_comes_from_the_port_files_app_data_folder() {
        let default = Path::new("C:/Users/x/AppData/Roaming/com.potatodev.workspace/potato-workspace.bridge.port");
        let dev = Path::new("C:/Users/x/AppData/Roaming/com.potatodev.workspace.profile-workspace/potato-workspace.bridge.port");
        let legacy = Path::new("C:/Users/x/AppData/Roaming/com.puppetmaster.app/bridge.port");
        assert_eq!(profile_of_port_file(default), Some(None));
        assert_eq!(profile_of_port_file(dev), Some(Some("workspace".to_string())));
        assert_eq!(profile_of_port_file(legacy), None);
        assert_eq!(profile_of_port_file(Path::new("bridge.port")), None);
    }

    #[test]
    fn a_stale_port_file_prefers_the_bridge_of_its_own_profile() {
        // 17421 is a dev profile, 17425 the installed (default) app, 17430 another default one.
        let answers = |port: u16| match port {
            17421 => Some(health(Some("workspace"))),
            17425 | 17430 => Some(health(None)),
            17426 => Some(json!({"product": "someone-else"})),
            _ => None,
        };
        assert_eq!(probe_with(17421, 17499, None, &answers), Some((17425, Picked::ProbeSameProfile)));
        assert_eq!(probe_with(17421, 17499, Some("workspace"), &answers), Some((17421, Picked::ProbeSameProfile)));
    }

    #[test]
    fn with_no_bridge_of_the_expected_profile_another_live_one_is_taken_and_marked() {
        let answers = |port: u16| (port == 17462).then(|| health(Some("workspace")));
        assert_eq!(probe_with(17421, 17499, None, &answers), Some((17462, Picked::ProbeOtherProfile)));
        assert_eq!(probe_with(17421, 17499, Some("qa"), &answers), Some((17462, Picked::ProbeOtherProfile)));
    }

    #[test]
    fn another_product_or_nothing_alive_picks_nothing() {
        let foreign = |port: u16| (port == 17430).then(|| json!({"product": "puppet-master", "profile": "x"}));
        assert_eq!(probe_with(17421, 17499, None, &foreign), None);
        assert_eq!(probe_with(17421, 17499, None, &|_| None), None);
    }

    #[test]
    fn connected_to_says_which_app_and_how_it_was_found() {
        let mut body = health(None);
        body["build_id"] = json!("abc-dirty@1");
        body["build_kind"] = json!("release");
        body["app_data_dir"] = json!("com.potatodev.workspace");
        let resolution = Resolution {
            port_file: PathBuf::from("C:/x/com.potatodev.workspace/potato-workspace.bridge.port"),
            port: 17421,
            picked: Picked::PortFile,
        };
        let connected = connected_to(&body, Some(&resolution));
        assert_eq!(connected["product"], puppet_master_app_lib::bridge_identity::PRODUCT);
        assert_eq!(connected["version"], "1.0.18");
        assert_eq!(connected["build_id"], "abc-dirty@1");
        assert_eq!(connected["build_kind"], "release");
        assert_eq!(connected["profile"], Value::Null);
        assert_eq!(connected["port"], 17421);
        assert_eq!(connected["picked"], "port_file");
        assert!(connected["port_file"].as_str().unwrap().ends_with("potato-workspace.bridge.port"));
        assert_eq!(
            connected_to_text(&connected),
            "Potato Workspace 1.0.18 (release, default profile) on 127.0.0.1:17421 via port file"
        );
        let other = Resolution { picked: Picked::ProbeOtherProfile, ..resolution };
        let mut dev = health(Some("workspace"));
        dev["build_kind"] = json!("dev");
        let text = connected_to_text(&connected_to(&dev, Some(&other)));
        assert!(text.contains("(dev, profile workspace)") && text.contains("DIFFERENT profile"), "{text}");
    }

    #[test]
    fn an_older_app_without_the_new_fields_still_reads() {
        let connected = connected_to(&health(None), None);
        assert_eq!(connected["picked"], Value::Null);
        assert_eq!(connected_to_text(&connected), "Potato Workspace 1.0.18 (unknown build, default profile)");
    }

    #[test]
    fn the_unreachable_text_names_the_stale_entry_and_the_legacy_variable_only_as_a_hint() {
        let hint = stale_entry_hint();
        assert!(hint.contains("more than one Potato Workspace MCP server"), "{hint}");
        assert!(hint.contains("remove the stale one"), "{hint}");
        let detail = unreachable_detail(17421);
        assert!(detail.contains("17421"), "{detail}");
        let down = read_bridge_endpoint_from_candidates(&[PathBuf::from("Z:/no/such/dir/x.port")]).unwrap_err();
        assert!(down.starts_with("bridge_down"), "{down}");
        assert!(down.contains("Z:/no/such/dir/x.port") && down.contains("remove the stale one"), "{down}");
    }

    #[test]
    fn a_dead_port_file_port_is_not_taken_from_the_legacy_env_var() {
        // The legacy variable is never a candidate: candidates come from the new variable or the default folder.
        let candidates = bridge_port_candidates();
        assert!(candidates.iter().all(|c| !c.to_string_lossy().contains("puppetmaster")), "{candidates:?}");
    }
}
