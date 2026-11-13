//! Tauri commands of the add-agent ladder (night 2026-11-13, contract 2.1): one click adds an agent with the free
//! checks only. All the work is in `tui::declarative::wizard::ladder`; this file holds the commands, the
//! `add-agent://progress` event and the real `Backends` (catalog, registry, install, reload).
//!
//! Only the app's own webview calls these. The bridge has no route for them, so a phone or an agent cannot add or
//! install anything.

use super::*;
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;

use crate::acp::adapter_catalog::{self, AdapterEntry};
use crate::acp::config::{AgentConfig, RealHost};
use crate::acp::install::{self, InstallError, Runner};
use crate::acp::overlay::{self, OverlayStore};
use crate::acp::registry::{self, Choice, Registry, RegistryAgent};
use crate::agent_install::plan::Tools;
use crate::agent_store::catalog;
use crate::tui::declarative::schema::parse_definition;
use crate::tui::declarative::wizard::ladder::{
    AddAgentRun, AddonPlan, Backends, CatalogHit, HandshakeRecord, InstallPlanView, Ladder, LadderCfg,
};
use crate::tui::declarative::wizard::session::WizardEnv;
use crate::tui::declarative::DeclarativeProfile;

/// Event: the whole run, after every step change and at the end. The window just replaces its state.
pub const EVENT: &str = "add-agent://progress";

struct RealBackends;

fn definition_of(text: &str) -> Option<crate::tui::declarative::schema::Definition> {
    parse_definition(text).ok()
}

impl Backends for RealBackends {
    fn catalog_lookup(&self, name: &str) -> Option<CatalogHit> {
        let lower = name.to_ascii_lowercase();
        catalog::all().iter().find_map(|entry| {
            let id = entry.entry.store.id.clone();
            let def = entry.definition_text.as_deref().and_then(definition_of);
            let names: Vec<String> = def.as_ref().map(|d| d.binary.names.clone()).unwrap_or_else(|| vec![id.clone()]);
            let hit = id.eq_ignore_ascii_case(&lower) || names.iter().any(|n| n.eq_ignore_ascii_case(&lower));
            hit.then(|| CatalogHit {
                label: entry.label(),
                names,
                has_chat: self.shipped_chat(&id).is_some(),
                has_headless: def.as_ref().is_some_and(|d| d.headless.is_some()),
                id,
            })
        })
    }

    fn registry(&self) -> Registry {
        // No network tonight: the snapshot compiled into this build.
        registry::snapshot()
    }

    fn adapters_for(&self, program: &str) -> Vec<AdapterEntry> {
        adapter_catalog::for_program(program)
    }

    fn is_registered(&self, id: &str) -> bool {
        crate::tui::is_registered(id)
    }

    fn chat_enabled(&self) -> bool {
        crate::acp::chat_enabled()
    }

    fn program_install_plan(&self, id: &str) -> Option<InstallPlanView> {
        let (plan, _) = crate::agent_install::plan_for(id, &Tools::detect()).ok()?;
        Some(InstallPlanView {
            what_will_run: plan.steps.iter().map(|s| s.command.clone()).collect(),
            source_host: plan.steps.first().map(|s| crate::agent_install::source_host(&s.source)).unwrap_or_default(),
            // The app shows the command; running a program install is a later step (contract open seam 3).
            can_install: false,
        })
    }

    fn shipped_chat(&self, id: &str) -> Option<AgentConfig> {
        let def = definition_of(catalog::embedded_definition(id)?)?;
        let profile = DeclarativeProfile::new(def).ok()?;
        crate::tui::TuiProfile::acp_table(&profile)
    }

    fn addon_plan(&self, agent: &RegistryAgent, choice: &Choice) -> AddonPlan {
        let (what, host) = match choice {
            Choice::Npx { package, version, .. } => (format!("npm install {package}@{version} (no install scripts)"), "registry.npmjs.org".to_string()),
            Choice::Binary { archive, .. } => (format!("download {archive}"), crate::agent_install::source_host(archive)),
            Choice::Unsupported(why) => (why.clone(), String::new()),
        };
        AddonPlan {
            registry_id: Some(agent.id.clone()),
            view: InstallPlanView { what_will_run: vec![what], source_host: host, can_install: !matches!(choice, Choice::Unsupported(_)) },
        }
    }

    fn install_addon(&self, plan: &AddonPlan, agent_id: &str, label: &str, cancel: &AtomicBool) -> Result<AgentConfig, String> {
        let registry_id = plan.registry_id.clone().ok_or("this add-on cannot be installed here")?;
        let reg = registry::snapshot();
        let agent = reg.agents.iter().find(|a| a.id == registry_id).cloned().ok_or("the registry has no such entry")?;
        let choice = registry::choose(&agent, &registry::platform_key());
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("stopped".into());
        }
        let addons = install::addons();
        addons.begin(agent_id).map_err(|e| e.to_string())?;
        let store = OverlayStore::in_app_data();
        let runner = CancelRunner { cancel };
        let mut job = |on_line: &mut dyn FnMut(&str)| -> Result<String, InstallError> {
            let written = crate::acp::install_registry::install_for_agent(&store, agent_id, label, &agent, &choice, &RealHost, &runner, &registry::RealHttp, on_line)?;
            Ok(written.version)
        };
        let outcome = addons.run_job(agent_id, &|| {}, &mut job).map_err(|e| e.to_string());
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            // Stopped by the person: the add-on entry (if it was just written) goes too.
            let _ = store.remove(agent_id);
            return Err("stopped".into());
        }
        outcome?;
        overlay::resolve_with(&store, agent_id, None, Some(label.to_string())).ok_or_else(|| "the add-on was installed but has no chat table".to_string())
    }

    fn catalog_add(&self, id: &str) -> Result<(), String> {
        crate::agent_store::add::add(id, true).map(|_| ())
    }

    fn catalog_remove(&self, id: &str) {
        let _ = crate::agent_store::add::remove(id);
        // A taken-back add leaves no capability entry behind for a later program with the same name.
        crate::agent_caps::forget(id);
    }

    fn reload(&self) {
        let _ = crate::tui::declarative::service::reload_global_with_diff();
    }

    fn record_handshake(&self, agent_id: &str, facts: &HandshakeRecord) -> Result<(), String> {
        crate::agent_caps::record_handshake(agent_id, facts)
    }

    fn caps_of(&self, agent_id: &str) -> crate::agent_caps::AgentCaps {
        crate::agent_caps::for_agent(agent_id)
    }
}

/// The npm runner of the install, with one difference from `install::RealRunner`: it looks at the cancel flag every
/// 50 ms and stops its own child (by handle) when the person cancelled.
struct CancelRunner<'a> {
    cancel: &'a AtomicBool,
}

impl Runner for CancelRunner<'_> {
    fn find_npm(&self) -> Option<std::path::PathBuf> {
        install::RealRunner.find_npm()
    }

    fn run(&self, npm: &std::path::Path, args: &[String], cwd: &std::path::Path, on_line: &mut dyn FnMut(&str)) -> Result<Option<i32>, String> {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};

        let mut command = crate::proc_util::hidden_command(npm);
        command.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env("npm_config_update_notifier", "false").env("npm_config_fund", "false").env("npm_config_audit", "false");
        if let Some(dir) = npm.parent() {
            let mut paths: Vec<std::path::PathBuf> = vec![dir.to_path_buf()];
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                command.env("PATH", joined);
            }
        }
        let mut child = command.spawn().map_err(|e| format!("could not start npm: {e}"))?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let mut readers = Vec::new();
        let mut reader = |stream: Box<dyn std::io::Read + Send>| {
            let tx = tx.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
                    let line = String::from_utf8_lossy(&line).trim().to_string();
                    if !line.is_empty() && tx.send(line).is_err() {
                        break;
                    }
                }
            }));
        };
        if let Some(out) = child.stdout.take() {
            reader(Box::new(out));
        }
        if let Some(err) = child.stderr.take() {
            reader(Box::new(err));
        }
        drop(tx);
        let deadline = Instant::now() + install::INSTALL_LIMIT;
        let mut code: Option<Option<i32>> = None;
        let mut stopped = false;
        loop {
            while let Ok(line) = rx.try_recv() {
                on_line(&line);
            }
            if self.cancel.load(Ordering::SeqCst) {
                stopped = true;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    code = Some(status.code());
                    break;
                }
                Ok(None) if !stopped && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    // Our own child, stopped by its handle (never by image name).
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
        for reader in readers {
            let _ = reader.join();
        }
        if stopped {
            return Err("stopped".into());
        }
        while let Ok(line) = rx.try_recv() {
            on_line(&line);
        }
        match code {
            Some(code) => Ok(code),
            None => Err(format!("npm took longer than {} minutes and was stopped", install::INSTALL_LIMIT.as_secs() / 60)),
        }
    }
}

static LADDER: OnceLock<Arc<Ladder>> = OnceLock::new();

fn ladder(app: &AppHandle) -> Arc<Ladder> {
    LADDER
        .get_or_init(|| {
            let app = app.clone();
            let emit = Arc::new(move |run: &AddAgentRun| {
                let _ = app.emit(EVENT, run);
            });
            Ladder::new(Arc::new(WizardEnv::app), Arc::new(RealBackends), emit, LadderCfg::default())
        })
        .clone()
}

/// Start adding an agent. Returns at once with the run in state `checking`; progress comes as `add-agent://progress`.
/// `terminal_only: true` skips the chat steps (the "use it in a terminal instead" button).
#[tauri::command]
pub async fn add_agent_start(app: AppHandle, input: String, terminal_only: Option<bool>) -> Result<AddAgentRun, String> {
    ladder(&app).start(&input, terminal_only.unwrap_or(false))
}

#[tauri::command]
pub async fn add_agent_status(app: AppHandle, run_id: String) -> Result<AddAgentRun, String> {
    ladder(&app).status(&run_id)
}

/// Stops the run: the running program is stopped, a half-written save is taken back. Cancel after `done` changes nothing.
#[tauri::command]
pub async fn add_agent_cancel(app: AppHandle, run_id: String) -> Result<AddAgentRun, String> {
    let ladder = ladder(&app);
    tauri::async_runtime::spawn_blocking(move || ladder.cancel(&run_id)).await.map_err(|e| e.to_string())?
}

/// The one approval an install needs. Runs the plan the window showed and nothing else, then checks again.
#[tauri::command]
pub async fn add_agent_approve_install(app: AppHandle, run_id: String) -> Result<AddAgentRun, String> {
    ladder(&app).approve_install(&run_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    /// Not a test when run normally. Started again by the cancel test below, it just waits.
    #[test]
    fn sleeper_child() {
        if std::env::var("PM_SLEEPER").as_deref() == Ok("1") {
            std::thread::sleep(Duration::from_secs(120));
        }
    }

    #[test]
    fn cancel_stops_the_install_child_quickly() {
        let exe = std::env::current_exe().unwrap();
        let args: Vec<String> = ["--exact", "commands::add_agent::tests::sleeper_child", "--nocapture"].iter().map(|a| a.to_string()).collect();
        std::env::set_var("PM_SLEEPER", "1");
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let runner = CancelRunner { cancel: &cancel };
        let out = runner.run(&exe, &args, &std::env::temp_dir(), &mut |_| {});
        stopper.join().unwrap();
        std::env::remove_var("PM_SLEEPER");
        assert_eq!(out, Err("stopped".to_string()));
        assert!(started.elapsed() < Duration::from_secs(20), "the child was stopped, not waited for");
    }
}
