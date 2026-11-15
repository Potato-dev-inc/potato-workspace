//! Step 0, "Look": walk the folder, drop what must never be read, score the rest. No model, free, seconds.
//!
//! What is dropped (and why it is told to the person on the consent sheet):
//! * secrets by name (`.env*`, keys, certificates, `credentials*`, ...): never read, never named to an agent;
//! * binaries, lock files, minified files, build output, vendored code, files over [`MAX_FILE_BYTES`];
//! * whatever the project's own `.gitignore` hides (simple patterns) and the steering file's `skip` list.
//!
//! The score says which files a page must not leave out: manifests and entry points, files many others import (a cheap
//! pattern match, no parser), files git changed often, and the README.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use regex::Regex;
use serde::Serialize;

use super::store::Steering;

/// A file bigger than this is skipped (generated data, bundles).
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// The walk stops after this many files (a huge monorepo): the scan says it was cut.
pub const MAX_VISITED: usize = 20_000;
/// A project with fewer source files than this is not offered a guide.
pub const MIN_SOURCE_FILES: usize = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    Secret,
    Binary,
    Lock,
    Generated,
    TooBig,
    Ignored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Source,
    Doc,
    Manifest,
    Config,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub path: String,
    pub size: u64,
    pub score: f32,
    pub kind: FileKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    /// Best score first.
    pub files: Vec<ScannedFile>,
    pub skipped: Vec<SkippedFile>,
    /// The walk was cut at [`MAX_VISITED`].
    pub truncated: bool,
}

impl Scan {
    pub fn source_count(&self) -> usize {
        self.files.iter().filter(|f| f.kind == FileKind::Source).count()
    }

    /// The paths a page must not leave out: the best-scored ones, at most `n`.
    pub fn top_paths(&self, n: usize) -> Vec<String> {
        self.files.iter().take(n).map(|f| f.path.clone()).collect()
    }
}

const SKIP_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "vendor", "third_party",
    "__pycache__", ".venv", "venv", ".tox", ".gradle", ".idea", ".vscode", "coverage", ".cache", ".potato", ".potato-workspace",
    ".turbo", "bower_components", "Pods", ".terraform", ".ssh", ".aws", ".gnupg", ".kube", ".dart_tool", ".pytest_cache", ".mypy_cache",
];

const SECRET_EXTS: &[&str] = &["pem", "key", "p12", "pfx", "keystore", "jks", "ppk", "kdbx", "asc", "gpg", "secret", "token", "crt", "cer", "der"];

const BINARY_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff", "psd", "svgz", "mp3", "mp4", "mov", "avi", "mkv", "wav", "ogg", "flac", "webm", "zip",
    "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "obj", "class", "pyc", "wasm", "pdf",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "ttf", "otf", "woff", "woff2", "eot", "db", "sqlite", "sqlite3", "iso", "dmg", "msi", "apk", "ipa", "node",
];

const LOCK_NAMES: &[&str] = &[
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "composer.lock", "poetry.lock", "go.sum", "gemfile.lock", "pipfile.lock",
    "bun.lockb", "flake.lock", "npm-shrinkwrap.json",
];

const MANIFESTS: &[&str] = &[
    "package.json", "cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "gemfile", "composer.json", "requirements.txt",
    "setup.py", "makefile", "dockerfile", "cmakelists.txt", "deno.json", "mix.exs", "pubspec.yaml", "tauri.conf.json",
];

const ENTRY_STEMS: &[&str] = &["main", "index", "lib", "app", "mod", "server", "cli", "__main__", "program", "init", "__init__"];

const SOURCE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "scala", "lua",
    "dart", "ex", "exs", "sh", "ps1", "sql", "vue", "svelte", "zig", "hs", "ml", "clj", "r",
];

/// Is this name a secret file? Looked at by name only, so a secret is never even opened.
pub fn is_secret_name(file_name: &str) -> bool {
    let name = file_name.to_ascii_lowercase();
    if name.starts_with(".env") {
        return true;
    }
    if name.starts_with("id_rsa") || name.starts_with("id_dsa") || name.starts_with("id_ecdsa") || name.starts_with("id_ed25519") {
        return true;
    }
    if matches!(name.as_str(), ".npmrc" | ".netrc" | ".pgpass" | ".git-credentials" | ".dockerconfigjson" | "htpasswd" | ".htpasswd" | "secrets.yml" | "secrets.yaml") {
        return true;
    }
    if name.starts_with("credentials") || name.starts_with("service-account") || name.starts_with("serviceaccount") {
        return true;
    }
    let stem_ext = name.rsplit_once('.');
    if let Some((stem, ext)) = stem_ext {
        if SECRET_EXTS.contains(&ext) {
            return true;
        }
        if stem == "secrets" && matches!(ext, "json" | "toml" | "env" | "txt" | "ini") {
            return true;
        }
    }
    false
}

/// Why a project-relative path must not be read, judged by name and size alone. `None`: it may be read.
pub fn classify(rel: &str, size: u64) -> Option<SkipReason> {
    let rel = rel.replace('\\', "/");
    let mut parts: Vec<&str> = rel.split('/').collect();
    let file = parts.pop().unwrap_or("");
    if parts.iter().any(|dir| SKIP_DIRS.contains(dir)) {
        return Some(SkipReason::Generated);
    }
    if is_secret_name(file) {
        return Some(SkipReason::Secret);
    }
    let lower = file.to_ascii_lowercase();
    if LOCK_NAMES.contains(&lower.as_str()) || lower.ends_with(".lock") || lower.ends_with(".min.js") || lower.ends_with(".min.css") || lower.ends_with(".map") {
        return Some(SkipReason::Lock);
    }
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if BINARY_EXTS.contains(&ext) {
        return Some(SkipReason::Binary);
    }
    if size > MAX_FILE_BYTES {
        return Some(SkipReason::TooBig);
    }
    None
}

/// `*` (any run) and `?` (one character) only.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The simple patterns of a `.gitignore` (and the steering `skip` list): names, globs, and `dir/` or `/path` prefixes.
/// Negations and `**` are left to git; a file kept by one is only ever skipped (never wrongly read).
#[derive(Debug, Clone, Default)]
pub struct IgnoreRules {
    patterns: Vec<String>,
}

impl IgnoreRules {
    pub fn parse(text: &str) -> Self {
        let patterns = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!'))
            .map(|l| l.replace("**/", "").replace("/**", "/"))
            .collect();
        Self { patterns }
    }

    pub fn add(&mut self, pattern: &str) {
        let p = pattern.trim().trim_end_matches('/').to_string();
        if !p.is_empty() {
            self.patterns.push(p);
        }
    }

    pub fn ignores(&self, rel: &str) -> bool {
        let comps: Vec<&str> = rel.split('/').collect();
        self.patterns.iter().any(|raw| {
            let anchored = raw.starts_with('/') || raw.trim_end_matches('/').contains('/');
            let pat = raw.trim_start_matches('/').trim_end_matches('/');
            if pat.is_empty() {
                return false;
            }
            if anchored {
                let pat_parts: Vec<&str> = pat.split('/').collect();
                comps.len() >= pat_parts.len() && pat_parts.iter().zip(&comps).all(|(p, c)| glob_match(p, c))
            } else {
                comps.iter().any(|c| glob_match(pat, c))
            }
        })
    }
}

fn kind_of(rel: &str) -> FileKind {
    let lower = rel.to_ascii_lowercase();
    let file = lower.rsplit('/').next().unwrap_or("");
    if MANIFESTS.contains(&file) {
        return FileKind::Manifest;
    }
    let ext = file.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if SOURCE_EXTS.contains(&ext) {
        FileKind::Source
    } else if matches!(ext, "md" | "mdx" | "rst" | "txt") {
        FileKind::Doc
    } else {
        FileKind::Config
    }
}

fn stem_of(rel: &str) -> String {
    let file = rel.rsplit('/').next().unwrap_or(rel);
    file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file).to_ascii_lowercase()
}

fn is_text(bytes: &[u8]) -> bool {
    !bytes.iter().take(4096).any(|b| *b == 0)
}

/// Best-effort count of how many recent commits touched each file (`git log`, no window). Empty when not a repo.
pub fn git_churn(project: &Path) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    let Ok(out) = crate::proc_util::hidden_command("git").arg("-C").arg(project).args(["log", "--name-only", "--pretty=format:", "-n", "300"]).output() else {
        return counts;
    };
    if !out.status.success() {
        return counts;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l| !l.is_empty()) {
        *counts.entry(line.to_string()).or_insert(0) += 1;
    }
    counts
}

/// The walk, the skips and the scores. `churn` is how often git changed each file (`None`: not used).
pub fn scan_with(project: &Path, steering: &Steering, churn: Option<&HashMap<String, u32>>) -> Scan {
    let mut ignore = fs::read_to_string(project.join(".gitignore")).map(|t| IgnoreRules::parse(&t)).unwrap_or_default();
    for pattern in &steering.skip {
        ignore.add(pattern);
    }
    let mut scan = Scan::default();
    let mut stack = vec![String::new()];
    let mut visited = 0usize;
    let mut kept: Vec<(String, u64)> = Vec::new();
    'walk: while let Some(dir_rel) = stack.pop() {
        let dir_path = if dir_rel.is_empty() { project.to_path_buf() } else { project.join(&dir_rel) };
        let Ok(read) = fs::read_dir(&dir_path) else { continue };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if ignore.ignores(&rel) {
                    continue;
                }
                stack.push(rel);
                continue;
            }
            visited += 1;
            if visited > MAX_VISITED {
                scan.truncated = true;
                break 'walk;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if let Some(reason) = classify(&rel, size) {
                scan.skipped.push(SkippedFile { path: rel, reason });
            } else if ignore.ignores(&rel) {
                scan.skipped.push(SkippedFile { path: rel, reason: SkipReason::Ignored });
            } else {
                kept.push((rel, size));
            }
        }
    }

    // Read the text of the files that may be read (once) to count imports.
    let import_re = Regex::new(r#"(?m)(?:\bfrom|\bimport|\brequire\(?|\buse|\bmod|\binclude|#include)\s+['"<(]?([A-Za-z0-9_./@:\\-]+)"#).expect("import pattern");
    let mut stems: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, (rel, _)) in kept.iter().enumerate() {
        if kind_of(rel) == FileKind::Source {
            stems.entry(stem_of(rel)).or_default().push(i);
        }
    }
    let mut imported_by: HashMap<usize, HashSet<usize>> = HashMap::new();
    let mut binary: Vec<usize> = Vec::new();
    for (i, (rel, _)) in kept.iter().enumerate() {
        let Ok(bytes) = fs::read(project.join(rel)) else { continue };
        if !is_text(&bytes) {
            binary.push(i);
            continue;
        }
        if kind_of(rel) != FileKind::Source {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for cap in import_re.captures_iter(&text) {
            for seg in cap[1].split(|c| matches!(c, '/' | '\\' | ':' | '.' | '@')).filter(|s| s.len() >= 3) {
                let seg = seg.to_ascii_lowercase();
                if matches!(seg.as_str(), "mod" | "index" | "main" | "lib" | "self" | "super" | "crate" | "std") {
                    continue;
                }
                if let Some(targets) = stems.get(&seg) {
                    if targets.len() <= 3 {
                        for t in targets {
                            if *t != i {
                                imported_by.entry(*t).or_default().insert(i);
                            }
                        }
                    }
                }
            }
        }
    }
    let binary: HashSet<usize> = binary.into_iter().collect();

    let mut files = Vec::new();
    for (i, (rel, size)) in kept.into_iter().enumerate() {
        if binary.contains(&i) {
            scan.skipped.push(SkippedFile { path: rel, reason: SkipReason::Binary });
            continue;
        }
        let kind = kind_of(&rel);
        let lower = rel.to_ascii_lowercase();
        let depth = rel.matches('/').count() as f32;
        let mut score = 1.0 - depth.min(6.0) * 0.5;
        match kind {
            FileKind::Manifest => score += if depth == 0.0 { 40.0 } else { 15.0 },
            FileKind::Source => score += 4.0,
            FileKind::Doc => score += 2.0,
            FileKind::Config => score -= 1.0,
        }
        if ENTRY_STEMS.contains(&stem_of(&rel).as_str()) && kind == FileKind::Source {
            score += 20.0 + if depth <= 2.0 { 5.0 } else { 0.0 };
        }
        if lower.starts_with("readme") {
            score += 30.0;
        } else if lower.rsplit('/').next().is_some_and(|f| f.starts_with("readme")) {
            score += 8.0;
        }
        if lower.starts_with("docs/") && kind == FileKind::Doc {
            score += 6.0;
        }
        if lower.contains("test") || lower.contains("spec") || lower.contains("__tests__") || lower.contains("fixture") {
            score -= 12.0;
        }
        score += (imported_by.get(&i).map_or(0, |s| s.len()) as f32 * 3.0).min(30.0);
        if let Some(churn) = churn {
            score += (churn.get(&rel).copied().unwrap_or(0) as f32 * 0.5).min(20.0);
        }
        files.push(ScannedFile { path: rel, size, score, kind });
    }
    files.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.path.cmp(&b.path)));
    scan.files = files;
    scan
}

/// The scan the app runs (git churn included).
pub fn scan(project: &Path) -> Scan {
    let steering = super::store::read_steering(project);
    let churn = git_churn(project);
    scan_with(project, &steering, Some(&churn))
}

/// How many files were skipped, by reason (for the "See list" part of the sheet).
pub fn skip_summary(scan: &Scan) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for s in &scan.skipped {
        let key = match s.reason {
            SkipReason::Secret => "secret",
            SkipReason::Binary => "binary",
            SkipReason::Lock => "lock",
            SkipReason::Generated => "generated",
            SkipReason::TooBig => "tooBig",
            SkipReason::Ignored => "ignored",
        };
        *out.entry(key.to_string()).or_insert(0) += 1;
    }
    out
}
