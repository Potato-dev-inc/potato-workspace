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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const KEEP_OUTPUT: usize = 6000;

/// One setup step runs at a time in the whole app: a second one (a second window, a second press) is refused while a
/// tool process of the first is still going. `prepare` of a new run is a step like any other, so it is refused too.
static BUSY: AtomicBool = AtomicBool::new(false);
/// The cancel flag of the step that holds `BUSY`. "Cancel" sets it; only that step's own thread reads it (see `run_raw`).
static CANCEL: std::sync::Mutex<Option<Arc<AtomicBool>>> = std::sync::Mutex::new(None);

thread_local! {
    /// The flag of the step running on THIS thread (none outside `exclusive`).
    static MY_CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> = const { std::cell::RefCell::new(None) };
}

const BUSY_MESSAGE: &str = "Another setup is still running. Wait for it to stop, then try again.";

/// Runs `step` as the only running setup step, or says another one is still running.
pub fn exclusive(step: impl FnOnce() -> StepOut) -> StepOut {
    if BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return fail(BUSY_MESSAGE);
    }
    let flag = Arc::new(AtomicBool::new(false));
    *CANCEL.lock().unwrap_or_else(|e| e.into_inner()) = Some(flag.clone());
    MY_CANCEL.with(|m| *m.borrow_mut() = Some(flag));
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            MY_CANCEL.with(|m| *m.borrow_mut() = None);
            *CANCEL.lock().unwrap_or_else(|e| e.into_inner()) = None;
            BUSY.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    step()
}

/// Asks the running step (if any) to stop. Only the tool process that step started is killed.
pub fn request_cancel() -> bool {
    match CANCEL.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StepOut {
    pub ok: bool,
    /// What the step printed, cleaned and cut to the last part.
    pub output: String,
    /// The `https://<name>.<you>.workers.dev` address the deploy printed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// `look` only: a relay with this name already exists in the account and this PC does not hold its key.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub taken: bool,
}

fn fail(output: impl Into<String>) -> StepOut {
    StepOut { ok: false, output: output.into(), url: None, taken: false }
}
fn done(output: impl Into<String>) -> StepOut {
    StepOut { ok: true, output: output.into(), url: None, taken: false }
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

/// The first address in `text` that is EXACTLY `https://<name>.<you>.workers.dev` (no path, no extra labels, no other
/// host), in its lower-case form. `name`: when given, only that Worker's address counts.
pub fn workers_dev_url_for(text: &str, name: Option<&str>) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '(' || c == ')')
        .map(|w| w.trim_end_matches(['.', ',', '/']))
        .filter(|w| !w.contains(['/', '?', '#']) || w.strip_prefix("https://").is_some_and(|r| !r.contains(['/', '?', '#'])))
        .find_map(|w| {
            let (n, sub) = parts_from_address(w)?;
            name.is_none_or(|want| want == n).then(|| format!("https://{n}.{sub}.workers.dev"))
        })
}

/// The first valid `https://<name>.<you>.workers.dev` address in `text`.
pub fn workers_dev_url(text: &str) -> Option<String> {
    workers_dev_url_for(text, None)
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
    cancelled: bool,
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
    // The tool starts helpers of its own (npm's install scripts, esbuild): the whole tree is held in a job (Windows) or a
    // process group, so a stop ends all of it, and so does the app closing during a run. Only THIS child's tree.
    crate::acp::job::prepare(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("The built-in Node could not start ({e})."))?;
    let contain = crate::acp::job::Containment::attach(&child);
    let out = collect(child.stdout.take());
    let err = collect(child.stderr.take());
    let started = Instant::now();
    let mut cancelled = false;
    let cancel_flag = MY_CANCEL.with(|m| m.borrow().clone());
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            // "Cancel": stop only the child this run started (our own handle), never anything else.
            Ok(None) if cancel_flag.as_ref().is_some_and(|f| f.load(Ordering::SeqCst)) => {
                cancelled = true;
                contain.terminate();
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) if started.elapsed() > limit => {
                contain.terminate();
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
    Ok(Raw { ok: status.is_some_and(|s| s.success()), timed_out: status.is_none() && !cancelled, cancelled, stdout, text })
}

fn run_node_as(env: &Env, script: &Path, args: &[&str], limit: Duration, account: Option<&str>) -> StepOut {
    match run_raw(env, script, args, limit, account) {
        Err(e) => fail(e),
        Ok(r) if r.cancelled => fail("Cancelled."),
        Ok(r) if r.ok => StepOut { ok: true, url: workers_dev_url(&r.text), output: scrub(&r.text), taken: false },
        Ok(r) if r.timed_out => fail(format!("{}\nThis took too long and was stopped.", scrub(&r.text))),
        Ok(r) => fail(scrub(&r.text)),
    }
}

fn run_node(env: &Env, script: &Path, args: &[&str], limit: Duration) -> StepOut {
    run_node_as(env, script, args, limit, None)
}

/// The first wrangler that has `wrangler auth token --json` (the "look" and the safe delete need it): 4.57.0, from
/// wrangler's own changelog ("Add `wrangler auth token` command", with its `--json` output).
pub const MIN_WRANGLER: (u64, u64, u64) = (4, 57, 0);

/// Whether a version text like `4.163.0` is at least `min`.
pub fn version_at_least(version: &str, min: (u64, u64, u64)) -> bool {
    let mut it = version.trim().split(['.', '-', '+']).map(|p| p.parse::<u64>().ok());
    match (it.next().flatten(), it.next().flatten(), it.next().flatten()) {
        (Some(a), Some(b), Some(c)) => (a, b, c) >= min,
        _ => false,
    }
}

const TOO_OLD: &str = "The tool this needs is too old and could not be updated. Press Try again.";

/// A finished install only counts when the tool that is now there is new enough.
fn after_install(env: &Env, out: StepOut) -> StepOut {
    if out.ok && !wrangler_current(env) {
        return fail(TOO_OLD);
    }
    out
}

/// The installed wrangler is there and new enough.
fn wrangler_current(env: &Env) -> bool {
    if !wrangler_js(env).is_file() {
        return false;
    }
    let pkg = plain(&env.work).join("node_modules").join("wrangler").join("package.json");
    std::fs::read_to_string(pkg)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["version"].as_str().map(str::to_string))
        .is_some_and(|v| version_at_least(&v, MIN_WRANGLER))
}

const DEPLOYED_FILE: &str = "deployed-relays.txt";

/// `<account id> <relay name>` lines of the relays this PC put online itself (written right after a good deploy). The
/// look counts a line as "mine" only for the account where it found the name. An old line with a bare name has no
/// account, so it is never "mine" (the safe default).
pub fn recorded(env: &Env, account: &str, name: &str) -> bool {
    std::fs::read_to_string(env.work.join(DEPLOYED_FILE)).unwrap_or_default().lines().any(|l| {
        let mut p = l.split_whitespace();
        p.next() == Some(account) && p.next() == Some(name) && p.next().is_none()
    })
}

fn record_deployed(env: &Env, account: &str, name: &str) {
    if recorded(env, account, name) {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(env.work.join(DEPLOYED_FILE)) {
        let _ = writeln!(f, "{account} {name}");
    }
}

/// After a delete (Start fresh) the line goes: another PC may now own that name.
fn forget_deployed(env: &Env, account: &str, name: &str) {
    let path = env.work.join(DEPLOYED_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let keep: Vec<&str> = text
        .lines()
        .filter(|l| {
            let mut p = l.split_whitespace();
            !(p.next() == Some(account) && p.next() == Some(name))
        })
        .collect();
    let _ = std::fs::write(&path, keep.iter().map(|l| format!("{l}\n")).collect::<String>());
}

/// The one account wrangler is signed in to (none when it cannot be told or there are several).
fn single_account(env: &Env) -> Option<String> {
    let r = run_raw(env, &wrangler_js(env), &["whoami", "--json"], Duration::from_secs(60), None).ok().filter(|r| r.ok)?;
    let mut ids = accounts_from_whoami(&r.stdout);
    (ids.len() == 1).then(|| ids.remove(0))
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
            "{\n  \"name\": \"potato-worker-update\",\n  \"private\": true,\n  \"devDependencies\": { \"wrangler\": \"^4.57.0\" }\n}\n",
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
    forget_deployed(env, &account, name);
    *PINNED.lock().unwrap_or_else(|e| e.into_inner()) = Some((name.to_string(), account));
    done(if out.ok { "The old Worker is deleted." } else { "The old Worker was already gone." })
}

/// The Worker names in an account (Cloudflare's own list; the token stays in memory, never printed). `None`: not sure.
fn cloudflare_scripts(token: &str, account: &str) -> Option<Vec<String>> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).redirects(0).user_agent("potato-workspace").build();
    let resp = agent.get(&format!("https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts")).set("authorization", &format!("Bearer {token}")).call().ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    Some(v["result"].as_array()?.iter().filter_map(|x| x["id"].as_str()).map(str::to_string).collect())
}

const NOT_SURE_LOOK: &str = "Could not look at your Cloudflare account, so nothing was changed. Press Try again and sign in.";

/// Whether this PC may put its relay under `name`: the shipped name, or that with a short ending (a second PC in the
/// same account). Never any other Worker name.
pub fn own_name(shipped: &str, requested: &str) -> bool {
    valid_name(requested)
        && (requested == shipped
            || requested.strip_prefix(shipped).and_then(|r| r.strip_prefix('-')).is_some_and(|tail| (3..=12).contains(&tail.len()) && tail.chars().all(|c| c.is_ascii_lowercase())))
}

/// "Look before deploy": reads (never writes) which Workers the account has. A Worker with this name that this PC does
/// not hold the key for (it is not the saved one) is `taken`: nothing may be deployed over it. When it cannot be told,
/// the answer is "failed", never "free".
pub fn look_verified(
    env: &Env,
    name: &str,
    saved_worker_url: Option<&str>,
    scripts_of: impl Fn(&str, &str) -> Option<Vec<String>>,
    subdomain_of: impl Fn(&str, &str) -> Option<String>,
) -> StepOut {
    if !valid_name(name) {
        return fail("That Worker name is not valid.");
    }
    let w = wrangler_js(env);
    let accounts = match run_raw(env, &w, &["whoami", "--json"], Duration::from_secs(60), None) {
        Ok(r) if r.ok => accounts_from_whoami(&r.stdout),
        _ => Vec::new(),
    };
    let token = match run_raw(env, &w, &["auth", "token", "--json"], Duration::from_secs(60), None) {
        Ok(r) if r.ok => token_from_output(&r.stdout),
        _ => None,
    };
    let (Some(token), false) = (token, accounts.is_empty()) else { return fail(NOT_SURE_LOOK) };
    let mut found_in: Vec<&String> = Vec::new();
    for id in &accounts {
        match scripts_of(&token, id) {
            Some(list) if list.iter().any(|n| n == name) => found_in.push(id),
            Some(_) => {}
            None => return fail(NOT_SURE_LOOK),
        }
    }
    if found_in.is_empty() {
        return done("No relay with this name yet.");
    }
    // Mine only in the account where it was found: this PC put it there (its own line), or its saved link points at
    // that account's workers.dev name.
    let saved = saved_worker_url.and_then(parts_from_address).filter(|(n, _)| n == name).map(|(_, sub)| sub);
    let mine_in = |id: &String| recorded(env, id, name) || saved.as_deref().is_some_and(|sub| subdomain_of(&token, id).is_some_and(|s| s.eq_ignore_ascii_case(sub)));
    if found_in.iter().all(|id| mine_in(id)) {
        return done("Your relay is already here.");
    }
    StepOut { ok: true, output: "A relay set up on another PC is already in this account.".into(), url: None, taken: true }
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
            if wrangler_current(env) {
                return done("The tool is already here.");
            }
            let npm = npm_cli_js(env);
            if !npm.is_file() {
                return fail("The built-in npm is missing.");
            }
            let out = run_node(env, &npm, &["install", "--no-audit", "--no-fund"], Duration::from_secs(600));
            after_install(env, out)
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
            let mut out = run_node_as(env, &wrangler_js(env), &refs, Duration::from_secs(300), pinned.as_deref());
            // Only this Worker's own address counts: anything else the tool printed is ignored.
            out.url = out.url.filter(|u| name_from_address(u).as_deref() == Some(name));
            if out.ok {
                // Which account got it: the pinned one, else the only one signed in (never a guess).
                if let Some(account) = pinned.clone().or_else(|| single_account(env)) {
                    record_deployed(env, &account, name);
                }
            }
            out
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
pub async fn worker_update_step(app: tauri::AppHandle, step: String, address: Option<String>, confirmed: Option<bool>, worker_name: Option<String>) -> Result<StepOut, String> {
    let env = env_for(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let name = match address.as_deref().filter(|a| !a.trim().is_empty()) {
            Some(a) => name_from_address(a).ok_or("That address is not a workers.dev address.")?,
            None => {
                let shipped = load_bundle(&env.bundle_dir).map(|b| b.manifest.name).unwrap_or_else(|_| "pm-relay".into());
                match worker_name.as_deref().filter(|n| !n.is_empty()) {
                    Some(n) if own_name(&shipped, n) => n.to_string(),
                    Some(_) => return Err("That is not a relay name this app makes.".to_string()),
                    None => shipped,
                }
            }
        };
        let saved = crate::tunnel_config::load(&crate::tunnel_config::tunnel_file());
        let saved_url = match &saved {
            crate::tunnel_config::TunnelConfig::Stable { worker_url, .. } => Some(worker_url.as_str()),
            _ => None,
        };
        if step == "look" {
            return Ok(exclusive(|| look_verified(&env, &name, saved_url, cloudflare_scripts, cloudflare_subdomain)));
        }
        if step == "delete" {
            return Ok(exclusive(|| delete_verified(&env, &name, saved_url, confirmed == Some(true), cloudflare_subdomain)));
        }
        // Far-away PCs (Labs): the Worker is told the public key that may open pairing boxes. Never a secret.
        let vars: Vec<(&str, String)> = crate::device_link::app::pair_owner_id().map(|id| ("PAIR_OWNER", id)).into_iter().collect();
        Ok(exclusive(|| run_step_with(&env, &step, &name, &vars)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Cancel" in the guided setup: stops the tool the running step started (nothing else). True when a step was running.
#[tauri::command]
pub fn worker_update_cancel() -> bool {
    request_cancel()
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

    /// A fake wrangler for ONE shared Cloudflare account: `account` is a file listing the Workers in it; a deploy over a
    /// name that is already there is written down as `CLOBBER` (that is what replaces the other PC's relay).
    fn account_script(account: &Path) -> String {
        let id = "d".repeat(32);
        let file = account.to_string_lossy().replace('\\', "/");
        format!(
            "const fs=require('fs');const a=process.argv.slice(2);const F='{file}';\
             const rd=()=>fs.existsSync(F)?fs.readFileSync(F,'utf8').split('\\n').filter(Boolean):[];\
             if(a[0]==='whoami'){{console.log(JSON.stringify({{accounts:[{{id:'{id}',name:'x'}}]}}));}}\
             else if(a[0]==='auth'){{console.log(JSON.stringify({{token:'tok'}}));}}\
             else if(a[0]==='deploy'){{const n=/name = \"([^\"]+)\"/.exec(fs.readFileSync('wrangler.toml','utf8'))[1];\
               fs.appendFileSync(F,(rd().includes(n)?'CLOBBER ':'')+n+'\\n');console.log('Deployed');}}"
        )
    }
    fn names_in(account: &Path) -> Vec<String> {
        std::fs::read_to_string(account).unwrap_or_default().lines().map(str::to_string).collect()
    }
    /// What Cloudflare's list answers for the fake account.
    fn listed(account: &Path) -> impl Fn(&str, &str) -> Option<Vec<String>> + '_ {
        move |_, _| Some(names_in(account).iter().map(|n| n.trim_start_matches("CLOBBER ").to_string()).collect())
    }
    fn me(_: &str, _: &str) -> Option<String> {
        Some("me".to_string())
    }
    fn pc(tag: &str, account: &Path, name: &str) -> Option<(Env, PathBuf)> {
        let (env, work) = fake_env(tag, &account_script(account))?;
        std::fs::write(work.join("wrangler.toml"), format!("name = \"{name}\"\n")).unwrap();
        Some((env, work))
    }

    #[test]
    fn two_pcs_one_account_the_second_pc_never_deploys_over_the_first() {
        let _g = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let acct = tmp("acct").join("workers.txt");
        let Some((pc1, w1)) = pc("pc1", &acct, "pm-relay") else { return };
        let (pc2, w2) = pc("pc2", &acct, "pm-relay").unwrap();
        let mine = |u: &'static str| Some(u);
        // PC 1 sets up first: nothing there, so it may deploy.
        let first = look_verified(&pc1, "pm-relay", None, listed(&acct), me);
        assert!(first.ok && !first.taken, "{}", first.output);
        assert!(run_step(&pc1, "deploy", "pm-relay").ok);
        // PC 2, same account, no key for it: the look says taken.
        let second = look_verified(&pc2, "pm-relay", None, listed(&acct), me);
        assert!(second.ok && second.taken, "{}", second.output);
        // The old behaviour (no look) is what broke PC 1: the same name gets deployed over.
        assert!(run_step(&pc2, "deploy", "pm-relay").ok);
        assert_eq!(names_in(&acct), vec!["pm-relay", "CLOBBER pm-relay"], "the root cause: a second deploy under the same name");
        // The fixed path: PC 2 takes its own name. PC 1's relay is not deployed over again.
        let _ = std::fs::remove_file(&acct);
        assert!(run_step(&pc1, "deploy", "pm-relay").ok);
        let _ = std::fs::remove_file(w2.join(DEPLOYED_FILE));
        std::fs::write(w2.join("wrangler.toml"), "name = \"pm-relay-abcd\"\n").unwrap();
        let own = look_verified(&pc2, "pm-relay-abcd", None, listed(&acct), me);
        assert!(own.ok && !own.taken, "{}", own.output);
        assert!(run_step(&pc2, "deploy", "pm-relay-abcd").ok);
        assert_eq!(names_in(&acct), vec!["pm-relay", "pm-relay-abcd"], "both relays exist, nothing was replaced");
        // PC 1 looking at its own relay again (an update) is not "taken": it holds the key.
        let again = look_verified(&pc1, "pm-relay", mine("https://pm-relay.me.workers.dev"), listed(&acct), me);
        assert!(again.ok && !again.taken, "{}", again.output);
        // PC 2 does not hold PC 1's name even when it saved its own.
        let other = look_verified(&pc2, "pm-relay", mine("https://pm-relay-abcd.me.workers.dev"), listed(&acct), me);
        assert!(other.taken);
        for w in [w1, w2, acct.parent().unwrap().to_path_buf()] {
            let _ = std::fs::remove_dir_all(&w);
        }
    }

    #[test]
    fn this_pcs_own_deploy_is_mine_on_a_retry_even_when_nothing_else_was_saved() {
        let _g = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let acct = tmp("acct-own").join("workers.txt");
        let Some((pc1, w1)) = pc("pc-own", &acct, "pm-relay") else { return };
        // Deploy worked, then the check failed / the person quit: nothing saved. Try again must not say "another PC".
        assert!(run_step(&pc1, "deploy", "pm-relay").ok);
        let id = "d".repeat(32);
        assert!(recorded(&pc1, &id, "pm-relay"), "the line holds the account and the name");
        assert!(!recorded(&pc1, &"e".repeat(32), "pm-relay"));
        let again = look_verified(&pc1, "pm-relay", None, listed(&acct), me);
        assert!(again.ok && !again.taken, "{}", again.output);
        // A failed deploy records nothing.
        let Some((bad, wb)) = fake_env("pc-own-bad", "console.error('boom');process.exit(1);") else { return };
        assert!(!run_step(&bad, "deploy", "pm-relay").ok);
        assert!(!std::fs::read_to_string(bad.work.join(DEPLOYED_FILE)).is_ok_and(|t| !t.is_empty()));
        for w in [w1, wb, acct.parent().unwrap().to_path_buf()] {
            let _ = std::fs::remove_dir_all(&w);
        }
    }

    #[test]
    fn the_same_name_in_another_account_is_taken_and_a_stale_line_goes_after_start_fresh() {
        let _g = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let acct = tmp("acct-x").join("workers.txt");
        let Some((pc1, w1)) = pc("pc-x", &acct, "pm-relay") else { return };
        let id = "d".repeat(32);
        let other = "e".repeat(32);
        // This PC once deployed pm-relay to ANOTHER account; now it is signed in to account d, where pm-relay exists.
        std::fs::write(pc1.work.join(DEPLOYED_FILE), format!("{other} pm-relay\npm-relay\n")).unwrap();
        std::fs::write(&acct, "pm-relay\n").unwrap();
        let out = look_verified(&pc1, "pm-relay", None, listed(&acct), me);
        assert!(out.ok && out.taken, "same name in another account, and an old bare-name line, are not mine: {}", out.output);
        // A saved link under another workers.dev name does not count either.
        let out = look_verified(&pc1, "pm-relay", Some("https://pm-relay.elsewhere.workers.dev"), listed(&acct), me);
        assert!(out.taken, "{}", out.output);
        // The line for account d counts; Start fresh removes it, so a later owner of the name is not "mine".
        std::fs::write(pc1.work.join(DEPLOYED_FILE), format!("{id} pm-relay\n")).unwrap();
        assert!(!look_verified(&pc1, "pm-relay", None, listed(&acct), me).taken);
        let del = delete_verified(&pc1, "pm-relay", Some(SAVED), true, |_, a| (a == id).then(|| "me".to_string()));
        assert!(del.ok, "{}", del.output);
        assert!(!recorded(&pc1, &id, "pm-relay"), "the delete removes the line");
        assert!(look_verified(&pc1, "pm-relay", None, listed(&acct), me).taken);
        for w in [w1, acct.parent().unwrap().to_path_buf()] {
            let _ = std::fs::remove_dir_all(&w);
        }
    }

    #[test]
    fn an_install_that_leaves_the_tool_too_old_says_so_plainly() {
        let Some((env, work)) = fake_env("inst-old", "") else { return };
        std::fs::write(work.join("node_modules/wrangler/package.json"), "{\"version\":\"4.1.0\"}").unwrap();
        let out = after_install(&env, done("added 1 package"));
        assert!(!out.ok && out.output.contains("too old") && !out.output.to_lowercase().contains("sign"), "{}", out.output);
        std::fs::write(work.join("node_modules/wrangler/package.json"), "{\"version\":\"4.163.0\"}").unwrap();
        assert!(after_install(&env, done("ok")).ok);
        assert!(!after_install(&env, fail("npm broke")).ok);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn the_tool_must_be_new_enough_to_print_its_token() {
        assert!(version_at_least("4.57.0", MIN_WRANGLER) && version_at_least("4.163.0", MIN_WRANGLER) && version_at_least("5.0.0", MIN_WRANGLER));
        for old in ["4.56.9", "4.0.0", "3.99.0", "", "x.y.z", "4.57"] {
            assert!(!version_at_least(old, MIN_WRANGLER), "{old}");
        }
        // An installed tool that is too old (or has no version) is installed again, not trusted.
        let Some((env, work)) = fake_env("old-wr", "") else { return };
        assert!(!wrangler_current(&env));
        let pkg = work.join("node_modules/wrangler/package.json");
        std::fs::write(&pkg, "{\"version\":\"4.40.1\"}").unwrap();
        assert!(!wrangler_current(&env));
        std::fs::write(&pkg, "{\"version\":\"4.163.0\"}").unwrap();
        assert!(wrangler_current(&env));
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn when_the_account_cannot_be_read_the_look_fails_instead_of_saying_free() {
        let acct = tmp("acct-bad").join("workers.txt");
        let Some((env, work)) = pc("pc-bad", &acct, "pm-relay") else { return };
        let out = look_verified(&env, "pm-relay", None, |_, _| None, me);
        assert!(!out.ok && !out.taken && out.output.contains("nothing was changed"), "{}", out.output);
        assert!(!look_verified(&env, "Bad Name", None, listed(&acct), me).ok);
        // Signed out (the tool cannot say who): also not "free".
        let Some((env2, work2)) = fake_env("look-who", "console.error('boom');process.exit(1);") else { return };
        assert!(!look_verified(&env2, "pm-relay", None, |_, _| Some(vec![]), me).ok);
        for w in [work, work2, acct.parent().unwrap().to_path_buf()] {
            let _ = std::fs::remove_dir_all(&w);
        }
    }

    #[test]
    fn a_second_pc_may_only_name_its_relay_after_ours() {
        assert!(own_name("pm-relay", "pm-relay"));
        assert!(own_name("pm-relay", "pm-relay-abcd"));
        for bad in ["pm-relay-", "pm-relay-ab", "pm-relay-abcdefghijklm", "other", "pm-relayx", "pm-relay-AB12", "pm-relay-ab12", "pm-relay-a-bc", "my-blog", "pm-relay--x"] {
            assert!(!own_name("pm-relay", bad), "{bad}");
        }
    }

    #[test]
    fn only_an_exact_name_dot_you_dot_workers_dev_address_counts() {
        for bad in [
            "https://evil.com/x.workers.dev",
            "https://evil.com/pm-relay.me.workers.dev",
            "https://a.b.c.workers.dev",
            "https://me.workers.dev",
            "http://pm-relay.me.workers.dev",
            "https://pm-relay.me.workers.dev.evil.com",
            "https://evil.com?x=pm-relay.me.workers.dev",
        ] {
            assert_eq!(workers_dev_url(bad), None, "{bad}");
        }
        assert_eq!(workers_dev_url("Deployed to https://Pm-Relay.Me.workers.dev/ now"), Some("https://pm-relay.me.workers.dev".into()));
        // Another Worker's address in the output is not this Worker's.
        let text = "see https://other.me.workers.dev and https://pm-relay.me.workers.dev";
        assert_eq!(workers_dev_url_for(text, Some("pm-relay")), Some("https://pm-relay.me.workers.dev".into()));
        assert_eq!(workers_dev_url_for("https://other.me.workers.dev", Some("pm-relay")), None);
    }

    static BUSY_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_second_step_is_refused_while_one_runs_and_cancel_stops_only_that_one() {
        let _g = BUSY_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let _p = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let Some((env, work)) = fake_env("cancel", "setTimeout(()=>{}, 60000);") else { return };
        std::fs::write(work.join("package.json"), "{}").unwrap();
        let env = std::sync::Arc::new(env);
        let e2 = env.clone();
        let running = std::thread::spawn(move || exclusive(|| run_step(&e2, "login", "pm-relay")));
        for _ in 0..100 {
            if BUSY.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let second = exclusive(|| done("should not run"));
        assert!(!second.ok && second.output.contains("Another setup is still running"), "{}", second.output);
        std::thread::sleep(Duration::from_millis(300));
        assert!(request_cancel());
        let first = running.join().unwrap();
        assert!(!first.ok, "{}", first.output);
        assert!(!BUSY.load(Ordering::SeqCst) && !request_cancel());
        let _ = std::fs::remove_dir_all(&work);
    }

    fn pid_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
        }
    }

    const GRANDCHILD: &str = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});require('fs').writeFileSync('gc.pid',String(c.pid));setTimeout(()=>{},60000);";

    fn grandchild_pid(work: &Path) -> u32 {
        for _ in 0..100 {
            if let Ok(t) = std::fs::read_to_string(work.join("gc.pid")) {
                if let Ok(p) = t.trim().parse() {
                    return p;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the fake tool never started its helper");
    }

    #[test]
    fn cancel_ends_the_tools_helpers_too() {
        let _g = BUSY_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let _p = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let Some((env, work)) = fake_env("cancel-tree", GRANDCHILD) else { return };
        std::fs::write(work.join("package.json"), "{}").unwrap();
        let env = std::sync::Arc::new(env);
        let e2 = env.clone();
        let running = std::thread::spawn(move || exclusive(|| run_step(&e2, "login", "pm-relay")));
        let gc = grandchild_pid(&work);
        assert!(pid_alive(gc));
        assert!(request_cancel());
        let first = running.join().unwrap();
        assert!(!first.ok);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!pid_alive(gc), "the helper of the cancelled tool is still running");
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn the_time_limit_ends_the_tools_helpers_too() {
        let _g = BUSY_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let _p = PIN_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let Some((env, work)) = fake_env("limit-tree", GRANDCHILD) else { return };
        let started = Instant::now();
        let raw = run_raw(&env, &wrangler_js(&env), &[], Duration::from_millis(1500), None).unwrap();
        assert!(raw.timed_out && !raw.cancelled);
        assert!(started.elapsed() < Duration::from_secs(20), "waited for the helper's pipe");
        let gc = grandchild_pid(&work);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!pid_alive(gc), "the helper of the timed-out tool is still running");
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
