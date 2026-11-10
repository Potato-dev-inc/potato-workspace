//! "Create team relay": puts the bundled relay Worker (relay/worker, built by
//! relay/worker/scripts/bundle-for-app.mjs into `resources/relay-worker/`) into the person's own Cloudflare
//! account through the Cloudflare API, so nobody needs Node or wrangler. The steps, each a progress event:
//!
//! 1. `GET /accounts`: the token works and which accounts it sees (more than one: the person picks);
//! 2. `GET /accounts/{a}/workers/services/pm-relay`: the deployed migration tag, if any (what wrangler reads),
//!    then `PUT /accounts/{a}/workers/scripts/pm-relay` (multipart: metadata + the JS module + the wasm module);
//! 3. `GET /accounts/{a}/workers/subdomain`, then `POST /accounts/{a}/workers/scripts/pm-relay/subdomain`
//!    `{"enabled":true}`: the relay answers on `https://pm-relay.<subdomain>.workers.dev`;
//! 4. `GET <url>/v1/health` until it answers (about 30 s at most).
//!
//! Running it again is safe: the upload replaces the script and migrations are sent only from the deployed tag on
//! (the same rule as wrangler, so a later `npm run deploy` in relay/worker carries on from here).
//!
//! The token is never logged, never stored, never put in an error, and is wiped when the deploy ends.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

const API: &str = "https://api.cloudflare.com/client/v4";
const MAX_ANSWER_BYTES: u64 = 1024 * 1024;
const HEALTH_DEADLINE: Duration = Duration::from_secs(30);

/// Where the Cloudflare credential comes from. Only a pasted API token for now.
pub enum CloudflareAuth {
    /// An API token the person made (the "Edit Cloudflare Workers" template) and pasted.
    ApiToken(String),
    // TODO(oauth): `OAuth { access_token }` from "Connect Cloudflare" (our registered OAuth client, PKCE, a
    // 127.0.0.1 callback). Not built until the client is confirmed; the deploy below only needs `bearer()`.
}

impl CloudflareAuth {
    fn bearer(&self) -> &str {
        match self {
            CloudflareAuth::ApiToken(token) => token.trim(),
        }
    }
}

impl Drop for CloudflareAuth {
    fn drop(&mut self) {
        let CloudflareAuth::ApiToken(token) = self;
        let mut bytes = std::mem::take(token).into_bytes();
        bytes.fill(0);
        std::hint::black_box(&bytes);
    }
}

impl std::fmt::Debug for CloudflareAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CloudflareAuth(..)")
    }
}

// ------------------------------------------------------------------------------------------- the bundle

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub name: String,
    pub main_module: String,
    pub compatibility_date: String,
    pub modules: Vec<ModuleSpec>,
    pub bindings: Vec<Binding>,
    pub migrations: Vec<Migration>,
    #[serde(default)]
    pub observability: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModuleSpec {
    pub name: String,
    pub file: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub class_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Migration {
    pub tag: String,
    #[serde(default)]
    pub new_sqlite_classes: Vec<String>,
}

pub struct Bundle {
    pub manifest: Manifest,
    /// (name, content type, bytes), in the manifest's order.
    pub modules: Vec<(String, String, Vec<u8>)>,
}

const NO_BUNDLE: &str = "This copy of the app doesn't include the relay. Reinstall it, or host the relay yourself.";

/// Reads `manifest.json` and the module files it lists from `dir`.
pub fn load_bundle(dir: &Path) -> Result<Bundle, String> {
    let text = std::fs::read(dir.join("manifest.json")).map_err(|_| NO_BUNDLE.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&text).map_err(|_| NO_BUNDLE.to_string())?;
    let mut modules = Vec::new();
    for m in &manifest.modules {
        if m.file.contains(['/', '\\']) || m.file.contains("..") {
            return Err(NO_BUNDLE.into());
        }
        let bytes = std::fs::read(dir.join(&m.file)).map_err(|_| NO_BUNDLE.to_string())?;
        modules.push((m.name.clone(), m.content_type.clone(), bytes));
    }
    if !manifest.modules.iter().any(|m| m.name == manifest.main_module) {
        return Err(NO_BUNDLE.into());
    }
    Ok(Bundle { manifest, modules })
}

// ------------------------------------------------------------------------------------------- pure parts

/// What to send as `migrations` given the tag Cloudflare has for the script (wrangler's rule): everything on a new
/// script, the steps after the deployed tag otherwise, nothing when it is up to date. The new tag is always the last
/// tag in wrangler.toml, so a later `wrangler deploy` sees its own history.
pub fn migrations_for(wanted: &[Migration], deployed: Option<&str>) -> Result<Option<Value>, String> {
    let Some(last) = wanted.last() else { return Ok(None) };
    let steps = |from: usize| -> Vec<Value> { wanted[from..].iter().map(|m| json!({ "new_sqlite_classes": m.new_sqlite_classes })).collect() };
    match deployed {
        None => Ok(Some(json!({ "new_tag": last.tag, "steps": steps(0) }))),
        Some(tag) if tag == last.tag => Ok(None),
        Some(tag) => match wanted.iter().position(|m| m.tag == tag) {
            Some(at) => Ok(Some(json!({ "old_tag": tag, "new_tag": last.tag, "steps": steps(at + 1) }))),
            None => Err(
                "Your Cloudflare account already has a Worker named pm-relay that this app didn't make. Rename or delete it in the Cloudflare dashboard, then try again."
                    .into(),
            ),
        },
    }
}

/// The `metadata` part of the upload.
pub fn metadata(manifest: &Manifest, migrations: Option<Value>) -> Value {
    let mut meta = json!({
        "main_module": manifest.main_module,
        "compatibility_date": manifest.compatibility_date,
        "bindings": manifest.bindings,
    });
    if let Some(m) = migrations {
        meta["migrations"] = m;
    }
    if manifest.observability {
        meta["observability"] = json!({ "enabled": true });
    }
    meta
}

/// A `multipart/form-data` body: the metadata field, then one file part per module (named as the code imports it).
pub fn multipart(boundary: &str, metadata: &Value, modules: &[(String, String, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n").as_bytes());
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(b"\r\n");
    for (name, content_type, bytes) in modules {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}\"\r\nContent-Type: {content_type}\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// A boundary that appears in none of the modules.
fn boundary_for(modules: &[(String, String, Vec<u8>)]) -> String {
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (0u32..)
        .map(|n| format!("pm-relay-{seed:x}-{n}"))
        .find(|b| !modules.iter().any(|(_, _, bytes)| bytes.windows(b.len()).any(|w| w == b.as_bytes())))
        .unwrap_or_default()
}

/// `https://<script>.<subdomain>.workers.dev`, or None when the subdomain isn't a plain DNS label.
pub fn relay_url(script: &str, subdomain: &str) -> Option<String> {
    let sub = subdomain.trim().trim_end_matches(".workers.dev").to_ascii_lowercase();
    let label = |s: &str| !s.is_empty() && s.len() <= 63 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !s.starts_with('-') && !s.ends_with('-');
    (label(&sub) && label(script)).then(|| format!("https://{script}.{sub}.workers.dev"))
}

/// The deploy steps, in order, as the progress events name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Token,
    Upload,
    Subdomain,
    Health,
    Done,
}

pub const BAD_TOKEN: &str = "Cloudflare didn't accept that token. Copy it again and paste all of it.";
pub const NO_PERMISSION: &str = "That token can't edit Workers. Make one with the \"Edit Cloudflare Workers\" template.";
pub const RATE_LIMITED: &str = "Cloudflare asks to slow down. Try again in a minute.";
pub const QUOTA: &str = "This Cloudflare account has hit a Workers limit. Remove a Worker you don't use or change the plan, then try again.";
pub const CLOUDFLARE_DOWN: &str = "Cloudflare had a problem. Try again in a minute.";
pub const OFFLINE: &str = "Couldn't reach Cloudflare. Check your internet connection.";
pub const NOT_ANSWERING: &str = "The relay is deployed but isn't answering yet. New workers.dev addresses can take a few minutes; press Retry in a bit.";

/// Cloudflare's `errors: [{code, message}]`.
fn cf_errors(body: &[u8]) -> Vec<(i64, String)> {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    parsed["errors"]
        .as_array()
        .map(|list| list.iter().map(|e| (e["code"].as_i64().unwrap_or(0), e["message"].as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default()
}

/// A failed Cloudflare API answer in plain words. On the first call (`Step::Token`) any refusal means the token.
pub fn explain(step: Step, status: u16, body: &[u8]) -> String {
    let errors = cf_errors(body);
    let has = |codes: &[i64]| errors.iter().any(|(c, _)| codes.contains(c));
    let says = |words: &[&str]| errors.iter().any(|(_, m)| words.iter().any(|w| m.to_ascii_lowercase().contains(w)));
    if status == 429 {
        return RATE_LIMITED.into();
    }
    if status >= 500 {
        return CLOUDFLARE_DOWN.into();
    }
    if status == 401 || has(&[9106, 9109, 6003, 6111, 1000]) || (step == Step::Token && matches!(status, 400 | 403)) {
        return BAD_TOKEN.into();
    }
    if status == 403 || has(&[10000]) {
        return NO_PERMISSION.into();
    }
    if says(&["exceeded", "limit", "quota"]) {
        return QUOTA.into();
    }
    match errors.iter().find(|(_, m)| !m.is_empty()) {
        Some((_, message)) => {
            let short: String = message.chars().take(160).collect();
            format!("Cloudflare refused it: {short}")
        }
        None => format!("Cloudflare refused it (error {status})."),
    }
}

// ------------------------------------------------------------------------------------------- the calls

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Account {
    pub id: String,
    pub name: String,
}

/// What a deploy ends with: the account to pick (the token sees more than one), or the relay's address.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    PickAccount { accounts: Vec<Account> },
    Done { url: String },
}

struct Api<'a> {
    auth: &'a CloudflareAuth,
    agent: ureq::Agent,
}

impl Api<'_> {
    fn call(&self, step: Step, method: &str, path: &str, body: Option<(&str, &[u8])>) -> Result<Value, String> {
        let req = self.agent.request(method, &format!("{API}{path}")).set("authorization", &format!("Bearer {}", self.auth.bearer()));
        let sent = match body {
            Some((content_type, bytes)) => req.set("content-type", content_type).send_bytes(bytes),
            None => req.call(),
        };
        match sent {
            Ok(resp) => {
                let mut bytes = Vec::new();
                resp.into_reader().take(MAX_ANSWER_BYTES).read_to_end(&mut bytes).map_err(|_| OFFLINE.to_string())?;
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| CLOUDFLARE_DOWN.to_string())?;
                Ok(value["result"].clone())
            }
            Err(ureq::Error::Status(code, resp)) => {
                let mut bytes = Vec::new();
                let _ = resp.into_reader().take(MAX_ANSWER_BYTES).read_to_end(&mut bytes);
                Err(CallError { code, body: bytes }.into_text(step))
            }
            // The transport text is never shown: it can name the URL.
            Err(ureq::Error::Transport(_)) => Err(OFFLINE.into()),
        }
    }

    /// Like `call`, but a "not found" answer is `Ok(None)`.
    fn get_optional(&self, step: Step, path: &str, not_found: &[i64]) -> Result<Option<Value>, String> {
        let req = self.agent.get(&format!("{API}{path}")).set("authorization", &format!("Bearer {}", self.auth.bearer()));
        match req.call() {
            Ok(resp) => {
                let mut bytes = Vec::new();
                resp.into_reader().take(MAX_ANSWER_BYTES).read_to_end(&mut bytes).map_err(|_| OFFLINE.to_string())?;
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| CLOUDFLARE_DOWN.to_string())?;
                Ok(Some(value["result"].clone()))
            }
            Err(ureq::Error::Status(code, resp)) => {
                let mut bytes = Vec::new();
                let _ = resp.into_reader().take(MAX_ANSWER_BYTES).read_to_end(&mut bytes);
                if code == 404 || cf_errors(&bytes).iter().any(|(c, _)| not_found.contains(c)) {
                    return Ok(None);
                }
                Err(CallError { code, body: bytes }.into_text(step))
            }
            Err(ureq::Error::Transport(_)) => Err(OFFLINE.into()),
        }
    }
}

struct CallError {
    code: u16,
    body: Vec<u8>,
}

impl CallError {
    fn into_text(self, step: Step) -> String {
        explain(step, self.code, &self.body)
    }
}

/// Runs the whole deploy. `account` picks one when the token sees several; `progress` hears each step as it starts.
pub fn deploy(auth: CloudflareAuth, account: Option<String>, bundle: &Bundle, mut progress: impl FnMut(Step)) -> Result<Outcome, String> {
    if auth.bearer().is_empty() {
        return Err("Paste a Cloudflare token first.".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        // A redirect would carry the token somewhere else.
        .redirects(0)
        .user_agent("potato-workspace")
        .build();
    let api = Api { auth: &auth, agent };
    let script = bundle.manifest.name.as_str();

    progress(Step::Token);
    let listed = api.call(Step::Token, "GET", "/accounts?per_page=50", None)?;
    let accounts: Vec<Account> = serde_json::from_value(listed).map_err(|_| CLOUDFLARE_DOWN.to_string())?;
    let account = match (account, accounts.len()) {
        (_, 0) => return Err("That token can't see any Cloudflare account. Make one with the \"Edit Cloudflare Workers\" template.".into()),
        (Some(id), _) => accounts.iter().find(|a| a.id == id).cloned().ok_or("That token can't see the account you picked.")?,
        (None, 1) => accounts[0].clone(),
        (None, _) => return Ok(Outcome::PickAccount { accounts }),
    };
    let base = format!("/accounts/{}/workers", account.id);

    progress(Step::Upload);
    // The deployed migration tag, where wrangler reads it. 10007 / 10090: no such Worker yet.
    let existing = api.get_optional(Step::Upload, &format!("{base}/services/{script}"), &[10007, 10090, 10092])?;
    let tag = existing.as_ref().and_then(|v| v["default_environment"]["script"]["migration_tag"].as_str()).filter(|t| !t.is_empty());
    let meta = metadata(&bundle.manifest, migrations_for(&bundle.manifest.migrations, tag)?);
    let boundary = boundary_for(&bundle.modules);
    let body = multipart(&boundary, &meta, &bundle.modules);
    let content_type = format!("multipart/form-data; boundary={boundary}");
    api.call(Step::Upload, "PUT", &format!("{base}/scripts/{script}"), Some((content_type.as_str(), body.as_slice())))?;

    progress(Step::Subdomain);
    let onboarding = format!(
        "Your Cloudflare account has no workers.dev address yet. Open dash.cloudflare.com/{}/workers/onboarding once to pick one, then press Retry.",
        account.id
    );
    let sub = api.get_optional(Step::Subdomain, &format!("{base}/subdomain"), &[10007])?;
    let sub = sub.as_ref().and_then(|v| v["subdomain"].as_str()).unwrap_or("");
    if sub.is_empty() {
        return Err(onboarding);
    }
    let url = relay_url(script, sub).ok_or(CLOUDFLARE_DOWN)?;
    api.call(Step::Subdomain, "POST", &format!("{base}/scripts/{script}/subdomain"), Some(("application/json", br#"{"enabled":true}"#.as_slice())))?;

    progress(Step::Health);
    let health = ureq::AgentBuilder::new().timeout(Duration::from_secs(5)).redirects(0).build();
    let started = Instant::now();
    let mut wait = 1;
    loop {
        if let Ok(resp) = health.get(&format!("{url}/v1/health")).call() {
            let answer: Value = resp.into_json().unwrap_or(Value::Null);
            if answer["ok"] == Value::Bool(true) {
                break;
            }
        }
        if started.elapsed() >= HEALTH_DEADLINE {
            return Err(NOT_ANSWERING.into());
        }
        std::thread::sleep(Duration::from_secs(wait));
        wait = (wait + 1).min(5);
    }
    progress(Step::Done);
    Ok(Outcome::Done { url })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        serde_json::from_value(json!({
            "format": 1,
            "name": "pm-relay",
            "main_module": "index.js",
            "compatibility_date": "2025-09-01",
            "modules": [
                { "name": "index.js", "file": "index.js", "content_type": "application/javascript+module" },
                { "name": "pm_relay_wasm_bg.wasm", "file": "pm_relay_wasm_bg.wasm", "content_type": "application/wasm" }
            ],
            "bindings": [
                { "type": "durable_object_namespace", "name": "TEAM", "class_name": "Team" },
                { "type": "durable_object_namespace", "name": "GATE", "class_name": "IpGate" },
                { "type": "durable_object_namespace", "name": "ROOM", "class_name": "Room" },
                { "type": "durable_object_namespace", "name": "ROOM_INDEX", "class_name": "RoomIndex" }
            ],
            "migrations": [
                { "tag": "v1", "new_sqlite_classes": ["Team", "IpGate"] },
                { "tag": "v2", "new_sqlite_classes": ["Room", "RoomIndex"] }
            ],
            "observability": true
        }))
        .unwrap()
    }

    #[test]
    fn a_new_script_gets_every_migration_under_the_last_tag() {
        let m = migrations_for(&manifest().migrations, None).unwrap().unwrap();
        assert_eq!(
            m,
            json!({ "new_tag": "v2", "steps": [{ "new_sqlite_classes": ["Team", "IpGate"] }, { "new_sqlite_classes": ["Room", "RoomIndex"] }] })
        );
        assert!(m.get("old_tag").is_none());
    }

    #[test]
    fn an_up_to_date_script_gets_no_migration_and_an_older_one_only_the_rest() {
        let wanted = manifest().migrations;
        assert_eq!(migrations_for(&wanted, Some("v2")).unwrap(), None);
        assert_eq!(
            migrations_for(&wanted, Some("v1")).unwrap().unwrap(),
            json!({ "old_tag": "v1", "new_tag": "v2", "steps": [{ "new_sqlite_classes": ["Room", "RoomIndex"] }] })
        );
        assert!(migrations_for(&wanted, Some("v9")).unwrap_err().contains("didn't make"));
        assert_eq!(migrations_for(&[], None).unwrap(), None);
    }

    #[test]
    fn metadata_carries_the_bindings_date_and_observability() {
        let meta = metadata(&manifest(), migrations_for(&manifest().migrations, None).unwrap());
        assert_eq!(meta["main_module"], "index.js");
        assert_eq!(meta["compatibility_date"], "2025-09-01");
        assert_eq!(meta["observability"], json!({ "enabled": true }));
        let bindings = meta["bindings"].as_array().unwrap();
        assert_eq!(bindings.len(), 4);
        assert_eq!(bindings[3], json!({ "type": "durable_object_namespace", "name": "ROOM_INDEX", "class_name": "RoomIndex" }));
        assert_eq!(meta["migrations"]["new_tag"], "v2");
        assert!(metadata(&manifest(), None).get("migrations").is_none());
    }

    #[test]
    fn the_multipart_body_has_the_metadata_and_each_module_with_its_type() {
        let modules = vec![
            ("index.js".to_string(), "application/javascript+module".to_string(), b"export default {}".to_vec()),
            ("pm_relay_wasm_bg.wasm".to_string(), "application/wasm".to_string(), vec![0, 97, 115, 109]),
        ];
        let boundary = boundary_for(&modules);
        let body = multipart(&boundary, &json!({ "main_module": "index.js" }), &modules);
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n")));
        assert!(text.contains("{\"main_module\":\"index.js\"}"));
        assert!(text.contains("name=\"index.js\"; filename=\"index.js\"\r\nContent-Type: application/javascript+module\r\n\r\nexport default {}\r\n"));
        assert!(text.contains("name=\"pm_relay_wasm_bg.wasm\"; filename=\"pm_relay_wasm_bg.wasm\"\r\nContent-Type: application/wasm\r\n\r\n"));
        assert!(body.windows(4).any(|w| w == [0, 97, 115, 109]));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
        assert_eq!(text.matches(&format!("--{boundary}\r\n")).count(), 3);
    }

    #[test]
    fn the_boundary_never_appears_in_a_module() {
        let b = boundary_for(&[]);
        let modules = vec![("a".to_string(), "x".to_string(), b.as_bytes().to_vec())];
        assert_ne!(boundary_for(&modules), b);
    }

    #[test]
    fn the_relay_url_is_the_workers_dev_name() {
        assert_eq!(relay_url("pm-relay", "maya").as_deref(), Some("https://pm-relay.maya.workers.dev"));
        assert_eq!(relay_url("pm-relay", "Maya-Dev.workers.dev").as_deref(), Some("https://pm-relay.maya-dev.workers.dev"));
        assert_eq!(relay_url("pm-relay", ""), None);
        assert_eq!(relay_url("pm-relay", "evil.com/x"), None);
        assert_eq!(relay_url("pm-relay", "-a"), None);
    }

    #[test]
    fn cloudflare_errors_read_as_plain_words() {
        let err = |code: i64, msg: &str| json!({ "success": false, "errors": [{ "code": code, "message": msg }] }).to_string().into_bytes();
        assert_eq!(explain(Step::Token, 400, &err(6003, "Invalid request headers")), BAD_TOKEN);
        assert_eq!(explain(Step::Token, 403, &err(10000, "Authentication error")), BAD_TOKEN);
        assert_eq!(explain(Step::Upload, 401, b""), BAD_TOKEN);
        assert_eq!(explain(Step::Upload, 403, &err(10000, "Authentication error")), NO_PERMISSION);
        assert_eq!(explain(Step::Upload, 429, b""), RATE_LIMITED);
        assert_eq!(explain(Step::Upload, 400, &err(10037, "You have exceeded the limit of 100 scripts")), QUOTA);
        assert_eq!(explain(Step::Subdomain, 502, b"<html>"), CLOUDFLARE_DOWN);
        assert_eq!(explain(Step::Upload, 400, &err(10021, "Uncaught SyntaxError")), "Cloudflare refused it: Uncaught SyntaxError");
        assert_eq!(explain(Step::Upload, 409, b"not json"), "Cloudflare refused it (error 409).");
    }

    #[test]
    fn the_token_is_never_printed() {
        let auth = CloudflareAuth::ApiToken(" secret-token \n".into());
        assert_eq!(auth.bearer(), "secret-token");
        assert!(!format!("{auth:?}").contains("secret"));
    }

    #[test]
    fn the_bundle_the_build_makes_loads() {
        // Only when the bundle was built (relay/worker/scripts/bundle-for-app.mjs); a fresh clone has none.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/relay-worker");
        if !dir.join("manifest.json").is_file() {
            return;
        }
        let bundle = load_bundle(&dir).unwrap();
        assert_eq!(bundle.manifest.name, "pm-relay");
        assert_eq!(bundle.manifest.migrations.last().unwrap().tag, "v2");
        assert!(bundle.modules.iter().any(|(n, t, b)| n == "pm_relay_wasm_bg.wasm" && t == "application/wasm" && b.starts_with(b"\0asm")));
        assert!(load_bundle(&dir.join("nope")).is_err());
    }
}
