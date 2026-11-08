//! Resolve how CLI hosts should launch the Potato Workspace MCP stdio server.

use once_cell::sync::OnceCell;
use std::path::{Path, PathBuf};

static BUNDLED_MCP_SCRIPT: OnceCell<PathBuf> = OnceCell::new();
static BUNDLED_MCP_BINARY: OnceCell<PathBuf> = OnceCell::new();

pub fn set_bundled_mcp_script(path: PathBuf) {
    let _ = BUNDLED_MCP_SCRIPT.set(path);
}

pub fn bundled_mcp_script() -> Option<&'static Path> {
    BUNDLED_MCP_SCRIPT.get().map(|p| p.as_path())
}

pub fn set_bundled_mcp_binary(path: PathBuf) {
    let _ = BUNDLED_MCP_BINARY.set(path);
}

pub fn bundled_mcp_binary() -> Option<&'static Path> {
    BUNDLED_MCP_BINARY.get().map(|p| p.as_path())
}

/// The MCP binary's file name on this platform.
fn mcp_binary_name() -> &'static str {
    if cfg!(windows) {
        "puppet-master-mcp.exe"
    } else {
        "puppet-master-mcp"
    }
}

/// Where a dev build (no installed resource folder) may find the Rust MCP binary, best first: the
/// package's `dist` (where it is built), the staged `src-tauri/resources/bin`, `<exe dir>/bin` (what
/// Tauri's resource folder is in a dev run, e.g. `target/debug/bin`).
pub fn dev_mcp_binary_candidates(manifest_dir: &Path, exe_dir: Option<&Path>) -> Vec<PathBuf> {
    let name = mcp_binary_name();
    let mut list = vec![
        manifest_dir.join("../../mcp-server/dist").join(name),
        manifest_dir.join("resources/bin").join(name),
    ];
    if let Some(dir) = exe_dir {
        list.push(dir.join("bin").join(name));
    }
    list
}

/// The first of [`dev_mcp_binary_candidates`] that exists.
pub fn dev_mcp_binary(manifest_dir: &Path, exe_dir: Option<&Path>) -> Option<PathBuf> {
    dev_mcp_binary_candidates(manifest_dir, exe_dir).into_iter().find(|path| path.is_file())
}

pub fn using_bundled_mcp() -> bool {
    bundled_mcp_binary().is_some() || bundled_mcp_script().is_some()
}

/// Where an installed copy keeps a bundled file named `rel` (relative to the `resources/` folder of tauri.conf.json),
/// best first: `<resource dir>/rel`, `<resource dir>/resources/rel` (the installer keeps the folder name, so this is
/// where a Windows MSI or a Linux package has it), then the same two next to the running exe. The first that is a file.
pub fn installed_resource(resource_dir: Option<&Path>, exe_dir: Option<&Path>, rel: &str) -> Option<PathBuf> {
    resource_candidates(resource_dir, exe_dir, rel).into_iter().find(|path| path.is_file())
}

/// Like [`installed_resource`], for a bundled folder (`pwa-dist`): the first candidate that is a directory.
pub fn installed_resource_dir(resource_dir: Option<&Path>, exe_dir: Option<&Path>, rel: &str) -> Option<PathBuf> {
    resource_candidates(resource_dir, exe_dir, rel).into_iter().find(|path| path.is_dir())
}

fn resource_candidates(resource_dir: Option<&Path>, exe_dir: Option<&Path>, rel: &str) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for base in [resource_dir, exe_dir].into_iter().flatten() {
        for path in [base.join(rel), base.join("resources").join(rel)] {
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    candidates
}

pub struct McpLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
}

pub fn npm_mcp_launch_spec() -> McpLaunchSpec {
    McpLaunchSpec {
        command: "npx".into(),
        args: vec!["-y".into(), "@potato-workspace/mcp".into()],
    }
}

/// The launch spec of a bundled program (the Rust MCP exe, else the Node bundle), or None when this install has
/// neither. Unlike [`mcp_launch_spec`] it never falls back to the npm package, which is not published.
pub fn bundled_launch_spec() -> Option<McpLaunchSpec> {
    if let Some(binary) = bundled_mcp_binary() {
        return Some(McpLaunchSpec { command: crate::app_paths::path_for_host_config(binary), args: vec![] });
    }
    bundled_mcp_script().map(|script| McpLaunchSpec {
        command: resolve_node_executable(),
        args: vec![crate::app_paths::path_for_host_config(script)],
    })
}

/// Command + args written into Claude / Codex / OpenCode MCP config.
pub fn mcp_launch_spec() -> McpLaunchSpec {
    if let Some(binary) = bundled_mcp_binary() {
        return McpLaunchSpec {
            command: crate::app_paths::path_for_host_config(binary),
            args: vec![],
        };
    }
    if let Some(script) = bundled_mcp_script() {
        return McpLaunchSpec {
            command: resolve_node_executable(),
            args: vec![crate::app_paths::path_for_host_config(script)],
        };
    }
    npm_mcp_launch_spec()
}

fn resolve_node_executable() -> String {
    which_node_executable()
        .map(|path| crate::app_paths::path_for_host_config(Path::new(&path)))
        .unwrap_or_else(|| "node".into())
}

#[cfg(unix)]
fn which_node_executable() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = crate::proc_util::hidden_command(&shell)
        .args(["-l", "-c", "command -v node"])
        .env("PATH", crate::shell_env::path_for_spawn())
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

#[cfg(windows)]
fn which_node_executable() -> Option<String> {
    let output = crate::proc_util::hidden_command("cmd.exe")
        .args(["/C", "where node"])
        .env("Path", crate::shell_env::path_for_spawn())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(all(not(unix), not(windows)))]
fn which_node_executable() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_uses_npx_when_no_bundle() {
        let spec = mcp_launch_spec();
        assert_eq!(spec.command, "npx");
        assert!(spec.args.contains(&"@potato-workspace/mcp".to_string()));
    }
}

#[cfg(test)]
mod dev_fallback_tests {
    use super::*;

    #[test]
    fn a_dev_build_finds_the_mcp_binary_in_the_staged_resources_folder() {
        // VERIFY-R13 #3: the exe sat in src-tauri/resources/bin only, so Hook Lane stayed inactive.
        let root = std::env::temp_dir().join(format!("pm-mcp-dev-{}", uuid::Uuid::new_v4()));
        let manifest = root.join("packages/app/src-tauri");
        let staged = manifest.join("resources/bin");
        std::fs::create_dir_all(&staged).unwrap();
        assert_eq!(dev_mcp_binary(&manifest, None), None, "nothing built or staged yet");
        std::fs::write(staged.join(mcp_binary_name()), "x").unwrap();
        assert_eq!(dev_mcp_binary(&manifest, None), Some(manifest.join("resources/bin").join(mcp_binary_name())));
        // The exe-side `bin` folder (a dev run's resource dir) counts too, after the other two.
        let exe_dir = root.join("target/debug");
        std::fs::create_dir_all(exe_dir.join("bin")).unwrap();
        std::fs::write(exe_dir.join("bin").join(mcp_binary_name()), "x").unwrap();
        let only_exe = root.join("elsewhere");
        assert_eq!(dev_mcp_binary(&only_exe, Some(&exe_dir)), Some(exe_dir.join("bin").join(mcp_binary_name())));
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod installed_layout_tests {
    use super::*;

    #[test]
    fn a_bundled_folder_is_found_under_the_installers_resources_folder() {
        let install = std::env::temp_dir().join(format!("pm-mcp-folder-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(install.join("resources/pwa-dist/assets")).unwrap();
        assert_eq!(installed_resource_dir(Some(&install), Some(&install), "pwa-dist"), Some(install.join("resources/pwa-dist")));
        assert_eq!(installed_resource_dir(Some(&install), None, "nope"), None);
        // A file is not a folder.
        std::fs::write(install.join("resources/plain"), "x").unwrap();
        assert_eq!(installed_resource_dir(Some(&install), None, "plain"), None);
    }

    /// The 1.0.6 MSI layout: tauri.conf.json lists `resources/bin/*` and `resources/mcp-stdio.bundle.cjs`, and the
    /// installer keeps that folder name, so the files are under `<install>/resources/`, not next to the exe.
    #[test]
    fn an_installed_copy_finds_its_tools_under_the_resources_folder() {
        let install = std::env::temp_dir().join(format!("pm-mcp-install-{}", uuid::Uuid::new_v4()));
        let bin = install.join("resources/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(mcp_binary_name()), "x").unwrap();
        std::fs::write(install.join("resources/mcp-stdio.bundle.cjs"), "x").unwrap();
        let rel = format!("bin/{}", mcp_binary_name());

        // Tauri's resource dir on Windows is the exe's folder: the old lookup (`<resource dir>/bin/...`) found nothing.
        assert!(!install.join(&rel).is_file());
        assert_eq!(installed_resource(Some(&install), Some(&install), &rel), Some(install.join("resources").join(&rel)));
        assert_eq!(
            installed_resource(None, Some(&install), "mcp-stdio.bundle.cjs"),
            Some(install.join("resources/mcp-stdio.bundle.cjs"))
        );
        assert_eq!(installed_resource(Some(&install), Some(&install), "missing.bin"), None);
        std::fs::remove_dir_all(&install).ok();
    }

    #[test]
    fn a_resource_dir_that_already_holds_the_file_directly_still_works() {
        let dir = std::env::temp_dir().join(format!("pm-mcp-flat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.cjs"), "x").unwrap();
        assert_eq!(installed_resource(Some(&dir), None, "a.cjs"), Some(dir.join("a.cjs")));
        std::fs::remove_dir_all(&dir).ok();
    }
}
