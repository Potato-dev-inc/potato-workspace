//! Who a process is: its creation time and program path. A pid alone is not an identity (the system
//! reuses pids), so anything that acts on a pid remembered from an earlier run checks this too.

/// Creation time (platform ticks, only compared for equality) and program path of one process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcIdentity {
    pub start: u64,
    pub exe: String,
}

/// The identity of the running process `pid`, or `None` when it is gone or cannot be read.
pub fn identity_of(pid: u32) -> Option<ProcIdentity> {
    if pid == 0 {
        return None;
    }
    imp::identity_of(pid)
}

/// The same program path (case and separators ignored, as Windows treats paths).
pub fn same_exe(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    !a.is_empty() && norm(a) == norm(b)
}

#[cfg(windows)]
mod imp {
    use super::ProcIdentity;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub fn identity_of(pid: u32) -> Option<ProcIdentity> {
        // SAFETY: the handle is opened, used and closed in this function; buffers outlive the calls.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return None;
            }
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let times = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let named = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if times == 0 || named == 0 {
                return None;
            }
            // An exited process whose handle someone still holds keeps a non-zero exit time.
            if exited.dwLowDateTime != 0 || exited.dwHighDateTime != 0 {
                return None;
            }
            Some(ProcIdentity {
                start: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                exe: String::from_utf16_lossy(&buf[..len as usize]),
            })
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::ProcIdentity;

    pub fn identity_of(pid: u32) -> Option<ProcIdentity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The command name is in parentheses and may hold spaces: fields count from after the last ')'.
        let rest = stat.rsplit_once(')')?.1;
        // Field 22 (starttime) is the 20th after the state field's predecessor split here.
        let start = rest.split_whitespace().nth(19)?.parse::<u64>().ok()?;
        let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?.to_string_lossy().to_string();
        Some(ProcIdentity { start, exe })
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::ProcIdentity;

    /// No cheap, dependable reading here: nothing is recorded and nothing is swept.
    pub fn identity_of(_pid: u32) -> Option<ProcIdentity> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_paths_compare_without_case_or_separator_differences() {
        assert!(same_exe(r"C:\Tools\Node.EXE", "c:/tools/node.exe"));
        assert!(!same_exe(r"C:\a\node.exe", r"C:\b\node.exe"));
        assert!(!same_exe("", ""));
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn the_running_test_process_has_a_stable_identity() {
        let me = std::process::id();
        let a = identity_of(me).expect("own identity");
        let b = identity_of(me).expect("own identity again");
        assert_eq!(a, b);
        assert!(!a.exe.is_empty());
    }

    #[test]
    fn pid_zero_and_a_missing_pid_have_no_identity() {
        assert!(identity_of(0).is_none());
        assert!(identity_of(0x7fff_fff0).is_none());
    }
}
