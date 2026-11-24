//! Agent spawn configuration, as data.
//!
//! [`AgentConfig`] is also the schema of the `[acp]` table that agent definitions carry, so a new ACP
//! agent is a TOML table and not code. A code-profile agent (Codex, Claude) keeps its table in
//! `tui/<agent>/acp.toml`; a declarative definition carries it as `[acp]` (docs/specs/agent-definitions).
//!
//! ```toml
//! [acp]
//! command = "node"
//! runtime = "python"                  # optional; python adds PYTHONUTF8=1 and PYTHONUNBUFFERED=1 to the env
//! args = ["{adapters}/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js"]
//! env_allow = ["CODEX_HOME"]          # names passed on from the app's environment
//! resume = "prefer_resume"
//! resume_command = ["resume", "{session}"]   # arguments added to the agent's normal terminal launch
//!
//! [acp.env]
//! INITIAL_AGENT_MODE = "read-only"
//!
//! [acp.env_which]                     # NAME -> program found on PATH, e.g. the user's own CLI
//! CODEX_PATH = "codex"
//!
//! [acp.quirks]                        # how this adapter differs from the protocol's happy path
//! cancel_reports_end_turn = true      # a stop that was asked for may still end with `end_turn`
//! serial_prompts = true               # one prompt at a time (the only value this build supports)
//!
//! [acp.mcp_config]                    # keep the person's own tool-server list out of the chat session
//! mode = "disable_listed"             # agent_default | session_meta | private_home | disable_listed
//!
//! [[acp.pins]]                        # versions this build accepts, and the SHA-256 of the file that runs
//! package = "@agentclientprotocol/codex-acp"
//! version = "1.1.4"
//! entry = "{adapters}/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
//! sha256 = "..."
//! ```
//!
//! Nothing outside this file, `tui/<agent>/acp.toml` and the definitions names an agent: the connection,
//! session, supervisor and hand-over code only read these fields.
pub use pm_core::acp::config::*;

use std::ffi::OsString;

use std::path::PathBuf;

use super::conn::SpawnSpec;
use super::error::AcpError;

/// The words started on the far machine: `[env NAME=VALUE ...] program args...`.
pub fn remote_words(cfg: &AgentConfig) -> Result<Vec<String>, AcpError> {
    let mut words: Vec<String> = Vec::new();
    if !cfg.remote_env.is_empty() {
        words.push("env".into());
        for (name, value) in &cfg.remote_env {
            if !valid_env_name(name) || !valid_remote_env_value(value) {
                return Err(AcpError::Spawn(format!("{} has a setting for another computer that cannot be sent.", cfg.label)));
            }
            words.push(format!("{name}={value}"));
        }
    }
    words.extend(cfg.remote_command.iter().cloned());
    Ok(words)
}

/// The host of a real machine: `ssh` is this PC's own program unless the host names another (a test's stand-in).
pub struct WithRealSsh<'a>(pub &'a dyn HostEnv);

impl HostEnv for WithRealSsh<'_> {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        self.0.var(name)
    }
    fn which(&self, program: &str) -> Option<PathBuf> {
        self.0.which(program)
    }
    fn adapters_dir(&self) -> PathBuf {
        self.0.adapters_dir()
    }
    fn homes_dir(&self) -> PathBuf {
        self.0.homes_dir()
    }
    fn ssh_program(&self) -> Option<SshProgram> {
        self.0.ssh_program().or_else(|| crate::ssh::run::ssh_exe().map(|exe| SshProgram { exe, pre: Vec::new(), env: Vec::new() }))
    }
    fn secret_value(&self, slot: &str) -> Option<String> {
        self.0.secret_value(slot)
    }
    fn capture(&self, program: &std::path::Path, args: &[String], cwd: &std::path::Path, env: &[(std::ffi::OsString, std::ffi::OsString)]) -> Option<String> {
        self.0.capture(program, args, cwd, env)
    }
    fn cache_listings(&self) -> bool {
        self.0.cache_listings()
    }
}

/// What `ssh` is started with for a remote chat: this PC's `ssh` program and the fixed argument list (`ssh::acp`).
pub fn resolve_remote_spawn(cfg: &AgentConfig, host: &dyn HostEnv, ssh: &crate::ssh::model::SshHost, folder: &str) -> Result<SpawnSpec, AcpError> {
    let program = host.ssh_program().ok_or_else(|| AcpError::Spawn("SSH is not installed on this PC. Turn on the OpenSSH Client in Windows optional features.".into()))?;
    let spawn = crate::ssh::acp::remote_spawn(program.exe.clone(), ssh, folder, &remote_words(cfg)?).map_err(|e| AcpError::Spawn(e.sentence()))?;
    // Only what `ssh` itself needs here (its config, known hosts, keys, agent socket). Nothing of the agent's setup.
    let mut env: Vec<(OsString, OsString)> = crate::ssh::acp::SSH_ENV.iter().filter_map(|name| host.var(name).map(|v| (OsString::from(*name), v))).collect();
    env.extend(program.env.iter().cloned());
    let mut args = program.pre.clone();
    args.extend(spawn.args);
    Ok(SpawnSpec { program: spawn.exe.into_os_string(), args, env, cwd: None })
}

#[cfg(test)]
mod ssh_tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    struct Host {
        vars: BTreeMap<String, String>,
        root: PathBuf,
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
                root: std::env::temp_dir().join(format!("pm-acp-config-{}", uuid::Uuid::new_v4())),
                no_ssh: false,
            }
        }
    }

    impl HostEnv for Host {
        fn var(&self, name: &str) -> Option<OsString> {
            self.vars.get(name).map(OsString::from)
        }
        fn which(&self, _program: &str) -> Option<PathBuf> {
            None
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
        fn capture(&self, _program: &Path, _args: &[String], _cwd: &Path, _env: &[(OsString, OsString)]) -> Option<String> {
            None
        }
    }

    fn lookup(env: &[(OsString, OsString)], name: &str) -> Option<String> {
        env.iter().find(|(n, _)| n.to_string_lossy() == name).map(|(_, v)| v.to_string_lossy().into_owned())
    }

    fn ssh_box() -> crate::ssh::model::SshHost {
        crate::ssh::model::SshHost::parse("h1", "Build box", "dev@build.local", None, None).unwrap()
    }

    #[test]
    fn a_remote_chat_gets_nothing_of_this_pc() {
        let host = Host::new();
        let mut cfg = find_builtin("codex").unwrap();
        cfg.adapter_keys = vec![AdapterKey { env: "OPENAI_API_KEY".into(), slot: "slot".into() }];
        cfg.adapter_key_groups = vec![vec!["OPENAI_API_KEY".into()]];
        cfg.private_home = Some(PrivateHome { env_var: "X_HOME".into(), config_file: "c".into(), config_text: "t".into() });
        cfg.authenticate_with = Some("api-key".into());
        let remote = for_remote(&cfg).unwrap();
        assert!(remote.adapter_keys.is_empty() && remote.adapter_key_groups.is_empty());
        assert!(remote.mcp_servers.is_empty(), "the own tool server points at this PC");
        assert!(remote.private_home.is_none() && remote.authenticate_with.is_none());
        assert_eq!(remote.mcp_config.mode, McpMode::AgentDefault, "no listing is asked of the local CLI");
        assert!(remote.env.is_empty() && remote.env_allow.is_empty() && remote.env_which.is_empty());
        assert_eq!(remote.pin_policy, PinPolicy::Off);
        assert!(remote.resume_command.is_empty(), "no terminal hand-over of a far session");
        let spec = resolve_remote_spawn(&remote, &host, &ssh_box(), "/srv/my app").unwrap();
        assert!(spec.program.to_string_lossy().ends_with("ssh.exe"));
        assert!(spec.cwd.is_none(), "nothing is checked or entered on this PC");
        let args = spec.args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        // The local adapter file, the local PATH lookup result and every secret stay out of the argument list and the env.
        for needle in ["node_modules", "adapters", "codex.exe","sk-secret", "sk-other", "ghp_secret"] {
            assert!(!args.contains(needle), "{needle}");
        }
        assert!(args.contains("BatchMode=yes") && args.contains("StrictHostKeyChecking=yes"));
        for (name, value) in &spec.env {
            let (name, value) = (name.to_string_lossy(), value.to_string_lossy());
            assert!(crate::ssh::acp::SSH_ENV.contains(&name.as_ref()), "{name}");
            assert!(!value.contains("sk-") && !value.contains("ghp_"), "{name}");
        }
        assert!(lookup(&spec.env, "ANTHROPIC_API_KEY").is_none() && lookup(&spec.env, "GITHUB_TOKEN").is_none());
    }

    #[test]
    fn codex_keeps_its_read_only_start_on_the_far_machine_through_env_words() {
        let cfg = find_builtin("codex").unwrap();
        assert_eq!(cfg.remote_env.get("INITIAL_AGENT_MODE").map(String::as_str), Some("read-only"));
        let remote = for_remote(&cfg).unwrap();
        assert_eq!(remote_words(&remote).unwrap(), vec!["env".to_string(), "INITIAL_AGENT_MODE=read-only".to_string(), "codex-acp".to_string()]);
        // Only the table's own non-secret setting is sent; a bad value is refused, never passed through.
        let mut bad = remote.clone();
        bad.remote_env.insert("X".into(), "a b".into());
        assert!(remote_words(&bad).is_err());
        assert!(!problems(&AgentConfig { remote_env: bad.remote_env.clone(), command: "x".into(), ..AgentConfig::default() }).is_empty());
        let args = resolve_remote_spawn(&remote, &Host::new(), &ssh_box(), "/x").unwrap().args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(!args.contains("INITIAL_AGENT_MODE"), "the setting travels encoded, not as text");
    }

    #[test]
    fn a_remote_chat_without_a_chat_program_says_so_and_ssh_must_exist() {
        let cfg = AgentConfig { id: "x".into(), label: "Xagent".into(), command: "x".into(), ..AgentConfig::default() };
        let err = for_remote(&cfg).unwrap_err().to_string();
        assert!(err.contains("Xagent has no chat over SSH yet"), "{err}");
        let mut with = cfg.clone();
        with.remote_command = vec!["xagent".into()];
        let remote = for_remote(&with).unwrap();
        let mut no_ssh = Host::new();
        no_ssh.no_ssh = true;
        let err = resolve_remote_spawn(&remote, &no_ssh, &ssh_box(), "/x").unwrap_err().to_string();
        assert!(err.contains("SSH is not installed"), "{err}");
        let err = resolve_remote_spawn(&remote, &Host::new(), &ssh_box(), "relative").unwrap_err().to_string();
        assert!(err.contains("folder"), "{err}");
    }
}

#[cfg(test)]
mod pane_id_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_chat_sessions_own_tool_server_is_told_which_pane_it_runs_in() {
        crate::engine_hooks::install();
        let mut cfg = AgentConfig {
            mcp_servers: vec![
                json!({
                    "name": crate::mcp_install::MCP_SERVER_NAME,
                    "command": "own",
                    "args": [],
                    "env": [{"name": "EXISTING", "value": "1"}]
                }),
                json!({"name": "someone-elses", "command": "x", "args": [], "env": []}),
            ],
            ..AgentConfig::default()
        };
        add_pane_id(&mut cfg, "acp-123");
        add_pane_id(&mut cfg, "acp-123");
        let own = &cfg.mcp_servers[0]["env"].as_array().unwrap();
        let pane: Vec<_> = own.iter().filter(|e| e["name"] == crate::pty::PANE_ID_ENV).collect();
        assert_eq!(pane.len(), 1, "added once");
        assert_eq!(pane[0]["value"], json!("acp-123"));
        assert!(own.iter().any(|e| e["name"] == "EXISTING"), "the existing variables stay");
        assert!(cfg.mcp_servers[1]["env"].as_array().unwrap().is_empty(), "another server is not given our pane");
        // The chat's own key: minted once, names this pane, and only our own server gets it.
        let keys: Vec<_> = own.iter().filter(|e| e["name"] == crate::agent_authority::pane_keys::KEY_ENV).collect();
        assert_eq!(keys.len(), 1, "minted once");
        assert_eq!(crate::agent_authority::pane_keys::pane_for_key(keys[0]["value"].as_str().unwrap()).as_deref(), Some("acp-123"));
        crate::agent_authority::pane_keys::revoke("acp-123");
    }
}
