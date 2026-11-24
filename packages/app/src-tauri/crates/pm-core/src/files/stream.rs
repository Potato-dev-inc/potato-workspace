//! Big Word, Excel and PDF files travel to the viewer as a stream, not as one base64 text through the command
//! channel. The `pmfile` protocol (see `commands/files_stream.rs`) answers the viewer's request with the bytes of one
//! file of the project, whole or the part a `Range` header asks for (the PDF viewer of the web view asks for parts).
//! Everything here is plain functions, so the path check, the range rules and the limits are tested without a window.
//!
//! The same path check as every other file call (`resolve_in_root`): no `..`, no absolute path elsewhere, no link
//! that leads out. On top of it only document kinds are served, so the protocol is not a general file reader.

use super::{rel_of, resolve_in_root};
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};

/// A Word, Excel or PDF file bigger than this is not opened in a tab. It is a stream, so only memory sets the limit.
pub const MAX_STREAM_BYTES: u64 = 500 * 1024 * 1024;
/// One answer to an open-ended `Range` (`bytes=100-`) is cut to this size (a 206 answer may be shorter).
pub const CHUNK_CAP: u64 = 64 * 1024 * 1024;
/// The kinds of file the protocol serves.
const STREAMABLE: &[&str] = &["docx", "pdf", "xlsx", "xlsm", "xls", "csv"];

/// What `files_open_bytes` tells the viewer about a file (the bytes come later, through the protocol).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStreamInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// `stream`, or `too_large` (the viewer then offers "Open in Word" and "Show in folder").
    pub kind: String,
    pub limit: u64,
}

/// An answer for the protocol: status, headers and body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamReply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl StreamReply {
    fn error(status: u16, text: &str, origin: Option<&str>) -> Self {
        let mut headers = vec![("Content-Type", "text/plain; charset=utf-8".to_string())];
        cors(&mut headers, origin);
        Self { status, headers, body: text.as_bytes().to_vec() }
    }

    /// The value of a header, for tests.
    #[cfg(test)]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" | "xlsm" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "csv" => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Only the app's own pages may read the answer: its window, and the dev server. A page in a sandboxed frame has the
/// origin `null`, which is never echoed.
fn origin_allowed(origin: &str) -> bool {
    matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" | "http://localhost:1442" | "http://127.0.0.1:1442")
}

fn cors(headers: &mut Vec<(&'static str, String)>, origin: Option<&str>) {
    headers.push(("Vary", "Origin".to_string()));
    if let Some(origin) = origin.filter(|o| origin_allowed(o)) {
        headers.push(("Access-Control-Allow-Origin", origin.to_string()));
        headers.push(("Access-Control-Allow-Headers", "Range".to_string()));
        headers.push(("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges".to_string()));
    }
}

/// `%41` and friends back to text. A bad escape keeps its `%`.
fn percent_decode(text: &str) -> String {
    let raw = text.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(hex) = std::str::from_utf8(&raw[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The request path (`/<pane id>%2F<path in the project>`, as `convertFileSrc` writes it) as (pane id, path).
pub fn split_request_path(uri_path: &str) -> Option<(String, String)> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'));
    let (pane, rel) = decoded.split_once('/')?;
    if pane.is_empty() || rel.is_empty() {
        return None;
    }
    Some((pane.to_string(), rel.to_string()))
}

/// One `Range: bytes=a-b` header against a file of `len` bytes: `Ok(None)` for no usable header, `Ok(Some((first,
/// last)))` inclusive, `Err(())` when it cannot be met (416). Several ranges are not served: the whole file answers.
fn parse_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else { return Ok(None) };
    let Some(spec) = header.trim().strip_prefix("bytes=") else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((a, b)) = spec.split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Err(());
    }
    if a.is_empty() {
        // The last `n` bytes.
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        return Ok(Some((len.saturating_sub(n), len - 1)));
    }
    let first: u64 = a.parse().map_err(|_| ())?;
    if first >= len {
        return Err(());
    }
    let last = if b.is_empty() { (len - 1).min(first + CHUNK_CAP - 1) } else { b.parse::<u64>().map_err(|_| ())?.min(len - 1) };
    if last < first {
        return Err(());
    }
    Ok(Some((first, last.min(first + CHUNK_CAP - 1))))
}

/// Tells the viewer about a file before it asks for the bytes: its size and whether it can be opened.
pub fn open_info(root: &str, rel: &str) -> Result<FileStreamInfo, String> {
    let (canon_root, file) = resolve_in_root(root, rel)?;
    if super::is_office_lock(rel) {
        return Err("FILES_NOT_OPENABLE: That is a temporary file made by Word or Excel while a document is open. It is not a document.".to_string());
    }
    let meta = fs::metadata(&file).map_err(|e| format!("FILES_IO: Could not open the file: {e}."))?;
    if !meta.is_file() {
        return Err("FILES_NOT_FILE: That is not a file.".to_string());
    }
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let kind = if meta.len() > MAX_STREAM_BYTES { "too_large" } else { "stream" };
    Ok(FileStreamInfo { path: rel_of(&canon_root, &file), name, size: meta.len(), kind: kind.into(), limit: MAX_STREAM_BYTES })
}

/// The answer to one request of the `pmfile` protocol.
pub fn serve(root: &str, rel: &str, range: Option<&str>, origin: Option<&str>) -> StreamReply {
    let (_, file) = match resolve_in_root(root, rel) {
        Ok(found) => found,
        Err(e) if e.starts_with("FILES_OUTSIDE") => return StreamReply::error(403, &e, origin),
        Err(e) => return StreamReply::error(404, &e, origin),
    };
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if super::is_office_lock(&name) {
        return StreamReply::error(403, "FILES_NOT_OPENABLE: That is a temporary file made by Word or Excel. It is not a document.", origin);
    }
    let ext = extension(&name);
    if !STREAMABLE.contains(&ext.as_str()) {
        return StreamReply::error(403, "FILES_KIND: This kind of file is not served here.", origin);
    }
    let Ok(mut handle) = fs::File::open(&file) else { return StreamReply::error(404, "FILES_NOT_FOUND: That file is not there any more.", origin) };
    let len = handle.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_STREAM_BYTES {
        return StreamReply::error(413, "FILES_TOO_LARGE: This file is too big to open here.", origin);
    }
    let mut headers = vec![
        ("Content-Type", mime_of(&ext).to_string()),
        ("Accept-Ranges", "bytes".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Content-Disposition", "inline".to_string()),
        ("Cache-Control", "no-store".to_string()),
    ];
    cors(&mut headers, origin);
    let (status, first, last) = match parse_range(range, len) {
        Ok(None) => (200, 0, len.saturating_sub(1)),
        Ok(Some((a, b))) => (206, a, b),
        Err(()) => {
            headers.push(("Content-Range", format!("bytes */{len}")));
            return StreamReply { status: 416, headers, body: Vec::new() };
        }
    };
    let count = if len == 0 { 0 } else { last - first + 1 };
    let mut body = vec![0u8; count as usize];
    if count > 0 {
        let read = handle.seek(SeekFrom::Start(first)).and_then(|_| handle.read_exact(&mut body));
        if read.is_err() {
            return StreamReply::error(500, "FILES_IO: Could not read the file.", origin);
        }
    }
    if status == 206 {
        headers.push(("Content-Range", format!("bytes {first}-{last}/{len}")));
    }
    headers.push(("Content-Length", count.to_string()));
    StreamReply { status, headers, body }
}

/// The answer to the browser's CORS question before a request with a `Range` header.
pub fn preflight(origin: Option<&str>) -> StreamReply {
    let mut headers = Vec::new();
    cors(&mut headers, origin);
    headers.push(("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS".to_string()));
    StreamReply { status: 204, headers, body: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("potato-stream-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }
    const APP: Option<&str> = Some("http://tauri.localhost");

    #[test]
    fn a_whole_file_and_a_part_of_it_are_served() {
        let dir = scratch("range");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        fs::write(dir.join("a.docx"), &bytes).unwrap();
        let whole = serve(s(&dir), "a.docx", None, APP);
        assert_eq!((whole.status, whole.body.len()), (200, 5000));
        assert_eq!(whole.header("accept-ranges"), Some("bytes"));
        assert_eq!(whole.header("access-control-allow-origin"), APP);
        let part = serve(s(&dir), "a.docx", Some("bytes=100-199"), APP);
        assert_eq!(part.status, 206);
        assert_eq!(part.body, bytes[100..200]);
        assert_eq!(part.header("content-range"), Some("bytes 100-199/5000"));
        let open_end = serve(s(&dir), "a.docx", Some("bytes=4990-"), APP);
        assert_eq!(open_end.body, bytes[4990..]);
        let tail = serve(s(&dir), "a.docx", Some("bytes=-10"), APP);
        assert_eq!(tail.body, bytes[4990..]);
        let beyond = serve(s(&dir), "a.docx", Some("bytes=9000-"), APP);
        assert_eq!(beyond.status, 416);
        assert_eq!(beyond.header("content-range"), Some("bytes */5000"));
    }

    #[test]
    fn a_path_that_leaves_the_project_is_refused() {
        let dir = scratch("escape");
        let other = scratch("escape-other");
        fs::write(other.join("secret.docx"), "secret").unwrap();
        fs::write(dir.join("ok.docx"), "fine").unwrap();
        assert_eq!(serve(s(&dir), "../potato-stream-escape-other-x/secret.docx", None, APP).status, 403);
        assert_eq!(serve(s(&dir), "a/../../secret.docx", None, APP).status, 403);
        assert_eq!(serve(s(&dir), s(&other.join("secret.docx")), None, APP).status, 403);
        // The same attempts as a viewer would send them: one percent-encoded request path.
        let (pane, rel) = split_request_path("/pane-1%2F..%2F..%2Fsecret.docx").unwrap();
        assert_eq!(pane, "pane-1");
        assert_eq!(serve(s(&dir), &rel, None, APP).status, 403);
        let (_, rel) = split_request_path("/pane-1/%2e%2e/secret.docx").unwrap();
        assert_eq!(serve(s(&dir), &rel, None, APP).status, 403);
        assert_eq!(serve(s(&dir), "ok.docx", None, APP).status, 200);
    }

    #[test]
    fn a_link_that_leads_out_is_refused() {
        let dir = scratch("link");
        let other = scratch("link-other");
        fs::write(other.join("secret.pdf"), "secret").unwrap();
        #[cfg(windows)]
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J", s(&dir.join("out")), s(&other)]).output().map(|o| o.status.success()).unwrap_or(false);
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&other, dir.join("out")).is_ok();
        if !made {
            return; // No permission to make a link here: nothing to test.
        }
        assert_eq!(serve(s(&dir), "out/secret.pdf", None, APP).status, 403);
    }

    #[test]
    fn only_document_kinds_are_served() {
        let dir = scratch("kind");
        fs::write(dir.join("notes.txt"), "x").unwrap();
        fs::write(dir.join(".env"), "KEY=1").unwrap();
        fs::write(dir.join("main.rs"), "fn main(){}").unwrap();
        for name in ["notes.txt", ".env", "main.rs"] {
            assert_eq!(serve(s(&dir), name, None, APP).status, 403, "{name}");
        }
        assert_eq!(serve(s(&dir), "missing.pdf", None, APP).status, 404);
    }

    #[test]
    fn only_the_apps_own_pages_may_read_the_answer() {
        let dir = scratch("cors");
        fs::write(dir.join("a.pdf"), "%PDF-1.4").unwrap();
        for origin in [Some("null"), Some("https://evil.example"), None] {
            let reply = serve(s(&dir), "a.pdf", None, origin);
            assert_eq!(reply.status, 200);
            assert_eq!(reply.header("access-control-allow-origin"), None, "{origin:?}");
        }
        assert_eq!(preflight(APP).header("access-control-allow-headers"), Some("Range"));
    }

    #[test]
    fn a_file_over_15_mb_opens_and_only_a_huge_one_is_too_large() {
        let dir = scratch("size");
        let file = fs::File::create(dir.join("big.docx")).unwrap();
        file.set_len(70 * 1024 * 1024).unwrap();
        let info = open_info(s(&dir), "big.docx").unwrap();
        assert_eq!((info.kind.as_str(), info.size, info.limit), ("stream", 70 * 1024 * 1024, MAX_STREAM_BYTES));
        // An open-ended range is cut to one chunk.
        let chunk = serve(s(&dir), "big.docx", Some("bytes=0-"), APP);
        assert_eq!((chunk.status, chunk.body.len() as u64), (206, CHUNK_CAP));
        let huge = fs::File::create(dir.join("huge.pdf")).unwrap();
        huge.set_len(MAX_STREAM_BYTES + 1).unwrap();
        assert_eq!(open_info(s(&dir), "huge.pdf").unwrap().kind, "too_large");
        assert_eq!(serve(s(&dir), "huge.pdf", None, APP).status, 413);
    }

    #[test]
    fn request_paths_are_split_and_decoded() {
        assert_eq!(split_request_path("/p1%2Fdocs%2Fmy%20report.docx"), Some(("p1".into(), "docs/my report.docx".into())));
        assert_eq!(split_request_path("/p1/a.pdf"), Some(("p1".into(), "a.pdf".into())));
        assert_eq!(split_request_path("/p1"), None);
        assert_eq!(split_request_path("/"), None);
        assert_eq!(split_request_path("/p1%2F%E6%9C%88.docx"), Some(("p1".into(), "月.docx".into())));
    }
}
