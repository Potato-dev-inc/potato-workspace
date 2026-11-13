//! `POST /panes/{id}/uploads`: a photo or a file from the phone for one agent (phone compose, P14).
//!
//! The body is `{ "name", "mime"?, "data_base64" }`. The route needs the `type` right (`route_need`), and because the path is
//! under `/panes/{id}` the agent's own remote rule is checked by `authorize_caller` first: a watch-only device, a watch-only
//! agent and a switched-off agent are all refused before this runs. This code adds the limits of a file that comes from
//! outside:
//!
//! - one fixed folder, `<app data>/phone-uploads/<YYYY-MM-DD>/`; the name the phone sends is cut down to letters, digits and a
//!   few marks, so it can never point out of that folder;
//! - at most 10 MB per file (the bridge's body limit is raised for this one path only, see `bridge::http::body_limit`);
//! - pictures (png, jpg, gif, webp) and common text files and PDF only, and the bytes must look like what the name says;
//! - the folder as a whole is capped, and every day folder older than 7 days is deleted when the bridge starts and before an
//!   upload;
//! - every upload is written to the PC's log (who, which agent, the name and the size).
//!
//! The answer is a `ChatAttachment`; the phone then sends its message with that list (`POST /panes/{id}/messages`, which
//! accepts only paths that this module made), so the agent gets the path the same way as a file dropped on the desktop.
//! None of this is an MCP tool: an agent session cannot reach it.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;
use serde_json::json;

use super::{Ctx, RouteResult};
use crate::attach::{AttachKind, ChatAttachment};

/// The biggest file the phone may send.
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// Day folders older than this many days are deleted.
pub const KEEP_DAYS: i64 = 7;
/// All uploads together may not take more than this on the PC.
pub const MAX_FOLDER_BYTES: u64 = 300 * 1024 * 1024;
/// A name is cut to this many characters.
const MAX_NAME_CHARS: usize = 80;

const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXT_EXTENSIONS: [&str; 24] = [
    "txt", "md", "json", "csv", "log", "yaml", "yml", "toml", "xml", "html", "css", "js", "ts", "tsx", "jsx", "py", "rs", "go", "java",
    "c", "h", "cpp", "sh", "sql",
];

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("POST", ["panes", pane_id, "uploads"]) if !super::panes::is_reserved_pane_id(pane_id) => Some(upload(cx, pane_id)),
        _ => None,
    }
}

/// The folder every upload lives in.
pub fn uploads_root() -> PathBuf {
    crate::app_paths::app_data_dir().join("phone-uploads")
}

/// Whether `path` is a file this module saved (inside the uploads folder, no `..`). A message may carry only these.
pub fn is_ours(path: &str) -> bool {
    is_inside(&uploads_root(), path)
}

fn is_inside(root: &Path, path: &str) -> bool {
    let candidate = Path::new(path);
    if candidate.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return false;
    }
    match (fs::canonicalize(root), fs::canonicalize(candidate)) {
        (Ok(root), Ok(file)) => file.starts_with(root) && file.is_file(),
        _ => false,
    }
}

fn refuse(status: u16, code: &str, error: &str) -> (u16, serde_json::Value) {
    (status, json!({ "error": error, "code": code }))
}

#[derive(Deserialize)]
struct Body {
    name: String,
    #[serde(default)]
    mime: String,
    data_base64: String,
}

fn upload(cx: &Ctx, pane_id: &str) -> RouteResult {
    if !cx.registry.lock().panes.contains_key(pane_id) {
        return Err((404, json!({ "error": crate::pty::registry::unknown_pane_message(pane_id), "code": "UNKNOWN_PANE" })));
    }
    let body: Body = serde_json::from_value(cx.request_body.clone()).map_err(|_| refuse(400, "INVALID_ARGUMENT", "name and data_base64 are required"))?;
    let root = uploads_root();
    let today = chrono::Local::now().date_naive();
    clean_old(&root, today);
    let saved = save_in(&root, today, &body.name, &body.mime, &body.data_base64)?;
    let device = crate::mobile_pairing::bearer_token(cx.headers).and_then(|token| crate::mobile_pairing::pairing_store()?.lock().device_id_for_token(&token));
    crate::audit::record(
        crate::audit::Kind::Pairing,
        crate::audit::Who::Device(device),
        "A phone sent a file to one agent",
        json!({ "pane_id": pane_id, "name": saved.name, "size": saved.size }),
    );
    Ok((200, json!({ "attachment": saved })))
}

/// Checks and saves one upload under `root/<day>/`. The pure part of the route (the tests call it with a temp folder).
pub fn save_in(root: &Path, day: chrono::NaiveDate, name: &str, mime: &str, data_base64: &str) -> Result<ChatAttachment, (u16, serde_json::Value)> {
    let (stem, extension) = clean_name(name);
    let Some(kind) = kind_of(&extension) else {
        return Err(refuse(415, "UPLOAD_BAD_TYPE", "Only pictures, PDF and common text files can be sent."));
    };
    // The text is 4/3 of the bytes: refuse a huge one before decoding it.
    if data_base64.len() > MAX_UPLOAD_BYTES / 3 * 4 + 8 {
        return Err(refuse(413, "UPLOAD_TOO_BIG", "That file is bigger than 10 MB."));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|_| refuse(400, "UPLOAD_BAD_DATA", "The file could not be read."))?;
    if bytes.is_empty() {
        return Err(refuse(400, "UPLOAD_BAD_DATA", "The file is empty."));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(refuse(413, "UPLOAD_TOO_BIG", "That file is bigger than 10 MB."));
    }
    if !looks_like(&extension, &bytes) {
        return Err(refuse(415, "UPLOAD_BAD_TYPE", "The file is not what its name says."));
    }
    if folder_size(root) + bytes.len() as u64 > MAX_FOLDER_BYTES {
        return Err(refuse(507, "UPLOAD_FOLDER_FULL", "The PC's folder for phone files is full. Try again in a day."));
    }
    let dir = root.join(day.format("%Y-%m-%d").to_string());
    fs::create_dir_all(&dir).map_err(|_| refuse(500, "UPLOAD_FAILED", "The PC could not save the file."))?;
    let shown = format!("{stem}.{extension}");
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut n = 0u32;
    let (target, mut file) = loop {
        let candidate = if n == 0 { dir.join(format!("{stamp}-{shown}")) } else { dir.join(format!("{stamp}-{n}-{shown}")) };
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(_) => return Err(refuse(500, "UPLOAD_FAILED", "The PC could not save the file.")),
        }
    };
    std::io::Write::write_all(&mut file, &bytes).map_err(|_| refuse(500, "UPLOAD_FAILED", "The PC could not save the file."))?;
    let mime = declared_mime(mime, &extension);
    Ok(ChatAttachment {
        name: shown,
        path: std::path::absolute(&target).unwrap_or(target).display().to_string(),
        kind,
        size: bytes.len() as u64,
        mime: Some(mime),
    })
}

/// A name the phone sent, as a safe stem and a lower-case extension. Never empty, never a path.
fn clean_name(name: &str) -> (String, String) {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let path = Path::new(last);
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let cleaned: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).take(MAX_NAME_CHARS).collect();
    let stem = if cleaned.trim_matches('-').is_empty() { "phone-file".to_string() } else { cleaned };
    (stem, extension.chars().filter(char::is_ascii_alphanumeric).take(8).collect())
}

fn kind_of(extension: &str) -> Option<AttachKind> {
    if IMAGE_EXTENSIONS.contains(&extension) {
        Some(AttachKind::Image)
    } else if extension == "pdf" {
        Some(AttachKind::File)
    } else if TEXT_EXTENSIONS.contains(&extension) {
        Some(AttachKind::Text)
    } else {
        None
    }
}

/// The first bytes say the same as the name: a picture has its header, a PDF starts with `%PDF`, text is UTF-8 without NUL.
fn looks_like(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "jpg" | "jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => bytes.starts_with(b"GIF8"),
        "webp" => bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "pdf" => bytes.starts_with(b"%PDF"),
        _ => !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok(),
    }
}

fn declared_mime(sent: &str, extension: &str) -> String {
    match extension {
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "gif" => "image/gif".into(),
        "webp" => "image/webp".into(),
        "pdf" => "application/pdf".into(),
        _ => {
            let _ = sent;
            "text/plain".into()
        }
    }
}

fn folder_size(root: &Path) -> u64 {
    let mut total = 0;
    let Ok(days) = fs::read_dir(root) else { return 0 };
    for day in days.flatten() {
        let Ok(files) = fs::read_dir(day.path()) else { continue };
        total += files.flatten().filter_map(|f| f.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum::<u64>();
    }
    total
}

/// Deletes the day folders older than [`KEEP_DAYS`]. Only folders named like a date are touched; anything else stays.
/// Returns how many folders were removed.
pub fn clean_old(root: &Path, today: chrono::NaiveDate) -> usize {
    let Ok(days) = fs::read_dir(root) else { return 0 };
    let mut removed = 0;
    for entry in days.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(day) = chrono::NaiveDate::parse_from_str(&name, "%Y-%m-%d") else { continue };
        if (today - day).num_days() > KEEP_DAYS && fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The cleanup the bridge runs once when it starts.
pub fn clean_on_start() {
    let removed = clean_old(&uploads_root(), chrono::Local::now().date_naive());
    if removed > 0 {
        tracing::info!(removed, "removed old phone uploads");
    }
}

#[cfg(test)]
#[path = "phone_upload_tests.rs"]
mod tests;
