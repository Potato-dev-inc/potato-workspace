//! The permanent phone origins this PC trusts for cross-origin calls: the person's own Worker (workers.dev OR a domain of
//! their own, whatever they saved), and any earlier address they used before, so a domain change never drops a pairing
//! made on the other origin. The phone page loads from the Worker, asks it where this PC's tunnel is, then calls the
//! tunnel directly; the tunnel answers CORS only for these origins (see `bridge::http::cors_lines_for`).
//!
//! Nothing here is a secret. Origins only ever grow (up to `MAX_KEPT`) until "Forget this Worker" clears them. An origin is
//! never read from a request: only from what the person saved.

use std::path::{Path, PathBuf};
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
    // "My domain" with the Address book: the phone page loads from that name (a small Worker) and calls the tunnel from there.
    // Only while the choice is on AND the name has passed an Address book Check. A Direct name is never trusted here: its
    // page comes from this PC itself, so its calls are same-origin.
    push(book_domain_from(&mode_file_beside(tunnel_file)));
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

// ------------------------------------------------------------------------------------------ permanent, temporary or my domain

/// How phones reach this PC. Only this choice changes between the three; the saved Worker and the typed domain both stay
/// saved whichever is on, so every switch is instant and reversible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkChoice {
    Permanent,
    Temporary,
    Domain,
}

impl LinkChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permanent => "permanent",
            Self::Temporary => "temporary",
            Self::Domain => "domain",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "permanent" => Some(Self::Permanent),
            "temporary" => Some(Self::Temporary),
            "domain" => Some(Self::Domain),
            _ => None,
        }
    }
}

/// What the address does once a phone has it. `Book`: the address only says where this PC is, and the phone then talks to
/// the tunnel directly. `Direct`: the address carries all the traffic itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRoute {
    Book,
    Direct,
}

impl LinkRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Book => "book",
            Self::Direct => "direct",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "book" => Some(Self::Book),
            "direct" => Some(Self::Direct),
            _ => None,
        }
    }
}

impl LinkChoice {
    /// The route used when the file says nothing: today's behaviour for each link (nothing changes for existing users).
    pub fn default_route(self) -> LinkRoute {
        match self {
            Self::Domain => LinkRoute::Direct,
            Self::Permanent | Self::Temporary => LinkRoute::Book,
        }
    }
    /// Whether this app can run `route` with this link. Only the combinations that are built are listed here; the
    /// others are "Coming" in the UI and must never be saved.
    pub fn supports(self, route: LinkRoute) -> bool {
        match self {
            Self::Permanent | Self::Temporary => route == LinkRoute::Book,
            // Direct (the name reaches this PC itself) and Address book (the name is a small Worker that holds this PC's address).
            Self::Domain => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkMode {
    pub choice: LinkChoice,
    /// The person's own https origin (already normalized by `own_domain::normalize`), kept while another choice is on.
    pub domain: Option<String>,
    /// The domain that last passed a Check made by this app (bound to this PC by a proof). "My domain" is advertised
    /// only while `domain == verified`; typing another one makes it unproven again until it passes a Check.
    pub verified: Option<String>,
    /// The route that Check was made with. A pass counts only for the route it was made with: a Direct pass never lets an
    /// Address book name be given to phones, and the other way round.
    pub verified_route: LinkRoute,
    /// How the chosen link carries traffic. Always a combination `LinkChoice::supports` accepts.
    pub route: LinkRoute,
    /// The route last used with each name (newest last, at most `MAX_ROUTES`), so choosing "My domain" again for a name that
    /// was an Address book brings the Address book back instead of the default.
    pub last_routes: Vec<(String, LinkRoute)>,
}

const MAX_ROUTES: usize = 8;

/// `list` with `route` remembered for `domain` (replacing an older entry for the same name).
fn remember_route(mut list: Vec<(String, LinkRoute)>, domain: &str, route: LinkRoute) -> Vec<(String, LinkRoute)> {
    list.retain(|(d, _)| d != domain);
    list.push((domain.to_string(), route));
    let keep = list.len().saturating_sub(MAX_ROUTES);
    list.drain(..keep);
    list
}

impl LinkMode {
    /// The domain proven to reach this PC, or none.
    pub fn proven_domain(&self) -> Option<&str> {
        match (&self.domain, &self.verified) {
            (Some(d), Some(v)) if d == v && self.verified_route == self.route => Some(d.as_str()),
            _ => None,
        }
    }
}

impl Default for LinkMode {
    fn default() -> Self {
        Self { choice: LinkChoice::Permanent, domain: None, verified: None, verified_route: LinkRoute::Direct, route: LinkRoute::Book, last_routes: Vec::new() }
    }
}

/// Reads the optional `route` argument of a save. Unknown text is an error; a missing one means "keep the right one".
pub fn parse_route_arg(raw: Option<&str>) -> Result<Option<LinkRoute>, String> {
    match raw {
        None => Ok(None),
        Some(text) => LinkRoute::parse(text).map(Some).ok_or_else(|| "Unknown link style.".to_string()),
    }
}

static MODE: Mutex<Option<LinkMode>> = Mutex::new(None);

fn mode_file_beside(tunnel_file: &Path) -> PathBuf {
    tunnel_file.with_file_name("potato-workspace.link-mode.json")
}

fn mode_file() -> PathBuf {
    mode_file_beside(&tunnel_config::tunnel_file())
}

/// The proven Address book name saved in `file`, or none (another link, another route, or no pass).
fn book_domain_from(file: &Path) -> Option<String> {
    let mode = load_mode(file);
    (mode.choice == LinkChoice::Domain && mode.route == LinkRoute::Book).then(|| mode.proven_domain().map(str::to_string)).flatten()
}

/// Reads the file. The older `{"temporary":true}` shape still means "Temporary link". A saved domain is only trusted
/// when it passes the same check a typed one does; a choice of "domain" without one falls back to permanent.
fn load_mode(file: &Path) -> LinkMode {
    let Some(v) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
        return LinkMode::default();
    };
    let domain = v.get("domain").and_then(serde_json::Value::as_str).and_then(|d| crate::own_domain::normalize(d).ok());
    let choice = match v.get("choice").and_then(serde_json::Value::as_str).and_then(LinkChoice::parse) {
        Some(c) => c,
        None if v.get("temporary").and_then(serde_json::Value::as_bool) == Some(true) => LinkChoice::Temporary,
        None => LinkChoice::Permanent,
    };
    let verified = v.get("verified_domain").and_then(serde_json::Value::as_str).and_then(|d| crate::own_domain::normalize(d).ok());
    let choice = if choice == LinkChoice::Domain && domain.is_none() { LinkChoice::Permanent } else { choice };
    // A file with no `route` (every file written before routes existed) gets the link's own default. A route this app
    // does not build for the link is never trusted either.
    let route = v
        .get("route")
        .and_then(serde_json::Value::as_str)
        .and_then(LinkRoute::parse)
        .filter(|r| choice.supports(*r))
        .unwrap_or(choice.default_route());
    // A pass written before routes existed was a Direct one.
    let verified_route = v.get("verified_route").and_then(serde_json::Value::as_str).and_then(LinkRoute::parse).unwrap_or(LinkRoute::Direct);
    let last_routes = v
        .get("routes")
        .and_then(serde_json::Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(d, r)| Some((crate::own_domain::normalize(d).ok()?, LinkRoute::parse(r.as_str()?)?)))
                .take(MAX_ROUTES)
                .collect()
        })
        .unwrap_or_default();
    LinkMode { choice, domain, verified, verified_route, route, last_routes }
}

/// The text written to the link-mode file. Pure, so the file shape is a unit test.
fn mode_text(mode: &LinkMode) -> String {
    serde_json::json!({
        "choice": mode.choice.as_str(),
        "temporary": mode.choice == LinkChoice::Temporary,
        "domain": mode.domain,
        "verified_domain": mode.verified,
        "verified_route": mode.verified_route.as_str(),
        "route": mode.route.as_str(),
        "routes": mode.last_routes.iter().map(|(d, r)| (d.clone(), serde_json::Value::from(r.as_str()))).collect::<serde_json::Map<_, _>>(),
    })
    .to_string()
}

fn write_mode(mode: &LinkMode) -> Result<(), String> {
    crate::secure_file::write_private(&mode_file(), &mode_text(mode))
}

pub fn link_mode() -> LinkMode {
    let mut slot = MODE.lock();
    slot.get_or_insert_with(|| load_mode(&mode_file())).clone()
}

/// True while the person chose "Temporary link": phones are given the plain quick address and the Worker is not used.
/// The Worker setting stays saved and linked, so going back is one tap and needs no restart.
pub fn link_temporary() -> bool {
    link_mode().choice == LinkChoice::Temporary
}

/// The name of the Address book Worker while "My domain" + Address book is on, proven or not (what this PC registers with).
pub fn book_domain() -> Option<String> {
    let mode = link_mode();
    if mode.choice == LinkChoice::Domain && mode.route == LinkRoute::Book {
        mode.domain
    } else {
        None
    }
}

/// The domain phones are told to use: only while "My domain" is the choice AND that exact domain has passed a Check.
pub fn own_domain_active() -> Option<String> {
    let mode = link_mode();
    if mode.choice == LinkChoice::Domain {
        mode.proven_domain().map(str::to_string)
    } else {
        None
    }
}

/// What `set_link_mode` does to the saved mode. Pure, so the "never loses the other setting" rule is a unit test.
/// A route asked for that this app does not build with the choice is refused. No route asked: keep the current one when
/// the new choice supports it, otherwise use the new choice's default.
pub fn next_mode(current: &LinkMode, choice: LinkChoice, domain: Option<String>, route: Option<LinkRoute>) -> Result<LinkMode, String> {
    let domain = match domain {
        Some(raw) => Some(crate::own_domain::normalize(&raw)?),
        None => current.domain.clone(),
    };
    if choice == LinkChoice::Domain && domain.is_none() {
        return Err("Type your web address first.".into());
    }
    let route = match route {
        Some(asked) if !choice.supports(asked) => return Err("That link style is coming soon.".into()),
        Some(asked) => asked,
        // Keep the saved route only while the same link stays on: a route chosen for one link never rides along into another
        // (Permanent's Address book must not turn "My domain" into an Address book unasked: Direct stays its default).
        None if choice == current.choice && choice.supports(current.route) => current.route,
        // Back on "My domain" for a name that was an Address book: the Address book comes back.
        None => (choice == LinkChoice::Domain)
            .then(|| domain.as_deref().and_then(|d| current.last_routes.iter().find(|(n, _)| n == d)).map(|(_, r)| *r))
            .flatten()
            .filter(|r| choice.supports(*r))
            .unwrap_or(choice.default_route()),
    };
    // What each name last used: the link being left, then the one chosen now.
    let mut last_routes = current.last_routes.clone();
    if let (LinkChoice::Domain, Some(d)) = (current.choice, current.domain.as_deref()) {
        last_routes = remember_route(last_routes, d, current.route);
    }
    if let (LinkChoice::Domain, Some(d)) = (choice, domain.as_deref()) {
        last_routes = remember_route(last_routes, d, route);
    }
    // Only a Check (`mark_verified`) proves a domain; saving, switching and editing never do.
    Ok(LinkMode { choice, domain, verified: current.verified.clone(), verified_route: current.verified_route, route, last_routes })
}

/// Choose how phones reach this PC. A domain typed now is saved even when the choice is not "My domain".
pub fn set_link_mode(choice: LinkChoice, domain: Option<String>, route: Option<LinkRoute>) -> Result<LinkMode, String> {
    let mut slot = MODE.lock();
    let current = slot.get_or_insert_with(|| load_mode(&mode_file())).clone();
    let next = next_mode(&current, choice, domain, route)?;
    write_mode(&next)?;
    *slot = Some(next.clone());
    drop(slot);
    // The trusted phone origins depend on the mode (an Address book name is one of them): read them again at once.
    invalidate();
    Ok(next)
}

/// Pure: may a pass for `origin`, earned with `route`, still be written into `current`? The Check takes seconds; the person can
/// change the link style or the name meanwhile, and a pass must never land on a setting it was not earned for.
pub fn pass_applies(current: &LinkMode, origin: &str, route: LinkRoute) -> Result<(), String> {
    if current.route != route {
        return Err("The link style changed while checking. Check again.".into());
    }
    // A Direct Check may be of a name typed in the sheet before it is saved. An Address book pass is only ever for the saved name,
    // with the choice on (that is the only thing it is given to phones for).
    if route == LinkRoute::Book && (current.choice != LinkChoice::Domain || current.domain.as_deref() != Some(origin)) {
        return Err("The address changed while checking. Check again.".into());
    }
    Ok(())
}

/// Record that `origin` passed a Check made by this app with `route` (the route and name the Check STARTED with: a pass is
/// refused when either has changed since). Called only by the Check command, never from the UI's say-so.
pub fn mark_verified(origin: &str, route: LinkRoute) -> Result<(), String> {
    let origin = crate::own_domain::normalize(origin)?;
    let mut slot = MODE.lock();
    let current = slot.get_or_insert_with(|| load_mode(&mode_file())).clone();
    pass_applies(&current, &origin, route)?;
    if current.verified.as_deref() == Some(origin.as_str()) && current.verified_route == current.route {
        return Ok(());
    }
    let next = LinkMode { verified: Some(origin), verified_route: current.route, ..current };
    write_mode(&next)?;
    *slot = Some(next);
    drop(slot);
    invalidate();
    Ok(())
}

/// `mode` without the pass for `origin` (unchanged when the pass is for another address or there is none).
pub fn without_pass_for(mode: &LinkMode, origin: &str) -> LinkMode {
    if mode.verified.as_deref() == Some(origin) {
        LinkMode { verified: None, ..mode.clone() }
    } else {
        mode.clone()
    }
}

/// `mode` without the pass for `origin`, only when that pass was earned with `route` (a Direct pass is not an Address book's to withdraw).
pub fn without_route_pass_for(mode: &LinkMode, origin: &str, route: LinkRoute) -> LinkMode {
    if mode.verified_route == route {
        without_pass_for(mode, origin)
    } else {
        mode.clone()
    }
}

/// Like `unmark_verified`, but only when the pass for `origin` was earned with `route`. The Address book loop uses it after a probe
/// that took seconds: a fresh Direct pass for the same name (Use Direct) must survive.
pub fn unmark_verified_for_route(origin: &str, route: LinkRoute) -> Result<(), String> {
    let origin = crate::own_domain::normalize(origin)?;
    let mut slot = MODE.lock();
    let current = slot.get_or_insert_with(|| load_mode(&mode_file())).clone();
    let next = without_route_pass_for(&current, &origin, route);
    if next == current {
        return Ok(());
    }
    write_mode(&next)?;
    *slot = Some(next);
    drop(slot);
    invalidate();
    Ok(())
}

/// The address answered, but not as this PC: withdraw its pass at once, so phones are no longer given it.
pub fn unmark_verified(origin: &str) -> Result<(), String> {
    let origin = crate::own_domain::normalize(origin)?;
    let mut slot = MODE.lock();
    let current = slot.get_or_insert_with(|| load_mode(&mode_file())).clone();
    let next = without_pass_for(&current, &origin);
    if next == current {
        return Ok(());
    }
    write_mode(&next)?;
    *slot = Some(next);
    drop(slot);
    invalidate();
    Ok(())
}

/// "Permanent link" (false) or "Temporary link" (true). The saved domain is left alone.
pub fn set_link_temporary(on: bool) -> Result<(), String> {
    set_link_mode(if on { LinkChoice::Temporary } else { LinkChoice::Permanent }, None, None).map(|_| ())
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
        assert_eq!(load_mode(&file), LinkMode::default());
        std::fs::write(&file, r#"{"temporary":true}"#).unwrap();
        assert_eq!(load_mode(&file).choice, LinkChoice::Temporary);
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(load_mode(&file), LinkMode::default());
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://phone.example.com","verified_domain":"https://phone.example.com"}"#).unwrap();
        let m = load_mode(&file);
        assert_eq!((m.choice, m.domain.as_deref(), m.proven_domain()), (LinkChoice::Domain, Some("https://phone.example.com"), Some("https://phone.example.com")));
        // a hand-edited file with no proof, or a proof for another address, keeps the domain but never activates it
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://phone.example.com"}"#).unwrap();
        assert_eq!(load_mode(&file).proven_domain(), None);
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://phone.example.com","verified_domain":"https://other.example.com"}"#).unwrap();
        assert_eq!(load_mode(&file).proven_domain(), None);
        // this computer's own name is never accepted from the file
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://localhost","verified_domain":"https://localhost"}"#).unwrap();
        assert_eq!(load_mode(&file), LinkMode::default());
        // a hand-edited file cannot put a bad or missing domain to use
        std::fs::write(&file, r#"{"choice":"domain","domain":"http://10.0.0.1","verified_domain":"http://10.0.0.1"}"#).unwrap();
        assert_eq!(load_mode(&file), LinkMode::default());
        std::fs::write(&file, r#"{"choice":"domain"}"#).unwrap();
        assert_eq!(load_mode(&file).choice, LinkChoice::Permanent);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn switching_never_loses_the_other_setting() {
        let start = LinkMode::default();
        let on = next_mode(&start, LinkChoice::Domain, Some("Phone.Example.com".into()), None).unwrap();
        assert_eq!((on.choice, on.domain.as_deref()), (LinkChoice::Domain, Some("https://phone.example.com")));
        let back = next_mode(&on, LinkChoice::Permanent, None, None).unwrap();
        assert_eq!((back.choice, back.domain.as_deref()), (LinkChoice::Permanent, Some("https://phone.example.com")));
        let temp = next_mode(&back, LinkChoice::Temporary, None, None).unwrap();
        assert_eq!(temp.domain.as_deref(), Some("https://phone.example.com"));
        assert_eq!(next_mode(&temp, LinkChoice::Domain, None, None).unwrap().choice, LinkChoice::Domain);
        // an address nobody checked is never proven by saving or switching; an edit drops an earlier proof
        assert_eq!(on.proven_domain(), None);
        let proven = LinkMode { verified: Some("https://phone.example.com".into()), ..on.clone() };
        assert_eq!(proven.proven_domain(), Some("https://phone.example.com"));
        // the pass is kept while another link is on, and counts again when "My domain" (Direct, the route it was made with) is back
        let perm = next_mode(&proven, LinkChoice::Permanent, None, None).unwrap();
        assert_eq!(perm.verified.as_deref(), Some("https://phone.example.com"));
        assert_eq!(next_mode(&perm, LinkChoice::Domain, None, None).unwrap().proven_domain(), Some("https://phone.example.com"));
        assert_eq!(next_mode(&proven, LinkChoice::Domain, Some("other.example.com".into()), None).unwrap().proven_domain(), None);
        assert_eq!(next_mode(&proven, LinkChoice::Domain, Some("PHONE.example.com".into()), None).unwrap().proven_domain(), Some("https://phone.example.com"));
        assert!(next_mode(&start, LinkChoice::Domain, None, None).is_err());
        assert!(next_mode(&on, LinkChoice::Domain, Some("http://evil.example.com".into()), None).is_err());
    }

    #[test]
    fn an_old_file_with_no_route_loads_as_before_and_routes_default_per_link() {
        let d = dir("route-old");
        let file = d.join("mode.json");
        // every file written before routes existed: same choice, domain and proof as before, and the link's own route
        std::fs::write(&file, r#"{"choice":"permanent","temporary":false,"domain":null,"verified_domain":null}"#).unwrap();
        assert_eq!(load_mode(&file), LinkMode::default());
        std::fs::write(&file, r#"{"temporary":true}"#).unwrap();
        let temp = load_mode(&file);
        assert_eq!((temp.choice, temp.route), (LinkChoice::Temporary, LinkRoute::Book));
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://phone.example.com","verified_domain":"https://phone.example.com"}"#).unwrap();
        let domain = load_mode(&file);
        assert_eq!((domain.choice, domain.domain.as_deref(), domain.proven_domain()), (LinkChoice::Domain, Some("https://phone.example.com"), Some("https://phone.example.com")));
        assert_eq!(domain.route, LinkRoute::Direct);
        // a route that this app does not build for the link is never trusted from the file
        std::fs::write(&file, r#"{"choice":"permanent","route":"direct"}"#).unwrap();
        assert_eq!(load_mode(&file).route, LinkRoute::Book);
        // "My domain" builds both routes now: a saved Address book is kept, no route at all stays Direct
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://phone.example.com","route":"book"}"#).unwrap();
        assert_eq!(load_mode(&file).route, LinkRoute::Book);
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://phone.example.com"}"#).unwrap();
        assert_eq!(load_mode(&file).route, LinkRoute::Direct);
        std::fs::write(&file, r#"{"choice":"permanent","route":"sideways"}"#).unwrap();
        assert_eq!(load_mode(&file).route, LinkRoute::Book);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_route_is_written_and_read_back_and_unknown_text_is_refused() {
        let on = LinkMode { choice: LinkChoice::Domain, domain: Some("https://phone.example.com".into()), verified: None, verified_route: LinkRoute::Direct, route: LinkRoute::Direct, last_routes: Vec::new() };
        let d = dir("route-write");
        let file = d.join("mode.json");
        std::fs::write(&file, mode_text(&on)).unwrap();
        let back = load_mode(&file);
        assert_eq!((back.choice, back.route), (LinkChoice::Domain, LinkRoute::Direct));
        assert!(mode_text(&on).contains(r#""route":"direct""#));
        assert_eq!(parse_route_arg(None), Ok(None));
        assert_eq!(parse_route_arg(Some("book")), Ok(Some(LinkRoute::Book)));
        assert_eq!(parse_route_arg(Some("direct")), Ok(Some(LinkRoute::Direct)));
        assert!(parse_route_arg(Some("")).is_err());
        assert!(parse_route_arg(Some("Direct ")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_route_each_name_last_used_comes_back_and_never_crosses_to_another_name() {
        let start = LinkMode::default();
        // Permanent's own Address book never turns a name into an Address book: a name with no history gets Direct
        assert_eq!(next_mode(&start, LinkChoice::Domain, Some("a.example.com".into()), None).unwrap().route, LinkRoute::Direct);
        let a_book = next_mode(&start, LinkChoice::Domain, Some("a.example.com".into()), Some(LinkRoute::Book)).unwrap();
        let perm = next_mode(&a_book, LinkChoice::Permanent, None, None).unwrap();
        let back = next_mode(&perm, LinkChoice::Domain, None, None).unwrap();
        assert_eq!(back.route, LinkRoute::Book, "Address book restored");
        // another name does not inherit it
        assert_eq!(next_mode(&perm, LinkChoice::Domain, Some("b.example.com".into()), None).unwrap().route, LinkRoute::Direct);
        // the choice is remembered per name; Direct is remembered too
        let b_direct = next_mode(&back, LinkChoice::Domain, Some("b.example.com".into()), Some(LinkRoute::Direct)).unwrap();
        let perm_b = next_mode(&b_direct, LinkChoice::Temporary, None, None).unwrap();
        assert_eq!(next_mode(&perm_b, LinkChoice::Domain, None, None).unwrap().route, LinkRoute::Direct);
        assert_eq!(next_mode(&perm_b, LinkChoice::Domain, Some("a.example.com".into()), None).unwrap().route, LinkRoute::Book);
        // an explicit route always wins over the memory
        assert_eq!(next_mode(&perm, LinkChoice::Domain, None, Some(LinkRoute::Direct)).unwrap().route, LinkRoute::Direct);
        // an older file (no memory) that was on an Address book still remembers it when it is left
        let old = LinkMode { choice: LinkChoice::Domain, domain: Some("https://a.example.com".into()), route: LinkRoute::Book, ..LinkMode::default() };
        let left = next_mode(&old, LinkChoice::Permanent, None, None).unwrap();
        assert_eq!(next_mode(&left, LinkChoice::Domain, None, None).unwrap().route, LinkRoute::Book);
        // the list is capped and survives the file
        let mut m = LinkMode::default();
        for i in 0..12 {
            m = next_mode(&m, LinkChoice::Domain, Some(format!("n{i}.example.com")), Some(LinkRoute::Book)).unwrap();
        }
        assert_eq!(m.last_routes.len(), MAX_ROUTES);
        let d = dir("routes-memory");
        let file = d.join("mode.json");
        std::fs::write(&file, mode_text(&m)).unwrap();
        let loaded = load_mode(&file);
        assert_eq!(loaded.last_routes.len(), MAX_ROUTES);
        assert!(loaded.last_routes.contains(&("https://n11.example.com".to_string(), LinkRoute::Book)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn only_the_built_routes_are_ever_saved() {
        let start = LinkMode::default();
        // asking for a route that is not built yet is refused, for both links, and nothing is saved
        assert!(next_mode(&start, LinkChoice::Permanent, None, Some(LinkRoute::Direct)).is_err());
        assert!(next_mode(&start, LinkChoice::Temporary, None, Some(LinkRoute::Direct)).is_err());
        let domain = next_mode(&start, LinkChoice::Domain, Some("phone.example.com".into()), None).unwrap();
        // "My domain" builds Address book too; Permanent and Temporary only build the Address book
        assert_eq!(next_mode(&domain, LinkChoice::Domain, None, Some(LinkRoute::Book)).unwrap().route, LinkRoute::Book);
        // with no route asked, the new link gets its own built route
        assert_eq!(next_mode(&start, LinkChoice::Domain, Some("phone.example.com".into()), None).unwrap().route, LinkRoute::Direct);
        assert_eq!(next_mode(&domain, LinkChoice::Permanent, None, None).unwrap().route, LinkRoute::Book);
        assert_eq!(next_mode(&domain, LinkChoice::Temporary, None, None).unwrap().route, LinkRoute::Book);
        // switching away and back brings back what THIS name last used (Permanent's own Address book never rides along: see the next test)
        let book = next_mode(&domain, LinkChoice::Domain, None, Some(LinkRoute::Book)).unwrap();
        let perm = next_mode(&book, LinkChoice::Permanent, None, None).unwrap();
        assert_eq!(perm.route, LinkRoute::Book);
        assert_eq!(next_mode(&perm, LinkChoice::Domain, None, None).unwrap().route, LinkRoute::Book);
        // staying on "My domain" without asking keeps the route it has
        assert_eq!(next_mode(&book, LinkChoice::Domain, Some("other.example.com".into()), None).unwrap().route, LinkRoute::Book);
        // asking for the built route saves it
        assert_eq!(next_mode(&domain, LinkChoice::Domain, None, Some(LinkRoute::Direct)).unwrap().route, LinkRoute::Direct);
        assert_eq!(next_mode(&start, LinkChoice::Permanent, None, Some(LinkRoute::Book)).unwrap().route, LinkRoute::Book);
        // every route the app can end up with is one its link supports
        for choice in [LinkChoice::Permanent, LinkChoice::Temporary, LinkChoice::Domain] {
            assert!(choice.supports(choice.default_route()));
        }
    }

    #[test]
    fn a_withdrawn_pass_stops_the_domain_being_given_to_phones() {
        let proven = LinkMode { choice: LinkChoice::Domain, domain: Some("https://a.example.com".into()), verified: Some("https://a.example.com".into()), verified_route: LinkRoute::Direct, route: LinkRoute::Direct, last_routes: Vec::new() };
        assert_eq!(proven.proven_domain(), Some("https://a.example.com"));
        let withdrawn = without_pass_for(&proven, "https://a.example.com");
        assert_eq!(withdrawn.proven_domain(), None);
        // the typed domain and the choice stay saved
        assert_eq!((withdrawn.choice, withdrawn.domain.as_deref()), (LinkChoice::Domain, Some("https://a.example.com")));
        // a check of some other address leaves this pass alone
        assert_eq!(without_pass_for(&proven, "https://b.example.com"), proven);
    }

    #[test]
    fn a_pass_is_refused_when_the_route_or_the_name_changed_during_the_check() {
        let name = "https://phone.example.com";
        let book = LinkMode { choice: LinkChoice::Domain, domain: Some(name.into()), verified: None, verified_route: LinkRoute::Direct, route: LinkRoute::Book, last_routes: Vec::new() };
        assert!(pass_applies(&book, name, LinkRoute::Book).is_ok());
        // the style was switched while the Check ran (either way)
        assert!(pass_applies(&book, name, LinkRoute::Direct).is_err());
        let direct = LinkMode { route: LinkRoute::Direct, ..book.clone() };
        assert!(pass_applies(&direct, name, LinkRoute::Direct).is_ok());
        assert!(pass_applies(&direct, name, LinkRoute::Book).is_err());
        // the name was edited meanwhile
        assert!(pass_applies(&book, "https://old.example.com", LinkRoute::Book).is_err());
        assert!(pass_applies(&direct, "https://old.example.com", LinkRoute::Direct).is_ok(), "a Direct Check of a typed name still counts");
        // a Direct Check of a name typed in the sheet before it is saved (another link is on) still counts
        let perm = LinkMode { choice: LinkChoice::Permanent, domain: None, route: LinkRoute::Book, ..book.clone() };
        assert!(pass_applies(&LinkMode { route: LinkRoute::Direct, ..perm.clone() }, name, LinkRoute::Direct).is_ok());
        // ...but an Address book pass never lands on a name that is not the saved one
        assert!(pass_applies(&perm, name, LinkRoute::Book).is_err());
        assert!(pass_applies(&LinkMode { choice: LinkChoice::Domain, ..perm }, name, LinkRoute::Book).is_err(), "no saved name");
    }

    #[test]
    fn a_pass_counts_only_for_the_route_it_was_made_with() {
        let direct = LinkMode { choice: LinkChoice::Domain, domain: Some("https://a.example.com".into()), verified: Some("https://a.example.com".into()), verified_route: LinkRoute::Direct, route: LinkRoute::Direct, last_routes: Vec::new() };
        assert_eq!(direct.proven_domain(), Some("https://a.example.com"));
        // switching the same name to the Address book does not inherit the Direct pass, and back it is still there
        let book = LinkMode { route: LinkRoute::Book, ..direct.clone() };
        assert_eq!(book.proven_domain(), None);
        let book_pass = LinkMode { verified_route: LinkRoute::Book, ..book.clone() };
        assert_eq!(book_pass.proven_domain(), Some("https://a.example.com"));
        assert_eq!(LinkMode { route: LinkRoute::Direct, ..book_pass }.proven_domain(), None);
        // the pass is written with its route, and a file with no route on its pass was a Direct one
        let d = dir("pass-route");
        let file = d.join("mode.json");
        std::fs::write(&file, mode_text(&LinkMode { verified_route: LinkRoute::Book, ..book.clone() })).unwrap();
        assert_eq!(load_mode(&file).verified_route, LinkRoute::Book);
        std::fs::write(&file, r#"{"choice":"domain","domain":"https://a.example.com","verified_domain":"https://a.example.com","route":"book"}"#).unwrap();
        assert_eq!(load_mode(&file).proven_domain(), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_address_book_name_is_a_trusted_phone_origin_only_while_proven_and_on() {
        let d = dir("cors-book");
        let tunnel = d.join("potato-workspace.tunnel.json");
        tunnel_config::save(&tunnel, &TunnelConfig::Quick).unwrap();
        let mode = d.join("potato-workspace.link-mode.json");
        let write = |text: &str| std::fs::write(&mode, text).unwrap();
        // proven Address book name: trusted
        write(r#"{"choice":"domain","domain":"https://phone.example.com","verified_domain":"https://phone.example.com","verified_route":"book","route":"book"}"#);
        assert_eq!(allowed_from(&tunnel), vec!["https://phone.example.com".to_string()]);
        // not proven, proven for Direct only, another link on, or the Direct route: never trusted
        write(r#"{"choice":"domain","domain":"https://phone.example.com","route":"book"}"#);
        assert!(allowed_from(&tunnel).is_empty());
        write(r#"{"choice":"domain","domain":"https://phone.example.com","verified_domain":"https://phone.example.com","verified_route":"direct","route":"book"}"#);
        assert!(allowed_from(&tunnel).is_empty());
        write(r#"{"choice":"permanent","domain":"https://phone.example.com","verified_domain":"https://phone.example.com","verified_route":"book","route":"book"}"#);
        assert!(allowed_from(&tunnel).is_empty());
        write(r#"{"choice":"domain","domain":"https://phone.example.com","verified_domain":"https://phone.example.com","verified_route":"direct","route":"direct"}"#);
        assert!(allowed_from(&tunnel).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_own_domain_never_becomes_a_trusted_cross_origin_caller() {
        // CORS is built only from the saved Worker (`allowed_from`); a saved link mode or domain is not read there.
        let d = dir("cors");
        let tunnel = d.join("potato-workspace.tunnel.json");
        tunnel_config::save(&tunnel, &TunnelConfig::Quick).unwrap();
        std::fs::write(d.join("potato-workspace.link-mode.json"), r#"{"choice":"domain","domain":"https://phone.example.com"}"#).unwrap();
        assert!(allowed_from(&tunnel).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_address_book_loop_only_withdraws_an_address_book_pass() {
        let name = "https://phone.example.com";
        let mk = |route| LinkMode { choice: LinkChoice::Domain, domain: Some(name.into()), verified: Some(name.into()), verified_route: route, route: LinkRoute::Direct, last_routes: Vec::new() };
        // a fresh Direct pass for the same name survives the Book loop
        let direct = mk(LinkRoute::Direct);
        assert_eq!(without_route_pass_for(&direct, name, LinkRoute::Book), direct);
        // a Book pass is withdrawn by it, and only for that name
        let book = mk(LinkRoute::Book);
        assert_eq!(without_route_pass_for(&book, name, LinkRoute::Book).verified, None);
        assert_eq!(without_route_pass_for(&book, "https://other.example.com", LinkRoute::Book), book);
    }
}
