//! Pictures in the chat: a picture an agent names (`![chart](out/chart.png)`) is read here and shown in the answer.
//!
//! The rules, in the order they are checked, so no path can reach a file the person did not put in front of the agent:
//! - only a file on this PC: a web address (`http:`, `data:`, `//host`) is refused, nothing is ever fetched;
//! - the path is made absolute (a relative one starts from the chat's project folder), then resolved through every
//!   link (`canonicalize`), and the result must be INSIDE the project folder of the chat (its attachments folder
//!   is inside it) or the phone-uploads folder. `..` and a link out of the folder both end up outside;
//! - a file that is not there and a file outside the folders get the same answer, so nothing is learned about the PC;
//! - only png, jpg, gif, webp and svg, and the first bytes must look like what the name says;
//! - a size cap (bigger for the PC, smaller for the phone);
//! - an svg with anything that can run or load something (a script, an event handler, `javascript:`, a frame, a web
//!   reference, a doctype) is refused; the view also only ever draws it as an `<img>`, which runs no script.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

/// The biggest picture the desktop shows.
pub const MAX_BYTES: u64 = 6 * 1024 * 1024;
/// The biggest picture the phone is sent.
pub const PHONE_MAX_BYTES: u64 = 3 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub message: &'static str,
}

const fn refuse(code: &'static str, message: &'static str) -> Refused {
    Refused { code, message }
}

const NOT_HERE: Refused = refuse("PICTURE_NOT_IN_PROJECT", "That picture is not in this project, so it is not shown.");
const BAD_TYPE: Refused = refuse("PICTURE_BAD_TYPE", "Only png, jpg, gif, webp and svg pictures are shown.");
const UNSAFE: Refused = refuse("PICTURE_UNSAFE", "This picture has something in it that could run, so it is not shown.");
const TOO_BIG: Refused = refuse("PICTURE_TOO_BIG", "This picture is too big to show here.");
const UNREADABLE: Refused = refuse("PICTURE_UNREADABLE", "This picture could not be read.");

/// A picture ready to draw: `data_url` is a `data:` URL, so the view never loads anything from the network or the disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    pub name: String,
    pub mime: &'static str,
    pub size: u64,
    pub data_url: String,
}

/// The folders a chat may show pictures from: its project folder and the folder of the phone's uploads.
pub fn roots_for(cwd: &str) -> Vec<PathBuf> {
    vec![PathBuf::from(cwd), crate::app_paths::app_data_dir().join("phone-uploads")]
}

/// The mime type for the extension, `None` for anything that is not a picture this view draws.
fn mime_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Whether the first bytes are what `mime` says (a text file named `.png` is not a picture).
fn looks_like(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/svg+xml" => std::str::from_utf8(bytes).is_ok_and(|text| text.to_lowercase().contains("<svg")),
        _ => false,
    }
}

/// Whether an svg could run or load something. A plain drawing passes.
pub fn svg_is_unsafe(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes).to_lowercase();
    const BAD_TAGS: [&str; 9] = ["<script", "<foreignobject", "<iframe", "<embed", "<object", "<!doctype", "<!entity", "<audio", "<video"];
    if BAD_TAGS.iter().any(|tag| text.contains(tag)) {
        return true;
    }
    if text.contains("javascript:") || text.contains("vbscript:") || text.contains("data:text/html") {
        return true;
    }
    // An event handler: ` onload=`, ` onclick =` ...
    let raw = text.as_bytes();
    let mut at = 0;
    while let Some(found) = text[at..].find("on") {
        let start = at + found;
        at = start + 2;
        let after_gap = start > 0 && matches!(raw[start - 1], b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b'/');
        if !after_gap {
            continue;
        }
        let word_end = text[start..].find(|c: char| !c.is_ascii_alphabetic()).map_or(text.len(), |n| start + n);
        if word_end - start > 2 && text[word_end..].trim_start().starts_with('=') {
            return true;
        }
    }
    // A reference to something outside the file: a picture, a style or a link.
    for marker in ["href", "src"] {
        let mut from = 0;
        while let Some(found) = text[from..].find(marker) {
            let after = from + found + marker.len();
            from = after;
            let Some(rest) = text[after..].trim_start().strip_prefix('=') else { continue };
            let value = rest.trim_start().trim_start_matches(['"', '\'']);
            if !value.starts_with('#') && !value.starts_with("data:image/") {
                return true;
            }
        }
    }
    text.contains("url(http") || text.contains("url(\"http") || text.contains("url('http") || text.contains("@import")
}

/// `%20` and the like. `None` when the bytes are not valid UTF-8.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The path as a file system path: a `file:` address becomes its path; any other address (a web address, a `data:` URL,
/// `//host/share`, a Windows device path) is refused.
fn plain_path(text: &str) -> Result<String, Refused> {
    let text = text.trim();
    if text.is_empty() || text.contains('\0') {
        return Err(NOT_HERE);
    }
    let lower = text.to_lowercase();
    if lower.starts_with("file:") {
        let after = &text[5..];
        // `file://host/share/x.png` and `file:////host/share/x.png` name a network share: refused before anything is decoded or opened.
        if (after.starts_with("//") && !after.starts_with("///")) || after.starts_with("////") {
            return Err(NOT_HERE);
        }
        let rest = after.trim_start_matches('/');
        let decoded = percent_decode(rest).ok_or(NOT_HERE)?;
        // `file:%5C%5Chost%5Cshare%5Cx.png` decodes to a share by another spelling.
        if is_network_path(&decoded) {
            return Err(NOT_HERE);
        }
        // `file:///C:/x` is `C:/x`; on a system that has no drive letters the leading slash is put back.
        return Ok(if cfg!(windows) { decoded } else { format!("/{decoded}") });
    }
    let web = ["http:", "https:", "data:", "ftp:", "blob:", "javascript:", "//", "\\\\"];
    if web.iter().any(|prefix| lower.starts_with(prefix)) {
        return Err(NOT_HERE);
    }
    if is_network_path(text) {
        return Err(NOT_HERE);
    }
    Ok(text.to_string())
}

/// A network share or a Windows device path in either slash (two slashes or backslashes in a row, `\\?\`, `\\.\`), also after a
/// percent-decode.
fn is_network_path(text: &str) -> bool {
    let t = text.trim_start();
    let mut chars = t.chars();
    let (a, b) = (chars.next(), chars.next());
    let slash = |c: Option<char>| matches!(c, Some('/') | Some('\\'));
    (slash(a) && slash(b)) || percent_decode(t).is_some_and(|d| d != t && is_network_path(&d))
}

/// The path with `.` and `..` resolved by its words alone: no disk is touched.
fn lexical(path: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => {
                let word = other.as_os_str().to_string_lossy().replace('\\', "/");
                out.push(if cfg!(windows) { word.to_lowercase() } else { word });
            }
        }
    }
    out
}

/// Whether the path lies under one of the roots by its words alone (a root as given, and as the disk names it).
fn lexically_inside(path: &Path, roots: &[PathBuf]) -> bool {
    let target = lexical(path);
    roots.iter().flat_map(|root| [Some(root.clone()), std::fs::canonicalize(root).ok()]).flatten().any(|root| {
        let base = lexical(&root);
        !base.is_empty() && target.starts_with(&base)
    })
}

/// Reads the picture at `path_text` for a chat whose project folder is `cwd`, if it is inside one of `roots`.
pub fn read(path_text: &str, cwd: &str, roots: &[PathBuf], max_bytes: u64) -> Result<Picture, Refused> {
    let plain = plain_path(path_text)?;
    let given = PathBuf::from(&plain);
    let absolute = if given.is_absolute() { given } else { Path::new(cwd).join(given) };
    mime_of(&absolute).ok_or(BAD_TYPE)?;
    // First by words alone, before the disk is asked anything about the file: not under the project folder is not here.
    if !lexically_inside(&absolute, roots) {
        return Err(NOT_HERE);
    }
    // Through every link and `..`: what is left is where the file really is.
    let real = std::fs::canonicalize(&absolute).map_err(|_| NOT_HERE)?;
    let inside = roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).any(|root| real.starts_with(&root));
    if !inside {
        return Err(NOT_HERE);
    }
    // The name of the file it really is (a link called `a.png` that points at `secret.txt` is not a picture).
    let mime = mime_of(&real).ok_or(BAD_TYPE)?;
    let meta = std::fs::metadata(&real).map_err(|_| UNREADABLE)?;
    if !meta.is_file() {
        return Err(NOT_HERE);
    }
    if meta.len() > max_bytes {
        return Err(TOO_BIG);
    }
    let bytes = std::fs::read(&real).map_err(|_| UNREADABLE)?;
    if !looks_like(mime, &bytes) {
        return Err(BAD_TYPE);
    }
    if mime == "image/svg+xml" && svg_is_unsafe(&bytes) {
        return Err(UNSAFE);
    }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "picture".into());
    let data_url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    Ok(Picture { name, mime, size: bytes.len() as u64, data_url })
}

/// The refusal as a JSON body for a bridge route.
pub fn refusal_body(refused: &Refused) -> serde_json::Value {
    serde_json::json!({ "code": refused.code, "error": refused.message })
}

#[cfg(test)]
#[path = "picture_tests.rs"]
mod tests;
