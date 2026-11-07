//! Files a person adds to a chat message, as structured data (like the Claude desktop app): a text file keeps its
//! own path, an image or any other file is copied into the project (`.potato-workspace/attachments/`) so the agent
//! can open it from a path it is allowed to read. The message carries the list; nothing is pasted into its text.
//!
//! - `mod` (here): the `ChatAttachment` record, `prepare`, `save_pasted`, `preview`.
//! - `blocks`: the ACP prompt blocks an attachment becomes, and file URIs.
//! - `search`: the project file picker behind `@`.

pub mod blocks;
pub mod search;

#[cfg(test)]
mod tests;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ATTACHMENTS_DIR: &str = "attachments";
/// A file up to this size may be read as text.
pub const MAX_TEXT_BYTES: u64 = 256 * 1024;
/// The biggest pasted picture.
pub const MAX_PASTED_BYTES: usize = 20 * 1024 * 1024;
/// The biggest picture `preview` turns into a data URL.
pub const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
/// Most attachments on one message.
pub const MAX_ATTACHMENTS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachKind {
    Text,
    Image,
    File,
}

/// One attachment of a chat message (camelCase JSON, the same shape in and out).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub name: String,
    /// Absolute path the agent reads.
    pub path: String,
    pub kind: AttachKind,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
}

fn extension(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The mime type of a picture by its extension; `None` for anything that is not a png, jpg, gif or webp.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    match extension(path).as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn other_mime(path: &Path) -> Option<&'static str> {
    match extension(path).as_str() {
        "pdf" => Some("application/pdf"),
        "zip" => Some("application/zip"),
        "json" => Some("application/json"),
        _ => None,
    }
}

/// Whether the file is text: small enough, valid UTF-8, no NUL byte.
fn is_text(path: &Path, size: u64) -> bool {
    if size > MAX_TEXT_BYTES {
        return false;
    }
    let mut bytes = Vec::with_capacity(size as usize);
    let Ok(file) = fs::File::open(path) else { return false };
    if file.take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes).is_err() {
        return false;
    }
    !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok()
}

fn attachments_dir(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".potato-workspace").join(ATTACHMENTS_DIR)
}

fn absolute(path: PathBuf) -> String {
    std::path::absolute(&path).unwrap_or(path).display().to_string()
}

/// A new, empty file in the attachments folder, named so that it did not exist before.
fn new_file_in_project(cwd: &str, name: &str) -> Result<(PathBuf, fs::File), String> {
    let dir = attachments_dir(cwd);
    fs::create_dir_all(&dir).map_err(|e| format!("ATTACHMENT_COPY_FAILED: could not make the attachments folder: {e}"))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut n = 0;
    loop {
        let target = if n == 0 { dir.join(format!("{stamp}-{name}")) } else { dir.join(format!("{stamp}-{n}-{name}")) };
        match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(file) => return Ok((target, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(format!("ATTACHMENT_COPY_FAILED: could not create {}: {e}", target.display())),
        }
    }
}

fn copy_into_project(path: &Path, cwd: &str) -> Result<PathBuf, String> {
    let (target, file) = new_file_in_project(cwd, &file_name(path))?;
    drop(file);
    fs::copy(path, &target).map_err(|e| format!("ATTACHMENT_COPY_FAILED: could not copy {}: {e}", path.display()))?;
    Ok(target)
}

/// Reads one picked file: text keeps its path, anything else is copied into the project.
pub fn prepare_one(path: &Path, cwd: &str) -> Result<ChatAttachment, String> {
    let meta = fs::metadata(path).map_err(|e| format!("ATTACHMENT_NOT_FOUND: {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("ATTACHMENT_NOT_A_FILE: {} is not a file.", path.display()));
    }
    let size = meta.len();
    let name = file_name(path);
    if let Some(mime) = image_mime(path) {
        let placed = copy_into_project(path, cwd)?;
        return Ok(ChatAttachment { name, path: absolute(placed), kind: AttachKind::Image, size, mime: Some(mime.into()) });
    }
    if is_text(path, size) {
        return Ok(ChatAttachment { name, path: absolute(path.to_path_buf()), kind: AttachKind::Text, size, mime: Some("text/plain".into()) });
    }
    let placed = copy_into_project(path, cwd)?;
    Ok(ChatAttachment { name, path: absolute(placed), kind: AttachKind::File, size, mime: other_mime(path).map(str::to_string) })
}

/// Keeps letters, digits, `-`, `_` and `.`; anything else becomes `-`. Never empty, never a dot-only name.
fn safe_stem(name: &str) -> String {
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let cleaned: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).take(60).collect();
    if cleaned.trim_matches('-').is_empty() { "pasted-image".into() } else { cleaned }
}

/// The extension for a pasted picture's mime type (`image/svg+xml` becomes `svg`).
fn pasted_extension(mime: &str) -> Option<String> {
    let sub = mime.strip_prefix("image/")?.split(';').next()?.trim().to_lowercase();
    let sub = sub.split('+').next().unwrap_or("");
    let ext = if sub == "jpeg" { "jpg" } else { sub };
    (!ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())).then(|| ext.to_string())
}

/// Saves a picture pasted into the message box (Ctrl+V) into the project's attachments folder.
pub fn save_pasted(cwd: &str, name: &str, mime: &str, data_base64: &str) -> Result<ChatAttachment, String> {
    let ext = pasted_extension(mime).ok_or_else(|| "ATTACHMENT_BAD_TYPE: only pictures can be pasted.".to_string())?;
    // The text is 4/3 of the bytes; refuse a huge one before decoding it.
    if data_base64.len() > MAX_PASTED_BYTES / 3 * 4 + 8 {
        return Err("ATTACHMENT_TOO_BIG: the picture is bigger than 20 MB.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|_| "ATTACHMENT_BAD_DATA: the picture could not be read.".to_string())?;
    if bytes.is_empty() {
        return Err("ATTACHMENT_BAD_DATA: the picture is empty.".into());
    }
    if bytes.len() > MAX_PASTED_BYTES {
        return Err("ATTACHMENT_TOO_BIG: the picture is bigger than 20 MB.".into());
    }
    let shown = format!("{}.{ext}", safe_stem(name));
    let (target, mut file) = new_file_in_project(cwd, &shown)?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|e| format!("ATTACHMENT_COPY_FAILED: could not save the picture: {e}"))?;
    let known = image_mime(&target).is_some();
    Ok(ChatAttachment {
        name: shown,
        path: absolute(target),
        kind: if known { AttachKind::Image } else { AttachKind::File },
        size: bytes.len() as u64,
        mime: Some(mime.split(';').next().unwrap_or(mime).trim().to_lowercase()),
    })
}

/// A `data:` URL for a picture (png, jpg, gif, webp) up to 8 MiB; `None` for anything else.
pub fn preview(path: &Path) -> Option<String> {
    let mime = image_mime(path)?;
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}
