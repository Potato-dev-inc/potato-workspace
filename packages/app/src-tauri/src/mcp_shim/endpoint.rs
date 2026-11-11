//! Discovery of the running app's bridge endpoint (port file lookup and parsing).

use super::*;

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
                return Ok(live_endpoint_or_probe(endpoint));
            }
            Err(err) => last_error = format!("{}: {err}", candidate.display()),
        }
    }
    Err(format!(
        "bridge_down: Potato Workspace bridge port file not found (tried: {}). Last error: {last_error}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// The port file can be stale (an instance exited and left it behind). When its port refuses
/// connections, scan the app's whole bridge port range (`app_paths::bridge_port_range_for`) and take the
/// first port whose `/health` says it is Potato Workspace (`product` marker). A port that only
/// accepts a connection is not enough: another program may have taken it.
pub(crate) fn live_endpoint_or_probe(endpoint: BridgeEndpoint) -> BridgeEndpoint {
    if accepts_connection(&endpoint.host, endpoint.port) {
        return endpoint;
    }
    #[cfg(test)]
    if test_endpoint_override().is_some() {
        return endpoint; // a test's fake bridge: never scan for a real app
    }
    let (lo, hi) = puppet_master_app_lib::app_paths::bridge_port_range_for(
        puppet_master_app_lib::app_paths::profile().as_deref(),
    );
    match probe_for_bridge(&endpoint.host, lo, hi) {
        Some(port) => BridgeEndpoint { host: endpoint.host, port },
        None => endpoint,
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
pub(crate) fn probe_for_bridge(host: &str, lo: u16, hi: u16) -> Option<u16> {
    let ip = host.parse::<std::net::IpAddr>().ok()?;
    (lo..=hi).find(|port| port_reports_our_product(ip, *port))
}

fn port_reports_our_product(ip: std::net::IpAddr, port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::new(ip, port), PROBE_CONNECT_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!("GET /health HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];
    // Read until close or a timeout; the health body is a few KB at most.
    while response.len() < 256 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => response.extend_from_slice(&chunk[..n]),
        }
    }
    let Some(split) = response.windows(4).position(|w| w == b"\r\n\r\n") else { return false };
    serde_json::from_slice::<Value>(&response[split + 4..])
        .ok()
        .and_then(|health| health.get("product").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|product| product == puppet_master_app_lib::bridge_identity::PRODUCT)
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
