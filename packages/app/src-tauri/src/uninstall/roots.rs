//! Where everything lives, passed in explicitly.
//!
//! The planner, the executor and the helper never read `APPDATA`, `USERPROFILE` or any other
//! environment variable. Only the Tauri command layer builds a real [`Roots`]; every test builds one
//! from folders it made under the system temp folder.

use std::path::{Path, PathBuf};

/// One app profile: the default one, or `POTATO_WORKSPACE_PROFILE=<name>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// `com.potatodev.workspace` or `com.potatodev.workspace.profile-<name>`.
    pub id: String,
    /// Roaming data: `<appdata>/<id>`.
    pub data_dir: PathBuf,
    /// Local data (the WebView2 profile): `<localappdata>/<id>`.
    pub local_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Roots {
    pub home: PathBuf,
    pub appdata: PathBuf,
    pub localappdata: PathBuf,
    pub temp: PathBuf,
    pub documents: PathBuf,
    /// The installed program folder; `None` when this is not an installed copy (dev, cargo run).
    pub install_dir: Option<PathBuf>,
    /// Projects named up front (tests, the "search a folder" button). The plan also reads the
    /// remembered ones from each profile's app data.
    pub projects: Vec<PathBuf>,
}

impl Roots {
    /// The real folders of this PC. Used by the command layer only.
    pub fn real(documents: Option<PathBuf>, install_dir: Option<PathBuf>) -> Result<Self, String> {
        let home = crate::project_path::home_dir().ok_or_else(|| "could not find the home folder".to_string())?;
        let appdata = crate::app_paths::app_data_dir_for(None)
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "could not find the app data folder".to_string())?;
        let localappdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join(".cache"));
        Ok(Self {
            documents: documents.unwrap_or_else(|| home.join("Documents")),
            home,
            appdata,
            localappdata,
            temp: std::env::temp_dir(),
            install_dir,
            projects: Vec::new(),
        })
    }

    /// Every profile that has a folder here. A folder is ours only when its name is the app id or the
    /// app id plus `.profile-<name>`: the other product's `com.puppetmaster.app*` never matches.
    pub fn profiles(&self) -> Vec<Profile> {
        let base = crate::app_paths::app_id_for(None);
        let mut ids: Vec<String> = Vec::new();
        for dir in [&self.appdata, &self.localappdata] {
            let Ok(read) = std::fs::read_dir(dir) else { continue };
            for entry in read.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_our_id(&base, &name) && !ids.contains(&name) {
                    ids.push(name);
                }
            }
        }
        ids.sort();
        ids.into_iter()
            .map(|id| Profile { data_dir: self.appdata.join(&id), local_dir: self.localappdata.join(&id), id })
            .collect()
    }
}

/// `base` itself, or `base.profile-<name>` with a name the app would accept.
pub fn is_our_id(base: &str, name: &str) -> bool {
    if name == base {
        return true;
    }
    let Some(rest) = name.strip_prefix(base).and_then(|r| r.strip_prefix(".profile-")) else { return false };
    !rest.is_empty() && rest.len() <= 32 && !rest.starts_with('-') && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Bytes and file count under `path` (a file counts as one). Links are not followed.
pub fn dir_stats(path: &Path) -> (u64, u64) {
    fn walk(path: &Path, depth: usize, bytes: &mut u64, files: &mut u64) {
        let Ok(meta) = std::fs::symlink_metadata(path) else { return };
        if meta.is_dir() {
            if depth > 40 {
                return;
            }
            if let Ok(read) = std::fs::read_dir(path) {
                for entry in read.filter_map(Result::ok) {
                    walk(&entry.path(), depth + 1, bytes, files);
                }
            }
        } else {
            *bytes += meta.len();
            *files += 1;
        }
    }
    let (mut bytes, mut files) = (0, 0);
    walk(path, 0, &mut bytes, &mut files);
    (bytes, files)
}

/// "412 MB", "3 KB": a short size for the list.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else if value >= 100.0 {
        format!("{:.0} {}", value, UNITS[unit])
    } else {
        format!("{:.1} {}", value, UNITS[unit])
    }
}
