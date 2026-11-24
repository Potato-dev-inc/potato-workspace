//! Keeps an adapter and everything it starts from outliving it.
//!
//! * **Windows**: the adapter is put in a Job Object with `KILL_ON_JOB_CLOSE`. When the app exits or
//!   crashes (the last handle to the job closes), Windows kills every process in the job. This is the
//!   Windows counterpart of Linux's "die with parent": the Node adapter, the agent CLI under it and that
//!   CLI's MCP servers (Codex starts about 25 processes) all go. Terminating the job is also how a
//!   session is stopped. The adapter is assigned a moment after it starts; the gap is far shorter than
//!   the adapter's own start-up, so it has started nothing yet. Jobs nest on Windows 8 and later.
//! * **Elsewhere** (and on Windows when the job cannot be made): the adapter leads its own process group
//!   and a stop kills the tree below its pid through `pty::proc_tree`, by pid and never by image name.
//!   There is no "die with the app" there; a stale-adapter sweep at start (A3) covers a crashed app.

use std::process::{Child, Command};

/// How a running adapter is contained.
#[derive(Debug)]
pub struct Containment {
    pid: u32,
    #[cfg(windows)]
    job: Option<crate::proc_job::Job>,
}

/// Which mechanism holds the adapter (for diagnostics and tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mechanism {
    JobObject,
    ProcessTree,
}

/// Before the child starts: put it in its own process group where that is how it will be contained.
pub fn prepare(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

impl Containment {
    /// Contains `child`, which was just spawned.
    pub fn attach(child: &Child) -> Containment {
        let pid = child.id();
        #[cfg(windows)]
        {
            let job = match crate::proc_job::Job::new() {
                Ok(job) => match job.assign(child) {
                    Ok(()) => Some(job),
                    Err(e) => {
                        tracing::warn!(pid, error = %e, "acp: could not put the adapter in a job object; falling back to killing its tree");
                        None
                    }
                },
                Err(e) => {
                    tracing::warn!(pid, error = %e, "acp: could not create a job object; falling back to killing the tree");
                    None
                }
            };
            Containment { pid, job }
        }
        #[cfg(not(windows))]
        {
            Containment { pid }
        }
    }

    pub fn mechanism(&self) -> Mechanism {
        #[cfg(windows)]
        {
            if self.job.is_some() {
                return Mechanism::JobObject;
            }
        }
        Mechanism::ProcessTree
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Kills the adapter and everything below it. Idempotent.
    pub fn terminate(&self) {
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                // The adapter is put in the job a moment AFTER it starts. Under load that moment is long
                // enough for it to start a helper first, and that helper is not in the job. So walk the
                // tree by pid first (it finds such a helper through its parent), then end the job.
                crate::pty::proc_tree::kill_process_tree(self.pid);
                job.terminate();
                return;
            }
        }
        crate::pty::proc_tree::kill_process_tree(self.pid);
    }

    /// Processes still alive in the job (the adapter included); `None` when there is no job to ask.
    pub fn live_processes(&self) -> Option<u32> {
        #[cfg(windows)]
        {
            self.job.as_ref().and_then(|job| job.active_processes())
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}
