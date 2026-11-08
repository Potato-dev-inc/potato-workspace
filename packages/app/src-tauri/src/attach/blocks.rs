//! What a message with attachments becomes on the wire: ACP content blocks
//! (https://agentclientprotocol.com/protocol/content). The text comes first, then one block per attachment.
//! An image goes in as an `image` block when the agent takes images, a text file as an embedded `resource` when it
//! takes embedded context; everything else (and anything that cannot be read) is a `resource_link`, which every
//! agent must accept.

use super::{AttachKind, ChatAttachment, FOLDER_MIME};
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;

/// `C:\a b\c.txt` becomes `file:///C:/a%20b/c.txt`, `/a/b` becomes `file:///a/b`, a share path
/// `\\host\share\x` becomes `file://host/share/x`.
pub fn file_uri(path: &str) -> String {
    let path = path.strip_prefix(r"\\?\UNC\").map(|rest| format!(r"\\{rest}")).unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_string());
    let slashed = path.replace('\\', "/");
    let (host, rest) = match slashed.strip_prefix("//") {
        Some(share) => {
            let (host, rest) = share.split_once('/').unwrap_or((share, ""));
            (host.to_string(), format!("/{rest}"))
        }
        None if slashed.starts_with('/') => (String::new(), slashed),
        None => (String::new(), format!("/{slashed}")),
    };
    let mut out = String::from("file://");
    out.push_str(&host);
    for byte in rest.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The reverse of `file_uri`: the path a `file:` URI names (a drive letter keeps its `C:/` form). `None` for
/// any other kind of URI.
pub fn path_of_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let mut bytes = Vec::with_capacity(path.len());
    let raw = path.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(v) = u8::from_str_radix(&path[i + 1..i + 3], 16) {
                bytes.push(v);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let decoded = String::from_utf8_lossy(&bytes).into_owned();
    // `/C:/x` is a Windows drive path.
    let b = decoded.as_bytes();
    let local = if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' { decoded[1..].to_string() } else { decoded };
    Some(if host.is_empty() || host == "localhost" { local } else { format!("//{host}{local}") })
}

fn link(attachment: &ChatAttachment) -> Value {
    let mut block = json!({
        "type": "resource_link",
        "uri": file_uri(&attachment.path),
        "name": attachment.name,
    });
    // A folder has no size; its `size` is a file count.
    if attachment.kind != AttachKind::Folder {
        block["size"] = json!(attachment.size);
    }
    if let Some(mime) = &attachment.mime {
        block["mimeType"] = json!(mime);
    }
    block
}

/// The block for one attachment. A file that cannot be read becomes a link: the agent may still open the path.
fn block(attachment: &ChatAttachment, image_prompts: bool, embedded_context: bool) -> Value {
    match attachment.kind {
        AttachKind::Image if image_prompts => match std::fs::read(Path::new(&attachment.path)) {
            Ok(bytes) => json!({
                "type": "image",
                "mimeType": attachment.mime.clone().unwrap_or_else(|| "image/png".into()),
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            Err(_) => link(attachment),
        },
        AttachKind::Text if embedded_context => match std::fs::read_to_string(Path::new(&attachment.path)) {
            Ok(text) => json!({
                "type": "resource",
                "resource": {
                    "uri": file_uri(&attachment.path),
                    "mimeType": attachment.mime.clone().unwrap_or_else(|| "text/plain".into()),
                    "text": text,
                },
            }),
            Err(_) => link(attachment),
        },
        _ => link(attachment),
    }
}

/// The prompt: the text block when the text is not empty, then one block per attachment.
pub fn prompt_blocks(text: &str, attachments: &[ChatAttachment], image_prompts: bool, embedded_context: bool) -> Vec<Value> {
    let mut out = Vec::with_capacity(attachments.len() + 1);
    if !text.is_empty() {
        out.push(json!({ "type": "text", "text": text }));
    }
    for a in attachments {
        // A folder is only a link; the line below it is for agents that ignore links.
        if a.kind == AttachKind::Folder {
            out.push(json!({ "type": "text", "text": format!("Folder: {}", a.path) }));
        }
        out.push(block(a, image_prompts, embedded_context));
    }
    out
}

/// The same message for a terminal agent, which only takes typed text: the attachments' paths follow the text.
pub fn text_with_paths(text: &str, attachments: &[ChatAttachment]) -> String {
    if attachments.is_empty() {
        return text.to_string();
    }
    // One line: a newline would submit the message in a terminal's input box.
    let notes: Vec<String> = attachments.iter().map(|a| format!("[attached: {}]", a.path)).collect();
    if text.is_empty() { notes.join(" ") } else { format!("{text} {}", notes.join(" ")) }
}

fn last_segment(path: &str) -> String {
    path.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or("file").to_string()
}

/// The attachment a replayed user content block stands for (an `image`, `resource` or `resource_link` block);
/// `None` for text and anything else. An image that came as bytes has no file: its path is empty.
pub fn attachment_of_block(block: &Value) -> Option<ChatAttachment> {
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    let kind_of = |mime: &Option<String>| match mime.as_deref() {
        Some(m) if m.starts_with("image/") => AttachKind::Image,
        Some(FOLDER_MIME) => AttachKind::Folder,
        Some(m) if m.starts_with("text/") => AttachKind::Text,
        _ => AttachKind::File,
    };
    match block.get("type").and_then(Value::as_str)? {
        "image" => {
            let mime = text(block, "mimeType");
            let path = text(block, "uri").map(|uri| path_of_uri(&uri).unwrap_or(uri)).unwrap_or_default();
            let size = block.get("data").and_then(Value::as_str).map_or(0, |d| (d.len() / 4 * 3) as u64);
            let name = if path.is_empty() { "image".to_string() } else { last_segment(&path) };
            Some(ChatAttachment { name, path, kind: AttachKind::Image, size, mime })
        }
        "resource_link" => {
            let uri = text(block, "uri")?;
            let path = path_of_uri(&uri).unwrap_or_else(|| uri.clone());
            let mime = text(block, "mimeType");
            Some(ChatAttachment {
                name: text(block, "name").unwrap_or_else(|| last_segment(&path)),
                path,
                kind: kind_of(&mime),
                size: block.get("size").and_then(Value::as_u64).unwrap_or(0),
                mime,
            })
        }
        "resource" => {
            let inner = block.get("resource")?;
            let uri = text(inner, "uri")?;
            let path = path_of_uri(&uri).unwrap_or_else(|| uri.clone());
            let mime = text(inner, "mimeType");
            let size = inner.get("text").and_then(Value::as_str).map_or(0, |t| t.len() as u64);
            Some(ChatAttachment { name: last_segment(&path), path, kind: kind_of(&mime), size, mime })
        }
        _ => None,
    }
}
