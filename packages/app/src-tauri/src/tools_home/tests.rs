use super::*;
use std::fs;
use super::stage::discard;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-tools-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A small tools tree under `root` (same layout as `resources/`) and the manifest that describes it.
fn write_tools(root: &Path, number: u32, node_bytes: &str) -> ToolsManifest {
    let files = [("node/node.exe", node_bytes), ("node/npm.cmd", "npm"), ("git/cmd/git.exe", "git"), ("bin/cloudflared.exe", "cloudflared")];
    let mut listed = Vec::new();
    for (rel, content) in files {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        listed.push(ToolFile { path: rel.to_string(), size: content.len() as u64, sha256: sha256_file(&path).unwrap() });
    }
    // Files that are not listed still count for the folder totals.
    fs::create_dir_all(root.join("node/node_modules")).unwrap();
    fs::write(root.join("node/node_modules/readme.txt"), "x").unwrap();
    let mut counts = BTreeMap::new();
    counts.insert("node".to_string(), count_files(&root.join("node")));
    counts.insert("git".to_string(), count_files(&root.join("git")));
    let manifest = ToolsManifest { tools_version: number, node: "1".into(), git: "1".into(), cloudflared: "1".into(), counts, files: listed };
    fs::write(root.join(MANIFEST_FILE), serde_json::to_string(&manifest).unwrap()).unwrap();
    manifest
}

fn says(root: &Path, number: u32) {
    fs::write(root.join(MANIFEST_FILE), format!("{{\"toolsVersion\":{number}}}")).unwrap();
}

#[test]
fn the_compiled_manifest_is_whole() {
    let m = ToolsManifest::parse(COMPILED_MANIFEST).expect("resources/tools-manifest.json parses");
    assert!(m.tools_version >= 1);
    assert!(m.files.iter().any(|f| f.path == "node/node.exe") && m.files.iter().any(|f| f.path == "bin/cloudflared.exe"));
    assert!(m.files.iter().all(|f| f.sha256.len() == 64 && f.size > 0));
    assert!(m.counts.contains_key("node") && m.counts.contains_key("git"));
}

#[test]
fn the_install_folder_wins_when_its_manifest_matches() {
    let install = temp("install");
    let local = temp("local");
    let m = write_tools(&install, 3, "node");
    write_tools(&local_dir(&local, 3), 3, "node");
    let home = resolve(&install, Some(&local), &m).unwrap();
    assert_eq!(home.source, Source::Install);
    assert_eq!(home.root, install);
    assert_eq!(home.node_dir(), install.join("node"));
    assert_eq!(home.git_cmd_dir(), install.join("git").join("cmd"));
}

#[test]
fn the_staged_folder_is_used_when_the_install_folder_has_no_tools() {
    let install = temp("empty-install");
    let local = temp("local");
    let m = write_tools(&local_dir(&local, 3), 3, "node");
    let home = resolve(&install, Some(&local), &m).unwrap();
    assert_eq!(home.source, Source::Local);
    assert_eq!(home.root, local.join("3"));
    assert!(home.cloudflared_bin().is_file());
}

#[test]
fn a_folder_with_another_tools_number_is_ignored() {
    let install = temp("old-install");
    let local = temp("local");
    let m = write_tools(&install, 3, "node");
    says(&install, 2);
    // A staged folder named for the right number but declaring a different one is no good either.
    write_tools(&local_dir(&local, 3), 3, "node");
    says(&local_dir(&local, 3), 4);
    assert_eq!(resolve(&install, Some(&local), &m), None);
    // A staged folder for another number is never looked at.
    write_tools(&local_dir(&local, 2), 2, "node");
    assert_eq!(resolve(&temp("none"), Some(&local), &m), None);
}

#[test]
fn a_missing_exe_or_a_wrong_size_or_a_wrong_hash_counts_as_missing() {
    let install = temp("broken");
    let m = write_tools(&install, 3, "node");
    assert!(resolve(&install, None, &m).is_some());

    // Wrong size: the quick check at every start catches it.
    fs::write(install.join("node/node.exe"), "nodeXX").unwrap();
    assert_eq!(resolve(&install, None, &m), None);
    // Same size, one byte changed: only the full check (after a copy) sees it.
    fs::write(install.join("node/node.exe"), "nodf").unwrap();
    assert!(verify(&install, &m, Depth::Quick).is_ok());
    assert!(verify(&install, &m, Depth::Full).unwrap_err().contains("wrong content"));
    // A removed exe.
    fs::remove_file(install.join("node/node.exe")).unwrap();
    assert!(verify(&install, &m, Depth::Quick).unwrap_err().contains("missing node/node.exe"));
    assert_eq!(resolve(&install, None, &m), None);
}

#[test]
fn a_folder_that_lost_unlisted_files_fails_the_full_check_only() {
    let install = temp("count");
    let m = write_tools(&install, 3, "node");
    fs::remove_file(install.join("node/node_modules/readme.txt")).unwrap();
    assert!(verify(&install, &m, Depth::Quick).is_ok());
    assert!(verify(&install, &m, Depth::Full).unwrap_err().contains("node/ has"));
}

#[test]
fn a_good_copy_ends_in_the_numbered_folder_and_checks_out() {
    let install = temp("src");
    let base = temp("base");
    let m = write_tools(&install, 5, "node");
    assert_eq!(stage_local(&install, &base, &m), Ok(Staged::Copied));
    let staged = local_dir(&base, 5);
    assert!(staged.join("node/node.exe").is_file() && staged.join("bin/cloudflared.exe").is_file() && staged.join(MANIFEST_FILE).is_file());
    assert!(verify(&staged, &m, Depth::Full).is_ok());
    assert!(!base.join("5.tmp").exists(), "the half copy name is gone");
    // The install folder is only read.
    assert!(install.join("node/node.exe").is_file());
    // The resolver finds it when the install folder has lost its tools.
    assert_eq!(resolve(&temp("gone"), Some(&base), &m).unwrap().source, Source::Local);
    // A second press copies nothing.
    assert_eq!(stage_local(&install, &base, &m), Ok(Staged::AlreadyThere));
}

#[test]
fn a_copy_with_one_byte_changed_is_refused_and_leaves_no_final_folder() {
    let install = temp("src-bad");
    let base = temp("base-bad");
    let m = write_tools(&install, 5, "node");
    // The disk (or an antivirus) changed one byte of the source after the manifest was made.
    fs::write(install.join("node/node.exe"), "nodf").unwrap();
    let err = stage_local(&install, &base, &m).unwrap_err();
    assert!(err.contains("wrong content"), "{err}");
    assert!(!local_dir(&base, 5).exists(), "no final folder");
    assert!(!base.join("5.tmp").exists(), "the half copy was removed");
}

#[test]
fn a_missing_source_file_is_refused() {
    let install = temp("src-missing");
    let base = temp("base-missing");
    let m = write_tools(&install, 5, "node");
    fs::remove_file(install.join("bin/cloudflared.exe")).unwrap();
    assert!(stage_local(&install, &base, &m).is_err());
    assert!(!local_dir(&base, 5).exists());
}

#[test]
fn a_leftover_half_copy_is_cleaned_and_the_next_try_works() {
    let install = temp("src-left");
    let base = temp("base-left");
    let m = write_tools(&install, 5, "node");
    fs::create_dir_all(base.join("5.tmp/node")).unwrap();
    fs::write(base.join("5.tmp/node/node.exe"), "half").unwrap();
    assert_eq!(stage_local(&install, &base, &m), Ok(Staged::Copied));
    assert!(verify(&local_dir(&base, 5), &m, Depth::Full).is_ok());
    assert!(!base.join("5.tmp").exists());
}

#[test]
fn a_broken_final_folder_is_replaced() {
    let install = temp("src-replace");
    let base = temp("base-replace");
    let m = write_tools(&install, 5, "node");
    fs::create_dir_all(local_dir(&base, 5)).unwrap();
    fs::write(local_dir(&base, 5).join("junk.txt"), "x").unwrap();
    assert_eq!(stage_local(&install, &base, &m), Ok(Staged::Copied));
    assert!(!local_dir(&base, 5).join("junk.txt").exists());
}

#[test]
fn cleanup_removes_only_old_numbers_half_copies_and_the_discard_folder() {
    let base = temp("clean");
    for name in ["1", "2", "3", "3.tmp", "7.tmp", ".discard"] {
        fs::create_dir_all(base.join(name)).unwrap();
        fs::write(base.join(name).join("f.txt"), "x").unwrap();
    }
    // Things this module never made: other folders and loose files stay.
    fs::create_dir_all(base.join("keep-me")).unwrap();
    fs::create_dir_all(base.join("3x")).unwrap();
    fs::write(base.join("2.txt"), "x").unwrap();
    let mut handled = cleanup_local(&base, 3);
    handled.sort();
    assert_eq!(handled, vec![".discard", "1", "2", "3.tmp", "7.tmp"]);
    assert!(base.join("3/f.txt").is_file(), "the current number stays");
    assert!(base.join("keep-me").is_dir() && base.join("3x").is_dir() && base.join("2.txt").is_file());
    for gone in ["1", "2", "3.tmp", "7.tmp", ".discard"] {
        assert!(!base.join(gone).exists(), "{gone}");
    }
}

#[test]
fn cleanup_never_touches_a_folder_outside_the_tools_folder() {
    let parent = temp("outside");
    let base = parent.join("tools");
    fs::create_dir_all(&base).unwrap();
    fs::create_dir_all(parent.join("9")).unwrap();
    assert!(!discard(&base, &parent.join("9")), "not inside the tools folder");
    assert!(!discard(&base, &base.join("notes")), "not one of our names");
    assert!(parent.join("9").is_dir());
    assert!(cleanup_local(&parent.join("missing"), 1).is_empty());
}

#[test]
fn the_status_says_missing_only_for_an_installed_app() {
    let install = temp("status");
    let exe_dir = install.join("app");
    let resources = exe_dir.join("resources");
    fs::create_dir_all(&resources).unwrap();
    let local = temp("status-local");
    let m = write_tools(&temp("seed"), 4, "node");
    with_test_home(m.clone(), Some(local.clone()), || {
        let dev = status_for(&exe_dir, true);
        assert!(dev.ok && dev.source == "dev");
        let missing = status_for(&exe_dir, false);
        assert!(!missing.ok && missing.source == "missing" && missing.tools_version == 4);
        write_tools(&resources, 4, "node");
        assert_eq!(status_for(&exe_dir, false).source, "install");
        fs::remove_file(resources.join("node/node.exe")).unwrap();
        assert!(!status_for(&exe_dir, false).ok);
        write_tools(&local_dir(&local, 4), 4, "node");
        assert_eq!(status_for(&exe_dir, false).source, "local");
    });
}

#[test]
fn the_path_for_children_follows_the_resolver() {
    // The folders a child gets on its PATH come from the same resolver: install folder first, then the staged one.
    let exe_dir = temp("path-exe");
    let local = temp("path-local");
    let m = write_tools(&temp("path-seed"), 6, "node");
    with_test_home(m, Some(local.clone()), || {
        assert!(crate::shell_env::bundled_tool_dirs(&exe_dir).is_empty(), "no tools: nothing is added");
        write_tools(&local_dir(&local, 6), 6, "node");
        assert_eq!(crate::shell_env::bundled_tool_dirs(&exe_dir), vec![local.join("6").join("node"), local.join("6").join("git").join("cmd")]);
        let resources = exe_dir.join("resources");
        write_tools(&resources, 6, "node");
        assert_eq!(crate::shell_env::bundled_tool_dirs(&exe_dir), vec![resources.join("node"), resources.join("git").join("cmd")]);
    });
}
