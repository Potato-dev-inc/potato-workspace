//! The app's way to renew a lend sign-in's token: run the agent's OWN CLI once, hidden, in the lend sign-in's
//! environment. The CLI renews the token and rewrites its file by itself; this app never talks to the provider's
//! sign-in. Nothing the CLI prints is kept or logged (it could echo text).

use std::process::Stdio;
use std::time::{Duration, Instant};

use super::service::{Refresh, RefreshJob};

/// The real renewal, for `Deps::refresh`.
pub fn app_refresh() -> Refresh {
    std::sync::Arc::new(|job| Box::pin(async move { tokio::task::spawn_blocking(move || run(&job)).await.map_err(|_| "The refresh stopped.".to_string())? }))
}

/// Blocking. The CLI is started with its output thrown away and stopped (by its own handle) when time is up.
fn run(job: &RefreshJob) -> Result<(), String> {
    let env = crate::accounts::Store::default_location().launch_env(&job.agent_id, &job.account_id)?;
    std::fs::create_dir_all(&job.scratch).map_err(|_| "The refresh folder could not be made.".to_string())?;
    let scratch = job.scratch.to_string_lossy().to_string();
    let profile = crate::tui::profile_for(&job.agent_id);
    let mut spec = crate::tui::headless_launch_with(&*profile, &job.agent_id, &crate::tui::HeadlessLaunch::new(&scratch, "refresh"))?;
    spec.args = job.args.clone();
    spec.cwd = job.scratch.clone();
    let mut command = crate::proc_util::hidden_command(&spec.program);
    command.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    spec.apply_to_command(&mut command);
    for (key, value) in &env.set {
        command.env(key, value);
    }
    for key in &env.remove {
        command.env_remove(key);
    }
    let mut child = command.spawn().map_err(|_| "The agent could not be started.".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(job.timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err("The agent did not finish cleanly.".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The agent took too long.".into());
            }
        }
    }
}
