use super::blocks::*;
use super::clipboard;
use super::search;
use super::*;
use serde_json::json;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("potato-attach-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn cwd(dir: &Path) -> &str {
    dir.to_str().unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let out = crate::proc_util::hidden_command("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

// ---- prepare --------------------------------------------------------------------------------------------------

#[test]
fn a_text_file_keeps_its_path_and_is_not_read_into_the_message() {
    let dir = scratch("text");
    let file = dir.join("notes.md");
    fs::write(&file, "hello\n").unwrap();
    let got = prepare_one(&file, cwd(&dir)).unwrap();
    assert_eq!((got.kind, got.size, got.name.as_str()), (AttachKind::Text, 6, "notes.md"));
    assert_eq!(Path::new(&got.path), std::path::absolute(&file).unwrap());
    assert!(!dir.join(".potato-workspace").exists(), "a text file is not copied");
    // A long text file is still text, up to 256 KiB.
    let long = dir.join("long.txt");
    fs::write(&long, "x".repeat(200_000)).unwrap();
    assert_eq!(prepare_one(&long, cwd(&dir)).unwrap().kind, AttachKind::Text);
    let too_long = dir.join("huge.txt");
    fs::write(&too_long, "x".repeat(MAX_TEXT_BYTES as usize + 1)).unwrap();
    assert_eq!(prepare_one(&too_long, cwd(&dir)).unwrap().kind, AttachKind::File);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn images_and_binaries_are_copied_into_the_project_with_their_kind() {
    let dir = scratch("binary");
    let shot = dir.join("shot.PNG");
    fs::write(&shot, [0u8, 1, 2, 3]).unwrap();
    let got = prepare_one(&shot, cwd(&dir)).unwrap();
    assert_eq!((got.kind, got.mime.as_deref()), (AttachKind::Image, Some("image/png")));
    let copied = Path::new(&got.path);
    assert!(copied.starts_with(dir.join(".potato-workspace").join(ATTACHMENTS_DIR)));
    assert_eq!(fs::read(copied).unwrap(), [0u8, 1, 2, 3]);

    let bin = dir.join("data.bin");
    fs::write(&bin, [0u8, 159, 146, 150]).unwrap();
    let got = prepare_one(&bin, cwd(&dir)).unwrap();
    assert_eq!(got.kind, AttachKind::File);
    assert!(Path::new(&got.path).exists() && got.path != bin.display().to_string());
    // Valid UTF-8 with a NUL byte is binary too.
    let nul = dir.join("nul.txt");
    fs::write(&nul, b"abc\0def").unwrap();
    assert_eq!(prepare_one(&nul, cwd(&dir)).unwrap().kind, AttachKind::File);
    // Latin-1 text is not UTF-8.
    let latin = dir.join("latin.txt");
    fs::write(&latin, [0x63u8, 0x61, 0x66, 0xE9]).unwrap();
    assert_eq!(prepare_one(&latin, cwd(&dir)).unwrap().kind, AttachKind::File);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_file_is_refused() {
    let dir = scratch("missing");
    assert!(prepare_one(&dir.join("nope.txt"), cwd(&dir)).unwrap_err().starts_with("ATTACHMENT_NOT_FOUND"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_folder_keeps_its_path_and_counts_its_files_without_the_noise_folders() {
    let dir = scratch("folder");
    let project = dir.join("my project");
    for rel in ["a.rs", "src/b.rs", "src/deep/c.rs", ".git/HEAD", "node_modules/x/index.js", "target/debug/out.bin", "src/target/d.rs"] {
        touch(&project, rel);
    }
    let got = prepare_one(&project, cwd(&dir)).unwrap();
    assert_eq!((got.kind, got.name.as_str(), got.mime.as_deref()), (AttachKind::Folder, "my project", Some("inode/directory")));
    assert!(got.path.ends_with("my project"));
    // a.rs, src/b.rs and src/deep/c.rs: the three skipped folders hold nothing that counts.
    assert_eq!(got.size, 3);
    // Nothing is copied into the project: the folder is passed by its path.
    assert!(!dir.join(".potato-workspace").exists() && !project.join(".potato-workspace").exists());
    assert_eq!(serde_json::to_value(&got).unwrap()["kind"], "folder");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_huge_folder_count_stops_at_the_cap() {
    let dir = scratch("folder-cap");
    for i in 0..(MAX_FOLDER_COUNT + 5) {
        fs::write(dir.join(format!("f{i}.txt")), "").unwrap();
    }
    assert_eq!(count_files(&dir), MAX_FOLDER_COUNT);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_json_shape_is_the_contract() {
    let a = ChatAttachment { name: "a.png".into(), path: "C:/x/a.png".into(), kind: AttachKind::Image, size: 3, mime: Some("image/png".into()) };
    assert_eq!(serde_json::to_value(&a).unwrap(), json!({"name":"a.png","path":"C:/x/a.png","kind":"image","size":3,"mime":"image/png"}));
    let back: ChatAttachment = serde_json::from_value(json!({"name":"n","path":"/p","kind":"text","size":1})).unwrap();
    assert_eq!((back.kind, back.mime), (AttachKind::Text, None));
}

// ---- pasted pictures ------------------------------------------------------------------------------------------

#[test]
fn a_pasted_picture_is_saved_with_a_safe_unique_name() {
    let dir = scratch("paste");
    let data = base64::engine::general_purpose::STANDARD.encode([137u8, 80, 78, 71]);
    let one = save_pasted(cwd(&dir), "../../evil name?.exe", "image/png", &data).unwrap();
    let two = save_pasted(cwd(&dir), "../../evil name?.exe", "image/png", &data).unwrap();
    assert_eq!((one.kind, one.size, one.mime.as_deref()), (AttachKind::Image, 4, Some("image/png")));
    assert_eq!(one.name, "evil-name-.png", "only a stem and the extension of the mime type");
    assert_ne!(one.path, two.path, "the same name twice never overwrites");
    let saved = Path::new(&one.path);
    assert!(saved.starts_with(dir.join(".potato-workspace").join(ATTACHMENTS_DIR)));
    assert_eq!(fs::read(saved).unwrap(), [137u8, 80, 78, 71]);
    let jpeg = save_pasted(cwd(&dir), "", "image/jpeg", &data).unwrap();
    assert!(jpeg.name.ends_with(".jpg") && jpeg.name.starts_with("pasted-image"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_pasted_picture_has_a_type_and_a_size_limit() {
    let dir = scratch("paste-limits");
    let ok = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
    assert!(save_pasted(cwd(&dir), "x", "text/plain", &ok).unwrap_err().starts_with("ATTACHMENT_BAD_TYPE"));
    assert!(save_pasted(cwd(&dir), "x", "application/pdf", &ok).is_err());
    assert!(save_pasted(cwd(&dir), "x", "image/png", "not base64 !!").unwrap_err().starts_with("ATTACHMENT_BAD_DATA"));
    assert!(save_pasted(cwd(&dir), "x", "image/png", "").is_err());
    let exactly = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_PASTED_BYTES]);
    assert!(save_pasted(cwd(&dir), "x", "image/png", &exactly).is_ok(), "20 MiB is allowed");
    let over = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_PASTED_BYTES + 1]);
    assert!(save_pasted(cwd(&dir), "x", "image/png", &over).unwrap_err().starts_with("ATTACHMENT_TOO_BIG"));
    let _ = fs::remove_dir_all(&dir);
}

// ---- preview --------------------------------------------------------------------------------------------------

#[test]
fn a_preview_is_a_data_url_for_a_small_picture_and_nothing_else() {
    let dir = scratch("preview");
    let png = dir.join("a.png");
    fs::write(&png, [1u8, 2, 3]).unwrap();
    assert_eq!(preview(&png).as_deref(), Some("data:image/png;base64,AQID"));
    let text = dir.join("a.txt");
    fs::write(&text, "secret").unwrap();
    assert_eq!(preview(&text), None, "only picture types are read");
    let svg = dir.join("a.svg");
    fs::write(&svg, "<svg/>").unwrap();
    assert_eq!(preview(&svg), None);
    let big = dir.join("big.jpg");
    fs::write(&big, vec![0u8; MAX_PREVIEW_BYTES as usize + 1]).unwrap();
    assert_eq!(preview(&big), None);
    let ok = dir.join("edge.webp");
    fs::write(&ok, vec![0u8; MAX_PREVIEW_BYTES as usize]).unwrap();
    assert!(preview(&ok).is_some());
    assert_eq!(preview(&dir.join("missing.png")), None);
    assert_eq!(preview(&dir), None);
    let _ = fs::remove_dir_all(&dir);
}

// ---- project files --------------------------------------------------------------------------------------------

fn touch(dir: &Path, rel: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, rel).unwrap();
}

fn paths(found: &[search::ProjectFile]) -> Vec<&str> {
    found.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn search_ranks_a_name_prefix_over_a_name_match_over_a_path_match() {
    let dir = scratch("rank");
    for rel in ["src/zeta.rs", "docs/render-notes.md", "render/readme.md", "src/prerender.rs", "src/other.rs"] {
        touch(&dir, rel);
    }
    let found = search::search(cwd(&dir), "Render", None);
    assert_eq!(paths(&found), ["docs/render-notes.md", "src/prerender.rs", "render/readme.md"]);
    let one = &found[0];
    assert_eq!((one.name.as_str(), one.size), ("render-notes.md", "docs/render-notes.md".len() as u64));
    assert!(Path::new(&one.abs_path).is_absolute() && one.abs_path.ends_with("render-notes.md"));
    // Every word has to match, in any order.
    assert_eq!(paths(&search::search(cwd(&dir), "notes docs", None)), ["docs/render-notes.md"]);
    assert!(search::search(cwd(&dir), "render zzz", None).is_empty());
    // An empty query lists by path; the limit holds and is clamped.
    let all = search::search(cwd(&dir), "", Some(2));
    assert_eq!(paths(&all), ["docs/render-notes.md", "render/readme.md"]);
    assert_eq!(search::search(cwd(&dir), "", Some(0)).len(), 1);
    assert_eq!(search::search(cwd(&dir), "", Some(10_000)).len(), 5);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn search_in_a_git_repo_follows_gitignore() {
    let dir = scratch("git");
    git(&dir, &["init", "-q"]);
    fs::write(dir.join(".gitignore"), "ignored/\n*.log\n").unwrap();
    for rel in ["keep/main.rs", "ignored/main.rs", "debug.log", "untracked-main.rs"] {
        touch(&dir, rel);
    }
    git(&dir, &["add", "keep/main.rs", ".gitignore"]);
    let found = search::search(cwd(&dir), "main", None);
    assert_eq!(paths(&found), ["keep/main.rs", "untracked-main.rs"], "tracked and untracked yes, ignored no");
    assert!(search::search(cwd(&dir), "debug", None).is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn search_outside_git_walks_but_skips_noise_folders() {
    let dir = scratch("walk");
    for rel in ["a/x.txt", "node_modules/p/x.txt", "target/x.txt", ".git/x.txt", ".potato-workspace/attachments/x.txt", ".hidden/x.txt", "b/c/x.txt"] {
        touch(&dir, rel);
    }
    let found = search::search(cwd(&dir), "x.txt", None);
    assert_eq!(paths(&found), ["a/x.txt", "b/c/x.txt"]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn search_reuses_the_list_for_a_few_seconds() {
    let dir = scratch("cache");
    touch(&dir, "one.txt");
    assert_eq!(search::search(cwd(&dir), "", None).len(), 1);
    touch(&dir, "two.txt");
    assert_eq!(search::search(cwd(&dir), "", None).len(), 1, "the second file is not listed until the cache is old");
    let _ = fs::remove_dir_all(&dir);
}

// ---- prompt blocks --------------------------------------------------------------------------------------------

#[test]
fn file_uris_are_right_on_windows_and_unix() {
    assert_eq!(file_uri(r"C:\Users\Ana Lee\notes #1.txt"), "file:///C:/Users/Ana%20Lee/notes%20%231.txt");
    assert_eq!(file_uri(r"\\?\C:\a\b.png"), "file:///C:/a/b.png");
    assert_eq!(file_uri("C:/a/b.png"), "file:///C:/a/b.png");
    assert_eq!(file_uri(r"\\server\share\x y.txt"), "file://server/share/x%20y.txt");
    assert_eq!(file_uri("/home/ana/f.txt"), "file:///home/ana/f.txt");
    assert_eq!(file_uri("/h/é.txt"), "file:///h/%C3%A9.txt");
    for path in [r"C:\Users\Ana Lee\notes #1.txt", "/home/a b/é.txt"] {
        let back = path_of_uri(&file_uri(path)).unwrap();
        assert_eq!(back, path.replace('\\', "/"));
    }
    assert_eq!(path_of_uri("https://x/y"), None);
}

fn attached(dir: &Path, name: &str, bytes: &[u8], kind: AttachKind, mime: &str) -> ChatAttachment {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    ChatAttachment { name: name.into(), path: path.display().to_string(), kind, size: bytes.len() as u64, mime: Some(mime.into()) }
}

#[test]
fn blocks_follow_what_the_agent_takes() {
    let dir = scratch("blocks");
    let image = attached(&dir, "a.png", &[1, 2, 3], AttachKind::Image, "image/png");
    let text = attached(&dir, "n.txt", b"hello", AttachKind::Text, "text/plain");
    let file = attached(&dir, "d.pdf", b"%PDF", AttachKind::File, "application/pdf");
    let all = [image.clone(), text.clone(), file.clone()];
    let types = |blocks: &[serde_json::Value]| blocks.iter().map(|b| b["type"].as_str().unwrap().to_string()).collect::<Vec<_>>();

    let both = prompt_blocks("look", &all, true, true);
    assert_eq!(types(&both), ["text", "image", "resource", "resource_link"]);
    assert_eq!(both[0]["text"], "look");
    assert_eq!((both[1]["mimeType"].as_str(), both[1]["data"].as_str()), (Some("image/png"), Some("AQID")));
    assert_eq!(both[2]["resource"]["text"], "hello");
    assert_eq!(both[2]["resource"]["mimeType"], "text/plain");
    assert_eq!(both[2]["resource"]["uri"], file_uri(&text.path));
    assert_eq!((both[3]["uri"].as_str(), both[3]["name"].as_str(), both[3]["size"].as_u64()), (Some(file_uri(&file.path).as_str()), Some("d.pdf"), Some(4)));
    assert_eq!(both[3]["mimeType"], "application/pdf");

    assert_eq!(types(&prompt_blocks("look", &all, true, false)), ["text", "image", "resource_link", "resource_link"]);
    assert_eq!(types(&prompt_blocks("look", &all, false, true)), ["text", "resource_link", "resource", "resource_link"]);
    assert_eq!(types(&prompt_blocks("look", &all, false, false)), ["text", "resource_link", "resource_link", "resource_link"]);
    // No text, no text block; nothing at all gives nothing.
    assert_eq!(types(&prompt_blocks("", &all[..1], true, true)), ["image"]);
    assert!(prompt_blocks("", &[], true, true).is_empty());
    // A file that cannot be read still goes, as a link.
    let gone = ChatAttachment { path: dir.join("gone.png").display().to_string(), ..image };
    assert_eq!(types(&prompt_blocks("", &[gone], true, true)), ["resource_link"]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_folder_goes_as_a_link_with_a_text_line_and_is_never_inlined() {
    let dir = scratch("folder-blocks");
    let folder = ChatAttachment { name: "my project".into(), path: dir.display().to_string(), kind: AttachKind::Folder, size: 3, mime: Some("inode/directory".into()) };
    // The same whatever the agent takes: no image or embedded context changes a folder.
    for (images, embedded) in [(true, true), (false, false)] {
        let blocks = prompt_blocks("look", &[folder.clone()], images, embedded);
        let types: Vec<_> = blocks.iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["text", "text", "resource_link"]);
        assert_eq!(blocks[1]["text"], format!("Folder: {}", folder.path));
        assert_eq!(blocks[2]["uri"], file_uri(&folder.path));
        assert!(blocks[2]["uri"].as_str().unwrap().starts_with("file://"));
        assert_eq!((blocks[2]["name"].as_str(), blocks[2]["mimeType"].as_str()), (Some("my project"), Some("inode/directory")));
        assert!(blocks[2].get("size").is_none() && blocks[2].get("resource").is_none());
    }
    // Replayed, the link is a folder again.
    let back = attachment_of_block(&prompt_blocks("", &[folder.clone()], false, false)[1]).unwrap();
    assert_eq!((back.kind, back.name.as_str()), (AttachKind::Folder, "my project"));
    assert_eq!(text_with_paths("see", &[folder.clone()]), format!("see [attached: {}]", folder.path));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_terminal_agent_gets_the_paths_on_one_line() {
    let a = ChatAttachment { name: "a".into(), path: "/p/a.png".into(), kind: AttachKind::Image, size: 1, mime: None };
    assert_eq!(text_with_paths("see", &[a.clone()]), "see [attached: /p/a.png]");
    assert_eq!(text_with_paths("", &[a.clone(), a]), "[attached: /p/a.png] [attached: /p/a.png]");
    assert_eq!(text_with_paths("plain", &[]), "plain");
}

#[test]
fn replayed_blocks_become_attachments() {
    let link = attachment_of_block(&json!({"type":"resource_link","uri":"file:///C:/a%20b/c.pdf","name":"c.pdf","mimeType":"application/pdf","size":9})).unwrap();
    assert_eq!((link.path.as_str(), link.kind, link.size), ("C:/a b/c.pdf", AttachKind::File, 9));
    let res = attachment_of_block(&json!({"type":"resource","resource":{"uri":"file:///h/n.txt","mimeType":"text/plain","text":"hey"}})).unwrap();
    assert_eq!((res.name.as_str(), res.kind, res.size), ("n.txt", AttachKind::Text, 3));
    let image = attachment_of_block(&json!({"type":"image","mimeType":"image/png","data":"AQID"})).unwrap();
    assert_eq!((image.kind, image.path.as_str(), image.name.as_str()), (AttachKind::Image, "", "image"));
    assert!(attachment_of_block(&json!({"type":"text","text":"x"})).is_none());
}

// ---- Explorer clipboard (CF_HDROP) ----------------------------------------------------------------------------

/// A DROPFILES block as Explorer writes it: a 20-byte header, then the paths (UTF-16 when `wide`), each null-ended.
fn drop_files(paths: &[&str], wide: bool) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&20u32.to_le_bytes()); // pFiles: the list starts after the header
    out.extend_from_slice(&[0u8; 8]); // pt
    out.extend_from_slice(&0u32.to_le_bytes()); // fNC
    out.extend_from_slice(&u32::from(wide).to_le_bytes()); // fWide
    for path in paths {
        if wide {
            for unit in path.encode_utf16().chain(std::iter::once(0)) {
                out.extend_from_slice(&unit.to_le_bytes());
            }
        } else {
            out.extend_from_slice(path.as_bytes());
            out.push(0);
        }
    }
    if wide {
        out.extend_from_slice(&[0, 0]);
    } else {
        out.push(0);
    }
    out
}

#[test]
fn explorer_paths_are_read_one_per_file_in_order() {
    let block = drop_files(&[r"C:\Users\me\notes.md", r"D:\photos\shot one.png", r"C:\work\src"], true);
    assert_eq!(clipboard::parse_drop_files(&block), vec![r"C:\Users\me\notes.md", r"D:\photos\shot one.png", r"C:\work\src"]);
}

#[test]
fn a_non_ascii_name_survives_the_wide_format() {
    let block = drop_files(&[r"C:\Docs\résumé ☕.txt"], true);
    assert_eq!(clipboard::parse_drop_files(&block), vec![r"C:\Docs\résumé ☕.txt"]);
}

#[test]
fn the_ansi_flavour_is_read_too() {
    let block = drop_files(&[r"C:\a.txt", r"C:\b.txt"], false);
    assert_eq!(clipboard::parse_drop_files(&block), vec![r"C:\a.txt", r"C:\b.txt"]);
}

#[test]
fn an_empty_or_broken_block_gives_no_paths_and_no_panic() {
    assert!(clipboard::parse_drop_files(&[]).is_empty());
    assert!(clipboard::parse_drop_files(&[1, 2, 3]).is_empty());
    // The list offset points past the end of the block.
    let mut bad = drop_files(&[r"C:\a.txt"], true);
    bad[0..4].copy_from_slice(&9999u32.to_le_bytes());
    assert!(clipboard::parse_drop_files(&bad).is_empty());
    // A list with no closing empty path still gives what it has.
    let mut cut = drop_files(&[r"C:\a.txt"], true);
    cut.truncate(cut.len() - 2);
    assert_eq!(clipboard::parse_drop_files(&cut), vec![r"C:\a.txt"]);
}
