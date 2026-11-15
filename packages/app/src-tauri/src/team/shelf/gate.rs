//! The untrusted-command gate. A tool from a teammate starts a program on this PC, so the person sees
//! the exact command line first, and anything that runs a shell, a downloaded script, a file by path
//! or a program this app does not know is refused until they tick "I trust this".

use super::model::{ToolDef, ToolTransport};

/// Programs that only start a package or a script the person can read about: no tick needed.
const LAUNCHERS: &[&str] = &["npx", "uvx", "bunx", "pnpx", "node", "python", "python3", "py", "deno", "bun", "docker", "uv", "pipx", "dotnet", "java"];
/// Programs that run whatever they are told.
const SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh", "wsl", "busybox", "env", "sudo", "su", "runas", "start", "wscript", "cscript", "mshta",
    "osascript", "eval", "exec",
];
/// Flags that hand the next text to a program as a command line, whatever the program.
const RUN_TEXT_FLAGS: &[&str] = &["/c", "/k", "--call", "-command", "-encodedcommand", "-enc", "-ec"];
/// Flags that make an interpreter run text instead of a file (`node -e`, `python -c`). Not checked for
/// other programs: `docker run -e NAME` and `npx -p pkg` are ordinary.
const INTERPRETERS: &[&str] = &["node", "python", "python3", "py", "deno", "bun", "ruby", "perl", "php"];
const INTERPRETER_FLAGS: &[&str] = &["-c", "-e", "--eval", "-p", "--print"];
const DOWNLOADERS: &[&str] = &["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod", "bitsadmin", "certutil"];

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    /// The exact line the item would run, or the address it would talk to. Never shortened.
    pub shown: String,
    /// Refused until the person ticks "I trust this".
    pub needs_trust: bool,
    /// Plain-English reasons, one short sentence each.
    pub reasons: Vec<String>,
}

fn base_name(command: &str) -> String {
    let last = command.rsplit(['/', '\\']).next().unwrap_or(command).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1", ".com", ".sh"] {
        if let Some(stem) = last.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    last
}

fn quote(arg: &str) -> String {
    if arg.is_empty() || arg.contains(char::is_whitespace) {
        format!("\"{arg}\"")
    } else {
        arg.to_string()
    }
}

fn has_meta(text: &str) -> bool {
    text.contains(['|', ';', '&', '>', '<', '`', '\n']) || text.contains("$(") || text.contains("${")
}

fn is_local_url(url: &str) -> bool {
    let rest = url.split("://").nth(1).unwrap_or("");
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").rsplit('@').next().unwrap_or("");
    let host = host.rsplit_once(':').map_or(host, |(h, _)| h).trim_matches(['[', ']']);
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host.ends_with(".localhost")
}

/// What adding this tool would start or contact, and whether the person must say "I trust this".
pub fn assess(tool: &ToolDef) -> Risk {
    match tool.transport {
        Some(ToolTransport::Stdio) => assess_command(tool),
        Some(ToolTransport::Http) => {
            let url = tool.url.clone().unwrap_or_default();
            let mut reasons = Vec::new();
            if url.starts_with("http://") && !is_local_url(&url) {
                reasons.push("This address is not secure (http, not https).".to_string());
            }
            // Nothing runs on this PC for an address, so it never needs the tick on its own.
            Risk { shown: url, needs_trust: false, reasons }
        }
        _ => Risk { shown: String::new(), needs_trust: true, reasons: vec!["Potato Workspace does not know what this does.".into()] },
    }
}

fn assess_command(tool: &ToolDef) -> Risk {
    let command = tool.command.clone().unwrap_or_default();
    let mut shown = quote(&command);
    for a in &tool.args {
        shown.push(' ');
        shown.push_str(&quote(a));
    }
    let base = base_name(&command);
    let mut reasons: Vec<String> = Vec::new();
    let mut push = |text: &str| {
        if !reasons.iter().any(|r| r == text) {
            reasons.push(text.to_string());
        }
    };
    if SHELLS.contains(&base.as_str()) {
        push("This runs a shell. A shell can run anything.");
    } else if command.contains(['/', '\\']) || command.starts_with(['.', '~']) {
        push("This runs a file by its path.");
    } else if !LAUNCHERS.contains(&base.as_str()) {
        push("This runs a program Potato Workspace does not know.");
    }
    if has_meta(&command) || tool.args.iter().any(|a| has_meta(a)) {
        push("The command line chains or redirects commands.");
    }
    let lower_args: Vec<String> = tool.args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let interpreter_text = INTERPRETERS.contains(&base.as_str()) && lower_args.iter().any(|a| INTERPRETER_FLAGS.contains(&a.as_str()));
    if interpreter_text || lower_args.iter().any(|a| RUN_TEXT_FLAGS.contains(&a.as_str())) {
        push("A flag hands text to run as a command.");
    }
    if DOWNLOADERS.contains(&base.as_str()) || lower_args.iter().any(|a| DOWNLOADERS.contains(&a.as_str())) {
        push("This downloads something from the web.");
    }
    if lower_args.iter().any(|a| a.starts_with("http://") || a.starts_with("https://") || a.starts_with("git+") || a.starts_with("github:")) {
        push("This fetches a program from a web address.");
    }
    Risk { shown, needs_trust: !reasons.is_empty(), reasons }
}
