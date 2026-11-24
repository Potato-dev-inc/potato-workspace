//! Where the built-in tools (Node.js, MinGit, cloudflared) are on this PC. ONE module decides; nothing else builds a path
//! to them (docs/features/app-only-updates.md).
//!
//! The tools have their own version number, `toolsVersion` in `resources/tools-manifest.json` (compiled into the app, so the
//! app always knows which tools it needs). They are looked for in this order:
//!
//! 1. the install folder (`<install>/resources/`), when its `tools-manifest.json` has the number the app needs and the files
//!    on disk match (the state after a full install);
//! 2. `%LOCALAPPDATA%/com.potatodev.workspace/tools/<number>/` (the state after an app-only update);
//! 3. neither: the tools are missing. The app still starts and offers Repair.
//!
//! Only Windows has app-only updates. Elsewhere the install folder is used as it always was.

mod stage;

pub use stage::{cleanup_local, stage_local};
#[cfg(any(test, feature = "test-util"))]
pub use stage::Staged;

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The file that says which tools version a folder holds. Same name in the install folder and in a staged folder.
pub const MANIFEST_FILE: &str = "tools-manifest.json";
/// The manifest this build was made with.
const COMPILED_MANIFEST: &str = include_str!("../../../../resources/tools-manifest.json");
/// The folder name of the app's own data (not the profile's): the tools are shared by every profile.
#[cfg(all(not(any(test, feature = "test-util")), windows))]
const APP_ID: &str = "com.potatodev.workspace";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ToolFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ToolsManifest {
    #[serde(rename = "toolsVersion")]
    pub tools_version: u32,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub git: String,
    #[serde(default)]
    pub cloudflared: String,
    /// Number of files in each tool folder (`node`, `git`). Checked only by a full check.
    #[serde(default)]
    pub counts: BTreeMap<String, u64>,
    #[serde(default)]
    pub files: Vec<ToolFile>,
}

impl ToolsManifest {
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

#[cfg(any(test, feature = "test-util"))]
thread_local! {
    static TEST_NEEDED: std::cell::RefCell<Option<Arc<ToolsManifest>>> = const { std::cell::RefCell::new(None) };
    static TEST_LOCAL: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Runs `f` as if the app needed `manifest` and kept its staged tools under `local_base` (this thread only).
#[cfg(any(test, feature = "test-util"))]
pub fn with_test_home<R>(manifest: ToolsManifest, local_base: Option<PathBuf>, f: impl FnOnce() -> R) -> R {
    set_test_home(Some((manifest, local_base)));
    let out = f();
    set_test_home(None);
    out
}

/// The same without a closure (`None` puts the real answers back). This thread only.
#[cfg(any(test, feature = "test-util"))]
pub fn set_test_home(home: Option<(ToolsManifest, Option<PathBuf>)>) {
    let (manifest, local) = match home {
        Some((m, l)) => (Some(Arc::new(m)), l),
        None => (None, None),
    };
    TEST_NEEDED.with(|n| *n.borrow_mut() = manifest);
    TEST_LOCAL.with(|l| *l.borrow_mut() = local);
}

/// The tools this build needs.
pub fn needed() -> Arc<ToolsManifest> {
    #[cfg(any(test, feature = "test-util"))]
    if let Some(m) = TEST_NEEDED.with(|n| n.borrow().clone()) {
        return m;
    }
    static NEEDED: OnceLock<Arc<ToolsManifest>> = OnceLock::new();
    NEEDED
        .get_or_init(|| {
            Arc::new(ToolsManifest::parse(COMPILED_MANIFEST).unwrap_or(ToolsManifest {
                tools_version: 0,
                node: String::new(),
                git: String::new(),
                cloudflared: String::new(),
                counts: BTreeMap::new(),
                files: Vec::new(),
            }))
        })
        .clone()
}

/// `%LOCALAPPDATA%/com.potatodev.workspace/tools`: only the person can write there, so no other account can plant a program.
pub fn local_base() -> Option<PathBuf> {
    #[cfg(any(test, feature = "test-util"))]
    return TEST_LOCAL.with(|l| l.borrow().clone());
    #[cfg(all(not(any(test, feature = "test-util")), windows))]
    {
        let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
        Some(PathBuf::from(base).join(APP_ID).join("tools"))
    }
    #[cfg(all(not(any(test, feature = "test-util")), not(windows)))]
    {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    /// Every listed file is there with the right size. Cheap; used at every start and spawn.
    Quick,
    /// Quick, plus the sha256 of every listed file and the file count of each folder. Used after a copy.
    Full,
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn count_files(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => count_files(&e.path()),
            Ok(_) => 1,
            Err(_) => 0,
        })
        .sum()
}

/// Whether the tools under `root` are the ones in `manifest`. `Err` names the first thing that is wrong (for logs, never shown).
pub fn verify(root: &Path, manifest: &ToolsManifest, depth: Depth) -> Result<(), String> {
    for file in &manifest.files {
        let path = root.join(&file.path);
        let meta = std::fs::metadata(&path).map_err(|_| format!("missing {}", file.path))?;
        if !meta.is_file() || meta.len() != file.size {
            return Err(format!("{} has the wrong size", file.path));
        }
        if depth == Depth::Full && sha256_file(&path).map_err(|e| format!("cannot read {}: {e}", file.path))? != file.sha256 {
            return Err(format!("{} has the wrong content", file.path));
        }
    }
    if depth == Depth::Full {
        for (folder, want) in &manifest.counts {
            let got = count_files(&root.join(folder));
            if got != *want {
                return Err(format!("{folder}/ has {got} files, expected {want}"));
            }
        }
    }
    Ok(())
}

/// The tools version a folder says it holds (`<root>/tools-manifest.json`), if it says one.
fn declared_version(root: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(root.join(MANIFEST_FILE)).ok()?;
    ToolsManifest::parse(&text).map(|m| m.tools_version)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Install,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolsHome {
    pub root: PathBuf,
    pub source: Source,
}

impl ToolsHome {
    /// The folder with `node` and `npm`.
    pub fn node_dir(&self) -> PathBuf {
        self.root.join("node")
    }
    /// The folder with `git`.
    pub fn git_cmd_dir(&self) -> PathBuf {
        self.root.join("git").join("cmd")
    }
    pub fn cloudflared_bin(&self) -> PathBuf {
        self.root.join("bin").join(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" })
    }
}

/// The folder staged tools of version `number` live in.
pub fn local_dir(local_base: &Path, number: u32) -> PathBuf {
    local_base.join(number.to_string())
}

/// The first good tools folder: the install folder, then the staged one, else None. Pure apart from reading the disk.
pub fn resolve(install_resources: &Path, local_base: Option<&Path>, manifest: &ToolsManifest) -> Option<ToolsHome> {
    let good = |root: &Path| declared_version(root) == Some(manifest.tools_version) && verify(root, manifest, Depth::Quick).is_ok();
    if good(install_resources) {
        return Some(ToolsHome { root: install_resources.to_path_buf(), source: Source::Install });
    }
    let local = local_dir(local_base?, manifest.tools_version);
    good(&local).then_some(ToolsHome { root: local, source: Source::Local })
}

/// The tools for the app running from `exe_dir`. On Windows: the order above. Elsewhere: the install folder as it always was.
pub fn resolve_for_exe_dir(exe_dir: &Path) -> Option<ToolsHome> {
    let resources = crate::shell_env::bundled_resources_root(exe_dir);
    // A development build keeps the old way (whatever sits next to the exe); only an installed Windows app checks the manifest.
    if cfg!(any(test, feature = "test-util")) || (cfg!(windows) && !cfg!(debug_assertions)) {
        resolve(&resources, local_base().as_deref(), &needed())
    } else {
        resources.is_dir().then_some(ToolsHome { root: resources, source: Source::Install })
    }
}

/// The tools for the running app.
pub fn current() -> Option<ToolsHome> {
    let exe = std::env::current_exe().ok()?;
    resolve_for_exe_dir(exe.parent()?)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    /// False only when an installed app has no good tools folder (the page then shows the Repair line).
    pub ok: bool,
    /// "install", "local", "missing", or "dev" (a development build is never asked to repair).
    pub source: &'static str,
    pub tools_version: u32,
}

/// What the page shows. `dev` is true for a development build, which runs on the person's own tools and never says "missing".
pub fn status_for(exe_dir: &Path, dev: bool) -> ToolsStatus {
    let tools_version = needed().tools_version;
    if dev {
        return ToolsStatus { ok: true, source: "dev", tools_version };
    }
    match resolve_for_exe_dir(exe_dir) {
        Some(home) => ToolsStatus { ok: true, source: if home.source == Source::Install { "install" } else { "local" }, tools_version },
        None => ToolsStatus { ok: false, source: "missing", tools_version },
    }
}

pub fn status() -> ToolsStatus {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_default();
    status_for(&exe_dir, cfg!(debug_assertions))
}

/// At start: when a good tools folder was found, remove staged folders of other numbers and half copies.
pub fn tidy_on_start() {
    if cfg!(debug_assertions) {
        return;
    }
    if let (Some(_), Some(base)) = (current(), local_base()) {
        let removed = cleanup_local(&base, needed().tools_version);
        if !removed.is_empty() {
            tracing::info!(removed = ?removed, "removed old staged tools");
        }
    }
}

#[cfg(test)]
mod tests;
