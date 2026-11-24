//! Terminal-engine tests that need the app (the MCP session registry, operations, settings, the replay corpus, the outbox).
//! They moved out of `pm-core` with the engine and run here, with the app's hooks installed.

#![allow(unused_imports)]

pub(crate) mod prelude {
    pub use crate::pty::agents::AgentType;
    pub use parking_lot::Mutex;
    pub use pm_core::pty::registry::*;
    pub use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    pub use std::io::{Read, Write};
    pub use std::sync::Arc;
    pub use std::thread;
    pub use std::time::{Duration, Instant};
}

mod codex_live_tests;
mod live_permit_tests;
mod codex_idle_tests;

mod pane_origin {
    use super::*;
    use pm_core::pty::pane_origin::*;
#[test]
fn a_session_that_named_its_host_gives_a_started_by_label() {
    crate::mcp_sessions::note_session_client("sess-origin-1", "claude-code");
    note("origin-test-3", Some("sess-origin-1"), "Write the tests\nfor the parser");
    let origin = get("origin-test-3").unwrap();
    assert_eq!(origin.host.as_deref(), Some("Claude Code"));
    assert_eq!(origin.task.as_deref(), Some("Write the tests"));
    forget("origin-test-3");
}

}

mod virtual_pane {
    use super::*;
    use parking_lot::Mutex;
    use pm_core::pty::registry::*;
    use std::sync::Arc;

    fn spec(id: &str) -> VirtualPaneSpec {
        VirtualPaneSpec { pane_id: id.into(), agent_type: "codex".into(), cwd: "C:\\work".into(), lane: "acp".into(), pid: 0 }
    }
#[test]
fn a_chat_on_another_computer_is_left_out_of_the_default_list_and_only_the_window_list_has_it() {
    let registry = Mutex::new(PaneRegistry::new());
    insert_virtual_pane(&registry, spec("local-1"), Arc::new(|| {}));
    insert_virtual_pane(&registry, spec("remote-1"), Arc::new(|| {}));
    crate::acp::chat::mark_remote_for_tests("remote-1");
    let ids = |list: Vec<crate::pty::PaneInfo>| list.into_iter().map(|p| p.id).collect::<Vec<_>>();
    assert_eq!(ids(registry.lock().list()), vec!["local-1".to_string()]);
    let mut all = ids(registry.lock().list_including_remote());
    all.sort();
    assert_eq!(all, vec!["local-1".to_string(), "remote-1".to_string()]);
}

}

mod registry_flags {
    use super::*;
    use pm_core::pty::registry::spawn::launch_command;
    use pm_core::pty::registry::*;
/// A helper asked for a model, a reasoning effort, read-only and an account: the pane the bridge spawns for
/// it is started with exactly that, all the way to the program's command line.
#[test]
fn a_visible_helper_pane_starts_with_the_asked_model_effort_read_only_and_account() {
    use crate::operations::{DelegateWorkRequest, WorkerPersist};
    let project = std::env::temp_dir().join(format!("pm-visible-flags-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&project).unwrap();
    let worker = WorkerPersist {
        requested_model: Some("claude-haiku-5-5".into()),
        requested_reasoning: Some("low".into()),
        account: Some("work".into()),
        ..Default::default()
    };
    let operation = crate::operations::create_operation(DelegateWorkRequest {
        project_path: project.to_string_lossy().into_owned(),
        task: "a simple task".into(),
        agent_type: "claude".into(),
        pane_id: None,
        idempotency_key: uuid::Uuid::new_v4().to_string(),
        acceptance_criteria: None,
        task_id: None,
        exclusive: false,
        locks: vec![],
        timeout_ms: 900_000,
        read_only: true,
        keep_pane: false,
        placement: None,
        owner_session_id: None,
        parent_pane_id: None,
        worker_has_mcp_tools: false,
        agent_run_id: Some("visible-flags".into()),
        turn_index: 0,
        worker,
        context_policy: None,
        checks: Vec::new(),
    })
    .unwrap()
    .0;
    let spawn = crate::bridge::spawn_args_for_run(&operation, "claude");
    assert_eq!(spawn.account.as_deref(), Some("work"), "the chosen account reaches the pane");
    assert!(spawn.read_only);
    let extra = spawn.extra_args.clone().expect("the asks become launch flags");
    let cwd = project.to_string_lossy().into_owned();
    let claude = crate::tui::require_registered("claude").expect("claude is registered");
    let request = crate::tui::SpawnRequest { cwd: &cwd, extra_args: &extra, cols: 80, rows: 24, read_only: true };
    let cmd = launch_command(claude.as_ref(), &request, &crate::tui::LaunchEnv::default()).unwrap();
    // On Windows the agent is started through PowerShell with one command string; elsewhere each flag is an argument.
    let line = cmd.get_argv().iter().map(|arg| arg.to_string_lossy().replace('\'', "")).collect::<Vec<_>>().join(" ");
    for flag in ["--model claude-haiku-5-5", "--effort low", "--permission-mode plan"] {
        assert!(line.contains(flag), "{flag} missing from {line}");
    }
}

}

mod helper_cascade {
    use super::*;
    use parking_lot::Mutex;
    use pm_core::pty::registry::helper_cascade::close_with_helpers;
    use pm_core::pty::registry::*;

    fn registry_with(panes: &[(&str, Option<&str>)]) -> Mutex<PaneRegistry> {
        let registry = Mutex::new(PaneRegistry::default());
        {
            let mut reg = registry.lock();
            for (id, parent) in panes {
                let mut pane = PaneRegistry::test_pane_stub(id);
                pane.info.parent_pane_id = parent.map(str::to_string);
                reg.panes.insert((*id).to_string(), pane);
            }
        }
        registry
    }

    fn ids(registry: &Mutex<PaneRegistry>) -> Vec<String> {
        let mut ids: Vec<String> = registry.lock().panes.keys().cloned().collect();
        ids.sort();
        ids
    }
    use super::*;
    
#[test]
fn the_public_entry_reads_the_setting() {
    crate::engine_hooks::install();
    use crate::agent_run_mode::{with_test_env, TestEnv};
    let on = registry_with(&[("boss", None), ("h", Some("boss"))]);
    with_test_env(TestEnv::default(), || kill_pane_and_helpers(&on, "boss", None).unwrap());
    assert!(ids(&on).is_empty(), "default: on");
    let off = registry_with(&[("boss", None), ("h", Some("boss"))]);
    with_test_env(TestEnv { close_helpers_with_agent: Some(false), ..TestEnv::default() }, || kill_pane_and_helpers(&off, "boss", None).unwrap());
    assert_eq!(ids(&off), vec!["h"]);
}

#[test]
fn in_two_types_closing_the_orchestrator_keeps_its_spin_offs_and_stops_its_minions() {
    crate::engine_hooks::install();
    use crate::agent_run_mode::{with_test_env, StartedAgentTypes, TestEnv};
    let registry = registry_with(&[("boss", None), ("spin", Some("boss")), ("spin-minion", Some("spin")), ("minion", Some("boss")), ("plain", Some("boss"))]);
    {
        let mut reg = registry.lock();
        reg.panes.get_mut("spin").unwrap().info.started_as = Some("spin_off".into());
        reg.panes.get_mut("spin-minion").unwrap().info.started_as = Some("minion".into());
        reg.panes.get_mut("minion").unwrap().info.started_as = Some("minion".into());
    }
    with_test_env(TestEnv { started_agent_types: StartedAgentTypes::Two, ..TestEnv::default() }, || {
        close_with_helpers(&registry, "boss", Some("test"), true, false).unwrap();
    });
    // The spin-off stays with its own minion. So does the helper from before the kinds: it counts as a spin-off. The minion went.
    assert_eq!(ids(&registry), vec!["plain", "spin", "spin-minion"]);
}

}
