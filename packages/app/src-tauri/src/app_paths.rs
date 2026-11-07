//! Stable application data paths (DMG-safe — not tied to process cwd).

use std::fs;
use std::path::{Path, PathBuf};

const APP_ID: &str = "com.potatodev.workspace";
/// Run a second, separate Potato Workspace on the same computer: `POTATO_WORKSPACE_PROFILE=<name>`.
/// Unset, empty or `default` is today's app, unchanged (same paths, ports and app id).
/// The other product's environment variables (the ones with its own `..._PROFILE` / `..._BRIDGE_...` names) are
/// never read: they belong to the other app, so a Puppet Master set-up can never steer this one.
pub const PROFILE_ENV: &str = "POTATO_WORKSPACE_PROFILE";
pub const BRIDGE_PORT_FILE_NAME: &str = "potato-workspace.bridge.port";
pub const PAIRING_FILE_NAME: &str = "potato-workspace.pairing.json";
pub const BRIDGE_PORT_FILE_ENV: &str = "POTATO_WORKSPACE_BRIDGE_PORT_FILE";
/// Per-project storage folder (`<project>/.potato-workspace`).
pub const PROJECT_DIR_NAME: &str = ".potato-workspace";
/// Per-user storage folder (`~/.potato-workspace`).
pub const HOME_DIR_NAME: &str = ".potato-workspace";
/// The companion root folder (`~/PotatoWorkspace/companions`).
pub const COMPANION_HOME_DIR_NAME: &str = "PotatoWorkspace";
/// The names release 1.0.3 (and the Puppet Master it was forked from) used. They are only read, to
/// copy old data once, and never written.
pub const LEGACY_PROJECT_DIR_NAME: &str = ".puppet-master";
pub const LEGACY_HOME_DIR_NAME: &str = ".puppet-master";
pub const LEGACY_COMPANION_HOME_DIR_NAME: &str = "PuppetMaster";
/// Files inside the app data folder (`com.potatodev.workspace`, unchanged between 1.0.3 and now) whose
/// names changed. Their contents are copied under the new names. The bridge port file and the bridge
/// secret are not: both are rewritten on every start, and a copied port would point at the old range.
pub const LEGACY_PAIRING_FILE_NAME: &str = "puppet-master.pairing.json";
pub const LEGACY_TUNNEL_FILE_NAME: &str = "puppet-master.tunnel.json";
pub const LEGACY_PUSH_FILE_NAME: &str = "puppet-master.push.json";
pub const LEGACY_PUSH_VAPID_FILE_NAME: &str = "puppet-master.push-vapid.json";
/// Dropped into a folder once the old data has been brought over. While it exists, nothing is ever
/// copied into that folder again, so data the person later deletes or changes here stays that way.
pub const IMPORT_MARKER_NAME: &str = ".imported-from-previous-version";

/// A non-default profile name: `[a-z0-9-]`, 1..=32 chars, lowercased. Anything else (unset, empty,
/// `default`, or a name with other characters) means the default profile, so a typo never lands a
/// second app in a surprising folder.
pub fn profile_from(raw: Option<&str>) -> Option<String> {
    let name = raw?.trim().to_ascii_lowercase();
    let valid = !name.is_empty()
        && name.len() <= 32
        && name != "default"
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-');
    valid.then_some(name)
}

/// The profile this process runs as (`None` = the default profile).
pub fn profile() -> Option<String> {
    static PROFILE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PROFILE
        .get_or_init(|| profile_from(std::env::var(PROFILE_ENV).ok().as_deref()))
        .clone()
}

/// The app id for a profile: today's id for the default profile, `<id>.profile-<name>` otherwise.
/// It names the app data folder, Tauri's own data (settings store, webview data), and the
/// single-instance lock, so each profile is one separate app.
pub fn app_id_for(profile: Option<&str>) -> String {
    match profile {
        None => APP_ID.to_string(),
        Some(name) => format!("{APP_ID}.profile-{name}"),
    }
}

pub fn app_id() -> String {
    app_id_for(profile().as_deref())
}

/// Bridge ports scanned for a free one. Potato Workspace owns 17421..=17499, away from
/// the other product's 17321..=17399 (and the MCP shim's no-port-file probe range), so a stray
/// shim or an inherited port file can never reach the wrong app. Other profiles use the top
/// of the range, away from the ports the shim probes when it has no port file (17421..=17430).
pub fn bridge_port_range_for(profile: Option<&str>) -> (u16, u16) {
    match profile {
        None => (17421, 17499),
        Some(_) => (17460, 17499),
    }
}

/// The phone (PWA) server port: the fixed 1423 for the default profile, a free one (0) otherwise.
/// The other product uses 1422, so both can run at once.
pub fn pwa_port_for(profile: Option<&str>) -> u16 {
    match profile {
        None => 1423,
        Some(_) => 0,
    }
}

/// Directory of app data for `profile`, rooted at the platform's usual folder.
pub fn app_data_dir_for(profile: Option<&str>) -> PathBuf {
    app_data_root().join(app_id_for(profile))
}

/// Dev-only (`dev-fake-tui`): the end-to-end harness roots app data in its own per-process folder, so
/// test processes running side by side never share an audit log, settings or agent definitions.
#[cfg(feature = "dev-fake-tui")]
static E2E_DATA_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Dev-only (`dev-fake-tui`): root app data at `root`. Must run before anything reads a path; a
/// second call is ignored.
#[cfg(feature = "dev-fake-tui")]
pub fn set_data_root_for_e2e(root: PathBuf) {
    let _ = E2E_DATA_ROOT.set(root);
}

fn app_data_root() -> PathBuf {
    #[cfg(feature = "dev-fake-tui")]
    if let Some(root) = E2E_DATA_ROOT.get() {
        return root.clone();
    }
    let home = crate::project_path::home_dir().unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        return home.join("Library").join("Application Support");
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or(home);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home.join(".local").join("share")
    }
}

pub fn app_data_dir() -> PathBuf {
    app_data_dir_for(profile().as_deref())
}

#[cfg(test)]
fn legacy_app_data_dir() -> PathBuf {
    let home = crate::project_path::home_dir().unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        return home
            .join("Library")
            .join("Application Support")
            .join(APP_ID);
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join(APP_ID);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home.join(".local").join("share").join(APP_ID)
    }
}

/// `<project>/.potato-workspace`: this app's per-project storage.
pub fn project_data_dir(project: impl AsRef<Path>) -> PathBuf {
    project.as_ref().join(PROJECT_DIR_NAME)
}

/// `~/.potato-workspace`: this app's per-user storage.
pub fn home_data_dir() -> PathBuf {
    crate::project_path::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(HOME_DIR_NAME)
}

/// `~/PotatoWorkspace/companions`: this app's companion folders.
pub fn companion_home_dir() -> PathBuf {
    crate::project_path::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(COMPANION_HOME_DIR_NAME)
        .join("companions")
}

/// How deep a copy goes. Real data is a few levels deep; this only stops a folder loop.
const MAX_COPY_DEPTH: usize = 24;

/// Bring the old folder `old` into `new`, once, without ever changing or deleting anything in `old`
/// and without ever overwriting a file that is already in `new`: only files `new` does not have are
/// copied, so data this app wrote into `new` since the update stays as it is. A failed copy leaves what
/// was copied in place, writes no marker and is tried again (it only fills in what is missing) at
/// the next start. Once the marker is in `new`, this does nothing.
pub fn copy_legacy_data_once(old: &Path, new: &Path) {
    import_tree_once(old, new, &[]);
}

fn import_tree_once(old: &Path, new: &Path, skip: &[&str]) {
    let marker = new.join(IMPORT_MARKER_NAME);
    if old == new || marker.exists() {
        return;
    }
    if !old.is_dir() {
        // Nothing to bring over. Once our own folder exists, close the door, so data another product
        // writes into the old folder later is never pulled in.
        if new.is_dir() {
            write_marker(&marker);
        }
        return;
    }
    if copy_tree_missing_excluding(old, new, skip, 0).is_ok() {
        write_marker(&marker);
    }
}

fn write_marker(marker: &Path) {
    let _ = fs::write(
        marker,
        "Data from the previous version of this app was copied here once. Nothing was moved or deleted there.\n",
    );
}

fn copy_tree_missing_excluding(from: &Path, to: &Path, skip: &[&str], depth: usize) -> std::io::Result<()> {
    if depth > MAX_COPY_DEPTH {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip.iter().any(|s| name.to_string_lossy().eq_ignore_ascii_case(s)) {
            continue;
        }
        let source = entry.path();
        let target = to.join(&name);
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_tree_missing_excluding(&source, &target, skip, depth + 1)?;
        } else if kind.is_file() && !target.exists() {
            copy_file_whole(&source, &target)?;
        }
    }
    Ok(())
}

/// Copy through a side file and rename, so a crash never leaves a half-written file that would later
/// count as "already there".
fn copy_file_whole(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut side = to.as_os_str().to_owned();
    side.push(".importing");
    let side = PathBuf::from(side);
    fs::copy(from, &side)?;
    if let Err(err) = fs::rename(&side, to) {
        let _ = fs::remove_file(&side);
        return Err(err);
    }
    Ok(())
}

/// Copy the old project folder into this app's own folder, once.
/// Worktrees are deliberately NOT copied: a copied git worktree is a broken worktree, and
/// existing runs keep working in the old folder until they finish. New runs create theirs
/// under the new folder.
pub fn migrate_legacy_project_data(project: &Path) {
    import_tree_once(&project.join(LEGACY_PROJECT_DIR_NAME), &project.join(PROJECT_DIR_NAME), &["worktrees"]);
}

/// Copy the old home folder and the old companion folder into this app's own folders, once.
pub fn migrate_legacy_home_data() {
    let Some(home) = crate::project_path::home_dir() else { return };
    migrate_legacy_home_data_in(&home);
}

pub(crate) fn migrate_legacy_home_data_in(home: &Path) {
    copy_legacy_data_once(&home.join(LEGACY_HOME_DIR_NAME), &home.join(HOME_DIR_NAME));
    copy_legacy_data_once(
        &home.join(LEGACY_COMPANION_HOME_DIR_NAME).join("companions"),
        &home.join(COMPANION_HOME_DIR_NAME).join("companions"),
    );
}

/// The files inside the app data folder whose names changed: (old name, new name).
fn renamed_app_data_files() -> [(&'static str, &'static str); 4] {
    [
        (LEGACY_PAIRING_FILE_NAME, PAIRING_FILE_NAME),
        (LEGACY_TUNNEL_FILE_NAME, crate::tunnel_config::TUNNEL_FILE_NAME),
        (LEGACY_PUSH_FILE_NAME, crate::push::SUBSCRIPTIONS_FILE_NAME),
        (LEGACY_PUSH_VAPID_FILE_NAME, crate::push::VAPID_FILE_NAME),
    ]
}

/// Copy the paired phones, tunnel set-up and push subscriptions saved under the old file names into the
/// new file names, once, in this app's data folder (which kept its name). Never overwrites a new
/// file and never touches the old one.
pub fn migrate_legacy_app_data() {
    import_files_once(&app_data_dir(), &renamed_app_data_files());
}

fn import_files_once(dir: &Path, renamed: &[(&str, &str)]) {
    let marker = dir.join(IMPORT_MARKER_NAME);
    if !dir.is_dir() || marker.exists() {
        return;
    }
    let mut complete = true;
    for (old, new) in renamed {
        let (from, to) = (dir.join(old), dir.join(new));
        if from.is_file() && !to.exists() && copy_file_whole(&from, &to).is_err() {
            complete = false;
        }
    }
    if complete {
        write_marker(&marker);
    }
}

pub fn ensure_app_data_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("could not create {}: {err}", dir.display()))?;
    Ok(dir)
}

/// `<app data>/agents`: the `user` definition source (SRC-2).
#[allow(dead_code)] // the loader wiring (T18) reads it
pub fn agents_dir() -> PathBuf {
    app_data_dir().join("agents")
}

pub fn bridge_port_file() -> PathBuf {
    app_data_dir().join(BRIDGE_PORT_FILE_NAME)
}

pub fn pairing_file() -> PathBuf {
    app_data_dir().join(PAIRING_FILE_NAME)
}

pub fn bridge_port_file_env_value() -> String {
    path_for_host_config(bridge_port_file())
}

/// Host config files (Codex TOML, JSON) — forward slashes avoid TOML escape issues on Windows.
pub fn path_for_host_config(path: impl AsRef<std::path::Path>) -> String {
    let mut text = path.as_ref().to_string_lossy().into_owned();
    // canonicalize() on Windows yields \\?\ extended paths that break Node/CLI MCP launchers.
    const WIN_EXT_PREFIX: &str = r"\\?\";
    if text.starts_with(WIN_EXT_PREFIX) {
        text = text[WIN_EXT_PREFIX.len()..].to_string();
    }
    text.replace('\\', "/")
}

#[cfg(test)]
#[path = "app_paths_import_tests.rs"]
mod import_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_is_absolute_and_named() {
        let dir = app_data_dir();
        assert!(dir.is_absolute());
        assert!(dir.to_string_lossy().contains(APP_ID));
    }

    /// The default profile must be today's app exactly: same app id, same data folder (compared
    /// with a verbatim copy of the old implementation), same port file, same bridge ports, same
    /// phone port.
    #[test]
    fn default_profile_is_unchanged() {
        for raw in [None, Some(""), Some("  "), Some("default"), Some("DEFAULT"), Some("bad name"), Some("-x"), Some("a/b")] {
            assert_eq!(profile_from(raw), None, "{raw:?} must mean the default profile");
        }
        assert_eq!(app_id_for(None), "com.potatodev.workspace");
        assert_eq!(app_data_dir_for(None), legacy_app_data_dir());
        assert_eq!(
            app_data_dir_for(None).join(BRIDGE_PORT_FILE_NAME),
            legacy_app_data_dir().join("potato-workspace.bridge.port")
        );
        assert_eq!(bridge_port_range_for(None), (17421, 17499));
        assert_eq!(pwa_port_for(None), 1423);
        // The test process runs without POTATO_WORKSPACE_PROFILE (cargo test never sets it).
        if std::env::var_os(PROFILE_ENV).is_none() {
            assert_eq!(profile(), None);
            assert_eq!(app_id(), "com.potatodev.workspace");
            assert_eq!(app_data_dir(), legacy_app_data_dir());
            assert_eq!(bridge_port_file(), legacy_app_data_dir().join(BRIDGE_PORT_FILE_NAME));
        }
    }

    /// Potato Workspace owns 17421..=17499 and never the other product's 17321..=17399; every
    /// profile's slice stays inside it and clear of the shim's no-port-file probe ports.
    #[test]
    fn the_bridge_range_is_ours_and_never_the_other_products() {
        let (lo, hi) = bridge_port_range_for(None);
        assert_eq!((lo, hi), (17421, 17499));
        assert!(lo > 17399, "no overlap with 17321..=17399");
        for profile in [Some("a"), Some("e2e"), Some("leo-2")] {
            let (plo, phi) = bridge_port_range_for(profile);
            assert!(plo >= lo && phi <= hi && plo <= phi, "{profile:?}: {plo}-{phi}");
            assert!(plo > 17430, "{profile:?} stays out of the shim's probe ports");
        }
    }

    #[test]
    fn a_named_profile_is_a_separate_app() {
        assert_eq!(profile_from(Some(" Maya ")), Some("maya".into()));
        assert_eq!(profile_from(Some("leo-2")), Some("leo-2".into()));
        let maya = profile_from(Some("maya"));
        assert_eq!(app_id_for(maya.as_deref()), "com.potatodev.workspace.profile-maya");
        assert_ne!(app_data_dir_for(maya.as_deref()), app_data_dir_for(None));
        assert_ne!(app_data_dir_for(maya.as_deref()), app_data_dir_for(Some("leo")));
        assert_eq!(app_data_dir_for(maya.as_deref()).parent(), app_data_dir_for(None).parent());
        let (lo, hi) = bridge_port_range_for(maya.as_deref());
        assert!(lo > 17430 && hi <= 17499, "outside the MCP shim's fallback probe range");
        assert_eq!(pwa_port_for(maya.as_deref()), 0, "a free port, never the default app's 1423");
    }

    #[test]
    fn path_for_host_config_strips_windows_extended_prefix() {
        let path = path_for_host_config(r"\\?\C:\Users\dev\potato-workspace\mcp\index.js");
        assert_eq!(path, "C:/Users/dev/potato-workspace/mcp/index.js");
        assert!(!path.contains("?/"));
    }
}
