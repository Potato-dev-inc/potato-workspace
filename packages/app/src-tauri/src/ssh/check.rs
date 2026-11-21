//! The check: one fixed, read-only script run over `ssh`. It prints the system name and one line per program it
//! finds. Nothing is installed, written or started on the far machine. The program names are bare names from our own
//! list (git, node, and each agent's Linux program), checked with `valid_program`; no text from a person is in it.
//!
//! Chat over SSH is built in `acp.rs` (the old note here, that file and terminal requests would be answered on this PC, no longer
//! applies: the handshake advertises no file or terminal support, so the agent uses its own tools on the far machine).

use crate::ssh::model::valid_program;
use serde::Serialize;

/// Programs listed for every machine, whatever agents exist.
pub const BASE_PROGRAMS: [&str; 2] = ["git", "node"];

/// One agent CLI that could be looked for: its id, its label and the bare program.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentProgram {
    pub id: String,
    pub label: String,
    pub program: String,
}

/// The agent CLIs worth looking for: every registered agent that has a bare Linux program.
pub fn agent_programs() -> Vec<AgentProgram> {
    let mut out: Vec<AgentProgram> = Vec::new();
    for d in crate::tui::descriptors() {
        let Some(program) = crate::tui::linux_program(d.id) else { continue };
        if valid_program(&program) && !out.iter().any(|p| p.program == program) {
            out.push(AgentProgram { id: d.id.to_string(), label: d.label.clone(), program });
        }
    }
    out
}

/// The fixed script for `programs` (names failing `valid_program` are dropped). Single quotes never appear in it, so
/// it can sit inside the one remote word. Only `uname` and `command -v` run.
pub fn script(programs: &[String]) -> String {
    let mut names: Vec<&str> = BASE_PROGRAMS.to_vec();
    for p in programs {
        if valid_program(p) && !names.contains(&p.as_str()) {
            names.push(p);
        }
    }
    format!(
        "echo \"os=$(uname -s 2>/dev/null)\"; for p in {}; do if command -v \"$p\" >/dev/null 2>&1; then echo \"has=$p\"; fi; done",
        names.join(" ")
    )
}

/// The whole remote command: the script run by a login shell, as one word.
pub fn remote_command(programs: &[String]) -> String {
    format!("/bin/sh -lc '{}'", script(programs))
}

/// What the script printed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Facts {
    /// `Linux`, `Darwin`, ... (cleaned, short).
    pub os: Option<String>,
    /// Program names found, only ones that were asked for.
    pub found: Vec<String>,
}

/// Reads the script's output. Lines that are not ours are ignored; a program that was not asked for is dropped.
pub fn parse(stdout: &str, asked: &[String]) -> Facts {
    let mut facts = Facts::default();
    let all: Vec<&str> = BASE_PROGRAMS.iter().copied().chain(asked.iter().map(String::as_str)).collect();
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(os) = line.strip_prefix("os=") {
            let os: String = os.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).take(24).collect();
            if !os.is_empty() {
                facts.os = Some(os);
            }
        } else if let Some(p) = line.strip_prefix("has=") {
            if all.contains(&p) && !facts.found.iter().any(|f| f == p) {
                facts.found.push(p.to_string());
            }
        }
    }
    facts
}
