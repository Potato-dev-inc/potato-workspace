//! The project folder as a person sees it: a lazy folder listing, a read-only file reader and the "changed / new"
//! marks. Every path is checked against the project root first: `..`, an absolute path elsewhere, and a link
//! (symlink or junction) that leads out of the root are refused. Nothing here writes.

use base64::Engine;
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// A file bigger than this is not opened in a tab.
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// A folder shows at most this many entries (the reply says when it cut the list).
pub const MAX_ENTRIES: usize = 2000;
/// Folders that are skipped when listing a parent, unless the caller asks for them.
const HEAVY_DIRS: &[&str] = &[".git", "node_modules", "target", ".potato-workspace"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Relative to the project root, with `/`.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub entries: Vec<FileEntry>,
    /// True when the folder had more entries than `MAX_ENTRIES`.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// `text`, `image`, `binary` or `too_large`.
    pub kind: String,
    pub text: Option<String>,
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMark {
    /// Relative to the project root, with `/`. A path that ends in `/` is a whole new folder.
    pub path: String,
    /// `M` changed or `N` new.
    pub mark: String,
}

fn outside() -> String {
    "FILES_OUTSIDE: That path is not inside the project folder.".to_string()
}

/// The canonical project root.
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    fs::canonicalize(root).map_err(|_| "FILES_NO_ROOT: The project folder is not there.".to_string())
}

/// `rel` (a path under the root, `/` or `\`, or an absolute path inside it) as a canonical path that is inside the
/// root. Refuses `..`, a path that leaves the root, and a link that leads out. Returns (canonical root, canonical path).
pub fn resolve_in_root(root: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let canon_root = canonical_root(root)?;
    let given = Path::new(rel);
    if given.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(outside());
    }
    let joined = if given.is_absolute() { given.to_path_buf() } else { canon_root.join(rel.trim_start_matches(['/', '\\'])) };
    let canon = match fs::canonicalize(&joined) {
        Ok(canon) => canon,
        Err(_) => {
            // A path that is not there: say "outside" when it is an absolute path elsewhere, else "not found".
            if given.is_absolute() && !joined.starts_with(&canon_root) {
                return Err(outside());
            }
            return Err("FILES_NOT_FOUND: That file is not there any more.".to_string());
        }
    };
    if !canon.starts_with(&canon_root) {
        return Err(outside());
    }
    Ok((canon_root, canon))
}

/// The path of `abs` under `root`, with `/`.
fn rel_of(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

/// Natural order: digit runs compare as numbers, the rest ignores case.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) if p.is_ascii_digit() && q.is_ascii_digit() => {
                let mut n = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    n.push(c);
                    x.next();
                }
                let mut m = String::new();
                while let Some(c) = y.peek().copied().filter(char::is_ascii_digit) {
                    m.push(c);
                    y.next();
                }
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let ord = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(p), Some(q)) => {
                let ord = p.to_lowercase().cmp(q.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// The entries of one folder: folders first, then files, each in natural order. `rel` is "" for the root.
/// Entries that lead out of the root (a link to elsewhere) are left out. `.git` and the heavy folders are left out
/// unless `show_heavy` is true.
pub fn list_dir(root: &str, rel: &str, show_heavy: bool) -> Result<FolderListing, String> {
    let (canon_root, dir) = resolve_in_root(root, rel)?;
    if !dir.is_dir() {
        return Err("FILES_NOT_FOLDER: That is not a folder.".to_string());
    }
    let read = fs::read_dir(&dir).map_err(|e| format!("FILES_IO: Could not open the folder: {e}."))?;
    let mut entries = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if !show_heavy && HEAVY_DIRS.contains(&name.as_str()) {
            continue;
        }
        // Resolve links: one that leads out of the project is not shown at all.
        let Ok(real) = fs::canonicalize(item.path()) else { continue };
        if !real.starts_with(&canon_root) {
            continue;
        }
        let Ok(meta) = fs::metadata(&real) else { continue };
        entries.push(FileEntry { path: rel_of(&canon_root, &dir.join(&name)), name, is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() } });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(FolderListing { entries, truncated })
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Reads one file for the viewer. A file over `MAX_READ_BYTES` is not read (`too_large`); a picture comes back as a
/// `data:` URL; text as text; anything else with NUL bytes as `binary`.
pub fn read_file(root: &str, rel: &str) -> Result<FileContent, String> {
    let (canon_root, file) = resolve_in_root(root, rel)?;
    let meta = fs::metadata(&file).map_err(|e| format!("FILES_IO: Could not open the file: {e}."))?;
    if !meta.is_file() {
        return Err("FILES_NOT_FILE: That is not a file.".to_string());
    }
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = FileContent { path: rel_of(&canon_root, &file), name, size: meta.len(), kind: "text".into(), text: None, data_url: None };
    if meta.len() > MAX_READ_BYTES {
        out.kind = "too_large".into();
        return Ok(out);
    }
    let bytes = fs::read(&file).map_err(|e| format!("FILES_IO: Could not read the file: {e}."))?;
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if let Some(mime) = image_mime(&ext) {
        out.kind = "image".into();
        out.data_url = Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
        return Ok(out);
    }
    if bytes.iter().take(8192).any(|b| *b == 0) {
        out.kind = "binary".into();
        return Ok(out);
    }
    out.text = Some(String::from_utf8_lossy(&bytes).into_owned());
    Ok(out)
}

/// Turns `git status --porcelain=v1 -z` output into marks. `prefix` is the folder's place inside the repository
/// (`git rev-parse --show-prefix`); entries outside it are dropped and it is cut off the rest.
pub fn parse_status(out: &[u8], prefix: &str) -> Vec<FileMark> {
    let mut marks = Vec::new();
    let mut entries = out.split(|b| *b == 0).filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = String::from_utf8_lossy(&entry[..2]).to_string();
        let path = String::from_utf8_lossy(&entry[3..]).to_string();
        // A rename or copy lists its old path as the next entry.
        if code.contains('R') || code.contains('C') {
            let _ = entries.next();
        }
        let Some(inside) = path.strip_prefix(prefix) else { continue };
        let mark = if code == "??" || code.starts_with('A') { "N" } else { "M" };
        marks.push(FileMark { path: inside.to_string(), mark: mark.to_string() });
    }
    marks
}

/// The changed and new files of the project folder (git). Empty when it is not a git folder or git is missing.
pub fn marks(root: &str) -> Vec<FileMark> {
    let run = |args: &[&str]| {
        let mut command = crate::proc_util::hidden_command("git");
        command.arg("--no-optional-locks").args(args).current_dir(root).env("GIT_TERMINAL_PROMPT", "0");
        command.output().ok().filter(|o| o.status.success()).map(|o| o.stdout)
    };
    let Some(prefix) = run(&["rev-parse", "--show-prefix"]) else { return Vec::new() };
    let prefix = String::from_utf8_lossy(&prefix).trim().to_string();
    match run(&["status", "--porcelain=v1", "-z", "--untracked-files=normal"]) {
        Some(out) => parse_status(&out, &prefix),
        None => Vec::new(),
    }
}

/// What changed in one file since the last commit, as a unified diff (`git diff HEAD`). A new file that git does not
/// know yet comes back as all added lines. Empty when nothing changed or it is not a git folder.
pub fn diff(root: &str, rel: &str) -> Result<String, String> {
    let (canon_root, file) = resolve_in_root(root, rel)?;
    let path = rel_of(&canon_root, &file);
    let run = |args: &[&str]| {
        let mut command = crate::proc_util::hidden_command("git");
        command.arg("--no-optional-locks").args(args).current_dir(&canon_root).env("GIT_TERMINAL_PROMPT", "0");
        command.output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let tracked = run(&["ls-files", "--error-unmatch", "--", &path]).is_some();
    if tracked {
        return Ok(run(&["diff", "--no-color", "--no-ext-diff", "HEAD", "--", &path]).unwrap_or_default());
    }
    // Not tracked: git must know the folder, and the file must not be ignored, for it to count as new.
    if run(&["rev-parse", "--show-prefix"]).is_none() || run(&["check-ignore", "-q", "--", &path]).is_some() {
        return Ok(String::new());
    }
    let meta = fs::metadata(&file).map_err(|e| format!("FILES_IO: Could not open the file: {e}."))?;
    if !meta.is_file() || meta.len() > MAX_READ_BYTES {
        return Ok(String::new());
    }
    let bytes = fs::read(&file).map_err(|e| format!("FILES_IO: Could not read the file: {e}."))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Ok(String::new());
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

/// Shows a file (or folder) in the system file manager, selected when the system can.
pub fn reveal(root: &str, rel: &str) -> Result<(), String> {
    let (_, path) = resolve_in_root(root, rel)?;
    #[cfg(windows)]
    {
        // `explorer /select,` wants no `\\?\` prefix.
        let plain = path.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        crate::proc_util::hidden_command("explorer").arg(format!("/select,{plain}")).spawn().map(|_| ()).map_err(|e| format!("FILES_IO: Could not open Explorer: {e}."))
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(not(target_os = "macos"))]
        let program = "xdg-open";
        let target = if path.is_dir() { path.clone() } else { path.parent().map(Path::to_path_buf).unwrap_or(path.clone()) };
        crate::proc_util::hidden_command(program).arg(target).spawn().map(|_| ()).map_err(|e| format!("FILES_IO: Could not open the file manager: {e}."))
    }
}

#[cfg(test)]
mod tests;
