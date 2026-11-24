use super::*;
use serde_json::json;

fn png_base64() -> String {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.extend_from_slice(&[7u8; 16]);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("pm-acp-images-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_picture_with_bytes_is_saved_in_the_chat_folder_once_and_the_line_points_at_it() {
    let folder = dir();
    let block = json!({ "type": "image", "data": png_base64(), "mimeType": "image/png" });
    let line = markdown_for(&block, Some(&folder_for(&folder))).unwrap();
    assert!(line.starts_with("![image](<") && line.ends_with(".png>)"), "{line}");
    let again = markdown_for(&block, Some(&folder_for(&folder))).unwrap();
    assert_eq!(line, again, "the same picture is the same file");
    assert_eq!(std::fs::read_dir(folder_for(&folder)).unwrap().count(), 1);
    // And the checked read of the chat accepts it: it is inside the chat's folder.
    let path = line.trim_start_matches("![image](<").trim_end_matches(">)");
    let cwd = folder.to_string_lossy();
    let shown = crate::session_chat::picture::read(path, &cwd, &[folder.clone()], crate::session_chat::picture::MAX_BYTES).unwrap();
    assert_eq!(shown.mime, "image/png");
}

#[test]
fn a_file_address_is_pointed_at_and_anything_else_stays_a_short_mark() {
    let block = json!({ "type": "image", "data": "", "mimeType": "image/png", "uri": "file:///C:/work/a%20b/chart.png" });
    let line = markdown_for(&block, None).unwrap();
    assert!(line.contains("a b/chart.png"), "{line}");
    // No folder to save into, a web address, an unknown type and a text block: no picture line.
    assert_eq!(markdown_for(&json!({ "type": "image", "data": png_base64(), "mimeType": "image/png" }), None), None);
    assert_eq!(markdown_for(&json!({ "type": "image", "uri": "https://example.com/a.png" }), None), None);
    assert_eq!(markdown_for(&json!({ "type": "image", "data": png_base64(), "mimeType": "text/html" }), Some(&dir())), None);
    assert_eq!(markdown_for(&json!({ "type": "text", "text": "hi" }), None), None);
}

#[test]
fn a_huge_or_broken_picture_is_not_saved() {
    let folder = dir();
    let huge = "A".repeat(MAX_BYTES / 3 * 4 + 100);
    assert_eq!(markdown_for(&json!({ "type": "image", "data": huge, "mimeType": "image/png" }), Some(&folder)), None);
    assert_eq!(markdown_for(&json!({ "type": "image", "data": "!!!not base64", "mimeType": "image/png" }), Some(&folder)), None);
    assert!(!folder.join("agent-x.png").exists());
}

#[test]
fn an_image_block_in_an_answer_becomes_a_picture_line_in_its_own_paragraph() {
    use crate::acp::session::SessionEvent;
    use crate::acp::types::{ContentChunk, SessionUpdate};
    use crate::session_chat::ChatItem;
    let folder = dir();
    let mut mapper = super::super::mapper::Mapper::new();
    mapper.set_image_folder(&folder);
    let now = std::time::Instant::now();
    let say = |mapper: &mut super::super::mapper::Mapper, content: serde_json::Value| {
        let event = SessionEvent::Update { update: Box::new(SessionUpdate::AgentMessageChunk(ContentChunk { content, message_id: None })), replay: false };
        mapper.on_event(&event, now, "t")
    };
    say(&mut mapper, json!({ "type": "text", "text": "Here is the chart:" }));
    let items = say(&mut mapper, json!({ "type": "image", "data": png_base64(), "mimeType": "image/png" }));
    let text = items.iter().find_map(|i| match i { ChatItem::Assistant { text, .. } => Some(text.clone()), _ => None }).expect("an assistant item");
    assert!(text.contains("Here is the chart:\n\n![image](<"), "{text}");
    let after = say(&mut mapper, json!({ "type": "text", "text": "Done." }));
    let text = after.iter().find_map(|i| match i { ChatItem::Assistant { text, .. } => Some(text.clone()), _ => None }).unwrap();
    assert!(text.contains(">)\n\nDone."), "{text}");
}
