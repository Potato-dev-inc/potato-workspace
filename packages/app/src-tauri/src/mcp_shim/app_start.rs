//! Starting the desktop app when a call finds it not running.
//!
//! The shim used to answer `BRIDGE_UNAVAILABLE` and wait for a person. Now, once per session, it starts the installed app in
//! its tray-only mode (`--background`: no window, so no focus is taken), waits for the bridge and lets the caller retry the
//! call once. Where the app lives comes from `POTATO_WORKSPACE_APP_EXE`, or the file the app writes beside its port file at
//! every start (`app_paths::write_app_exe_file`), or the per-user install folder. Set `POTATO_WORKSPACE_NO_AUTOSTART=1` to
//! turn this off. Tests never start an app: they pass a fake [`AppLauncher`] to [`start_app`].

use super::*;
use std::path::Path;

/// `1` or `true` turns the automatic start off.
pub(crate) const NO_AUTOSTART_ENV: &str = "POTATO_WORKSPACE_NO_AUTOSTART";
/// Overrides where the app is looked for.
pub(crate) const APP_EXE_ENV: &str = "POTATO_WORKSPACE_APP_EXE";
use puppet_master_app_lib::app_paths::APP_EXE_FILE_NAME;
/// How long the bridge gets to come up after the start.
pub(crate) const START_WAIT: Duration = Duration::from_secs(30);
const START_POLL: Duration = Duration::from_millis(500);

/// What the shim needs from the machine to start the app. The real one launches a process; tests fake it.
pub(crate) trait AppLauncher {
    /// The installed app, when it can be found.
    fn app_exe(&self) -> Option<PathBuf>;
    /// Starts it without a window and without waiting for it.
    fn spawn(&self, exe: &Path) -> Result<(), String>;
    /// Whether the app's bridge answers now.
    fn bridge_answers(&self) -> bool;
    /// Waits between two checks.
    fn pause(&self, how_long: Duration);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartOutcome {
    /// The setting or environment variable turned it off.
    Disabled,
    /// This session already tried once.
    AlreadyTried,
    /// No installed app was found.
    NotInstalled,
    SpawnFailed(String),
    /// Started, but the bridge did not answer in time.
    NoAnswer,
    /// Started and the bridge answers.
    Started,
}

impl StartOutcome {
    /// A few words for the error a caller sees when the start did not work out.
    pub(crate) fn note(&self) -> String {
        match self {
            StartOutcome::Disabled => format!("starting the app from here is off ({NO_AUTOSTART_ENV})"),
            StartOutcome::AlreadyTried => "this session already tried to start it".into(),
            StartOutcome::NotInstalled => "no installed app was found to start".into(),
            StartOutcome::SpawnFailed(why) => format!("it could not be started: {why}"),
            StartOutcome::NoAnswer => format!("it was started but did not answer within {} seconds", START_WAIT.as_secs()),
            StartOutcome::Started => "it was started".into(),
        }
    }
}

/// Starts the app once. `tried` is the once-per-session flag; `enabled` is the setting.
pub(crate) fn start_app(launcher: &dyn AppLauncher, enabled: bool, tried: &AtomicBool, wait: Duration) -> StartOutcome {
    if !enabled {
        return StartOutcome::Disabled;
    }
    if tried.swap(true, Ordering::AcqRel) {
        return StartOutcome::AlreadyTried;
    }
    let Some(exe) = launcher.app_exe() else { return StartOutcome::NotInstalled };
    if let Err(why) = launcher.spawn(&exe) {
        return StartOutcome::SpawnFailed(why);
    }
    let checks = (wait.as_millis() / START_POLL.as_millis().max(1)).max(1);
    for _ in 0..checks {
        launcher.pause(START_POLL);
        if launcher.bridge_answers() {
            return StartOutcome::Started;
        }
    }
    StartOutcome::NoAnswer
}

/// Whether the automatic start is allowed (the environment variable is the setting).
pub(crate) fn enabled_by(env_value: Option<&str>) -> bool {
    !env_value.is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

static TRIED: AtomicBool = AtomicBool::new(false);

/// The real thing, once per session. Returns how it went.
pub(crate) fn start_app_once() -> StartOutcome {
    let enabled = enabled_by(env::var(NO_AUTOSTART_ENV).ok().as_deref());
    report_progress("Starting Potato Workspace\u{2026}");
    start_app(&RealLauncher, enabled, &TRIED, START_WAIT)
}

struct RealLauncher;

impl AppLauncher for RealLauncher {
    fn app_exe(&self) -> Option<PathBuf> {
        // A test must never find (and so never start) a real app.
        if cfg!(test) {
            return None;
        }
        find_app_exe(&bridge_port_candidates(), env::var_os(APP_EXE_ENV).map(PathBuf::from), per_user_install_path())
    }

    fn spawn(&self, exe: &Path) -> Result<(), String> {
        let mut command = std::process::Command::new(exe);
        // Tray only: no window opens, so nothing takes the focus.
        command.arg("--background").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: the app outlives this shim and shares no console with it.
            command.creation_flags(0x0000_0008 | 0x0000_0200);
        }
        command.spawn().map(|_| ()).map_err(|err| err.to_string())
    }

    fn bridge_answers(&self) -> bool {
        read_bridge_endpoint().is_ok_and(|endpoint| accepts_connection(&endpoint.host, endpoint.port))
    }

    fn pause(&self, how_long: Duration) {
        std::thread::sleep(how_long);
    }
}

/// The app to start: the override, else the path the app wrote beside its port file, else the per-user install folder.
/// Only a file that exists counts.
pub(crate) fn find_app_exe(port_files: &[PathBuf], override_path: Option<PathBuf>, install_path: Option<PathBuf>) -> Option<PathBuf> {
    let written = port_files.iter().find_map(|port_file| {
        let raw = fs::read_to_string(port_file.with_file_name(APP_EXE_FILE_NAME)).ok()?;
        Some(PathBuf::from(raw.trim())).filter(|path| !path.as_os_str().is_empty())
    });
    [override_path, written, install_path].into_iter().flatten().find(|path| path.is_file())
}

/// Where the per-user installer puts the app on Windows (`%LOCALAPPDATA%\Programs\<name>`), when that is known.
fn per_user_install_path() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(base.join("Programs").join("Potato Workspace").join("Potato Workspace.exe"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        exe: Option<PathBuf>,
        spawn_error: Option<String>,
        /// The bridge answers on this check (1-based); 0 = never.
        answers_on_check: u32,
        spawned: RefCell<Vec<PathBuf>>,
        checks: Cell<u32>,
        pauses: Cell<u32>,
    }

    impl Fake {
        fn new(answers_on_check: u32) -> Self {
            Fake { exe: Some(PathBuf::from("C:/fake/app.exe")), spawn_error: None, answers_on_check, spawned: RefCell::new(Vec::new()), checks: Cell::new(0), pauses: Cell::new(0) }
        }
    }

    impl AppLauncher for Fake {
        fn app_exe(&self) -> Option<PathBuf> {
            self.exe.clone()
        }
        fn spawn(&self, exe: &Path) -> Result<(), String> {
            self.spawned.borrow_mut().push(exe.to_path_buf());
            self.spawn_error.clone().map_or(Ok(()), Err)
        }
        fn bridge_answers(&self) -> bool {
            self.checks.set(self.checks.get() + 1);
            self.answers_on_check != 0 && self.checks.get() >= self.answers_on_check
        }
        fn pause(&self, _how_long: Duration) {
            self.pauses.set(self.pauses.get() + 1);
        }
    }

    #[test]
    fn it_starts_the_app_and_reports_when_the_bridge_answers() {
        let fake = Fake::new(3);
        let tried = AtomicBool::new(false);
        assert_eq!(start_app(&fake, true, &tried, START_WAIT), StartOutcome::Started);
        assert_eq!(fake.spawned.borrow().len(), 1);
        assert_eq!(fake.checks.get(), 3, "it stopped checking as soon as the bridge answered");
    }

    #[test]
    fn the_setting_turns_it_off_and_nothing_is_started() {
        let fake = Fake::new(1);
        assert_eq!(start_app(&fake, false, &AtomicBool::new(false), START_WAIT), StartOutcome::Disabled);
        assert!(fake.spawned.borrow().is_empty());
        assert!(!enabled_by(Some("1")) && !enabled_by(Some("TRUE")) && enabled_by(None) && enabled_by(Some("0")));
    }

    #[test]
    fn it_tries_once_per_session() {
        let fake = Fake::new(0);
        let tried = AtomicBool::new(false);
        assert_eq!(start_app(&fake, true, &tried, Duration::from_secs(2)), StartOutcome::NoAnswer);
        assert_eq!(start_app(&fake, true, &tried, Duration::from_secs(2)), StartOutcome::AlreadyTried);
        assert_eq!(fake.spawned.borrow().len(), 1, "the second call started nothing");
    }

    #[test]
    fn no_installed_app_or_a_failed_start_ends_without_waiting() {
        let mut fake = Fake::new(1);
        fake.exe = None;
        assert_eq!(start_app(&fake, true, &AtomicBool::new(false), START_WAIT), StartOutcome::NotInstalled);
        let mut fake = Fake::new(1);
        fake.spawn_error = Some("denied".into());
        assert_eq!(start_app(&fake, true, &AtomicBool::new(false), START_WAIT), StartOutcome::SpawnFailed("denied".into()));
        assert_eq!(fake.pauses.get(), 0);
    }

    #[test]
    fn the_wait_is_about_thirty_seconds() {
        let fake = Fake::new(0);
        assert_eq!(start_app(&fake, true, &AtomicBool::new(false), START_WAIT), StartOutcome::NoAnswer);
        assert_eq!(fake.pauses.get() as u128 * START_POLL.as_millis(), START_WAIT.as_millis());
    }

    #[test]
    fn the_app_is_found_from_the_file_it_writes_beside_the_port_file() {
        let dir = std::env::temp_dir().join(format!("pw-app-start-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("app.exe");
        fs::write(&exe, b"x").unwrap();
        let port_file = dir.join(DEFAULT_BRIDGE_PORT_FILE);
        fs::write(dir.join(APP_EXE_FILE_NAME), format!("{}\n", exe.display())).unwrap();
        assert_eq!(find_app_exe(&[port_file.clone()], None, None), Some(exe.clone()));
        // The override wins; a path that is not a file is skipped.
        let other = dir.join("other.exe");
        fs::write(&other, b"x").unwrap();
        assert_eq!(find_app_exe(&[port_file.clone()], Some(other.clone()), None), Some(other));
        assert_eq!(find_app_exe(&[port_file.clone()], Some(dir.join("missing.exe")), None), Some(exe));
        fs::remove_file(dir.join(APP_EXE_FILE_NAME)).unwrap();
        assert_eq!(find_app_exe(&[port_file], None, Some(dir.join("nope.exe"))), None);
        let _ = fs::remove_dir_all(&dir);
    }

    fn connect_failure() -> Result<String, String> {
        Err(format!("{BRIDGE_DOWN}: no port file"))
    }

    #[test]
    fn a_call_that_finds_the_app_down_starts_it_and_is_made_once_more_with_a_note() {
        let calls = Cell::new(0);
        let result = with_restart_retry_using(&|| StartOutcome::Started, false, false, || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 { connect_failure() } else { Ok(r#"{"agents":[]}"#.to_string()) }
        })
        .unwrap();
        assert_eq!(calls.get(), 2, "retried exactly once");
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), json!({"agents": [], "app_started": true}));
    }

    #[test]
    fn a_start_that_does_not_work_ends_in_the_old_error_with_the_reason_and_no_second_call() {
        for outcome in [StartOutcome::NotInstalled, StartOutcome::Disabled, StartOutcome::NoAnswer] {
            let calls = Cell::new(0);
            let error = with_restart_retry_using(&|| outcome.clone(), false, false, || {
                calls.set(calls.get() + 1);
                connect_failure()
            })
            .unwrap_err();
            assert_eq!(calls.get(), 1, "{outcome:?}");
            let detail = tool_error_detail(&error);
            assert_eq!(detail["code"], "BRIDGE_UNAVAILABLE");
            assert_eq!(detail["fix"], "Start Potato Workspace, then retry.");
            assert!(detail["message"].as_str().unwrap().contains(&outcome.note()), "{detail}");
        }
    }

    #[test]
    fn a_started_app_that_still_refuses_the_call_is_unavailable_not_looping() {
        let calls = Cell::new(0);
        let error = with_restart_retry_using(&|| StartOutcome::Started, false, true, || {
            calls.set(calls.get() + 1);
            connect_failure()
        })
        .unwrap_err();
        assert_eq!(calls.get(), 2);
        assert_eq!(tool_error_detail(&error)["code"], "BRIDGE_UNAVAILABLE");
    }

    #[test]
    fn the_real_launcher_finds_no_app_under_test() {
        assert_eq!(RealLauncher.app_exe(), None);
    }
}
