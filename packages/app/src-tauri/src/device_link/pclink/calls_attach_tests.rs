//! P4.3 rows (`calls_attach.rs`): their levels, that a Watch or Answer PC reaches nothing, that no row is refused, the door's own cap for
//! the one call that carries a file, and what a message may name (inside the chat's project only).

use serde_json::{json, Value};

use super::calls_attach::{audit_detail, mine, vouch_all};
use super::tests::Fake;
use super::*;
use crate::attach::{AttachKind, ChatAttachment};

fn ours() -> Vec<(&'static str, Level, bool)> {
    let source = include_str!("../../../crates/pm-core/src/device_link/pclink/calls.rs");
    let from = source.find("    // ---- P4b attach and start ----").expect("the P4b marker");
    let names: Vec<&str> = source[from..].lines().skip(1).take_while(|l| !l.trim_start().starts_with("// ---- ")).filter_map(|l| l.trim_start().strip_prefix("(\"")?.split('"').next()).collect();
    names.iter().map(|n| calls::TABLE.iter().find(|r| r.0 == *n).map(|(c, l, p)| (*c, *l, *p)).expect("a row")).collect()
}

fn post(level: Option<Level>, fake: &Fake, cmd: &str, body: &Value) -> (u16, Value) {
    let who = Caller { node: "aa", name: "Laptop", level, now_ms: 1_000, marked: false };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap())
}

#[test]
fn the_block_is_these_rows_at_full_and_nothing_here_is_refused() {
    assert_eq!(ours(), vec![("attachment_prepare", Level::Full, true), ("attachment_save_pasted", Level::Full, true), ("acp_chat_start", Level::Full, false)]);
    for (cmd, _, _) in ours() {
        assert!(mine(cmd) && !calls::refused(cmd), "{cmd}");
    }
    assert!(!mine("attachment_read_local") && !mine("clipboard_file_paths"), "the commands that read a path of the window's own PC are not rows");
}

#[test]
fn only_full_reaches_the_rows_and_a_pc_that_is_off_reaches_nothing() {
    let body = json!({ "paneId": "p1", "paths": [], "name": "a.png", "mime": "image/png", "dataBase64": "AAAA", "agentId": "claude", "folder": "p1", "separateCopy": true });
    for (cmd, _, _) in ours() {
        for level in [Level::Watch, Level::Answer] {
            let fake = Fake::default();
            let (status, answer) = post(Some(level), &fake, cmd, &body);
            assert_eq!((status, answer["code"].as_str(), answer["needs"].as_str()), (403, Some("DEVICE_NOT_ALLOWED"), Some("full")), "{level:?} {cmd}");
            assert!(fake.calls().is_empty(), "{level:?} {cmd} reached nothing");
        }
        let fake = Fake::default();
        assert_eq!(post(None, &fake, cmd, &body).1["code"], "REMOTE_OFF", "{cmd}");
        let fake = Fake::default();
        assert_eq!(post(Some(Level::Full), &fake, cmd, &body).0, 200, "{cmd}");
        assert_eq!(fake.calls().len(), 1, "{cmd}");
    }
}

#[test]
fn a_file_may_be_as_big_as_the_door_says_and_every_other_call_keeps_the_small_cap() {
    use crate::device_link::wire::{body_max, ATTACH_BODY_MAX, BODY_MAX};
    // 20 MB of file is 26.7 MB of text: it must fit the one call that carries it.
    assert!(ATTACH_BODY_MAX > crate::attach::far::SENT_MAX_BYTES / 3 * 4 + 1024);
    assert_eq!(body_max("POST", "/pclink/call/attachment_save_pasted"), ATTACH_BODY_MAX);
    for (method, target) in [("POST", "/pclink/call/attachment_prepare"), ("POST", "/pclink/call/pane_message_send"), ("GET", "/pclink/call/attachment_save_pasted"), ("POST", "/pclink/call/attachment_save_pasted2"), ("POST", "/pclink/sessions/p1/messages")] {
        assert_eq!(body_max(method, target), BODY_MAX, "{method} {target}");
    }
}

fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("potato-p4b-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn wants(path: &std::path::Path) -> ChatAttachment {
    // What the sender says about the file is a lie on purpose: the name, the size and the kind must be read from the disk.
    ChatAttachment { name: "../../evil.exe".into(), path: path.display().to_string(), kind: AttachKind::Image, size: 1, mime: Some("image/png".into()) }
}

#[test]
fn a_message_may_name_only_files_inside_the_chats_project_and_they_are_described_from_the_disk() {
    let project = scratch("msg");
    let outside = scratch("outside");
    std::fs::write(project.join("notes.md"), "hello\n").unwrap();
    std::fs::write(outside.join("secret.txt"), "key").unwrap();
    let cwd = project.to_str().unwrap();

    let done = vouch_all(&[wants(&project.join("notes.md"))], cwd).unwrap();
    assert_eq!((done[0].name.as_str(), done[0].kind, done[0].size), ("notes.md", AttachKind::Text, 6));
    // A file next to the project, and one reached with `..`, are outside.
    assert!(vouch_all(&[wants(&outside.join("secret.txt"))], cwd).unwrap_err().starts_with("ATTACHMENT_OUTSIDE"));
    let dotdot = project.join("..").join(outside.file_name().unwrap()).join("secret.txt");
    assert!(vouch_all(&[wants(&dotdot)], cwd).unwrap_err().starts_with("ATTACHMENT_OUTSIDE"));
    // A path that is not there, and one more file than a message takes.
    assert!(vouch_all(&[wants(&project.join("nope.txt"))], cwd).unwrap_err().starts_with("ATTACHMENT_NOT_FOUND"));
    let many = vec![wants(&project.join("notes.md")); crate::attach::MAX_ATTACHMENTS + 1];
    assert!(vouch_all(&many, cwd).unwrap_err().starts_with("ATTACHMENT_TOO_MANY"));
    // A chat whose folder is gone attaches nothing.
    assert!(vouch_all(&[wants(&project.join("notes.md"))], "Z:/no/such/folder").is_err());
    let _ = std::fs::remove_dir_all(&project);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn a_folder_inside_the_project_goes_by_its_path() {
    let project = scratch("dir");
    std::fs::create_dir_all(project.join("docs")).unwrap();
    std::fs::write(project.join("docs").join("a.txt"), "a").unwrap();
    let got = vouch_all(&[wants(&project.join("docs"))], project.to_str().unwrap()).unwrap();
    assert_eq!((got[0].kind, got[0].size, got[0].name.as_str()), (AttachKind::Folder, 1, "docs"));
    let _ = std::fs::remove_dir_all(&project);
}

#[test]
fn an_audit_line_holds_a_count_and_ids_and_nothing_a_person_wrote() {
    let detail = audit_detail("attach.save", Some("p1"), 1);
    assert_eq!(detail, json!({ "event": "attach.save", "pane_id": "p1", "count": 1 }));
}

#[test]
fn a_thumbnail_is_made_only_inside_the_chats_project() {
    use crate::attach::far::preview_inside;
    let project = scratch("thumb");
    let outside = scratch("thumb-out");
    let png: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    std::fs::write(project.join("a.png"), png).unwrap();
    std::fs::write(project.join("notes.txt"), "hi").unwrap();
    std::fs::write(outside.join("b.png"), png).unwrap();
    let cwd = project.to_str().unwrap();
    let url = preview_inside(project.join("a.png").to_str().unwrap(), cwd).unwrap();
    assert!(url.is_some_and(|u| u.starts_with("data:image/png;base64,")));
    assert_eq!(preview_inside(project.join("notes.txt").to_str().unwrap(), cwd).unwrap(), None, "a file that is not a picture has no thumbnail");
    let refused = preview_inside(outside.join("b.png").to_str().unwrap(), cwd).unwrap_err();
    assert!(refused.starts_with("ATTACHMENT_OUTSIDE"), "{refused}");
    let _ = std::fs::remove_dir_all(&project);
    let _ = std::fs::remove_dir_all(&outside);
}
