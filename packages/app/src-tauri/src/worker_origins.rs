//! The permanent phone origins this PC trusts for cross-origin calls: the person's own Worker (workers.dev OR a domain of
//! their own, whatever they saved), and any earlier address they used before, so a domain change never drops a pairing
//! made on the other origin. The phone page loads from the Worker, asks it where this PC's tunnel is, then calls the
//! tunnel directly; the tunnel answers CORS only for these origins (see `bridge::http::cors_lines_for`).
//!
//! Nothing here is a secret. Origins only ever grow (up to `MAX_KEPT`) until "Forget this Worker" clears them. An origin is
//! never read from a request: only from what the person saved.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::tunnel_config::{self, TunnelConfig};

const MAX_KEPT: usize = 8;
const CACHE_FOR: Duration = Duration::from_secs(5);

/// `https://host[:port]`, lowercase, from an address the person typed (`https://pm.me.workers.dev/`, `https://relay.example.com/bridge`).
/// Only https: a phone token never travels over plain http. `None` for anything else.
pub fn origin_of(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url.get(..8).filter(|p| p.eq_ignore_ascii_case("https://")).map(|_| &url[8..])?;
    let authority = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if authority.is_empty() || authority.contains('@') || authority.contains(' ') || authority.contains('*') {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => (h, Some(p)),
        Some(_) => return None,
        None => (authority.as_str(), None),
    };
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') || !host.contains('.') {
        return None;
    }
    Some(match port {
        Some("443") | None => format!("https://{host}"),
        Some(p) => format!("https://{host}:{p}"),
    })
}

pub fn origins_file(tunnel_file: &Path) -> PathBuf {
    tunnel_file.with_file_name("potato-workspace.worker-origins.json")
}

fn read_list(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()).unwrap_or_default()
}

/// Keep `worker_url`'s origin (a new address is added; the earlier ones stay). Best effort.
pub fn remember(file: &Path, worker_url: &str) {
    let Some(origin) = origin_of(worker_url) else { return };
    let mut list = read_list(file);
    if list.contains(&origin) {
        return;
    }
    list.push(origin);
    let keep_from = list.len().saturating_sub(MAX_KEPT);
    if let Ok(text) = serde_json::to_string(&list[keep_from..]) {
        let _ = crate::secure_file::write_private(file, &text);
    }
    invalidate();
}

/// "Forget this Worker": no origin stays trusted.
pub fn forget(file: &Path) {
    let _ = std::fs::remove_file(file);
    invalidate();
}

/// Every permanent origin to trust now: the saved Worker, the remembered one and the kept list. No duplicates.
pub fn allowed_from(tunnel_file: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |o: Option<String>| {
        if let Some(o) = o {
            if !out.contains(&o) {
                out.push(o);
            }
        }
    };
    if let TunnelConfig::Stable { worker_url, .. } = tunnel_config::load(tunnel_file) {
        push(origin_of(&worker_url));
    }
    if let TunnelConfig::Stable { worker_url, .. } = tunnel_config::load(&tunnel_config::memory_file(tunnel_file)) {
        push(origin_of(&worker_url));
    }
    for kept in read_list(&origins_file(tunnel_file)) {
        push(origin_of(&kept));
    }
    out
}

static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

/// `allowed_from` for this app's own setting, kept for a few seconds so a busy bridge does not read files per request.
pub fn allowed() -> Vec<String> {
    let mut cache = CACHE.lock();
    if let Some((at, list)) = cache.as_ref() {
        if at.elapsed() < CACHE_FOR {
            return list.clone();
        }
    }
    let list = allowed_from(&tunnel_config::tunnel_file());
    *cache = Some((Instant::now(), list.clone()));
    list
}

pub fn invalidate() {
    *CACHE.lock() = None;
}

// ------------------------------------------------------------------------------------------ permanent or temporary

static TEMPORARY: AtomicBool = AtomicBool::new(false);
static LOADED: AtomicBool = AtomicBool::new(false);

fn mode_file() -> PathBuf {
    tunnel_config::tunnel_file().with_file_name("potato-workspace.link-mode.json")
}

fn load_mode(file: &Path) -> bool {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("temporary").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

/// True while the person chose "Temporary link": phones are given the plain quick address and the Worker is not used.
/// The Worker setting stays saved and linked, so going back is one tap and needs no restart.
pub fn link_temporary() -> bool {
    if !LOADED.swap(true, Ordering::SeqCst) {
        TEMPORARY.store(load_mode(&mode_file()), Ordering::SeqCst);
    }
    TEMPORARY.load(Ordering::SeqCst)
}

pub fn set_link_temporary(on: bool) -> Result<(), String> {
    let text = serde_json::json!({ "temporary": on }).to_string();
    crate::secure_file::write_private(&mode_file(), &text)?;
    LOADED.store(true, Ordering::SeqCst);
    TEMPORARY.store(on, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-worker-origins-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_origin_comes_from_any_https_address_the_person_saved() {
        assert_eq!(origin_of("https://pm.me.workers.dev/").as_deref(), Some("https://pm.me.workers.dev"));
        assert_eq!(origin_of("HTTPS://Relay.Example.com/bridge?x=1").as_deref(), Some("https://relay.example.com"));
        assert_eq!(origin_of("https://relay.example.com:443").as_deref(), Some("https://relay.example.com"));
        assert_eq!(origin_of("https://relay.example.com:8443/x").as_deref(), Some("https://relay.example.com:8443"));
        for bad in ["http://relay.example.com", "https://", "https://*.example.com", "https://a@b.example.com", "https://localhost", "javascript:alert(1)", "https://x.example.com:abc", ""] {
            assert_eq!(origin_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_domain_change_keeps_the_old_origin_trusted_and_forget_clears_all() {
        let d = dir("keep");
        let tunnel = d.join("potato-workspace.tunnel.json");
        let file = origins_file(&tunnel);
        let first = TunnelConfig::Stable { worker_url: "https://pm.me.workers.dev".into(), secret: "s".repeat(32) };
        tunnel_config::save(&tunnel, &first).unwrap();
        remember(&file, "https://pm.me.workers.dev");
        assert_eq!(allowed_from(&tunnel), vec!["https://pm.me.workers.dev".to_string()]);
        // the person moves the Worker to their own domain
        let second = TunnelConfig::Stable { worker_url: "https://phone.example.com".into(), secret: "s".repeat(32) };
        tunnel_config::save(&tunnel, &second).unwrap();
        remember(&file, "https://phone.example.com");
        let all = allowed_from(&tunnel);
        assert!(all.contains(&"https://pm.me.workers.dev".to_string()) && all.contains(&"https://phone.example.com".to_string()), "{all:?}");
        remember(&file, "https://phone.example.com");
        assert_eq!(read_list(&file).len(), 2, "no duplicates");
        // a different mode does not drop what was kept
        tunnel_config::save(&tunnel, &TunnelConfig::Quick).unwrap();
        assert_eq!(allowed_from(&tunnel).len(), 2);
        forget(&file);
        assert!(allowed_from(&tunnel).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_list_is_capped_and_junk_is_never_kept() {
        let d = dir("cap");
        let file = origins_file(&d.join("t.json"));
        for i in 0..12 {
            remember(&file, &format!("https://w{i}.example.com"));
        }
        remember(&file, "http://plain.example.com");
        let list = read_list(&file);
        assert_eq!(list.len(), MAX_KEPT);
        assert_eq!(list.last().map(String::as_str), Some("https://w11.example.com"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_link_mode_file_round_trips_and_defaults_to_permanent() {
        let d = dir("mode");
        let file = d.join("mode.json");
        assert!(!load_mode(&file));
        std::fs::write(&file, r#"{"temporary":true}"#).unwrap();
        assert!(load_mode(&file));
        std::fs::write(&file, "not json").unwrap();
        assert!(!load_mode(&file));
        let _ = std::fs::remove_dir_all(&d);
    }
}
