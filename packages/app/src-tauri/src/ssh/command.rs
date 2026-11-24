//! The `ssh` argument lists, built from validated parts only. No string from a person is ever joined into a
//! command line unchecked:
//! * options come first and are all fixed words or validated numbers and paths;
//! * `--` ends the options, so the destination can never be read as one;
//! * the one remote command is fixed text plus a folder that is quoted for the far POSIX shell (or refused) and a
//!   program that is a bare name (or refused).
//! `StrictHostKeyChecking` is `ask` for a terminal (the terminal asks the person) and `yes` for the check (no prompt
//! is possible there, so an unknown key is a plain "new machine" state). It is never `no`, `off` or `accept-new`.

use crate::ssh::model::{valid_folder, valid_program, PartError, SshHost};

/// What runs on the far machine in a terminal pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Remote {
    /// The person's login shell.
    Shell,
    /// One CLI agent by its bare program name (`claude`).
    Program(String),
}

/// `/bin/sh -l` reads the login profile, so the CLI agents the person installed under `~/.local/bin` are found.
const LOGIN_SH: &str = "/bin/sh -lc";

fn base(host: &SshHost) -> Vec<String> {
    let mut a = vec!["-p".to_string(), host.port.to_string()];
    if let Some(key) = &host.key_file {
        // By path only: ssh opens the file itself. This program never reads it.
        a.push("-i".into());
        a.push(key.clone());
    }
    a
}

/// A far folder as one shell word (or two joined words for a `~` form): quoted so nothing in it is special.
pub fn quote_folder(folder: &str) -> Result<String, PartError> {
    if !valid_folder(folder) {
        return Err(PartError::Folder);
    }
    if folder == "~" {
        return Ok("\"$HOME\"".into());
    }
    match folder.strip_prefix("~/") {
        Some(rest) if rest.is_empty() => Ok("\"$HOME\"".into()),
        Some(rest) => Ok(format!("\"$HOME\"/{}", single_quote(rest))),
        None => Ok(single_quote(folder)),
    }
}

/// `'...'` with every inner `'` written as `'\''`. Inside single quotes the POSIX shell reads nothing else.
pub fn single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The one remote command of a terminal pane.
pub fn remote_script(folder: Option<&str>, remote: &Remote) -> Result<String, PartError> {
    let mut script = String::new();
    if let Some(folder) = folder {
        let word = quote_folder(folder)?;
        script.push_str(&format!("cd {word} 2>/dev/null || echo 'That folder was not found. Starting in your home folder.'; "));
    }
    match remote {
        Remote::Shell => script.push_str("exec \"${SHELL:-/bin/sh}\" -l"),
        Remote::Program(name) => {
            if !valid_program(name) {
                return Err(PartError::Program);
            }
            // A bare name from `valid_program` needs no quoting; the single quotes keep the inner shell's parse trivial.
            script.push_str(&format!("exec {LOGIN_SH} 'exec {name}'"));
        }
    }
    Ok(script)
}

/// The arguments of `ssh` for a terminal pane (the PTY gives it a screen; `-t` asks the far side for one too).
pub fn terminal_argv(host: &SshHost, folder: Option<&str>, remote: &Remote) -> Result<Vec<String>, PartError> {
    let script = remote_script(folder, remote)?;
    let mut a = vec!["-t".to_string()];
    a.extend(base(host));
    for o in ["StrictHostKeyChecking=ask", "ServerAliveInterval=30", "ForwardAgent=no", "ForwardX11=no"] {
        a.push("-o".into());
        a.push(o.into());
    }
    a.push("--".into());
    a.push(host.destination());
    a.push(script);
    Ok(a)
}

/// The arguments of `ssh` for one fixed setup line (`install.rs`): the same hardening as the check, and no forwarding of anything.
/// Never a prompt, and `ClearAllForwardings` so nothing is tunnelled to this PC (plan S1).
pub fn setup_argv(host: &SshHost, line: &str) -> Vec<String> {
    let mut a = vec!["-T".to_string()];
    a.extend(base(host));
    for o in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "NumberOfPasswordPrompts=0",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
    ] {
        a.push("-o".into());
        a.push(o.into());
    }
    a.push("--".into());
    a.push(host.destination());
    a.push(line.to_string());
    a
}

/// The arguments of `ssh` for the read-only check: no screen, no prompt, a short timeout. `script` is fixed text
/// built by `check::script`.
pub fn check_argv(host: &SshHost, script: &str) -> Vec<String> {
    let mut a = vec!["-T".to_string()];
    a.extend(base(host));
    for o in ["BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=8", "NumberOfPasswordPrompts=0", "ForwardAgent=no", "ForwardX11=no"] {
        a.push("-o".into());
        a.push(o.into());
    }
    a.push("--".into());
    a.push(host.destination());
    a.push(script.to_string());
    a
}
