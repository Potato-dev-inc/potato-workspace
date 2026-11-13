//! The model chip: the agent's own model-list command, run once, becomes the `model` config option.
//!
//! The command is the one the definition names (`[model] probe_argv`); the bridge adds nothing. It starts the
//! way every headless command starts (the program the profile resolves and gates, hidden window, closed stdin,
//! its own process group or job), has a time limit and an output cap, and never sends a prompt.

use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::extras::ModelListCommand;
use crate::acp::job::{self, Containment};
use crate::tui::{HeadlessLaunch, LaunchEnv, TuiProfile};

/// Output kept from the list command (a list of hundreds of models is a few KiB).
const MAX_LIST_BYTES: usize = 256 * 1024;

/// The value of the "agent's own default" entry: no model flag is passed.
pub const DEFAULT_MODEL_VALUE: &str = "";

/// Runs `list` for `profile` in `cwd` and returns the model ids. Empty when the command cannot start, fails,
/// times out, or prints nothing the definition's pattern reads: the chip is then simply not offered.
pub fn list_models(profile: &dyn TuiProfile, list: &ModelListCommand, cwd: &Path, timeout: Duration) -> Vec<String> {
    let project = cwd.to_string_lossy().into_owned();
    if profile.spawn_gate(&project).is_err() {
        return Vec::new();
    }
    let launch = HeadlessLaunch {
        project: &project,
        task: "list models",
        read_only: false,
        resume_session: None,
        trust_workspace: false,
        allow_shell: false,
        model: None,
        reasoning: None,
    };
    let Ok(mut spec) = crate::tui::headless_launch_with(profile, profile.id(), &launch) else { return Vec::new() };
    spec.args = list.args.clone();
    spec.read_only_enforced = false;
    let mut command = crate::agent_runs::headless::headless_command(&spec, &LaunchEnv::default());
    job::prepare(&mut command);
    let Ok(mut child) = command.spawn() else { return Vec::new() };
    let containment = Arc::new(Containment::attach(&child));
    let (Some(mut stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        containment.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };
    // stderr is drained and dropped so a chatty program cannot block on a full pipe.
    let _ = std::thread::Builder::new().name("acp-bridge-models-err".into()).spawn(move || {
        let mut stderr = stderr;
        let mut sink = [0u8; 4096];
        while matches!(stderr.read(&mut sink), Ok(n) if n > 0) {}
    });
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let _ = std::thread::Builder::new().name("acp-bridge-models-out".into()).spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let started = Instant::now();
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                let room = MAX_LIST_BYTES.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if started.elapsed() > timeout || bytes.len() >= MAX_LIST_BYTES {
            break;
        }
    }
    // Output is over: the process gets what is left of the time to exit; a success exit is required.
    let mut status_ok = false;
    while started.elapsed() <= timeout && bytes.len() < MAX_LIST_BYTES {
        match child.try_wait() {
            Ok(Some(status)) => {
                status_ok = status.success();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break,
        }
    }
    containment.terminate();
    let _ = child.kill();
    let _ = child.wait();
    if !status_ok {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = crate::redact::text(&text).into_inner();
    list.parse(&text)
}

/// The `model` config option: the agent's default first (no flag), then the CLI's own list.
pub fn model_option(models: &[String], current: &str) -> Value {
    let mut options = vec![json!({"value": DEFAULT_MODEL_VALUE, "name": "Default"})];
    options.extend(models.iter().map(|m| json!({"value": m, "name": m})));
    json!({
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": current,
        "options": options
    })
}
