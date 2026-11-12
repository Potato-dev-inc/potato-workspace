//! The real PC for the cleanup helper. Only `helper::run_cli` builds this; no test does.

use std::path::{Path, PathBuf};

use super::helper::{MsiResult, Os};

pub struct RealOs;

impl RealOs {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`: the only shape that is ever put on a command line.
pub fn is_product_code(code: &str) -> bool {
    code.len() == 38 && code.starts_with('{') && code.ends_with('}') && code[1..37].chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Exit code of `msiexec /x` to what it means.
pub fn msi_result(code: i32) -> MsiResult {
    match code {
        0 | 3010 | 1641 | 1605 => MsiResult::Removed,
        1223 | 1925 | 5 => MsiResult::Refused,
        other => MsiResult::Failed(other),
    }
}

impl Os for RealOs {
    #[cfg(windows)]
    fn pid_alive(&self, pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        // SAFETY: plain handle calls; the handle is closed before returning.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle == 0 {
                return false;
            }
            let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            alive
        }
    }
    #[cfg(not(windows))]
    fn pid_alive(&self, _pid: u32) -> bool {
        false
    }

    #[cfg(windows)]
    fn kill_pid(&self, pid: u32) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        // SAFETY: opens this one PID for termination and closes the handle.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle != 0 {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
    #[cfg(not(windows))]
    fn kill_pid(&self, _pid: u32) {}

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn is_dir(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false)
    }
    fn exists(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok()
    }
    fn read_dir(&self, path: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(path).map(|r| r.filter_map(Result::ok).map(|e| e.path()).collect()).unwrap_or_default()
    }
    fn remove_file(&self, path: &Path) -> Result<(), String> {
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(path, perms);
            }
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
    fn remove_dir(&self, path: &Path) -> Result<(), String> {
        std::fs::remove_dir(path).map_err(|e| e.to_string())
    }

    #[cfg(windows)]
    fn delete_on_reboot(&self, path: &Path) -> bool {
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
        let w = wide_path(path);
        // SAFETY: `w` is a NUL-terminated wide string that outlives the call.
        unsafe { MoveFileExW(w.as_ptr(), std::ptr::null(), MOVEFILE_DELAY_UNTIL_REBOOT) != 0 }
    }
    #[cfg(not(windows))]
    fn delete_on_reboot(&self, _path: &Path) -> bool {
        false
    }

    #[cfg(windows)]
    fn product_codes(&self, upgrade_code: &str) -> Vec<String> {
        use windows_sys::Win32::System::ApplicationInstallationAndServicing::MsiEnumRelatedProductsW;
        let upgrade = wide(upgrade_code);
        let mut out = Vec::new();
        for index in 0..32u32 {
            let mut buf = [0u16; 39];
            // SAFETY: the buffer holds the 39 characters (GUID, braces and NUL) the API writes.
            let rc = unsafe { MsiEnumRelatedProductsW(upgrade.as_ptr(), 0, index, buf.as_mut_ptr()) };
            if rc != 0 {
                break;
            }
            let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
            out.push(String::from_utf16_lossy(&buf[..len]));
        }
        out
    }
    #[cfg(not(windows))]
    fn product_codes(&self, _upgrade_code: &str) -> Vec<String> {
        Vec::new()
    }

    fn msiexec_remove(&self, product_code: &str) -> MsiResult {
        if !is_product_code(product_code) {
            return MsiResult::Failed(-1);
        }
        // `Start-Process -Verb RunAs` shows the one Windows permission prompt; a "No" ends as 1223.
        let script = format!(
            "try {{ $p = Start-Process msiexec.exe -ArgumentList '/x {product_code} /qb REBOOT=ReallySuppress' -Verb RunAs -Wait -PassThru; exit $p.ExitCode }} catch {{ exit 1223 }}"
        );
        match crate::proc_util::hidden_command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).status() {
            Ok(status) => msi_result(status.code().unwrap_or(-1)),
            Err(_) => MsiResult::Failed(-1),
        }
    }

    #[cfg(windows)]
    fn delete_install_key(&self) -> Result<(), String> {
        use windows_sys::Win32::System::Registry::{RegDeleteKeyW, RegDeleteTreeW, HKEY_CURRENT_USER};
        let app = wide("Software\\potatodev\\Potato Workspace");
        let vendor = wide("Software\\potatodev");
        // SAFETY: NUL-terminated wide strings that outlive the calls. `RegDeleteKeyW` on the vendor key
        // fails while it still has subkeys, which is exactly "only if empty".
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, app.as_ptr());
            RegDeleteKeyW(HKEY_CURRENT_USER, app.as_ptr());
            RegDeleteKeyW(HKEY_CURRENT_USER, vendor.as_ptr());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    fn delete_install_key(&self) -> Result<(), String> {
        Ok(())
    }

    fn append_report(&self, report: &Path, text: &str) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(report) {
            let _ = f.write_all(text.as_bytes());
        }
    }

    fn show_done(&self, report: &Path, summary: &str) {
        let _ = crate::proc_util::hidden_command(if cfg!(windows) { "notepad.exe" } else { "open" }).arg(report).spawn();
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND};
            let text = wide(&format!("{summary}\n\nThe list of what was left is open in Notepad."));
            let title = wide("Potato Workspace");
            // SAFETY: NUL-terminated wide strings that outlive the call; no owner window.
            unsafe {
                MessageBoxW(0, text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND);
            }
        }
        #[cfg(not(windows))]
        let _ = summary;
    }

    fn schedule_self_delete(&self) {
        let Ok(exe) = std::env::current_exe() else { return };
        #[cfg(windows)]
        {
            // Not possible while running; a hidden shell deletes the file a moment after this process ends.
            let line = format!("ping -n 4 127.0.0.1 >nul & del /f /q \"{}\"", exe.display());
            let _ = crate::proc_util::hidden_command("cmd.exe").args(["/C", &line]).spawn();
        }
        #[cfg(not(windows))]
        let _ = std::fs::remove_file(exe);
    }
}
