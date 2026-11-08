//! Agents the user pointed Workspace at: inspect, save, plan, install, undo, forget. Temp folders only.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::custom::{self, MAX_FILE_BYTES};
use super::plan::AgentSpec;
use super::service::{self, Env};
use crate::mcp_install::declarative::HostLaunch;

fn temp(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("pm-agent-custom-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn launch() -> HostLaunch {
    HostLaunch {
        command: "npx".into(),
        args: vec!["-y".into(), "@potato-workspace/mcp".into()],
        env: vec![("POTATO_WORKSPACE_BRIDGE_PORT_FILE".into(), "C:/pm/bridge.port".into())],
        ..Default::default()
    }
}

/// A registered agent that declares nothing, like an agent Workspace has no settings location for.
fn bare(id: &str, label: &str) -> AgentSpec {
    AgentSpec { id: id.into(), label: label.into(), installed: false, mcp: None, skills: None }
}

fn put(home: &Path, rel: &str, text: &str) -> String {
    let p = home.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, text).unwrap();
    p.display().to_string()
}

fn inspect(home: &Path, path: &str) -> Result<custom::Inspection, String> {
    custom::inspect(path, home, &launch())
}

fn env(home: &Path, agents: Vec<AgentSpec>) -> Env {
    Env::new(agents, home.to_path_buf(), home.join("appdata"), launch())
}

#[test]
fn json_with_mcp_servers_copies_the_shape_of_a_sibling_entry() {
    let home = temp("json");
    let path = put(&home, "a/settings.json", r#"{"theme":"dark","mcpServers":{"other":{"type":"stdio","command":"node","args":["x.js"],"env":{"A":"1"},"autoApprove":["*"]}}}"#);
    let found = inspect(&home, &path).unwrap();
    assert_eq!((found.format.as_str(), found.key_path.as_str(), found.creates_list, found.already_present), ("json", "mcpServers", false, false));
    assert_eq!(found.entry["type"], "stdio");
    assert_eq!(found.entry["command"], "npx");
    assert_eq!(found.entry["args"], json!(["-y", "@potato-workspace/mcp"]));
    assert_eq!(found.entry["env"]["POTATO_WORKSPACE_BRIDGE_PORT_FILE"], "C:/pm/bridge.port");
    assert!(found.entry.get("autoApprove").is_none(), "only the known fields are copied");
}

#[test]
fn a_local_command_array_sibling_gives_the_command_array_shape() {
    let home = temp("local");
    let path = put(&home, "a/cfg.json", r#"{"mcp":{"x":{"type":"local","command":["node","x.js"],"environment":{}}}}"#);
    let found = inspect(&home, &path).unwrap();
    assert_eq!(found.key_path, "mcp");
    assert_eq!(found.entry, json!({"type":"local","command":["npx","-y","@potato-workspace/mcp"],"environment":{"POTATO_WORKSPACE_BRIDGE_PORT_FILE":"C:/pm/bridge.port"}}));
}

#[test]
fn nested_servers_and_generic_servers_are_found_only_when_they_look_right() {
    let home = temp("nested");
    let nested = put(&home, "n.json", r#"{"mcp":{"servers":{}}}"#);
    assert_eq!(inspect(&home, &nested).unwrap().key_path, "mcp.servers");
    let real = put(&home, "s.json", r#"{"servers":{"a":{"command":"x"}}}"#);
    assert_eq!(inspect(&home, &real).unwrap().key_path, "servers");
    // `servers` that are not server entries are not a list: a JSON file then gets its own.
    let other = put(&home, "o.json", r#"{"servers":{"a":"hello","b":3}}"#);
    let f = inspect(&home, &other).unwrap();
    assert_eq!((f.key_path.as_str(), f.creates_list), ("mcpServers", true));
    let zed = put(&home, "z.json", r#"{"context_servers":{"a":{"source":"custom","command":"x"}}}"#);
    assert_eq!(inspect(&home, &zed).unwrap().key_path, "context_servers");
}

#[test]
fn toml_mcp_servers_is_found() {
    let home = temp("toml");
    let path = put(&home, "c/config.toml", "model = \"x\"\n\n[mcp_servers.other]\ncommand = \"node\"\nargs = [\"x\"]\n");
    let found = inspect(&home, &path).unwrap();
    assert_eq!((found.format.as_str(), found.key_path.as_str()), ("toml", "mcp_servers"));
    assert_eq!(found.entry["command"], "npx");
}

#[test]
fn yaml_is_found_in_block_and_flow_style() {
    let home = temp("yaml");
    let block = put(&home, "y/config.yaml", "name: x\nmcpServers:\n  other:\n    command: node\n    args:\n      - x.js\n");
    let f = inspect(&home, &block).unwrap();
    assert_eq!((f.format.as_str(), f.key_path.as_str()), ("yaml", "mcpServers"));
    assert_eq!(f.entry["command"], "npx");
    let flow = put(&home, "y/flow.yml", "mcp_servers:\n  other: {\"command\":\"node\",\"args\":[]}\n");
    assert_eq!(inspect(&home, &flow).unwrap().key_path, "mcp_servers");
}

#[test]
fn no_list_is_created_for_json_only() {
    let home = temp("none");
    let json_file = put(&home, "a.json", r#"{"theme":"dark"}"#);
    let f = inspect(&home, &json_file).unwrap();
    assert_eq!((f.key_path.as_str(), f.creates_list), ("mcpServers", true));
    assert_eq!(f.entry["command"], "npx", "the default shape");
    let empty = put(&home, "e.json", "");
    assert!(inspect(&home, &empty).unwrap().creates_list);
    let toml_file = put(&home, "a.toml", "theme = \"dark\"\n");
    assert_eq!(inspect(&home, &toml_file).unwrap_err(), "This file has no MCP list Potato Workspace recognises.");
    let yaml_file = put(&home, "a.yaml", "theme: dark\n");
    assert_eq!(inspect(&home, &yaml_file).unwrap_err(), "This file has no MCP list Potato Workspace recognises.");
}

#[test]
fn an_existing_entry_is_reported_as_already_there() {
    let home = temp("present");
    let path = put(&home, "a.json", r#"{"mcpServers":{"potato-workspace":{"command":"mine"}}}"#);
    assert!(inspect(&home, &path).unwrap().already_present);
}

#[test]
fn json_with_comments_is_refused_with_a_clear_message() {
    let home = temp("jsonc");
    let path = put(&home, "a.jsonc", "{\n // hi\n \"mcpServers\": {}\n}\n");
    let err = inspect(&home, &path).unwrap_err();
    assert!(err.contains("comments"), "{err}");
}

#[test]
fn a_file_outside_the_home_folder_is_refused() {
    let home = temp("home");
    let elsewhere = temp("elsewhere");
    let path = put(&elsewhere, "a.json", "{}");
    let err = inspect(&home, &path).unwrap_err();
    assert!(err.contains("home folder"), "{err}");
    assert!(custom::check_skills_dir(&elsewhere.display().to_string(), &home).is_err());
    // `..` cannot climb out either.
    let sneaky = format!("{}/../{}/a.json", home.display(), elsewhere.file_name().unwrap().to_string_lossy());
    assert!(inspect(&home, &sneaky).is_err());
    // A relative path is not accepted at all.
    assert!(inspect(&home, "a.json").is_err());
}

#[test]
fn a_link_is_refused() {
    let home = temp("link");
    let real = put(&home, "real.json", "{}");
    let link = home.join("link.json");
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&real, &link).is_ok();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&real, &link).is_ok();
    if !made {
        eprintln!("skipped: this account may not create links");
        return;
    }
    let err = inspect(&home, &link.display().to_string()).unwrap_err();
    assert!(err.contains("link"), "{err}");
}

#[test]
fn a_folder_and_a_huge_file_are_refused() {
    let home = temp("big");
    let dir = home.join("d.json");
    fs::create_dir_all(&dir).unwrap();
    assert!(inspect(&home, &dir.display().to_string()).unwrap_err().contains("not a file"));
    let big = home.join("big.json");
    fs::write(&big, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
    assert!(inspect(&home, &big.display().to_string()).unwrap_err().contains("larger than 1 MB"));
}

#[test]
fn the_choice_survives_a_restart_and_forget_removes_it() {
    let home = temp("persist");
    let cfg = put(&home, "x/settings.json", r#"{"mcpServers":{}}"#);
    let skills = home.join("x/skills");
    fs::create_dir_all(&skills).unwrap();
    let e = env(&home, vec![bare("zed", "Zed")]);
    let saved = service::save_custom(&e, Some("zed"), "ignored", &cfg, Some(&skills.display().to_string())).unwrap();
    assert_eq!(saved["id"], "zed");
    assert_eq!(saved["name"], "Zed");
    // A new Env (an app restart) still has it.
    let hosts = custom::load(&home.join("appdata"));
    assert_eq!(hosts.len(), 1);
    assert_eq!((hosts[0].key_path.as_str(), hosts[0].format.as_str()), ("mcpServers", "json"));
    assert_eq!(hosts[0].skills_dir.as_deref(), Some(skills.display().to_string().as_str()));
    let again = service::call(&env(&home, vec![bare("zed", "Zed")]), "preview").unwrap();
    assert_eq!(again["custom"].as_array().unwrap().len(), 1);
    // Forget.
    let gone = service::forget_custom(&e, "zed").unwrap();
    assert_eq!(gone["removed"], true);
    assert!(custom::load(&home.join("appdata")).is_empty());
    assert!(!custom::store_path(&home.join("appdata")).exists());
    assert_eq!(service::forget_custom(&e, "zed").unwrap()["removed"], false);
    let after = service::call(&e, "preview").unwrap();
    assert_eq!(after["unsupported"].as_array().unwrap().len(), 1, "back to unsupported");
}

#[test]
fn the_plan_includes_the_users_host_and_install_and_undo_use_the_normal_machinery() {
    let home = temp("plan");
    let original = "{\n  \"theme\": \"dark\"\n}\n";
    let cfg = put(&home, "agent/settings.json", original);
    let skills = home.join("agent/skills");
    fs::create_dir_all(&skills).unwrap();
    let e = env(&home, vec![bare("zed", "Zed")]);

    let before = service::call(&e, "preview").unwrap();
    assert_eq!(before["unsupported"].as_array().unwrap().len(), 1);
    assert!(before["agents"].as_array().unwrap().is_empty());

    service::save_custom(&e, Some("zed"), "", &cfg, Some(&skills.display().to_string())).unwrap();
    let preview = service::call(&e, "preview").unwrap();
    assert!(preview["unsupported"].as_array().unwrap().is_empty());
    let row = &preview["agents"][0];
    assert_eq!(row["id"], "zed");
    assert_eq!(row["mcp"]["status"], "ready");
    assert!(row["mcp"]["diff"].as_str().unwrap().contains("potato-workspace"));
    assert_eq!(row["skills"]["status"], "ready");
    assert_eq!(fs::read_to_string(&cfg).unwrap(), original, "a preview writes nothing");

    let applied = service::call(&e, "apply").unwrap();
    assert_eq!(applied["agents"][0]["mcp"]["written"], true);
    let text = fs::read_to_string(&cfg).unwrap();
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["theme"], "dark");
    assert_eq!(parsed["mcpServers"]["potato-workspace"]["command"], "npx");
    assert!(skills.join("potato-workspace/SKILL.md").exists());
    assert!(Path::new(&format!("{cfg}.bak")).exists(), "the same .bak copy as the other agents");

    // A second install changes nothing, and an existing entry is left as it is.
    let second = service::call(&e, "apply").unwrap();
    assert_eq!(second["agents"][0]["mcp"]["status"], "unchanged");

    let undone = service::call(&e, "undo").unwrap();
    assert!(undone["skipped"].as_array().unwrap().is_empty());
    assert_eq!(fs::read_to_string(&cfg).unwrap(), original, "Undo puts the file back as it was");
    assert!(!skills.join("potato-workspace").exists());
}

#[test]
fn an_agent_workspace_does_not_know_becomes_its_own_row() {
    let home = temp("unknown");
    let cfg = put(&home, "mine/mcp.toml", "[mcp_servers.other]\ncommand = \"node\"\n");
    let e = env(&home, vec![bare("zed", "Zed")]);
    let saved = service::save_custom(&e, None, "  My Agent ", &cfg, None).unwrap();
    assert_eq!(saved["id"], "custom-my-agent");
    assert_eq!(saved["name"], "My Agent");
    let preview = service::call(&e, "preview").unwrap();
    let rows = preview["agents"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["label"], "My Agent");
    assert!(rows[0]["skills"].is_null());
    assert_eq!(preview["unsupported"].as_array().unwrap().len(), 1, "Zed is still unsupported");
    service::call(&e, "apply").unwrap();
    assert!(fs::read_to_string(&cfg).unwrap().contains("potato-workspace"));
    service::call(&e, "undo").unwrap();
    assert!(!fs::read_to_string(&cfg).unwrap().contains("potato-workspace"));
}

#[test]
fn saving_checks_the_name_the_agent_and_the_skills_folder() {
    let home = temp("checks");
    let cfg = put(&home, "a.json", "{}");
    let e = env(&home, vec![bare("zed", "Zed")]);
    assert!(service::save_custom(&e, None, "   ", &cfg, None).is_err());
    assert!(service::save_custom(&e, Some("nobody"), "", &cfg, None).is_err());
    let outside = temp("outside-skills");
    assert!(service::save_custom(&e, Some("zed"), "", &cfg, Some(&outside.display().to_string())).is_err());
    let not_a_dir = put(&home, "file.txt", "x");
    assert!(service::save_custom(&e, Some("zed"), "", &cfg, Some(&not_a_dir)).is_err());
    assert!(custom::load(&home.join("appdata")).is_empty(), "nothing is kept after a refusal");
}

#[test]
fn a_saved_host_that_moved_outside_home_is_an_error_row_not_a_write() {
    let home = temp("moved");
    let elsewhere = temp("moved-away");
    let target = elsewhere.join("a.json");
    fs::write(&target, "{}").unwrap();
    let host = custom::CustomHost {
        id: "zed".into(),
        name: "Zed".into(),
        config_path: target.display().to_string(),
        format: "json".into(),
        key_path: "mcpServers".into(),
        entry: json!({"command":"{command}","args":"{args}","env":"{env}"}),
        skills_dir: None,
    };
    let mut specs = vec![bare("zed", "Zed")];
    custom::merge(&mut specs, &[host]);
    let r = super::plan::run(&specs, &env(&home, vec![]).options, true).unwrap();
    assert_eq!(r.agents[0].mcp.as_ref().unwrap().status, "error");
    assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
}
