//! Interactive shell PATH for GUI-launched apps.
//!
//! macOS `.app` / DMG launches inherit a minimal PATH that omits Homebrew,
//! npm globals, nvm, cargo, etc. Dev (`npm run tauri -- dev`) works because the
//! process is started from a terminal with a full PATH. We mirror the login
//! shell PATH so CLI presets (`codex`, `claude`, `opencode`, …) resolve the
//! same way as in Terminal.

use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The start-up PATH without the bundled tools: login shell (or Windows registry / fallback) plus
/// the dev-only e2e folders. Read once; [`path_for_spawn`] adds the live registry folders on top.
static STARTUP_BASE: Lazy<String> = Lazy::new(discover_startup_path);

/// How long a Windows spawn PATH is reused before the registry is read again.
#[cfg(windows)]
const SPAWN_PATH_TTL: std::time::Duration = std::time::Duration::from_secs(3);

/// PATH string to pass to spawned children. Fresh on every call: on Windows the registry is read
/// again (at most every 3 seconds), so a CLI installed while the app runs is found by new panes.
pub fn path_for_spawn() -> String {
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    #[cfg(windows)]
    {
        static CACHE: std::sync::Mutex<Option<(std::time::Instant, String)>> =
            std::sync::Mutex::new(None);
        let mut cache = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, path)) = cache.as_ref() {
            if at.elapsed() < SPAWN_PATH_TTL {
                return path.clone();
            }
        }
        let registry = crate::agent_install::path_refresh::registry_folders();
        let refs: Vec<&str> = registry.iter().map(String::as_str).collect();
        let path = compose_spawn_path(&STARTUP_BASE, &refs, exe_dir.as_deref());
        *cache = Some((std::time::Instant::now(), path.clone()));
        path
    }
    #[cfg(not(windows))]
    {
        compose_spawn_path(&STARTUP_BASE, &[], exe_dir.as_deref())
    }
}

/// Builds the PATH a spawned child gets: `base`, then the `registry` folders it lacks (in the order
/// given), then the bundled tools in `exe_dir` LAST, so a tool the person installed always wins.
/// Duplicates are dropped, ignoring case and a trailing slash on Windows. A `%VAR%` entry from the
/// registry is skipped; it is not a folder. Pure: nothing is read from the system.
pub(crate) fn compose_spawn_path(base: &str, registry: &[&str], exe_dir: Option<&Path>) -> String {
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';

    let bundled: Vec<String> = exe_dir
        .map(bundled_tool_dirs)
        .unwrap_or_default()
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    let bundled_keys: HashSet<String> = bundled.iter().map(|dir| path_key(dir)).collect();

    // Bundled folders are taken out of the base so they always end up last.
    let base_kept: Vec<&str> = base
        .split(sep)
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && !bundled_keys.contains(&path_key(entry)))
        .collect();
    let base_kept = base_kept.join(&sep.to_string());
    let joined = if registry.is_empty() {
        base_kept
    } else {
        crate::agent_install::path_refresh::merge_path(&base_kept, registry).0
    };

    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for entry in joined.split(sep).map(str::trim).filter(|entry| !entry.is_empty()) {
        if seen.insert(path_key(entry)) {
            out.push(entry.to_string());
        }
    }
    for dir in bundled {
        if seen.insert(path_key(&dir)) {
            out.push(dir);
        }
    }
    out.join(&sep.to_string())
}

/// Identity of a PATH folder for duplicate checks.
fn path_key(entry: &str) -> String {
    #[cfg(windows)]
    {
        entry.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        entry.trim().to_string()
    }
}

/// Apply the interactive PATH to the current process (bridge, MCP helpers, etc.).
pub fn apply_to_process() {
    let path = path_for_spawn();
    std::env::set_var("PATH", &path);
    #[cfg(windows)]
    std::env::set_var("Path", &path);
    scrub_host_session_env();
}

/// Variables a launching Claude session exports to its children. A pane or headless `claude`
/// that inherits them believes it is a nested child session: it turns transcript saving off, shows
/// a warning row instead of its input hint and repaints the prompt box, which breaks screen-based
/// prompt delivery and completion capture. Auth and config variables are deliberately not listed.
const HOST_SESSION_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_PID",
];

/// Remove [`HOST_SESSION_ENV`] from this process so every child (panes, headless runs, opencode
/// serve) starts as a top-level session no matter what launched the app.
pub fn scrub_host_session_env() {
    for name in HOST_SESSION_ENV {
        std::env::remove_var(name);
    }
}

#[cfg(test)]
mod scrub_tests {
    use super::*;

    #[test]
    fn host_session_markers_are_removed_and_auth_is_kept() {
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
        std::env::set_var("CLAUDECODE", "1");
        std::env::set_var("CLAUDE_CODE_OAUTH_TOKEN", "keep-me");
        scrub_host_session_env();
        assert!(std::env::var("CLAUDE_CODE_CHILD_SESSION").is_err());
        assert!(std::env::var("CLAUDECODE").is_err());
        assert_eq!(std::env::var("CLAUDE_CODE_OAUTH_TOKEN").as_deref(), Ok("keep-me"));
        std::env::remove_var("CLAUDE_CODE_OAUTH_TOKEN");
    }
}

/// Resolve the OpenCode binary for `std::process::Command` / PTY spawn.
///
/// `opencode` is looked up on the PATH Potato Workspace gives its panes, the way a command prompt
/// does: the machine's `PATHEXT`, then the npm shim kinds. Windows cannot start a `.cmd` / `.ps1`
/// shim directly, so a shim is followed to the native `.exe` it names. No install folder is
/// assumed, so custom npm prefixes, pnpm, bun, Volta, Scoop and winget all resolve.
pub fn resolve_opencode_executable() -> Result<String, String> {
    resolve_opencode_in(&path_for_spawn())
}

/// [`resolve_opencode_executable`] with the `PATH` string passed in, so a test can point it at a
/// temp dir.
fn resolve_opencode_in(path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let found = crate::tui::find_program_in(
            std::ffi::OsStr::new(path),
            &crate::tui::runnable_extensions(),
            "opencode",
        );
        let Some(found) = found else {
            return Err(
                "opencode was not found on PATH (install: npm i -g opencode-ai, or add the folder it was installed in to PATH)"
                    .into(),
            );
        };
        if is_native(&found) {
            return Ok(found.to_string_lossy().into_owned());
        }
        if let Some(native) = native_exe_from_shim(&found) {
            return Ok(native.to_string_lossy().into_owned());
        }
        Err(format!(
            "found {} but the opencode.exe it launches was not found (install: npm i -g opencode-ai)",
            found.display()
        ))
    }
    #[cfg(not(windows))]
    {
        if which_on_path("opencode", path).is_some() {
            return Ok("opencode".into());
        }
        Err("opencode not found on PATH (install: npm i -g opencode-ai)".into())
    }
}

#[cfg(windows)]
fn is_native(path: &std::path::Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("exe" | "com")
    )
}

/// The native program a `.cmd` / `.bat` / `.ps1` shim runs, read from the shim itself. Handles the
/// npm / pnpm / cmd-shim templates (`%dp0%`, `%~dp0`, `$basedir`, `$PSScriptRoot`) and absolute
/// targets, so a store path or a custom global prefix works as well as the default one.
#[cfg(windows)]
fn native_exe_from_shim(shim: &std::path::Path) -> Option<PathBuf> {
    let dir = shim.parent()?;
    let text = std::fs::read_to_string(shim).ok()?;
    let mut fallback = None;
    for raw in exe_references(&text) {
        let candidate = expand_shim_reference(raw, dir);
        if !is_native(&candidate) || !candidate.is_file() {
            continue;
        }
        let Some(name) = candidate.file_name() else { continue };
        let name = name.to_string_lossy().to_ascii_lowercase();
        if name.starts_with("opencode") {
            return Some(candidate);
        }
        if name != "node.exe" && fallback.is_none() {
            fallback = Some(candidate);
        }
    }
    fallback
}

/// Every command-line token in a shim that names an `.exe`, quoted or bare.
#[cfg(windows)]
fn exe_references(text: &str) -> Vec<&str> {
    let mut refs = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('"') else { break };
        if has_exe(&rest[..end]) {
            refs.push(&rest[..end]);
        }
        rest = &rest[end + 1..];
    }
    for token in text.split(|c: char| {
        c.is_whitespace() || matches!(c, '(' | ')' | '\'' | '`' | ';' | '=' | '&' | '|')
    }) {
        if has_exe(token) {
            refs.push(token);
        }
    }
    refs
}

#[cfg(windows)]
fn has_exe(text: &str) -> bool {
    text.to_ascii_lowercase().contains(".exe")
}

#[cfg(windows)]
fn expand_shim_reference(raw: &str, dir: &std::path::Path) -> PathBuf {
    let raw = raw.trim().trim_matches(['"', '\'']);
    let lower = raw.to_ascii_lowercase();
    for prefix in ["%~dp0", "%dp0%", "$psscriptroot", "${basedir}", "$basedir"] {
        if lower.starts_with(prefix) {
            let rest = &raw[prefix.len()..];
            return dir.join(rest.trim_start_matches(['\\', '/']));
        }
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() { path } else { dir.join(path) }
}

#[cfg(not(windows))]
fn which_on_path(name: &str, path: &str) -> Option<String> {
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';

    for dir in path.split(sep) {
        let candidate = PathBuf::from(dir.trim()).join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn discover_startup_path() -> String {
    let path = match read_login_shell_path() {
        Some(path) if !path.is_empty() => dedupe_path(&path),
        _ => dedupe_path(&registry_or_fallback_path()),
    };
    prepend_e2e_dirs(path)
}

/// Windows: the registry PATH when PowerShell could not be read. Other systems: the fallback list.
#[cfg(windows)]
fn registry_or_fallback_path() -> String {
    tracing::warn!("reading the user and machine PATH with PowerShell failed; using the registry");
    let folders = crate::agent_install::path_refresh::registry_folders();
    if folders.is_empty() {
        build_fallback_path()
    } else {
        folders.join(";")
    }
}

#[cfg(not(windows))]
fn registry_or_fallback_path() -> String {
    build_fallback_path()
}

/// The tools the installer puts next to the app: Node.js with npm (`resources/node`) and MinGit
/// (`resources/git/cmd`). Only the folders that exist, in that order.
pub(crate) fn bundled_tool_dirs(exe_dir: &std::path::Path) -> Vec<PathBuf> {
    let resources = bundled_resources_root(exe_dir);
    [["node"].as_slice(), ["git", "cmd"].as_slice()]
        .iter()
        .map(|parts| parts.iter().fold(resources.clone(), |dir, part| dir.join(part)))
        .filter(|dir| dir.is_dir())
        .collect()
}

/// Where the bundle resources live. Beside the executable on Windows, but inside
/// `<App>.app/Contents/Resources` on macOS (the executable is in `Contents/MacOS`).
pub(crate) fn bundled_resources_root(exe_dir: &std::path::Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(contents) = exe_dir.parent() {
            let resources = contents.join("Resources");
            if resources.is_dir() {
                return resources;
            }
        }
    }
    exe_dir.join("resources")
}

/// Dev only (`dev-fake-tui`): the end-to-end runner (`packages/e2e`) puts folders holding fake agent programs
/// first on PATH with `PM_E2E_PATH_PREPEND` (folders joined by the platform's PATH separator). On Windows the
/// PATH is rebuilt from the registry, so the environment alone cannot add a folder. Not compiled into a
/// release or normal build.
#[cfg(feature = "dev-fake-tui")]
fn prepend_e2e_dirs(path: String) -> String {
    match std::env::var("PM_E2E_PATH_PREPEND") {
        Ok(extra) if !extra.trim().is_empty() => {
            let sep = if cfg!(windows) { ';' } else { ':' };
            dedupe_path(&format!("{}{sep}{path}", extra.trim()))
        }
        _ => path,
    }
}

#[cfg(not(feature = "dev-fake-tui"))]
fn prepend_e2e_dirs(path: String) -> String {
    path
}

#[cfg(unix)]
fn read_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = crate::proc_util::hidden_command(&shell)
        .args(["-l", "-c", "echo -n \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(unix))]
fn read_login_shell_path() -> Option<String> {
    read_windows_path()
}

#[cfg(windows)]
fn read_windows_path() -> Option<String> {
    let output = crate::proc_util::hidden_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$u=[Environment]::GetEnvironmentVariable('Path','User');$m=[Environment]::GetEnvironmentVariable('Path','Machine');if($u-and$m){\"$u;$m\"}elseif($u){$u}else{$m}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(all(not(unix), not(windows)))]
fn read_windows_path() -> Option<String> {
    None
}

fn build_fallback_path() -> String {
    let mut segments: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        segments.push("/opt/homebrew/bin".into());
        segments.push("/opt/homebrew/sbin".into());
    }

    segments.push("/usr/local/bin".into());
    segments.push("/usr/bin".into());
    segments.push("/bin".into());
    segments.push("/usr/sbin".into());
    segments.push("/sbin".into());

    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = PathBuf::from(home);
        #[cfg(windows)]
        {
            if let Ok(pf) = std::env::var("ProgramFiles") {
                segments.push(format!(r"{pf}\nodejs"));
            }
            if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
                segments.push(format!(r"{pf86}\nodejs"));
            }
            segments.push(
                home.join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .to_string_lossy()
                    .into_owned(),
            );
            segments.push(
                home.join("AppData")
                    .join("Local")
                    .join("fnm")
                    .to_string_lossy()
                    .into_owned(),
            );
            segments.push(
                home.join(".cargo")
                    .join("bin")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        #[cfg(not(windows))]
        {
            for sub in [
                ".local/bin",
                ".cargo/bin",
                ".npm-global/bin",
                "bin",
                ".volta/bin",
                ".fnm/current/bin",
            ] {
                segments.push(home.join(sub).to_string_lossy().into_owned());
            }
        }
    }

    if let Ok(existing) = std::env::var("PATH").or_else(|_| std::env::var("Path")) {
        segments.push(existing);
    }

    path_separator_join(&segments)
}

fn path_separator_join(segments: &[String]) -> String {
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';
    segments.join(&sep.to_string())
}

fn dedupe_path(path: &str) -> String {
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for part in path.split(sep) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if seen.insert(part.to_string()) {
            out.push(part);
        }
    }
    out.join(&sep.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_keeps_first_occurrence() {
        let duplicate = path_separator_join(&[
            "/opt/homebrew/bin".to_string(),
            "/usr/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
        ]);
        let expected =
            path_separator_join(&["/opt/homebrew/bin".to_string(), "/usr/bin".to_string()]);
        assert_eq!(dedupe_path(&duplicate), expected);
    }

    #[test]
    fn fallback_includes_homebrew_on_macos() {
        let path = build_fallback_path();
        #[cfg(target_os = "macos")]
        assert!(path.contains("/opt/homebrew/bin"));
        assert!(path.contains("/usr/local/bin"));
    }

    #[test]
    fn bundled_tools_are_appended_last_and_only_when_present() {
        let exe_dir = std::env::temp_dir().join(format!("pm-bundled-tools-{}", uuid::Uuid::new_v4()));
        let node_dir = exe_dir.join("resources").join("node");
        std::fs::create_dir_all(&node_dir).unwrap();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let user = "/opt/user-tools";
        let node = node_dir.to_string_lossy().into_owned();

        // No git folder: only node is added, after the person's own PATH.
        assert_eq!(compose_spawn_path(user, &[], Some(&exe_dir)), format!("{user}{sep}{node}"));

        // With git too, and a bundled folder already listed in the base still ends up last.
        let git_cmd = exe_dir.join("resources").join("git").join("cmd");
        std::fs::create_dir_all(&git_cmd).unwrap();
        let git = git_cmd.to_string_lossy().into_owned();
        assert_eq!(
            compose_spawn_path(&format!("{node}{sep}{user}"), &[], Some(&exe_dir)),
            format!("{user}{sep}{node}{sep}{git}")
        );

        let _ = std::fs::remove_dir_all(exe_dir);
    }

    #[cfg(windows)]
    #[test]
    fn compose_adds_a_new_registry_folder_and_keeps_the_base_order() {
        let out = compose_spawn_path(r"C:\Windows;C:\Tools", &[r"C:\Windows;C:\Users\a\.local\bin"], None);
        assert_eq!(out, r"C:\Windows;C:\Tools;C:\Users\a\.local\bin");
    }

    #[cfg(windows)]
    #[test]
    fn compose_drops_duplicates_ignoring_case_and_trailing_slash() {
        let out = compose_spawn_path(r"C:\A\;c:\a;C:\B", &[r"C:\b\", r"C:\C"], None);
        assert_eq!(out, r"C:\A\;C:\B;C:\C");
    }

    #[cfg(windows)]
    #[test]
    fn compose_keeps_bundled_folders_last_even_when_registry_repeats_them() {
        let exe_dir = std::env::temp_dir().join(format!("pm-compose-{}", uuid::Uuid::new_v4()));
        let node = exe_dir.join("resources").join("node");
        std::fs::create_dir_all(&node).unwrap();
        let node_s = node.to_string_lossy().into_owned();
        let out = compose_spawn_path(&format!(r"{};C:\A", node_s.to_uppercase()), &[r"C:\New;C:\A"], Some(&exe_dir));
        assert_eq!(out, format!(r"C:\A;C:\New;{node_s}"));
        let _ = std::fs::remove_dir_all(exe_dir);
    }

    #[cfg(windows)]
    #[test]
    fn compose_skips_unexpanded_variables_from_the_registry() {
        let out = compose_spawn_path(r"C:\A", &[r"%NOPE%\bin;C:\New"], None);
        assert_eq!(out, r"C:\A;C:\New");
    }

    #[test]
    fn compose_with_no_registry_and_no_bundled_tools_is_the_base() {
        let base = if cfg!(windows) { r"C:\A;C:\B" } else { "/a:/b" };
        assert_eq!(compose_spawn_path(base, &[], None), base);
    }

    /// A throw-away directory that stands in for a PATH entry or an install folder.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-opencode-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn opencode_is_found_on_path_and_a_missing_one_names_the_fix() {
        let on_path = temp_dir("path");
        let empty = temp_dir("empty");
        let path = on_path.to_string_lossy().into_owned();

        // Nothing installed anywhere: a clear error that names the fix.
        let missing = resolve_opencode_in(&empty.to_string_lossy());
        assert!(missing.unwrap_err().contains("npm i -g opencode-ai"));

        // On PATH.
        let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
        std::fs::write(on_path.join(exe), "stub").unwrap();
        let found = resolve_opencode_in(&path).unwrap();
        #[cfg(windows)]
        assert!(found.ends_with("opencode.exe"), "expected opencode.exe, got {found:?}");
        #[cfg(not(windows))]
        assert_eq!(found, "opencode");

        let _ = (std::fs::remove_dir_all(on_path), std::fs::remove_dir_all(empty));
    }

    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_is_followed_to_its_native_exe_wherever_it_lives() {
        let shim_dir = temp_dir("shim");
        let bin = shim_dir.join("node_modules").join("opencode-ai").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("opencode.exe"), "stub").unwrap();
        std::fs::write(
            shim_dir.join("opencode.cmd"),
            "@ECHO off\r\nSET dp0=%~dp0\r\n\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\" %*\r\n",
        )
        .unwrap();

        let found = resolve_opencode_in(&shim_dir.to_string_lossy()).unwrap();
        assert_eq!(PathBuf::from(found), bin.join("opencode.exe"));

        let _ = std::fs::remove_dir_all(shim_dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_shim_pointing_at_an_absolute_exe_elsewhere_resolves() {
        let install = temp_dir("elsewhere").join("with space");
        let exe = install.join("opencode.exe");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(&exe, "stub").unwrap();

        let shim_dir = temp_dir("abs-shim");
        std::fs::write(shim_dir.join("opencode.bat"), format!("\"{}\" %*\r\n", exe.display())).unwrap();

        let found = resolve_opencode_in(&shim_dir.to_string_lossy()).unwrap();
        assert_eq!(PathBuf::from(found), exe);

        let _ = (std::fs::remove_dir_all(install), std::fs::remove_dir_all(shim_dir));
    }

    #[cfg(windows)]
    #[test]
    fn a_ps1_shim_using_basedir_is_followed_too() {
        let shim_dir = temp_dir("ps1-shim");
        let bin = shim_dir.join("node_modules").join("opencode-ai").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("opencode.exe"), "stub").unwrap();
        std::fs::write(
            shim_dir.join("opencode.ps1"),
            "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& \"$basedir\\node_modules\\opencode-ai\\bin\\opencode.exe\" $args\n",
        )
        .unwrap();

        let found = resolve_opencode_in(&shim_dir.to_string_lossy()).unwrap();
        assert_eq!(PathBuf::from(found), bin.join("opencode.exe"));

        let _ = std::fs::remove_dir_all(shim_dir);
    }
}
