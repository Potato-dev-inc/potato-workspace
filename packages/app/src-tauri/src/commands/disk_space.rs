//! How much room is left on the drive that holds the app's own data. The quiet start-up check on the page reads it and
//! shows one line only when it is low. Nothing here writes anything or reads a file name.

use serde::Serialize;
use std::path::Path;

/// What the page needs: the free bytes, or nothing when the drive could not be read.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    pub free_bytes: Option<u64>,
}

/// Free bytes for the drive that holds `path`, for the current user. `None` when the system gives no answer.
#[cfg(windows)]
pub fn free_bytes_for(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // The folder may not exist yet: walk up to the first parent that does.
    let mut dir = path;
    while !dir.exists() {
        dir = dir.parent()?;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the other two out-pointers may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
pub fn free_bytes_for(_path: &Path) -> Option<u64> {
    None
}

/// Free room on the drive of the app's data folder.
#[tauri::command]
pub fn disk_space() -> DiskSpace {
    DiskSpace { free_bytes: free_bytes_for(&crate::app_paths::app_data_dir()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_serializes_with_a_camel_case_key_and_null_when_unknown() {
        let json = serde_json::to_value(DiskSpace { free_bytes: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "freeBytes": null }));
        let json = serde_json::to_value(DiskSpace { free_bytes: Some(5) }).unwrap();
        assert_eq!(json, serde_json::json!({ "freeBytes": 5 }));
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_that_does_not_exist_yet_still_reads_its_drive() {
        let dir = std::env::temp_dir().join("pm-disk-space-test-missing").join("deeper");
        let free = free_bytes_for(&dir);
        assert!(free.is_some_and(|n| n > 0), "the drive of the temp folder has room: {free:?}");
    }

    #[cfg(windows)]
    #[test]
    fn a_path_with_no_drive_gives_no_answer_instead_of_a_wrong_number() {
        assert_eq!(free_bytes_for(Path::new("")), None);
    }
}
