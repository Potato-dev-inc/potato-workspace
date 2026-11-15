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

/// The Worker's own name in a `https://<name>.<you>.workers.dev` address (an update goes to the same Worker).
pub fn name_from_address(address: &str) -> Option<String> {
    let rest = address.trim().strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let first = host.strip_suffix(".workers.dev")?.split('.').next()?.to_string();
    valid_name(&first).then_some(first)
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

/// Runs `node <script> <args>` in the working copy and waits (bounded). The output is both streams together.
fn run_node(env: &Env, script: &Path, args: &[&str], limit: Duration) -> StepOut {
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
    cmd.env("WRANGLER_SEND_METRICS", "false")
        .env("npm_config_audit", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_update_notifier", "false")
        .env("NO_COLOR", "1")
        .env_remove("CI");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("The built-in Node could not start ({e}).")),
    };
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
    let text = format!("{}\n{}", out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        Some(s) if s.success() => StepOut { ok: true, url: workers_dev_url(&text), output: scrub(&text) },
        Some(_) => fail(scrub(&text)),
        None => fail(format!("{}\nThis took too long and was stopped.", scrub(&text))),
    }
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

/// Runs one step. `name` is the Worker's name (from its address, or the shipped default).
pub fn run_step(env: &Env, step: &str, name: &str) -> StepOut {
    if !valid_name(name) {
        return fail("That Worker name is not valid.");
    }
    match step {
        "prepare" => prepare(env, name),
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
        "deploy" => run_node(env, &wrangler_js(env), &["deploy", "--config", "wrangler.toml", "--keep-vars"], Duration::from_secs(300)),
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
pub async fn worker_update_step(app: tauri::AppHandle, step: String, address: Option<String>) -> Result<StepOut, String> {
    let env = env_for(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let name = match address.as_deref().filter(|a| !a.trim().is_empty()) {
            Some(a) => name_from_address(a).ok_or("That address is not a workers.dev address.")?,
            None => load_bundle(&env.bundle_dir).map(|b| b.manifest.name).unwrap_or_else(|_| "pm-relay".into()),
        };
        Ok(run_step(&env, &step, &name))
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
