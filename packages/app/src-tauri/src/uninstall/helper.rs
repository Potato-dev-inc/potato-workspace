//! The cleanup helper: the last stage of "Uninstall everything".
//!
//! The running app copies its own exe to `%TEMP%\potato-cleanup-<rand>.exe` and starts it detached with
//! `--potato-cleanup <args>` (no extra program ships: `main` hands this flag to [`run_cli`]). The app
//! then exits, and the helper:
//!
//!   1. waits for the app to be gone (kills only that PID after 20 s),
//!   2. deletes the app's data folders (locked files: retry, then delete at next restart),
//!   3. removes the program with `msiexec /x` (the one Windows permission prompt),
//!   4. deletes the install key it can leave behind,
//!   5. shows "Done" and opens the report,
//!   6. deletes itself.
//!
//! Every OS call goes through [`Os`], so the order is a unit test with a fake.

use std::path::{Path, PathBuf};

use super::roots::is_our_id;
use super::UPGRADE_CODE;

/// What the app tells the helper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperArgs {
    pub app_pid: u32,
    /// App ids of the profiles to remove (`com.potatodev.workspace[.profile-x]`).
    pub ids: Vec<String>,
    pub appdata: PathBuf,
    pub localappdata: PathBuf,
    /// Paths inside the app data to leave (chats or sign-ins the person chose to keep).
    pub keep: Vec<PathBuf>,
    pub remove_data: bool,
    pub remove_program: bool,
    pub report: PathBuf,
    pub temp: PathBuf,
}

impl HelperArgs {
    /// The command line after the exe name, starting with the flag.
    pub fn to_cli(&self) -> Vec<String> {
        let mut a = vec![super::HELPER_FLAG.to_string(), "--pid".into(), self.app_pid.to_string()];
        for id in &self.ids {
            a.extend(["--id".into(), id.clone()]);
        }
        a.extend(["--appdata".into(), self.appdata.display().to_string(), "--localappdata".into(), self.localappdata.display().to_string()]);
        for k in &self.keep {
            a.extend(["--keep".into(), k.display().to_string()]);
        }
        if self.remove_data {
            a.push("--remove-data".into());
        }
        if self.remove_program {
            a.push("--remove-program".into());
        }
        a.extend(["--report".into(), self.report.display().to_string(), "--temp".into(), self.temp.display().to_string()]);
        a
    }

    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut out = Self {
            app_pid: 0,
            ids: Vec::new(),
            appdata: PathBuf::new(),
            localappdata: PathBuf::new(),
            keep: Vec::new(),
            remove_data: false,
            remove_program: false,
            report: PathBuf::new(),
            temp: PathBuf::new(),
        };
        let mut it = args.iter().skip_while(|a| a.as_str() != super::HELPER_FLAG).skip(1);
        while let Some(flag) = it.next() {
            let mut value = || it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
            match flag.as_str() {
                "--pid" => out.app_pid = value()?.parse().map_err(|_| "bad --pid".to_string())?,
                "--id" => out.ids.push(value()?),
                "--appdata" => out.appdata = PathBuf::from(value()?),
                "--localappdata" => out.localappdata = PathBuf::from(value()?),
                "--keep" => out.keep.push(PathBuf::from(value()?)),
                "--report" => out.report = PathBuf::from(value()?),
                "--temp" => out.temp = PathBuf::from(value()?),
                "--remove-data" => out.remove_data = true,
                "--remove-program" => out.remove_program = true,
                other => return Err(format!("unknown option {other}")),
            }
        }
        if out.app_pid == 0 {
            return Err("--pid is required".into());
        }
        Ok(out)
    }
}

/// How `msiexec /x` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsiResult {
    Removed,
    /// The person said no to the Windows prompt (or no permission).
    Refused,
    Failed(i32),
}

/// Everything the helper does to the PC.
pub trait Os {
    fn pid_alive(&self, pid: u32) -> bool;
    fn kill_pid(&self, pid: u32);
    fn sleep_ms(&self, ms: u64);
    fn is_dir(&self, path: &Path) -> bool;
    fn exists(&self, path: &Path) -> bool;
    fn read_dir(&self, path: &Path) -> Vec<PathBuf>;
    fn remove_file(&self, path: &Path) -> Result<(), String>;
    fn remove_dir(&self, path: &Path) -> Result<(), String>;
    /// Ask Windows to delete `path` at the next restart. True when it was queued.
    fn delete_on_reboot(&self, path: &Path) -> bool;
    /// Product codes of installed copies with the upgrade code (`{...}`).
    fn product_codes(&self, upgrade_code: &str) -> Vec<String>;
    fn msiexec_remove(&self, product_code: &str) -> MsiResult;
    /// Delete HKCU `Software\potatodev\Potato Workspace`, then `Software\potatodev` if empty.
    fn delete_install_key(&self) -> Result<(), String>;
    fn append_report(&self, report: &Path, text: &str);
    /// The small "Done" window; then the report opens.
    fn show_done(&self, report: &Path, summary: &str);
    fn schedule_self_delete(&self);
}

/// What happened, in order. Tests read this.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HelperReport {
    pub steps: Vec<String>,
    pub locked: Vec<PathBuf>,
    pub program_refused: bool,
    pub killed_app: bool,
}

const WAIT_STEP_MS: u64 = 250;
const WAIT_LIMIT_MS: u64 = 20_000;
const AFTER_EXIT_MS: u64 = 2_000;
const RETRIES: u32 = 5;
pub const REFUSED_TEXT: &str = "Windows did not allow removing the program. Open Settings > Apps > Potato Workspace to finish.";

pub fn run_helper(args: &HelperArgs, os: &dyn Os) -> HelperReport {
    let mut report = HelperReport::default();

    // 1. Wait for the app.
    let mut waited = 0;
    while os.pid_alive(args.app_pid) && waited < WAIT_LIMIT_MS {
        os.sleep_ms(WAIT_STEP_MS);
        waited += WAIT_STEP_MS;
    }
    if os.pid_alive(args.app_pid) {
        os.kill_pid(args.app_pid);
        report.killed_app = true;
    }
    os.sleep_ms(AFTER_EXIT_MS);
    report.steps.push("wait".into());

    // 2. App data.
    if args.remove_data {
        let base = crate::app_paths::app_id_for(None);
        for id in args.ids.iter().filter(|id| is_our_id(&base, id)) {
            for root in [&args.appdata, &args.localappdata] {
                let dir = root.join(id);
                if os.exists(&dir) {
                    delete_tree(os, &dir, &args.keep, &mut report.locked);
                }
            }
        }
        report.steps.push("delete_data".into());
    }

    // 3 + 4. The program.
    if args.remove_program {
        let codes = os.product_codes(UPGRADE_CODE);
        let mut refused = false;
        for code in &codes {
            match os.msiexec_remove(code) {
                MsiResult::Removed => {}
                MsiResult::Refused => refused = true,
                MsiResult::Failed(_) => refused = true,
            }
        }
        report.steps.push("msiexec".into());
        report.program_refused = refused;
        if !refused {
            let _ = os.delete_install_key();
            report.steps.push("registry".into());
        }
    }

    // 5. Report and the Done window.
    let mut extra = String::new();
    if report.program_refused {
        extra.push_str(&format!("\n{REFUSED_TEXT}\n"));
    }
    if !report.locked.is_empty() {
        extra.push_str("\nThese files were in use. Windows will delete them when you restart:\n");
        for p in &report.locked {
            extra.push_str(&format!("  - {}\n", p.display()));
        }
    }
    if !extra.is_empty() {
        os.append_report(&args.report, &extra);
    }
    let summary = if report.program_refused { REFUSED_TEXT.to_string() } else { "Done. Here is what was left.".to_string() };
    os.show_done(&args.report, &summary);
    report.steps.push("report".into());

    // 6. Go.
    os.schedule_self_delete();
    report.steps.push("self_delete".into());
    report
}

/// Delete `path` and everything under it except the paths in `keep` (and the folders that lead to them).
/// Returns true when `path` itself is gone.
fn delete_tree(os: &dyn Os, path: &Path, keep: &[PathBuf], locked: &mut Vec<PathBuf>) -> bool {
    if keep.iter().any(|k| k == path) {
        return false;
    }
    if os.is_dir(path) {
        let mut all_gone = true;
        for kid in os.read_dir(path) {
            all_gone &= delete_tree(os, &kid, keep, locked);
        }
        // A folder that leads to something kept stays.
        if !all_gone || keep.iter().any(|k| k.starts_with(path)) {
            return false;
        }
        remove_with_retry(os, path, true, locked)
    } else {
        remove_with_retry(os, path, false, locked)
    }
}

fn remove_with_retry(os: &dyn Os, path: &Path, dir: bool, locked: &mut Vec<PathBuf>) -> bool {
    for attempt in 0..RETRIES {
        let result = if dir { os.remove_dir(path) } else { os.remove_file(path) };
        if result.is_ok() || !os.exists(path) {
            return true;
        }
        os.sleep_ms(200 * u64::from(attempt + 1));
    }
    if os.delete_on_reboot(path) {
        locked.push(path.to_path_buf());
    }
    false
}

/// `main` calls this first: `Some(exit code)` when the command line is the cleanup helper's.
pub fn run_cli(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == super::HELPER_FLAG) {
        return None;
    }
    let code = match HelperArgs::parse(args) {
        Ok(parsed) => {
            run_helper(&parsed, &super::helper_os::RealOs::new());
            0
        }
        Err(_) => 2,
    };
    Some(code)
}
