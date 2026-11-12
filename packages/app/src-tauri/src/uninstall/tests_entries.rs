//! Our entries leave other tools' config files; the user's own servers stay exactly as they were.

use super::entries::{self, Backup};
use super::tests::*;

fn host_for<'a>(hosts: &'a [entries::HostFile], file: &str) -> &'a entries::HostFile {
    hosts.iter().find(|h| h.path.ends_with(file)).unwrap_or_else(|| panic!("no host for {file}"))
}

#[test]
fn only_potato_workspace_and_toolbelt_keys_go_and_the_rest_is_byte_equal() {
    let w = world("entries");
    let hosts = entries::global_hosts(&specs(), &w.roots);
    let backup = Backup::new(w.roots.temp.join("potato-uninstall-backup"));

    for h in &hosts {
        entries::remove_ours(h, &backup).unwrap();
    }

    // JSON: the user's server is untouched, key order and layout kept, only our two members are gone.
    let claude = read(&w.roots.home.join(".claude.json"));
    assert!(claude.contains("\"their-server\"") && claude.contains("\"numStartups\": 12"));
    assert!(!claude.contains("potato-workspace") && !claude.contains("pm-toolbelt-fetch"));
    let doc: serde_json::Value = serde_json::from_str(&claude).expect("still valid JSON");
    assert_eq!(doc["mcpServers"]["their-server"]["args"][0], "theirs.js");
    // TOML
    let codex = read(&w.roots.home.join(".codex").join("config.toml"));
    assert!(codex.contains("model = \"gpt-5\"") && codex.contains("[mcp_servers.their-server]") && codex.contains("command = \"theirs\""));
    assert!(!codex.contains("potato-workspace"));
    let parsed: toml::Table = codex.parse().expect("still valid TOML");
    assert!(parsed["mcp_servers"].as_table().unwrap().contains_key("their-server"));
    // Cursor, OpenCode (both files).
    let cursor = read(&w.roots.home.join(".cursor").join("mcp.json"));
    assert!(cursor.contains("\"mine\"") && !cursor.contains("potato-workspace"));
    for file in [w.roots.home.join(".config").join("opencode").join("opencode.json"), w.roots.appdata.join("opencode").join("opencode.json")] {
        let text = read(&file);
        assert!(text.contains("\"theme\": \"dark\"") && text.contains("\"other\"") && !text.contains("potato-workspace"), "{}", file.display());
    }
    // A backup of each touched file exists, with the original bytes, and says where it came from.
    let index = read(&backup.dir.join("index.txt"));
    assert!(index.contains(".claude.json") && index.contains("config.toml") && index.contains("mcp.json"));
    let copy = std::fs::read_dir(&backup.dir).unwrap().filter_map(Result::ok).find(|e| e.file_name().to_string_lossy().ends_with("-.claude.json")).expect("claude backup");
    assert_eq!(read(&copy.path()), CLAUDE_JSON);
}

#[test]
fn a_file_without_our_entry_is_not_rewritten_or_backed_up() {
    let w = world("noentry");
    write(&w.roots.home.join(".cursor").join("mcp.json"), "{ \"mcpServers\": { \"mine\": {} } }");
    let hosts = entries::global_hosts(&specs(), &w.roots);
    let backup = Backup::new(w.roots.temp.join("bk"));
    let h = host_for(&hosts, "mcp.json");
    let before = std::fs::metadata(&h.path).unwrap().modified().unwrap();
    assert_eq!(entries::remove_ours(h, &backup).unwrap(), None);
    assert_eq!(read(&h.path), "{ \"mcpServers\": { \"mine\": {} } }");
    assert_eq!(std::fs::metadata(&h.path).unwrap().modified().unwrap(), before);
    assert!(!backup.dir.exists(), "no backup for a file that was not touched");
}

#[test]
fn a_broken_file_is_left_alone_and_reported() {
    let w = world("broken");
    write(&w.roots.home.join(".claude.json"), "{ not json potato-workspace");
    let hosts = entries::global_hosts(&specs(), &w.roots);
    let backup = Backup::new(w.roots.temp.join("bk"));
    let h = host_for(&hosts, ".claude.json");
    assert!(entries::our_keys(h).is_empty(), "an unreadable file reports nothing instead of guessing");
    assert_eq!(entries::remove_ours(h, &backup).unwrap(), None);
    assert_eq!(read(&h.path), "{ not json potato-workspace");
}

#[test]
fn project_hosts_come_from_the_agents_declarations_plus_the_known_extras() {
    let w = world("projhosts");
    let hosts = entries::project_hosts(&specs(), &w.shop);
    let names: Vec<String> = hosts.iter().map(|h| h.path.strip_prefix(&w.shop).unwrap().to_string_lossy().replace('\\', "/")).collect();
    for want in [".mcp.json", ".codex/config.toml", ".cursor/mcp.json", "opencode.json"] {
        assert!(names.contains(&want.to_string()), "{want} missing in {names:?}");
    }
    assert_eq!(names.iter().filter(|n| *n == ".mcp.json").count(), 1, "no repeats");
}

#[test]
fn only_skill_folders_with_our_marker_are_ours() {
    let w = world("skills");
    let dir = w.roots.home.join(".claude").join("skills");
    let ours = entries::our_skill_dirs(&dir);
    assert_eq!(ours.len(), 1);
    assert!(ours[0].ends_with("pm-review"));
    entries::remove_skill_dir(&ours[0]).unwrap();
    assert!(!dir.join("pm-review").exists());
    assert!(dir.join("pm-status").join("SKILL.md").exists(), "the user's own skill stays");
}

#[test]
fn the_blanket_trust_flag_is_found_but_never_changed() {
    let w = world("flag");
    let file = entries::blanket_trust_flag(&w.shop).expect("flag found");
    assert_eq!(read(&file), "{\"enableAllProjectMcpServers\":true}");
}

#[test]
fn our_git_exclude_block_goes_and_every_other_line_stays() {
    let w = world("exclude");
    assert!(crate::git_exclude::has_our_block(&w.shop));
    assert!(crate::git_exclude::remove_block(&w.shop));
    assert_eq!(read(&w.shop.join(".git").join("info").join("exclude")), "# mine\n*.log\ntarget/\n");
    assert!(!crate::git_exclude::has_our_block(&w.shop));
    assert!(!crate::git_exclude::remove_block(&w.shop), "nothing left to remove");
}
