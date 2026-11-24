//! Resolve a writable project directory for PTY cwd and MCP install.

use std::path::{Path, PathBuf};

pub use crate::app_paths::home_dir;

/// Expand `~` and `~/…` so paths typed in settings resolve outside `src-tauri` during dev.
pub fn expand_user_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

/// GUI macOS apps launched from a DMG often have current_dir `/` — never use that as a project root.
pub fn is_valid_project_path(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    if path == Path::new("/") {
        return false;
    }
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if s.len() == 2 && s.ends_with(':') {
            return false;
        }
    }
    true
}

pub fn default_project_path() -> String {
    if let Ok(cwd) = std::env::current_dir() {
        if is_valid_project_path(&cwd) {
            return cwd.to_string_lossy().to_string();
        }
    }
    home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".into())
}

pub fn normalize_project_path(path: &Path) -> Result<PathBuf, String> {
    let expanded = expand_user_path(path);
    if !is_valid_project_path(&expanded) {
        return Err(
            "Pick a project folder in the header before using Claude, Codex, or OpenCode orchestrators (cannot use /)"
                .into(),
        );
    }
    Ok(expanded)
}

/// PTY spawn cwd: explicit path when valid, otherwise registry default (also validated).
pub fn resolve_spawn_cwd(
    cwd: Option<String>,
    registry_fallback: String,
) -> Result<PathBuf, String> {
    let candidate = cwd
        .filter(|value| is_valid_project_path(Path::new(value)))
        .unwrap_or(registry_fallback);
    let normalized = normalize_project_path(Path::new(&candidate))?;
    crate::path_limit::check(&normalized).map_err(|found| found.message())?;
    Ok(normalized)
}

pub fn comparable_project_path(path: &Path) -> String {
    let normalized = normalize_project_path(path).unwrap_or_else(|_| path.to_path_buf());
    let canon = std::fs::canonicalize(&normalized).unwrap_or(normalized);
    let text = canon.to_string_lossy().replace('\\', "/");
    // `\\?\C:\x` (extended-length) and `\\?\UNC\host\share` name the same places as `C:\x` and
    // `\\host\share`; a trailing separator names the same directory as none.
    let text = if let Some(rest) = text.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = text.strip_prefix("//?/").or_else(|| text.strip_prefix("//./")) {
        rest.to_string()
    } else {
        text
    };
    let trimmed = text.trim_end_matches('/');
    let text = if trimmed.is_empty() || trimmed.ends_with(':') {
        text // a filesystem root keeps its separator
    } else {
        trimmed.to_string()
    };
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

