//! A picture the agent sends in its answer (an ACP `image` content block) becomes a Markdown picture line that the chat
//! draws (`![image](<path>)`), so it goes through the same checked read as any picture the agent names
//! (`session_chat::picture`): only a file inside the chat's folder is ever shown.
//!
//! - a block with a `file:` address names a file: the line points at it;
//! - a block that carries its bytes (`data`, base64) is saved once into the chat folder's attachments folder
//!   (`<folder>/.potato-workspace/attachments/agent-<hash>.<ext>`, the same name for the same picture) and the line
//!   points at that;
//! - anything else (a web address, an unknown type, too big, no folder to save into) stays the short mark `[image]`.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

impl super::AcpChat {
    /// Pictures this agent sends inline are saved under `folder` (the chat's own folder).
    pub(crate) fn set_image_folder(&self, folder: &Path) {
        self.mapper.lock().set_image_folder(folder);
    }
}

/// The biggest picture saved (the chat shows at most `picture::MAX_BYTES`).
pub const MAX_BYTES: usize = crate::session_chat::picture::MAX_BYTES as usize;

/// Where an agent's pictures are saved for a chat in `folder`.
pub fn folder_for(folder: &Path) -> PathBuf {
    folder.join(".potato-workspace").join(crate::attach::ATTACHMENTS_DIR)
}

fn extension_for(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim().to_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// The Markdown line for one `image` block, or `None` when the block is not a picture this chat can point at.
pub fn markdown_for(block: &Value, save_in: Option<&Path>) -> Option<String> {
    if block.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let path = match block.get("uri").and_then(Value::as_str).and_then(crate::attach::blocks::path_of_uri) {
        Some(path) => path,
        None => saved(block, save_in?)?,
    };
    // `<...>` keeps a path with spaces or brackets in one piece.
    Some(format!("![image](<{}>)", path.replace('\\', "/").replace('>', "%3E")))
}

fn saved(block: &Value, dir: &Path) -> Option<String> {
    let data = block.get("data").and_then(Value::as_str)?;
    let ext = extension_for(block.get("mimeType").and_then(Value::as_str)?)?;
    if data.len() > MAX_BYTES / 3 * 4 + 8 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let hash: String = Sha256::digest(&bytes).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let target = dir.join(format!("agent-{hash}.{ext}"));
    if !target.exists() {
        std::fs::create_dir_all(dir).ok()?;
        std::fs::write(&target, &bytes).ok()?;
    }
    Some(std::path::absolute(&target).unwrap_or(target).display().to_string())
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
