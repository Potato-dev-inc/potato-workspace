//! Saving a file from the editor. The same path check as the reader (`resolve_in_root`), and only a file that is
//! already there: a save never makes a new path, so a link cannot be used to land outside the project. A save also
//! carries the version the editor opened, so a change made on disk in the meantime (the agent) is noticed.

use super::{image_mime, rel_of, resolve_in_root, MAX_READ_BYTES};
use serde::Serialize;
use std::fs;
use std::path::Component;

/// The biggest text a save accepts: the same as the biggest file the viewer opens.
pub const MAX_WRITE_BYTES: u64 = MAX_READ_BYTES;
/// Kinds that stay read-only: documents with their own viewer, and pictures.
const READ_ONLY_EXTS: &[&str] = &["docx", "doc", "dotx", "xlsx", "xls", "xlsm", "pptx", "ppt", "pdf", "odt", "ods", "rtf"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSaved {
    pub path: String,
    pub size: u64,
    /// The version of what was written: the editor's new starting point.
    pub version: String,
}

/// A short stamp of a file's bytes: length and an FNV-1a hash. Equal bytes give equal versions.
pub fn version_of(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:x}-{hash:016x}", bytes.len())
}

/// Writes `text` over the file `rel`. `base_version` is the version the editor opened; when the file on disk is
/// different now, nothing is written and the error starts with `FILES_CONFLICT` unless `overwrite` is true.
pub fn write_file(root: &str, rel: &str, text: &str, base_version: Option<&str>, overwrite: bool) -> Result<FileSaved, String> {
    if text.len() as u64 > MAX_WRITE_BYTES {
        return Err("FILES_TOO_LARGE: That file is too big to save from here (2 MB at most).".to_string());
    }
    let (canon_root, file) = resolve_in_root(root, rel)?;
    let inside_git = file.strip_prefix(&canon_root).map(|p| p.components().any(|c| matches!(c, Component::Normal(n) if n == ".git"))).unwrap_or(true);
    if inside_git {
        return Err("FILES_PROTECTED: Files inside .git are not saved from here.".to_string());
    }
    let meta = fs::metadata(&file).map_err(|e| format!("FILES_IO: Could not open the file: {e}."))?;
    if !meta.is_file() {
        return Err("FILES_NOT_FILE: That is not a file.".to_string());
    }
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if READ_ONLY_EXTS.contains(&ext.as_str()) || image_mime(&ext).is_some() {
        return Err("FILES_READ_ONLY: That kind of file is not edited here.".to_string());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err("FILES_TOO_LARGE: That file is too big to save from here (2 MB at most).".to_string());
    }
    let current = fs::read(&file).map_err(|e| format!("FILES_IO: Could not read the file: {e}."))?;
    if current.iter().take(8192).any(|b| *b == 0) || std::str::from_utf8(&current).is_err() {
        return Err("FILES_NOT_TEXT: This is not a plain text file, so it is not saved from here.".to_string());
    }
    if !overwrite && base_version != Some(version_of(&current).as_str()) {
        return Err("FILES_CONFLICT: The file changed on disk since you opened it.".to_string());
    }
    fs::write(&file, text.as_bytes()).map_err(|e| format!("FILES_IO: Could not save the file: {e}."))?;
    Ok(FileSaved { path: rel_of(&canon_root, &file), size: text.len() as u64, version: version_of(text.as_bytes()) })
}
