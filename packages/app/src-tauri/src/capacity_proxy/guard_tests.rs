//! Guards: Share an agent is a desktop-window feature. No bridge route, MCP tool or phone route reaches it, the
//! webview can never read a lend key back, and the generic code never names an agent.

use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn sources(path: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let mut todo = vec![path.to_path_buf()];
    while let Some(next) = todo.pop() {
        if next.is_file() {
            if next.extension().is_some_and(|e| e == "rs") {
                found.push((next.clone(), std::fs::read_to_string(&next).unwrap()));
            }
            continue;
        }
        for entry in std::fs::read_dir(&next).unwrap().flatten() {
            todo.push(entry.path());
        }
    }
    found
}

#[test]
fn lend_is_not_reachable_from_bridge_mcp_or_phone_routes() {
    // Built from pieces so this file does not contain the words itself.
    let words = [["capacity", "_proxy"].concat(), ["lend", "_state"].concat(), ["lend", "_answer"].concat(), ["lend", "_revoke"].concat(), ["pm/", "lend"].concat()];
    let places = [
        "bridge",
        "tool_registry",
        "mcp_shim",
        "mcp_sessions",
        "mobile_pairing",
        "agent_runs",
        "pane_mcp",
        "companion",
        "pwa_server.rs",
        "mobile_tunnel.rs",
        "tunnel_config.rs",
        "mcp_runtime.rs",
        "team/mcp.rs",
        "team/phone.rs",
    ];
    let mut seen = 0;
    for place in places.iter().filter(|p| src_dir().join(p).exists()) {
        for (path, text) in sources(&src_dir().join(place)) {
            seen += 1;
            for word in &words {
                assert!(!text.contains(word.as_str()), "{} mentions {word}: lending must not be a bridge route, MCP tool or phone route", path.display());
            }
        }
    }
    assert!(seen > 20, "only {seen} files scanned");
}

#[test]
fn the_mcp_server_package_never_names_lend_commands() {
    let pkgs = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let word = ["lend", "_answer"].concat();
    for dir in ["mcp-server", "rust-mcp", "cli"].iter().map(|d| pkgs.join(d)).filter(|d| d.exists()) {
        let mut todo = vec![dir];
        while let Some(next) = todo.pop() {
            let name = next.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name == "node_modules" || name == "dist" || name == "target" {
                continue;
            }
            if next.is_file() {
                if let Ok(text) = std::fs::read_to_string(&next) {
                    assert!(!text.contains(&word), "{} mentions {word}", next.display());
                }
                continue;
            }
            if let Ok(rd) = std::fs::read_dir(&next) {
                todo.extend(rd.flatten().map(|e| e.path()));
            }
        }
    }
}

#[test]
fn commands_check_the_window_and_never_return_a_key() {
    let text = std::fs::read_to_string(src_dir().join("commands").join("lend.rs")).unwrap();
    assert!(text.contains("webview.label()"), "commands must check the calling window");
    for banned in ["read_secret", "secrets.get(", ".get(&key_slot", "borrowed_launch_env"] {
        assert!(!text.contains(banned), "commands/lend.rs must not touch a raw key: {banned}");
    }
    let commands = text.matches("#[tauri::command").count();
    let checked = text.matches("on(&webview)?").count() + text.matches("guard(&webview)?").count();
    assert!(commands >= 12 && checked >= commands, "{commands} commands, {checked} checks");
    // Lend keys are not UI secrets: the shared secret commands can't read them.
    assert!(!crate::secrets::is_ui_secret("lend:key:lp_x"));
    assert!(!crate::secrets::is_ui_secret("lend:link:lg_x"));
}

#[test]
fn generic_lend_code_never_names_an_agent() {
    for (path, text) in sources(&src_dir().join("capacity_proxy")) {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with("tests.rs") {
            continue;
        }
        let code: String = text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n").to_lowercase();
        let code = code.split("#[cfg(test)]").next().unwrap_or_default().to_string();
        for agent in ["\"claude\"", "\"codex\"", "\"opencode\"", "\"gemini\"", "anthropic_api_key", "api.anthropic.com"] {
            assert!(!code.contains(agent), "{name} names {agent}: per-agent facts belong in the spec");
        }
    }
}

#[test]
fn the_lender_never_reads_a_default_login_folder() {
    for (path, text) in sources(&src_dir().join("capacity_proxy")) {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with("tests.rs") {
            continue;
        }
        for banned in ["home_dir", "USERPROFILE", ".claude\\", ".claude/", "HOME\")", "dirs::"] {
            assert!(!text.contains(banned), "{name} uses {banned}: only an app-managed lend sign-in folder may be read");
        }
    }
}

#[test]
fn the_shim_listens_on_loopback_only_and_the_upstream_cannot_be_changed_outside_tests() {
    let shim = std::fs::read_to_string(src_dir().join("capacity_proxy").join("shim.rs")).unwrap();
    assert!(shim.contains("127.0.0.1"));
    assert!(!shim.contains("0.0.0.0"));
    let fwd = std::fs::read_to_string(src_dir().join("capacity_proxy").join("forward.rs")).unwrap();
    let setter = fwd.find("fn with_test_upstream").expect("the test override exists");
    assert!(fwd[..setter].trim_end().ends_with("#[cfg(test)]\n    pub") || fwd[..setter].contains("#[cfg(test)]\n    pub fn") || fwd[setter.saturating_sub(40)..setter].contains("#[cfg(test)]"), "the upstream override must be test-only");
    assert!(fwd.contains(".redirects(0)"), "no redirects");
}

#[test]
fn agent_and_helper_runs_refuse_a_borrowed_sign_in() {
    // The MCP run path and the automatic pick use the refusing check; person-picked paths keep the plain one.
    for (file, name) in [("agent_runs/headless/entry.rs", "run_agent path"), ("scores/pick/live.rs", "automatic pick")] {
        let text = std::fs::read_to_string(src_dir().join(file)).unwrap();
        assert!(text.contains("validate_for_agent_run"), "{name} must use validate_for_agent_run");
        assert!(!text.contains("validate_for_run("), "{name} must not use validate_for_run");
    }
}

#[test]
fn no_token_value_shows_in_the_auth_source_debug_output() {
    use crate::capacity_proxy::forward::{AuthSource, InjectedAuth};
    use crate::capacity_proxy::spec::ProxySpec;
    let dir = std::env::temp_dir().join(format!("pm-lend-guard-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"tok-GUARD-FAKE","expiresAt":1}}"#).unwrap();
    let spec = ProxySpec::parse(include_str!("../tui/claude/lend_proxy.toml")).unwrap();
    let account = spec.auth.account.as_ref().unwrap();
    let file = AuthSource::account(dir.to_str().unwrap(), account).unwrap();
    let fixed: AuthSource = InjectedAuth::from_spec(account, "tok-GUARD-FAKE").into();
    for source in [&file, &fixed] {
        let text = format!("{source:?} {source:#?}");
        assert!(!text.contains("tok-GUARD-FAKE"), "{text}");
    }
    let signin = crate::capacity_proxy::signin::SigninFile::new(dir.to_str().unwrap(), account).unwrap();
    assert!(!format!("{signin:?}").contains("tok-GUARD-FAKE"));
    let _ = std::fs::remove_dir_all(dir);
}
