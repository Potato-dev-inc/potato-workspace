//! "Update Worker" / "Set up my Worker" / "Set up stable link": the steps a person used to type in a terminal, run by
//! the app. The steps are fixed (the front end cannot name a program or an argument):
//!
//! 1. `prepare`: a working copy under the app's data folder (never the install folder) with the Worker the app ships
//!    (`resources/relay-worker`: one ES module + one wasm module + `manifest.json`), a `wrangler.toml` made from that
//!    manifest, and a `package.json`;
//! 2. `install`: wrangler, with the Node that ships with the app (`resources/node`), into the working copy;
//! 3. `login`: the Cloudflare sign-in in the browser (skipped when wrangler already has one);
//! 4. `deploy`: `wrangler deploy` of the shipped bundle (no bundling step, `--keep-vars`).
//!
//! The front end runs the steps, retries a failed one, and hands the job to an agent after three failures. Output is
//! shown behind "Details", so it is cleaned first: anything that looks like a token is hidden. Wrangler keeps the
//! Cloudflare sign-in in its own config file; this module never reads or stores it.

use super::relay_deploy::{load_bundle, Manifest};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

const KEEP_OUTPUT: usize = 6000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StepOut {
    pub ok: bool,
    /// What the step printed, cleaned and cut to the last part.
    pub output: String,
    /// The `https://<name>.<you>.workers.dev` address the deploy printed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn fail(output: impl Into<String>) -> StepOut {
    StepOut { ok: false, output: output.into(), url: None }
}
fn done(output: impl Into<String>) -> StepOut {
    StepOut { ok: true, output: output.into(), url: None }
}

pub struct Env {
    /// `resources/relay-worker`.
    pub bundle_dir: PathBuf,
    /// `resources/node` (node.exe and node_modules/npm).
    pub node_dir: PathBuf,
    /// The working copy, under the app data folder.
    pub work: PathBuf,
}

/// A Worker name Cloudflare accepts: lowercase letters, digits and dashes.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `(name, subdomain)` of exactly `https://<name>.<sub>.workers.dev` (no more, no fewer labels).
pub fn parts_from_address(address: &str) -> Option<(String, String)> {
    let rest = address.trim().strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let labels: Vec<&str> = host.strip_suffix(".workers.dev")?.split('.').collect();
    match labels.as_slice() {
        [name, sub] if valid_name(name) && valid_name(sub) => Some((name.to_string(), sub.to_string())),
        _ => None,
    }
}

/// The Worker's own name in a `https://<name>.<you>.workers.dev` address (an update goes to the same Worker).
pub fn name_from_address(address: &str) -> Option<String> {
    parts_from_address(address).map(|(name, _)| name)
}

/// `wrangler.toml` for the shipped bundle: the manifest's bindings and migrations, the bundle used as it is.
pub fn wrangler_toml(manifest: &Manifest, name: &str) -> String {
    let mut t = String::new();
    t.push_str("# Made by the app from the Worker it ships. Safe to delete.\n");
    t.push_str(&format!(
        "name = \"{name}\"\nmain = \"dist/{}\"\ncompatibility_date = \"{}\"\nno_bundle = true\nfind_additional_modules = true\n",
        manifest.main_module, manifest.compatibility_date
    ));
    for b in &manifest.bindings {
        t.push_str(&format!("\n[[durable_objects.bindings]]\nname = \"{}\"\nclass_name = \"{}\"\n", b.name, b.class_name));
    }
    for m in &manifest.migrations {
        let classes: Vec<String> = m.new_sqlite_classes.iter().map(|c| format!("\"{c}\"")).collect();
        t.push_str(&format!("\n[[migrations]]\ntag = \"{}\"\nnew_sqlite_classes = [{}]\n", m.tag, classes.join(", ")));
    }
    if manifest.observability {
        t.push_str("\n[observability]\nenabled = true\n");
    }
    t
}

/// Output for the "Details" box: long secret-looking words are hidden, and only the last part is kept.
pub fn scrub(text: &str) -> String {
    let mut out = String::new();
    for line in text.replace('\r', "").lines() {
        let words: Vec<String> = line
            .split(' ')
            .map(|w| {
                let bare = w.trim_matches(|c: char| !c.is_ascii_alphanumeric());
                let secretish = bare.len() >= 32 && !bare.contains("://") && bare.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
                if secretish {
                    "[hidden]".to_string()
                } else {
                    w.to_string()
                }
            })
            .collect();
        out.push_str(&words.join(" "));
        out.push('\n');
    }
    let out = out.trim().to_string();
    let chars: Vec<char> = out.chars().collect();
    if chars.len() > KEEP_OUTPUT {
        format!("...{}", chars[chars.len() - KEEP_OUTPUT..].iter().collect::<String>())
    } else {
        out
    }
}

/// The first `https://....workers.dev` address in `text`.
pub fn workers_dev_url(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '(' || c == ')')
        .map(|w| w.trim_end_matches(['.', ',', '/']))
        .find(|w| w.starts_with("https://") && w.ends_with(".workers.dev") && w.len() > "https://.workers.dev".len())
        .map(str::to_string)
}

fn plain(p: &Path) -> PathBuf {
    crate::mcp_runtime::without_verbatim_prefix(p)
}

/// The bundled npm: `<node dir>/node_modules/npm/bin/npm-cli.js`, run by our own node as ONE argument (never npm.cmd, never a shell).
fn npm_cli_js(env: &Env) -> PathBuf {
    plain(&env.node_dir).join("node_modules").join("npm").join("bin").join("npm-cli.js")
}

fn node_exe(env: &Env) -> PathBuf {
    let exe = plain(&env.node_dir).join(if cfg!(windows) { "node.exe" } else { "bin/node" });
    if exe.is_file() {
        exe
    } else {
        PathBuf::from("node")
    }
}

fn collect(stream: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = stream {
            let _ = r.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

struct Raw {
    ok: bool,
    timed_out: bool,
    stdout: String,
    /// Both streams, as printed (not cleaned: only for parsing in memory).
    text: String,
}

/// Runs `node <script> <args>` in the working copy and waits (bounded). Inherited `CLOUDFLARE_*` / `CF_*` variables
/// are dropped (a token or account id from the person's shell must not steer wrangler to another account); `account`
/// pins `CLOUDFLARE_ACCOUNT_ID` to the account the app verified.
fn run_raw(env: &Env, script: &Path, args: &[&str], limit: Duration, account: Option<&str>) -> Result<Raw, String> {
    let node = node_exe(env);
    let script = plain(script);
    let work = plain(&env.work);
    let mut cmd = crate::proc_util::hidden_command(&node);
    cmd.arg(&script).args(args).current_dir(&work).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Our Node first on PATH: wrangler's helpers and npm's install scripts start `node` by name.
    let mut paths = vec![node.parent().map(Path::to_path_buf).unwrap_or_default()];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
    for (key, _) in std::env::vars_os() {
        let Some(key) = key.to_str() else { continue };
        let upper = key.to_ascii_uppercase();
        if upper.starts_with("CLOUDFLARE_") || upper.starts_with("CF_") {
            cmd.env_remove(key);
        }
    }
    if let Some(id) = account {
        cmd.env("CLOUDFLARE_ACCOUNT_ID", id);
    }
    cmd.env("WRANGLER_SEND_METRICS", "false")
        .env("npm_config_audit", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_update_notifier", "false")
        .env("NO_COLOR", "1")
        .env_remove("CI");
    let mut child = cmd.spawn().map_err(|e| format!("The built-in Node could not start ({e})."))?;
    let out = collect(child.stdout.take());
    let err = collect(child.stderr.take());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break None,
        }
    };
    let stdout = out.join().unwrap_or_default();
    let text = format!("{stdout}\n{}", err.join().unwrap_or_default());
    Ok(Raw { ok: status.is_some_and(|s| s.success()), timed_out: status.is_none(), stdout, text })
}

fn run_node_as(env: &Env, script: &Path, args: &[&str], limit: Duration, account: Option<&str>) -> StepOut {
    match run_raw(env, script, args, limit, account) {
        Err(e) => fail(e),
        Ok(r) if r.ok => StepOut { ok: true, url: workers_dev_url(&r.text), output: scrub(&r.text) },
        Ok(r) if r.timed_out => fail(format!("{}\nThis took too long and was stopped.", scrub(&r.text))),
        Ok(r) => fail(scrub(&r.text)),
    }
}

fn run_node(env: &Env, script: &Path, args: &[&str], limit: Duration) -> StepOut {
    run_node_as(env, script, args, limit, None)
}

fn wrangler_js(env: &Env) -> PathBuf {
    plain(&env.work).join("node_modules").join("wrangler").join("bin").join("wrangler.js")
}

fn prepare(env: &Env, name: &str) -> StepOut {
    let bundle = match load_bundle(&env.bundle_dir) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    let dist = env.work.join("dist");
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dist)?;
        for (module, _, bytes) in &bundle.modules {
            std::fs::write(dist.join(module), bytes)?;
        }
        std::fs::write(env.work.join("wrangler.toml"), wrangler_toml(&bundle.manifest, name))?;
        std::fs::write(
            env.work.join("package.json"),
            "{\n  \"name\": \"potato-worker-update\",\n  \"private\": true,\n  \"devDependencies\": { \"wrangler\": \"^4.0.0\" }\n}\n",
        )?;
        Ok(())
    };
    match write() {
        Ok(()) => done("Worker files are ready."),
        Err(e) => fail(format!("Could not make the working copy: {e}")),
    }
}

/// Whether `name` may be deleted: the person confirmed, it is a valid Worker name AND the very Worker the saved stable
/// link points to. Gives that Worker's workers.dev subdomain, which the logged-in account must own.
pub fn may_delete(saved_worker_url: Option<&str>, name: &str, confirmed: bool) -> Result<String, &'static str> {
    if !confirmed {
        return Err("Nothing was deleted: the delete was not confirmed.");
    }
    if !valid_name(name) {
        return Err("That Worker name is not valid.");
    }
    match saved_worker_url.and_then(parts_from_address) {
        Some((saved, sub)) if saved == name => Ok(sub),
        _ => Err("That is not the Worker saved for your link, so nothing was deleted."),
    }
}

/// The account ids in `wrangler whoami --json`.
pub fn accounts_from_whoami(json: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).unwrap_or(serde_json::Value::Null);
    v["accounts"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x["id"].as_str()).filter(|id| id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The token in `wrangler auth token --json` (kept in memory only, never shown or logged).
fn token_from_output(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    v["token"].as_str().or_else(|| v["api_token"].as_str()).filter(|t| !t.is_empty()).map(str::to_string)
}

/// Which of the signed-in accounts owns the workers.dev subdomain of the saved link. Exactly one must; otherwise the
/// delete is refused. `subdomain_of(account_id)` asks Cloudflare (a fake in tests).
pub fn verified_account(accounts: &[String], expected_sub: &str, subdomain_of: impl Fn(&str) -> Option<String>) -> Result<String, &'static str> {
    if accounts.is_empty() {
        return Err("Could not tell which Cloudflare account you are signed in to, so nothing was deleted. Press Try again and sign in.");
    }
    let matching: Vec<&String> = accounts.iter().filter(|id| subdomain_of(id).is_some_and(|s| s.eq_ignore_ascii_case(expected_sub))).collect();
    match matching.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err("The Cloudflare account you are signed in to is not the one that owns this link, so nothing was deleted. Sign in with the right account and try again."),
        _ => Err("More than one signed-in account matches this link, so nothing was deleted."),
    }
}

/// Cloudflare's own "no such Worker" answer (error 10007 / script not found), not any other "not found".
pub fn worker_is_gone(output: &str) -> bool {
    let low = output.to_ascii_lowercase();
    ["10007", "script_not_found", "script not found", "worker not found", "this worker does not exist", "there is no worker named"].iter().any(|w| low.contains(w))
}

/// The wrangler arguments that delete exactly one Worker (its Durable Object storage goes with it).
pub fn delete_args(name: &str) -> Result<Vec<String>, &'static str> {
    if !valid_name(name) {
        return Err("That Worker name is not valid.");
    }
    Ok(["delete", "--name", name, "--config", "wrangler.toml", "--force"].iter().map(|s| s.to_string()).collect())
}

/// What a failed `wrangler delete` means, in plain words. `None`: the Worker is already gone, which is fine.
pub fn explain_delete(output: &str) -> Option<&'static str> {
    if worker_is_gone(output) {
        return None;
    }
    let low = output.to_ascii_lowercase();
    Some(if ["not logged in", "not authenticated", "authentication error", "10000", "login"].iter().any(|w| low.contains(w)) {
        "You are not signed in to Cloudflare. Press Try again and sign in when the browser page opens."
    } else if ["enotfound", "etimedout", "fetch failed", "econnreset", "network", "eai_again"].iter().any(|w| low.contains(w)) {
        "Could not reach Cloudflare. Check your internet connection, then press Try again."
    } else {
        "Cloudflare did not let the old Worker be deleted. Press Try again, or delete it in the Cloudflare dashboard and then set up again."
    })
}

/// The account a verified "start fresh" delete used: the deploy that follows goes to the same account.
static PINNED: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

fn pinned_account(name: &str) -> Option<String> {
    PINNED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(n, _)| n == name).map(|(_, id)| id.clone())
}

/// Asks Cloudflare which workers.dev subdomain an account has (the token stays in memory, never printed).
fn cloudflare_subdomain(token: &str, account: &str) -> Option<String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).redirects(0).user_agent("potato-workspace").build();
    let resp = agent.get(&format!("https://api.cloudflare.com/client/v4/accounts/{account}/workers/subdomain")).set("authorization", &format!("Bearer {token}")).call().ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    v["result"]["subdomain"].as_str().map(str::to_string)
}

const NOT_SURE_WHO: &str = "Could not tell which Cloudflare account you are signed in to, so nothing was deleted. Press Try again and sign in.";

/// The "start fresh" delete. Refuses unless the person confirmed, the name is the saved Worker's, and the account
/// wrangler is signed in to owns that Worker's workers.dev subdomain. Then deletes (and pins the account for the deploy).
pub fn delete_verified(
    env: &Env,
    name: &str,
    saved_worker_url: Option<&str>,
    confirmed: bool,
    subdomain_of: impl Fn(&str, &str) -> Option<String>,
) -> StepOut {
    let sub = match may_delete(saved_worker_url, name, confirmed) {
        Ok(sub) => sub,
        Err(e) => return fail(e),
    };
    let w = wrangler_js(env);
    let accounts = match run_raw(env, &w, &["whoami", "--json"], Duration::from_secs(60), None) {
        Ok(r) if r.ok => accounts_from_whoami(&r.stdout),
        _ => Vec::new(),
    };
    let token = match run_raw(env, &w, &["auth", "token", "--json"], Duration::from_secs(60), None) {
        Ok(r) if r.ok => token_from_output(&r.stdout),
        _ => None,
    };
    let Some(token) = token else { return fail(NOT_SURE_WHO) };
    let account = match verified_account(&accounts, &sub, |id| subdomain_of(&token, id)) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let args = match delete_args(name) {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_node_as(env, &w, &args, Duration::from_secs(120), Some(&account));
    if !out.ok {
        if let Some(words) = explain_delete(&out.output) {
            return fail(words);
        }
    }
    *PINNED.lock().unwrap_or_else(|e| e.into_inner()) = Some((name.to_string(), account));
    done(if out.ok { "The old Worker is deleted." } else { "The old Worker was already gone." })
}

/// Runs one step. `name` is the Worker's name (from its address, or the shipped default).
#[cfg(test)]
pub fn run_step(env: &Env, step: &str, name: &str) -> StepOut {
    run_step_with(env, step, name, &[])
}

/// [`run_step`] with settings the deploy adds to the Worker (`--var NAME:value`). Only the deploy step uses them.
pub fn run_step_with(env: &Env, step: &str, name: &str, vars: &[(&str, String)]) -> StepOut {
    if !valid_name(name) {
        return fail("That Worker name is not valid.");
    }
    match step {
        "prepare" => {
            // A new run starts: any account pinned by an earlier "start fresh" is forgotten.
            *PINNED.lock().unwrap_or_else(|e| e.into_inner()) = None;
            prepare(env, name)
        }
        "install" => {
            if !env.work.join("package.json").is_file() {
                return fail("The working copy is not ready.");
            }
            if wrangler_js(env).is_file() {
                return done("The tool is already here.");
            }
            let npm = npm_cli_js(env);
            if !npm.is_file() {
                return fail("The built-in npm is missing.");
            }
            run_node(env, &npm, &["install", "--no-audit", "--no-fund"], Duration::from_secs(600))
        }
        "login" => {
            let w = wrangler_js(env);
            let who = run_node(env, &w, &["whoami"], Duration::from_secs(60));
            if who.ok && who.output.contains("logged in") {
                return done("Already signed in to Cloudflare.");
            }
            run_node(env, &w, &["login"], Duration::from_secs(300))
        }
        "deploy" => {
            let mut args: Vec<String> = ["deploy", "--config", "wrangler.toml", "--keep-vars"].iter().map(|a| a.to_string()).collect();
            for (k, v) in vars {
                args.push("--var".into());
                args.push(format!("{k}:{v}"));
            }
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            let pinned = pinned_account(name);
            run_node_as(env, &wrangler_js(env), &refs, Duration::from_secs(300), pinned.as_deref())
        }
        _ => fail("Unknown step."),
    }
}

// ------------------------------------------------------------------------------------------- command

fn env_for(app: &tauri::AppHandle) -> Env {
    use tauri::Manager;
    let resource_dir = app.path().resource_dir().ok();
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from));
    let find = |rel: &str| {
        crate::mcp_runtime::installed_resource_dir(resource_dir.as_deref(), exe_dir.as_deref(), rel)
            .or_else(|| cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(rel)))
            .unwrap_or_default()
    };
    Env { bundle_dir: plain(&find("relay-worker")), node_dir: plain(&find("node")), work: plain(&crate::app_paths::app_data_dir()).join("worker-update") }
}

/// One step of "Update Worker". `address`: the Worker to update (its name is used); none: a new Worker with the shipped name.
#[tauri::command]
pub async fn worker_update_step(app: tauri::AppHandle, step: String, address: Option<String>, confirmed: Option<bool>) -> Result<StepOut, String> {
    let env = env_for(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let name = match address.as_deref().filter(|a| !a.trim().is_empty()) {
            Some(a) => name_from_address(a).ok_or("That address is not a workers.dev address.")?,
            None => load_bundle(&env.bundle_dir).map(|b| b.manifest.name).unwrap_or_else(|_| "pm-relay".into()),
        };
        if step == "delete" {
            let saved = crate::tunnel_config::load(&crate::tunnel_config::tunnel_file());
            let saved_url = match &saved {
                crate::tunnel_config::TunnelConfig::Stable { worker_url, .. } => Some(worker_url.as_str()),
                _ => None,
            };
            return Ok(delete_verified(&env, &name, saved_url, confirmed == Some(true), cloudflare_subdomain));
        }
        // Far-away PCs (Labs): the Worker is told the public key that may open pairing boxes. Never a secret.
        let vars: Vec<(&str, String)> = crate::device_link::app::pair_owner_id().map(|id| ("PAIR_OWNER", id)).into_iter().collect();
        Ok(run_step_with(&env, &step, &name, &vars))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("pm-wu-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn names_come_from_the_address() {
        assert_eq!(name_from_address("https://pm-relay.me.workers.dev/"), Some("pm-relay".into()));
        assert_eq!(name_from_address("https://potato-stable-link.you.workers.dev/x?y"), Some("potato-stable-link".into()));
        assert_eq!(name_from_address("https://evil.example.com"), None);
        assert_eq!(name_from_address("http://a.b.workers.dev"), None);
        assert!(!valid_name("-a") && !valid_name("A") && !valid_name("") && valid_name("a-1"));
    }

    /// The pinned account is process-wide: tests that touch it run one at a time.
    static PIN_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const SAVED: &str = "https://pm-relay.me.workers.dev";

    #[test]
    fn only_the_saved_confirmed_worker_can_be_deleted() {
        assert_eq!(may_delete(Some(SAVED), "pm-relay", true), Ok("me".to_string()));
        assert!(may_delete(Some(SAVED), "pm-relay", false).is_err(), "no delete without the confirm");
        assert!(may_delete(Some(SAVED), "other-worker", true).is_err());
        assert!(may_delete(None, "pm-relay", true).is_err());
        assert!(may_delete(Some("https://me.workers.dev"), "me", true).is_err());
        assert!(may_delete(Some("https://trycloudflare.example.com"), "pm-relay", true).is_err());
        for bad in ["Pm-Relay", "pm-relay; rm", ""] {
            assert!(may_delete(Some(SAVED), bad, true).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_address_needs_exactly_name_dot_sub_dot_workers_dev() {
        assert_eq!(parts_from_address(SAVED), Some(("pm-relay".into(), "me".into())));
        assert_eq!(name_from_address("https://me.workers.dev"), None);
        assert_eq!(name_from_address("https://a.b.c.workers.dev"), None);
        assert_eq!(name_from_address("https://.me.workers.dev"), None);
    }

    #[test]
    fn the_delete_command_names_one_worker_only() {
        let args = delete_args("pm-relay").unwrap();
        assert_eq!(args, ["delete", "--name", "pm-relay", "--config", "wrangler.toml", "--force"]);
        assert!(delete_args("../x").is_err() && delete_args("A").is_err() && delete_args("").is_err() && delete_args(&"a".repeat(64)).is_err());
    }

    #[test]
    fn only_cloudflares_no_such_worker_answer_counts_as_already_gone() {
        assert_eq!(explain_delete("A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]"), None);
        assert_eq!(explain_delete("Worker not found."), None);
        for other in ["Account not found", "Could not find config file: wrangler.toml not found", "node: command not found", "something odd"] {
            assert!(explain_delete(other).is_some(), "{other}");
        }
        assert!(explain_delete("You are not logged in").unwrap().contains("not signed in"));
        assert!(explain_delete("fetch failed: ENOTFOUND api.cloudflare.com").unwrap().contains("internet"));
    }

    #[test]
    fn the_account_must_own_the_saved_subdomain() {
        let a = "a".repeat(32);
        let b = "b".repeat(32);
        let ask = |mine: &'static str| move |id: &str| (id == "a".repeat(32)).then(|| mine.to_string());
        assert_eq!(verified_account(&[a.clone(), b.clone()], "me", ask("me")), Ok(a.clone()));
        assert!(verified_account(&[a.clone()], "me", ask("work")).is_err());
        assert!(verified_account(&[], "me", ask("me")).is_err());
        assert!(verified_account(&[a.clone(), a], "me", ask("me")).is_err(), "two matches are refused");
        assert_eq!(accounts_from_whoami(&format!(r#"{{"accounts":[{{"id":"{}","name":"x"}},{{"id":"nope"}}]}}"#, "c".repeat(32))), vec!["c".repeat(32)]);
        assert!(accounts_from_whoami("not json").is_empty());
    }

    /// A fake wrangler (a script run by the real node) records what it is asked and what account it is pinned to.
    fn fake_env(tag: &str, script: &str) -> Option<(Env, PathBuf)> {
        let real_node = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/node");
        if !real_node.join(if cfg!(windows) { "node.exe" } else { "bin/node" }).is_file() {
            return None;
        }
        let work = tmp(tag);
        let wr = work.join("node_modules/wrangler/bin");
        std::fs::create_dir_all(&wr).unwrap();
        std::fs::write(wr.join("wrangler.js"), script).unwrap();
        Some((Env { bundle_dir: PathBuf::new(), node_dir: real_node, work: work.clone() }, work))
    }

    fn whoami_script(delete_body: &str) -> String {
        let id = "d".repeat(32);
        format!(
            "const a=process.argv.slice(2);\
             if(a[0]==='whoami'){{console.log(JSON.stringify({{accounts:[{{id:'{id}',name:'x'}}]}}));}}\
             else if(a[0]==='auth'){{console.log(JSON.stringify({{token:'tok'}}));}}\
             else if(a[0]==='delete'){{require('fs').writeFileSync('deleted.txt', a.join('|')+'|acct='+process.env.CLOUDFLARE_ACCOUNT_ID+'|stale='+process.env.CLOUDFLARE_API_TOKEN);{delete_body}}}\
             else {{require('fs').writeFileSync('deployed.txt', String(process.env.CLOUDFLARE_ACCOUNT_ID));console.log('Deployed');}}"
        )
    }

    #[test]
    fn delete_runs_only_for_the_matching_account_and_pins_it_for_the_deploy() {
        let _g = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let Some((env, work)) = fake_env("del", &whoami_script("console.log('ok');")) else { return };
        std::env::set_var("CLOUDFLARE_API_TOKEN", "from-the-shell");
        let id = "d".repeat(32);
        // The account owns "me": deleted, with the account pinned and the shell's token removed.
        let out = delete_verified(&env, "pm-relay", Some(SAVED), true, |_, acct| (acct == id).then(|| "me".to_string()));
        assert!(out.ok && out.output.contains("deleted"), "{}", out.output);
        let seen = std::fs::read_to_string(work.join("deleted.txt")).unwrap();
        assert!(seen.starts_with("delete|--name|pm-relay|--config|wrangler.toml|--force"), "{seen}");
        assert!(seen.contains(&format!("acct={id}")) && seen.contains("stale=undefined"), "{seen}");
        // The deploy that follows is pinned to the same account.
        let dep = run_step(&env, "deploy", "pm-relay");
        assert!(dep.ok, "{}", dep.output);
        assert_eq!(std::fs::read_to_string(work.join("deployed.txt")).unwrap(), id);
        assert!(run_step(&env, "deploy", "other").ok);
        assert_eq!(std::fs::read_to_string(work.join("deployed.txt")).unwrap(), "undefined");
        std::env::remove_var("CLOUDFLARE_API_TOKEN");
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn delete_is_refused_for_another_account_unknown_account_or_no_confirm() {
        let Some((env, work)) = fake_env("del-no", &whoami_script("console.log('ok');")) else { return };
        let sub = |s: &'static str| move |_: &str, _: &str| Some(s.to_string());
        let other = delete_verified(&env, "pm-relay", Some(SAVED), true, sub("work-team"));
        assert!(!other.ok && other.output.contains("not the one that owns"), "{}", other.output);
        let unasked = delete_verified(&env, "pm-relay", Some(SAVED), false, sub("me"));
        assert!(!unasked.ok);
        assert!(!delete_verified(&env, "other-worker", Some(SAVED), true, sub("me")).ok);
        assert!(!delete_verified(&env, "pm-relay", None, true, sub("me")).ok);
        assert!(!work.join("deleted.txt").exists(), "nothing may be deleted in any refused case");
        let _ = std::fs::remove_dir_all(&work);
        // whoami failing: refuse, nothing deleted.
        let Some((env2, work2)) = fake_env("del-who", "if(process.argv[2]==='delete'){require('fs').writeFileSync('deleted.txt','x');} else {console.error('boom');process.exit(1);}") else { return };
        let failed = delete_verified(&env2, "pm-relay", Some(SAVED), true, sub("me"));
        assert!(!failed.ok && failed.output.contains("which Cloudflare account"), "{}", failed.output);
        assert!(!work2.join("deleted.txt").exists());
        let _ = std::fs::remove_dir_all(&work2);
    }

    #[test]
    fn a_missing_worker_counts_as_gone_but_a_login_problem_is_said() {
        let id = "d".repeat(32);
        let me = |_: &str, acct: &str| (acct == id).then(|| "me".to_string());
        let Some((env, work)) = fake_env("del-gone", &whoami_script("console.error('Worker not found [code: 10007]');process.exit(1);")) else { return };
        assert!(delete_verified(&env, "pm-relay", Some(SAVED), true, me).ok);
        let _ = std::fs::remove_dir_all(&work);
        let Some((env, work)) = fake_env("del-login", &whoami_script("console.error('You are not logged in');process.exit(1);")) else { return };
        assert!(delete_verified(&env, "pm-relay", Some(SAVED), true, me).output.contains("not signed in"));
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn output_is_cleaned_and_cut() {
        let token = "A".repeat(40);
        let cleaned = scrub(&format!("Token: {token} ok"));
        assert!(!cleaned.contains(&token) && cleaned.contains("[hidden]"));
        assert!(scrub(&"x ".repeat(20000)).chars().count() <= KEEP_OUTPUT + 3);
        assert_eq!(workers_dev_url("Deployed to https://pm-relay.me.workers.dev (1 sec)."), Some("https://pm-relay.me.workers.dev".into()));
        assert_eq!(workers_dev_url("nothing"), None);
    }

    #[test]
    fn prepare_makes_a_working_copy_from_the_shipped_bundle() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/relay-worker");
        if !bundle.join("manifest.json").is_file() {
            return;
        }
        let _g = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let work = tmp("prep");
        let env = Env { bundle_dir: bundle, node_dir: PathBuf::new(), work: work.clone() };
        let out = run_step(&env, "prepare", "my-worker");
        assert!(out.ok, "{}", out.output);
        let toml = std::fs::read_to_string(work.join("wrangler.toml")).unwrap();
        assert!(toml.contains("name = \"my-worker\"") && toml.contains("no_bundle = true") && toml.contains("main = \"dist/index.js\""));
        assert!(toml.contains("[[migrations]]") && toml.contains("durable_objects.bindings"));
        assert!(work.join("dist/index.js").is_file() && work.join("package.json").is_file());
        assert!(!run_step(&env, "nope", "my-worker").ok);
        assert!(!run_step(&env, "deploy", "Bad Name").ok);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn toml_keeps_the_workers_own_settings_out() {
        let m: Manifest = serde_json::from_str(
            r#"{"name":"pm-relay","main_module":"index.js","compatibility_date":"2025-09-01","modules":[],"bindings":[{"type":"durable_object_namespace","name":"TEAM","class_name":"Team"}],"migrations":[{"tag":"v1","new_sqlite_classes":["Team"]}],"observability":true}"#,
        )
        .unwrap();
        let t = wrangler_toml(&m, "pm-relay");
        assert!(!t.contains("[vars]") && t.contains("enabled = true") && t.contains("new_sqlite_classes = [\"Team\"]"));
    }

    #[test]
    fn verbatim_prefix_is_dropped() {
        use crate::mcp_runtime::without_verbatim_prefix as plain;
        assert_eq!(plain(Path::new(r"\\?\C:\Program Files\Potato Workspace\resources\node")), PathBuf::from(r"C:\Program Files\Potato Workspace\resources\node"));
        assert_eq!(plain(Path::new(r"\\?\UNC\host\share\x")), PathBuf::from(r"\\host\share\x"));
        assert_eq!(plain(Path::new(r"C:\plain\path")), PathBuf::from(r"C:\plain\path"));
    }

    /// The installed app lives in "C:\Program Files\..." and Tauri hands out its folders with the `\\?\` prefix. Our node must
    /// get the npm script as ONE plain argument and run in the working copy, whatever the spelling of the folders.
    #[test]
    fn npm_runs_from_a_folder_with_spaces_even_when_spelled_with_the_verbatim_prefix() {
        let real_node = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/node");
        let node_exe_src = real_node.join(if cfg!(windows) { "node.exe" } else { "bin/node" });
        if !node_exe_src.is_file() {
            return;
        }
        let top = tmp("sp ace");
        let root = top.join("Program Files").join("Potato Workspace");
        let node_dir = root.join("resources").join("node");
        let exe_dest = node_dir.join(if cfg!(windows) { "node.exe" } else { "bin/node" });
        std::fs::create_dir_all(exe_dest.parent().unwrap()).unwrap();
        std::fs::copy(&node_exe_src, &exe_dest).unwrap();
        let bin = node_dir.join("node_modules").join("npm").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("npm-cli.js"), "console.log('ARGV1=' + process.argv[1]); console.log('CWD=' + process.cwd()); console.log('ARGS=' + process.argv.slice(2).join('|'));").unwrap();
        let work = root.join("app data").join("worker-update");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("package.json"), "{}").unwrap();
        let mut spellings = vec![(node_dir.clone(), work.clone())];
        if cfg!(windows) {
            let verbatim = |p: &Path| PathBuf::from(format!(r"\\?\{}", p.display()));
            spellings.push((verbatim(&node_dir), verbatim(&work)));
        }
        for (nd, w) in spellings {
            let env = Env { bundle_dir: PathBuf::new(), node_dir: nd, work: w };
            let npm = npm_cli_js(&env);
            let out = run_node(&env, &npm, &["install", "--no-audit", "--no-fund"], Duration::from_secs(60));
            assert!(out.ok, "{}", out.output);
            assert!(out.output.contains("npm-cli.js") && !out.output.contains(r"\\?\"), "{}", out.output);
            assert!(out.output.contains("Program Files") && out.output.contains("ARGS=install|--no-audit|--no-fund"), "{}", out.output);
            assert!(out.output.contains("app data"), "{}", out.output);
        }
        let _ = std::fs::remove_dir_all(&top);
    }
}
