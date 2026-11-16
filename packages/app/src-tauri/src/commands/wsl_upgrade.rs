//! The Settings "Upgrade" button for a Linux (WSL) distro that still runs WSL 1. Agents need WSL 2.
//!
//! This is the one place that runs `wsl.exe --set-version`. It lives outside `wsl/` on purpose: the S5
//! guard tests there say the probe code never runs admin commands, and that stays true. Only a person's
//! click reaches it. The distro must be listed, name-checked and on WSL 1; every call has a time limit and
//! is killed on timeout; nothing from `wsl.exe` is shown raw (the person sees one plain sentence).

use crate::operations::OperationError;
use crate::proc_util::hidden_command;
use crate::wsl::model::{DistroName, WslStatus, WSL_DISTRO_MISSING, WSL_NOT_INSTALLED, WSL_START_FAILED};
use crate::wsl::probe;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// The longest one upgrade is waited for. Converting a big distro can take many minutes.
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// The app tries this many times by itself before the screen offers "Let an agent fix it".
const TRIES: usize = 3;
const POLL_EVERY: Duration = Duration::from_millis(100);

/// Why one `--set-version` call did not finish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpgradeRunError {
    Timeout,
    Failed,
}

/// The arguments of one upgrade call. Built here from a checked distro name, nothing else.
fn upgrade_args(distro: &DistroName) -> Vec<String> {
    vec!["--set-version".to_string(), distro.as_str().to_string(), "2".to_string()]
}

/// Runs `wsl.exe` with `args`, output dropped, killed after `timeout`.
fn run_live(args: &[String], timeout: Duration) -> Result<(), UpgradeRunError> {
    let Some(exe) = probe::wsl_exe() else { return Err(UpgradeRunError::Failed) };
    let mut child = hidden_command(&exe)
        .args(args)
        .env("WSL_UTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| UpgradeRunError::Failed)?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(UpgradeRunError::Failed) },
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_EVERY),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(UpgradeRunError::Timeout);
            }
        }
    }
}

/// The upgrade of one distro. `status` lists the distros (never boots one); `run` is the one `wsl.exe` call.
/// Refuses before anything runs when the name is bad, not listed, or already WSL 2. A timeout is not
/// retried (it already waited long); a plain failure is tried up to `TRIES` times.
fn upgrade_with(
    status: impl FnOnce() -> WslStatus,
    run: impl Fn(&[String], Duration) -> Result<(), UpgradeRunError>,
    distro: &str,
) -> Result<(), OperationError> {
    let name = DistroName::parse(distro).ok_or_else(|| missing(distro))?;
    let listed = match status() {
        WslStatus::Ready { distros } => distros
            .into_iter()
            .find(|d| d.name.eq_ignore_ascii_case(name.as_str()))
            .ok_or_else(|| missing(distro))?,
        WslStatus::NotWindows | WslStatus::NotInstalled { .. } => {
            return Err(OperationError::new(WSL_NOT_INSTALLED, "Linux is not available on this PC.", false))
        }
        WslStatus::NoDistro { .. } => return Err(missing(distro)),
        WslStatus::Broken { .. } => {
            return Err(OperationError::new(WSL_START_FAILED, "Linux did not answer. Try again in a moment.", true))
        }
    };
    if listed.version == 2 {
        return Ok(());
    }
    let name = DistroName::parse(&listed.name).ok_or_else(|| missing(distro))?;
    let args = upgrade_args(&name);
    for _ in 0..TRIES {
        match run(&args, UPGRADE_TIMEOUT) {
            Ok(()) => return Ok(()),
            Err(UpgradeRunError::Timeout) => {
                return Err(OperationError::new(WSL_START_FAILED, "The upgrade is taking too long.", true))
            }
            Err(UpgradeRunError::Failed) => {}
        }
    }
    Err(OperationError::new(WSL_START_FAILED, "The upgrade did not work.", true))
}

fn missing(distro: &str) -> OperationError {
    OperationError::new(WSL_DISTRO_MISSING, format!("Linux \"{distro}\" was not found."), false)
}

/// Upgrades one distro from WSL 1 to WSL 2. Off the UI thread. Returns the fresh distro list.
#[tauri::command]
pub async fn wsl_upgrade(distro: String) -> Result<WslStatus, OperationError> {
    tauri::async_runtime::spawn_blocking(move || {
        upgrade_with(|| probe::status_cached(0), run_live, &distro)?;
        probe::invalidate(&distro);
        Ok(probe::status_cached(0))
    })
    .await
    .map_err(|error| OperationError::new("INTERNAL", error.to_string(), false))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl::model::Distro;
    use std::cell::{Cell, RefCell};

    fn ready(version: u8) -> WslStatus {
        WslStatus::Ready {
            distros: vec![Distro { name: "Ubuntu-Test".into(), default: true, version, state: "Stopped".into() }],
        }
    }

    #[test]
    fn a_wsl_1_distro_is_upgraded_with_one_checked_call() {
        let calls: RefCell<Vec<Vec<String>>> = RefCell::default();
        let run = |args: &[String], timeout: Duration| {
            assert!(timeout <= UPGRADE_TIMEOUT);
            calls.borrow_mut().push(args.to_vec());
            Ok(())
        };
        upgrade_with(|| ready(1), run, "ubuntu-test").unwrap();
        assert_eq!(*calls.borrow(), vec![vec!["--set-version".to_string(), "Ubuntu-Test".to_string(), "2".to_string()]]);
    }

    #[test]
    fn nothing_runs_for_a_wsl_2_distro_a_stranger_or_a_bad_name() {
        let ran = Cell::new(0);
        let run = |_: &[String], _: Duration| {
            ran.set(ran.get() + 1);
            Ok(())
        };
        upgrade_with(|| ready(2), &run, "Ubuntu-Test").unwrap();
        assert_eq!(upgrade_with(|| ready(1), &run, "Other").unwrap_err().code, WSL_DISTRO_MISSING);
        assert_eq!(upgrade_with(|| ready(1), &run, "bad name; calc").unwrap_err().code, WSL_DISTRO_MISSING);
        assert!(upgrade_with(|| WslStatus::NotInstalled { command: String::new() }, &run, "Ubuntu-Test").is_err());
        assert_eq!(ran.get(), 0);
    }

    #[test]
    fn a_failure_is_tried_three_times_and_a_timeout_once() {
        let ran = Cell::new(0);
        let fail = |_: &[String], _: Duration| {
            ran.set(ran.get() + 1);
            Err(UpgradeRunError::Failed)
        };
        let error = upgrade_with(|| ready(1), fail, "Ubuntu-Test").unwrap_err();
        assert_eq!(ran.get(), TRIES);
        assert!(error.message.len() < 60 && !error.message.contains("--"), "one plain sentence");
        ran.set(0);
        let slow = |_: &[String], _: Duration| {
            ran.set(ran.get() + 1);
            Err(UpgradeRunError::Timeout)
        };
        assert!(upgrade_with(|| ready(1), slow, "Ubuntu-Test").is_err());
        assert_eq!(ran.get(), 1);
    }
}
