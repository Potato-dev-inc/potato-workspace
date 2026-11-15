use super::*;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("potato-files-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn a_path_with_dot_dot_is_refused() {
    let dir = scratch("dotdot");
    let err = read_file(s(&dir), "../secret.txt").unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    let err = list_dir(s(&dir), "a/../..", false).unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
}

#[test]
fn an_absolute_path_outside_the_root_is_refused_and_inside_is_allowed() {
    let dir = scratch("abs");
    let other = scratch("abs-other");
    fs::write(other.join("x.txt"), "x").unwrap();
    fs::write(dir.join("in.txt"), "hello").unwrap();
    let err = read_file(s(&dir), s(&other.join("x.txt"))).unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    let ok = read_file(s(&dir), s(&dir.join("in.txt"))).unwrap();
    assert_eq!(ok.text.as_deref(), Some("hello"));
    assert_eq!(ok.path, "in.txt");
}

#[test]
fn a_link_that_leads_out_is_refused_and_not_listed() {
    let dir = scratch("link");
    let other = scratch("link-other");
    fs::write(other.join("secret.txt"), "s").unwrap();
    fs::write(dir.join("ok.txt"), "ok").unwrap();
    // A directory symlink needs a privilege on Windows; a junction does not.
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&other, dir.join("out")).is_ok()
        || crate::proc_util::hidden_command("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("out")).arg(&other).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&other, dir.join("out")).is_ok();
    assert!(made, "this machine cannot make a link, so the test proves nothing");
    let err = read_file(s(&dir), "out/secret.txt").unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    let listing = list_dir(s(&dir), "", false).unwrap();
    let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["ok.txt"], "the link must not be listed");
}

#[test]
fn a_file_over_two_megabytes_is_not_read() {
    let dir = scratch("big");
    fs::write(dir.join("big.txt"), vec![b'a'; (MAX_READ_BYTES + 1) as usize]).unwrap();
    fs::write(dir.join("edge.txt"), vec![b'a'; MAX_READ_BYTES as usize]).unwrap();
    let big = read_file(s(&dir), "big.txt").unwrap();
    assert_eq!(big.kind, "too_large");
    assert!(big.text.is_none());
    assert_eq!(big.size, MAX_READ_BYTES + 1);
    assert_eq!(read_file(s(&dir), "edge.txt").unwrap().kind, "text");
}

#[test]
fn pictures_and_binaries_are_told_apart() {
    let dir = scratch("kinds");
    fs::write(dir.join("a.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
    fs::write(dir.join("b.bin"), [1, 0, 2]).unwrap();
    let image = read_file(s(&dir), "a.png").unwrap();
    assert_eq!(image.kind, "image");
    assert!(image.data_url.unwrap().starts_with("data:image/png;base64,"));
    assert_eq!(read_file(s(&dir), "b.bin").unwrap().kind, "binary");
}

#[test]
fn listing_puts_folders_first_in_natural_order_and_skips_heavy_folders() {
    let dir = scratch("list");
    for d in ["src", "node_modules", "target", ".git", "docs"] {
        fs::create_dir_all(dir.join(d)).unwrap();
    }
    for f in ["file10.txt", "file2.txt", "Readme.md", "a.txt"] {
        fs::write(dir.join(f), "x").unwrap();
    }
    let names = |show| list_dir(s(&dir), "", show).unwrap().entries.into_iter().map(|e| e.name).collect::<Vec<_>>();
    assert_eq!(names(false), vec!["docs", "src", "a.txt", "file2.txt", "file10.txt", "Readme.md"]);
    let all = names(true);
    assert!(all.contains(&"node_modules".to_string()) && all.contains(&".git".to_string()) && all.contains(&"target".to_string()));
}

#[test]
fn a_heavy_folder_can_be_opened_when_asked_for_by_path() {
    let dir = scratch("heavy");
    fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
    let inner = list_dir(s(&dir), "node_modules", false).unwrap();
    assert_eq!(inner.entries[0].name, "pkg");
    assert_eq!(inner.entries[0].path, "node_modules/pkg");
}

#[test]
fn the_status_output_becomes_changed_and_new_marks() {
    let out = b" M src/a.rs\0?? src/b.rs\0A  c.rs\0R  new.rs\0old.rs\0 M other/z.rs\0";
    let marks = parse_status(out, "src/");
    assert_eq!(marks, vec![FileMark { path: "a.rs".into(), mark: "M".into() }, FileMark { path: "b.rs".into(), mark: "N".into() }]);
    let all = parse_status(out, "");
    assert_eq!(all.len(), 5);
    assert_eq!(all[2], FileMark { path: "c.rs".into(), mark: "N".into() });
}

#[test]
fn natural_order_counts_numbers_as_numbers() {
    assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
    assert_eq!(natural_cmp("B", "a"), Ordering::Greater);
}

fn git(dir: &Path, args: &[&str]) {
    let out = crate::proc_util::hidden_command("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn the_marks_and_the_diff_follow_git() {
    let dir = scratch("git");
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.email", "t@example.test"]);
    git(&dir, &["config", "user.name", "t"]);
    fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "first"]);
    fs::write(dir.join("a.txt"), "one\nTWO\n").unwrap();
    fs::write(dir.join("b.txt"), "fresh\n").unwrap();
    let got = marks(s(&dir));
    assert!(got.contains(&FileMark { path: "a.txt".into(), mark: "M".into() }), "{got:?}");
    assert!(got.contains(&FileMark { path: "b.txt".into(), mark: "N".into() }), "{got:?}");
    let changed = diff(s(&dir), "a.txt").unwrap();
    assert!(changed.contains("-two") && changed.contains("+TWO"), "{changed}");
    let fresh = diff(s(&dir), "b.txt").unwrap();
    assert!(fresh.contains("+fresh") && fresh.contains("@@ -0,0 +1,1 @@"), "{fresh}");
    assert!(diff(s(&dir), "../x").unwrap_err().starts_with("FILES_OUTSIDE"));
}

#[test]
fn raw_bytes_come_back_as_base64_and_a_big_file_is_not_read() {
    let dir = scratch("bytes");
    fs::write(dir.join("a.docx"), [b'P', b'K', 0, 1, 2]).unwrap();
    fs::write(dir.join("big.pdf"), vec![0u8; (MAX_BYTES_READ + 1) as usize]).unwrap();
    let ok = read_bytes(s(&dir), "a.docx").unwrap();
    assert_eq!(ok.kind, "bytes");
    assert_eq!(ok.size, 5);
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(ok.base64.unwrap()).unwrap(), vec![b'P', b'K', 0, 1, 2]);
    let big = read_bytes(s(&dir), "big.pdf").unwrap();
    assert_eq!(big.kind, "too_large");
    assert!(big.base64.is_none());
}

#[test]
fn the_byte_reader_stays_inside_the_project_folder() {
    let dir = scratch("bytes-out");
    let other = scratch("bytes-out-other");
    fs::write(other.join("secret.docx"), "s").unwrap();
    assert!(read_bytes(s(&dir), "../x.docx").unwrap_err().starts_with("FILES_OUTSIDE"));
    let err = read_bytes(s(&dir), s(&other.join("secret.docx"))).unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    assert!(read_bytes(s(&dir), "missing.docx").unwrap_err().starts_with("FILES_NOT_FOUND"));
}

#[test]
fn only_document_kinds_are_opened_in_the_default_program() {
    let dir = scratch("open-default");
    fs::write(dir.join("run.exe"), "x").unwrap();
    fs::write(dir.join("run.bat"), "x").unwrap();
    assert!(open_default(s(&dir), "run.exe").unwrap_err().starts_with("FILES_NOT_OPENABLE"));
    assert!(open_default(s(&dir), "run.bat").unwrap_err().starts_with("FILES_NOT_OPENABLE"));
    assert!(open_default(s(&dir), "../run.docx").unwrap_err().starts_with("FILES_OUTSIDE"));
}

fn opened(dir: &Path, rel: &str) -> String {
    read_file(s(dir), rel).unwrap().version
}

#[test]
fn a_save_writes_the_text_and_returns_the_new_version() {
    let dir = scratch("save-ok");
    fs::write(dir.join("a.rs"), "fn main() {}\n").unwrap();
    let v = opened(&dir, "a.rs");
    let saved = write_file(s(&dir), "a.rs", "fn main() { 1 }\n", Some(&v), false).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.rs")).unwrap(), "fn main() { 1 }\n");
    assert_eq!(saved.path, "a.rs");
    assert_eq!(saved.version, opened(&dir, "a.rs"));
    // The new version is a valid starting point for the next save.
    write_file(s(&dir), "a.rs", "x\n", Some(&saved.version), false).unwrap();
}

#[test]
fn a_save_over_a_changed_file_is_a_conflict_unless_overwrite_is_asked_for() {
    let dir = scratch("save-conflict");
    fs::write(dir.join("a.txt"), "mine").unwrap();
    let v = opened(&dir, "a.txt");
    fs::write(dir.join("a.txt"), "the agent was here").unwrap();
    let err = write_file(s(&dir), "a.txt", "mine, edited", Some(&v), false).unwrap_err();
    assert!(err.starts_with("FILES_CONFLICT"), "{err}");
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "the agent was here", "nothing was written");
    let err = write_file(s(&dir), "a.txt", "mine, edited", None, false).unwrap_err();
    assert!(err.starts_with("FILES_CONFLICT"), "no version is no proof: {err}");
    write_file(s(&dir), "a.txt", "mine, edited", Some(&v), true).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "mine, edited");
}

#[test]
fn a_save_refuses_dot_dot_and_a_path_outside_the_project() {
    let dir = scratch("save-out");
    let other = scratch("save-out-other");
    fs::write(other.join("x.txt"), "x").unwrap();
    let err = write_file(s(&dir), "../x.txt", "bad", None, true).unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    let err = write_file(s(&dir), s(&other.join("x.txt")), "bad", None, true).unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    assert_eq!(fs::read_to_string(other.join("x.txt")).unwrap(), "x");
}

#[test]
fn a_save_through_a_link_that_leads_out_is_refused() {
    let dir = scratch("save-link");
    let other = scratch("save-link-other");
    fs::write(other.join("secret.txt"), "s").unwrap();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&other, dir.join("out")).is_ok()
        || crate::proc_util::hidden_command("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("out")).arg(&other).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&other, dir.join("out")).is_ok();
    assert!(made, "this machine cannot make a link, so the test proves nothing");
    let err = write_file(s(&dir), "out/secret.txt", "bad", None, true).unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    assert_eq!(fs::read_to_string(other.join("secret.txt")).unwrap(), "s");
}

#[test]
fn a_save_never_makes_a_new_file() {
    let dir = scratch("save-new");
    let err = write_file(s(&dir), "new.txt", "x", None, true).unwrap_err();
    assert!(err.starts_with("FILES_NOT_FOUND"), "{err}");
    assert!(!dir.join("new.txt").exists());
}

#[test]
fn a_save_over_two_megabytes_is_refused() {
    let dir = scratch("save-big");
    fs::write(dir.join("a.txt"), "x").unwrap();
    let big = "a".repeat((MAX_WRITE_BYTES + 1) as usize);
    let err = write_file(s(&dir), "a.txt", &big, None, true).unwrap_err();
    assert!(err.starts_with("FILES_TOO_LARGE"), "{err}");
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "x");
}

#[test]
fn documents_pictures_binaries_and_git_files_are_not_saved() {
    let dir = scratch("save-kinds");
    fs::write(dir.join("a.docx"), "PK").unwrap();
    fs::write(dir.join("a.png"), "png").unwrap();
    fs::write(dir.join("a.bin"), [1u8, 0, 2]).unwrap();
    fs::write(dir.join("latin.txt"), [0x63u8, 0x61, 0x66, 0xe9]).unwrap();
    fs::create_dir_all(dir.join(".git")).unwrap();
    fs::write(dir.join(".git").join("config"), "c").unwrap();
    for (name, code) in [("a.docx", "FILES_READ_ONLY"), ("a.png", "FILES_READ_ONLY"), ("a.bin", "FILES_NOT_TEXT"), ("latin.txt", "FILES_NOT_TEXT"), (".git/config", "FILES_PROTECTED")] {
        let err = write_file(s(&dir), name, "bad", None, true).unwrap_err();
        assert!(err.starts_with(code), "{name}: {err}");
    }
    assert_eq!(fs::read_to_string(dir.join(".git").join("config")).unwrap(), "c");
}

#[test]
fn equal_bytes_have_equal_versions_and_any_change_changes_it() {
    assert_eq!(write::version_of(b"abc"), write::version_of(b"abc"));
    assert_ne!(write::version_of(b"abc"), write::version_of(b"abd"));
    assert_ne!(write::version_of(b""), write::version_of(b"a"));
}
