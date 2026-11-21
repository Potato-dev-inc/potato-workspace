//! "My domain": the person's own https address that already points at this PC (a reverse proxy, their own Cloudflare
//! tunnel, ...). This module only validates what they typed and checks, safely, that the address reaches a Potato
//! Workspace. It never saves anything (see `worker_origins` for the saved link choice) and never widens CORS: a phone
//! that opens this address loads the page straight from this PC, so its calls are same-origin.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

use crate::mobile_tunnel::{interpret_health, ConnectionTest};

pub(crate) const CHECK_TIMEOUT: Duration = Duration::from_secs(6);
pub(crate) const BODY_CAP: u64 = 64 * 1024;

/// Turn what a person typed (`phone.example.com`, `https://phone.example.com/anything?x=1`) into `https://host[:port]`.
/// Plain words in every error: this text is shown on the screen as is.
pub fn normalize(raw: &str) -> Result<String, String> {
    let typed = raw.trim();
    if typed.is_empty() {
        return Err("Type your web address, for example phone.example.com.".into());
    }
    let (scheme, rest) = match typed.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("https".to_string(), typed),
    };
    if scheme != "https" && scheme != "http" {
        return Err("Use a web address that starts with https.".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if authority.is_empty() || authority.contains('@') || authority.chars().any(|c| c.is_whitespace() || c == '*' || c == '\\') {
        return Err("That does not look like a web address.".into());
    }
    if authority.starts_with('[') {
        return Err("Use a name like phone.example.com, not a number address.".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            let n: u32 = p.parse().map_err(|_| "That port number is not valid.".to_string())?;
            if n == 0 || n > 65535 {
                return Err("That port number is not valid.".into());
            }
            (h.to_string(), Some(n))
        }
        Some(_) => return Err("That does not look like a web address.".into()),
        None => (authority.clone(), None),
    };
    let host = host.trim_end_matches('.').to_string();
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return Err("That does not look like a web address.".into());
    }
    if host.parse::<IpAddr>().is_ok() || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err("Use a name like phone.example.com, not a number address.".into());
    }
    {
        // This computer is never "my domain": a phone cannot reach it, and a check must never be aimed at it.
        if host == "localhost" || host.ends_with(".localhost") {
            return Err("Type a web address that works from anywhere, not this computer's own name.".into());
        }
        if scheme == "http" {
            return Err("Use an address that starts with https, so your phone stays private.".into());
        }
        // Old-style number spellings (0x7f.1, 127.1, example.123) are read as numbers by some systems.
        let last = host.rsplit('.').next().unwrap_or("");
        if last.bytes().all(|b| b.is_ascii_digit()) || last.starts_with("0x") {
            return Err("Use a name like phone.example.com, not a number address.".into());
        }
        if host.ends_with(".trycloudflare.com") || host.ends_with(".workers.dev") {
            return Err("That is a Cloudflare address this app already uses. Type a domain of your own, or pick Permanent or Temporary link.".into());
        }
        let private_suffix = [".local", ".localhost", ".internal", ".lan", ".home", ".home.arpa", ".corp"].iter().any(|s| host.ends_with(s));
        if !host.contains('.') || private_suffix {
            return Err("Type the full name that works from anywhere, for example phone.example.com.".into());
        }
        if host.len() > 253 || host.split('.').any(|l| l.is_empty() || l.len() > 63 || l.starts_with('-') || l.ends_with('-')) {
            return Err("That does not look like a web address.".into());
        }
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    Ok(match port {
        Some(p) if p != default_port => format!("{scheme}://{host}:{p}"),
        _ => format!("{scheme}://{host}"),
    })
}

/// True for an address on the open internet. Everything private, local, shared or reserved is out: the check must
/// never be a way to poke at the person's own network.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => public_v4(v4),
            None => public_v6(v6),
        },
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19))
        || a >= 240)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let first_six_zero = s[..6].iter().all(|&x| x == 0);
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || first_six_zero                                    // ::/96, the old IPv4-compatible form (also ::, ::1)
        || (s[..4].iter().all(|&x| x == 0) && s[4] == 0xffff) // ::ffff:0:0:0/96, IPv4-translated
        || (s[0] & 0xfe00) == 0xfc00                          // fc00::/7 unique local
        || (s[0] & 0xffc0) == 0xfe80                          // fe80::/10 link local
        || (s[0] & 0xffc0) == 0xfec0                          // fec0::/10 site local (old)
        || s[0] == 0x2002                                     // 2002::/16 6to4 (embeds an IPv4 we cannot trust)
        || (s[0] == 0x2001 && s[1] == 0)                      // 2001::/32 Teredo
        || (s[0] == 0x2001 && s[1] == 0x0db8)                 // documentation
        || (s[0] == 0x0064 && s[1] == 0xff9b)                 // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64
        || (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0)) // 100::/64 discard
}

/// Looks the name up and keeps only public addresses. The connection is made to what this
/// returns, so a name that answers differently a moment later cannot swap in a private address.
pub(crate) struct PublicOnly;

impl ureq::Resolver for PublicOnly {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let kept: Vec<SocketAddr> = netloc.to_socket_addrs()?.filter(|a| is_public_ip(a.ip())).collect();
        if kept.is_empty() {
            return Err(std::io::Error::other("that name does not point to a public address"));
        }
        Ok(kept)
    }
}

/// A fresh random nonce for one Check.
pub(crate) fn fresh_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0_u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Does `<address>/bridge/health?nonce=<fresh>` come from THIS app? The answer must carry `proof`, which only this running
/// app can make from the nonce (`expected`); a server that merely says `{"ok":true}`, or repeats the nonce back, fails.
/// No token is sent. No redirect is followed, the wait is short, the answer is read up to a small cap, and only public
/// addresses are connected to.
pub fn check(raw: &str, expected: &dyn Fn(&str) -> String) -> Result<(ConnectionTest, Verdict), String> {
    check_with(raw, expected, &fresh_nonce())
}

/// What a Check found, for what the app does with an earlier pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The answer carried the right proof: this address reaches this PC.
    Pass,
    /// The address answered (HTTP 200) but without the right proof: it is another server now. An earlier pass is withdrawn.
    NotThisPc,
    /// No answer, a timeout, or a proxy error: nothing is known, so an earlier pass stays (no flapping on a bad minute).
    Unreached,
}

/// Pure: what an answer means. Only a 200 with a wrong or missing proof says "not this PC".
pub fn verdict_of(status: Option<u16>, transport_error: bool, body: &str, expected_proof: &str) -> Verdict {
    if transport_error {
        return Verdict::Unreached;
    }
    match status {
        Some(200) if proof_matches(body, expected_proof) => Verdict::Pass,
        Some(200) => Verdict::NotThisPc,
        _ => Verdict::Unreached,
    }
}

fn check_with(raw: &str, expected: &dyn Fn(&str) -> String, nonce: &str) -> Result<(ConnectionTest, Verdict), String> {
    let origin = normalize(raw)?;
    let url = format!("{origin}/bridge/health");
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(CHECK_TIMEOUT).resolver(PublicOnly).build();
    let started = Instant::now();
    let read = |resp: ureq::Response| {
        let mut body = String::new();
        let _ = resp.into_reader().take(BODY_CAP).read_to_string(&mut body);
        body
    };
    let outcome = match agent.get(&url).query("nonce", nonce).call() {
        Ok(resp) => {
            let status = resp.status();
            (Some(status), read(resp), None)
        }
        Err(ureq::Error::Status(code, resp)) => (Some(code), read(resp), None),
        Err(err) => (None, String::new(), Some(err.to_string())),
    };
    let latency = started.elapsed().as_millis() as u64;
    let mut result = interpret_health(&url, outcome.0, &outcome.1, latency, outcome.2.as_deref());
    let verdict = verdict_of(outcome.0, outcome.2.is_some(), &outcome.1, &expected(nonce));
    result.reason = Some(domain_reason(verdict, outcome.0, outcome.2.as_deref()));
    if verdict == Verdict::Pass {
        result.ok = true;
    } else {
        result.ok = false;
        result.message = if verdict == Verdict::NotThisPc {
            "The address answers, but it is not this PC. Point it at this PC.".into()
        } else {
            plain_failure(outcome.0, outcome.2.as_deref())
        };
    }
    Ok((result, verdict))
}

/// The body says `"proof": "<expected>"`.
pub fn proof_matches(body: &str, expected: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("proof").and_then(serde_json::Value::as_str).map(str::to_string))
        .is_some_and(|p| !expected.is_empty() && p == expected)
}

/// Why a Check ended as it did, as a short code the screen has words for:
/// reached | not_this_pc | dns | timeout | unreachable | redirect | bad_gateway | other_http.
pub fn domain_reason(verdict: Verdict, status: Option<u16>, transport: Option<&str>) -> &'static str {
    match (verdict, status, transport) {
        (Verdict::Pass, _, _) => "reached",
        (Verdict::NotThisPc, _, _) => "not_this_pc",
        (_, _, Some(err)) => {
            let err = err.to_ascii_lowercase();
            if err.contains("dns") || err.contains("lookup") || err.contains("resolve") || err.contains("no such host") || err.contains("public") {
                "dns"
            } else if err.contains("timed out") || err.contains("timeout") {
                "timeout"
            } else {
                "unreachable"
            }
        }
        (_, Some(300..=399), _) => "redirect",
        (_, Some(502 | 503 | 504 | 521 | 522 | 523 | 530), _) => "bad_gateway",
        (_, Some(_), _) => "other_http",
        (_, None, None) => "unreachable",
    }
}

fn plain_failure(status: Option<u16>, transport: Option<&str>) -> String {
    match (status, transport) {
        (_, Some(_)) => "Not reachable yet. Check that the name points at this PC and try again.".into(),
        (Some(300..=399), _) => "The address sends visitors somewhere else. Point it straight at this PC.".into(),
        (Some(502 | 503 | 504 | 521 | 522 | 523 | 530), _) => "The address is there, but it cannot reach this PC yet.".into(),
        (Some(200), _) => "The address answers, but it is not this app. Point it at this PC.".into(),
        (Some(_), _) => "The address answers, but not like this app. Point it at this PC.".into(),
        (None, None) => "Not reachable yet.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_says_why_in_one_short_code() {
        assert_eq!(domain_reason(Verdict::Pass, Some(200), None), "reached");
        assert_eq!(domain_reason(Verdict::NotThisPc, Some(200), None), "not_this_pc");
        assert_eq!(domain_reason(Verdict::Unreached, None, Some("Dns Failed: failed to lookup address")), "dns");
        assert_eq!(domain_reason(Verdict::Unreached, None, Some("Network Error: timed out reading response")), "timeout");
        assert_eq!(domain_reason(Verdict::Unreached, None, Some("Connection Failed: connection refused")), "unreachable");
        assert_eq!(domain_reason(Verdict::Unreached, Some(502), None), "bad_gateway");
        assert_eq!(domain_reason(Verdict::Unreached, Some(301), None), "redirect");
        assert_eq!(domain_reason(Verdict::Unreached, Some(404), None), "other_http");
        assert_eq!(domain_reason(Verdict::Unreached, None, None), "unreachable");
    }

    #[test]
    fn a_plain_name_or_a_full_https_address_becomes_one_https_origin() {
        assert_eq!(normalize("phone.example.com").as_deref(), Ok("https://phone.example.com"));
        assert_eq!(normalize("  HTTPS://Phone.Example.com/a/b?x=1#y ").as_deref(), Ok("https://phone.example.com"));
        assert_eq!(normalize("https://phone.example.com:443/").as_deref(), Ok("https://phone.example.com"));
        assert_eq!(normalize("phone.example.com:8443").as_deref(), Ok("https://phone.example.com:8443"));
        assert_eq!(normalize("https://phone.example.com.").as_deref(), Ok("https://phone.example.com"));
    }

    #[test]
    fn only_a_port_other_than_the_default_is_kept() {
        // https default 443 is dropped; every other valid port stays visible. 0 and above 65535 are refused.
        assert_eq!(normalize("phone.example.com:443").as_deref(), Ok("https://phone.example.com"));
        assert_eq!(normalize("https://phone.example.com:8443/x").as_deref(), Ok("https://phone.example.com:8443"));
        assert_eq!(normalize("phone.example.com:80").as_deref(), Ok("https://phone.example.com:80"));
        assert_eq!(normalize("phone.example.com:1").as_deref(), Ok("https://phone.example.com:1"));
        assert_eq!(normalize("phone.example.com:65535").as_deref(), Ok("https://phone.example.com:65535"));
        for bad in ["phone.example.com:0", "phone.example.com:65536", "phone.example.com:99999999999", "phone.example.com:", "phone.example.com:-1"] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn plain_http_is_refused() {
        assert!(normalize("http://phone.example.com").unwrap_err().contains("https"));
        assert!(normalize("http://localhost:8080/x").is_err());
    }

    #[test]
    fn number_addresses_and_our_own_cloudflare_hosts_and_private_names_are_refused() {
        for bad in ["192.168.1.5", "https://10.0.0.1", "127.0.0.1", "[::1]", "https://[2001:db8::1]/", "http://127.0.0.1:3000", "1.2.3"] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
        for bad in ["https://x-y.trycloudflare.com", "pm.me.workers.dev", "nas.local", "printer.lan", "intranet", "a.internal", "x.home.arpa"] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
        assert!(normalize("pm.me.workers.dev").unwrap_err().contains("Cloudflare"));
    }

    #[test]
    fn this_computer_is_never_my_domain_in_any_form() {
        for bad in ["localhost", "https://localhost", "https://localhost:8443/x", "http://localhost:80", "LOCALHOST", "app.localhost", "https://a.b.localhost:9", "localhost.", "127.0.0.1", "https://[::1]:3000", "0.0.0.0", "0x7f.1", "127.1", "2130706433"] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_last_label_that_is_a_number_is_refused() {
        for bad in ["0x7f.1", "example.123", "a.b.0x10", "foo.0xff", "host.1", "a.b.c.456"] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
        assert!(normalize("a1.example.com").is_ok());
        assert!(normalize("x.example.co").is_ok());
    }

    #[test]
    fn junk_is_refused() {
        for bad in ["", "   ", "ftp://phone.example.com", "https://", "a@phone.example.com", "https://a b.example.com", "*.example.com", "x.example.com:abc", "x.example.com:0", "x.example.com:70000", "-a.example.com", "a..example.com", "javascript:alert(1)"] {
            assert!(normalize(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_public_addresses_pass_the_check_filter() {
        for ip in ["10.1.2.3", "172.16.0.1", "192.168.0.9", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "2001:db8::1", "::127.0.0.1", "::8.8.8.8", "::ffff:0:127.0.0.1", "::ffff:0:8.8.8.8", "2002:7f00:1::1", "2002:0808:0808::1", "64:ff9b::7f00:1", "64:ff9b:1::1", "fec0::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1"] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "104.16.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn the_resolver_refuses_an_address_that_is_not_public() {
        use ureq::Resolver;
        assert!(PublicOnly.resolve("127.0.0.1:80").is_err());
        assert!(PublicOnly.resolve("192.168.1.1:443").is_err());
        assert!(PublicOnly.resolve("localhost:80").is_err());
    }

    #[test]
    fn a_failed_check_says_why_in_plain_words() {
        assert!(plain_failure(Some(301), None).contains("somewhere else"));
        assert!(plain_failure(Some(502), None).contains("cannot reach this PC"));
        assert!(plain_failure(None, Some("dns")).contains("Not reachable"));
        assert!(plain_failure(Some(200), None).contains("not this app"));
    }

    #[test]
    fn check_refuses_a_bad_address_before_any_network() {
        let proof = |n: &str| format!("p-{n}");
        assert!(check("192.168.1.2", &proof).is_err());
        assert!(check("http://example.com", &proof).is_err());
        assert!(check("localhost", &proof).is_err());
        assert!(check("https://localhost:8443", &proof).is_err());
    }

    #[test]
    fn only_the_right_proof_passes() {
        assert!(proof_matches(r#"{"ok":true,"proof":"abc"}"#, "abc"));
        // a generic server, or one that only repeats the nonce back, is not this PC
        assert!(!proof_matches(r#"{"ok":true}"#, "abc"));
        assert!(!proof_matches(r#"{"ok":true,"nonce":"abc"}"#, "abc"));
        assert!(!proof_matches(r#"{"ok":true,"proof":"abd"}"#, "abc"));
        assert!(!proof_matches(r#"{"ok":true,"proof":""}"#, ""));
        assert!(!proof_matches("not json", "abc"));
    }

    #[test]
    fn only_an_answer_that_is_not_this_pc_withdraws_a_pass() {
        let good = r#"{"ok":true,"proof":"abc"}"#;
        assert_eq!(verdict_of(Some(200), false, good, "abc"), Verdict::Pass);
        // reached, but another server: withdraw
        assert_eq!(verdict_of(Some(200), false, r#"{"ok":true}"#, "abc"), Verdict::NotThisPc);
        assert_eq!(verdict_of(Some(200), false, r#"{"ok":true,"proof":"zzz"}"#, "abc"), Verdict::NotThisPc);
        assert_eq!(verdict_of(Some(200), false, "<html>hello</html>", "abc"), Verdict::NotThisPc);
        // nothing known: keep (timeouts, connection errors, proxy errors, rate limits, redirects)
        assert_eq!(verdict_of(None, true, "", "abc"), Verdict::Unreached);
        for status in [301, 429, 500, 502, 503, 504, 521, 530] {
            assert_eq!(verdict_of(Some(status), false, "", "abc"), Verdict::Unreached, "{status}");
        }
    }

    #[test]
    fn nonces_are_fresh_and_hex() {
        let (a, b) = (fresh_nonce(), fresh_nonce());
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }

    /// A tiny local server stands in for the address: one that answers like this app with the right proof, one that is generic.
    /// The address is `localhost`-refused by `normalize`, so this exercises the proof rule through `proof_matches` plus the body read.
    #[test]
    fn the_nonce_is_sent_as_a_query_and_the_answer_decides() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0_u8; 2048];
            let n = sock.read(&mut buf).unwrap();
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
            head
        });
        // a plain ureq GET with the same query shape the check uses
        let resp = ureq::get(&format!("http://127.0.0.1:{port}/bridge/health")).query("nonce", "abc123").call().unwrap();
        let body = resp.into_string().unwrap();
        let head = handle.join().unwrap();
        assert!(head.starts_with("GET /bridge/health?nonce=abc123 "), "{head}");
        assert!(!proof_matches(&body, "whatever"));
    }
}
