//! Files that cross the PC link (remote parity P4.3). A far PC never names a path of its own on this disk: it sends the BYTES of
//! a picture or file (`save_sent`, capped at `SENT_MAX_BYTES`), and any attachment a far message names must lie inside the chat's
//! own project folder (`vouch`, `prepare_inside`). Everything about the file but its bytes is re-read from the disk here, never
//! taken from the sender (its name, size, kind and type are untrusted text).

use super::*;

/// The most bytes of one file that may cross the link. The text that carries it is 4/3 of this.
pub const SENT_MAX_BYTES: usize = MAX_PASTED_BYTES;

/// A local file as the far side takes it: what `save_sent` wants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}

fn other_ext_ok(ext: &str) -> bool {
    !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// The extension a sent file keeps: the one on its name, else its picture type's, else `bin`.
fn sent_extension(name: &str, mime: &str) -> String {
    let own = extension(Path::new(name));
    if other_ext_ok(&own) {
        own
    } else {
        pasted_extension(mime).unwrap_or_else(|| "bin".into())
    }
}

/// Reads a file of THIS PC for sending to another PC. Files only, at most `SENT_MAX_BYTES`.
pub fn read_local(path: &Path) -> Result<LocalFile, String> {
    let meta = fs::metadata(path).map_err(|e| format!("ATTACHMENT_NOT_FOUND: {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err("ATTACHMENT_FOLDER: A folder on this PC cannot be sent to another PC. Attach files one by one.".into());
    }
    if !meta.is_file() {
        return Err(format!("ATTACHMENT_NOT_A_FILE: {} is not a file.", path.display()));
    }
    if meta.len() > SENT_MAX_BYTES as u64 {
        return Err("ATTACHMENT_TOO_BIG: That file is bigger than 20 MB.".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("ATTACHMENT_NOT_FOUND: {}: {e}", path.display()))?;
    let mime = image_mime(path).or_else(|| other_mime(path)).unwrap_or("application/octet-stream");
    Ok(LocalFile { name: file_name(path), mime: mime.into(), data_base64: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// Saves the bytes another PC sent into this chat's project (`.potato-workspace/attachments/`), like a pasted picture but for any file.
/// The name is cleaned and the type is read from the extension: what the sender says about the type is not kept.
pub fn save_sent(cwd: &str, name: &str, mime: &str, data_base64: &str) -> Result<ChatAttachment, String> {
    if data_base64.len() > SENT_MAX_BYTES / 3 * 4 + 8 {
        return Err("ATTACHMENT_TOO_BIG: That file is bigger than 20 MB.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.trim()).map_err(|_| "ATTACHMENT_BAD_DATA: The file could not be read.".to_string())?;
    if bytes.is_empty() {
        return Err("ATTACHMENT_BAD_DATA: The file is empty.".into());
    }
    if bytes.len() > SENT_MAX_BYTES {
        return Err("ATTACHMENT_TOO_BIG: That file is bigger than 20 MB.".into());
    }
    let shown = format!("{}.{}", safe_stem(name), sent_extension(name, mime));
    let (target, mut file) = new_file_in_project(cwd, &shown)?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|e| format!("ATTACHMENT_COPY_FAILED: could not save the file: {e}"))?;
    let image = image_mime(&target);
    Ok(ChatAttachment {
        name: shown,
        path: plain(&target),
        kind: if image.is_some() { AttachKind::Image } else { AttachKind::File },
        size: bytes.len() as u64,
        mime: image.or_else(|| other_mime(&target)).map(str::to_string),
    })
}

/// A path without the `\\?\` that `canonicalize` puts on Windows (the agent and the chips show the plain one).
fn plain(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text)
}

/// The canonical form of `path` when it lies inside `cwd`; otherwise the refusal. `..`, links and a different drive all end up outside.
fn inside(path: &str, cwd: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(cwd).map_err(|_| "ATTACHMENT_OUTSIDE: This chat has no project folder to attach from.".to_string())?;
    let found = fs::canonicalize(path).map_err(|_| format!("ATTACHMENT_NOT_FOUND: {path} is not there."))?;
    if found.starts_with(&root) {
        Ok(found)
    } else {
        Err("ATTACHMENT_OUTSIDE: Only files inside the chat's project can be attached from that PC.".into())
    }
}

/// Describes what a far message names, from the disk: the file must lie inside `cwd`; its name, size, kind and type are read here.
pub fn vouch(wanted: &ChatAttachment, cwd: &str) -> Result<ChatAttachment, String> {
    let path = inside(&wanted.path, cwd)?;
    let meta = fs::metadata(&path).map_err(|e| format!("ATTACHMENT_NOT_FOUND: {e}"))?;
    let name = file_name(&path);
    if meta.is_dir() {
        return Ok(ChatAttachment { name, path: plain(&path), kind: AttachKind::Folder, size: count_files(&path), mime: Some(FOLDER_MIME.into()) });
    }
    let size = meta.len();
    let (kind, mime) = if let Some(image) = image_mime(&path) {
        (AttachKind::Image, Some(image))
    } else if is_text(&path, size) {
        (AttachKind::Text, Some("text/plain"))
    } else {
        (AttachKind::File, other_mime(&path))
    };
    Ok(ChatAttachment { name, path: plain(&path), kind, size, mime: mime.map(str::to_string) })
}

/// A thumbnail (`attach::preview`) of a picture that another PC named: it must lie inside `cwd`. `None` for a file that is not a picture or is too big.
pub fn preview_inside(path: &str, cwd: &str) -> Result<Option<String>, String> {
    Ok(super::preview(&inside(path, cwd)?))
}

/// `prepare_one` for paths that another PC named: each must lie inside `cwd` (a path on the asker's own disk means nothing here).
pub fn prepare_inside(paths: &[String], cwd: &str) -> Result<Vec<ChatAttachment>, String> {
    if paths.len() > MAX_ATTACHMENTS {
        return Err(format!("ATTACHMENT_TOO_MANY: at most {MAX_ATTACHMENTS} files go with one message."));
    }
    paths.iter().map(|p| prepare_one(&inside(p, cwd)?, cwd)).collect()
}
