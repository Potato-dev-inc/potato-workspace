//! The headless child process: spawn, stream its output into the transcript, wait for it (with a
//! result-grace and the run deadline), terminate it, and cancel it by operation id.

use super::control::{children, terminate, HeadlessControl};
use super::finish::finish_from_output;
use super::output::{forget_raw, spawn_reader, stream_text};
use crate::agent_runs::{persist, transcript};
use crate::operations::{self, ContextPolicy, OperationError, OperationStatus, StateSource};
use parking_lot::Mutex;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub(in crate::agent_runs) fn execute_headless(
    project: String,
    operation_id: String,
    agent_type: String,
    task: String,
    read_only: bool,
    timeout_ms: u64,
    registry: Arc<Mutex<crate::pty::PaneRegistry>>,
    app: tauri::AppHandle,
) {
    // A turn runs with the profile it was admitted under: editing or unregistering the definition
    // mid-run must not change how this turn is launched, parsed or finished.
    let profile = crate::tui::profile_for(&agent_type);
    crate::one_brain::sync_on_spawn(&project);
    transcript::append(&project, &operation_id, "user_task", &crate::redact::text(&task));
    let snapshot = operations::get_operation(&project, &operation_id).ok();
    let resume_session = snapshot
        .as_ref()
        .filter(|current| {
            persist::snapshot_can_resume(current)
                && current.worker.context_policy != ContextPolicy::Fresh
        })
        .and_then(|current| current.worker.provider_session_id.clone())
        .filter(|id| !id.is_empty());
    let trust_workspace = snapshot
        .as_ref()
        .is_some_and(|current| current.worker.trust_workspace);
    let allow_shell = snapshot
        .as_ref()
        .is_some_and(|current| current.worker.allow_shell);
    let account = snapshot
        .as_ref()
        .and_then(|current| current.worker.account.clone())
        .filter(|id| !id.trim().is_empty());
    let guard = snapshot
        .as_ref()
        .and_then(|current| current.worker.guard_env.clone());
    let requested_model = snapshot
        .as_ref()
        .and_then(|current| current.worker.requested_model.clone())
        .filter(|model| !model.trim().is_empty());
    let requested_reasoning = snapshot
        .as_ref()
        .and_then(|current| current.worker.requested_reasoning.clone())
        .filter(|effort| !effort.trim().is_empty());
    if profile.probes_default_model()
        && snapshot
            .as_ref()
            .is_some_and(|current| current.worker.resolved_model.is_none())
    {
        // Some headless CLIs never say which model ran; record the CLI's configured default so
        // resolved_model is a real answer instead of null. Off-thread: it may shell out.
        let (project, operation_id) = (project.clone(), operation_id.clone());
        let probe_profile = profile.clone();
        let _ = thread::Builder::new()
            .name("puppet-default-model".into())
            .spawn(move || {
                if let Some(model) = probe_profile.default_model() {
                    // A configured default is a best guess, not a confirmation of what ran.
                    let _ = operations::record_unconfirmed_model(&project, &operation_id, &model);
                }
            });
    }
    // An isolated run launches in its worktree; everything else keeps the project folder.
    let launch_dir = snapshot
        .as_ref()
        .map(|current| current.work_dir().to_string())
        .unwrap_or_else(|| project.clone());
    let isolated = snapshot
        .as_ref()
        .is_some_and(|current| current.worker.worktree.is_some());
    // Windows cannot start a program in a folder this long: say so now, in plain words, instead of
    // letting the spawn fail with a bare "os error 267".
    if let Err(found) = crate::path_limit::check(std::path::Path::new(&launch_dir)) {
        fail_start(&project, &operation_id, crate::path_limit::CODE, &found.message());
        publish(&project, &operation_id, &registry, &app);
        return;
    }
    let spec = match crate::tui::headless_launch_with(
        &*profile,
        &agent_type,
        &crate::tui::HeadlessLaunch {
            project: &launch_dir,
            task: &task,
            read_only,
            resume_session: resume_session.as_deref(),
            trust_workspace,
            allow_shell,
            model: requested_model.as_deref(),
            reasoning: requested_reasoning.as_deref(),
        },
    ) {
        Ok(spec) if !read_only || spec.read_only_enforced => spec,
        Ok(_) => {
            fail_start(
                &project,
                &operation_id,
                "READ_ONLY_UNSUPPORTED",
                "adapter did not enforce read-only mode",
            );
            publish(&project, &operation_id, &registry, &app);
            return;
        }
        Err(error) => {
            let (code, message) = error
                .strip_prefix("READ_ONLY_UNSUPPORTED: ")
                .map(|message| ("READ_ONLY_UNSUPPORTED", message))
                .unwrap_or(("LAUNCH_FAILED", error.as_str()));
            fail_start(&project, &operation_id, code, message);
            publish(&project, &operation_id, &registry, &app);
            return;
        }
    };
    // Opt-in warm pool: a pre-launched process (startup already paid) takes the task over stdin.
    // A guarded run never takes a warm process: it was started without the run's env guard.
    let pool_key = (resume_session.is_none() && !trust_workspace && !isolated && requested_reasoning.is_none() && guard.is_none())
        .then(|| {
            crate::standby::key_for_run(
                &agent_type,
                &project,
                requested_model.as_deref(),
                read_only,
                allow_shell,
                true,
                account.as_deref(),
            )
        })
        .flatten();
    // Held in a guard: every early return below kills a warm process that was never used.
    let mut standby = StandbyGuard(
        pool_key
            .as_ref()
            .and_then(crate::standby::claim_headless)
            .and_then(|claim| claim.into_process()),
    );
    if let Some(key) = &pool_key {
        crate::standby::note_run(key, &project);
    }
    // Every run moves Preload to its folder, claimable or not.
    crate::standby::note_run_project(&project);
    tracing::info!(
        operation_id = %operation_id,
        agent = %agent_type,
        model = ?requested_model,
        reasoning = ?requested_reasoning,
        read_only,
        project = %project,
        guarded = guard.is_some(),
        has_key = pool_key.is_some(),
        claimed = standby.0.is_some(),
        "standby claim (headless run): Preload keeps visible panes only, so a headless run starts its own process unless the legacy headless pool is on"
    );
    let account_env = match account.as_deref() {
        Some(id) => match crate::accounts::launch_env(&agent_type, id) {
            Ok(env) => env,
            Err(message) => {
                fail_start(&project, &operation_id, "LAUNCH_FAILED", &message);
                publish(&project, &operation_id, &registry, &app);
                return;
            }
        },
        None => crate::tui::LaunchEnv::default(),
    };
    // The env guard goes on last, so it wins over the account's env. An unknown name or a folder
    // that cannot be made refuses the start (nothing runs unguarded).
    let launch_env = match guard.as_deref() {
        Some(name) => match crate::pty::guard_launch::launch_env_for(name) {
            Ok(guard_env) => crate::pty::env_guard::layer(account_env, guard_env, &[]),
            Err(message) => {
                fail_start(&project, &operation_id, "LAUNCH_FAILED", &message);
                publish(&project, &operation_id, &registry, &app);
                return;
            }
        },
        None => account_env,
    };
    let mut command = headless_command(&spec, &launch_env);
    // A run with a budget tells its MCP shim who it is, so a helper it starts draws from that budget.
    if let Some(handle) = snapshot.as_ref().map(|current| current.agent_run_id.as_str()) {
        if !handle.is_empty() && crate::budgets::record_of(&project, handle).is_some() {
            command.env(crate::budgets::PARENT_ENV, handle);
        }
    }
    let mut readers = Vec::new();
    let dispatch = operations::run_operation_dispatch(&project, &operation_id, |_| {
        operations::dispatch_input_if_active(&project, &operation_id, |_| {
            let from_standby = standby
                .0
                .take()
                .and_then(|process| hand_task_to_standby(process, &profile, &task));
            if from_standby.is_some() {
                operations::mark_standby_claimed(&project, &operation_id);
            }
            let child = match from_standby {
                Some(child) => child,
                None => command.spawn().map_err(|error| {
                if let Some(found) = crate::path_limit::from_io_error(&error, &spec.cwd) {
                    return found.into_error(&spec.cwd);
                }
                let mut op_error = OperationError::new(
                    "LAUNCH_FAILED",
                    format!(
                        "spawn failed (program {:?}, cwd {}): {error}",
                        spec.program,
                        spec.cwd.display()
                    ),
                    true,
                );
                op_error.context = serde_json::json!({"program": spec.program, "cwd": spec.cwd.display().to_string()});
                op_error
            })?,
            };
            let control = Arc::new(HeadlessControl {
                child: Mutex::new(child),
                cancelled: AtomicBool::new(false),
            });
            children()
                .lock()
                .insert(operation_id.clone(), control.clone());
            // A cancel that landed after the Starting check but before this insert found no
            // child (and was treated as "nothing to stop"). Look again now that the child is
            // registered: if the run left Starting meanwhile, stop it before it does anything.
            if operations::operation_left_starting(&project, &operation_id) {
                tracing::warn!(operation_id = %operation_id, "run was cancelled while its process started; stopping it");
                if terminate(&control).is_err() {
                    force_kill(&control);
                }
            }
            let (stdout, stderr) = {
                let mut child = control.child.lock();
                (child.stdout.take(), child.stderr.take())
            };
            if let Some(stdout) = stdout {
                if let Some(reader) =
                    spawn_reader(project.clone(), operation_id.clone(), "stdout", stdout)
                {
                    readers.push(reader);
                }
            }
            if let Some(stderr) = stderr {
                if let Some(reader) =
                    spawn_reader(project.clone(), operation_id.clone(), "stderr", stderr)
                {
                    readers.push(reader);
                }
            }
            Ok(())
        })?;
        Ok(())
    });
    if dispatch.is_err() {
        children().lock().remove(&operation_id);
        forget_raw(&project, &operation_id);
        publish(&project, &operation_id, &registry, &app);
        return;
    }
    let Some(control) = children().lock().get(&operation_id).cloned() else {
        // Cancelled while queued (or the process never registered): nothing runs; tell the UI.
        forget_raw(&project, &operation_id);
        publish(&project, &operation_id, &registry, &app);
        return;
    };
    operations::mark_operation_stage(&project, &operation_id, "process_running");
    let started = Instant::now();
    let mut result_seen_at: Option<Instant> = None;
    let mut last_result_poll = Instant::now();
    let exit_status: Option<i32> = loop {
        if control.cancelled.load(Ordering::Acquire) {
            break None;
        }
        let mut child = control.child.lock();
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.code().unwrap_or(-1)),
            Ok(None) => {}
            Err(error) => {
                // We can no longer watch it: do not leave it running unattended.
                let pid = child.id();
                crate::pty::proc_tree::kill_process_tree(pid);
                let _ = child.kill();
                let _ = operations::mark_operation_state(
                    &project,
                    &operation_id,
                    OperationStatus::Failed,
                    StateSource::Native,
                    Some("failed".into()),
                    None,
                    Some(OperationError::new(
                        "WORKER_WAIT_FAILED",
                        error.to_string(),
                        true,
                    )),
                );
                break None;
            }
        }
        drop(child);
        // A CLI that printed its terminal result but does not exit would hold the turn open until
        // the deadline: once the result is in the output, give it a short grace to exit, then
        // stop it and finish the turn from that result.
        if last_result_poll.elapsed() >= Duration::from_millis(RESULT_POLL_MS) {
            last_result_poll = Instant::now();
            // The run was cancelled or ended elsewhere and the cancel did not reach this child
            // (it raced the start): stop it here instead of letting it run on.
            if operations::get_operation(&project, &operation_id)
                .is_ok_and(|op| op.status.terminal() || op.status == OperationStatus::Cancelling)
            {
                if terminate(&control).is_err() {
                    force_kill(&control);
                }
                break None;
            }
            if result_seen_at.is_none() {
                let stdout = stream_text(&project, &operation_id, "stdout");
                if profile.headless_result_ready(&stdout) {
                    result_seen_at = Some(Instant::now());
                }
            }
        }
        if result_seen_at
            .is_some_and(|seen| seen.elapsed() >= Duration::from_millis(RESULT_EXIT_GRACE_MS))
        {
            tracing::warn!(operation_id = %operation_id, "headless child printed its result but did not exit; stopping it");
            if terminate(&control).is_ok() {
                break Some(0);
            }
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            if let Err(stop_error) = terminate(&control) {
                // The polite stop failed at the deadline: kill it outright so it cannot run on.
                force_kill(&control);
                let failure = OperationError::new("WORKER_STOP_FAILED", stop_error.message, true);
                let _ = operations::mark_operation_state(
                    &project,
                    &operation_id,
                    OperationStatus::Failed,
                    StateSource::Native,
                    Some("stop_failed".into()),
                    None,
                    Some(failure),
                );
                break None;
            }
            let mut error = OperationError::new(
                "TIMEOUT",
                "agent exceeded its wall-clock deadline and was terminated",
                true,
            );
            error.context = serde_json::json!({"timeout_ms": timeout_ms});
            let _ = operations::mark_operation_state(
                &project,
                &operation_id,
                OperationStatus::Failed,
                StateSource::Native,
                Some("timeout".into()),
                None,
                Some(error),
            );
            break None;
        }
        thread::sleep(Duration::from_millis(75));
    };
    join_bounded(readers, READER_JOIN_MS);
    let current = operations::get_operation(&project, &operation_id).ok();
    if current.as_ref().is_some_and(|op| op.status.terminal()) {
        children().lock().remove(&operation_id);
        forget_raw(&project, &operation_id);
        publish(&project, &operation_id, &registry, &app);
        return;
    }
    if let Some(code) = exit_status {
        finish_from_output(&project, &operation_id, &profile, &spec.program, code);
    }
    children().lock().remove(&operation_id);
    forget_raw(&project, &operation_id);
    publish(&project, &operation_id, &registry, &app);
}

/// Kills the child and its process tree outright, without waiting on it. Best effort.
fn force_kill(control: &HeadlessControl) {
    let mut child = control.child.lock();
    crate::pty::proc_tree::kill_process_tree(child.id());
    let _ = child.kill();
    control.cancelled.store(true, Ordering::Release);
}

/// How long to wait for the output readers once the child is gone. A grandchild that inherited
/// the pipes can keep them open forever; the turn must still settle.
const READER_JOIN_MS: u64 = 5000;

fn join_bounded(readers: Vec<thread::JoinHandle<()>>, limit_ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(limit_ms);
    for reader in readers {
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if reader.is_finished() {
            let _ = reader.join();
        }
        // An unfinished reader is detached: it ends on its own when the pipe finally closes.
    }
}

/// A claimed warm process that was not handed a task is killed (and reaped) when the run returns,
/// whatever path it returns by; otherwise it would linger as an orphaned CLI with open stdin.
struct StandbyGuard(Option<crate::standby::StandbyProcess>);

impl Drop for StandbyGuard {
    fn drop(&mut self) {
        if let Some(mut process) = self.0.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

/// Gives a claimed standby process its task and closes its stdin. `None` (the process is shut
/// down) when it died while it waited or cannot take the task: the run then spawns normally, so a
/// bad standby is never a user-visible failure.
fn hand_task_to_standby(
    mut process: crate::standby::StandbyProcess,
    profile: &Arc<dyn crate::tui::TuiProfile>,
    task: &str,
) -> Option<std::process::Child> {
    use std::io::Write;
    let Some(input) = profile.headless_standby_input(task) else {
        let _ = process.child.kill();
        let _ = process.child.wait();
        return None;
    };
    let delivered = process.child.stdin.take().is_some_and(|mut stdin| {
        stdin
            .write_all(input.as_bytes())
            .and_then(|()| stdin.flush())
            .is_ok()
        // `stdin` drops here: EOF tells the CLI the task is complete.
    });
    if delivered && process.child.try_wait().map_or(false, |status| status.is_none()) {
        Some(process.child)
    } else {
        let _ = process.child.kill();
        let _ = process.child.wait();
        None
    }
}

/// How often the wait loop looks for a printed result, and how long the child gets to exit after it.
const RESULT_POLL_MS: u64 = 400;
const RESULT_EXIT_GRACE_MS: u64 = 3000;

pub(super) fn fail_start(project: &str, id: &str, code: &str, message: &str) {
    let error = OperationError::new(code, message, false);
    let _ = operations::mark_operation_state(
        project,
        id,
        OperationStatus::Failed,
        StateSource::Native,
        Some("failed".into()),
        None,
        Some(error),
    );
}

pub(in crate::agent_runs) fn publish(
    project: &str,
    id: &str,
    registry: &Arc<Mutex<crate::pty::PaneRegistry>>,
    app: &tauri::AppHandle,
) {
    if let Ok(snapshot) = operations::get_operation(project, id) {
        let _ = crate::bridge::publish_operation(&snapshot, registry, app);
        if snapshot.status.terminal() && snapshot.pane_id.is_none() {
            // A hidden run ended: its Inbox row changes from running to done / failed.
            let _ = tauri::Emitter::emit(app, "hidden-runs://changed", ());
        }
    }
}

/// The child process for a headless run: the spec's program, args and cwd, piped output, and the
/// environment (the spec's `[env]` first, then the account's, which wins).
pub(crate) fn headless_command(spec: &crate::tui::LaunchSpec, account_env: &crate::tui::LaunchEnv) -> Command {
    // Never opens a console window: a PowerShell launcher (the Cursor agent's) would flash one per run.
    let mut command = crate::proc_util::hidden_command(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spec.apply_to_command(&mut command);
    for (key, value) in &account_env.set {
        command.env(key, value);
    }
    for key in &account_env.remove {
        command.env_remove(key);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::operations::DelegateWorkRequest;

    fn sleeper() -> std::process::Child {
        let mut command = if cfg!(windows) {
            let mut command = crate::proc_util::hidden_command("ping");
            command.args(["-n", "60", "127.0.0.1"]);
            command
        } else {
            let mut command = crate::proc_util::hidden_command("sleep");
            command.arg("60");
            command
        };
        command.stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("spawn sleeper")
    }

    #[test]
    fn an_unused_warm_process_is_killed_when_the_run_returns() {
        let child = sleeper();
        let pid = child.id();
        let process = crate::standby::StandbyProcess { child };
        let guard = StandbyGuard(Some(process));
        drop(guard);
        // Reap check: the pid is gone, so a new handle to it cannot be waited on as alive.
        let alive = if cfg!(windows) {
            crate::proc_util::hidden_command("tasklist")
                .args(["/FI", &format!("PID eq {pid}")])
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
                .unwrap_or(false)
        } else {
            crate::proc_util::hidden_command("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        };
        assert!(!alive, "the unclaimed warm process must be killed");
    }

    #[test]
    fn force_kill_stops_a_child_the_wait_loop_can_no_longer_watch() {
        let control = HeadlessControl { child: Mutex::new(sleeper()), cancelled: AtomicBool::new(false) };
        force_kill(&control);
        assert!(control.cancelled.load(Ordering::Acquire));
        let status = control.child.lock().wait().expect("reaped");
        assert!(!status.success());
    }

    #[test]
    fn joining_readers_gives_up_on_a_pipe_that_never_closes() {
        let (hold, release) = std::sync::mpsc::channel::<()>();
        let stuck = thread::spawn(move || {
            let _ = release.recv();
        });
        let started = Instant::now();
        join_bounded(vec![stuck], 200);
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(hold);
    }

    #[test]
    fn a_cancel_that_lands_before_the_process_registers_is_noticed_afterwards() {
        let project = std::env::temp_dir().join(format!("pm-hl-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        let path = project.to_string_lossy().into_owned();
        let request = DelegateWorkRequest {
            project_path: path.clone(),
            task: "x".into(),
            agent_type: "claude".into(),
            pane_id: None,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            acceptance_criteria: None,
            task_id: None,
            exclusive: false,
            locks: vec![],
            timeout_ms: 900_000,
            read_only: false,
            keep_pane: false,
            placement: None,
            owner_session_id: None,
            parent_pane_id: None,
            worker_has_mcp_tools: false,
            agent_run_id: None,
            turn_index: 0,
            worker: Default::default(),
            context_policy: None,
            checks: Vec::new(),
        };
        let (op, _) = operations::create_operation(request).unwrap();
        let id = op.operation_id.clone();
        operations::run_operation_dispatch(&path, &id, |_| {
            // The run is Starting inside dispatch: nothing has left it yet.
            assert!(!operations::operation_left_starting(&path, &id));
            // A cancel arrives now: the hook finds no process yet and reports nothing to stop.
            let mut hook_saw_a_process = true;
            let _ = operations::cancel_operation_with(&path, &id, |_| {
                hook_saw_a_process = children().lock().contains_key(&id);
                Ok(())
            });
            assert!(!hook_saw_a_process, "the race: the cancel ran before the child registered");
            // The worker registers its child afterwards and must now see that it was cancelled.
            assert!(operations::operation_left_starting(&path, &id));
            Ok(())
        })
        .unwrap();
        assert!(!operations::operation_left_starting(&path, "no-such-operation"));
        let _ = std::fs::remove_dir_all(project);
    }
}

#[cfg(test)]
mod env_tests {
    use super::*;
    use crate::tui::{LaunchEnv, LaunchSpec};
    use std::io::Read;

    fn echo_spec(name: &str) -> LaunchSpec {
        let (program, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/C".to_string(), format!("echo VAL=%{name}%")])
        } else {
            ("sh", vec!["-c".to_string(), format!("echo VAL=${name}")])
        };
        LaunchSpec::new(program, args, std::env::temp_dir(), false)
    }

    fn stdout_of(mut command: Command) -> String {
        let mut child = command.spawn().expect("spawn");
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        let _ = child.wait();
        out
    }

    #[test]
    fn headless_run_gets_spec_env_then_account_env() {
        let mut spec = echo_spec("PM_HL_T");
        spec.env = vec![("PM_HL_T".into(), "from-spec".into())];
        assert!(stdout_of(headless_command(&spec, &LaunchEnv::default())).contains("VAL=from-spec"));
        let account = LaunchEnv { set: vec![("PM_HL_T".into(), "from-account".into())], remove: vec![] };
        assert!(stdout_of(headless_command(&spec, &account)).contains("VAL=from-account"));
    }

    /// The env a guarded headless run is launched with: account, then the guard on top.
    fn guarded_env(account: LaunchEnv) -> LaunchEnv {
        let guard = crate::pty::guard_launch::launch_env_for(crate::pty::env_guard::NO_PUSH).expect("guard");
        crate::pty::env_guard::layer(account, guard, &[])
    }

    #[test]
    fn a_guarded_headless_run_sees_the_guards_gh_folder_over_the_accounts() {
        let account = LaunchEnv { set: vec![("GH_CONFIG_DIR".into(), "from-account".into())], remove: vec![] };
        let mut spec = echo_spec("GH_CONFIG_DIR");
        spec.env = vec![("GH_CONFIG_DIR".into(), "from-spec".into())];
        let out = stdout_of(headless_command(&spec, &guarded_env(account)));
        assert!(out.contains("gh-empty"), "{out}");
        assert!(!out.contains("from-account") && !out.contains("from-spec"), "{out}");
    }

    #[test]
    fn a_guarded_headless_run_drops_inherited_tokens_but_keeps_api_keys() {
        std::env::set_var("PM_HL_GUARD_SECRET", "leaked-secret");
        std::env::set_var("PM_HL_GUARD_API_KEY", "kept-key");
        let drop_out = stdout_of(headless_command(&echo_spec("PM_HL_GUARD_SECRET"), &guarded_env(LaunchEnv::default())));
        assert!(!drop_out.contains("leaked-secret"), "{drop_out}");
        let keep_out = stdout_of(headless_command(&echo_spec("PM_HL_GUARD_API_KEY"), &guarded_env(LaunchEnv::default())));
        assert!(keep_out.contains("kept-key"), "{keep_out}");
        // Control: an unguarded run still sees the secret.
        let plain = stdout_of(headless_command(&echo_spec("PM_HL_GUARD_SECRET"), &LaunchEnv::default()));
        assert!(plain.contains("leaked-secret"), "{plain}");
    }

    #[test]
    fn the_headless_launch_takes_no_warm_process_when_guarded() {
        let src = include_str!("process.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert!(body.contains("&& guard.is_none())"), "pool_key must exclude guarded runs");
        assert!(body.contains("layer(account_env, guard_env, &[])"));
        assert!(body.contains("headless_command(&spec, &launch_env)"));
    }

    #[test]
    fn headless_run_drops_removed_variables() {
        std::env::set_var("PM_HL_DROP", "leaked-value");
        let mut spec = echo_spec("PM_HL_DROP");
        spec.env_remove = vec!["PM_HL_DROP".into()];
        let out = stdout_of(headless_command(&spec, &LaunchEnv::default()));
        assert!(!out.contains("leaked-value"), "{out}");
    }
}
