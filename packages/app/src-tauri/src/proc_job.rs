//! A Windows Job Object with `KILL_ON_JOB_CLOSE`: every process put in it dies when the last handle to
//! the job closes, which includes the owner crashing or being killed. Shared by the chat adapters
//! (`acp::job`) and the terminal agents (`pty::term_job`). Jobs nest on Windows 8 and later.
//!
//! Windows only; other platforms contain processes by pid tree (`pty::proc_tree`).

#![cfg(windows)]

use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::Child;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

#[derive(Debug)]
pub struct Job(HANDLE);

// SAFETY: a job handle is a kernel object handle; the calls used on it are thread-safe.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> io::Result<Job> {
        // SAFETY: plain Win32 calls with valid pointers; the handle is owned by the returned Job.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle == 0 {
                return Err(io::Error::last_os_error());
            }
            let job = Job(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    pub fn assign(&self, child: &Child) -> io::Result<()> {
        // SAFETY: both handles are valid for the duration of the call.
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Puts the process `pid` in the job (for a child whose handle the spawner keeps, such as a PTY child).
    pub fn assign_pid(&self, pid: u32) -> io::Result<()> {
        // SAFETY: the process handle is opened, used and closed inside this call.
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process == 0 {
                return Err(io::Error::last_os_error());
            }
            let ok = AssignProcessToJobObject(self.0, process);
            let err = io::Error::last_os_error();
            CloseHandle(process);
            if ok == 0 {
                Err(err)
            } else {
                Ok(())
            }
        }
    }

    /// True when the process `pid` is a member of this job.
    pub fn contains_pid(&self, pid: u32) -> bool {
        // SAFETY: the process handle is opened, used and closed inside this call.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process == 0 {
                return false;
            }
            let mut inside = 0;
            let ok = IsProcessInJob(process, self.0, &mut inside);
            CloseHandle(process);
            ok != 0 && inside != 0
        }
    }

    pub fn terminate(&self) {
        // SAFETY: valid job handle. Failure means the job is already empty.
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }

    pub fn active_processes(&self) -> Option<u32> {
        // SAFETY: the out structure is zeroed, correctly sized and lives across the call.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            if ok == 0 {
                None
            } else {
                Some(info.ActiveProcesses)
            }
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Closing the last handle kills whatever is still in the job (KILL_ON_JOB_CLOSE).
        // SAFETY: the handle is owned and closed once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_util::{hidden_command, pid_alive};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    fn sleeper() -> Child {
        hidden_command("ping").args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().expect("start ping")
    }

    fn gone_within(pid: u32, wait: Duration) -> bool {
        let end = Instant::now() + wait;
        while Instant::now() < end {
            if !pid_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        !pid_alive(pid)
    }

    #[test]
    fn a_child_in_the_job_dies_when_the_job_is_dropped() {
        let mut child = sleeper();
        let pid = child.id();
        let job = Job::new().expect("job");
        job.assign(&child).expect("assign");
        assert_eq!(job.active_processes(), Some(1));
        assert!(pid_alive(pid));
        drop(job);
        assert!(gone_within(pid, Duration::from_secs(5)), "the child must be gone once the job closed");
        let _ = child.wait();
    }

    #[test]
    fn a_child_assigned_by_pid_dies_when_the_job_is_dropped() {
        let mut child = sleeper();
        let pid = child.id();
        let job = Job::new().expect("job");
        job.assign_pid(pid).expect("assign by pid");
        assert_eq!(job.active_processes(), Some(1));
        drop(job);
        assert!(gone_within(pid, Duration::from_secs(5)));
        let _ = child.wait();
    }

    #[test]
    fn terminate_ends_the_members_but_leaves_other_processes() {
        let mut inside = sleeper();
        let mut outside = sleeper();
        let job = Job::new().expect("job");
        job.assign(&inside).expect("assign");
        job.terminate();
        assert!(gone_within(inside.id(), Duration::from_secs(5)));
        assert!(pid_alive(outside.id()), "a process outside the job is untouched");
        let _ = inside.wait();
        let _ = outside.kill();
        let _ = outside.wait();
    }

    #[test]
    fn assigning_a_missing_pid_is_an_error_not_a_panic() {
        let job = Job::new().expect("job");
        assert!(job.assign_pid(0x7fff_fff0).is_err());
    }
}
