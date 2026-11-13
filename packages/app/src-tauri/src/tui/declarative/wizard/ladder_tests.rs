//! The add-agent ladder (`ladder.rs`, `ladder_handshake.rs`, `ladder_save.rs`) against fakes only: the fake ACP
//! agent (`acp::fake_agent`, this test binary started again), the wizard's fake CLI as a plain program, a temp PATH
//! folder and a temp agents folder. No real agent, no network, no window. Every test sets its own tree.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::acp::adapter_catalog::AdapterEntry;
use crate::acp::config::AgentConfig;
use crate::acp::registry::{self, Choice, Registry, RegistryAgent};
use crate::agent_caps::types::{AgentCaps, Level, Source, Tri};
use crate::tui::declarative::wizard::ladder::{
    error_for, AddAgentRun, AddonPlan, Backends, CatalogHit, HandshakeRecord, InstallPlanView, Ladder, LadderCfg, RunState, StepState,
};
use crate::tui::declarative::wizard::ladder_save as save;
use crate::tui::declarative::wizard::session::WizardEnv;

use super::tests::support::{bin_dir, Tree};

const BANNED: [&str; 10] = ["acp", "adapter", "toml", "pty", "probe", "definition", "handshake", "registry", "headless", "tui"];

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

// ---- the fakes behind the ladder ----------------------------------------------------------------------------

struct Fakes {
    env: WizardEnv,
    catalog: Mutex<Vec<CatalogHit>>,
    registry: Registry,
    chat: Mutex<HashMap<String, AgentConfig>>,
    plans: Mutex<HashMap<String, InstallPlanView>>,
    addon: Mutex<Option<AgentConfig>>,
    chat_on: AtomicBool,
    installs: AtomicUsize,
    install_fails: AtomicBool,
    /// The install waits until the person cancels (it honours the cancel flag like the real one).
    install_blocks: AtomicBool,
    /// Where the capability store of this test lives (the real store code, a temp folder).
    caps_dir: PathBuf,
    records: Mutex<Vec<(String, HandshakeRecord)>>,
}

impl Fakes {
    fn caps_dir_caps(&self, id: &str) -> AgentCaps {
        crate::agent_caps::for_agent_in(&self.caps_dir, id)
    }
}

impl Backends for Fakes {
    fn catalog_lookup(&self, name: &str) -> Option<CatalogHit> {
        self.catalog.lock().iter().find(|c| c.id == name || c.names.iter().any(|n| n == name)).cloned()
    }
    fn registry(&self) -> Registry {
        self.registry.clone()
    }
    fn adapters_for(&self, _program: &str) -> Vec<AdapterEntry> {
        Vec::new()
    }
    fn is_registered(&self, id: &str) -> bool {
        self.env.agents_dir.join(format!("{id}.toml")).exists()
    }
    fn chat_enabled(&self) -> bool {
        self.chat_on.load(Ordering::SeqCst)
    }
    fn program_install_plan(&self, id: &str) -> Option<InstallPlanView> {
        self.plans.lock().get(id).cloned()
    }
    fn shipped_chat(&self, id: &str) -> Option<AgentConfig> {
        self.chat.lock().get(id).cloned()
    }
    fn addon_plan(&self, agent: &RegistryAgent, _choice: &Choice) -> AddonPlan {
        AddonPlan {
            registry_id: Some(agent.id.clone()),
            view: InstallPlanView { what_will_run: vec!["npm install fakereg-acp@1.0.0".into()], source_host: "registry.npmjs.org".into(), can_install: true },
        }
    }
    fn install_addon(&self, _plan: &AddonPlan, _agent_id: &str, _label: &str, cancel: &AtomicBool) -> Result<AgentConfig, String> {
        self.installs.fetch_add(1, Ordering::SeqCst);
        if self.install_blocks.load(Ordering::SeqCst) {
            let until = Instant::now() + Duration::from_secs(60);
            while !cancel.load(Ordering::SeqCst) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            return Err("stopped".into());
        }
        if self.install_fails.load(Ordering::SeqCst) {
            return Err("npm failed".into());
        }
        self.addon.lock().clone().ok_or_else(|| "no add-on".to_string())
    }
    fn catalog_add(&self, id: &str) -> Result<(), String> {
        let hit = self.catalog_lookup(id).ok_or("not in the catalog")?;
        let mut written = save::write_terminal(&self.env, id, &hit.label, &hit.names[0])?;
        save::approve(&self.env, &mut written, id, &["store".to_string()])?;
        Ok(())
    }
    fn catalog_remove(&self, id: &str) {
        save::undo(
            &self.env,
            &save::Written {
                files: vec![self.env.agents_dir.join(format!("{id}.toml")), self.env.agents_dir.join(format!("{id}.wizard.json"))],
                definition: None,
                approval_id: Some(id.to_string()),
                catalog_id: None,
            },
        );
    }
    fn reload(&self) {}
    fn record_handshake(&self, agent_id: &str, facts: &HandshakeRecord) -> Result<(), String> {
        self.records.lock().push((agent_id.to_string(), facts.clone()));
        crate::agent_caps::record_handshake_in(&self.caps_dir, agent_id, facts)
    }
    fn caps_of(&self, agent_id: &str) -> AgentCaps {
        crate::agent_caps::for_agent_in(&self.caps_dir, agent_id)
    }
}

const REGISTRY: &str = r#"{"version":"1","agents":[{"id":"fakereg","name":"Fakereg","version":"1.0.0","distribution":{"npx":{"package":"fakereg-acp@1.0.0","args":[]}}}]}"#;

struct Rig {
    tree: Tree,
    bin: PathBuf,
    fakes: Arc<Fakes>,
    ladder: Arc<Ladder>,
    frames: Arc<Mutex<Vec<AddAgentRun>>>,
}

impl Rig {
    fn new(name: &str) -> Self {
        Self::with(name, |_| ())
    }

    fn with(name: &str, change: impl FnOnce(&mut LadderCfg)) -> Self {
        let tree = Tree::new(name);
        let bin = tree.root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let mut env = tree.env();
        env.path_dirs = Some(vec![bin.clone()]);
        let fakes = Arc::new(Fakes {
            env: env.clone(),
            catalog: Mutex::new(Vec::new()),
            registry: registry::parse(REGISTRY).unwrap(),
            chat: Mutex::new(HashMap::new()),
            plans: Mutex::new(HashMap::new()),
            addon: Mutex::new(None),
            chat_on: AtomicBool::new(true),
            installs: AtomicUsize::new(0),
            install_fails: AtomicBool::new(false),
            install_blocks: AtomicBool::new(false),
            caps_dir: tree.root.join("agent-caps"),
            records: Mutex::new(Vec::new()),
        });
        let frames: Arc<Mutex<Vec<AddAgentRun>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = frames.clone();
        let mut cfg = LadderCfg { init: Duration::from_secs(30), session_new: Duration::from_secs(30), total: Duration::from_secs(90), ..LadderCfg::default() };
        change(&mut cfg);
        let env2 = env.clone();
        let ladder = Ladder::new(Arc::new(move || env2.clone()), fakes.clone(), Arc::new(move |run: &AddAgentRun| sink.lock().push(run.clone())), cfg);
        Rig { tree, bin, fakes, ladder, frames }
    }

    /// A program of this name on the temp PATH (the wizard's fake CLI under another name).
    fn program(&self, name: &str) -> PathBuf {
        let to = self.bin.join(name);
        std::fs::copy(bin_dir().join(exe_name("fake-agent")), &to).expect("copy the fake cli");
        to
    }

    fn catalog(&self, id: &str, label: &str, names: &[&str]) {
        self.fakes.catalog.lock().push(CatalogHit {
            id: id.into(),
            label: label.into(),
            names: names.iter().map(|n| n.to_string()).collect(),
            has_chat: false,
            has_headless: false,
        });
    }

    /// The fake ACP agent as this agent's shipped chat table.
    fn chat(&self, id: &str, opts: &str) {
        let store = self.tree.root.join(format!("store-{id}"));
        self.fakes.chat.lock().insert(id.into(), crate::acp::fake_agent::agent_config(opts, &store));
    }

    fn wait(&self, run_id: &str) -> AddAgentRun {
        let until = Instant::now() + Duration::from_secs(120);
        loop {
            let run = self.ladder.status(run_id).expect("the run exists");
            if run.state != RunState::Checking {
                return run;
            }
            assert!(Instant::now() < until, "the run never ended: {run:?}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn add(&self, input: &str, terminal_only: bool) -> AddAgentRun {
        let started = self.ladder.start(input, terminal_only).expect("start");
        assert_eq!(started.state, RunState::Checking);
        self.wait(&started.run_id)
    }

    fn step<'a>(&self, run: &'a AddAgentRun, id: &str) -> &'a crate::tui::declarative::wizard::ladder::StepRun {
        run.steps.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("no step {id}"))
    }

    fn agents_files(&self) -> Vec<String> {
        std::fs::read_dir(&self.tree.agents).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
    }

    fn approvals_text(&self) -> String {
        std::fs::read_to_string(self.tree.root.join("agent-approvals.json")).unwrap_or_default()
    }
}

/// Invariants 1-3 of the capability contract (1.2), checked on what a finished add returns.
fn caps_problems(caps: &AgentCaps) -> Vec<String> {
    let mut out = Vec::new();
    let all = [
        ("level_proof", &caps.level_proof),
        ("chat", &caps.chat),
        ("resume", &caps.resume),
        ("shows_steps", &caps.shows_steps),
        ("edits_files", &caps.edits_files),
        ("asks_before_edit", &caps.asks_before_edit),
        ("asks_before_shell", &caps.asks_before_shell),
        ("model_pick", &caps.model_pick),
        ("stop", &caps.stop),
        ("images", &caps.images),
        ("usage", &caps.usage),
        ("read_only", &caps.read_only),
    ];
    for (name, cap) in all {
        if cap.value != Tri::Unknown && (cap.source == Source::Unknown || cap.proof.is_empty() || cap.at.is_none()) {
            out.push(format!("{name}: a value without a source, proof or time"));
        }
        if cap.source == Source::Unknown && cap.value != Tri::Unknown {
            out.push(format!("{name}: no source but a value"));
        }
    }
    if caps.model_pick.value == Tri::Yes && caps.models.is_empty() {
        out.push("model_pick yes with no models".into());
    }
    if caps.chat.value == Tri::No && caps.level != Level::L5 {
        out.push("chat no but not level l5".into());
    }
    out
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).creation_flags(0x0800_0000).output().expect("tasklist runs");
    String::from_utf8_lossy(&out.stdout).split_whitespace().any(|word| word == pid.to_string())
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

// ---- the free path ------------------------------------------------------------------------------------------

#[test]
fn fake_acp_agent_ready_in_one_click_zero_model_calls() {
    let rig = Rig::new("native");
    rig.program(&exe_name("fakenat"));
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    let started = rig.ladder.start("fakenat", false).unwrap();
    assert_eq!(started.state, RunState::Checking, "start returns at once");
    let run = rig.wait(&started.run_id);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    let result = run.result.as_ref().expect("a result");
    assert_eq!((result.mode, result.sign_in_needed, result.already_added), ("chat", false, false));
    assert_eq!(rig.ladder.requests_sent(&run.run_id), ["initialize", "session/new"], "no prompt, ever");
    let caps = &result.caps;
    assert_eq!((caps.level, caps.chat.value, caps.chat.source), (Level::L0, Tri::Yes, Source::Handshake));
    assert_eq!(caps.models, ["a", "b"]);
    assert_eq!((caps.model_pick.value, caps.resume.value, caps.images.value), (Tri::Yes, Tri::Yes, Tri::Yes));
    assert_eq!(caps.usage.value, Tri::Unknown, "not seen yet");
    assert!(rig.approvals_text().contains("fakenat"), "the approval is recorded: {}", rig.approvals_text());
    let records = rig.fakes.records.lock();
    assert_eq!(records.len(), 1);
    assert_eq!((records[0].0.as_str(), records[0].1.models_total, records[0].1.init_ok), ("fakenat", 2, true));
    assert_eq!(rig.ladder.status(&run.run_id).unwrap().state, RunState::Done, "no second call is needed");
    for pid in rig.ladder.child_pids() {
        assert!(!process_alive(pid), "the hello child {pid} is gone");
    }
}

#[test]
fn terminal_only_program_is_added_without_handshake() {
    let rig = Rig::new("terminal");
    rig.program(&exe_name("faketerm"));
    let run = rig.add("faketerm", false);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    let result = run.result.as_ref().unwrap();
    assert_eq!((result.mode, result.agent_id.as_str(), result.label.as_str()), ("terminal", "faketerm", "Faketerm"));
    assert!(rig.ladder.requests_sent(&run.run_id).is_empty());
    assert_eq!((result.caps.level, result.caps.chat.value, result.caps.chat.source), (Level::L5, Tri::No, Source::Check), "every step said no: that is a real No");
    assert_eq!(rig.step(&run, "handshake").state, StepState::Skipped);
    assert_eq!(rig.step(&run, "models").state, StepState::Skipped);
    let text = std::fs::read_to_string(rig.tree.agents.join("faketerm.toml")).unwrap();
    assert!(text.contains("kind = \"generic\"") && !text.contains("[acp]"), "{text}");
    assert!(rig.approvals_text().contains("faketerm"));
    assert!(rig.fakes.records.lock().iter().all(|(_, r)| !r.init_ok), "no hello facts for a terminal-only agent");
}

#[test]
fn unknown_name_fails_with_plain_message() {
    let rig = Rig::new("unknown");
    let run = rig.add("zzzzunknown", false);
    assert_eq!(run.state, RunState::Failed);
    let error = run.error.as_ref().unwrap();
    assert_eq!((error.code.as_str(), error.action, error.step), ("ADD_UNKNOWN_NAME", "retry", Some("find")));
    assert_eq!(error.message, "Potato could not find zzzzunknown on this computer.");
    assert!(rig.agents_files().is_empty());
    let bad = rig.add("two words that mean nothing", false);
    assert_eq!(bad.error.as_ref().unwrap().code, "ADD_BAD_INPUT");
    assert_eq!(bad.error.as_ref().unwrap().message, "Type one agent name, like kimi.");
}

#[test]
fn known_but_missing_program_needs_install_and_runs_nothing() {
    let rig = Rig::new("missing");
    rig.catalog("fakegone", "Fakegone", &["fakegone-zz"]);
    rig.fakes.plans.lock().insert("fakegone".into(), InstallPlanView { what_will_run: vec!["npm install -g fakegone".into()], source_host: "registry.npmjs.org".into(), can_install: false });
    let run = rig.add("fakegone", false);
    assert_eq!(run.state, RunState::NeedsInstall, "{run:?}");
    let install = run.install.as_ref().unwrap();
    assert_eq!((install.kind, install.can_install, install.label.as_str()), ("program", false, "Fakegone"));
    assert_eq!(install.what_will_run, ["npm install -g fakegone"]);
    assert_eq!(rig.fakes.installs.load(Ordering::SeqCst), 0);
    assert!(rig.agents_files().is_empty(), "nothing was written");
    let again = rig.ladder.approve_install(&run.run_id).unwrap();
    assert_eq!(again.state, RunState::NeedsInstall, "a program the app cannot install tonight is shown, not run");
    assert_eq!(rig.fakes.installs.load(Ordering::SeqCst), 0);
}

#[test]
fn install_runs_only_after_approve() {
    let rig = Rig::new("install");
    rig.program(&exe_name("fakereg"));
    *rig.fakes.addon.lock() = Some(crate::acp::fake_agent::agent_config("", &rig.tree.root.join("store-reg")));
    let run = rig.add("fakereg", false);
    assert_eq!(run.state, RunState::NeedsInstall, "{run:?}");
    let install = run.install.as_ref().unwrap();
    assert_eq!((install.kind, install.can_install, install.source_host.as_str()), ("chat_addon", true, "registry.npmjs.org"));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(rig.fakes.installs.load(Ordering::SeqCst), 0, "nothing runs before the person says yes");
    assert!(rig.agents_files().is_empty());
    let after = rig.ladder.approve_install(&run.run_id).unwrap();
    assert_eq!(after.state, RunState::Checking);
    assert_eq!(after.steps[0].id, "install");
    let done = rig.wait(&run.run_id);
    assert_eq!(done.state, RunState::Done, "{done:?}");
    assert_eq!(rig.fakes.installs.load(Ordering::SeqCst), 1);
}

#[test]
fn registry_addon_asks_once_then_finishes() {
    let rig = Rig::new("addon-once");
    rig.program(&exe_name("fakereg"));
    *rig.fakes.addon.lock() = Some(crate::acp::fake_agent::agent_config("", &rig.tree.root.join("store-reg")));
    let run = rig.add("fakereg", false);
    assert_eq!(run.state, RunState::NeedsInstall);
    rig.ladder.approve_install(&run.run_id).unwrap();
    let done = rig.wait(&run.run_id);
    assert_eq!(done.state, RunState::Done, "{done:?}");
    let asked = rig.frames.lock().iter().filter(|f| f.state == RunState::NeedsInstall).map(|f| f.install.clone()).collect::<Vec<_>>();
    assert!(!asked.is_empty() && asked.iter().all(|a| a == &asked[0]), "the same single question every time it is shown");
    let after_yes = rig.frames.lock().iter().skip_while(|f| f.state != RunState::Checking || f.steps[0].id != "install").filter(|f| f.state == RunState::NeedsInstall).count();
    assert_eq!(after_yes, 0, "no second question after the yes");
    let result = done.result.unwrap();
    assert_eq!((result.mode, result.caps.level, result.caps.chat.value), ("chat", Level::L0, Tri::Yes), "the table decides the level (spec 1.3: l1 needs a reviewed adapter hit)");
    assert_eq!(rig.ladder.requests_sent(&done.run_id), ["initialize", "session/new"]);
    assert_eq!(rig.step(&rig.ladder.status(&done.run_id).unwrap(), "install").state, StepState::Done);
}

#[test]
fn a_failed_install_ends_in_one_plain_error() {
    let rig = Rig::new("install-fails");
    rig.program(&exe_name("fakereg"));
    rig.fakes.install_fails.store(true, Ordering::SeqCst);
    let run = rig.add("fakereg", false);
    rig.ladder.approve_install(&run.run_id).unwrap();
    let failed = rig.wait(&run.run_id);
    let error = failed.error.as_ref().expect("an error");
    assert_eq!((error.code.as_str(), error.message.as_str(), error.action), ("ADD_INSTALL_FAILED", "The install did not finish.", "show_install"));
    assert!(rig.agents_files().is_empty());
}

#[test]
fn chat_off_is_a_plain_error_when_a_chat_way_exists() {
    let rig = Rig::new("chat-off");
    rig.program(&exe_name("fakenat"));
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    rig.fakes.chat_on.store(false, Ordering::SeqCst);
    let run = rig.add("fakenat", false);
    let error = run.error.as_ref().expect("an error");
    assert_eq!((error.code.as_str(), error.action), ("ADD_CHAT_OFF", "open_labs"));
    assert!(rig.ladder.requests_sent(&run.run_id).is_empty());
}

// ---- the hello fails or is slow -----------------------------------------------------------------------------

#[test]
fn silent_agent_fails_within_limit_and_offers_terminal() {
    let rig = Rig::with("silent", |c| {
        c.init = Duration::from_secs(30);
        c.session_new = Duration::from_millis(1500);
    });
    rig.program(&exe_name("fakemute"));
    rig.catalog("fakemute", "Fakemute", &["fakemute"]);
    rig.chat("fakemute", "deaf_ms=20000");
    let began = Instant::now();
    let run = rig.add("fakemute", false);
    let error = run.error.as_ref().expect("an error");
    assert_eq!((error.code.as_str(), error.action, error.step), ("ADD_HANDSHAKE_SILENT", "use_terminal", Some("handshake")));
    assert_eq!(error.message, "Fakemute did not answer in time.");
    assert!(began.elapsed() < Duration::from_secs(60), "{:?}", began.elapsed());
    assert!(rig.agents_files().is_empty(), "nothing was written");
    for pid in rig.ladder.child_pids() {
        assert!(!process_alive(pid), "the silent child {pid} was stopped");
    }
    let terminal = rig.add("fakemute", true);
    assert_eq!(terminal.state, RunState::Done, "{terminal:?}");
    assert_eq!(terminal.result.unwrap().mode, "terminal");
}

/// A program that answers `initialize` with something that is not a result. (Local double: the shared fake has no
/// switch for it. Wanted switch for the fake agent: `bad_init=1`.)
#[test]
#[ignore]
fn fake_bad_init() {
    use std::io::{BufRead, Write};
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    println!("{}", r#"{"jsonrpc":"2.0","id":1,"result":{"ready":true}}"#);
    let _ = std::io::stdout().flush();
    std::thread::sleep(Duration::from_secs(20));
}

fn bad_agent_config() -> AgentConfig {
    let module = module_path!().split_once("::").map_or(module_path!(), |(_, rest)| rest);
    AgentConfig {
        id: "fakeodd".into(),
        label: "Fakeodd".into(),
        command: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
        args: vec!["--ignored".into(), "--exact".into(), format!("{module}::fake_bad_init"), "--nocapture".into()],
        ..AgentConfig::default()
    }
}

#[test]
fn bad_initialize_reply_is_handshake_bad() {
    let rig = Rig::new("bad-init");
    rig.program(&exe_name("fakeodd"));
    rig.catalog("fakeodd", "Fakeodd", &["fakeodd"]);
    rig.fakes.chat.lock().insert("fakeodd".into(), bad_agent_config());
    let run = rig.add("fakeodd", false);
    let error = run.error.as_ref().expect("an error");
    assert_eq!((error.code.as_str(), error.action), ("ADD_HANDSHAKE_BAD", "use_terminal"));
    assert_eq!(error.message, "Fakeodd answered in a way Potato does not understand.");
    assert_eq!(rig.ladder.requests_sent(&run.run_id).len(), 0, "session/new is never sent after a bad initialize");
    assert!(rig.agents_files().is_empty());
}

#[test]
fn slow_start_still_succeeds() {
    let rig = Rig::new("slow");
    rig.program(&exe_name("fakeslow"));
    rig.catalog("fakeslow", "Fakeslow", &["fakeslow"]);
    rig.chat("fakeslow", "init_delay_ms=300");
    let run = rig.add("fakeslow", false);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    assert!(rig.step(&run, "handshake").elapsed_ms.unwrap_or(0) >= 300);
}

#[test]
fn auth_needed_on_session_new_is_done_with_sign_in() {
    let rig = Rig::new("auth");
    rig.program(&exe_name("fakeauth"));
    rig.catalog("fakeauth", "Fakeauth", &["fakeauth"]);
    rig.chat("fakeauth", "auth=1");
    let run = rig.add("fakeauth", false);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    let result = run.result.as_ref().unwrap();
    assert!(result.sign_in_needed && run.error.is_none());
    assert_eq!(result.caps.model_pick.value, Tri::Unknown, "no models without a session");
    assert!(result.caps.models.is_empty());
    assert_eq!(rig.step(&run, "models").state, StepState::Skipped);
    assert_eq!(rig.ladder.requests_sent(&run.run_id), ["initialize", "session/new"]);
}

// ---- cancel, repeat, busy -----------------------------------------------------------------------------------

#[test]
fn cancel_kills_child_and_writes_nothing() {
    let rig = Rig::new("cancel");
    rig.program(&exe_name("fakeslow"));
    rig.catalog("fakeslow", "Fakeslow", &["fakeslow"]);
    rig.chat("fakeslow", "init_delay_ms=60000");
    let started = rig.ladder.start("fakeslow", false).unwrap();
    let until = Instant::now() + Duration::from_secs(60);
    while rig.ladder.child_pids().is_empty() {
        assert!(Instant::now() < until, "the child never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    let frames_before = rig.frames.lock().len();
    let cancelled = rig.ladder.cancel(&started.run_id).unwrap();
    assert_eq!(cancelled.state, RunState::Cancelled, "{cancelled:?}");
    assert!(cancelled.error.is_none() && cancelled.result.is_none());
    assert!(rig.agents_files().is_empty(), "{:?}", rig.agents_files());
    assert!(!rig.approvals_text().contains("fakeslow"));
    for pid in rig.ladder.child_pids() {
        assert!(!process_alive(pid), "the child {pid} is gone");
    }
    let cancelled_frames = rig.frames.lock().iter().skip(frames_before).filter(|f| f.state == RunState::Cancelled).count();
    assert_eq!(cancelled_frames, 1, "emitted once");
    assert_eq!(rig.ladder.cancel(&started.run_id).unwrap().state, RunState::Cancelled, "a second cancel changes nothing");
}

#[test]
fn cancel_after_done_changes_nothing() {
    let rig = Rig::new("cancel-done");
    rig.program(&exe_name("faketerm"));
    let run = rig.add("faketerm", false);
    assert_eq!(run.state, RunState::Done);
    let after = rig.ladder.cancel(&run.run_id).unwrap();
    assert_eq!(after.state, RunState::Done);
    assert!(rig.tree.agents.join("faketerm.toml").exists());
}

#[test]
fn already_added_is_refused_and_never_overwrites() {
    let rig = Rig::new("twice");
    rig.program(&exe_name("faketerm"));
    let first = rig.add("faketerm", false);
    assert_eq!(first.state, RunState::Done);
    let file = rig.tree.agents.join("faketerm.toml");
    let before = std::fs::read(&file).unwrap();
    let second = rig.add("faketerm", false);
    let error = second.error.as_ref().expect("an error");
    assert_eq!((error.code.as_str(), error.action, error.message.as_str()), ("ADD_ALREADY_ADDED", "open_agent", "Faketerm is already added."));
    assert_eq!(std::fs::read(&file).unwrap(), before, "the file is byte for byte the same");
    // Even when the registry does not know the id yet, the ladder's own save refuses a taken file.
    assert!(save::write_terminal(&rig.fakes.env, "faketerm", "Other", "faketerm").is_err());
}

#[test]
fn uppercase_exe_extension_is_lowered() {
    if !cfg!(windows) {
        return;
    }
    let rig = Rig::new("upper");
    rig.program("Upprog.EXE");
    let run = rig.add("upprog", true);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    let detail = rig.step(&run, "find").detail.clone().unwrap();
    assert!(detail.to_ascii_lowercase().ends_with("upprog.exe"), "{detail}");
    assert!(detail.ends_with(".exe"), "the extension is lower case: {detail}");
}

#[test]
fn second_start_while_checking_is_busy() {
    let rig = Rig::new("busy");
    rig.program(&exe_name("fakeslow"));
    rig.program(&exe_name("faketerm"));
    rig.catalog("fakeslow", "Fakeslow", &["fakeslow"]);
    rig.chat("fakeslow", "init_delay_ms=60000");
    let first = rig.ladder.start("fakeslow", false).unwrap();
    let error = rig.ladder.start("faketerm", false).unwrap_err();
    assert!(error.starts_with("ADD_BUSY: Potato is already adding an agent."), "{error}");
    rig.ladder.cancel(&first.run_id).unwrap();
    assert_eq!(rig.add("faketerm", false).state, RunState::Done, "a new run is fine once the first ended");
}

#[test]
fn terminal_only_flag_skips_chat_steps() {
    let rig = Rig::new("flag");
    rig.program(&exe_name("fakenat"));
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    let run = rig.add("fakenat", true);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    assert_eq!(run.result.as_ref().unwrap().mode, "terminal");
    assert!(rig.ladder.requests_sent(&run.run_id).is_empty(), "no hello was sent");
    assert_eq!(rig.step(&run, "chat_way").state, StepState::Done);
    assert_eq!((rig.step(&run, "handshake").state, rig.step(&run, "models").state), (StepState::Skipped, StepState::Skipped));
    assert!(rig.ladder.child_pids().is_empty(), "no child was started");
}

// ---- the payload --------------------------------------------------------------------------------------------

#[test]
fn steps_are_complete_and_ordered_from_first_event() {
    let rig = Rig::new("steps");
    rig.program(&exe_name("fakenat"));
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    let run = rig.add("fakenat", false);
    assert_eq!(run.state, RunState::Done);
    let frames = rig.frames.lock();
    let order = ["find", "version", "chat_way", "handshake", "models", "save"];
    assert!(frames.len() > order.len(), "an event per step change");
    for frame in frames.iter() {
        let ids: Vec<&str> = frame.steps.iter().map(|s| s.id).collect();
        assert_eq!(ids, order, "every event holds all steps in order");
    }
    assert!(frames[0].steps.iter().all(|s| s.state == StepState::Pending), "the first event shows the whole list as pending");
    assert_eq!(frames[0].state, RunState::Checking);
    let last = frames.last().unwrap();
    assert!(last.steps.iter().all(|s| matches!(s.state, StepState::Done | StepState::Skipped)), "{:?}", last.steps);
    assert!(last.steps.iter().all(|s| s.started_ms.is_some() && s.elapsed_ms.is_some() && s.limit_ms > 0 || s.id == "models"));
}

#[test]
fn every_error_message_is_plain() {
    let codes = [
        "ADD_BAD_INPUT",
        "ADD_UNKNOWN_NAME",
        "ADD_ALREADY_ADDED",
        "ADD_INSTALL_FAILED",
        "ADD_NOT_SEEN_AFTER_INSTALL",
        "ADD_HANDSHAKE_SILENT",
        "ADD_HANDSHAKE_BAD",
        "ADD_CHAT_OFF",
        "ADD_SAVE_FAILED",
        "ADD_BUSY",
        "ADD_RUN_NOT_FOUND",
    ];
    for code in codes {
        for name in ["Kimi", "zzzz"] {
            let e = error_for(code, name, None);
            let lower = e.message.to_ascii_lowercase();
            for banned in BANNED {
                assert!(!lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == banned), "{code}: {}", e.message);
            }
            assert!(e.message.split_whitespace().count() <= 12, "{code}: {}", e.message);
            assert_eq!(e.code, code);
        }
    }
    assert_eq!(error_for("ADD_RUN_NOT_FOUND", "", None).message, "That check is gone. Start again.");
    let rig = Rig::new("gone");
    assert_eq!(rig.ladder.status("nope").unwrap_err(), "ADD_RUN_NOT_FOUND: That check is gone. Start again.");
    assert!(rig.ladder.cancel("nope").is_err() && rig.ladder.approve_install("nope").is_err());
}

#[test]
fn result_caps_pass_invariants() {
    let rig = Rig::new("invariants");
    for name in ["fakenat", "fakeauth", "fakeplain"] {
        rig.program(&exe_name(name));
    }
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    rig.catalog("fakeauth", "Fakeauth", &["fakeauth"]);
    rig.chat("fakeauth", "auth=1");
    for (input, terminal_only) in [("fakenat", false), ("fakeauth", false), ("fakeplain", false)] {
        let run = rig.add(input, terminal_only);
        assert_eq!(run.state, RunState::Done, "{input}: {run:?}");
        let caps = run.result.unwrap().caps;
        assert!(caps_problems(&caps).is_empty(), "{input}: {:?}", caps_problems(&caps));
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["agent_id"], input);
        assert!(["l0", "l5"].contains(&json["level"].as_str().unwrap()));
    }
    // The checker itself catches a claim without a proof.
    let mut bad = AgentCaps::default();
    bad.stop.value = Tri::Yes;
    assert!(!caps_problems(&bad).is_empty());
}

// ---- contract open seam 4: what the save step relies on ----------------------------------------------------

#[test]
fn smallest_generic_definition_is_valid() {
    let tree = Tree::new("minimal");
    let env = tree.env();
    let text = save::terminal_text("minimal_one", "Minimal One", "minimal-one");
    assert!(!text.contains("[headless") && !text.contains("[tui") && !text.contains("[acp"));
    save::check_text(&text, &env.code_id_refs()).expect("the validator accepts it");
    assert!(crate::tui::declarative::build_for_test(&text).is_ok(), "and the loader builds a profile from it");
    let clash = save::terminal_text("claude", "Claude", "claude");
    assert!(save::check_text(&clash, &env.code_id_refs()).is_err(), "a built-in id is refused");
}

#[test]
fn chat_definition_saves_from_a_resolved_session_without_probe() {
    let rig = Rig::new("resolved");
    rig.program(&exe_name("fakechat"));
    let env = rig.fakes.env.clone();
    let env2 = env.clone();
    let wizard = crate::tui::declarative::wizard::Wizard::new(move || env2.clone());
    let mut written = save::write_chat(&wizard, "fakechat", "Fakechat", "fakechat", "fakechat-acp", &["--stdio".to_string()]).expect("acp::finish works from a resolved session");
    let text = std::fs::read_to_string(written.definition.as_ref().unwrap()).unwrap();
    assert!(text.contains("[acp]") && text.contains("fakechat-acp"), "{text}");
    save::approve(&env, &mut written, "fakechat", &["add_agent:find".to_string()]).expect("the wizard's approval works without a probe");
    let approvals = rig.approvals_text();
    assert!(approvals.contains("fakechat") && approvals.contains("wizard"), "{approvals}");
    save::undo(&env, &written);
    assert!(rig.agents_files().iter().all(|f| !f.starts_with("fakechat")), "{:?}", rig.agents_files());
}

// ---- checkpoint-1 fixes -------------------------------------------------------------------------------------------

#[test]
fn ladder_result_caps_equal_agent_caps_get() {
    let rig = Rig::new("caps-agree");
    for name in ["fakenat", "faketerm"] {
        rig.program(&exe_name(name));
    }
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    for input in ["fakenat", "faketerm"] {
        let run = rig.add(input, false);
        assert_eq!(run.state, RunState::Done, "{input}: {run:?}");
        let result = run.result.unwrap();
        // The window shows `result.caps`; the chip asks `agent_caps_get`. They are the same table.
        assert_eq!(result.caps, crate::agent_caps::for_agent_in(&rig.fakes.caps_dir, input), "{input}");
        assert_eq!(crate::agent_caps::caps_to_json(&result.caps), crate::agent_caps::caps_to_json(&rig.fakes.caps_dir_caps(input)));
    }
    // And the hello really reached the store: the chat tick has the hello as its proof.
    let caps = crate::agent_caps::for_agent_in(&rig.fakes.caps_dir, "fakenat");
    assert_eq!((caps.chat.value, caps.chat.source), (Tri::Yes, Source::Handshake));
    assert_eq!(caps.level, Level::L0);
}

#[test]
fn terminal_only_leaves_chat_unknown() {
    let rig = Rig::new("term-unknown");
    rig.program(&exe_name("fakenat"));
    rig.catalog("fakenat", "Fakenat", &["fakenat"]);
    rig.chat("fakenat", "");
    let run = rig.add("fakenat", true);
    assert_eq!(run.state, RunState::Done, "{run:?}");
    let result = run.result.as_ref().unwrap();
    assert_eq!(result.mode, "terminal");
    assert_eq!(result.caps.chat.value, Tri::Unknown, "nothing was checked, so nothing is claimed: {:?}", result.caps.chat);
    assert!(result.caps.level_proof.proof.contains("chat not checked"), "{}", result.caps.level_proof.proof);
    assert!(caps_problems(&result.caps).is_empty());
    let records = rig.fakes.records.lock();
    let (_, record) = records.last().expect("recorded");
    assert!(record.terminal_only && record.no_chat_reason.is_none() && !record.init_ok, "{record:?}");
}

#[test]
fn double_approve_install_runs_once_and_keeps_the_add() {
    let rig = Rig::new("double-approve");
    rig.program(&exe_name("fakereg"));
    *rig.fakes.addon.lock() = Some(crate::acp::fake_agent::agent_config("", &rig.tree.root.join("store-reg")));
    let run = rig.add("fakereg", false);
    assert_eq!(run.state, RunState::NeedsInstall, "{run:?}");
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let clicks: Vec<_> = (0..2)
        .map(|_| {
            let (ladder, id, gate) = (rig.ladder.clone(), run.run_id.clone(), barrier.clone());
            std::thread::spawn(move || {
                gate.wait();
                ladder.approve_install(&id)
            })
        })
        .collect();
    for click in clicks {
        click.join().unwrap().expect("a second click is answered, not an error");
    }
    let done = rig.wait(&run.run_id);
    assert_eq!(done.state, RunState::Done, "{done:?}");
    assert_eq!(rig.fakes.installs.load(Ordering::SeqCst), 1, "installed once");
    assert!(rig.agents_files().iter().any(|f| f.starts_with("fakereg")), "the add is still there: {:?}", rig.agents_files());
    assert_eq!(rig.ladder.status(&run.run_id).unwrap().state, RunState::Done, "it does not flip to failed later");
}

#[test]
fn two_starts_at_once_one_is_busy() {
    let rig = Rig::new("two-starts");
    rig.program(&exe_name("fakeslow"));
    rig.program(&exe_name("faketerm"));
    rig.catalog("fakeslow", "Fakeslow", &["fakeslow"]);
    rig.chat("fakeslow", "init_delay_ms=60000");
    for round in 0..5 {
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let starts: Vec<_> = ["fakeslow", "faketerm"]
            .into_iter()
            .map(|input| {
                let (ladder, gate) = (rig.ladder.clone(), barrier.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    ladder.start(input, false)
                })
            })
            .collect();
        let results: Vec<_> = starts.into_iter().map(|s| s.join().unwrap()).collect();
        let started: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        let busy = results.iter().filter(|r| r.as_ref().is_err_and(|e| e.starts_with("ADD_BUSY"))).count();
        // faketerm can finish before the second start looks; then both ran one after the other, which is fine.
        let checking: Vec<_> = rig.ladder.live_checking();
        assert!(checking.len() <= 1, "round {round}: two runs checking at once: {checking:?}");
        assert!(!started.is_empty() && started.len() + busy == 2, "round {round}: {results:?}");
        for run in started {
            rig.ladder.cancel(&run.run_id).unwrap();
            rig.wait(&run.run_id);
        }
        // Clear any finished terminal add so the next round starts clean.
        for f in rig.agents_files() {
            let _ = std::fs::remove_file(rig.tree.agents.join(f));
        }
    }
}

#[test]
fn cancel_during_install_ends_cancelled_and_stops_the_install() {
    let rig = Rig::new("cancel-install");
    rig.program(&exe_name("fakereg"));
    rig.fakes.install_blocks.store(true, Ordering::SeqCst);
    let run = rig.add("fakereg", false);
    assert_eq!(run.state, RunState::NeedsInstall, "{run:?}");
    let after = rig.ladder.approve_install(&run.run_id).unwrap();
    assert_eq!(after.state, RunState::Checking);
    let until = Instant::now() + Duration::from_secs(20);
    while rig.fakes.installs.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < until, "the install never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    let started = Instant::now();
    let cancelled = rig.ladder.cancel(&run.run_id).unwrap();
    assert_eq!(cancelled.state, RunState::Cancelled, "{cancelled:?}");
    assert!(started.elapsed() < Duration::from_secs(4), "cancel returned at once");
    assert!(cancelled.error.is_none());
    assert!(rig.agents_files().is_empty());
    // The next add is not blocked by a run that is gone.
    rig.program(&exe_name("faketerm"));
    assert_eq!(rig.add("faketerm", false).state, RunState::Done);
}
