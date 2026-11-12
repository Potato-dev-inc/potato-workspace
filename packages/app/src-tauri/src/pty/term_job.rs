//! One app-wide Job Object (`KILL_ON_JOB_CLOSE`) that holds every terminal agent's process tree.
//!
//! The app keeps the only handle. When the app quits, crashes or is killed, Windows closes it and ends
//! every process in the job, the agent CLI and everything it started included, exactly as for chat
//! adapters (`acp::job`). Each PTY child is put in the job right after it spawns; the gap is far
//! shorter than an agent CLI's start-up, so it has started nothing yet. Closing a pane still kills its
//! tree by pid (`proc_tree`), so a child the job could not take is stopped the same way.
//! Elsewhere there is no job: the startup sweep (`orphans`) is the safety net.

/// Creates the job now (idempotent). Called at start so a failure is logged once, early.
pub fn init() {
    #[cfg(windows)]
    {
        let _ = job();
    }
}

/// Puts the process `pid` (and so everything it starts from now on) in the job. Best effort: a pid the
/// job cannot take is logged and left to the by-pid kill.
pub fn adopt(pid: u32) {
    #[cfg(windows)]
    {
        if pid == 0 {
            return;
        }
        match job() {
            Some(job) => {
                if let Err(e) = job.assign_pid(pid) {
                    tracing::warn!(pid, error = %e, "pty: could not put the terminal agent in the app job; closing its pane still kills its tree");
                }
            }
            None => {}
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

#[cfg(windows)]
fn job() -> Option<&'static crate::proc_job::Job> {
    static JOB: std::sync::OnceLock<Option<crate::proc_job::Job>> = std::sync::OnceLock::new();
    JOB.get_or_init(|| match crate::proc_job::Job::new() {
        Ok(job) => Some(job),
        Err(e) => {
            tracing::warn!(error = %e, "pty: could not create the terminal job object; relying on the pid-tree kill and the start-up sweep");
            None
        }
    })
    .as_ref()
}

/// True when `pid` is in the app job.
#[cfg(all(windows, test))]
pub(crate) fn holds(pid: u32) -> bool {
    job().is_some_and(|job| job.contains_pid(pid))
}

/// Processes currently in the app job (diagnostics and tests); `None` without a job.
#[cfg(all(windows, test))]
pub(crate) fn live_processes() -> Option<u32> {
    job().and_then(|job| job.active_processes())
}

#[cfg(all(windows, test))]
mod tests {
    use super::*;
    use crate::proc_util::{hidden_command, pid_alive};
    use std::process::Stdio;

    #[test]
    fn adopting_a_child_puts_it_in_the_app_job_and_a_missing_pid_is_harmless() {
        init();
        let mut child = hidden_command("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn().expect("start ping");
        let before = live_processes().unwrap_or(0);
        adopt(child.id());
        assert_eq!(live_processes().unwrap_or(0), before + 1);
        adopt(0);
        adopt(0x7fff_fff0);
        let _ = child.kill();
        let _ = child.wait();
        assert!(!pid_alive(child.id()));
    }
}
