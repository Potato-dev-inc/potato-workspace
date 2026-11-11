//! The avoidable waits on the chat start path, each measured before (the old way) and after (the cache). Run with
//! `--nocapture` to see the numbers.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::config::{self, AgentConfig, HostEnv, McpConfig, McpMode};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-acp-speed-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_program_lookup_is_remembered() {
    // `cmd`/`sh` exist on every machine the tests run on; a PATH walk with PATHEXT is the cost being measured.
    let program = if cfg!(windows) { "cmd" } else { "sh" };
    let rounds = 20;
    let before = Instant::now();
    for _ in 0..rounds {
        assert!(config::which_for_tests_uncached(program).is_some());
    }
    let uncached = before.elapsed() / rounds;
    assert!(config::which_for_tests(program).is_some());
    let after = Instant::now();
    for _ in 0..rounds {
        assert!(config::which_for_tests(program).is_some());
    }
    let cached = after.elapsed() / rounds;
    println!("TIMING which({program}): before {uncached:?} per lookup, after {cached:?} per lookup (a start does about 4)");
    assert!(cached <= uncached, "{cached:?} vs {uncached:?}");
}

/// A host whose tool-server listing takes a while and counts how often it runs.
struct Host {
    root: PathBuf,
    runs: Arc<AtomicUsize>,
    delay: Duration,
    names: parking_lot::Mutex<String>,
}

impl HostEnv for Host {
    fn var(&self, name: &str) -> Option<OsString> {
        (name == "AGENT_HOME").then(|| self.root.clone().into_os_string())
    }
    fn which(&self, program: &str) -> Option<PathBuf> {
        Some(PathBuf::from(program))
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
    fn cache_listings(&self) -> bool {
        true
    }
    fn capture(&self, _: &Path, _: &[String], _: &Path, _: &[(OsString, OsString)]) -> Option<String> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        Some(self.names.lock().clone())
    }
}

fn listed_agent(cache_files: &[&str]) -> AgentConfig {
    AgentConfig {
        id: "lister".into(),
        command: "agent-adapter".into(),
        mcp_config: McpConfig {
            mode: McpMode::DisableListed,
            env: "AGENT_CONFIG".into(),
            list_program: "agent".into(),
            list_args: vec!["mcp".into(), "list".into()],
            name_field: "name".into(),
            disable_path: vec!["servers".into(), "{name}".into()],
            disable_value: serde_json::json!({"enabled": false}),
            list_cache_files: cache_files.iter().map(|f| f.to_string()).collect(),
            ..McpConfig::default()
        },
        ..AgentConfig::default()
    }
}

fn setting_of(spec: &crate::acp::conn::SpawnSpec) -> String {
    spec.env.iter().find(|(n, _)| n == "AGENT_CONFIG").map(|(_, v)| v.to_string_lossy().into_owned()).expect("the isolation setting")
}

#[test]
fn the_tool_server_listing_is_remembered_until_a_config_file_changes() {
    config::clear_list_cache();
    let root = temp_dir("list");
    let cwd = temp_dir("list-cwd");
    let file = root.join("config.toml");
    std::fs::write(&file, "a = 1").unwrap();
    let runs = Arc::new(AtomicUsize::new(0));
    let host = Host { root: root.clone(), runs: runs.clone(), delay: Duration::from_millis(400), names: parking_lot::Mutex::new(r#"[{"name":"one"}]"#.into()) };
    let cfg = listed_agent(&["{AGENT_HOME}/config.toml", "{UNSET_VARIABLE}/config.toml", "{cwd}/.agent/config.toml"]);

    let t = Instant::now();
    let first = config::resolve_spawn(&cfg, &host, &cwd).unwrap();
    let before = t.elapsed();
    let t = Instant::now();
    let second = config::resolve_spawn(&cfg, &host, &cwd).unwrap();
    let after = t.elapsed();
    println!("TIMING tool-server listing (stand-in that takes 400 ms): before {before:?} per start, after {after:?} per start (listing ran {} time)", runs.load(Ordering::SeqCst));
    assert_eq!(runs.load(Ordering::SeqCst), 1, "the second start did not list again");
    assert_eq!(setting_of(&first), setting_of(&second), "the same setting");
    assert!(after < Duration::from_millis(100), "{after:?}");

    // A config file changes (another size): the next start lists again and sees the new server.
    *host.names.lock() = r#"[{"name":"one"},{"name":"two"}]"#.into();
    std::fs::write(&file, "a = 12345").unwrap();
    let third = config::resolve_spawn(&cfg, &host, &cwd).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 2);
    assert!(setting_of(&third).contains("two"));

    // A file that appears (the project's own config) counts as a change too.
    std::fs::create_dir_all(cwd.join(".agent")).unwrap();
    std::fs::write(cwd.join(".agent").join("config.toml"), "b = 2").unwrap();
    config::resolve_spawn(&cfg, &host, &cwd).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 3);

    // Another folder is another listing.
    let other = temp_dir("list-other");
    config::resolve_spawn(&cfg, &host, &other).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 4);

    // Without the field nothing is remembered.
    let plain = listed_agent(&[]);
    config::resolve_spawn(&plain, &host, &cwd).unwrap();
    config::resolve_spawn(&plain, &host, &cwd).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 6);

    // Only files that exist as variables count: with none usable there is nothing to watch, so nothing is remembered.
    let unwatched = listed_agent(&["{UNSET_VARIABLE}/config.toml"]);
    config::resolve_spawn(&unwatched, &host, &cwd).unwrap();
    config::resolve_spawn(&unwatched, &host, &cwd).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 8);
    for dir in [&root, &cwd, &other] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn the_codex_definition_names_its_config_files() {
    let cfg = config::find_builtin("codex").expect("codex has an [acp] table");
    assert!(!cfg.mcp_config.list_cache_files.is_empty());
    assert!(config::problems(&cfg).is_empty(), "{:?}", config::problems(&cfg));
}

/// The environment a chat start needs from the host, with no real agent installed (the fake agent is used).
struct ChatEnv {
    root: PathBuf,
}

impl HostEnv for ChatEnv {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
}

#[test]
fn chat_start_records_its_stages() {
    use crate::acp::chat::{start, QuietHost, StartDeps, StartRequest};
    let dir = temp_dir("chat-stages");
    let cfg = crate::acp::fake_agent::agent_config("", &dir.join("store"));
    let deps = StartDeps {
        registry: Arc::new(parking_lot::Mutex::new(crate::pty::PaneRegistry::new())),
        host: Arc::new(QuietHost),
        env: Arc::new(ChatEnv { root: dir.clone() }),
        conversations: None,
    };
    let chat = start(&deps, cfg, StartRequest { agent_id: "fake".into(), folder: dir.clone(), explicit: true, account: None, ..Default::default() }).expect("the fake agent starts");
    let pane = chat.pane_id().to_string();
    let stages = crate::startup_timing::stages(&pane);
    let names: Vec<&str> = stages.iter().map(|(name, _)| name.as_str()).collect();
    // No warm session is set up in this test, so the claim is a miss; a hit would also be a valid start.
    assert_eq!(names.len(), 4, "{names:?}");
    assert_eq!(names[0], "chat_start_begin");
    assert!(names[1] == "chat_warm_miss" || names[1] == "chat_warm_hit", "{names:?}");
    assert_eq!(names[2], "chat_pane_registered");
    assert_eq!(names[3], "chat_session_ready");
    assert!(stages.windows(2).all(|pair| pair[0].1 <= pair[1].1), "elapsed times go up: {stages:?}");
    chat.retire();
    let _ = std::fs::remove_dir_all(&dir);
}
