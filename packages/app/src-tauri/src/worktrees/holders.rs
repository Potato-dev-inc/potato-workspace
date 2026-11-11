//! Which processes still hold files under a folder that could not be deleted. Windows asks the
//! Restart Manager (it names every process with an open handle to a file); other systems answer
//! with an empty list. Only ever reads below the path it is given.

use serde::Serialize;
use std::path::Path;

/// A process that keeps a file of the folder open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Holder {
    pub pid: u32,
    pub name: String,
}

/// Most files handed to the Restart Manager (a bounded, breadth-first walk of the folder).
pub const MAX_FILES: usize = 2000;

/// The processes holding files under `root`. Empty when none can be found.
pub fn find(root: &Path) -> Vec<Holder> {
    #[cfg(windows)]
    {
        windows::find(root)
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Vec::new()
    }
}

/// Files below `root` (breadth first, symlinks never followed), at most `limit`.
pub fn sample_files(root: &Path, limit: usize) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    let mut dirs = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = dirs.pop_front() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.filter_map(Result::ok) {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                dirs.push_back(entry.path());
            } else if kind.is_file() {
                files.push(entry.path());
                if files.len() >= limit {
                    return files;
                }
            }
        }
    }
    files
}

/// "name (PID n), name (PID m)" for the message.
pub fn describe(holders: &[Holder]) -> String {
    holders.iter().map(|h| format!("{} (PID {})", h.name, h.pid)).collect::<Vec<_>>().join(", ")
}

#[cfg(windows)]
mod windows {
    use super::{sample_files, Holder, MAX_FILES};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY, RM_PROCESS_INFO,
    };

    pub fn find(root: &Path) -> Vec<Holder> {
        let wide: Vec<Vec<u16>> = sample_files(root, MAX_FILES)
            .iter()
            .map(|p| p.as_os_str().encode_wide().chain(std::iter::once(0)).collect())
            .collect();
        if wide.is_empty() {
            return Vec::new();
        }
        let pointers: Vec<*const u16> = wide.iter().map(|w| w.as_ptr()).collect();
        let mut session: u32 = 0;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        // SAFETY: plain Restart Manager calls; every pointer outlives the call it is passed to, and
        // the session is always ended before returning.
        unsafe {
            if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
                return Vec::new();
            }
            let mut found = Vec::new();
            if RmRegisterResources(
                session,
                pointers.len() as u32,
                pointers.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
            ) == 0
            {
                let mut capacity: u32 = 16;
                for _ in 0..3 {
                    let mut needed: u32 = 0;
                    let mut count = capacity;
                    let mut reasons: u32 = 0;
                    let mut infos: Vec<RM_PROCESS_INFO> = vec![std::mem::zeroed(); capacity as usize];
                    let status = RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reasons);
                    if status == 0 {
                        for info in infos.iter().take(count as usize) {
                            let len = info.strAppName.iter().position(|c| *c == 0).unwrap_or(info.strAppName.len());
                            found.push(Holder {
                                pid: info.Process.dwProcessId,
                                name: String::from_utf16_lossy(&info.strAppName[..len]),
                            });
                        }
                        break;
                    } else if status == ERROR_MORE_DATA {
                        capacity = needed.max(capacity + 1);
                    } else {
                        break;
                    }
                }
            }
            RmEndSession(session);
            found
        }
    }
}
