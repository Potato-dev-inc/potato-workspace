//! Guards: the Discord bot is a desktop-window feature with no way to act. It is not a bridge route, an MCP tool
//! or a phone route; the webview can never read the token; and nothing in the bot's code can reach a pane, a
//! tool, a shell or the companion's memory.

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
    assert!(!found.is_empty(), "no sources under {}", path.display());
    found
}

/// The code of a file without its `#[cfg(test)] mod tests` part (tests may name what they forbid).
fn code_only(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    text.split("#[cfg(test)]\nmod tests {").next().unwrap_or(&text).to_string()
}

#[test]
fn the_discord_bot_is_not_reachable_from_bridge_mcp_or_phone_routes() {
    // Built from pieces so this file does not contain the word itself.
    let word = ["discord", "_bot"].concat();
    let places = ["bridge", "tool_registry", "mcp_shim", "mcp_sessions", "mobile_pairing", "agent_runs", "pwa_server.rs", "mobile_tunnel.rs", "tunnel_config.rs", "mcp_runtime.rs"];
    for place in places.iter().filter(|p| src_dir().join(p).exists()) {
        for (path, text) in sources(&src_dir().join(place)) {
            assert!(!text.contains(&word), "{} mentions {word}: it must not be a bridge route, MCP tool or phone route", path.display());
        }
    }
}

#[test]
fn the_token_is_not_a_ui_secret_so_no_generic_secret_command_can_read_it() {
    let name = super::token::key_name("mochi");
    assert!(!crate::secrets::is_ui_secret(&name));
    assert!(!crate::secrets::is_provider_secret(&name));
    assert!(!crate::secrets::is_custom_ai_secret(&name));
    for (path, text) in sources(&src_dir().join("commands").join("secrets.rs")) {
        assert!(!code_only(&text).contains("discord_bot"), "{} must not handle the bot token", path.display());
    }
}

#[test]
fn commands_check_the_window_and_never_return_the_token() {
    let text = std::fs::read_to_string(src_dir().join("commands").join("discord_bot.rs")).unwrap();
    assert!(text.contains("webview.label()"), "commands must check the calling window");
    for banned in ["read_with", ".expose(", "read_secret", "Token"] {
        assert!(!text.contains(banned), "commands/discord_bot.rs must not touch the raw token: {banned}");
    }
    let commands = text.matches("#[tauri::command]").count();
    let checked = text.matches("on(&webview)?;").count() + text.matches("guard(&webview)?;").count();
    assert!(commands >= 5 && checked >= commands, "{commands} commands, {checked} checks");
}

#[test]
fn only_the_gateway_and_the_poster_use_the_token_text_and_none_of_that_goes_to_a_log() {
    let root = src_dir().join("discord_bot");
    let mut users = Vec::new();
    for (path, text) in sources(&root) {
        if matches!(path.file_name().and_then(|n| n.to_str()), Some("guard_tests.rs" | "tests.rs")) {
            continue;
        }
        let code = code_only(&text);
        for line in code.lines().filter(|l| l.contains(".expose(")) {
            assert!(!["tracing", "println", "eprintln", "log::", "dbg!", "panic!", "expect(", "unwrap_or_else(|e|"].iter().any(|b| line.contains(b)), "{}: {line}", path.display());
            users.push(path.file_name().unwrap().to_string_lossy().to_string());
        }
    }
    users.sort();
    users.dedup();
    assert_eq!(users, vec!["gateway.rs".to_string(), "rest.rs".to_string()]);
}

#[test]
fn the_token_type_cannot_be_printed_or_saved() {
    let text = std::fs::read_to_string(src_dir().join("discord_bot").join("token.rs")).unwrap();
    let at = text.find("pub struct Token(").expect("the token type");
    let derives: Vec<&str> = text[..at].lines().rev().take(3).filter(|l| l.trim_start().starts_with("#[derive")).collect();
    assert_eq!(derives, vec!["#[derive(Clone)]"], "Token may derive Clone only");
    assert!(!text.contains("impl std::fmt::Debug for Token") && !text.contains("impl fmt::Debug for Token") && !text.contains("impl std::fmt::Display for Token"));
}

#[test]
fn the_bot_and_the_brain_have_no_way_to_reach_a_pane_a_tool_a_shell_or_memory() {
    // Built from pieces, so this file does not contain what it forbids.
    let banned: Vec<String> = [
        ["pane", "_outbox"].concat(),
        ["tool", "_registry"].concat(),
        ["shell", "_exec"].concat(),
        ["agent", "_runs"].concat(),
        ["mcp", "_"].concat(),
        ["pty", "::"].concat(),
        ["companion::", "memory"].concat(),
        ["companion::", "delegate"].concat(),
        ["companion::", "service"].concat(),
        ["companion::", "live"].concat(),
        ["std::", "process"].concat(),
        ["Command", "::new"].concat(),
        ["sand", "box"].concat(),
    ]
    .to_vec();
    let places = [src_dir().join("discord_bot"), src_dir().join("companion").join("brain"), src_dir().join("companion").join("social")];
    for place in places {
        for (path, text) in sources(&place) {
            // The test files may talk about what they forbid; the code may not.
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if matches!(name.as_str(), "guard_tests.rs" | "tests.rs" | "fake_gateway.rs") {
                continue;
            }
            let code = code_only(&text);
            for word in &banned {
                // `//!` and `///` lines are prose.
                let hit = code.lines().filter(|l| !l.trim_start().starts_with("//")).find(|l| l.contains(word.as_str()));
                assert!(hit.is_none(), "{} reaches for `{word}`: {hit:?}", path.display());
            }
        }
    }
}

#[test]
fn the_real_gateway_and_poster_only_name_discord_in_one_place() {
    let mut hosts = 0;
    for (path, text) in sources(&src_dir().join("discord_bot")) {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if matches!(name.as_str(), "guard_tests.rs" | "tests.rs" | "fake_gateway.rs") {
            continue;
        }
        hosts += code_only(&text).lines().filter(|l| !l.trim_start().starts_with("//")).filter(|l| l.contains("gateway.discord.gg") || l.contains("discord.com/api")).count();
    }
    assert_eq!(hosts, 2, "the two real addresses live in mod.rs and nowhere else");
}
