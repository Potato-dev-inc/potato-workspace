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

const INSTALLED: &str = "C:/Program Files/Potato Workspace/puppet-master-mcp.exe";

fn dev_current() -> McpLaunchSpec {
    McpLaunchSpec { command: "D:/work/x/resources/bin/puppet-master-mcp.exe".into(), args: vec![] }
}

fn host_home(name: &str) -> PathBuf {
    let home = temp(name);
    let claude = json!({"mcpServers": {
        "potato-workspace": {"command": INSTALLED, "args": []},
        "potato-workspace-dev": {"command": OLD, "args": []},
    }});
    fs::write(home.join(".claude.json"), serde_json::to_string_pretty(&claude).unwrap()).unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex").join("config.toml"),
        format!("# keep me\n[mcp_servers.potato-workspace]\ncommand = \"{INSTALLED}\"\nargs = []\n\n[mcp_servers.potato-workspace-dev]\ncommand = \"{OLD}\"\nargs = []\n"),
    )
    .unwrap();
    home
}

#[test]
fn a_dev_build_leaves_the_installed_entry_alone_and_refreshes_only_its_own() {
    let home = host_home("dev-guard");
    let n = refresh_for_build(false, &dev_current(), Some(&home), &None, claude_user_server_in_home);
    assert_eq!(n, 2);
    let claude: Value = serde_json::from_str(&fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(claude["mcpServers"]["potato-workspace"]["command"], INSTALLED);
    assert_eq!(claude["mcpServers"]["potato-workspace-dev"]["command"], dev_current().command);
    let toml = fs::read_to_string(home.join(".codex").join("config.toml")).unwrap();
    assert!(toml.contains("# keep me"), "{toml}");
    let doc: toml::Table = toml.parse().unwrap();
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["command"].as_str(), Some(INSTALLED));
    assert_eq!(doc["mcp_servers"]["potato-workspace-dev"]["command"].as_str(), Some(dev_current().command.as_str()));
    assert_eq!(refresh_for_build(false, &dev_current(), Some(&home), &None, claude_user_server_in_home), 0);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn a_dev_build_never_adds_a_missing_dev_entry() {
    let home = temp("dev-missing");
    fs::write(home.join(".claude.json"), json!({"mcpServers": {"potato-workspace": {"command": INSTALLED, "args": []}}}).to_string()).unwrap();
    assert_eq!(refresh_for_build(false, &dev_current(), Some(&home), &None, claude_user_server_in_home), 0);
    let claude: Value = serde_json::from_str(&fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
    assert!(claude["mcpServers"].get("potato-workspace-dev").is_none());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn an_installed_build_refreshes_its_own_stale_codex_entry_but_not_the_dev_one() {
    let home = temp("installed-refresh");
    let path = home.join(".codex").join("config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        format!("[mcp_servers.potato-workspace]\ncommand = \"{OLD}\"\nargs = []\n\n[mcp_servers.potato-workspace-dev]\ncommand = \"{OLD}\"\nargs = []\n"),
    )
    .unwrap();
    let n = as_new_app(|| refresh_for_build(true, &current(), Some(&home), &None, |_| None));
    assert_eq!(n, 1);
    let doc: toml::Table = fs::read_to_string(&path).unwrap().parse().unwrap();
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["command"].as_str(), Some(NEW));
    assert_eq!(doc["mcp_servers"]["potato-workspace-dev"]["command"].as_str(), Some(OLD));
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn only_a_release_exe_outside_a_target_folder_counts_as_installed() {
    let installed = Path::new("C:/Program Files/Potato Workspace/potato-workspace.exe");
    let dev = Path::new("E:/cargo-out/x/target/release/potato-workspace.exe");
    assert_eq!(running_from_installed_location(Some(installed)), !cfg!(debug_assertions));
    assert!(!running_from_installed_location(Some(dev)));
    assert!(!running_from_installed_location(None));
}

#[test]
fn a_profile_dev_build_never_writes_its_port_file_env_onto_the_installed_entry() {
    let home = temp("dev-env");
    let toml_before = format!("[mcp_servers.potato-workspace]
command = \"{INSTALLED}\"
args = []
");
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(home.join(".codex").join("config.toml"), &toml_before).unwrap();
    let json_before = json!({"mcpServers": {"potato-workspace": {"command": INSTALLED, "args": []}}}).to_string();
    fs::write(home.join(".claude.json"), &json_before).unwrap();
    let n = as_new_app(|| refresh_for_build(false, &dev_current(), Some(&home), &None, claude_user_server_in_home));
    assert_eq!(n, 0);
    assert_eq!(fs::read_to_string(home.join(".codex").join("config.toml")).unwrap(), toml_before);
    assert_eq!(fs::read_to_string(home.join(".claude.json")).unwrap(), json_before);
    let _ = fs::remove_dir_all(&home);
}
