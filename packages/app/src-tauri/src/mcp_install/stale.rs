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

/// Rewrites this app's entry in every GLOBAL host config that still points at an older program. Entries
/// that are missing are not added (that is the person's choice), and nothing but the `potato-workspace` entry is
/// touched. Claude's user scope goes through its own CLI, which only runs when the entry is stale.
pub(super) fn refresh_stale_global_configs() -> Vec<EnsureMcpResult> {
    let Some(current) = current_for(McpLaunchSource::Auto) else { return Vec::new() };
    refresh_stale_in(&current, crate::project_path::home_dir().as_deref(), &opencode_global_config_path().ok(), claude_user_server_in_home)
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

/// App start / update: in the background, put right every host config entry this app wrote that still starts an
/// older MCP program (global host configs and the agent pack's recorded entries). Quiet; never blocks the start.
pub fn refresh_on_start() {
    let _ = std::thread::Builder::new().name("mcp-refresh-stale".into()).spawn(|| {
        let global = refresh_stale_global_configs();
        let pack = crate::agent_pack::service::refresh_stale_live();
        let rewritten = global.iter().filter(|r| r.changed).count() + pack.len();
        if rewritten > 0 {
            tracing::info!(rewritten, "refreshed host MCP entries that pointed at an older program");
        }
    });
}

#[cfg(test)]
#[path = "stale_tests.rs"]
mod tests;
