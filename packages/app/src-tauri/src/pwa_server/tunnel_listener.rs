//! The loopback listener the OpenTunnel client forwards to. It is not the phone server's port and not the
//! bridge's port.
//!
//! Why a listener of its own: a request that comes through OpenTunnel arrives from `127.0.0.1`, with the
//! visitor's own `Host` (even `localhost`) and no forwarder headers, so it cannot be told apart from a request
//! made on this computer. That is the shape of the 2026-10-14 bypass. So:
//!
//! - It only talks to a client that starts with a PROXY protocol v2 header (the client is told to send one).
//!   A missing, malformed, oversized or v1 header closes the connection with no reply.
//! - Everything on it is remote, always. It never decides trust from the peer address, the `Host` or a
//!   forwarder header. The normal proxy code drops any client marker and adds ours, so the bridge asks for a
//!   paired-device bearer token.
//! - The request's `Host` must be the hostname the PROXY header names (the TLS server name). Anything else
//!   gets 421 and nothing is forwarded.
//! - The source address in the header is used for the pairing throttle and the audit log only.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::DevInfoSupplier;

/// The 12 bytes that start every PROXY protocol v2 header.
const SIGNATURE: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";
/// The most bytes after the 16-byte start that this listener reads. OpenTunnel sends at most about 300.
const MAX_HEADER_BODY: usize = 512;
/// How long a client has to send the whole header.
const HEADER_DEADLINE: Duration = Duration::from_secs(5);
const PP2_TYPE_AUTHORITY: u8 = 0x02;

/// What the PROXY header says about a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProxyInfo {
    /// The visitor's address, when the relay knew it. For the throttle and the log only.
    pub peer: Option<IpAddr>,
    /// The TLS server name the visitor asked for, lowercase.
    pub authority: String,
}

/// Read and check one PROXY v2 header. Reads exactly the header's bytes, so the request that follows stays
/// in the stream. Any problem is an `Err` (the caller closes the connection).
pub(crate) fn read_proxy_v2(stream: &mut impl Read) -> Result<ProxyInfo, &'static str> {
    let mut start = [0_u8; 16];
    stream.read_exact(&mut start).map_err(|_| "header too short")?;
    if start[..12] != SIGNATURE {
        return Err("not a PROXY v2 header");
    }
    let (command, family) = (start[12], start[13]);
    let min_body = match (command, family) {
        (0x21, 0x11) => 12,
        (0x21, 0x21) => 36,
        (0x20 | 0x21, 0x00) => 0,
        _ => return Err("unsupported command or family"),
    };
    let len = usize::from(u16::from_be_bytes([start[14], start[15]]));
    if len > MAX_HEADER_BODY {
        return Err("header too large");
    }
    if len < min_body {
        return Err("header shorter than its address block");
    }
    let mut body = vec![0_u8; len];
    stream.read_exact(&mut body).map_err(|_| "header cut short")?;

    let peer = match family {
        0x11 => Some(IpAddr::V4(Ipv4Addr::new(body[0], body[1], body[2], body[3]))),
        0x21 => {
            let mut octets = [0_u8; 16];
            octets.copy_from_slice(&body[..16]);
            let v6 = Ipv6Addr::from(octets);
            Some(IpAddr::V6(v6).to_canonical())
        }
        _ => None,
    };

    let mut authority: Option<String> = None;
    let mut at = min_body;
    while at < len {
        if at + 3 > len {
            return Err("bad extra field");
        }
        let kind = body[at];
        let size = usize::from(u16::from_be_bytes([body[at + 1], body[at + 2]]));
        at += 3;
        if at + size > len {
            return Err("extra field runs past the header");
        }
        if kind == PP2_TYPE_AUTHORITY {
            if authority.is_some() {
                return Err("two server names");
            }
            authority = Some(valid_host(&body[at..at + size])?);
        }
        at += size;
    }
    Ok(ProxyInfo { peer, authority: authority.ok_or("no server name")? })
}

/// A lowercase DNS name: letters, digits, dots and hyphens, in non-empty labels.
fn valid_host(raw: &[u8]) -> Result<String, &'static str> {
    if raw.is_empty() || raw.len() > 253 {
        return Err("bad server name");
    }
    let text = std::str::from_utf8(raw).map_err(|_| "bad server name")?.to_ascii_lowercase();
    let ok = text
        .split('.')
        .all(|label| !label.is_empty() && label.len() <= 63 && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    if ok {
        Ok(text)
    } else {
        Err("bad server name")
    }
}

/// The part of `Host` before any port, lowercase, no trailing dot.
fn host_without_port(value: &str) -> String {
    let value = value.trim();
    let host = if value.starts_with('[') {
        value
    } else {
        value.rsplit_once(':').map_or(value, |(h, p)| if p.bytes().all(|b| b.is_ascii_digit()) { h } else { value })
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// How many pairing tries one address gets per window before the listener answers 429 itself.
pub(crate) const PAIR_TRIES: usize = 8;
const PAIR_WINDOW: Duration = Duration::from_secs(60);
const PAIR_TRACKED: usize = 1024;

/// Counts pairing tries per visitor address. The bridge already burns a pairing code after a few wrong guesses;
/// this slows one visitor down before it gets that far.
#[derive(Default)]
pub(crate) struct PairThrottle {
    seen: Mutex<HashMap<Option<IpAddr>, VecDeque<Instant>>>,
}

impl PairThrottle {
    /// True when this try may go on; false when the address has used up its window.
    pub(crate) fn allow(&self, who: Option<IpAddr>, now: Instant) -> bool {
        let mut seen = self.seen.lock();
        if seen.len() >= PAIR_TRACKED && !seen.contains_key(&who) {
            seen.retain(|_, hits| hits.back().is_some_and(|last| now.duration_since(*last) < PAIR_WINDOW));
            if seen.len() >= PAIR_TRACKED {
                return false;
            }
        }
        let hits = seen.entry(who).or_default();
        while hits.front().is_some_and(|first| now.duration_since(*first) >= PAIR_WINDOW) {
            hits.pop_front();
        }
        if hits.len() >= PAIR_TRIES {
            return false;
        }
        hits.push_back(now);
        true
    }
}

/// What the shared request code needs to know about a connection that came through the tunnel.
pub(crate) struct RemoteCtx {
    host: String,
    peer: Option<IpAddr>,
    throttle: Arc<PairThrottle>,
}

impl RemoteCtx {
    pub(crate) fn new(host: String, peer: Option<IpAddr>, throttle: Arc<PairThrottle>) -> Self {
        Self { host, peer, throttle }
    }

    /// Checked before a request is forwarded or served. `Some((status, text))` is the whole reply.
    pub(crate) fn gate(&self, method: &str, path: &str, headers_raw: &str) -> Option<(u16, &'static str)> {
        let mut hosts = headers_raw
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.trim().eq_ignore_ascii_case("host"))
            .map(|(_, value)| value);
        match (hosts.next(), hosts.next()) {
            (Some(one), None) if host_without_port(one) == self.host => {}
            (Some(_), Some(_)) => return Some((400, "Bad Request")),
            _ => return Some((421, "Misdirected Request")),
        }
        let mut segments = path.split('/').filter(|s| !s.is_empty());
        if segments.next() == Some("bridge") && segments.next() == Some("pair") {
            let allowed = self.throttle.allow(self.peer, Instant::now());
            let from = self.peer.map_or_else(|| "unknown".to_string(), |ip| ip.to_string());
            crate::audit::record(
                crate::audit::Kind::Pairing,
                crate::audit::Who::Local,
                if allowed { "Someone tried to pair through the fixed phone address" } else { "A pairing try through the fixed phone address was slowed down" },
                serde_json::json!({ "from": from, "method": method, "slowed": !allowed }),
            );
            if !allowed {
                return Some((429, "Too Many Requests"));
            }
        }
        None
    }
}

/// What the listener needs to serve the phone page and reach the bridge.
pub(crate) struct ListenerConfig {
    pub dist_root: PathBuf,
    pub bridge_port_file: PathBuf,
    pub dev_info: DevInfoSupplier,
    /// The one hostname this listener answers for (`<route>.<tunnel>.<relay domain>`), lowercase.
    pub allowed_host: String,
}

/// The running listener. Dropping it stops it.
pub(crate) struct TunnelListener {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl TunnelListener {
    /// Bind a new loopback port and start answering. A new random port every time.
    pub(crate) fn start(config: ListenerConfig) -> Result<Self, String> {
        let listener = TcpListener::bind((super::HOST, 0)).map_err(|err| format!("bind the tunnel listener: {err}"))?;
        let port = listener.local_addr().map_err(|err| format!("tunnel listener address: {err}"))?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let throttle = Arc::new(PairThrottle::default());
        thread::Builder::new()
            .name("potato-workspace-tunnel-listener".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    if stop_for_thread.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let dist_root = config.dist_root.clone();
                    let bridge_port_file = config.bridge_port_file.clone();
                    let dev_info = config.dev_info.clone();
                    let allowed_host = config.allowed_host.clone();
                    let throttle = throttle.clone();
                    thread::spawn(move || serve(stream, &dist_root, &bridge_port_file, &dev_info, &allowed_host, throttle));
                }
            })
            .map_err(|err| format!("spawn the tunnel listener: {err}"))?;
        Ok(Self { port, stop })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    /// `host:port` for the OpenTunnel route target.
    pub(crate) fn target(&self) -> String {
        format!("{}:{}", super::HOST, self.port)
    }
}

impl Drop for TunnelListener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop so it sees the flag.
        let _ = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, self.port)), Duration::from_millis(500));
    }
}

fn serve(
    mut stream: TcpStream,
    dist_root: &std::path::Path,
    bridge_port_file: &std::path::Path,
    dev_info: &DevInfoSupplier,
    allowed_host: &str,
    throttle: Arc<PairThrottle>,
) {
    let _ = stream.set_read_timeout(Some(HEADER_DEADLINE));
    let info = match read_proxy_v2(&mut stream) {
        Ok(info) => info,
        Err(why) => {
            // No reply of any kind: a client that did not send the header is not the tunnel.
            tracing::debug!(why, "tunnel listener closed a connection with no valid PROXY header");
            return;
        }
    };
    if info.authority != allowed_host {
        let _ = write!(stream, "HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\n{}Connection: close\r\n\r\n", super::SECURITY_HEADERS);
        return;
    }
    let ctx = RemoteCtx::new(info.authority, info.peer, throttle);
    if let Err(err) = super::handle_connection(stream, dist_root, bridge_port_file, dev_info, Some(&ctx)) {
        tracing::debug!(%err, "tunnel request failed");
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// A PROXY v2 header for tests: IPv4 visitor `peer` and server name `sni`.
    pub(crate) fn v2_header(peer: [u8; 4], sni: &str) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&peer);
        body.extend_from_slice(&[0, 0, 0, 0]);
        body.extend_from_slice(&40000_u16.to_be_bytes());
        body.extend_from_slice(&443_u16.to_be_bytes());
        body.push(PP2_TYPE_AUTHORITY);
        body.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        body.extend_from_slice(sni.as_bytes());
        let mut out = SIGNATURE.to_vec();
        out.extend_from_slice(&[0x21, 0x11]);
        out.extend_from_slice(&(body.len() as u16).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    /// A listener on a free port for `allowed_host`, answering from `dist_root` and the bridge in `bridge_port_file`.
    pub(crate) fn start(dist_root: PathBuf, bridge_port_file: PathBuf, allowed_host: &str) -> TunnelListener {
        let dev_info: DevInfoSupplier = Arc::new(|| unreachable!("dev info is not used in tests"));
        TunnelListener::start(ListenerConfig { dist_root, bridge_port_file, dev_info, allowed_host: allowed_host.into() }).expect("start tunnel listener")
    }

    /// Like `exchange`, but a port nobody listens on (the connection is refused) gives `None` instead of a panic.
    pub(crate) fn exchange_if_open(port: u16, header: &[u8], request: &str) -> Option<String> {
        let client = TcpStream::connect((super::super::HOST, port)).ok()?;
        Some(talk(client, header, request))
    }

    /// Send `header` then `request` to `port`; read until the server closes. Empty string when it closed with no reply.
    pub(crate) fn exchange(port: u16, header: &[u8], request: &str) -> String {
        talk(TcpStream::connect((super::super::HOST, port)).expect("connect tunnel listener"), header, request)
    }

    fn talk(mut client: TcpStream, header: &[u8], request: &str) -> String {
        client.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let _ = client.write_all(header);
        let _ = client.write_all(request.as_bytes());
        let mut raw = Vec::new();
        let _ = client.read_to_end(&mut raw);
        String::from_utf8_lossy(&raw).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::fs;

    const HOST_A: &str = "k3x9q2.abc123.opentunnel.example";

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-tl-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An upstream that sends back the request head it was given, as the body.
    fn echo_upstream() -> u16 {
        let listener = TcpListener::bind((super::super::HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                // Read the whole request (head and body), so closing never resets the connection under the proxy.
                let mut got = Vec::new();
                let mut chunk = [0_u8; 4096];
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    got.extend_from_slice(&chunk[..n]);
                    if let Some(end) = got.windows(4).position(|w| w == b"

") {
                        let head = String::from_utf8_lossy(&got[..end]).to_ascii_lowercase();
                        let want = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        if got.len() >= end + 4 + want {
                            break;
                        }
                    }
                }
                let head = String::from_utf8_lossy(&got).into_owned();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{head}", head.len());
            }
        });
        port
    }

    fn rig(name: &str, host: &str) -> (TunnelListener, PathBuf) {
        let dir = dir(name);
        let port_file = dir.join("bridge.port");
        fs::write(&port_file, format!("127.0.0.1:{}\n", echo_upstream())).unwrap();
        fs::write(dir.join("index.html"), "<html>phone</html>").unwrap();
        (start(dir.clone(), port_file, host), dir)
    }

    fn get(path: &str, host: &str, extra: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: close\r\n\r\n")
    }

    #[test]
    fn a_listener_started_again_after_a_stop_is_running_and_still_checks_the_host() {
        let (first, dir) = rig("again", HOST_A);
        let first_port = first.port();
        assert!(exchange(first_port, &v2_header([203, 0, 113, 9], HOST_A), &get("/", HOST_A, "")).starts_with("HTTP/1.1 200"));
        drop(first);
        // Stopped: the old port no longer answers (a refused connection, or one closed with no reply).
        std::thread::sleep(Duration::from_millis(300));
        let old = exchange_if_open(first_port, &v2_header([203, 0, 113, 9], HOST_A), &get("/", HOST_A, ""));
        assert!(old.as_deref().map_or(true, str::is_empty), "the stopped listener still answered: {old:?}");
        // Started again with the same files: a new listener answers, still wants the PROXY v2 header and the right host.
        let second = start(dir.clone(), dir.join("bridge.port"), HOST_A);
        assert!(exchange(second.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/", HOST_A, "")).starts_with("HTTP/1.1 200"));
        assert_eq!(exchange(second.port(), b"", &get("/", HOST_A, "")), "");
        assert!(exchange(second.port(), &v2_header([203, 0, 113, 9], "other.example"), &get("/", "other.example", "")).starts_with("HTTP/1.1 421"));
    }

    #[test]
    fn a_connection_with_no_proxy_header_is_closed_with_no_reply() {
        let (tl, _) = rig("none", HOST_A);
        assert_eq!(exchange(tl.port(), b"", &get("/", HOST_A, "")), "");
    }

    #[test]
    fn a_v1_header_is_closed_with_no_reply() {
        let (tl, _) = rig("v1", HOST_A);
        assert_eq!(exchange(tl.port(), b"PROXY TCP4 203.0.113.9 0.0.0.0 51234 443\r\n", &get("/", HOST_A, "")), "");
    }

    #[test]
    fn a_malformed_or_oversized_v2_header_is_closed_with_no_reply() {
        let (tl, _) = rig("bad", HOST_A);
        // wrong signature
        let mut broken = v2_header([203, 0, 113, 9], HOST_A);
        broken[3] ^= 0xff;
        assert_eq!(exchange(tl.port(), &broken, &get("/", HOST_A, "")), "");
        // a length that claims more than the cap
        let mut huge = v2_header([203, 0, 113, 9], HOST_A);
        huge[14..16].copy_from_slice(&60000_u16.to_be_bytes());
        assert_eq!(exchange(tl.port(), &huge, &get("/", HOST_A, "")), "");
        // an extra field that runs past the header
        let mut cut = v2_header([203, 0, 113, 9], HOST_A);
        let at = cut.len() - HOST_A.len() - 2;
        cut[at..at + 2].copy_from_slice(&5000_u16.to_be_bytes());
        assert_eq!(exchange(tl.port(), &cut, &get("/", HOST_A, "")), "");
        // no server name at all
        let mut nameless = SIGNATURE.to_vec();
        nameless.extend_from_slice(&[0x21, 0x11, 0, 12, 203, 0, 113, 9, 0, 0, 0, 0, 0x9c, 0x40, 0x01, 0xbb]);
        assert_eq!(exchange(tl.port(), &nameless, &get("/", HOST_A, "")), "");
        // a server name with a space in it
        assert_eq!(exchange(tl.port(), &v2_header([203, 0, 113, 9], "bad host"), &get("/", "bad host", "")), "");
    }

    #[test]
    fn the_parser_reads_ipv4_and_ipv6_peers_and_the_name() {
        let parsed = read_proxy_v2(&mut std::io::Cursor::new(v2_header([203, 0, 113, 9], "Route.Id.Example.COM"))).unwrap();
        assert_eq!(parsed, ProxyInfo { peer: Some("203.0.113.9".parse().unwrap()), authority: "route.id.example.com".into() });
        let mut v6 = SIGNATURE.to_vec();
        let mut body = Vec::new();
        body.extend_from_slice(&"2001:db8::1".parse::<Ipv6Addr>().unwrap().octets());
        body.extend_from_slice(&[0; 16]);
        body.extend_from_slice(&[0x9c, 0x40, 0x01, 0xbb]);
        body.extend_from_slice(&[PP2_TYPE_AUTHORITY, 0, 3, b'a', b'.', b'b']);
        v6.extend_from_slice(&[0x21, 0x21]);
        v6.extend_from_slice(&(body.len() as u16).to_be_bytes());
        v6.extend_from_slice(&body);
        let parsed = read_proxy_v2(&mut std::io::Cursor::new(v6)).unwrap();
        assert_eq!(parsed.peer, Some("2001:db8::1".parse().unwrap()));
        assert_eq!(parsed.authority, "a.b");
    }

    #[test]
    fn a_valid_v2_request_for_the_tunnel_host_is_served() {
        let (tl, _) = rig("ok", HOST_A);
        let page = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/", HOST_A, ""));
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("<html>phone</html>"), "{page}");
        // the port may be on the Host
        let with_port = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/", &format!("{HOST_A}:443"), ""));
        assert!(with_port.starts_with("HTTP/1.1 200"), "{with_port}");
    }

    #[test]
    fn a_host_that_is_not_the_proxy_name_gets_421_and_nothing_is_forwarded() {
        let (tl, _) = rig("421", HOST_A);
        for host in ["localhost", "127.0.0.1", "other.example.com"] {
            let reply = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/bridge/health", host, ""));
            assert!(reply.starts_with("HTTP/1.1 421"), "{host}: {reply}");
            assert!(!reply.contains("GET /health"), "the request must not reach the bridge: {reply}");
        }
        // no Host at all, and two Host lines
        let none = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), "GET /bridge/health HTTP/1.1\r\nConnection: close\r\n\r\n");
        assert!(none.starts_with("HTTP/1.1 421"), "{none}");
        let two = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/bridge/health", HOST_A, &format!("Host: {HOST_A}\r\n")));
        assert!(two.starts_with("HTTP/1.1 400"), "{two}");
        // a header that names some other host than this tunnel's
        let wrong = exchange(tl.port(), &v2_header([203, 0, 113, 9], "elsewhere.example.com"), &get("/", "elsewhere.example.com", ""));
        assert!(wrong.starts_with("HTTP/1.1 421"), "{wrong}");
    }

    #[test]
    fn a_client_marker_is_dropped_and_ours_is_added() {
        let (tl, _) = rig("marker", HOST_A);
        let forged = "X-Potato-Workspace-Proxied: 0\r\nx-pm-proxied: 0\r\n X-Potato-Workspace-Proxied: 0\r\nX-Forwarded-For: 127.0.0.1\r\n";
        let reply = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/bridge/panes", HOST_A, forged));
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        let marker_lines: Vec<&str> = reply.lines().filter(|l| l.to_ascii_lowercase().contains("proxied")).collect();
        assert_eq!(marker_lines, ["X-Potato-Workspace-Proxied: 1"], "{reply}");
        // and the upstream is always asked as the bridge's own address, not what the visitor said
        assert!(!reply.contains(HOST_A), "{reply}");
    }

    #[test]
    fn pairing_tries_are_slowed_per_visitor_address() {
        let throttle = PairThrottle::default();
        let now = Instant::now();
        let one: Option<IpAddr> = Some("203.0.113.9".parse().unwrap());
        let two: Option<IpAddr> = Some("203.0.113.10".parse().unwrap());
        for _ in 0..PAIR_TRIES {
            assert!(throttle.allow(one, now));
        }
        assert!(!throttle.allow(one, now), "the ninth try in a minute waits");
        assert!(throttle.allow(two, now), "another visitor is not slowed");
        assert!(throttle.allow(one, now + PAIR_WINDOW + Duration::from_secs(1)), "the window passes");
    }

    #[test]
    fn the_listener_answers_429_for_a_visitor_that_keeps_pairing() {
        let (tl, _) = rig("429", HOST_A);
        let pair = format!("POST /bridge/pair HTTP/1.1\r\nHost: {HOST_A}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
        let mut last = String::new();
        for _ in 0..=PAIR_TRIES {
            last = exchange(tl.port(), &v2_header([198, 51, 100, 77], HOST_A), &pair);
        }
        assert!(last.starts_with("HTTP/1.1 429"), "{last}");
        let other = exchange(tl.port(), &v2_header([198, 51, 100, 78], HOST_A), &pair);
        assert!(other.starts_with("HTTP/1.1 200"), "{other}");
    }

    #[test]
    fn the_dev_info_is_never_served_through_the_listener_and_replies_carry_the_security_headers() {
        let (tl, _) = rig("devinfo", HOST_A);
        // The test supplier would panic if it were asked: a 404 means it was not.
        let reply = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/__puppet_master_dev__.json", HOST_A, ""));
        assert!(reply.starts_with("HTTP/1.1 404"), "{reply}");
        assert!(reply.contains("X-Frame-Options: DENY") && reply.contains("frame-ancestors 'none'"), "{reply}");
        let wrong_host = exchange(tl.port(), &v2_header([203, 0, 113, 9], HOST_A), &get("/", "other.example.com", ""));
        assert!(wrong_host.starts_with("HTTP/1.1 421") && wrong_host.contains("X-Content-Type-Options: nosniff"), "{wrong_host}");
    }

    #[test]
    fn dropping_the_listener_stops_it() {
        let (tl, _) = rig("drop", HOST_A);
        let port = tl.port();
        drop(tl);
        thread::sleep(Duration::from_millis(300));
        assert!(TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(500)).is_err());
    }
}
