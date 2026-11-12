//! The cleanup helper's order of work, with a fake PC. Nothing here touches a real process, file
//! outside the temp folder, registry key or installer.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::helper::*;

#[derive(Default)]
struct FakeOs {
    log: RefCell<Vec<String>>,
    /// Paths that exist. Directories end with `/`.
    fs: RefCell<BTreeSet<String>>,
    alive_polls: RefCell<u32>,
    msi: Option<MsiResult>,
    codes: Vec<String>,
    /// Files that refuse deletion this many times.
    locked: RefCell<std::collections::BTreeMap<String, u32>>,
    always_locked: Vec<String>,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

impl FakeOs {
    fn note(&self, line: impl Into<String>) {
        self.log.borrow_mut().push(line.into());
    }
    fn add_dir(&self, p: &str) {
        self.fs.borrow_mut().insert(format!("{p}/"));
    }
    fn add_file(&self, p: &str) {
        self.fs.borrow_mut().insert(p.to_string());
    }
    fn lines(&self) -> Vec<String> {
        self.log.borrow().clone()
    }
    fn position(&self, prefix: &str) -> usize {
        self.lines().iter().position(|l| l.starts_with(prefix)).unwrap_or_else(|| panic!("no `{prefix}` in {:?}", self.lines()))
    }
}

impl Os for FakeOs {
    fn pid_alive(&self, _pid: u32) -> bool {
        let mut n = self.alive_polls.borrow_mut();
        if *n == 0 {
            return false;
        }
        *n -= 1;
        true
    }
    fn kill_pid(&self, pid: u32) {
        self.note(format!("kill {pid}"));
        *self.alive_polls.borrow_mut() = 0;
    }
    fn sleep_ms(&self, ms: u64) {
        if ms == 2_000 {
            self.note("sleep_after_exit");
        }
    }
    fn is_dir(&self, p: &Path) -> bool {
        self.fs.borrow().contains(&format!("{}/", s(p)))
    }
    fn exists(&self, p: &Path) -> bool {
        self.is_dir(p) || self.fs.borrow().contains(&s(p))
    }
    fn read_dir(&self, p: &Path) -> Vec<PathBuf> {
        let base = format!("{}/", s(p));
        let mut out = BTreeSet::new();
        for entry in self.fs.borrow().iter() {
            if let Some(rest) = entry.strip_prefix(&base) {
                let first = rest.trim_end_matches('/').split('/').next().unwrap_or("");
                if !first.is_empty() {
                    out.insert(PathBuf::from(format!("{base}{first}")));
                }
            }
        }
        out.into_iter().collect()
    }
    fn remove_file(&self, p: &Path) -> Result<(), String> {
        let key = s(p);
        if self.always_locked.contains(&key) {
            return Err("in use".into());
        }
        if let Some(n) = self.locked.borrow_mut().get_mut(&key) {
            if *n > 0 {
                *n -= 1;
                return Err("in use".into());
            }
        }
        self.fs.borrow_mut().remove(&key);
        self.note(format!("rm {key}"));
        Ok(())
    }
    fn remove_dir(&self, p: &Path) -> Result<(), String> {
        let key = format!("{}/", s(p));
        if !self.read_dir(p).is_empty() {
            return Err("not empty".into());
        }
        self.fs.borrow_mut().remove(&key);
        self.note(format!("rmdir {}", s(p)));
        Ok(())
    }
    fn delete_on_reboot(&self, p: &Path) -> bool {
        self.note(format!("reboot_delete {}", s(p)));
        true
    }
    fn product_codes(&self, upgrade: &str) -> Vec<String> {
        self.note(format!("find_product {upgrade}"));
        self.codes.clone()
    }
    fn msiexec_remove(&self, code: &str) -> MsiResult {
        self.note(format!("msiexec /x {code}"));
        self.msi.unwrap_or(MsiResult::Removed)
    }
    fn delete_install_key(&self) -> Result<(), String> {
        self.note("registry");
        Ok(())
    }
    fn append_report(&self, _report: &Path, text: &str) {
        self.note(format!("append_report {}", text.trim().lines().next().unwrap_or("")));
    }
    fn show_done(&self, _report: &Path, summary: &str) {
        self.note(format!("done_window {summary}"));
    }
    fn schedule_self_delete(&self) {
        self.note("self_delete");
    }
}

fn args(keep: Vec<&str>) -> HelperArgs {
    HelperArgs {
        app_pid: 4242,
        ids: vec!["com.potatodev.workspace".into(), "com.potatodev.workspace.profile-work".into(), "com.puppetmaster.app".into(), "../escape".into()],
        appdata: PathBuf::from("/ad"),
        localappdata: PathBuf::from("/lad"),
        keep: keep.into_iter().map(PathBuf::from).collect(),
        remove_data: true,
        remove_program: true,
        report: PathBuf::from("/tmp/report.txt"),
        temp: PathBuf::from("/tmp"),
    }
}

fn os_with_data() -> FakeOs {
    let os = FakeOs { codes: vec!["{11111111-2222-3333-4444-555555555555}".into()], ..Default::default() };
    for d in ["/ad/com.potatodev.workspace", "/ad/com.potatodev.workspace/acp", "/ad/com.potatodev.workspace/acp/journals", "/ad/com.potatodev.workspace.profile-work", "/lad/com.potatodev.workspace", "/ad/com.puppetmaster.app"] {
        os.add_dir(d);
    }
    for f in ["/ad/com.potatodev.workspace/settings.json", "/ad/com.potatodev.workspace/acp/journals/j1", "/ad/com.potatodev.workspace.profile-work/x", "/lad/com.potatodev.workspace/y", "/ad/com.puppetmaster.app/theirs"] {
        os.add_file(f);
    }
    os
}

#[test]
fn the_order_is_wait_then_data_then_msiexec_then_registry_then_report_then_self_delete() {
    let os = os_with_data();
    *os.alive_polls.borrow_mut() = 3;
    let report = run_helper(&args(vec![]), &os);
    assert_eq!(report.steps, vec!["wait", "delete_data", "msiexec", "registry", "report", "self_delete"]);
    let first_rm = os.position("rm ");
    assert!(os.position("sleep_after_exit") < first_rm, "waits (plus 2 s) before deleting");
    assert!(first_rm < os.position("find_product"));
    assert!(os.position("find_product") < os.position("msiexec /x"));
    assert!(os.position("msiexec /x") < os.position("registry"));
    assert!(os.position("registry") < os.position("done_window Done"));
    assert!(os.position("done_window") < os.position("self_delete"));
    assert!(os.lines().iter().any(|l| l == "find_product {2E0398E3-228F-4C24-A750-390F8BD522D8}"), "found by the upgrade code");
    assert!(os.lines().iter().any(|l| l == "msiexec /x {11111111-2222-3333-4444-555555555555}"));
    assert!(!report.killed_app);
}

#[test]
fn only_our_profile_folders_are_deleted() {
    let os = os_with_data();
    run_helper(&args(vec![]), &os);
    assert!(!os.exists(Path::new("/ad/com.potatodev.workspace")));
    assert!(!os.exists(Path::new("/ad/com.potatodev.workspace.profile-work")));
    assert!(!os.exists(Path::new("/lad/com.potatodev.workspace")));
    assert!(os.exists(Path::new("/ad/com.puppetmaster.app/theirs")), "the other product stays");
    assert!(!os.lines().iter().any(|l| l.contains("escape")), "a name that is not an app id is ignored");
}

#[test]
fn an_app_that_will_not_exit_is_killed_after_the_wait_and_only_by_its_pid() {
    let os = os_with_data();
    *os.alive_polls.borrow_mut() = 10_000;
    let report = run_helper(&args(vec![]), &os);
    assert!(report.killed_app);
    assert_eq!(os.lines().iter().filter(|l| l.starts_with("kill ")).collect::<Vec<_>>(), vec!["kill 4242"]);
    assert!(os.position("kill 4242") < os.position("rm "));
}

#[test]
fn kept_paths_and_the_folders_leading_to_them_stay() {
    let os = os_with_data();
    run_helper(&args(vec!["/ad/com.potatodev.workspace/acp/journals"]), &os);
    assert!(os.exists(Path::new("/ad/com.potatodev.workspace/acp/journals/j1")));
    assert!(os.exists(Path::new("/ad/com.potatodev.workspace/acp")));
    assert!(!os.exists(Path::new("/ad/com.potatodev.workspace/settings.json")));
}

#[test]
fn a_locked_file_is_retried_then_left_for_the_next_restart() {
    let mut os = os_with_data();
    os.always_locked = vec!["/lad/com.potatodev.workspace/y".into()];
    os.locked.borrow_mut().insert("/ad/com.potatodev.workspace/settings.json".into(), 2);
    let report = run_helper(&args(vec![]), &os);
    assert!(!os.exists(Path::new("/ad/com.potatodev.workspace/settings.json")), "freed after two retries");
    assert_eq!(report.locked, vec![PathBuf::from("/lad/com.potatodev.workspace/y")]);
    assert!(os.lines().iter().any(|l| l == "reboot_delete /lad/com.potatodev.workspace/y"));
    assert!(os.lines().iter().any(|l| l.starts_with("append_report")), "the locked file is named in the report");
    assert!(!os.lines().iter().any(|l| l == "reboot_delete /ad/com.potatodev.workspace/settings.json"));
}

#[test]
fn if_windows_does_not_allow_it_the_app_data_is_gone_the_key_stays_and_the_message_says_what_to_do() {
    let os = FakeOs { msi: Some(MsiResult::Refused), codes: vec!["{11111111-2222-3333-4444-555555555555}".into()], ..os_with_data() };
    let report = run_helper(&args(vec![]), &os);
    assert!(report.program_refused);
    assert!(!os.exists(Path::new("/ad/com.potatodev.workspace")), "data was removed before the prompt");
    assert!(!os.lines().iter().any(|l| l == "registry"), "the program is still installed, so its key stays");
    assert!(os.lines().iter().any(|l| l == &format!("done_window {REFUSED_TEXT}")));
    assert!(REFUSED_TEXT.contains("Settings > Apps > Potato Workspace"));
    assert_eq!(report.steps.last().map(String::as_str), Some("self_delete"));
}

#[test]
fn unticked_parts_are_skipped() {
    let os = os_with_data();
    let mut a = args(vec![]);
    a.remove_program = false;
    let report = run_helper(&a, &os);
    assert!(!os.lines().iter().any(|l| l.starts_with("find_product") || l.starts_with("msiexec")));
    assert_eq!(report.steps, vec!["wait", "delete_data", "report", "self_delete"]);

    let os = os_with_data();
    let mut a = args(vec![]);
    a.remove_data = false;
    run_helper(&a, &os);
    assert!(os.exists(Path::new("/ad/com.potatodev.workspace/settings.json")));
}

#[test]
fn the_command_line_round_trips() {
    let a = args(vec!["/ad/x y/journals"]);
    let cli = a.to_cli();
    assert_eq!(cli[0], "--potato-cleanup");
    assert_eq!(HelperArgs::parse(&cli).unwrap(), a);
    assert!(HelperArgs::parse(&["--potato-cleanup".into()]).is_err(), "a pid is required");
    assert!(HelperArgs::parse(&["--potato-cleanup".into(), "--pid".into(), "1".into(), "--rm-rf".into()]).is_err());
    assert_eq!(run_cli(&["acp-bridge".into()]), None, "other command lines are not ours");
}

#[test]
fn product_codes_are_checked_before_they_reach_a_command_line() {
    use super::helper_os::{is_product_code, msi_result};
    assert!(is_product_code("{2E0398E3-228F-4C24-A750-390F8BD522D8}"));
    assert!(!is_product_code("{2E0398E3-228F-4C24-A750-390F8BD522D8}; calc"));
    assert!(!is_product_code("not a code"));
    assert_eq!(msi_result(0), MsiResult::Removed);
    assert_eq!(msi_result(3010), MsiResult::Removed);
    assert_eq!(msi_result(1223), MsiResult::Refused);
    assert_eq!(msi_result(1603), MsiResult::Failed(1603));
}

#[test]
fn the_upgrade_code_matches_the_installer_config() {
    let conf = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap();
    assert!(conf.contains(&super::UPGRADE_CODE.trim_matches(|c| c == '{' || c == '}').to_ascii_lowercase()));
}
