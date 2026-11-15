//! Spotting a host config entry that still starts an older MCP program: a path from a previous install folder,
//! or the `npx` package, while this app has its own bundled program. Only the entry named `potato-workspace`
//! is ever looked at; another server in the same file is not ours.

use super::*;
use crate::mcp_runtime::McpLaunchSpec;

/// One path or word in a launch line, compared the way the OS compares it (slashes and, on Windows, case).
fn same_word(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = crate::app_paths::path_for_host_config(s);
        if cfg!(windows) {
            s.to_ascii_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

/// Whether `command` + `args` start something other than `current`.
pub(crate) fn launch_is_stale(command: &str, args: &[String], current: &McpLaunchSpec) -> bool {
    !same_word(command, &current.command)
        || args.len() != current.args.len()
        || args.iter().zip(&current.args).any(|(a, b)| !same_word(a, b))
}

/// This app's bundled launch, only when `source` asks for it and a bundled program exists.
pub(super) fn current_for(source: McpLaunchSource) -> Option<McpLaunchSpec> {
    if source != McpLaunchSource::Auto {
        return None;
    }
    crate::mcp_runtime::bundled_launch_spec()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Claude `.mcp.json` / `~/.claude.json` server: `command` + `args`.
pub(crate) fn json_server_is_stale(server: &Value, current: &McpLaunchSpec) -> bool {
    let command = server.get("command").and_then(Value::as_str).unwrap_or_default();
    launch_is_stale(command, &strings(server.get("args")), current)
}

/// OpenCode entry: `command` is the whole argv.
pub(crate) fn opencode_entry_is_stale(entry: &Value, current: &McpLaunchSpec) -> bool {
    let argv = strings(entry.get("command"));
    match argv.split_first() {
        Some((command, args)) => launch_is_stale(command, args, current),
        None => true,
    }
}

/// Codex `config.toml`: the `[mcp_servers.potato-workspace]` table.
pub(crate) fn codex_block_is_stale(content: &str, current: &McpLaunchSpec) -> bool {
    let Ok(doc) = content.parse::<toml::Table>() else { return false };
    let Some(entry) = doc.get("mcp_servers").and_then(|t| t.get(MCP_SERVER_NAME)) else { return false };
    let command = entry.get("command").and_then(|v| v.as_str()).unwrap_or_default();
    let args: Vec<String> = entry
        .get("args")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    launch_is_stale(command, &args, current)
}

fn claude_user_server_in_home(home: &Path) -> Option<Value> {
    let doc = read_json_safe(&home.join(".claude.json"))?;
    doc.get("mcpServers")?.get(MCP_SERVER_NAME).cloned()
}

pub(super) fn refresh_stale_in(
    current: &McpLaunchSpec,
    home: Option<&Path>,
    opencode: &Option<PathBuf>,
    claude_user: fn(&Path) -> Option<Value>,
) -> Vec<EnsureMcpResult> {
    let mut out = Vec::new();
    if let Some(home) = home {
        let codex = home.join(".codex").join("config.toml");
        if fs::read_to_string(&codex).is_ok_and(|text| codex_block_is_stale(&text, current)) {
            if let Ok(result) = ensure_codex_mcp_at(&codex, McpLaunchSource::Auto, "codex_cli_global") {
                out.push(result);
            }
        }
        if claude_user(home).is_some_and(|server| json_server_is_stale(&server, current)) {
            out.push(ensure_claude_user_mcp_with_source(McpLaunchSource::Auto));
        }
    }
    if let Some(path) = opencode {
        let stale = read_json_safe(path)
            .and_then(|doc| doc.pointer(&format!("/mcp/{MCP_SERVER_NAME}")).cloned())
            .is_some_and(|entry| opencode_entry_is_stale(&entry, current));
        if stale {
            if let Ok(result) = ensure_opencode_mcp_at(path, McpLaunchSource::Auto, "opencode_cli_global") {
                out.push(result);
            }
        }
    }
    out
}

/// The entry a dev build keeps for itself. A dev build never touches `potato-workspace`.
pub const DEV_MCP_SERVER_NAME: &str = "potato-workspace-dev";

/// Whether this running app is an installed copy. A debug build, or any exe inside a cargo `target` folder, is a
/// dev build: its bundled program lives in a work folder, so it must never be written over an installed entry.
pub(crate) fn running_from_installed_location(exe: Option<&Path>) -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    match exe {
        Some(path) => !path.components().any(|c| c.as_os_str().eq_ignore_ascii_case("target")),
        None => false,
    }
}

/// Dev build: point only an existing `potato-workspace-dev` entry (Claude `~/.claude.json`, Codex `config.toml`)
/// at this build's program. Nothing is added, and no other entry is rewritten. Returns how many changed.
pub(super) fn refresh_dev_entries_in(current: &McpLaunchSpec, home: &Path) -> usize {
    let mut changed = 0;
    let claude = home.join(".claude.json");
    if let Some(mut doc) = read_json_safe(&claude) {
        if let Some(server) = doc.get_mut("mcpServers").and_then(|s| s.get_mut(DEV_MCP_SERVER_NAME)).and_then(Value::as_object_mut) {
            let command = server.get("command").and_then(Value::as_str).unwrap_or_default().to_string();
            if launch_is_stale(&command, &strings(server.get("args")), current) {
                server.insert("command".into(), json!(current.command));
                server.insert("args".into(), json!(current.args));
                if write_json_pretty(&claude, &doc).is_ok() {
                    changed += 1;
                }
            }
        }
    }
    let codex = home.join(".codex").join("config.toml");
    if let Ok(text) = fs::read_to_string(&codex) {
        if let Ok(mut doc) = text.parse::<toml_edit::Document>() {
            if let Some(entry) = doc.get_mut("mcp_servers").and_then(|t| t.get_mut(DEV_MCP_SERVER_NAME)).and_then(|t| t.as_table_like_mut()) {
                let command = entry.get("command").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let args: Vec<String> = entry
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                if launch_is_stale(&command, &args, current) {
                    entry.insert("command", toml_edit::value(current.command.as_str()));
                    let mut list = toml_edit::Array::new();
                    for a in &current.args {
                        list.push(a.as_str());
                    }
                    entry.insert("args", toml_edit::value(list));
                    if fs::write(&codex, doc.to_string()).is_ok() {
                        changed += 1;
                    }
                }
            }
        }
    }
    changed
}

/// The start-up refresh, split by who is running. An installed app refreshes entries that start an older copy of
/// itself; a dev build only looks after its own `-dev` entry. Returns how many host entries were rewritten.
pub(super) fn refresh_for_build(
    installed: bool,
    current: &McpLaunchSpec,
    home: Option<&Path>,
    opencode: &Option<PathBuf>,
    claude_user: fn(&Path) -> Option<Value>,
) -> usize {
    if installed {
        refresh_stale_in(current, home, opencode, claude_user).iter().filter(|r| r.changed).count()
    } else {
        home.map_or(0, |h| refresh_dev_entries_in(current, h))
    }
}

/// App start / update: in the background, put right every host config entry this app wrote that still starts an
/// older MCP program (global host configs and the agent pack's recorded entries). Quiet; never blocks the start.
/// A dev build skips all of that except its own `potato-workspace-dev` entry.
pub fn refresh_on_start() {
    let _ = std::thread::Builder::new().name("mcp-refresh-stale".into()).spawn(|| {
        let installed = running_from_installed_location(std::env::current_exe().ok().as_deref());
        let Some(current) = current_for(McpLaunchSource::Auto) else { return };
        let home = crate::project_path::home_dir();
        let opencode = opencode_global_config_path().ok();
        let mut rewritten = refresh_for_build(installed, &current, home.as_deref(), &opencode, claude_user_server_in_home);
        if installed {
            rewritten += crate::agent_pack::service::refresh_stale_live().len();
        }
        if rewritten > 0 {
            tracing::info!(rewritten, installed, "refreshed host MCP entries that pointed at an older program");
        }
    });
}

#[cfg(test)]
#[path = "stale_tests.rs"]
mod tests;
