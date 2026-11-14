//! The files of the store (see the module doc in `mod.rs`).

use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use super::model::{Artifact, ArtifactKind, Version, MAX_BYTES};

/// One writer at a time: two agents showing a page at once cannot both pick version 3.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactError {
    Empty,
    TooBig,
    NotText,
    BadKind,
    BadId,
    NotFound,
    /// A file named by path is not inside the project.
    Outside,
    /// The artifact exists with another kind.
    KindChanged(ArtifactKind),
    Io(String),
}

impl ArtifactError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Empty => "ARTIFACT_EMPTY",
            Self::TooBig => "ARTIFACT_TOO_BIG",
            Self::NotText => "ARTIFACT_NOT_TEXT",
            Self::BadKind => "ARTIFACT_BAD_KIND",
            Self::BadId => "ARTIFACT_BAD_ID",
            Self::NotFound => "ARTIFACT_NOT_FOUND",
            Self::Outside => "ARTIFACT_OUTSIDE_PROJECT",
            Self::KindChanged(_) => "ARTIFACT_KIND_CHANGED",
            Self::Io(_) => "ARTIFACT_IO",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Empty => "The page is empty.".into(),
            Self::TooBig => "The page is bigger than 16 MB.".into(),
            Self::NotText => "The page is not text.".into(),
            Self::BadKind => "The kind must be html, markdown, svg or mermaid.".into(),
            Self::BadId => "That artifact id is not valid (letters, digits and dashes only).".into(),
            Self::NotFound => "There is no such artifact.".into(),
            Self::Outside => "The file must be inside the project folder.".into(),
            Self::KindChanged(kind) => format!("This artifact is already a {} page. Use another title for a page of another kind.", kind.as_str()),
            Self::Io(why) => format!("Could not save the page: {why}"),
        }
    }
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

fn io(e: std::io::Error) -> ArtifactError {
    ArtifactError::Io(e.to_string())
}

/// `<project>/.potato/artifacts`.
pub fn artifacts_dir(project: &Path) -> PathBuf {
    project.join(".potato").join("artifacts")
}

/// An id from a title: lowercase letters, digits and single dashes, at most 48 characters; "artifact" when nothing is left.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "artifact".into()
    } else {
        out
    }
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !id.starts_with('-')
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn sha_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn ensure_root(project: &Path) -> Result<PathBuf, ArtifactError> {
    let dir = artifacts_dir(project);
    fs::create_dir_all(&dir).map_err(io)?;
    // Best effort, once per process: outside a git work tree nothing is written.
    static DONE: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let mut done = DONE.lock();
    if !done.iter().any(|p| p == project) {
        crate::git_exclude::exclude_file(project, ".potato/");
        done.push(project.to_path_buf());
    }
    Ok(dir)
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(id).join("meta.json")
}

fn version_file(dir: &Path, a: &Artifact, n: u32) -> PathBuf {
    dir.join(&a.id).join(format!("v{n}.{}", a.kind.ext()))
}

fn load_meta(dir: &Path, id: &str) -> Option<Artifact> {
    serde_json::from_slice(&fs::read(meta_path(dir, id)).ok()?).ok()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ArtifactError> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(io)?;
    fs::rename(&tmp, path).map_err(io)
}

/// Adds `content` as the next version of artifact `id` (creating it). The same content as the latest version adds
/// nothing: the answer's second part is `None`. `source` is the loose file the page follows, if any.
pub fn add_version(project: &Path, id: &str, title: &str, kind: ArtifactKind, content: &str, source: Option<&str>) -> Result<(Artifact, Option<u32>), ArtifactError> {
    if !valid_id(id) {
        return Err(ArtifactError::BadId);
    }
    if content.trim().is_empty() {
        return Err(ArtifactError::Empty);
    }
    if content.len() > MAX_BYTES {
        return Err(ArtifactError::TooBig);
    }
    let _one = WRITE.lock();
    let dir = ensure_root(project)?;
    let sha = sha_of(content.as_bytes());
    let at = now();
    let mut artifact = match load_meta(&dir, id) {
        Some(existing) => {
            if existing.kind != kind {
                return Err(ArtifactError::KindChanged(existing.kind));
            }
            existing
        }
        None => Artifact {
            id: id.to_string(),
            title: title.trim().chars().take(120).collect(),
            kind,
            source: source.map(str::to_string),
            created_at: at.clone(),
            updated_at: at.clone(),
            versions: Vec::new(),
            share: None,
        },
    };
    if artifact.versions.last().is_some_and(|v| v.sha == sha) {
        return Ok((artifact, None));
    }
    let n = artifact.latest() + 1;
    fs::create_dir_all(dir.join(id)).map_err(io)?;
    write_atomic(&version_file(&dir, &artifact, n), content.as_bytes())?;
    artifact.versions.push(Version { n, at: at.clone(), bytes: content.len() as u64, sha });
    artifact.updated_at = at;
    if !title.trim().is_empty() && artifact.source.is_none() {
        artifact.title = title.trim().chars().take(120).collect();
    }
    if artifact.source.is_none() {
        artifact.source = source.map(str::to_string);
    }
    write_atomic(&meta_path(&dir, id), &serde_json::to_vec_pretty(&artifact).map_err(|e| ArtifactError::Io(e.to_string()))?)?;
    Ok((artifact, Some(n)))
}

/// A title from a file name: `quarterly-report.html` becomes "Quarterly report".
fn title_of(stem: &str) -> String {
    let words = stem.replace(['-', '_'], " ");
    let mut chars = words.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Page".into(),
    }
}

/// Reads the loose files of `.potato/artifacts/` and records each new or changed one as a version. Returns the
/// versions that were added. A file that is not text, too big, empty or of another kind than its artifact is skipped.
pub fn sync_folder(project: &Path) -> Vec<(Artifact, u32)> {
    let dir = artifacts_dir(project);
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut added = Vec::new();
    let mut names: Vec<String> = entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).filter_map(|e| e.file_name().into_string().ok()).collect();
    names.sort();
    for name in names {
        let Some(kind) = ArtifactKind::from_name(&name) else { continue };
        let path = dir.join(&name);
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.len() as usize > MAX_BYTES || meta.len() == 0 {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
        if let Ok((artifact, Some(n))) = add_version(project, &slug(stem), &title_of(stem), kind, &text, Some(&name)) {
            added.push((artifact, n));
        }
    }
    added
}

/// Every artifact of the project, newest change first.
pub fn list(project: &Path) -> Vec<Artifact> {
    let dir = artifacts_dir(project);
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<Artifact> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|id| valid_id(id))
        .filter_map(|id| load_meta(&dir, &id))
        .filter(|a| !a.versions.is_empty())
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// A version's content.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub artifact: Artifact,
    pub version: u32,
    pub content: String,
}

/// The artifact and one version of it (`None`: the latest).
pub fn read(project: &Path, id: &str, version: Option<u32>) -> Result<Read, ArtifactError> {
    if !valid_id(id) {
        return Err(ArtifactError::BadId);
    }
    let dir = artifacts_dir(project);
    let artifact = load_meta(&dir, id).ok_or(ArtifactError::NotFound)?;
    let n = version.unwrap_or_else(|| artifact.latest());
    if !artifact.versions.iter().any(|v| v.n == n) {
        return Err(ArtifactError::NotFound);
    }
    let bytes = fs::read(version_file(&dir, &artifact, n)).map_err(|_| ArtifactError::NotFound)?;
    let content = String::from_utf8(bytes).map_err(|_| ArtifactError::NotText)?;
    Ok(Read { artifact, version: n, content })
}

/// Where a version's file is.
pub fn file_of(project: &Path, id: &str, version: Option<u32>) -> Result<PathBuf, ArtifactError> {
    let r = read(project, id, version)?;
    Ok(version_file(&artifacts_dir(project), &r.artifact, r.version))
}

/// A file inside the project, read as text for `show_artifact` with a `path`. Refuses anything outside the project
/// folder (a `..`, an absolute path elsewhere, a link that leads out).
pub fn read_project_file(project: &Path, path: &str) -> Result<String, ArtifactError> {
    let root = fs::canonicalize(project).map_err(io)?;
    let wanted = Path::new(path);
    let full = if wanted.is_absolute() { wanted.to_path_buf() } else { root.join(wanted) };
    let full = fs::canonicalize(full).map_err(|_| ArtifactError::NotFound)?;
    if !full.starts_with(&root) || !full.is_file() {
        return Err(ArtifactError::Outside);
    }
    let len = fs::metadata(&full).map_err(io)?.len() as usize;
    if len > MAX_BYTES {
        return Err(ArtifactError::TooBig);
    }
    String::from_utf8(fs::read(full).map_err(io)?).map_err(|_| ArtifactError::NotText)
}
