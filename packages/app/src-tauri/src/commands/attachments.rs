//! Files a person adds to a chat message. Text files are read and put in the message itself; images, PDFs and other
//! binary files are copied into the project (`.potato-workspace/attachments/`) so the agent can open them from a path
//! it is allowed to read. Nothing is uploaded.

use super::AppState;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Files bigger than this are never read as text: they are copied into the project instead.
pub const MAX_TEXT_BYTES: u64 = 64 * 1024;
/// The most text put inline for one file. The rest stays in the original file.
pub const MAX_INLINE_CHARS: usize = 4_000;
pub const ATTACHMENTS_DIR: &str = "attachments";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAttachment {
    pub name: String,
    /// Where the agent can read it: the original path for text, the project copy for everything else.
    pub path: String,
    /// `text` (contents are in `text`) or `file` (open the path).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub size: u64,
    /// The text was cut at `MAX_INLINE_CHARS`; the original holds the rest.
    pub truncated: bool,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
}

fn attachments_dir(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".potato-workspace").join(ATTACHMENTS_DIR)
}

fn copy_into_project(path: &Path, cwd: &str) -> Result<PathBuf, String> {
    let dir = attachments_dir(cwd);
    fs::create_dir_all(&dir).map_err(|e| format!("ATTACHMENT_COPY_FAILED: could not make the attachments folder: {e}"))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let name = file_name(path);
    let mut target = dir.join(format!("{stamp}-{name}"));
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!("{stamp}-{n}-{name}"));
        n += 1;
    }
    fs::copy(path, &target).map_err(|e| format!("ATTACHMENT_COPY_FAILED: could not copy {}: {e}", path.display()))?;
    Ok(target)
}

/// Reads one file: text goes inline (cut to `MAX_INLINE_CHARS`), anything else is copied into the project.
pub fn prepare_one(path: &Path, cwd: &str) -> Result<PreparedAttachment, String> {
    let meta = fs::metadata(path).map_err(|e| format!("ATTACHMENT_NOT_FOUND: {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("ATTACHMENT_NOT_A_FILE: {} is not a file.", path.display()));
    }
    let size = meta.len();
    if size <= MAX_TEXT_BYTES {
        if let Ok(bytes) = fs::read(path) {
            // A NUL byte means binary, even when the bytes happen to be valid UTF-8.
            if !bytes.contains(&0) {
                if let Ok(text) = String::from_utf8(bytes) {
                    let truncated = text.chars().count() > MAX_INLINE_CHARS;
                    let body: String = if truncated { text.chars().take(MAX_INLINE_CHARS).collect() } else { text };
                    return Ok(PreparedAttachment {
                        name: file_name(path),
                        path: path.display().to_string(),
                        kind: "text".into(),
                        text: Some(body),
                        size,
                        truncated,
                    });
                }
            }
        }
    }
    let placed = copy_into_project(path, cwd)?;
    Ok(PreparedAttachment {
        name: file_name(path),
        path: placed.display().to_string(),
        kind: "file".into(),
        text: None,
        size,
        truncated: false,
    })
}

/// Prepares the files a person picked for a pane's message. The pane's folder decides where copies go; without a
/// pane (an older window) the default project folder is used.
#[tauri::command]
pub async fn attachment_prepare(state: State<'_, AppState>, pane_id: String, paths: Vec<String>) -> Result<Vec<PreparedAttachment>, String> {
    let registry = state.registry.clone();
    let cwd = {
        let registry = registry.lock();
        registry.get(&pane_id).map(|pane| pane.info.cwd.clone()).unwrap_or_else(|| registry.project_path.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());
        for path in paths {
            out.push(prepare_one(Path::new(&path), &cwd)?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("INTERNAL: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("potato-attach-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_text_file_is_read_and_cut_when_it_is_long() {
        let dir = scratch("text");
        let file = dir.join("notes.md");
        fs::write(&file, "hello\n").unwrap();
        let got = prepare_one(&file, dir.to_str().unwrap()).unwrap();
        assert_eq!(got.kind, "text");
        assert_eq!(got.text.as_deref(), Some("hello\n"));
        assert!(!got.truncated);

        let long = dir.join("long.txt");
        fs::write(&long, "x".repeat(MAX_INLINE_CHARS + 10)).unwrap();
        let got = prepare_one(&long, dir.to_str().unwrap()).unwrap();
        assert!(got.truncated);
        assert_eq!(got.text.unwrap().chars().count(), MAX_INLINE_CHARS);
    }

    #[test]
    fn a_binary_file_is_copied_into_the_project() {
        let dir = scratch("binary");
        let file = dir.join("shot.png");
        fs::write(&file, [0u8, 1, 2, 3]).unwrap();
        let got = prepare_one(&file, dir.to_str().unwrap()).unwrap();
        assert_eq!(got.kind, "file");
        assert!(got.text.is_none());
        let copied = Path::new(&got.path);
        assert!(copied.exists());
        assert!(copied.starts_with(dir.join(".potato-workspace").join(ATTACHMENTS_DIR)));
        assert_eq!(fs::read(copied).unwrap(), [0u8, 1, 2, 3]);
    }

    #[test]
    fn a_missing_file_is_refused() {
        let dir = scratch("missing");
        let error = prepare_one(&dir.join("nope.txt"), dir.to_str().unwrap()).unwrap_err();
        assert!(error.starts_with("ATTACHMENT_NOT_FOUND"));
    }
}
