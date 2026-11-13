//! Drift and Repair (night 2026-11-13, A10). An agent the person added can update itself. When its version is not the
//! one the free check recorded, the free checks run again (version, handshake, model list: the same functions the
//! add-agent ladder uses, never a prompt). If the chat still answers, the new facts are recorded. If it does not, the
//! chat is turned off with a plain reason and the agent's page offers "Check it again", which runs the same checks.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use super::types::Level;
use super::{store, HandshakeFacts};
use crate::tui::declarative::wizard::exec::{self, RunSpec};
use crate::tui::declarative::wizard::ladder::{handshake_record, launch_of, Launch};
use crate::tui::declarative::wizard::ladder_handshake::{self as hs, Hello, HelloError, HelloSpec, NewOutcome};
use crate::tui::declarative::wizard::locate;

/// How many model names the table keeps (the ladder keeps the same).
const MODELS_MAX: usize = super::types::MAX_MODELS;

/// The two free questions drift asks of a program. A trait so a test can swap the program's version at will.
pub trait Probe {
    /// What `--version` says now. `None`: nothing readable.
    fn version(&self) -> Option<String>;
    /// `initialize` then `session/new`, nothing else.
    fn hello(&self) -> Result<Hello, HelloError>;
}

/// What a drift check decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing to do: no record to drift from, a terminal-only add, no readable version, or the same version.
    Unchanged,
    /// The version changed (or a re-check was asked for) and the chat still answers; the facts were recorded.
    Passed { version: Option<String> },
    /// The chat no longer answers; it is off and the reason is recorded.
    ChatOff { reason: String },
}

/// The real program of an agent: its chat table's launch line.
pub struct LaunchProbe {
    pub launch: Launch,
}

impl LaunchProbe {
    /// `None` when the agent has no chat table or its program cannot be resolved.
    pub fn for_agent(agent_id: &str) -> Option<Self> {
        let table = crate::tui::profile_for(agent_id).acp_table()?;
        Some(Self { launch: launch_of(&table).ok()? })
    }
}

impl Probe for LaunchProbe {
    fn version(&self) -> Option<String> {
        let args = vec!["--version".to_string()];
        let cwd = std::env::temp_dir();
        let vars = locate::probe_env();
        let mut spec = RunSpec::new(&self.launch.program, &args, &cwd);
        spec.env = &vars;
        spec.timeout = Duration::from_secs(5);
        spec.max_bytes = 8 * 1024;
        let out = exec::run(&spec);
        if out.exit != Some(0) {
            return None;
        }
        locate::version_number(&exec::clean(&format!("{}\n{}", out.stdout, out.stderr)))
    }

    fn hello(&self) -> Result<Hello, HelloError> {
        let cancel = AtomicBool::new(false);
        hs::hello(&HelloSpec {
            program: &self.launch.program,
            args: &self.launch.args,
            extra_env: &self.launch.extra_env,
            init_timeout: Duration::from_secs(20),
            new_timeout: Duration::from_secs(20),
            cancel: &cancel,
            on_start: &|_| {},
        })
    }
}

/// The reason shown to the person. Plain words, no protocol names.
fn plain_reason(version: Option<&str>, why: &str) -> String {
    match version {
        Some(v) => format!("Updated to {v}, and its chat {why}."),
        None => format!("It changed, and its chat {why}."),
    }
}

/// Run the free checks if the version moved (or `force`). Writes only to `dir`.
pub fn check_in(dir: &Path, agent_id: &str, probe: &dyn Probe, force: bool) -> Verdict {
    let stored = store::load(dir, agent_id).handshake;
    if stored.as_ref().is_some_and(|h| h.terminal_only) {
        return Verdict::Unchanged; // chat was never claimed, so there is nothing to break
    }
    if stored.is_none() && !force {
        return Verdict::Unchanged;
    }
    let now = probe.version();
    if !force {
        let was = stored.as_ref().and_then(|h| h.program_version.clone());
        if now.is_none() || now == was {
            return Verdict::Unchanged;
        }
    }
    let version = now.or_else(|| stored.as_ref().and_then(|h| h.program_version.clone()));
    match probe.hello() {
        Err(HelloError::Cancelled) => Verdict::Unchanged,
        Ok(hello) if hello.new != NewOutcome::Refused => {
            let models = match &hello.new {
                NewOutcome::Answered(result) => hs::models_of(result, MODELS_MAX),
                _ => None,
            };
            let record = handshake_record(Level::L0, version.clone(), Some(&hello), models.as_ref(), false);
            match super::record_handshake_in(dir, agent_id, &record) {
                Ok(()) => Verdict::Passed { version },
                Err(_) => Verdict::Unchanged,
            }
        }
        Ok(_) => turn_off(dir, agent_id, version, "would not open a session"),
        Err(HelloError::Silent) => turn_off(dir, agent_id, version, "did not answer"),
        Err(HelloError::Bad(_)) => turn_off(dir, agent_id, version, "gave an answer Potato does not understand"),
    }
}

/// Chat off, with the reason. What was seen in earlier turns stays; only the free-check record changes.
fn turn_off(dir: &Path, agent_id: &str, version: Option<String>, why: &str) -> Verdict {
    let reason = plain_reason(version.as_deref(), why);
    let record = HandshakeFacts {
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        program_version: version,
        init_ok: false,
        no_chat_reason: Some(reason.clone()),
        drifted: true,
        ..Default::default()
    };
    let _ = store::update(dir, agent_id, |f| f.handshake = Some(record));
    Verdict::ChatOff { reason }
}

/// "Check it again": always runs the checks, on the app's real store. Returns the table as it stands afterwards.
pub fn check_again(agent_id: &str) -> Result<serde_json::Value, String> {
    let probe = LaunchProbe::for_agent(agent_id).ok_or_else(|| "This agent has no chat to check.".to_string())?;
    check_in(&store::default_dir(), agent_id, &probe, true);
    super::notify(agent_id);
    Ok(super::caps_json(agent_id))
}

/// At start: every agent with a recorded chat gets a version look, off the main thread. Cheap when nothing changed.
pub fn spawn_startup_check() {
    std::thread::spawn(|| {
        let dir: PathBuf = store::default_dir();
        for id in crate::tui::registered_agent_ids() {
            if store::load(&dir, &id).handshake.is_none() {
                continue;
            }
            let Some(probe) = LaunchProbe::for_agent(&id) else { continue };
            if check_in(&dir, &id, &probe, false) != Verdict::Unchanged {
                super::notify(&id);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_caps::types::{Source, Tri};
    use parking_lot::Mutex;

    /// A fake program: its version is whatever the test says, and it answers the hello like the fake ACP agent
    /// (a real child process) or, when broken, like a program that never starts.
    struct FakeProgram {
        version: Mutex<Option<String>>,
        broken: Mutex<bool>,
        store: PathBuf,
    }

    impl Probe for FakeProgram {
        fn version(&self) -> Option<String> {
            self.version.lock().clone()
        }
        fn hello(&self) -> Result<Hello, HelloError> {
            let cfg = crate::acp::fake_agent::agent_config("", &self.store);
            let mut launch = launch_of(&cfg).unwrap();
            if *self.broken.lock() {
                launch.program = self.store.join("no-such-program");
            }
            LaunchProbe { launch }.hello()
        }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-drift-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake(dir: &Path, version: &str) -> FakeProgram {
        FakeProgram { version: Mutex::new(Some(version.into())), broken: Mutex::new(false), store: dir.join("store") }
    }

    fn recorded(dir: &Path, id: &str, version: &str) {
        let hs = HandshakeFacts { at: "2026-11-13T01:00:00Z".into(), program_version: Some(version.into()), init_ok: true, protocol_version: Some(1), session_new_ok: true, ..Default::default() };
        crate::agent_caps::record_handshake_in(dir, id, &hs).unwrap();
    }

    #[test]
    fn drift_flips_chip_and_repair_passes() {
        let dir = temp("flip");
        let prog = fake(&dir, "1.0.0");
        recorded(&dir, "fakedrift", "1.0.0");

        // Same version: nothing runs, nothing changes.
        assert_eq!(check_in(&dir, "fakedrift", &prog, false), Verdict::Unchanged);
        assert!(!crate::agent_caps::for_agent_in(&dir, "fakedrift").needs_repair);

        // The program updates and its chat breaks: the chip flips to No with a plain reason.
        *prog.version.lock() = Some("2.0.0".into());
        *prog.broken.lock() = true;
        let verdict = check_in(&dir, "fakedrift", &prog, false);
        let Verdict::ChatOff { reason } = verdict else { panic!("expected the chat to go off, got {verdict:?}") };
        assert!(reason.contains("2.0.0") && reason.contains("did not answer"), "{reason}");
        let caps = crate::agent_caps::for_agent_in(&dir, "fakedrift");
        assert_eq!((caps.chat.value, caps.chat.source), (Tri::No, Source::Check));
        assert_eq!(caps.chat.proof, reason);
        assert!(caps.needs_repair);
        assert_eq!(caps.program_version.as_deref(), Some("2.0.0"));

        // The new version is recorded, so a plain look does not retry on its own.
        assert_eq!(check_in(&dir, "fakedrift", &prog, false), Verdict::Unchanged);
        assert!(crate::agent_caps::for_agent_in(&dir, "fakedrift").needs_repair);

        // The person fixes it and presses "Check it again": the checks run, the chat is back.
        *prog.broken.lock() = false;
        assert_eq!(check_in(&dir, "fakedrift", &prog, true), Verdict::Passed { version: Some("2.0.0".into()) });
        let caps = crate::agent_caps::for_agent_in(&dir, "fakedrift");
        assert_eq!((caps.chat.value, caps.chat.source), (Tri::Yes, Source::Handshake));
        assert!(!caps.needs_repair);
        assert_eq!(caps.models, ["a", "b"]);
    }

    #[test]
    fn a_new_version_that_still_chats_is_recorded_without_a_scare() {
        let dir = temp("ok");
        let prog = fake(&dir, "3.1.0");
        recorded(&dir, "fakedrift", "3.0.0");
        assert_eq!(check_in(&dir, "fakedrift", &prog, false), Verdict::Passed { version: Some("3.1.0".into()) });
        let caps = crate::agent_caps::for_agent_in(&dir, "fakedrift");
        assert_eq!(caps.program_version.as_deref(), Some("3.1.0"));
        assert_eq!(caps.chat.value, Tri::Yes);
    }

    #[test]
    fn no_record_or_terminal_only_means_nothing_to_drift_from() {
        let dir = temp("none");
        let prog = fake(&dir, "9.9.9");
        assert_eq!(check_in(&dir, "fakedrift", &prog, false), Verdict::Unchanged);
        let hs = HandshakeFacts { terminal_only: true, program_version: Some("1.0.0".into()), ..Default::default() };
        crate::agent_caps::record_handshake_in(&dir, "faketerm", &hs).unwrap();
        assert_eq!(check_in(&dir, "faketerm", &prog, true), Verdict::Unchanged);
    }
}
