//! "My domain" + Address book: the person's own name points at a small Worker (`relay/domain-book`) that only holds this
//! PC's current quick-tunnel address and serves the phone page. This module owns the pieces that are not the link mode
//! itself (see `worker_origins`) and not the registration loop (see `mobile_tunnel`):
//!
//! - the keys: one master key per PC (own private file) and, from it, ONE KEY PER NAME (`HMAC-SHA256(master, host)`). A name
//!   only ever receives its own key, so a wrong or hostile name can never learn a key that opens another Worker,
//! - the Worker files the app shows and copies (the source and a `wrangler.toml` with the name and the HASH of that name's key),
//! - which names are "armed": this PC sends a name its key only after the name has proven it is the Worker deployed with that
//!   key's hash (a typo, or a server that merely claims to be a Worker, never receives anything),
//! - the Check: the phone's real path, `GET <name>/_pm/where?nonce=` (the answer must carry the Worker's proof) and then
//!   `<tunnel>/bridge/health?nonce=`, so a pass means a phone that opens the name really ends up at THIS PC.
//!
//! Nothing here logs a key or a nonce. Only public addresses are connected to, no redirect is followed.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::mobile_tunnel::{stable_link, ConnectionTest};
use crate::own_domain::{self, Verdict};
use crate::tunnel_config;

const SECRET_FILE: &str = "potato-workspace.domain-book.json";
const WORKER_SOURCE: &str = include_str!("../../../../relay/domain-book/worker.js");
const WRANGLER_TEMPLATE: &str = include_str!("../../../../relay/domain-book/wrangler.toml.tpl");

fn secret_file() -> PathBuf {
    tunnel_config::tunnel_file().with_file_name(SECRET_FILE)
}

fn read_json(file: &Path) -> serde_json::Value {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(serde_json::Value::Null)
}

fn read_secret(file: &Path) -> Option<String> {
    let secret = read_json(file).get("secret")?.as_str()?.trim().to_string();
    (secret.len() >= 32).then_some(secret)
}

/// The master key of this PC, made the first time it is needed and kept in its own private file. It is never sent anywhere:
/// only keys derived from it for one name each are.
fn secret_in(file: &Path) -> Result<String, String> {
    if let Some(secret) = read_secret(file) {
        return Ok(secret);
    }
    let secret = tunnel_config::generate_secret();
    // A new master key makes every earlier "armed" name meaningless: start the list again.
    crate::secure_file::write_private(file, &serde_json::json!({ "secret": secret, "armed": [] }).to_string())?;
    Ok(secret)
}

pub fn secret() -> Result<String, String> {
    secret_in(&secret_file())
}

/// SHA-256 as lowercase hex (what the Worker keeps of a key).
pub fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// HMAC-SHA-256 as lowercase hex.
pub fn hmac_hex(key: &[u8], message: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac takes any key length");
    mac.update(message);
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// The host of a normalized `https://host` origin, lowercase.
fn host_of(domain_origin: &str) -> String {
    domain_origin.trim_start_matches("https://").trim_end_matches('/').to_ascii_lowercase()
}

/// The key for ONE name: `HMAC-SHA256(master, host)`. Different names get unrelated keys; the master cannot be got from one.
pub fn name_key(master: &str, domain_origin: &str) -> String {
    hmac_hex(master.as_bytes(), host_of(domain_origin).as_bytes())
}

/// The key this PC would send to `domain_origin` (the master key is made now when this PC has none yet).
pub fn key_for(domain_origin: &str) -> Result<String, String> {
    Ok(name_key(&secret()?, domain_origin))
}

// ------------------------------------------------------------------------------------------ armed names

fn armed_in(file: &Path, domain_origin: &str) -> bool {
    let host = host_of(domain_origin);
    read_json(file).get("armed").and_then(|a| a.as_array()).is_some_and(|a| a.iter().any(|h| h.as_str() == Some(host.as_str())))
}

fn set_armed_in(file: &Path, domain_origin: &str, on: bool) -> Result<(), String> {
    let master = secret_in(file)?;
    let host = host_of(domain_origin);
    let mut list: Vec<String> =
        read_json(file).get("armed").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|h| h.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let had = list.contains(&host);
    if on == had {
        return Ok(());
    }
    if on {
        list.push(host);
        let keep = list.len().saturating_sub(8);
        list.drain(..keep);
    } else {
        list.retain(|h| h != &host);
    }
    crate::secure_file::write_private(file, &serde_json::json!({ "secret": master, "armed": list }).to_string())
}

/// Has this name proven it is the Worker deployed with its key's hash? Only then may it be sent its key.
pub fn is_armed(domain_origin: &str) -> bool {
    armed_in(&secret_file(), domain_origin)
}

pub fn arm(domain_origin: &str) -> Result<(), String> {
    set_armed_in(&secret_file(), domain_origin, true)
}

/// The name answered as something else: it gets nothing until it proves itself again.
pub fn disarm(domain_origin: &str) -> Result<(), String> {
    set_armed_in(&secret_file(), domain_origin, false)
}

// ------------------------------------------------------------------------------------------ the Worker files

/// What the screen shows and copies for the person's own Cloudflare.
#[derive(Debug, Clone, Serialize)]
pub struct WorkerFiles {
    /// The name only (`phone.example.com`), as it goes into `routes`.
    pub host: String,
    /// `worker.js`: the same for everybody, no name inside.
    pub worker_js: String,
    /// `wrangler.toml` with the name and the hash of THIS NAME's key filled in. The key itself is not in it.
    pub wrangler_toml: String,
}

/// Pure: the files for `domain_origin` and the PC's master key. A name with a port cannot be a Cloudflare custom domain.
pub fn files_for(domain_origin: &str, master: &str) -> Result<WorkerFiles, String> {
    let rest = domain_origin.strip_prefix("https://").ok_or_else(|| "Use a name that starts with https.".to_string())?;
    if rest.contains(':') {
        return Err("The Address book needs a plain name without a port number, for example phone.example.com.".into());
    }
    let hash = sha256_hex(&name_key(master, domain_origin));
    let wrangler = WRANGLER_TEMPLATE.replace("{{HOST}}", rest).replace("{{SECRET_SHA256}}", &hash);
    Ok(WorkerFiles { host: rest.to_string(), worker_js: WORKER_SOURCE.to_string(), wrangler_toml: wrangler })
}

/// The files for what the person typed (the master key is made now when this PC has none yet).
pub fn files(raw: &str) -> Result<WorkerFiles, String> {
    files_for(&own_domain::normalize(raw)?, &secret()?)
}

// ------------------------------------------------------------------------------------------ the Check

/// What one GET returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub status: Option<u16>,
    pub body: String,
    pub transport: Option<String>,
}

/// One GET: public addresses only, no redirect, a short wait, a capped read.
fn http_get(url: &str, nonce: Option<&str>) -> Fetched {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(own_domain::CHECK_TIMEOUT).resolver(own_domain::PublicOnly).build();
    let mut request = agent.get(url).set("Accept-Encoding", "identity");
    if let Some(nonce) = nonce {
        request = request.query("nonce", nonce);
    }
    let read = |resp: ureq::Response| {
        let mut body = String::new();
        let _ = resp.into_reader().take(own_domain::BODY_CAP).read_to_string(&mut body);
        body
    };
    match request.call() {
        Ok(resp) => {
            let status = resp.status();
            Fetched { status: Some(status), body: read(resp), transport: None }
        }
        Err(ureq::Error::Status(code, resp)) => Fetched { status: Some(code), body: read(resp), transport: None },
        Err(err) => Fetched { status: None, body: String::new(), transport: Some(err.to_string()) },
    }
}

/// The plain sentence for a reason code. Flat words: what is wrong and what to do.
pub fn reason_message(reason: &str) -> &'static str {
    match reason {
        "reached" => "Your name reaches this PC through the Address book.",
        "no_quick_tunnel" => "The Address book needs the automatic Cloudflare address. Turn the tunnel back to automatic first.",
        "no_address" => "This PC has no tunnel address yet. Wait for the tunnel to start, then check again.",
        "no_worker" => "That name answers, but it is not your Address book Worker. Deploy the Worker with the settings from this app and point the name at it.",
        "is_direct" => "That name already goes straight to this PC (Direct). Use Direct, it works now. Or replace it with the Address book.",
        "other_key" => "That name is an Address book made on another PC or with old settings. Set it up again from this PC.",
        "unconfigured" => "That name is an Address book Worker that has no settings yet. Set it up again from this PC.",
        "dns_taken" => "That name is already used by a DNS record. Remove it in Cloudflare first, or replace it.",
        "zone_missing" => "The name's domain is not on this Cloudflare account. Add it there first.",
        "not_linked" => "The Worker is there, but this PC has not told it where it is yet. Keep this app open and check again in a minute.",
        "stale" => "The Worker still holds an older address. This PC is updating it. Check again in a minute.",
        "tunnel_down" => "The Worker knows this PC's address, but nothing answers there right now. Press Restart tunnel, then check again.",
        "not_this_pc" => "The Worker points at another computer. Open this app on the PC that should be linked.",
        "over_quota" => "Cloudflare's free daily limit for your Worker is used up. It resets at 00:00 UTC.",
        "busy" => "The Worker says too many checks. Wait a minute and try again.",
        "dns" => "That name does not point anywhere yet. Add it to Cloudflare and try again.",
        "timeout" => "The name did not answer in time. Try again.",
        "bad_gateway" => "Cloudflare answers for that name, but the Worker behind it is not working.",
        "redirect" => "The name sends visitors somewhere else. Point it straight at the Worker.",
        _ => "Not reachable yet. Check that the name points at your Worker and try again.",
    }
}

fn cloudflare_quota(body: &str) -> bool {
    body.contains("error code: 1027") || body.contains("error code 1027")
}

/// What only the Worker deployed with `key_hash` can answer to `nonce`.
pub fn where_proof(key_hash: &str, nonce: &str) -> String {
    hmac_hex(key_hash.as_bytes(), nonce.as_bytes())
}

/// Pure: what `GET <name>/_pm/where?nonce=` means for this PC (whose own quick address is `quick`). The pair is the verdict
/// (`Ok(())` = the Worker points at this PC's current address; `Err(reason)` = what is wrong) and whether the answer carried the
/// Worker's own proof. An answer without the proof is never trusted, however well it repeats our address.
pub fn judge_where(got: &Fetched, quick: &str, nonce: &str, key_hash: &str) -> (Result<(), &'static str>, bool) {
    if let Some(err) = &got.transport {
        return (Err(own_domain::domain_reason(Verdict::Unreached, None, Some(err))), false);
    }
    let json = serde_json::from_str::<serde_json::Value>(&got.body).ok();
    let authentic = json.as_ref().and_then(|v| v.get("proof")?.as_str().map(|p| p == where_proof(key_hash, nonce))).unwrap_or(false);
    let ok_flag = json.as_ref().and_then(|v| v.get("ok")?.as_bool());
    match got.status {
        Some(200) => {
            if !authentic {
                return (Err("no_worker"), false);
            }
            match (ok_flag, json.as_ref().and_then(|v| v.get("url")?.as_str())) {
                (Some(true), Some(url)) if stable_link::is_quick_origin(url) && url == quick => (Ok(()), true),
                (Some(true), Some(url)) if stable_link::is_quick_origin(url) => (Err("stale"), true),
                _ => (Err("no_worker"), false),
            }
        }
        Some(429 | 503) if cloudflare_quota(&got.body) => (Err("over_quota"), false),
        Some(429) => (Err("busy"), false),
        // The Worker's own "not linked yet" answer is JSON `{"ok":false,"proof":..}`; any other 503 is Cloudflare's.
        Some(503) if ok_flag == Some(false) => {
            if authentic {
                (Err("not_linked"), true)
            } else {
                (Err("no_worker"), false)
            }
        }
        Some(300..=399) => (Err("redirect"), false),
        Some(502 | 503 | 504 | 521 | 522 | 523 | 530) => (Err("bad_gateway"), false),
        _ => (Err("no_worker"), false),
    }
}

/// What a Check found and what the caller must do about it.
#[derive(Debug, Clone)]
pub struct Checked {
    pub test: ConnectionTest,
    pub verdict: Verdict,
    /// The name answered with the Worker's own proof: it is the Worker deployed with this name's key.
    pub authentic: bool,
}

/// The Check for "My domain" + Address book. `quick` is this PC's current quick-tunnel address (none yet), `supported` says
/// whether this PC runs a quick tunnel at all (Named, Custom and OpenTunnel have no quick address to register).
pub fn check_with(
    origin: &str,
    quick: Option<String>,
    supported: bool,
    expected: &dyn Fn(&str) -> String,
    nonce: &str,
    key_hash: &str,
    get: &dyn Fn(&str, Option<&str>) -> Fetched,
) -> Checked {
    let url = stable_link::where_url(origin);
    let started = Instant::now();
    let done = |reason: &'static str, verdict: Verdict, status: Option<u16>, authentic: bool| Checked {
        test: ConnectionTest { ok: reason == "reached", url: url.clone(), http_status: status, latency_ms: started.elapsed().as_millis() as u64, message: reason_message(reason).into(), reason: Some(reason) },
        verdict,
        authentic,
    };
    if !supported {
        return done("no_quick_tunnel", Verdict::Unreached, None, false);
    }
    let Some(quick) = quick else { return done("no_address", Verdict::Unreached, None, false) };
    let asked = get(&url, Some(nonce));
    let (judged, authentic) = judge_where(&asked, &quick, nonce, key_hash);
    if let Err(reason) = judged {
        if reason == "no_worker" && !authentic {
            // Not the Worker for this key. Say what it IS: an Address book of another PC, a Worker without settings, this very PC
            // behind a plain proxy (Direct), or just some other website.
            let found = classify_foreign(origin, &asked, nonce, key_hash, expected, get);
            return done(found, Verdict::Unreached, asked.status, false);
        }
        return done(reason, Verdict::Unreached, asked.status, authentic);
    }
    // The Worker (proven) points at this PC's address. Does that address answer as THIS running app? (The proof only this app can make.)
    let tunnel_nonce = own_domain::fresh_nonce();
    let tunnel = get(&format!("{quick}/bridge/health"), Some(&tunnel_nonce));
    let verdict = own_domain::verdict_of(tunnel.status, tunnel.transport.is_some(), &tunnel.body, &expected(&tunnel_nonce));
    match verdict {
        Verdict::Pass => done("reached", Verdict::Pass, tunnel.status, true),
        Verdict::NotThisPc => done("not_this_pc", Verdict::NotThisPc, tunnel.status, true),
        Verdict::Unreached => done("tunnel_down", Verdict::Unreached, tunnel.status, true),
    }
}

/// Pure part: what the Worker's `where` answer says about the key it was deployed with. `Some("other_key")`: it made a proof, but
/// not with this name's key. `Some("unconfigured")`: JSON with no proof at all (no key was ever put into it). `None`: no
/// verdict from the answer alone.
fn key_state_of(asked: &Fetched, nonce: &str, key_hash: &str) -> Option<&'static str> {
    let json = serde_json::from_str::<serde_json::Value>(&asked.body).ok()?;
    json.as_object()?;
    match json.get("proof").and_then(|p| p.as_str()) {
        Some(p) if p == where_proof(key_hash, nonce) => None,
        Some(_) => Some("other_key"),
        None => Some("unconfigured"),
    }
}

/// A name that did not prove itself as this PC's Worker: what is it? Only a bare nonce is sent to it, never a key.
fn classify_foreign(
    origin: &str,
    asked: &Fetched,
    nonce: &str,
    key_hash: &str,
    expected: &dyn Fn(&str) -> String,
    get: &dyn Fn(&str, Option<&str>) -> Fetched,
) -> &'static str {
    let health = get(&format!("{origin}/_pm/health"), None);
    let is_book_worker = health.status == Some(200)
        && serde_json::from_str::<serde_json::Value>(&health.body).ok().and_then(|v| v.get("worker")?.as_str().map(|w| w == "pm-book/1")).unwrap_or(false);
    if is_book_worker {
        return key_state_of(asked, nonce, key_hash).unwrap_or("no_worker");
    }
    if is_direct_with(origin, expected, get) {
        "is_direct"
    } else {
        "no_worker"
    }
}

/// The Direct proof: does the name itself answer as THIS running app? Only a bare nonce is sent to it.
pub fn is_direct_with(origin: &str, expected: &dyn Fn(&str) -> String, get: &dyn Fn(&str, Option<&str>) -> Fetched) -> bool {
    let direct_nonce = own_domain::fresh_nonce();
    let direct = get(&format!("{origin}/bridge/health"), Some(&direct_nonce));
    own_domain::verdict_of(direct.status, direct.transport.is_some(), &direct.body, &expected(&direct_nonce)) == Verdict::Pass
}

/// `is_direct_with` on the real network (public addresses only). Used when a registered name stops being the Worker.
pub fn is_direct(origin: &str) -> bool {
    is_direct_with(origin, &crate::bridge::identity::own_domain_proof, &http_get)
}

/// How long one press of Check waits for this PC to tell a just-armed Worker where it is, and how often it looks again.
pub const SETTLE_BUDGET: std::time::Duration = std::time::Duration::from_secs(12);
pub const SETTLE_STEP: std::time::Duration = std::time::Duration::from_secs(2);

/// A Check that ended on "not_linked" (the Worker is ours but has not been told yet): look again every `step` until it is
/// linked, ends another way, or `budget` is used up, so one press ends on a pass. Every look is a full Check.
pub fn settle(first: Checked, budget: std::time::Duration, step: std::time::Duration, sleep: &dyn Fn(std::time::Duration), again: &mut dyn FnMut() -> Checked) -> Checked {
    let mut last = first;
    let mut waited = std::time::Duration::ZERO;
    while last.test.reason == Some("not_linked") && waited < budget {
        sleep(step);
        waited += step;
        last = again();
    }
    last
}

/// The Check as the command runs it: when the name proves it is the Worker, `on_authentic` runs once (arm it, tell it where this PC
/// is) and a "not linked yet" answer is looked at again until it is linked (see `settle`). Each look uses a fresh nonce.
#[allow(clippy::too_many_arguments)]
pub fn check_armed_with(
    origin: &str,
    quick: Option<String>,
    supported: bool,
    expected: &dyn Fn(&str) -> String,
    key_hash: &str,
    get: &dyn Fn(&str, Option<&str>) -> Fetched,
    on_authentic: &dyn Fn(),
    sleep: &dyn Fn(std::time::Duration),
    budget: std::time::Duration,
    step: std::time::Duration,
) -> Checked {
    let mut run = || check_with(origin, quick.clone(), supported, expected, &own_domain::fresh_nonce(), key_hash, get);
    let first = run();
    if first.authentic {
        on_authentic();
    }
    settle(first, budget, step, sleep, &mut run)
}

/// `check_armed_with` on the real network.
pub fn check_armed(raw: &str, quick: Option<String>, supported: bool, expected: &dyn Fn(&str) -> String, on_authentic: &dyn Fn()) -> Result<Checked, String> {
    let origin = own_domain::normalize(raw)?;
    let key_hash = sha256_hex(&key_for(&origin)?);
    Ok(check_armed_with(&origin, quick, supported, expected, &key_hash, &http_get, on_authentic, &std::thread::sleep, SETTLE_BUDGET, SETTLE_STEP))
}

/// After this PC told a reset or re-pointed Worker again: run the full Check and, only when it passes for the proven Worker, set the
/// pass again (`mark` writes it; it refuses a route or name that changed meanwhile). True when the pass was set.
pub fn restore_pass(check: &dyn Fn() -> Result<Checked, String>, mark: &dyn Fn() -> Result<(), String>) -> bool {
    match check() {
        Ok(checked) if grants_pass(&checked) => mark().is_ok(),
        _ => false,
    }
}

/// A name that is not the Worker for this key (another website, another PC's Address book, a Worker without settings) is
/// forgotten as proven. A name that is this PC (Direct) is left as it is.
pub fn should_disarm(checked: &Checked) -> bool {
    matches!(checked.test.reason, Some("no_worker" | "other_key" | "unconfigured"))
}

/// Only a Check that reached this PC through the proven Worker may set the pass.
pub fn grants_pass(checked: &Checked) -> bool {
    checked.verdict == Verdict::Pass && checked.authentic && checked.test.ok
}

/// Who answers at a name, before this PC sends it anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    /// The Worker deployed with this name's key (it made the proof).
    Yes,
    /// Something answered, and it is not that Worker.
    Foreign,
    /// No usable answer now (down, slow, busy): try again later.
    Down,
}

/// Ask the name once and say what it is, and what it thinks of this PC's address (`quick`).
pub fn probe(domain_origin: &str, quick: &str, key_hash: &str) -> (Result<(), &'static str>, bool) {
    let nonce = own_domain::fresh_nonce();
    let got = http_get(&stable_link::where_url(domain_origin), Some(&nonce));
    judge_where(&got, quick, &nonce, key_hash)
}

pub fn authenticate(domain_origin: &str, key_hash: &str) -> Auth {
    match probe(domain_origin, "", key_hash) {
        (_, true) => Auth::Yes,
        (Err("no_worker"), false) => Auth::Foreign,
        _ => Auth::Down,
    }
}

/// What the periodic look at a registered Worker means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Monitor {
    /// Still pointing at this PC.
    Fine,
    /// The Worker is the right one but holds another address, or none (reset, or taken over by another PC): withdraw the pass and tell it again.
    ReRegister,
    /// The name is no longer that Worker: withdraw the pass, forget the name's proof, stop.
    Foreign,
    /// No usable answer: change nothing.
    Ignore,
}

pub fn monitor_decision(judged: &Result<(), &'static str>, authentic: bool) -> Monitor {
    match (judged, authentic) {
        (Ok(()), true) => Monitor::Fine,
        (Err("stale" | "not_linked"), true) => Monitor::ReRegister,
        (Err("no_worker"), false) => Monitor::Foreign,
        _ => Monitor::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUICK: &str = "https://calm-river-1234.trycloudflare.com";
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const MASTER: &str = "master-key-master-key-master-key-0123";

    fn hash() -> String {
        sha256_hex(&name_key(MASTER, "https://phone.example.com"))
    }
    fn ok(status: u16, body: &str) -> Fetched {
        Fetched { status: Some(status), body: body.into(), transport: None }
    }
    fn gone(why: &str) -> Fetched {
        Fetched { status: None, body: String::new(), transport: Some(why.into()) }
    }
    fn expected(n: &str) -> String {
        format!("proof-of-{n}")
    }
    /// What the real Worker says: JSON with its proof for the nonce it was sent.
    fn worker_says(status: u16, url: Option<&str>) -> Fetched {
        let proof = where_proof(&hash(), NONCE);
        match url {
            Some(url) => ok(status, &format!(r#"{{"ok":true,"url":"{url}","proof":"{proof}"}}"#)),
            None => ok(status, &format!(r#"{{"ok":false,"proof":"{proof}"}}"#)),
        }
    }
    /// A fake network: the answer for the Worker's `where` and for the PC's own address. Every tunnel nonce is answered with its proof.
    /// The name's own `/_pm/health` and `/bridge/health` (the Direct proof) answer `Net` defaults: "not a Worker", "another website".
    /// `{PROOF}` in the Direct body is what this app would answer to that nonce.
    struct Net {
        health: Fetched,
        direct: Fetched,
    }
    impl Default for Net {
        fn default() -> Self {
            Net { health: ok(404, "<html>not found</html>"), direct: ok(200, "<html>a web page</html>") }
        }
    }
    fn run(supported: bool, quick: Option<&str>, worker: Fetched, tunnel: Option<Fetched>) -> Checked {
        run_net(supported, quick, worker, tunnel, Net::default())
    }
    fn run_net(supported: bool, quick: Option<&str>, worker: Fetched, tunnel: Option<Fetched>, net: Net) -> Checked {
        let get = move |url: &str, nonce: Option<&str>| -> Fetched {
            if url.ends_with("/_pm/where") {
                assert_eq!(nonce, Some(NONCE));
                worker.clone()
            } else if url == "https://phone.example.com/_pm/health" {
                assert_eq!(nonce, None, "nothing is sent to a name that has not proven itself");
                net.health.clone()
            } else if url == "https://phone.example.com/bridge/health" {
                Fetched { body: net.direct.body.replace("{PROOF}", &expected(nonce.unwrap())), ..net.direct.clone() }
            } else {
                assert!(url.starts_with(QUICK) && url.ends_with("/bridge/health"), "{url}");
                let n = nonce.unwrap();
                tunnel.clone().unwrap_or_else(|| ok(200, &format!(r#"{{"ok":true,"proof":"{}"}}"#, expected(n))))
            }
        };
        check_with("https://phone.example.com", quick.map(str::to_string), supported, &expected, NONCE, &hash(), &get)
    }
    fn reason(r: &Checked) -> &'static str {
        r.test.reason.unwrap()
    }

    #[test]
    fn a_pass_needs_the_workers_proof_the_right_address_and_the_proof_from_this_app() {
        let r = run(true, Some(QUICK), worker_says(200, Some(QUICK)), None);
        assert_eq!((reason(&r), r.verdict, r.test.ok, r.authentic), ("reached", Verdict::Pass, true, true));
    }

    #[test]
    fn a_foreign_server_that_echoes_our_address_is_not_the_worker() {
        // repeats the address and says ok, but has no proof: never passes, never counts as authentic
        for fake in [
            ok(200, &format!(r#"{{"ok":true,"url":"{QUICK}"}}"#)),
            ok(200, &format!(r#"{{"ok":true,"url":"{QUICK}","proof":"{}"}}"#, "0".repeat(64))),
            ok(200, &format!(r#"{{"ok":true,"url":"{QUICK}","proof":"{}"}}"#, where_proof("another-hash", NONCE))),
            ok(503, r#"{"ok":false}"#),
        ] {
            let r = run(true, Some(QUICK), fake.clone(), None);
            assert_eq!((reason(&r), r.verdict, r.authentic), ("no_worker", Verdict::Unreached, false), "{fake:?}");
        }
    }

    #[test]
    fn another_server_behind_the_worker_withdraws_the_pass_but_a_dead_tunnel_does_not() {
        let r = run(true, Some(QUICK), worker_says(200, Some(QUICK)), Some(ok(200, r#"{"ok":true,"proof":"someone-else"}"#)));
        assert_eq!((reason(&r), r.verdict, r.test.ok), ("not_this_pc", Verdict::NotThisPc, false));
        let r = run(true, Some(QUICK), worker_says(200, Some(QUICK)), Some(ok(200, r#"{"ok":true}"#)));
        assert_eq!(reason(&r), "not_this_pc", "a server that only says ok has no proof");
        for dead in [ok(530, ""), ok(404, "nope"), gone("timed out")] {
            let r = run(true, Some(QUICK), worker_says(200, Some(QUICK)), Some(dead));
            assert_eq!((reason(&r), r.verdict), ("tunnel_down", Verdict::Unreached));
        }
    }

    #[test]
    fn every_way_the_worker_can_be_wrong_has_its_own_flat_reason() {
        let cases: Vec<(Fetched, &str, bool)> = vec![
            (ok(404, "not found"), "no_worker", false),
            (ok(200, "<html>a web page</html>"), "no_worker", false),
            (worker_says(200, Some("https://evil.example.com")), "no_worker", false),
            (worker_says(503, None), "not_linked", true),
            (worker_says(200, Some("https://old-one-7.trycloudflare.com")), "stale", true),
            (ok(429, r#"{"ok":false}"#), "busy", false),
            (ok(429, "error code: 1027"), "over_quota", false),
            (ok(503, "error code: 1027"), "over_quota", false),
            (ok(522, "timeout"), "bad_gateway", false),
            (ok(503, "<html>Service Unavailable</html>"), "bad_gateway", false),
            (ok(302, ""), "redirect", false),
            (gone("dns error: failed to lookup address"), "dns", false),
            (gone("timed out reading response"), "timeout", false),
        ];
        for (worker, want, authentic) in cases {
            let r = run(true, Some(QUICK), worker.clone(), None);
            assert_eq!((reason(&r), r.verdict, r.test.ok, r.authentic), (want, Verdict::Unreached, false, authentic), "{worker:?}");
            assert!(!r.test.message.is_empty());
        }
    }

    fn book_health() -> Fetched {
        ok(200, r#"{"ok":true,"protocol":"pm-relay/1","worker":"pm-book/1","features":["stable-link"]}"#)
    }
    fn direct_proxy() -> Fetched {
        ok(200, r#"{"ok":true,"proof":"{PROOF}"}"#)
    }

    #[test]
    fn a_name_that_goes_straight_to_this_pc_is_direct_and_is_not_disarmed() {
        // what the founder has: the phone server answers every path with its page (so `where` is a 200 web page), and /bridge/health proves it
        let r = run_net(true, Some(QUICK), ok(200, "<html>phone page</html>"), None, Net { direct: direct_proxy(), ..Net::default() });
        assert_eq!((reason(&r), r.verdict, r.test.ok, r.authentic), ("is_direct", Verdict::Unreached, false, false));
        assert!(!should_disarm(&r), "a Direct name is left as it is");
        // a Direct answer carrying someone else's proof is just another website
        let r = run_net(true, Some(QUICK), ok(200, "<html>x</html>"), None, Net { direct: ok(200, r#"{"ok":true,"proof":"someone-else"}"#), ..Net::default() });
        assert_eq!(reason(&r), "no_worker");
        assert!(should_disarm(&r));
        // a Direct name that does not answer is not Direct
        let r = run_net(true, Some(QUICK), ok(200, "<html>x</html>"), None, Net { direct: gone("timed out"), ..Net::default() });
        assert_eq!(reason(&r), "no_worker");
    }

    #[test]
    fn an_address_book_with_another_key_or_no_settings_is_told_apart() {
        let wrong = ok(200, &format!(r#"{{"ok":true,"url":"{QUICK}","proof":"{}"}}"#, where_proof("another-hash", NONCE)));
        let wrong_503 = ok(503, &format!(r#"{{"ok":false,"proof":"{}"}}"#, where_proof("another-hash", NONCE)));
        let none = ok(503, r#"{"ok":false}"#);
        let none_200 = ok(200, r#"{"ok":true,"url":"https://x-1.trycloudflare.com"}"#);
        for (worker, want) in [(wrong, "other_key"), (wrong_503, "other_key"), (none, "unconfigured"), (none_200, "unconfigured")] {
            let r = run_net(true, Some(QUICK), worker.clone(), None, Net { health: book_health(), ..Net::default() });
            assert_eq!((reason(&r), r.verdict, r.authentic), (want, Verdict::Unreached, false), "{worker:?}");
            assert!(should_disarm(&r));
        }
        // a non-JSON answer stays a plain "not your Worker", even from a Worker's health
        let r = run_net(true, Some(QUICK), ok(200, "<html>page</html>"), None, Net { health: book_health(), ..Net::default() });
        assert_eq!(reason(&r), "no_worker");
        // the health answer must say exactly this Worker, whatever else it claims
        for health in [ok(200, r#"{"ok":true,"worker":"pm-relay/9"}"#), ok(200, "<html></html>"), ok(500, r#"{"worker":"pm-book/1"}"#)] {
            let r = run_net(true, Some(QUICK), ok(503, r#"{"ok":false}"#), None, Net { health, ..Net::default() });
            assert_eq!(reason(&r), "no_worker");
        }
    }

    #[test]
    fn a_real_pass_never_asks_the_health_or_direct_path() {
        let get = |url: &str, nonce: Option<&str>| -> Fetched {
            assert!(!url.starts_with("https://phone.example.com/_pm/health") && !url.starts_with("https://phone.example.com/bridge"), "{url}");
            if url.ends_with("/_pm/where") {
                worker_says(200, Some(QUICK))
            } else {
                ok(200, &format!(r#"{{"ok":true,"proof":"{}"}}"#, expected(nonce.unwrap())))
            }
        };
        let r = check_with("https://phone.example.com", Some(QUICK.into()), true, &expected, NONCE, &hash(), &get);
        assert_eq!(reason(&r), "reached");
        assert!(grants_pass(&r));
    }

    #[test]
    fn one_press_waits_for_a_just_armed_worker_to_be_told_and_ends_on_a_pass() {
        use std::cell::{Cell, RefCell};
        let told = Cell::new(false);
        let armed_calls = Cell::new(0);
        let sleeps = RefCell::new(Vec::new());
        let get = |url: &str, nonce: Option<&str>| -> Fetched {
            if url.ends_with("/_pm/where") {
                let proof = where_proof(&hash(), nonce.unwrap());
                if told.get() {
                    ok(200, &format!(r#"{{"ok":true,"url":"{QUICK}","proof":"{proof}"}}"#))
                } else {
                    ok(503, &format!(r#"{{"ok":false,"proof":"{proof}"}}"#))
                }
            } else {
                ok(200, &format!(r#"{{"ok":true,"proof":"{}"}}"#, expected(nonce.unwrap())))
            }
        };
        let sleep = |d: std::time::Duration| {
            sleeps.borrow_mut().push(d);
            // the registration loop tells the Worker after the second wait
            if sleeps.borrow().len() == 2 {
                told.set(true);
            }
        };
        let on_authentic = || armed_calls.set(armed_calls.get() + 1);
        let r = check_armed_with("https://phone.example.com", Some(QUICK.into()), true, &expected, &hash(), &get, &on_authentic, &sleep, SETTLE_BUDGET, SETTLE_STEP);
        assert_eq!((reason(&r), r.verdict), ("reached", Verdict::Pass));
        assert!(grants_pass(&r));
        assert_eq!(armed_calls.get(), 1, "armed once, on the first proof");
        assert_eq!(sleeps.borrow().len(), 2);

        // never linked: gives up after the budget with the honest reason, never a pass
        let waits = Cell::new(0);
        let never = |url: &str, nonce: Option<&str>| -> Fetched {
            assert!(url.ends_with("/_pm/where"), "{url}");
            ok(503, &format!(r#"{{"ok":false,"proof":"{}"}}"#, where_proof(&hash(), nonce.unwrap())))
        };
        let count = |_: std::time::Duration| waits.set(waits.get() + 1);
        let r = check_armed_with("https://phone.example.com", Some(QUICK.into()), true, &expected, &hash(), &never, &|| {}, &count, SETTLE_BUDGET, SETTLE_STEP);
        assert_eq!((reason(&r), r.verdict), ("not_linked", Verdict::Unreached));
        assert!(!grants_pass(&r));
        assert_eq!(waits.get(), 6, "12 s in steps of 2 s");
    }

    #[test]
    fn nothing_waits_and_nothing_is_armed_for_an_answer_that_is_not_the_worker() {
        let armed = std::cell::Cell::new(false);
        let get = |url: &str, _: Option<&str>| -> Fetched {
            if url.ends_with("/_pm/where") {
                ok(200, "<html>page</html>")
            } else {
                ok(404, "")
            }
        };
        let r = check_armed_with("https://phone.example.com", Some(QUICK.into()), true, &expected, &hash(), &get, &|| armed.set(true), &|_| panic!("must not wait"), SETTLE_BUDGET, SETTLE_STEP);
        assert_eq!(reason(&r), "no_worker");
        assert!(!armed.get(), "a name that did not prove itself is never armed");
    }

    #[test]
    fn a_pass_needs_the_proven_worker_and_this_apps_proof() {
        assert!(grants_pass(&run(true, Some(QUICK), worker_says(200, Some(QUICK)), None)));
        for worker in [worker_says(503, None), worker_says(200, Some("https://old-1.trycloudflare.com")), ok(200, "<html></html>")] {
            assert!(!grants_pass(&run(true, Some(QUICK), worker, None)));
        }
        assert!(!grants_pass(&run(true, Some(QUICK), worker_says(200, Some(QUICK)), Some(ok(530, "")))));
    }

    #[test]
    fn after_a_relink_the_pass_is_set_again_only_when_the_full_check_passes() {
        let marked = std::cell::Cell::new(0);
        let mark = || {
            marked.set(marked.get() + 1);
            Ok(())
        };
        let good = || Ok(run(true, Some(QUICK), worker_says(200, Some(QUICK)), None));
        assert!(restore_pass(&good, &mark));
        assert_eq!(marked.get(), 1);
        // every way of not passing leaves the pass unset
        let cases: Vec<Result<Checked, String>> = vec![
            Ok(run(true, Some(QUICK), worker_says(503, None), None)),
            Ok(run(true, Some(QUICK), worker_says(200, Some(QUICK)), Some(ok(530, "")))),
            Ok(run(true, Some(QUICK), worker_says(200, Some(QUICK)), Some(ok(200, r#"{"ok":true,"proof":"other"}"#)))),
            Ok(run(true, Some(QUICK), ok(200, "<html></html>"), None)),
            Err("no key".to_string()),
        ];
        for c in cases {
            assert!(!restore_pass(&|| c.clone(), &mark));
        }
        assert_eq!(marked.get(), 1, "nothing else was marked");
        // a refused mark (route or name changed meanwhile) is not a pass
        assert!(!restore_pass(&good, &|| Err("route changed".into())));
    }

    #[test]
    fn no_quick_tunnel_is_said_flatly_and_nothing_is_fetched() {
        let never = |_: &str, _: Option<&str>| -> Fetched { panic!("nothing may be fetched") };
        let r = check_with("https://phone.example.com", None, false, &expected, NONCE, &hash(), &never);
        assert_eq!((r.test.reason, r.verdict), (Some("no_quick_tunnel"), Verdict::Unreached));
        let r = check_with("https://phone.example.com", None, true, &expected, NONCE, &hash(), &never);
        assert_eq!((r.test.reason, r.verdict), (Some("no_address"), Verdict::Unreached));
    }

    #[test]
    fn every_reason_has_a_sentence_and_none_names_a_secret() {
        for reason in ["reached", "no_quick_tunnel", "no_address", "no_worker", "not_linked", "stale", "tunnel_down", "not_this_pc", "over_quota", "busy", "dns", "timeout", "bad_gateway", "redirect", "unreachable", "is_direct", "other_key", "unconfigured", "dns_taken", "zone_missing"] {
            let text = reason_message(reason);
            assert!(text.len() > 20 && !text.to_lowercase().contains("secret"), "{reason}");
        }
    }

    #[test]
    fn hmac_matches_the_published_test_vector() {
        // RFC 4231 test case 2
        assert_eq!(hmac_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn every_name_gets_its_own_key_and_the_hash_in_the_files_is_that_names_hash() {
        let a = name_key(MASTER, "https://phone.example.com");
        let b = name_key(MASTER, "https://other.example.com");
        assert_ne!(a, b);
        assert_ne!(a, MASTER);
        assert_eq!(a, name_key(MASTER, "https://PHONE.example.com/"), "the same name, however it is spelled");
        assert_ne!(a, name_key("another-master-another-master-0000", "https://phone.example.com"));
        assert_eq!(a.len(), 64);
        let files = files_for("https://phone.example.com", MASTER).unwrap();
        assert!(files.wrangler_toml.contains(&sha256_hex(&a)));
        assert!(!files.wrangler_toml.contains(&sha256_hex(&b)));
        assert!(!files.wrangler_toml.contains(&sha256_hex(MASTER)), "never the master's hash: it opens no Worker");
        for secret in [MASTER, a.as_str()] {
            assert!(!files.wrangler_toml.contains(secret) && !files.worker_js.contains(secret), "never a key itself");
        }
    }

    #[test]
    fn the_master_key_is_made_once_kept_private_and_the_files_carry_no_name_in_the_worker() {
        let d = std::env::temp_dir().join(format!("pm-domain-book-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let file = d.join("book.json");
        let a = secret_in(&file).unwrap();
        assert!(a.len() >= 32);
        assert_eq!(secret_in(&file).unwrap(), a, "the same key every time");
        let f = files_for("https://phone.example.com", &a).unwrap();
        assert_eq!(f.host, "phone.example.com");
        assert!(f.wrangler_toml.contains(r#"pattern = "phone.example.com""#));
        assert!(!f.worker_js.contains("phone.example.com"), "the Worker names no domain");
        assert!(!f.wrangler_toml.contains("{{"), "every placeholder is filled");
        assert!(f.worker_js.contains("export class Book") && f.worker_js.contains("/_pm/where"));
        assert!(files_for("https://phone.example.com:8443", &a).is_err());
        // a damaged file is replaced, not trusted
        std::fs::write(&file, "{\"secret\":\"short\"}").unwrap();
        assert_ne!(secret_in(&file).unwrap(), "short");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_name_is_sent_nothing_until_it_is_armed_and_arming_keeps_the_key() {
        let d = std::env::temp_dir().join(format!("pm-domain-book-armed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let file = d.join("book.json");
        let master = secret_in(&file).unwrap();
        assert!(!armed_in(&file, "https://phone.example.com"), "a new name is not armed");
        set_armed_in(&file, "https://phone.example.com", true).unwrap();
        assert!(armed_in(&file, "https://phone.example.com"));
        assert!(armed_in(&file, "https://PHONE.example.com/"));
        assert!(!armed_in(&file, "https://other.example.com"), "arming one name arms no other");
        assert_eq!(secret_in(&file).unwrap(), master, "arming never changes the key");
        set_armed_in(&file, "https://phone.example.com", false).unwrap();
        assert!(!armed_in(&file, "https://phone.example.com"));
        // a new master key forgets every armed name
        set_armed_in(&file, "https://phone.example.com", true).unwrap();
        std::fs::write(&file, "{\"secret\":\"short\"}").unwrap();
        let fresh = secret_in(&file).unwrap();
        assert_ne!(fresh, master);
        assert!(!armed_in(&file, "https://phone.example.com"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_periodic_look_tells_a_taken_over_or_reset_worker_from_a_busy_one() {
        let ours = Ok(());
        assert_eq!(monitor_decision(&ours, true), Monitor::Fine);
        // the right Worker, another address (taken over by another PC) or none (reset): tell it again
        assert_eq!(monitor_decision(&Err("stale"), true), Monitor::ReRegister);
        assert_eq!(monitor_decision(&Err("not_linked"), true), Monitor::ReRegister);
        // not the Worker any more: stop and forget
        assert_eq!(monitor_decision(&Err("no_worker"), false), Monitor::Foreign);
        // a bad minute changes nothing
        for why in ["dns", "timeout", "bad_gateway", "busy", "over_quota", "redirect"] {
            assert_eq!(monitor_decision(&Err(why), false), Monitor::Ignore, "{why}");
        }
        // the monitor reads the same judgement as the Check
        let j = judge_where(&worker_says(200, Some("https://someone-else-3.trycloudflare.com")), QUICK, NONCE, &hash());
        assert_eq!(monitor_decision(&j.0, j.1), Monitor::ReRegister);
        let j = judge_where(&worker_says(503, None), QUICK, NONCE, &hash());
        assert_eq!(monitor_decision(&j.0, j.1), Monitor::ReRegister);
        let j = judge_where(&ok(200, &format!(r#"{{"ok":true,"url":"{QUICK}"}}"#)), QUICK, NONCE, &hash());
        assert_eq!(monitor_decision(&j.0, j.1), Monitor::Foreign);
    }

    #[test]
    fn sha256_matches_a_known_value() {
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn the_direct_proof_alone_tells_a_direct_name_from_a_foreign_one() {
        let direct = |_: &str, nonce: Option<&str>| ok(200, &format!(r#"{{"ok":true,"proof":"{}"}}"#, expected(nonce.unwrap())));
        assert!(is_direct_with("https://phone.example.com", &expected, &direct));
        let foreign = |_: &str, _: Option<&str>| ok(200, "<html>my blog</html>");
        assert!(!is_direct_with("https://phone.example.com", &expected, &foreign));
        let wrong = |_: &str, _: Option<&str>| ok(200, r#"{"ok":true,"proof":"someone-else"}"#);
        assert!(!is_direct_with("https://phone.example.com", &expected, &wrong));
        let down = |_: &str, _: Option<&str>| Fetched { status: None, body: String::new(), transport: Some("dns".into()) };
        assert!(!is_direct_with("https://phone.example.com", &expected, &down));
    }
}
