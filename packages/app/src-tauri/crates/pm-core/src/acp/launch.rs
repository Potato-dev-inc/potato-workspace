//! The launch half of an agent's chat configuration: what a spawn needs from the machine (`HostEnv`), the environment an
//! adapter gets, the private home, the tool-server isolation and the registered agents' chat tables. The data types
//! (`AgentConfig` and friends) are in `config.rs`. What this machine adds that only the app can answer (the lend
//! borrower's env, the bundled tool server, the `ssh` start) comes through `hooks::EngineHooks`.

use std::collections::{BTreeSet, HashMap};
#[cfg(test)]
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::config::*;
use super::conn::SpawnSpec;
use super::error::AcpError;

/// The program that is started for a chat over SSH: `exe`, the words put before the `ssh` arguments (none for the real `ssh`),
/// and extra environment (none for the real `ssh`).
#[derive(Debug, Clone)]
pub struct SshProgram {
    pub exe: PathBuf,
    pub pre: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}


// ---- host environment ------------------------------------------------------------------------------

/// Everything the spawn needs from the machine, behind a trait so tests never read the real environment.
pub trait HostEnv: Send + Sync {
    fn var(&self, name: &str) -> Option<OsString>;
    fn which(&self, program: &str) -> Option<PathBuf>;
    /// Where adapters are installed (`{adapters}`).
    fn adapters_dir(&self) -> PathBuf;
    /// Where private agent homes live; one folder per agent id.
    fn homes_dir(&self) -> PathBuf;
    /// What starts `ssh` for a chat on another computer. Nothing by default: the app's hook (`ssh_chat_spawn`) falls back to this PC's `ssh`; tests give a stand-in.
    fn ssh_program(&self) -> Option<SshProgram> {
        None
    }
    /// The value saved in a credential-store slot. Asked only for an approved adapter key, by slot name.
    fn secret_value(&self, _slot: &str) -> Option<String> {
        None
    }
    /// Runs `program args` in `cwd` with exactly `env` (no window, a short time limit) and returns what it
    /// printed on stdout; `None` when it cannot run, fails, or takes too long. Tests answer from a table.
    fn capture(&self, _program: &Path, _args: &[String], _cwd: &Path, _env: &[(OsString, OsString)]) -> Option<String> {
        None
    }
    /// Whether a tool-server listing (`list_cache_files`) may be remembered. Only the real machine says yes: a fake host
    /// answers from a table that a test changes, and its answers must never outlive it.
    fn cache_listings(&self) -> bool {
        false
    }
}

pub struct RealHost;

impl HostEnv for RealHost {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }
    fn which(&self, program: &str) -> Option<PathBuf> {
        which_cached(program)
    }
    fn adapters_dir(&self) -> PathBuf {
        crate::app_paths::app_data_dir().join("acp").join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        crate::app_paths::app_data_dir().join("acp").join("homes")
    }
    fn secret_value(&self, slot: &str) -> Option<String> {
        crate::secrets::read_secret(slot)
    }
    fn capture(&self, program: &Path, args: &[String], cwd: &Path, env: &[(OsString, OsString)]) -> Option<String> {
        capture_stdout(program, args, cwd, env, CAPTURE_LIMIT)
    }
    fn cache_listings(&self) -> bool {
        true
    }
}

/// Program lookups, remembered for the process: a start asks for the same few programs again and again, and each lookup
/// is a walk over every folder on PATH (times every PATHEXT entry on Windows). The key holds the PATH it was found on, so a
/// changed PATH asks again; an entry whose file is gone is dropped. A program that was not found is not remembered
/// (it may be installed a minute later).
fn which_cached(program: &str) -> Option<PathBuf> {
    static CACHE: Lazy<Mutex<HashMap<(String, OsString), PathBuf>>> = Lazy::new(|| Mutex::new(HashMap::new()));
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let key = (program.to_string(), path_var);
    let hit = CACHE.lock().get(&key).cloned();
    if let Some(found) = hit {
        if found.is_file() {
            return Some(found);
        }
        CACHE.lock().remove(&key);
    }
    let found = crate::env_probe::find_on_path(program)?;
    CACHE.lock().insert(key, found.clone());
    Some(found)
}

/// The lookup through the cache the app uses (`RealHost`), and the plain walk it replaced: for measuring and tests.
pub fn which_for_tests(program: &str) -> Option<PathBuf> {
    which_cached(program)
}

pub fn which_for_tests_uncached(program: &str) -> Option<PathBuf> {
    crate::env_probe::find_on_path(program)
}

/// How long a listing command may run, and how much of its output is read.
const CAPTURE_LIMIT: Duration = Duration::from_secs(10);
const CAPTURE_MAX_BYTES: u64 = 1024 * 1024;

fn capture_stdout(program: &Path, args: &[String], cwd: &Path, env: &[(OsString, OsString)], limit: Duration) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut command = crate::proc_util::hidden_command(program);
    command.args(args).current_dir(cwd).env_clear().envs(env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = (&mut stdout).take(CAPTURE_MAX_BYTES).read_to_end(&mut text);
        text
    });
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                // Our own child only: killed by handle, never by image name.
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = reader.join().ok()?;
    status.filter(|status| status.success())?;
    String::from_utf8(bytes).ok()
}

pub fn expand(template: &str, host: &dyn HostEnv) -> String {
    template.replace("{adapters}", &host.adapters_dir().to_string_lossy())
}

/// The environment an adapter gets. Pure: the caller's `host` answers every question.
pub fn build_env(cfg: &AgentConfig, host: &dyn HostEnv, private_home: Option<&Path>) -> Vec<(OsString, OsString)> {
    let mut out: Vec<(OsString, OsString)> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let key = |name: &str| if cfg!(windows) { name.to_ascii_lowercase() } else { name.to_string() };
    let mut put = |out: &mut Vec<(OsString, OsString)>, name: &str, value: OsString| {
        if seen.insert(key(name)) {
            out.push((OsString::from(name), value));
        } else if let Some(slot) = out.iter_mut().find(|(n, _)| key(&n.to_string_lossy()) == key(name)) {
            slot.1 = value;
        }
    };
    for name in BASE_ENV_ALLOW.iter().copied().chain(cfg.env_allow.iter().map(String::as_str)) {
        if let Some(value) = host.var(name) {
            put(&mut out, name, value);
        }
    }
    for (name, program) in &cfg.env_which {
        if let Some(path) = host.which(program) {
            put(&mut out, name, path.into_os_string());
        }
    }
    if cfg.runtime.trim().eq_ignore_ascii_case("python") {
        put(&mut out, "PYTHONUTF8", OsString::from("1"));
        put(&mut out, "PYTHONUNBUFFERED", OsString::from("1"));
    }
    for (name, value) in &cfg.env {
        put(&mut out, name, OsString::from(expand(value, host)));
    }
    if let (Some(home), Some(spec)) = (private_home, &cfg.private_home) {
        put(&mut out, &spec.env_var, home.as_os_str().to_os_string());
    }
    out
}

/// Points the adapter at an account's login: the account's variables replace what the app's own environment would
/// pass on (`env_allow`), and a variable the account removes is not passed at all. Pure.
pub fn with_account_env(cfg: &mut AgentConfig, launch: &crate::tui::LaunchEnv) {
    // A chat on a chosen account uses that account's own login: the key saved for the main login never goes along.
    cfg.optional_keys.clear();
    let same = |a: &str, b: &str| if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b };
    for (name, value) in &launch.set {
        cfg.env_allow.retain(|n| !same(n, name));
        cfg.env.retain(|n, _| !same(n, name));
        cfg.env.insert(name.clone(), value.clone());
    }
    for name in &launch.remove {
        cfg.env_allow.retain(|n| !same(n, name));
        cfg.env.retain(|n, _| !same(n, name));
    }
}
/// A chat on a borrowed sign-in: the env of the account, the adapter's extra arguments and the `authenticate` method.
pub fn with_borrowed_chat(cfg: &mut AgentConfig, chat: &crate::capacity_proxy::BorrowedChat) {
    with_account_env(cfg, &chat.env);
    cfg.args.extend(chat.args.iter().cloned());
    // A borrowed sign-in carries its own placeholder key: the person's real key never goes with it.
    cfg.optional_keys.clear();
    cfg.authenticate_with = chat.authenticate.clone();
}

/// Makes the private home folder and writes its config (only when the text changed). Returns the folder.
pub fn prepare_private_home(cfg: &AgentConfig, host: &dyn HostEnv) -> Result<Option<PathBuf>, AcpError> {
    let Some(spec) = &cfg.private_home else { return Ok(None) };
    let dir = host.homes_dir().join(sanitize_dir_name(&cfg.id));
    std::fs::create_dir_all(&dir).map_err(|e| AcpError::Spawn(format!("cannot make {}: {e}", dir.display())))?;
    let file = dir.join(&spec.config_file);
    let unchanged = std::fs::read_to_string(&file).map(|old| old == spec.config_text).unwrap_or(false);
    if !unchanged {
        crate::write_atomic::write_atomic(&file, spec.config_text.as_bytes())
            .map_err(|e| AcpError::Spawn(format!("cannot write {}: {e}", file.display())))?;
    }
    Ok(Some(dir))
}

fn sanitize_dir_name(id: &str) -> String {
    let cleaned: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if cleaned.is_empty() {
        "agent".into()
    } else {
        cleaned
    }
}

/// Everything needed to start the adapter for a session in `cwd`.
pub fn resolve_spawn(cfg: &AgentConfig, host: &dyn HostEnv, cwd: &Path) -> Result<SpawnSpec, AcpError> {
    if cfg.disabled {
        let why = if cfg.disabled_note.trim().is_empty() { "it is switched off in this build" } else { cfg.disabled_note.trim() };
        return Err(AcpError::Spawn(format!("chat for {:?} is off: {why}", cfg.id)));
    }
    if cfg.command.trim().is_empty() {
        return Err(AcpError::Spawn(format!("agent {:?} has no command", cfg.id)));
    }
    let home = prepare_private_home(cfg, host)?;
    let mut env = build_env(cfg, host, home.as_deref());
    // Approved adapter keys only (`cfg.adapter_keys` is empty for every other source). A key that is not saved is
    // left out; it is an error only when its group has no saved key at all (a one-of group needs one), or when the key
    // is in no group. The message names the variables; a value is never part of any message.
    let mut present: Vec<&str> = Vec::new();
    for key in &cfg.adapter_keys {
        let Some(value) = host.secret_value(&key.slot) else { continue };
        present.push(&key.env);
        env.retain(|(n, _)| !n.to_string_lossy().eq_ignore_ascii_case(&key.env));
        env.push((OsString::from(&key.env), OsString::from(value)));
    }
    let saved = |name: &str| present.iter().any(|p| p.eq_ignore_ascii_case(name));
    for group in &cfg.adapter_key_groups {
        if !group.iter().any(|name| saved(name)) {
            return Err(AcpError::Spawn(format!("{} is needed by this chat and is not saved: add the key for this adapter", group.join(" or "))));
        }
    }
    for key in &cfg.adapter_keys {
        let grouped = cfg.adapter_key_groups.iter().any(|g| g.iter().any(|n| n.eq_ignore_ascii_case(&key.env)));
        if !grouped && !saved(&key.env) {
            return Err(AcpError::Spawn(format!("{} is needed by this chat and is not saved: add the key for this adapter", key.env)));
        }
    }
    // A key the person saved in Settings > Keys for this agent's provider: passed when there, skipped when not.
    for key in &cfg.optional_keys {
        let Some(value) = host.secret_value(&key.slot).filter(|v| !v.trim().is_empty()) else { continue };
        env.retain(|(n, _)| !n.to_string_lossy().eq_ignore_ascii_case(&key.env));
        env.push((OsString::from(&key.env), OsString::from(value.trim())));
    }
    if let Some((name, value)) = mcp_isolation(cfg, host, cwd, &env)? {
        env.retain(|(n, _)| !n.to_string_lossy().eq_ignore_ascii_case(&name.to_string_lossy()));
        env.push((name, value));
    }
    Ok(SpawnSpec {
        program: program_for(&expand(&cfg.command, host), host),
        args: cfg.args.iter().map(|a| OsString::from(expand(a, host))).collect(),
        env,
        cwd: Some(cwd.to_path_buf()),
    })
}

/// The config of a chat that runs on another computer over SSH (`ssh::acp`). Nothing of this PC crosses over: no adapter
/// key, no own tool server, no private home, no tool-server listing (that asks the LOCAL CLI), no environment. Fails
/// plainly when the agent has no remote chat program.
pub fn for_remote(cfg: &AgentConfig) -> Result<AgentConfig, AcpError> {
    if cfg.disabled {
        return Err(AcpError::Spawn(format!("chat for {:?} is off in this build", cfg.id)));
    }
    if cfg.remote_command.is_empty() {
        return Err(AcpError::Spawn(format!("{} has no chat over SSH yet. Use its terminal on that computer.", cfg.label)));
    }
    let mut out = cfg.clone();
    out.adapter_keys.clear();
    out.adapter_key_groups.clear();
    out.optional_keys.clear();
    out.mcp_servers.clear();
    out.private_home = None;
    // "Open in terminal" would start THIS PC's program with the far machine's session id.
    out.resume_command.clear();
    out.env.clear();
    out.env_allow.clear();
    out.env_which.clear();
    out.mcp_config = McpConfig::default();
    out.pins.clear();
    out.pin_policy = PinPolicy::Off;
    out.authenticate_with = None;
    Ok(out)
}
/// A bare program name (no folder) is looked up on PATH the way a shell does (PATHEXT on Windows). Rust's own
/// lookup only appends `.exe`, so an npm program installed as a `.cmd` shim would never start. A `.cmd` found
/// here is run by the platform's batch handling, which refuses arguments it cannot quote safely (the arguments
/// are fixed text from the table or the confirmed overlay). Not found: the name is kept and the spawn says so.
fn program_for(command: &str, host: &dyn HostEnv) -> OsString {
    let bare = !command.is_empty() && !command.contains(['/', '\\', ':']);
    if bare {
        if let Some(found) = host.which(command) {
            return found.into_os_string();
        }
    }
    OsString::from(command)
}


// ---- keeping the person's own tool servers out ------------------------------------------------------

/// Most tool servers one listing may name, and the longest name accepted.
const MAX_LISTED_SERVERS: usize = 256;
const MAX_SERVER_NAME_CHARS: usize = 128;

/// The variable and JSON text that switch the person's tool servers off for one adapter start
/// (`McpMode::DisableListed`), or `None` for every other mode. The person's own CLI is asked which servers
/// are set up (so a server added yesterday is covered today); each is switched off by name.
pub fn mcp_isolation(cfg: &AgentConfig, host: &dyn HostEnv, cwd: &Path, env: &[(OsString, OsString)]) -> Result<Option<(OsString, OsString)>, AcpError> {
    let m = &cfg.mcp_config;
    if m.mode != McpMode::DisableListed {
        return Ok(None);
    }
    let names = match list_server_names(m, host, cwd, env) {
        Ok(names) => names,
        Err(why) => match m.on_list_failure {
            ListFailure::Refuse => {
                return Err(AcpError::Spawn(format!("cannot tell which tool servers {:?} is set up with ({why}), so chat is not started", cfg.id)));
            }
            ListFailure::Continue => {
                tracing::warn!(agent = %cfg.id, "acp: could not list the agent's tool servers ({why}); starting with its own list");
                Vec::new()
            }
        },
    };
    // The server this app passes itself is never switched off by name: the person may have a server of the same
    // name in their own setup (an older install wrote one), and the switch would take ours down with it.
    let names: Vec<String> = names.into_iter().filter(|n| !is_own_server_name(n, cfg)).collect();
    let own: Vec<Value> = handed_over_servers(cfg).iter().filter_map(|s| server_as_table(s)).collect();
    let json = isolation_json_with(m, &names, &own).map_err(|e| AcpError::Spawn(format!("tool-server setting for {:?}: {e}", cfg.id)))?;
    Ok(Some((OsString::from(&m.env), OsString::from(json))))
}

fn list_server_names(m: &McpConfig, host: &dyn HostEnv, cwd: &Path, env: &[(OsString, OsString)]) -> Result<Vec<String>, String> {
    let program = host.which(&m.list_program).ok_or_else(|| format!("{} was not found", m.list_program))?;
    // Asked again only when something it is read from may have changed (`list_cache_files`).
    let watched = if host.cache_listings() { list_cache_paths(m, host, cwd) } else { Vec::new() };
    let cache_key = (!watched.is_empty()).then(|| list_cache_key(&program, m, cwd, env));
    let stamps: Vec<Option<(SystemTime, u64)>> = watched.iter().map(|p| file_stamp(p)).collect();
    if let Some(key) = cache_key {
        if let Some(entry) = LIST_CACHE.lock().get(&key) {
            if entry.at.elapsed() < LIST_CACHE_TTL && entry.stamps == stamps {
                return Ok(entry.names.clone());
            }
        }
    }
    let output = host.capture(&program, &m.list_args, cwd, env).ok_or_else(|| format!("{} did not list them", m.list_program))?;
    let names = parse_server_names(&output, &m.name_field)?;
    if let Some(key) = cache_key {
        // The stamps are those from before the listing ran: a file changed meanwhile is seen as changed next time.
        let mut cache = LIST_CACHE.lock();
        if cache.len() >= 32 {
            cache.clear();
        }
        cache.insert(key, ListCacheEntry { at: Instant::now(), stamps, names: names.clone() });
    }
    Ok(names)
}

/// How long a remembered listing is trusted when none of its files changed.
const LIST_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

struct ListCacheEntry {
    at: Instant,
    stamps: Vec<Option<(SystemTime, u64)>>,
    names: Vec<String>,
}

static LIST_CACHE: Lazy<Mutex<HashMap<u64, ListCacheEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Forgets every remembered listing (tests; the person's own change is seen through the file stamps).
pub fn clear_list_cache() {
    LIST_CACHE.lock().clear();
}

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn list_cache_key(program: &Path, m: &McpConfig, cwd: &Path, env: &[(OsString, OsString)]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    program.hash(&mut hasher);
    m.list_args.hash(&mut hasher);
    m.name_field.hash(&mut hasher);
    cwd.hash(&mut hasher);
    env.hash(&mut hasher);
    hasher.finish()
}

/// `list_cache_files` with its placeholders filled in (a file whose variable is not set is left out).
fn list_cache_paths(m: &McpConfig, host: &dyn HostEnv, cwd: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for template in &m.list_cache_files {
        let mut text = template.replace("{cwd}", &cwd.to_string_lossy());
        if text.contains("{home}") {
            let Some(home) = crate::project_path::home_dir() else { continue };
            text = text.replace("{home}", &home.to_string_lossy());
        }
        // Any other `{NAME}` is an environment variable.
        let mut complete = true;
        while let (Some(open), true) = (text.find('{'), complete) {
            let Some(close) = text[open..].find('}').map(|i| open + i) else { break };
            match host.var(&text[open + 1..close]).filter(|v| !v.is_empty()) {
                Some(value) => text.replace_range(open..=close, &value.to_string_lossy()),
                None => complete = false,
            }
        }
        if complete {
            out.push(PathBuf::from(text));
        }
    }
    out
}

/// Names from a JSON array of objects, each with a string `name_field`. Anything else is an error: a list
/// that cannot be read is not a list that is empty.
pub fn parse_server_names(output: &str, name_field: &str) -> Result<Vec<String>, String> {
    let value: Value = serde_json::from_str(output.trim()).map_err(|_| "the list is not JSON".to_string())?;
    let items = value.as_array().ok_or_else(|| "the list is not an array".to_string())?;
    if items.len() > MAX_LISTED_SERVERS {
        return Err(format!("more than {MAX_LISTED_SERVERS} servers"));
    }
    let mut names: Vec<String> = Vec::new();
    for item in items {
        let name = item.get(name_field).and_then(Value::as_str).ok_or_else(|| format!("an entry has no {name_field:?}"))?;
        if name.is_empty() || name.chars().count() > MAX_SERVER_NAME_CHARS || name.chars().any(char::is_control) {
            return Err("a server name is empty, too long or has control characters".into());
        }
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// `base` with one switch per name merged in.
pub fn isolation_json(m: &McpConfig, names: &[String]) -> Result<String, String> {
    isolation_json_with(m, names, &[])
}

/// As `isolation_json`, then each own server (`server_as_table` shape, with its `name`) merged in at
/// `own_server_path`, so it wins over a switch or an entry of the same name.
pub fn isolation_json_with(m: &McpConfig, names: &[String], own: &[Value]) -> Result<String, String> {
    let mut root = if m.base.is_object() { m.base.clone() } else { Value::Object(Default::default()) };
    for name in names {
        let path: Vec<String> = m.disable_path.iter().map(|part| part.replace("{name}", name)).collect();
        set_at(&mut root, &path, m.disable_value.clone());
    }
    if !m.own_server_path.is_empty() {
        for server in own {
            let Some(name) = server.get("name").and_then(Value::as_str) else { continue };
            let path: Vec<String> = m.own_server_path.iter().map(|part| part.replace("{name}", name)).collect();
            let mut entry = server.clone();
            if let Some(map) = entry.as_object_mut() {
                map.remove("name");
            }
            set_at(&mut root, &path, entry);
            if m.own_server_extra.is_object() {
                set_at(&mut root, &path, m.own_server_extra.clone());
            }
        }
    }
    serde_json::to_string(&root).map_err(|e| e.to_string())
}

fn is_own_server_name(name: &str, cfg: &AgentConfig) -> bool {
    name == crate::mcp_install::MCP_SERVER_NAME
        && cfg.mcp_servers.iter().any(|s| s.get("name").and_then(Value::as_str) == Some(name))
}

/// A session-call tool server in the shape of a settings table: `{name, command, args, env: {NAME: value}}`.
/// Only a program the adapter starts (stdio); anything else is `None` and stays in the session call.
pub fn server_as_table(server: &Value) -> Option<Value> {
    let ty = server.get("type").and_then(Value::as_str);
    if !matches!(ty, None | Some("stdio")) {
        return None;
    }
    let name = server.get("name").and_then(Value::as_str)?;
    let command = server.get("command").and_then(Value::as_str)?;
    let mut env = serde_json::Map::new();
    for e in server.get("env").and_then(Value::as_array).into_iter().flatten() {
        if let (Some(n), Some(v)) = (e.get("name").and_then(Value::as_str), e.get("value").and_then(Value::as_str)) {
            env.insert(n.to_string(), json!(v));
        }
    }
    Some(json!({ "name": name, "command": command, "args": server.get("args").cloned().unwrap_or_else(|| json!([])), "env": env }))
}

/// The tool servers this config hands over in the agent's settings (`own_server_path`) instead of the session call:
/// this app's own server, when the mode has a place for it.
pub fn handed_over_servers(cfg: &AgentConfig) -> Vec<&Value> {
    let m = &cfg.mcp_config;
    if m.mode != McpMode::DisableListed || m.own_server_path.is_empty() {
        return Vec::new();
    }
    cfg.mcp_servers
        .iter()
        .filter(|s| s.get("name").and_then(Value::as_str) == Some(crate::mcp_install::MCP_SERVER_NAME) && server_as_table(s).is_some())
        .collect()
}

/// `mcpServers` for the session calls: the config's servers except those handed over in the settings.
pub fn session_mcp_servers(cfg: &AgentConfig) -> Vec<Value> {
    let handed = handed_over_servers(cfg);
    cfg.mcp_servers.iter().filter(|s| !handed.iter().any(|h| std::ptr::eq(*h, *s))).cloned().collect()
}

/// Puts `value` at `path` (objects are made on the way; two objects are merged, not replaced).
fn set_at(root: &mut Value, path: &[String], value: Value) {
    let Some((last, parents)) = path.split_last() else { return };
    let mut at = root;
    for part in parents {
        if !at.is_object() {
            *at = Value::Object(Default::default());
        }
        at = at.as_object_mut().expect("just made an object").entry(part.clone()).or_insert_with(|| Value::Object(Default::default()));
    }
    if !at.is_object() {
        *at = Value::Object(Default::default());
    }
    let slot = at.as_object_mut().expect("just made an object").entry(last.clone()).or_insert(Value::Null);
    merge_json(slot, value);
}

fn merge_json(into: &mut Value, from: Value) {
    match (into, from) {
        (Value::Object(into), Value::Object(from)) => {
            for (key, value) in from {
                merge_json(into.entry(key).or_insert(Value::Null), value);
            }
        }
        (into, from) => *into = from,
    }
}


// ---- agents with an ACP table -------------------------------------------------------------------------

/// Every registered agent that carries an `[acp]` table (code profiles and approved definitions), in
/// registry order. Data only: the generic code never matches on `id`.
pub fn builtin_agents() -> Vec<AgentConfig> {
    crate::tui::registry::registry().ordered().iter().filter_map(|profile| profile.acp_table()).collect()
}

/// The chat config of a registered agent: its own `[acp]` table, else (only when it has none) the person's
/// chat overlay (`acp::overlay`, "Add chat (ACP)").
pub fn find_builtin(id: &str) -> Option<AgentConfig> {
    let profile = crate::tui::registry::registry().find(id.trim())?;
    let mut cfg = match profile.acp_table() {
        Some(table) => Some(table),
        None => {
            let label = crate::tui::descriptor_for(profile.id()).map(|d| d.label);
            super::overlay::resolve_with(&super::overlay::OverlayStore::in_app_data(), profile.id(), None, label)
        }
    }?;
    if cfg.mcp_servers.is_empty() {
        cfg.mcp_servers = default_mcp_servers();
    }
    Some(cfg)
}

/// Tell this session's own tool server which pane it runs in, so a helper it starts nests under
/// it (the pane id is a hint the app verifies against the process tree; it grants no rights).
pub fn add_pane_id(cfg: &mut AgentConfig, pane_id: &str) {
    for server in &mut cfg.mcp_servers {
        if server.get("name").and_then(Value::as_str) != Some(crate::mcp_install::MCP_SERVER_NAME) {
            continue;
        }
        let Some(map) = server.as_object_mut() else { continue };
        let env = map.entry("env").or_insert_with(|| json!([]));
        let Some(list) = env.as_array_mut() else { continue };
        let already = list.iter().any(|e| e.get("name").and_then(Value::as_str) == Some(crate::pty::PANE_ID_ENV));
        if !already {
            list.push(json!({ "name": crate::pty::PANE_ID_ENV, "value": pane_id }));
        }
        // This chat's own key (revoked when the session is removed): the shim proves which window it is by it.
        let has_key = list.iter().any(|e| e.get("name").and_then(Value::as_str) == Some(crate::hooks::PANE_KEY_ENV));
        if !has_key {
            // No key where there is no bridge to read it (a machine without the app).
            if let Some(key) = crate::hooks::get().pane_key_mint(pane_id) {
                list.push(json!({ "name": crate::hooks::PANE_KEY_ENV, "value": key }));
            }
        }
    }
}

/// The tool server every chat session gets with no setup: Potato Workspace's own bundled MCP
/// program (never `npx`, never the other product's package), pointed at this app's bridge port
/// file. Empty when this build has no bundled program to start.
pub fn default_mcp_servers() -> Vec<Value> {
    crate::hooks::get().mcp_chat_default_servers()
}

/// Why this chat session will not have Potato Workspace's own tools (`run_agent`, `wait_agents`...), or `None` when it
/// gets them. The chat shows it as a quiet note, so a missing tool server is never silent. Plain words, no path.
pub fn workspace_tools_gap(cfg: &AgentConfig) -> Option<String> {
    let listed = cfg.mcp_servers.iter().any(|s| s.get("name").and_then(Value::as_str) == Some(crate::mcp_install::MCP_SERVER_NAME));
    if listed {
        return None;
    }
    let reason = if crate::hooks::get().mcp_bundled_available() {
        "this chat lists its own tool servers instead"
    } else {
        "this app could not find its bundled tool program"
    };
    Some(format!("Potato Workspace tools aren't available in this chat: {reason}."))
}

/// The Codex table (for tests and tools).
pub fn codex() -> AgentConfig {
    find_builtin("codex").expect("the codex profile carries an [acp] table")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Host {
        vars: BTreeMap<String, String>,
        programs: BTreeMap<String, PathBuf>,
        root: PathBuf,
        /// What the agent's listing command prints (None = it fails).
        listing: Option<String>,
        asked: std::sync::Mutex<Vec<Vec<String>>>,
        /// No `ssh` program on this PC.
        no_ssh: bool,
    }

    impl Host {
        fn new() -> Self {
            Host {
                vars: BTreeMap::from([
                    ("PATH".into(), "C:\\bin".into()),
                    ("SystemRoot".into(), "C:\\Windows".into()),
                    ("ANTHROPIC_API_KEY".into(), "sk-secret".into()),
                    ("OPENAI_API_KEY".into(), "sk-other".into()),
                    ("GITHUB_TOKEN".into(), "ghp_secret".into()),
                ]),
                programs: BTreeMap::from([("codex".into(), PathBuf::from("C:\\tools\\codex.exe"))]),
                root: std::env::temp_dir().join(format!("pm-acp-config-{}", uuid::Uuid::new_v4())),
                listing: Some(r#"[{"name":"chrome-devtools","enabled":true},{"name":"potato-workspace","enabled":true}]"#.into()),
                asked: std::sync::Mutex::new(Vec::new()),
                no_ssh: false,
            }
        }
    }

    impl HostEnv for Host {
        fn var(&self, name: &str) -> Option<OsString> {
            self.vars.get(name).map(OsString::from)
        }
        fn which(&self, program: &str) -> Option<PathBuf> {
            self.programs.get(program).cloned()
        }
        fn adapters_dir(&self) -> PathBuf {
            self.root.join("adapters")
        }
        fn homes_dir(&self) -> PathBuf {
            self.root.join("homes")
        }
        fn ssh_program(&self) -> Option<SshProgram> {
            (!self.no_ssh).then(|| SshProgram { exe: PathBuf::from("ssh.exe"), pre: Vec::new(), env: Vec::new() })
        }
        fn capture(&self, _program: &Path, args: &[String], _cwd: &Path, _env: &[(OsString, OsString)]) -> Option<String> {
            self.asked.lock().unwrap().push(args.to_vec());
            self.listing.clone()
        }
    }

    fn lookup(env: &[(OsString, OsString)], name: &str) -> Option<String> {
        env.iter().find(|(n, _)| n.to_string_lossy() == name).map(|(_, v)| v.to_string_lossy().into_owned())
    }

    #[test]
    fn secrets_in_the_apps_environment_do_not_reach_the_adapter() {
        let host = Host::new();
        let env = build_env(&codex(), &host, None);
        assert_eq!(lookup(&env, "PATH").as_deref(), Some("C:\\bin"));
        assert_eq!(lookup(&env, "SystemRoot").as_deref(), Some("C:\\Windows"));
        assert!(lookup(&env, "ANTHROPIC_API_KEY").is_none());
        assert!(lookup(&env, "OPENAI_API_KEY").is_none());
        assert!(lookup(&env, "GITHUB_TOKEN").is_none());
    }

    #[test]
    fn the_login_name_reaches_the_adapter_so_the_macos_keychain_is_found() {
        let mut host = Host::new();
        host.vars.insert("USER".into(), "ren".into());
        host.vars.insert("LOGNAME".into(), "ren".into());
        let env = build_env(&codex(), &host, None);
        assert_eq!(lookup(&env, "USER").as_deref(), Some("ren"));
        assert_eq!(lookup(&env, "LOGNAME").as_deref(), Some("ren"));
    }

    #[test]
    fn an_agent_can_ask_for_more_names_and_resolves_its_own_cli() {
        let host = Host::new();
        let mut cfg = codex();
        cfg.env_allow.push("OPENAI_API_KEY".into());
        let env = build_env(&cfg, &host, None);
        assert_eq!(lookup(&env, "OPENAI_API_KEY").as_deref(), Some("sk-other"));
        assert_eq!(lookup(&env, "CODEX_PATH").as_deref(), Some("C:\\tools\\codex.exe"));
        assert_eq!(lookup(&env, "INITIAL_AGENT_MODE").as_deref(), Some("read-only"));
    }

    fn private_home_config() -> AgentConfig {
        AgentConfig {
            id: "x".into(),
            command: "node".into(),
            private_home: Some(PrivateHome { env_var: "X_HOME".into(), config_file: "config.toml".into(), config_text: "# no tool servers\n".into() }),
            mcp_config: McpConfig { mode: McpMode::PrivateHome, ..McpConfig::default() },
            ..AgentConfig::default()
        }
    }

    #[test]
    fn the_private_home_replaces_the_users_own_config_folder() {
        let host = Host::new();
        let cfg = private_home_config();
        let dir = prepare_private_home(&cfg, &host).unwrap().expect("this agent has a private home");
        assert!(dir.starts_with(host.homes_dir()));
        let written = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(!written.contains("mcp_servers"), "the minimal config lists no tool server");
        let env = build_env(&cfg, &host, Some(&dir));
        assert_eq!(lookup(&env, "X_HOME").map(PathBuf::from), Some(dir.clone()));
        // A second call does not rewrite an unchanged file.
        let before = std::fs::metadata(dir.join("config.toml")).unwrap().modified().unwrap();
        prepare_private_home(&cfg, &host).unwrap();
        assert_eq!(std::fs::metadata(dir.join("config.toml")).unwrap().modified().unwrap(), before);
        let _ = std::fs::remove_dir_all(&host.root);
    }

    #[test]
    fn codex_uses_the_persons_own_home_not_a_private_one() {
        let cfg = codex();
        assert!(cfg.private_home.is_none());
        assert_eq!(cfg.mcp_config.mode, McpMode::DisableListed);
        assert_eq!(cfg.resume_command, vec!["resume".to_string(), "{session}".to_string()]);
        let host = Host { vars: BTreeMap::from([("CODEX_HOME".into(), "D:\\mine".into()), ("PATH".into(), "C:\\bin".into())]), ..Host::new() };
        assert_eq!(lookup(&build_env(&cfg, &host, None), "CODEX_HOME").as_deref(), Some("D:\\mine"), "a custom home reaches the adapter");
    }

    #[test]
    fn the_listed_tool_servers_are_switched_off_by_name_and_plugins_are_off() {
        let host = Host::new();
        let spec = resolve_spawn(&codex(), &host, Path::new("C:\\work")).unwrap();
        let setting = lookup(&spec.env, "CODEX_CONFIG").expect("the setting is passed");
        let value: Value = serde_json::from_str(&setting).unwrap();
        assert_eq!(value["mcp_servers"]["chrome-devtools"]["enabled"], false);
        assert_eq!(value["mcp_servers"]["potato-workspace"]["enabled"], false);
        assert_eq!(value["features"]["plugins"], false);
        assert_eq!(value["mcp_servers"].as_object().unwrap().len(), 2, "only the listed ones");
        let asked = host.asked.lock().unwrap().clone();
        assert_eq!(asked, vec![vec!["mcp", "list", "--json", "--disable", "plugins"]]);
        let _ = std::fs::remove_dir_all(&host.root);
    }

    #[test]
    fn a_listing_that_fails_or_cannot_be_read_refuses_the_start() {
        let cwd = Path::new("C:\\work");
        for listing in [None, Some("not json".to_string()), Some(r#"{"name":"x"}"#.to_string()), Some(r#"[{"id":"x"}]"#.to_string())] {
            let host = Host { listing, ..Host::new() };
            let err = resolve_spawn(&codex(), &host, cwd).unwrap_err().to_string();
            assert!(err.contains("chat is not started"), "{err}");
        }
        let host = Host { programs: BTreeMap::new(), ..Host::new() };
        assert!(resolve_spawn(&codex(), &host, cwd).is_err(), "no CLI, no start");
    }

    #[test]
    fn continue_policy_starts_with_the_base_setting_only() {
        let mut cfg = codex();
        cfg.mcp_config.on_list_failure = ListFailure::Continue;
        let host = Host { listing: None, ..Host::new() };
        let spec = resolve_spawn(&cfg, &host, Path::new("C:\\work")).unwrap();
        let value: Value = serde_json::from_str(&lookup(&spec.env, "CODEX_CONFIG").unwrap()).unwrap();
        assert!(value.get("mcp_servers").is_none());
        assert_eq!(value["features"]["plugins"], false);
    }

    #[test]
    fn an_empty_listing_still_passes_the_base_setting() {
        let host = Host { listing: Some("[]".into()), ..Host::new() };
        let spec = resolve_spawn(&codex(), &host, Path::new("C:\\work")).unwrap();
        let value: Value = serde_json::from_str(&lookup(&spec.env, "CODEX_CONFIG").unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"features": {"plugins": false}}));
    }

    #[test]
    fn server_names_with_odd_characters_stay_data() {
        let names = parse_server_names(r#"[{"name":"a.b"},{"name":"a.b"},{"name":"c d\"e"}]"#, "name").unwrap();
        assert_eq!(names, vec!["a.b".to_string(), "c d\"e".to_string()]);
        let json = isolation_json(&codex().mcp_config, &names).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["mcp_servers"]["a.b"]["enabled"], false, "the name is a key, not a path");
        assert!(parse_server_names(r#"[{"name":"\u0007"}]"#, "name").is_err());
        assert!(parse_server_names(&format!(r#"[{{"name":"{}"}}]"#, "x".repeat(300)), "name").is_err());
    }

    fn own_server_cfg() -> AgentConfig {
        let mut cfg = codex();
        cfg.mcp_servers = vec![json!({
            "name": crate::mcp_install::MCP_SERVER_NAME,
            "command": "C:/Program Files/Potato Workspace/resources/bin/puppet-master-mcp.exe",
            "args": [],
            "env": [{"name": "POTATO_WORKSPACE_BRIDGE_PORT_FILE", "value": "C:/pm/port"}, {"name": "POTATO_WORKSPACE_PANE_ID", "value": "p1"}],
        })];
        cfg
    }

    fn spawn_setting(cfg: &AgentConfig) -> Value {
        let host = Host::new();
        let spec = resolve_spawn(cfg, &host, Path::new("C:\\work")).unwrap();
        let value = serde_json::from_str(&lookup(&spec.env, "CODEX_CONFIG").unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&host.root);
        value
    }

    #[test]
    fn our_own_server_is_never_switched_off_by_name_and_goes_in_the_setting() {
        // The listing names potato-workspace too: an older install wrote that entry into the person's config.toml.
        let value = spawn_setting(&own_server_cfg());
        let ours = &value["mcp_servers"]["potato-workspace"];
        assert_eq!(ours["enabled"], true, "on, not off: {value}");
        assert_eq!(ours["default_tools_approval_mode"], "approve");
        assert_eq!(ours["command"], "C:/Program Files/Potato Workspace/resources/bin/puppet-master-mcp.exe");
        assert_eq!(ours["env"]["POTATO_WORKSPACE_PANE_ID"], "p1");
        assert_eq!(ours["env"]["POTATO_WORKSPACE_BRIDGE_PORT_FILE"], "C:/pm/port");
        assert_eq!(value["mcp_servers"]["chrome-devtools"]["enabled"], false, "the other servers stay off");
        assert_eq!(value["features"]["plugins"], false);
    }

    #[test]
    fn a_handed_over_server_is_not_also_asked_for_in_the_session_calls() {
        let cfg = own_server_cfg();
        assert!(session_mcp_servers(&cfg).is_empty(), "else the adapter drops it as a duplicate or loses the switches");
        assert_eq!(workspace_tools_gap(&cfg), None);
        let mut with_other = own_server_cfg();
        with_other.mcp_servers.push(json!({"name": "other", "command": "x", "args": [], "env": []}));
        let rest = session_mcp_servers(&with_other);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["name"], "other");
    }

    #[test]
    fn an_agent_without_a_setting_place_keeps_the_session_call_and_still_never_switches_it_off() {
        let mut cfg = own_server_cfg();
        cfg.mcp_config.own_server_path = Vec::new();
        assert_eq!(session_mcp_servers(&cfg).len(), 1, "stays in session/new");
        let value = spawn_setting(&cfg);
        assert!(value["mcp_servers"].get("potato-workspace").is_none(), "no switch for the server we pass: {value}");
        assert_eq!(value["mcp_servers"]["chrome-devtools"]["enabled"], false);
    }

    #[test]
    fn only_the_server_we_pass_is_exempt_from_the_switches() {
        let mut cfg = own_server_cfg();
        cfg.mcp_servers[0]["name"] = json!("someone-else");
        let value = spawn_setting(&cfg);
        assert_eq!(value["mcp_servers"]["potato-workspace"]["enabled"], false);
    }

    struct KeyHost(Option<&'static str>);
    impl HostEnv for KeyHost {
        fn var(&self, _: &str) -> Option<OsString> {
            None
        }
        fn which(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn adapters_dir(&self) -> PathBuf {
            "adapters".into()
        }
        fn homes_dir(&self) -> PathBuf {
            "homes".into()
        }
        fn secret_value(&self, slot: &str) -> Option<String> {
            (slot == "anthropic_api_key").then(|| self.0.map(str::to_string)).flatten()
        }
    }

    #[test]
    fn a_saved_anthropic_key_reaches_the_claude_chat_and_nothing_fails_without_one() {
        let cfg = find_builtin("claude").unwrap();
        assert_eq!(cfg.optional_keys.len(), 1);
        let with = resolve_spawn(&cfg, &KeyHost(Some("sk-ant-test-fake-0000")), Path::new(".")).unwrap();
        assert_eq!(lookup(&with.env, "ANTHROPIC_API_KEY").as_deref(), Some("sk-ant-test-fake-0000"));
        let without = resolve_spawn(&cfg, &KeyHost(None), Path::new(".")).unwrap();
        assert!(lookup(&without.env, "ANTHROPIC_API_KEY").is_none());
        // Never over SSH, never on a chosen account or a borrowed sign-in.
        assert!(for_remote(&cfg).unwrap().optional_keys.is_empty());
        let mut on_account = cfg.clone();
        with_account_env(&mut on_account, &crate::tui::LaunchEnv { set: vec![("CLAUDE_CONFIG_DIR".into(), "C:/acc".into())], remove: Vec::new() });
        let spawn = resolve_spawn(&on_account, &KeyHost(Some("sk-ant-test-fake-0000")), Path::new(".")).unwrap();
        assert!(lookup(&spawn.env, "ANTHROPIC_API_KEY").is_none(), "no key on a chat under an account");
        assert!(find_builtin("codex").unwrap().optional_keys.is_empty());
    }

    #[test]
    fn a_definition_cannot_ask_for_a_saved_secret() {
        // The field is not read from text: it is ignored (or refused), and the spawn never reads the slot.
        let text = "command = \"node\"
[[optional_keys]]
env = \"OPENAI_API_KEY\"
slot = \"openai_api_key\"
";
        match from_toml_text("mine", "Mine", text) {
            Err(_) => {}
            Ok(cfg) => {
                assert!(cfg.optional_keys.is_empty());
                struct Spy(std::sync::Mutex<Vec<String>>);
                impl HostEnv for Spy {
                    fn var(&self, _: &str) -> Option<OsString> { None }
                    fn which(&self, _: &str) -> Option<PathBuf> { None }
                    fn adapters_dir(&self) -> PathBuf { "adapters".into() }
                    fn homes_dir(&self) -> PathBuf { "homes".into() }
                    fn secret_value(&self, slot: &str) -> Option<String> {
                        self.0.lock().unwrap().push(slot.to_string());
                        Some("sk-test-fake".into())
                    }
                }
                let spy = Spy(Default::default());
                let spawn = resolve_spawn(&cfg, &spy, Path::new(".")).unwrap();
                assert!(spy.0.lock().unwrap().is_empty(), "no secret slot was read");
                assert!(lookup(&spawn.env, "OPENAI_API_KEY").is_none());
            }
        }
    }

    #[test]
    fn the_codex_table_hands_our_server_over_with_its_approval_and_checks_the_path() {
        let m = codex().mcp_config;
        assert_eq!(m.own_server_path, vec!["mcp_servers".to_string(), "{name}".to_string()]);
        assert_eq!(m.own_server_extra["default_tools_approval_mode"], "approve");
        assert_eq!(m.own_server_extra["enabled"], true);
        let mut bad = codex();
        bad.mcp_config.own_server_path = vec!["mcp_servers".into(), "fixed".into()];
        assert!(problems(&bad).iter().any(|(f, _)| f.contains("own_server_path")), "needs {{name}}");
    }

    #[test]
    fn claude_is_on_and_keeps_the_persons_own_login_and_sessions() {
        let cfg = find_builtin("claude").expect("claude has an [acp] table");
        assert!(!cfg.disabled, "founder decision 2026-11-01: the subscription login");
        assert_eq!(cfg.label, "Claude");
        assert!(!cfg.label.contains("Code"), "branding rule");
        assert!(cfg.private_home.is_none());
        assert_eq!(cfg.mcp_config.mode, McpMode::SessionMeta);
        assert_eq!(session_meta(&cfg).unwrap()["claudeCode"]["options"]["strictMcpConfig"], true);
        assert_eq!(cfg.resume_command, vec!["--resume".to_string(), "{session}".to_string()]);
        let env_names: Vec<&String> = cfg.env.keys().chain(cfg.env_allow.iter()).collect();
        assert!(env_names.iter().all(|n| !n.to_ascii_uppercase().contains("KEY")), "no API key is asked for");
    }

    #[test]
    fn a_disabled_agent_is_listed_but_never_started() {
        let cfg = AgentConfig { id: "x".into(), command: "node".into(), disabled: true, disabled_note: "waiting".into(), ..AgentConfig::default() };
        let err = resolve_spawn(&cfg, &Host::new(), Path::new("C:\\work")).unwrap_err().to_string();
        assert!(err.contains("waiting"), "{err}");
    }

    #[test]
    fn the_built_in_tables_pass_their_own_checks() {
        for cfg in builtin_agents() {
            let found = problems(&cfg);
            assert!(found.is_empty(), "{}: {found:?}", cfg.id);
        }
        assert!(find_builtin("codex").is_some() && find_builtin("claude").is_some());
        let opencode = find_builtin("opencode").expect("opencode has its own [acp] table (its own `opencode acp`)");
        assert_eq!(opencode.args, vec!["acp".to_string()]);
        assert!(!opencode.disabled);
        assert_eq!(opencode.shared_server_images, vec!["opencode".to_string()], "its shared server keeps tool servers: they are marked and swept");
        assert!(opencode.chat_only, "OpenCode's terminal takes no typed prompt: a failed chat is never rerun there");
        assert!(!find_builtin("codex").unwrap().chat_only);
    }

    #[test]
    fn resume_commands_match_what_the_chat_history_already_uses() {
        for id in ["codex", "claude", "opencode"] {
            let cfg = find_builtin(id).unwrap();
            let profile = crate::tui::registry::registry().find(id).unwrap();
            let history = profile.session_history().expect("history");
            assert_eq!(
                crate::session_chat::history::resume_args_from(&cfg.resume_command, SAMPLE_SESSION),
                history.resume_args(SAMPLE_SESSION),
                "{id}: the [acp] resume_command and the history resume_args disagree"
            );
        }
    }

    #[test]
    fn a_table_from_a_definition_is_checked_strictly() {
        let ok = "command = \"adapter\"\n[quirks]\ncancel_reports_end_turn = false\n";
        let cfg = from_toml_text("mine", "Mine", ok).unwrap();
        assert_eq!((cfg.id.as_str(), cfg.label.as_str()), ("mine", "Mine"));
        assert!(!cfg.quirks.cancel_reports_end_turn && cfg.quirks.serial_prompts);
        for bad in [
            "command = \"a\"\ntypo = 1",
            "command = \"a\"\nid = \"other\"",
            "command = \"\"",
            "command = \"a\"\n[quirks]\nserial_prompts = false",
            "command = \"a\"\nresume_command = [\"resume\"]",
            "command = \"a\"\nresume_command = [\"x\", \"{session}\", \"{other}\"]",
            "command = \"a\"\n[mcp_config]\nmode = \"session_meta\"",
            "command = \"a\"\n[mcp_config]\nmode = \"disable_listed\"",
            "command = \"a\"\n[env]\n\"BAD NAME\" = \"x\"",
            "command = \"a\"\n[[pins]]\npackage = \"p\"\nversion = \"1\"\nentry = \"e\"\nsha256 = \"zz\"",
            "command = \"a\"\n[[pins]]\npackage = \"p\"\nversion = \"1\"\nentry = \"e\"",
        ] {
            assert!(from_toml_text("mine", "Mine", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn capture_reads_stdout_and_gives_up_on_failure() {
        let cwd = std::env::temp_dir();
        let env = [
            (OsString::from("SystemRoot"), OsString::from(std::env::var("SystemRoot").unwrap_or_default())),
            (OsString::from("PATH"), OsString::from(std::env::var("PATH").unwrap_or_default())),
        ];
        let (program, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd", vec!["/C".into(), "echo hi".into()]) } else { ("sh", vec!["-c".into(), "echo hi".into()]) };
        let out = capture_stdout(Path::new(program), &args, &cwd, &env, Duration::from_secs(10));
        assert_eq!(out.map(|t| t.trim().to_string()), Some("hi".to_string()));
        assert!(capture_stdout(Path::new("definitely-not-a-program-xyz"), &[], &cwd, &[], Duration::from_secs(2)).is_none());
    }

    #[test]
    fn a_bare_command_is_looked_up_on_path_so_a_cmd_shim_starts() {
        let mut host = Host::new();
        host.programs.insert("shimmed".into(), PathBuf::from(r"C:\npm\shimmed.cmd"));
        let cfg = AgentConfig { id: "x".into(), command: "shimmed".into(), args: vec!["acp".into()], ..AgentConfig::default() };
        let spec = resolve_spawn(&cfg, &host, Path::new(r"C:\work")).unwrap();
        assert_eq!(spec.program, OsString::from(r"C:\npm\shimmed.cmd"));
        assert_eq!(spec.args, vec![OsString::from("acp")], "the arguments stay fixed text");
        // not found: the name stays, a folder form is never looked up
        let none = AgentConfig { command: "nowhere".into(), ..cfg.clone() };
        assert_eq!(resolve_spawn(&none, &host, Path::new(r"C:\work")).unwrap().program, OsString::from("nowhere"));
        let path = AgentConfig { command: r"C:\x\shimmed".into(), ..cfg };
        assert_eq!(resolve_spawn(&path, &host, Path::new(r"C:\work")).unwrap().program, OsString::from(r"C:\x\shimmed"));
    }

    #[test]
    fn templates_expand_in_the_command_and_arguments() {
        let host = Host::new();
        let spec = resolve_spawn(&codex(), &host, Path::new("C:\\work")).unwrap();
        let arg = spec.args[0].to_string_lossy().into_owned();
        assert!(arg.starts_with(&host.adapters_dir().to_string_lossy().into_owned()), "{arg}");
        assert!(arg.ends_with("codex-acp/dist/index.js"));
        assert_eq!(spec.cwd.as_deref(), Some(Path::new("C:\\work")));
        let _ = std::fs::remove_dir_all(&host.root);
    }

    #[test]
    fn a_config_without_a_command_is_refused() {
        let host = Host::new();
        assert!(matches!(resolve_spawn(&AgentConfig::default(), &host, Path::new("C:\\")), Err(AcpError::Spawn(_))));
    }

    #[test]
    fn the_toml_table_of_the_design_note_parses_into_the_struct() {
        let text = r##"
            command = "node"
            args = ["{adapters}/x/index.js"]
            resume = "prefer_load"
            history_lost = "refuse"
            [env]
            MODE = "read-only"
            [env_which]
            X_PATH = "xcli"
            [private_home]
            env_var = "X_HOME"
            config_file = "config.toml"
            config_text = "# none\n"
            [timeouts]
            inactivity_secs = 60
            [session_meta]
            claudeLike = { strict = true }
            [[pins]]
            package = "pkg"
            version = "1.0.0"
            entry = "{adapters}/x/index.js"
        "##;
        let cfg: AgentConfig = toml::from_str(text).unwrap();
        assert_eq!(cfg.command, "node");
        assert_eq!(cfg.resume, ResumePreference::PreferLoad);
        assert_eq!(cfg.history_lost, HistoryLostPolicy::Refuse);
        assert_eq!(cfg.timeouts.inactivity_secs, 60);
        assert_eq!(cfg.timeouts.progress_secs, 1800, "unset fields keep their defaults");
        assert_eq!(cfg.private_home.unwrap().env_var, "X_HOME");
        assert_eq!(cfg.session_meta.unwrap()["claudeLike"]["strict"], serde_json::json!(true));
        assert_eq!(cfg.pins[0].sha256, None);
        assert_eq!(cfg.pin_policy, PinPolicy::Enforce);
    }

    #[test]
    fn builtin_lookup_ignores_case_and_unknown_ids() {
        assert!(find_builtin("Codex").is_some());
        assert!(find_builtin("nope").is_none());
    }

    #[test]
    fn a_remote_chat_has_a_chat_program_for_the_agents_that_can_do_it() {
        for id in ["claude", "codex", "opencode"] {
            let cfg = find_builtin(id).unwrap();
            assert!(!cfg.remote_command.is_empty(), "{id}");
            assert!(crate::ssh::model::valid_program(&cfg.remote_command[0]), "{id}");
            assert!(problems(&cfg).is_empty(), "{id}: {:?}", problems(&cfg));
        }
    }
}

#[cfg(test)]
mod tools_gap_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_session_without_the_workspace_tool_server_says_why() {
        let bare = AgentConfig::default();
        let note = workspace_tools_gap(&bare).expect("no tool server listed");
        assert!(note.starts_with("Potato Workspace tools aren't available in this chat: "), "{note}");
        assert!(!note.contains('\\') &&!note.contains(":/"), "no path in the note: {note}");
    }

    #[test]
    fn a_session_that_lists_the_workspace_tool_server_gets_no_note() {
        let cfg = AgentConfig { mcp_servers: vec![json!({"name": crate::mcp_install::MCP_SERVER_NAME, "command": "x", "args": [], "env": []})], ..AgentConfig::default() };
        assert_eq!(workspace_tools_gap(&cfg), None);
    }

    #[test]
    fn another_servers_name_does_not_count() {
        let cfg = AgentConfig { mcp_servers: vec![json!({"name": "other", "command": "x", "args": [], "env": []})], ..AgentConfig::default() };
        assert!(workspace_tools_gap(&cfg).is_some());
    }
}
