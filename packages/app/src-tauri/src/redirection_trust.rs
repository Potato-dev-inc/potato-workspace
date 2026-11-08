//! Windows "redirection trust": a process mitigation that makes a process refuse to follow
//! junctions and symbolic links created by non-admin users.
//!
//! `msiexec.exe` runs with it enforced, and the app the installer starts at the end of an install or
//! update inherits it, and so do the app's webview and every pane's shell. A pane then cannot start
//! a program that is reached through a user's link (Codex is: a junction into `~\.codex`, and a
//! `WinGet\Links` symlink), and fails with "No application is associated". Starting the app from the
//! Start menu clears it. So at startup the app checks its own policy and, when it is enforced,
//! starts a fresh copy through `explorer.exe` (a normal child of the user's shell) and exits.
//!
//! Order with the single-instance lock: the old copy holds the lock until it exits. It writes a
//! marker (its pid and the time), asks Explorer to start the new copy and exits at once. The new copy
//! sees the fresh marker, waits for that pid to be gone, and only then goes on to take the lock.
//! The marker is also the loop guard: a copy that finds a fresh marker and is still enforced never
//! relaunches again; it keeps running and the panes explain the problem honestly.

use std::path::PathBuf;
use std::time::Duration;

/// A marker older than this is a leftover of an earlier run and is ignored.
const MARKER_MAX_AGE_SECS: u64 = 60;
/// How long a relaunched copy waits for the copy that started it to be gone.
const OLD_COPY_WAIT: Duration = Duration::from_secs(15);

/// The sentence shown in panes and in the setup check while the policy is enforced.
pub const RESTART_ADVICE: &str = "Close Potato Workspace and open it again from the Start menu.";

/// What the startup guard decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Not enforced: carry on.
    Nothing,
    /// Enforced and this is the first try: start a fresh copy and exit.
    Relaunch,
    /// Enforced, and a relaunch was already tried (or cannot be done): carry on and warn.
    WarnOnly,
}

/// The pure rule. `marker_fresh`: an earlier copy asked for this relaunch a moment ago.
pub fn decide(enforced: bool, marker_fresh: bool) -> Decision {
    match (enforced, marker_fresh) {
        (false, _) => Decision::Nothing,
        (true, false) => Decision::Relaunch,
        (true, true) => Decision::WarnOnly,
    }
}

/// What the guard tells `run`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Go on starting the app. The text, when present, is something to log.
    Continue(Option<String>),
    /// A fresh copy was asked for; this process must exit now.
    Exit,
}

/// The operating-system side of the guard, behind a trait so the order of steps is unit-tested.
pub trait Os {
    /// `Ok(true)` when this process has the policy enforced.
    fn enforced(&self) -> Result<bool, String>;
    fn now_secs(&self) -> u64;
    fn own_pid(&self) -> u32;
    /// The marker's `(pid, written_at_secs)`, if there is one.
    fn read_marker(&self) -> Option<(u32, u64)>;
    fn write_marker(&self, pid: u32, at_secs: u64) -> Result<(), String>;
    fn remove_marker(&self);
    /// Starts the app's own exe through Explorer.
    fn start_through_explorer(&self) -> Result<(), String>;
    /// Blocks until process `pid` has ended, or `limit` passes.
    fn wait_for_exit(&self, pid: u32, limit: Duration);
}

/// The startup guard. Call it before anything is spawned and before the single-instance lock.
pub fn guard(os: &dyn Os) -> Outcome {
    let now = os.now_secs();
    let own = os.own_pid();
    let marker = os.read_marker().filter(|(pid, at)| *pid != own && now.saturating_sub(*at) <= MARKER_MAX_AGE_SECS);
    // We are the relaunched copy: the copy that started us still holds the single-instance lock until
    // it is gone, so let it finish first.
    if let Some((old, _)) = marker {
        os.wait_for_exit(old, OLD_COPY_WAIT);
    }
    let enforced = match os.enforced() {
        Ok(v) => v,
        Err(e) => {
            os.remove_marker();
            return Outcome::Continue(Some(format!("could not read the redirection trust policy: {e}")));
        }
    };
    match decide(enforced, marker.is_some()) {
        Decision::Nothing => {
            os.remove_marker();
            Outcome::Continue(None)
        }
        Decision::Relaunch => {
            if let Err(e) = os.write_marker(own, now) {
                return warn_only(format!(
                    "redirection trust is enforced; no marker could be written ({e}), so no relaunch"
                ));
            }
            match os.start_through_explorer() {
                Ok(()) => Outcome::Exit,
                Err(e) => {
                    os.remove_marker();
                    warn_only(format!("redirection trust is enforced and Explorer could not start a fresh copy: {e}"))
                }
            }
        }
        Decision::WarnOnly => {
            os.remove_marker();
            warn_only("redirection trust is still enforced after a relaunch; links will not be followed".into())
        }
    }
}

fn warn_only(text: String) -> Outcome {
    Outcome::Continue(Some(text))
}

/// Whether this process has the policy enforced right now (a live query; false off Windows or when
/// it cannot be read).
pub fn enforced() -> bool {
    RealOs.enforced().unwrap_or(false)
}

/// `guard` with the real operating system. Windows only; elsewhere it does nothing.
pub fn guard_at_startup() -> Outcome {
    #[cfg(windows)]
    {
        guard(&RealOs)
    }
    #[cfg(not(windows))]
    {
        Outcome::Continue(None)
    }
}

struct RealOs;

#[cfg(windows)]
impl RealOs {
    fn marker_path() -> PathBuf {
        let suffix = crate::app_paths::profile().map(|p| format!("-{p}")).unwrap_or_default();
        std::env::temp_dir().join(format!("potato-workspace-relaunch{suffix}.marker"))
    }
}

#[cfg(windows)]
impl Os for RealOs {
    fn enforced(&self) -> Result<bool, String> {
        query_flags().map(|flags| flags & ENFORCE_REDIRECTION_TRUST != 0)
    }
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }
    fn own_pid(&self) -> u32 {
        std::process::id()
    }
    fn read_marker(&self) -> Option<(u32, u64)> {
        let text = std::fs::read_to_string(Self::marker_path()).ok()?;
        let mut parts = text.split_whitespace();
        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
    }
    fn write_marker(&self, pid: u32, at_secs: u64) -> Result<(), String> {
        std::fs::write(Self::marker_path(), format!("{pid} {at_secs}")).map_err(|e| e.to_string())
    }
    fn remove_marker(&self) {
        let _ = std::fs::remove_file(Self::marker_path());
    }
    fn start_through_explorer(&self) -> Result<(), String> {
        let exe: PathBuf = std::env::current_exe().map_err(|e| e.to_string())?;
        crate::proc_util::hidden_command("explorer.exe").arg(exe).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    fn wait_for_exit(&self, pid: u32, limit: Duration) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        const SYNCHRONIZE: u32 = 0x0010_0000;
        // SAFETY: plain handle calls; the handle is closed right after the wait.
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, pid);
            if handle == 0 {
                return; // already gone (or not ours to wait on)
            }
            WaitForSingleObject(handle, limit.as_millis().min(u32::MAX as u128) as u32);
            CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
impl Os for RealOs {
    fn enforced(&self) -> Result<bool, String> {
        Ok(false)
    }
    fn now_secs(&self) -> u64 {
        0
    }
    fn own_pid(&self) -> u32 {
        std::process::id()
    }
    fn read_marker(&self) -> Option<(u32, u64)> {
        None
    }
    fn write_marker(&self, _: u32, _: u64) -> Result<(), String> {
        Ok(())
    }
    fn remove_marker(&self) {}
    fn start_through_explorer(&self) -> Result<(), String> {
        Err("not Windows".into())
    }
    fn wait_for_exit(&self, _: u32, _: Duration) {}
}

/// `PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY.Flags`: bit 0 EnforceRedirectionTrust.
#[cfg(windows)]
const ENFORCE_REDIRECTION_TRUST: u32 = 0x1;

/// `ProcessRedirectionTrustPolicy` of the `PROCESS_MITIGATION_POLICY` enum.
#[cfg(windows)]
const PROCESS_REDIRECTION_TRUST_POLICY: i32 = 16;

/// The policy flags of this process.
#[cfg(windows)]
pub fn query_flags() -> Result<u32, String> {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessMitigationPolicy};
    let mut flags: u32 = 0;
    // SAFETY: the buffer is a u32, the size the policy struct has.
    let ok = unsafe {
        GetProcessMitigationPolicy(
            GetCurrentProcess(),
            PROCESS_REDIRECTION_TRUST_POLICY,
            &mut flags as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        enforced: Result<bool, String>,
        marker: RefCell<Option<(u32, u64)>>,
        explorer_ok: bool,
        log: RefCell<Vec<String>>,
    }
    impl Fake {
        fn new(enforced: bool, marker: Option<(u32, u64)>) -> Self {
            Fake { enforced: Ok(enforced), marker: RefCell::new(marker), explorer_ok: true, log: RefCell::default() }
        }
        fn log(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
    }
    impl Os for Fake {
        fn enforced(&self) -> Result<bool, String> {
            self.enforced.clone()
        }
        fn now_secs(&self) -> u64 {
            1000
        }
        fn own_pid(&self) -> u32 {
            7
        }
        fn read_marker(&self) -> Option<(u32, u64)> {
            *self.marker.borrow()
        }
        fn write_marker(&self, pid: u32, at: u64) -> Result<(), String> {
            self.log.borrow_mut().push("write_marker".into());
            *self.marker.borrow_mut() = Some((pid, at));
            Ok(())
        }
        fn remove_marker(&self) {
            self.log.borrow_mut().push("remove_marker".into());
            *self.marker.borrow_mut() = None;
        }
        fn start_through_explorer(&self) -> Result<(), String> {
            self.log.borrow_mut().push("explorer".into());
            if self.explorer_ok {
                Ok(())
            } else {
                Err("no explorer".into())
            }
        }
        fn wait_for_exit(&self, pid: u32, _: Duration) {
            self.log.borrow_mut().push(format!("wait {pid}"));
        }
    }

    #[test]
    fn decision_table() {
        assert_eq!(decide(false, false), Decision::Nothing);
        assert_eq!(decide(false, true), Decision::Nothing);
        assert_eq!(decide(true, false), Decision::Relaunch);
        assert_eq!(decide(true, true), Decision::WarnOnly);
    }

    #[test]
    fn enforced_without_a_marker_relaunches_and_exits() {
        let os = Fake::new(true, None);
        assert_eq!(guard(&os), Outcome::Exit);
        assert_eq!(os.log(), ["write_marker", "explorer"]);
        assert_eq!(*os.marker.borrow(), Some((7, 1000)));
    }

    #[test]
    fn enforced_with_a_fresh_marker_waits_for_the_old_copy_then_warns_without_relaunching() {
        let os = Fake::new(true, Some((99, 990)));
        let out = guard(&os);
        assert!(matches!(out, Outcome::Continue(Some(_))), "{out:?}");
        assert_eq!(os.log(), ["wait 99", "remove_marker"]);
    }

    #[test]
    fn a_clear_flag_does_nothing_and_clears_the_marker() {
        let os = Fake::new(false, Some((99, 990)));
        assert_eq!(guard(&os), Outcome::Continue(None));
        assert_eq!(os.log(), ["wait 99", "remove_marker"]);
        let plain = Fake::new(false, None);
        assert_eq!(guard(&plain), Outcome::Continue(None));
    }

    #[test]
    fn a_stale_marker_is_ignored_so_a_later_install_relaunches_again() {
        let os = Fake::new(true, Some((99, 100)));
        assert_eq!(guard(&os), Outcome::Exit);
        assert!(!os.log().iter().any(|l| l.starts_with("wait")));
    }

    #[test]
    fn a_marker_of_our_own_pid_is_not_a_relaunch() {
        let os = Fake::new(true, Some((7, 999)));
        assert_eq!(guard(&os), Outcome::Exit);
    }

    #[test]
    fn explorer_failing_keeps_the_app_running_with_a_warning() {
        let mut os = Fake::new(true, None);
        os.explorer_ok = false;
        let out = guard(&os);
        assert!(matches!(out, Outcome::Continue(Some(ref t)) if t.contains("no explorer")), "{out:?}");
        assert_eq!(*os.marker.borrow(), None);
    }

    #[test]
    fn an_unreadable_policy_does_not_relaunch() {
        let mut os = Fake::new(true, None);
        os.enforced = Err("denied".into());
        assert!(matches!(guard(&os), Outcome::Continue(Some(_))));
        assert!(!os.log().contains(&"explorer".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn the_real_query_of_this_process_succeeds() {
        let flags = query_flags().expect("the policy can be read");
        eprintln!("redirection trust flags of the test process: {flags:#x}");
    }
}
