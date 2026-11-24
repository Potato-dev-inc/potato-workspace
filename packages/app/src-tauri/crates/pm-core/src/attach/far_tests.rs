//! Files that cross the PC link (P4.3): what is kept of a sent file, the caps, and the inside-the-project rule.

use super::*;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("potato-far-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn cwd(dir: &Path) -> &str {
    dir.to_str().unwrap()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn a_sent_picture_lands_in_the_project_with_a_clean_name_and_a_type_read_from_its_extension() {
    let dir = scratch("sent");
    // The name tries to leave the folder and the type is a lie: only a clean stem, the extension and an honest type are kept.
    let got = far::save_sent(cwd(&dir), "../../etc/Pasted image 1.png", "text/html", &b64(b"\x89PNG-fake")).unwrap();
    assert_eq!((got.kind, got.mime.as_deref(), got.size), (AttachKind::Image, Some("image/png"), 9));
    assert!(got.name.ends_with(".png") && !got.name.contains('/') && !got.name.contains(".."), "{}", got.name);
    let saved = Path::new(&got.path);
    assert!(saved.canonicalize().unwrap().starts_with(dir.canonicalize().unwrap().join(".potato-workspace").join("attachments")), "{}", got.path);
    assert_eq!(fs::read(saved).unwrap(), b"\x89PNG-fake");
    // Any other file keeps its (clean) extension; a name with none becomes `.bin`; the type is never the sender's.
    let pdf = far::save_sent(cwd(&dir), "report.pdf", "application/x-evil", &b64(b"x")).unwrap();
    assert_eq!((pdf.kind, pdf.mime.as_deref()), (AttachKind::File, Some("application/pdf")));
    let bare = far::save_sent(cwd(&dir), "noext", "", &b64(b"x")).unwrap();
    assert!(bare.name.ends_with(".bin"), "{}", bare.name);
    let odd = far::save_sent(cwd(&dir), "x.ex e/../", "", &b64(b"x")).unwrap();
    assert!(!odd.name.contains('/') && !odd.name.contains(' '), "{}", odd.name);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_sent_file_over_20_mb_or_empty_or_not_base64_is_refused_and_nothing_is_written() {
    let dir = scratch("sent-bad");
    let big = "A".repeat(far::SENT_MAX_BYTES / 3 * 4 + 100);
    assert!(far::save_sent(cwd(&dir), "a.png", "image/png", &big).unwrap_err().starts_with("ATTACHMENT_TOO_BIG"));
    // Just over the byte cap once decoded (the text itself is within the text cap).
    assert!(far::save_sent(cwd(&dir), "a.bin", "", &b64(&vec![1u8; far::SENT_MAX_BYTES + 1])).unwrap_err().starts_with("ATTACHMENT_TOO_BIG"));
    assert!(far::save_sent(cwd(&dir), "a.png", "image/png", "").unwrap_err().starts_with("ATTACHMENT_BAD_DATA"));
    assert!(far::save_sent(cwd(&dir), "a.png", "image/png", "!!!not base64").unwrap_err().starts_with("ATTACHMENT_BAD_DATA"));
    assert!(!dir.join(".potato-workspace").exists(), "a refused file leaves no folder or file behind");
    // Exactly the cap is fine.
    assert_eq!(far::save_sent(cwd(&dir), "a.bin", "", &b64(&vec![1u8; far::SENT_MAX_BYTES])).unwrap().size, far::SENT_MAX_BYTES as u64);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_local_file_is_read_for_sending_but_a_folder_or_a_huge_file_is_not() {
    let dir = scratch("read-local");
    let file = dir.join("shot.png");
    fs::write(&file, b"abc").unwrap();
    let got = far::read_local(&file).unwrap();
    assert_eq!((got.name.as_str(), got.mime.as_str(), got.data_base64.as_str()), ("shot.png", "image/png", "YWJj"));
    assert!(far::read_local(&dir).unwrap_err().starts_with("ATTACHMENT_FOLDER"));
    assert!(far::read_local(&dir.join("gone.bin")).unwrap_err().starts_with("ATTACHMENT_NOT_FOUND"));
    let big = dir.join("big.bin");
    fs::File::create(&big).unwrap().set_len(far::SENT_MAX_BYTES as u64 + 1).unwrap();
    assert!(far::read_local(&big).unwrap_err().starts_with("ATTACHMENT_TOO_BIG"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn files_a_far_pc_names_to_prepare_must_lie_inside_the_project() {
    let dir = scratch("inside");
    let outside = scratch("inside-out");
    fs::write(dir.join("a.txt"), "a").unwrap();
    fs::write(outside.join("b.txt"), "b").unwrap();
    let ok = far::prepare_inside(&[dir.join("a.txt").display().to_string()], cwd(&dir)).unwrap();
    assert_eq!(ok[0].kind, AttachKind::Text);
    let no = far::prepare_inside(&[outside.join("b.txt").display().to_string()], cwd(&dir)).unwrap_err();
    assert!(no.starts_with("ATTACHMENT_OUTSIDE"), "{no}");
    let many: Vec<String> = (0..=MAX_ATTACHMENTS).map(|_| dir.join("a.txt").display().to_string()).collect();
    assert!(far::prepare_inside(&many, cwd(&dir)).unwrap_err().starts_with("ATTACHMENT_TOO_MANY"));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&outside);
}
