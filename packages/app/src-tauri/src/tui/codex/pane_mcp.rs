//! Potato Workspace's MCP server for one Codex launch: `-c mcp_servers.<name>.<key>=<toml>` overrides.
//!
//! Checked live on 0.162.1 (`codex -c ... mcp list --json`): the overrides add the server for this
//! run only, next to the servers in the person's own `config.toml`, which is never written. Codex
//! has no append-only way to add a note (`developer_instructions` would replace the person's own),
//! so no note is added; the server's own `instructions` describe the tools.

use crate::tui::pane_mcp::{PaneMcpLaunch, PaneMcpRequest};

/// A TOML basic string. JSON string escapes are valid TOML ones for every character we write.
fn toml_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// A bare TOML key, or a quoted one.
fn toml_key(key: &str) -> String {
    if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        key.to_string()
    } else {
        toml_string(key)
    }
}

/// A TOML literal string `'text'` when it can hold the text, so no double quote reaches the command
/// line: Windows PowerShell 5.1 strips or mangles them in args to native programs. Otherwise a basic string.
fn toml_value(text: &str) -> String {
    if !text.contains('\'') && !text.chars().any(|c| c.is_control()) {
        format!("'{text}'")
    } else {
        toml_string(text)
    }
}

pub(super) fn launch(request: &PaneMcpRequest<'_>) -> PaneMcpLaunch {
    // The person already named a server with this name on the command line: leave it alone.
    let prefix = format!("mcp_servers.{}.", request.server.name);
    if request.user_args.iter().any(|a| a.starts_with(&prefix)) {
        return PaneMcpLaunch::default();
    }
    let server = request.server;
    let name = toml_key(&server.name);
    let args = server.args.iter().map(|a| toml_value(a)).collect::<Vec<_>>().join(", ");
    let env = server
        .env
        .iter()
        .map(|(k, v)| format!("{}={}", toml_key(k), toml_value(v)))
        .collect::<Vec<_>>()
        .join(", ");
    let overrides = [
        format!("mcp_servers.{name}.command={}", toml_value(&server.command)),
        format!("mcp_servers.{name}.args=[{args}]"),
        format!("mcp_servers.{name}.env={{{env}}}"),
        // Launched with `--ask-for-approval never`, Codex refuses the calls of a server that is not pre-approved.
        // Only this server (Potato Workspace's own), never a blanket setting.
        format!("mcp_servers.{name}.default_tools_approval_mode='approve'"),
    ];
    PaneMcpLaunch {
        env: Vec::new(),
        args: overrides.into_iter().flat_map(|o| ["-c".to_string(), o]).collect(),
        files: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::pane_mcp::PaneMcpServer;
    use std::path::Path;

    fn server() -> PaneMcpServer {
        PaneMcpServer {
            name: "potato-workspace".into(),
            command: "C:/Program Files/Potato Workspace/bin/puppet-master-mcp.exe".into(),
            args: vec![],
            env: vec![
                ("POTATO_WORKSPACE_BRIDGE_PORT_FILE".into(), "C:/Users/a b/potato-workspace.bridge.port".into()),
                ("POTATO_WORKSPACE_PANE_ID".into(), "pane-7".into()),
            ],
        }
    }

    fn request<'a>(server: &'a PaneMcpServer, user_args: &'a [String]) -> PaneMcpRequest<'a> {
        PaneMcpRequest { pane_id: "pane-7", user_args, server, dir: Path::new("C:/d"), note: "note" }
    }

    #[test]
    fn three_overrides_name_the_command_args_and_this_panes_env() {
        let s = server();
        let launch = launch(&request(&s, &[]));
        assert!(launch.env.is_empty() && launch.files.is_empty());
        assert_eq!(
            launch.args,
            vec![
                "-c",
                "mcp_servers.potato-workspace.command='C:/Program Files/Potato Workspace/bin/puppet-master-mcp.exe'",
                "-c",
                "mcp_servers.potato-workspace.args=[]",
                "-c",
                "mcp_servers.potato-workspace.env={POTATO_WORKSPACE_BRIDGE_PORT_FILE='C:/Users/a b/potato-workspace.bridge.port', POTATO_WORKSPACE_PANE_ID='pane-7'}",
                "-c",
                "mcp_servers.potato-workspace.default_tools_approval_mode='approve'",
            ]
        );
    }

    #[test]
    fn every_override_is_valid_toml_with_the_right_values() {
        let s = server();
        for pair in launch(&request(&s, &[])).args.chunks(2) {
            let (key, value) = pair[1].split_once('=').expect("key=value");
            let parsed: toml::Value = toml::from_str(&format!("v = {value}")).unwrap_or_else(|e| panic!("{key}: {e}"));
            assert!(parsed.get("v").is_some());
        }
    }

    #[test]
    fn a_server_the_person_already_named_on_the_command_line_is_left_alone() {
        let s = server();
        let mine = vec!["-c".to_string(), "mcp_servers.potato-workspace.command=\"x\"".to_string()];
        assert_eq!(launch(&request(&s, &mine)), PaneMcpLaunch::default());
    }

    #[test]
    fn a_quote_or_backslash_in_a_value_is_escaped() {
        let mut s = server();
        s.env = vec![("K".into(), "a\"b\\c".into())];
        let args = launch(&request(&s, &[])).args;
        let (_, value) = args[5].split_once('=').unwrap();
        let parsed: toml::Value = toml::from_str(&format!("v = {value}")).unwrap();
        assert_eq!(parsed["v"]["K"].as_str(), Some("a\"b\\c"));
    }

    #[test]
    fn a_backslash_path_stays_exact_as_a_literal_string() {
        let mut s = server();
        s.command = "C:\\Users\\a b\\x".into();
        s.env = vec![("K".into(), "C:\\Users\\a b\\x".into())];
        let args = launch(&request(&s, &[])).args;
        let (_, command) = args[1].split_once('=').unwrap();
        let parsed: toml::Value = toml::from_str(&format!("v = {command}")).unwrap();
        assert_eq!(parsed["v"].as_str(), Some("C:\\Users\\a b\\x"));
        let (_, env) = args[5].split_once('=').unwrap();
        let parsed: toml::Value = toml::from_str(&format!("v = {env}")).unwrap();
        assert_eq!(parsed["v"]["K"].as_str(), Some("C:\\Users\\a b\\x"));
    }

    #[test]
    fn a_value_with_a_single_quote_falls_back_to_a_double_quoted_string() {
        let mut s = server();
        s.command = "C:/Users/you/O'Brien/x.exe".into();
        let args = launch(&request(&s, &[])).args;
        let (_, command) = args[1].split_once('=').unwrap();
        assert!(command.starts_with('"'));
        let parsed: toml::Value = toml::from_str(&format!("v = {command}")).unwrap();
        assert_eq!(parsed["v"].as_str(), Some("C:/Users/you/O'Brien/x.exe"));
    }

    #[test]
    fn no_override_has_a_double_quote_for_a_normal_path() {
        let s = server();
        for arg in launch(&request(&s, &[])).args {
            assert!(!arg.contains('"'), "double quote in {arg}");
        }
    }
}
