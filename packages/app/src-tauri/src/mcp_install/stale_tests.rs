use super::*;

const NEW: &str = "C:/Apps/Potato/bin/puppet-master-mcp.exe";
const OLD: &str = "C:/Old/puppet-master-mcp.exe";

fn current() -> McpLaunchSpec {
    McpLaunchSpec { command: NEW.into(), args: vec![] }
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-stale-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn as_new_app<R>(f: impl FnOnce() -> R) -> R {
    crate::mcp_runtime::with_test_bundled(NEW, &[], f)
}

#[test]
fn a_path_from_an_older_install_is_stale_and_slashes_do_not_matter() {
    assert!(launch_is_stale(OLD, &[], &current()));
    assert!(launch_is_stale("npx", &["-y".into(), "@potato-workspace/mcp".into()], &current()));
    assert!(!launch_is_stale(NEW, &[], &current()));
    assert!(!launch_is_stale(&NEW.replace('/', "\\"), &[], &current()));
}

#[test]
fn each_host_shape_is_read() {
    assert!(json_server_is_stale(&json!({"command": OLD, "args": []}), &current()));
    assert!(!json_server_is_stale(&json!({"command": NEW, "args": []}), &current()));
    assert!(opencode_entry_is_stale(&json!({"command": [OLD]}), &current()));
    assert!(!opencode_entry_is_stale(&json!({"command": [NEW]}), &current()));
    assert!(opencode_entry_is_stale(&json!({}), &current()));
    let toml_old = format!("[mcp_servers.potato-workspace]\ncommand = \"{OLD}\"\nargs = []\n");
    let toml_new = format!("[mcp_servers.potato-workspace]\ncommand = \"{NEW}\"\nargs = []\n");
    assert!(codex_block_is_stale(&toml_old, &current()));
    assert!(!codex_block_is_stale(&toml_new, &current()));
    // Another server's entry is not ours, and a file that is not valid TOML is left alone.
    assert!(!codex_block_is_stale(&format!("[mcp_servers.other]\ncommand = \"{OLD}\"\n"), &current()));
    assert!(!codex_block_is_stale("[[[", &current()));
}

#[test]
fn a_stale_codex_entry_is_rewritten_and_the_other_servers_stay() {
    let home = temp("codex");
    let path = home.join(".codex").join("config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let foreign = "[mcp_servers.other]\ncommand = \"node\"\nargs = [\"other.js\"]\n";
    let old = format!(
        "[mcp_servers.potato-workspace]\ncommand = \"{OLD}\"\nargs = []\nenabled = true\ndefault_tools_approval_mode = \"approve\"\ntool_timeout_sec = 3600\n\n[mcp_servers.potato-workspace.env]\nPOTATO_WORKSPACE_BRIDGE_PORT_FILE = \"x\"\n"
    );
    fs::write(&path, format!("{foreign}\n{old}")).unwrap();
    let done = as_new_app(|| refresh_stale_in(&current(), Some(&home), &None, |_| None));
    assert_eq!(done.len(), 1);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains(NEW), "{text}");
    assert!(!text.contains("C:/Old"), "{text}");
    assert!(text.contains(foreign.trim()), "{text}");
    // A second pass finds nothing to do.
    assert!(as_new_app(|| refresh_stale_in(&current(), Some(&home), &None, |_| None)).is_empty());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn a_stale_opencode_entry_is_rewritten_and_other_entries_stay() {
    let dir = temp("opencode");
    let path = dir.join("opencode.json");
    let doc = json!({"mcp": {
        "other": {"type": "local", "command": ["node", "x.js"]},
        "potato-workspace": {"type": "local", "command": [OLD], "enabled": true,
            "environment": {"POTATO_WORKSPACE_BRIDGE_PORT_FILE": "x"}}
    }});
    fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    let done = as_new_app(|| refresh_stale_in(&current(), None, &Some(path.clone()), |_| None));
    assert_eq!(done.len(), 1);
    let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(after["mcp"]["potato-workspace"]["command"], json!([NEW]));
    assert_eq!(after["mcp"]["other"], doc["mcp"]["other"]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_current_entry_and_a_missing_one_are_not_touched() {
    let home = temp("current");
    let path = home.join(".codex").join("config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ours = as_new_app(|| codex_mcp_block(McpLaunchSource::Auto));
    fs::write(&path, &ours).unwrap();
    assert!(refresh_stale_in(&current(), Some(&home), &None, |_| None).is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), ours);
    // No file at all: nothing is created.
    let empty = temp("empty");
    assert!(refresh_stale_in(&current(), Some(&empty), &Some(empty.join("opencode.json")), |_| None).is_empty());
    assert!(!empty.join(".codex").exists() && !empty.join("opencode.json").exists());
    let _ = fs::remove_dir_all(&home);
    let _ = fs::remove_dir_all(&empty);
}

#[test]
fn a_claude_user_entry_that_is_stale_goes_through_the_claude_cli_only_then() {
    let home = temp("claude");
    // Current entry: the CLI is not asked.
    let done = as_new_app(|| refresh_stale_in(&current(), Some(&home), &None, |_| Some(json!({"command": NEW, "args": []}))));
    assert!(done.is_empty());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn the_status_check_calls_a_stale_entry_not_installed() {
    let dir = temp("status");
    let path = dir.join("opencode.json");
    let doc = json!({"mcp": {"potato-workspace": {"type": "local", "command": ["C:/Old/x.exe"], "enabled": true,
        "environment": {"POTATO_WORKSPACE_BRIDGE_PORT_FILE": "x"}}}});
    fs::write(&path, doc.to_string()).unwrap();
    as_new_app(|| {
        assert!(opencode_mcp_needs_refresh_path(&path, McpLaunchSource::Auto));
        assert!(!opencode_mcp_installed_path(&path, McpLaunchSource::Auto));
    });
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_stale_claude_project_file_is_flagged() {
    let dir = temp("claude-project");
    let doc = json!({"mcpServers": {"potato-workspace": {"command": OLD, "args": [],
        "env": {"POTATO_WORKSPACE_BRIDGE_PORT_FILE": "x"}}, "other": {"command": "node"}}});
    fs::write(dir.join(".mcp.json"), doc.to_string()).unwrap();
    as_new_app(|| assert!(claude_mcp_needs_refresh(&dir, McpLaunchSource::Auto)));
    let _ = fs::remove_dir_all(&dir);
}
