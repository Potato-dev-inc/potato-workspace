//! Invite links on the Potato Worker (`relay/worker`): `https://<worker>/join/<one-time-code>`.
//!
//! What comes from outside is a link a person pasted or an OS handed over (`potato-workspace://join/<code>?w=<host>`).
//! It is untrusted: from it we take **only a code and a host name**, checked strictly here. Everything else
//! (team name, who invited, the invite itself) is fetched from that Worker, and the team's own checks
//! (`InviteLink::parse`, the roster, the owner's approval) still apply to it. Nothing here joins by itself.

use std::io::Read;
use std::time::Duration;

/// Same alphabet as the Worker (`relay/worker/src/invites.ts`): no 0/O, 1/I/L, U.
const CODE_ALPHABET: &str = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const CODE_LEN: usize = 16;
const MAX_BODY: u64 = 16 * 1024;

/// Where an invite lives: a code, and the Worker's host name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinTarget {
    pub code: String,
    pub host: String,
}

impl JoinTarget {
    pub fn base_url(&self) -> String {
        format!("https://{}", self.host)
    }
}

fn valid_code(code: &str) -> bool {
    code.len() == CODE_LEN && code.chars().all(|c| CODE_ALPHABET.contains(c))
}

/// A public DNS name only: letters, digits, hyphens and dots, at least one dot, not an IP address, no port,
/// no user name. A link cannot point the app at this computer or at a private address by name tricks.
fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") || lower.ends_with(".internal") {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        // an all-number last label is an IP-like name (`1.2.3.4` is caught above, `1.2.3.04` here)
        && !labels.last().is_some_and(|l| l.chars().all(|c| c.is_ascii_digit()))
}

/// Read a pasted invite link or an OS deep link. Either:
/// `https://<host>/join/<code>` or `potato-workspace://join/<code>?w=<host>`.
pub fn parse_target(text: &str) -> Result<JoinTarget, String> {
    let bad = || "That isn't an invite link from a Potato Worker.".to_string();
    let text = text.trim();
    if text.is_empty() || text.len() > 512 || text.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad());
    }
    let (code, host) = if let Some(rest) = text.strip_prefix("potato-workspace://join/") {
        let (code, query) = rest.split_once('?').ok_or_else(bad)?;
        let mut host = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("w", value)) if host.is_none() => host = Some(value.to_string()),
                _ => return Err(bad()), // anything else in the link is refused, not ignored
            }
        }
        (code.trim_end_matches('/').to_string(), host.ok_or_else(bad)?)
    } else if let Some(rest) = text.strip_prefix("https://") {
        let (host, path) = rest.split_once('/').ok_or_else(bad)?;
        let code = path.strip_prefix("join/").ok_or_else(bad)?;
        (code.trim_end_matches('/').to_string(), host.to_string())
    } else {
        return Err(bad());
    };
    let code = code.to_ascii_uppercase();
    if !valid_code(&code) || !valid_host(&host) {
        return Err(bad());
    }
    Ok(JoinTarget { code, host: host.to_ascii_lowercase() })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(10)).build()
}

fn read_json(response: ureq::Response) -> Result<serde_json::Value, String> {
    let mut bytes = Vec::new();
    response.into_reader().take(MAX_BODY).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "The Worker sent an unreadable answer.".to_string())
}

/// What a refusal means, in plain words.
fn refusal(status: u16, body: Option<serde_json::Value>) -> String {
    let state = body.as_ref().and_then(|b| b.get("state")).and_then(|s| s.as_str()).unwrap_or("");
    match (status, state) {
        (410, "used") => "This invite was already used. Ask for a new one.".into(),
        (410, _) => "This invite ran out. Ask for a new one.".into(),
        (404, _) => "This invite link isn't valid. Ask for a new one.".into(),
        (429, _) => "Too many tries. Wait a little and try again.".into(),
        _ => format!("The Worker said no ({status})."),
    }
}

fn call(method: &str, base: &str, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{base}{path}");
    let request = agent().request(method, &url);
    let result = if method == "POST" { request.send_bytes(b"") } else { request.call() };
    match result {
        Ok(response) => read_json(response),
        Err(ureq::Error::Status(status, response)) => Err(refusal(status, read_json(response).ok())),
        Err(_) => Err("Can't reach that Worker. Check your internet and the link.".into()),
    }
}

/// What the popup shows before the person says yes. Does not use the invite up.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub host: String,
    pub team_name: String,
    pub inviter: String,
    pub expires_at_ms: u64,
}

/// Look at an invite without using it up. `base` is `https://<host>` (tests pass a loopback address).
pub fn peek(base: &str, target: &JoinTarget) -> Result<Lookup, String> {
    let body = call("GET", base, &format!("/v1/invites/{}", target.code))?;
    if body.get("state").and_then(|s| s.as_str()) != Some("open") {
        return Err(refusal(410, Some(body)));
    }
    let text = |key: &str| super::event::clean_text(body.get(key).and_then(|v| v.as_str()).unwrap_or(""), 60);
    Ok(Lookup {
        host: target.host.clone(),
        team_name: text("team_name"),
        inviter: text("inviter"),
        expires_at_ms: body.get("expires_at_ms").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// The invite itself: the team's invite link and its code. Using it burns it on the Worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claimed {
    pub link: String,
    pub code: String,
}

pub fn claim(base: &str, target: &JoinTarget) -> Result<Claimed, String> {
    let body = call("POST", base, &format!("/v1/invites/{}/claim", target.code))?;
    if body.get("state").and_then(|s| s.as_str()) != Some("claimed") {
        return Err(refusal(410, Some(body)));
    }
    let payload = body.get("payload").and_then(|p| p.as_str()).ok_or("The Worker sent an unreadable invite.")?;
    let inner: serde_json::Value = serde_json::from_str(payload).map_err(|_| "The invite is damaged.".to_string())?;
    let get = |key: &str| inner.get(key).and_then(|v| v.as_str()).map(str::to_string).filter(|v| !v.is_empty());
    Ok(Claimed { link: get("link").ok_or("The invite is damaged.")?, code: get("code").ok_or("The invite is damaged.")? })
}

/// What a Worker address can do, for Settings: "Use this address" and "Update your Worker".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHealth {
    pub reachable: bool,
    pub features: Vec<String>,
    /// An older stable-link-only Worker (no feature list, but it answers the link route).
    pub legacy_link: bool,
}

/// Ask a Worker what it can do. Nothing secret is sent: plain GETs, tried in order.
pub fn worker_health(base: &str) -> WorkerHealth {
    let features_of = |path: &str| {
        call("GET", base, path).ok().and_then(|body| {
            body.get("features").and_then(|f| f.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>())
        })
    };
    if let Some(features) = features_of("/_pm/health") {
        return WorkerHealth { reachable: true, features, legacy_link: false };
    }
    // An older deploy: the team relay answers /v1/health without features, the old stable link only /_pm/link/health.
    let relay = call("GET", base, "/v1/health").ok().is_some_and(|b| b.get("ok").and_then(|v| v.as_bool()) == Some(true));
    let legacy = call("GET", base, "/_pm/link/health").ok().is_some_and(|b| b.get("linked").is_some());
    let mut features = Vec::new();
    if relay {
        features.push("team".to_string());
    }
    if legacy {
        features.push("stable-link".to_string());
    }
    WorkerHealth { reachable: relay || legacy, features, legacy_link: legacy && !relay }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    const CODE: &str = "ABCDEFGH23456789";

    #[test]
    fn reads_both_link_shapes() {
        let want = JoinTarget { code: CODE.into(), host: "pm-relay.me.workers.dev".into() };
        assert_eq!(parse_target(&format!("https://pm-relay.me.workers.dev/join/{CODE}")), Ok(want.clone()));
        assert_eq!(parse_target(&format!("  https://PM-relay.me.workers.dev/join/{}/ ", CODE.to_lowercase())), Ok(want.clone()));
        assert_eq!(parse_target(&format!("potato-workspace://join/{CODE}?w=pm-relay.me.workers.dev")), Ok(want));
    }

    #[test]
    fn junk_is_refused() {
        let junk = [
            "",
            "hello",
            "pm://team/join?v=1&t=x",
            "potato-workspace://join/",
            "potato-workspace://join/ABCDEFGH23456789",
            "potato-workspace://join/ABCDEFGH23456789?w=",
            "potato-workspace://join/ABCDEFGH23456789?w=a.dev&x=1",
            "potato-workspace://join/ABCDEFGH23456789?w=a.dev&w=b.dev",
            "potato-workspace://join/ABCDEFGH23456789?w=localhost",
            "potato-workspace://join/ABCDEFGH23456789?w=127.0.0.1",
            "potato-workspace://join/ABCDEFGH23456789?w=a.dev:8080",
            "potato-workspace://join/ABCDEFGH23456789?w=user@a.dev",
            "potato-workspace://join/ABCDEFGH23456789?w=a.dev/evil",
            "potato-workspace://join/ABCDEFGH23456789?w=-a.dev",
            "potato-workspace://join/ABCDEFGH2345678?w=a.dev",
            "potato-workspace://join/ABCDEFGH2345678O?w=a.dev",
            "potato-workspace://join/../../etc?w=a.dev",
            "potato-workspace://join/ABCDEFGH23456789?w=1.2.3.04",
            "http://a.dev/join/ABCDEFGH23456789",
            "https://a.dev/other/ABCDEFGH23456789",
            "https://a.dev/join/ABCDEFGH23456789/extra",
            "https://user@a.dev/join/ABCDEFGH23456789",
            "https://[::1]/join/ABCDEFGH23456789",
            "https://a.dev/join/ABCDEFGH23456789 && rm",
            "javascript:alert(1)",
        ];
        for text in junk {
            assert!(parse_target(text).is_err(), "should refuse {text:?}");
        }
        assert!(parse_target(&format!("https://a.dev/join/{}", "A".repeat(600))).is_err());
    }

    /// A one-shot fake Worker on loopback: answers each connection with the next canned (status, body).
    fn fake(answers: Vec<(u16, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string());
                let reason = if status == 200 { "OK" } else { "Gone" };
                let reply = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
            seen
        });
        (base, handle)
    }

    fn target() -> JoinTarget {
        JoinTarget { code: CODE.into(), host: "a.dev".into() }
    }

    #[test]
    fn peek_shows_names_and_uses_a_get() {
        let (base, seen) = fake(vec![(200, r#"{"state":"open","team_name":"Design crew","inviter":"Ren","expires_at_ms":1700000000000}"#)]);
        let look = peek(&base, &target()).unwrap();
        assert_eq!((look.team_name.as_str(), look.inviter.as_str(), look.expires_at_ms), ("Design crew", "Ren", 1_700_000_000_000));
        assert_eq!(seen.join().unwrap(), vec![format!("GET /v1/invites/{CODE} HTTP/1.1")]);
    }

    #[test]
    fn claim_is_a_post_and_a_used_invite_is_said_plainly() {
        let (base, seen) = fake(vec![
            (200, r#"{"state":"claimed","payload":"{\"link\":\"pm://team/join?v=1\",\"code\":\"ABCD-EFGH\"}"}"#),
            (410, r#"{"state":"used"}"#),
            (410, r#"{"state":"expired"}"#),
            (404, r#"{"error":"invite not found"}"#),
        ]);
        let got = claim(&base, &target()).unwrap();
        assert_eq!((got.link.as_str(), got.code.as_str()), ("pm://team/join?v=1", "ABCD-EFGH"));
        assert!(claim(&base, &target()).unwrap_err().contains("already used"));
        assert!(claim(&base, &target()).unwrap_err().contains("ran out"));
        assert!(claim(&base, &target()).unwrap_err().contains("isn't valid"));
        assert!(seen.join().unwrap().iter().all(|l| l.starts_with("POST ")));
    }

    #[test]
    fn a_damaged_payload_is_refused() {
        let (base, _) = fake(vec![(200, r#"{"state":"claimed","payload":"not json"}"#), (200, r#"{"state":"claimed","payload":"{}"}"#)]);
        assert!(claim(&base, &target()).is_err());
        assert!(claim(&base, &target()).is_err());
    }

    #[test]
    fn worker_health_reads_features_and_knows_older_deploys() {
        let (base, _) = fake(vec![(200, r#"{"ok":true,"features":["team","stable-link","invites"]}"#)]);
        let h = worker_health(&base);
        assert!(h.reachable && !h.legacy_link);
        assert_eq!(h.features, vec!["team", "stable-link", "invites"]);
        // older team relay: no /_pm/health, /v1/health has no features, no link route
        let (base, _) = fake(vec![(404, "{}"), (200, r#"{"ok":true}"#), (404, "{}")]);
        let h = worker_health(&base);
        assert!(h.reachable && !h.legacy_link);
        assert_eq!(h.features, vec!["team"]);
        // older stable-link-only Worker
        let (base, _) = fake(vec![(404, "{}"), (404, "{}"), (200, r#"{"linked":false,"updated_at":null}"#)]);
        let h = worker_health(&base);
        assert!(h.reachable && h.legacy_link);
        assert_eq!(h.features, vec!["stable-link"]);
    }
}
