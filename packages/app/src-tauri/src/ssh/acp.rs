//! A chat (ACP) agent that runs ON an SSH machine: the adapter's stdio is the `ssh` process's stdio.
//!
//! What goes over the wire is one fixed remote command plus data, and the data can never be read as shell syntax:
//!
//! ```text
//! ssh -T [-p port] [-i key] -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no ... -- user@host \
//!     exec /bin/sh -lc '<FIXED SCRIPT>' sh x<folder> x<arg0> x<arg1> ...
//! ```
//!
//! * `<FIXED SCRIPT>` is a constant of this file. It holds no single quote (so it is exactly one single-quoted word
//!   for the far login shell) and nothing taken from a person.
//! * Every datum (the folder, the program, each program argument) is sent as `x` followed by the byte values in
//!   three-digit octal (`A` is `x101`). That alphabet is `x` and `0-7` only, so no shell, however it parses the
//!   command line, finds a quote, space, `$`, backtick, `;`, `-`, newline or `~` in it. The fixed script rebuilds each
//!   datum byte for byte with `printf`, then runs `cd -- <folder>` and `exec "$@"` (the program and its arguments as
//!   separate words, never re-parsed).
//! * No secret is in the argument list: it holds the machine's address, an optional key FILE PATH (ssh opens the
//!   file; this program never does), the fixed script and the encoded folder and program. No environment variable of
//!   this PC is forwarded (`SendEnv` is not used, `ForwardAgent=no`).
//!
//! Assumptions (each one is also in the review notes):
//! 1. The far user's login shell parses single quotes the POSIX way (sh, bash, zsh, dash, ksh, fish). `csh` and
//!    `tcsh` are not supported. Even where the fixed script would fail to run, no datum can become a command: data
//!    is `x` and digits only.
//! 2. The far machine has a POSIX `/bin/sh` with `printf` and `$((..))`. (Linux, macOS, the BSDs.)
//! 3. `/bin/sh -l` reads the person's login profile so `~/.local/bin` and Node version managers put the adapter on
//!    PATH. A profile that prints text to stdout would corrupt the protocol; that is a far-machine setup problem and
//!    is reported as "did not answer".
//! 4. The host key is already known (the person said yes once in a terminal). `StrictHostKeyChecking=yes` plus
//!    `BatchMode=yes` means an unknown or changed key is a refusal, never a prompt or an automatic accept.

use crate::ssh::model::{classify, valid_folder, valid_program, PartError, SshHost, SshState};
use std::ffi::OsString;
use std::path::PathBuf;

/// The longest folder or argument this accepts (bytes), so the command line stays small.
const MAX_DATUM: usize = 1024;
/// The most bytes of data in one start (each byte is sent as 3 characters, and Windows limits a command line to 32 K).
const MAX_TOTAL: usize = 4096;
/// The most program words (the program and its arguments).
const MAX_WORDS: usize = 16;

/// The fixed far script. Facts for review:
/// * no single quote, no `!` (csh history), no newline;
/// * `dec` turns `x<octal triples>` back into the original bytes. A trailing `x` is added before the command
///   substitution and removed after, because a substitution drops trailing newlines;
/// * a folder `~` or `~/...` is the far user's home;
/// * `cd --` so a folder cannot be read as an option; a missing folder exits 97 with one fixed line;
/// * `exec "$@"` runs the program with its arguments as separate words. A missing program exits 127 (the shell says
///   `not found`).
pub const FAR_SCRIPT: &str = "bs=$(printf \"\\134\"); \
dec() { s=${1#x}; f=; while [ -n \"$s\" ]; do t=${s%\"${s#???}\"}; f=\"$f$bs$t\"; s=${s#???}; done; printf \"${f}x\"; }; \
c=$(dec \"$1\"); c=${c%x}; shift; \
case \"$c\" in \"~\") c=$HOME;; \"~/\"*) c=$HOME/${c#\"~/\"};; esac; \
cd -- \"$c\" || { echo \"pm-ssh: the folder was not found\" >&2; exit 97; }; \
n=$#; while [ \"$n\" -gt 0 ]; do a=$(dec \"$1\"); shift; set -- \"$@\" \"${a%x}\"; n=$((n-1)); done; \
exec \"$@\"";

/// Why a start was refused before ssh ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    Part(PartError),
    TooLong,
    NoProgram,
}

impl RemoteError {
    pub fn sentence(&self) -> String {
        match self {
            Self::Part(p) => p.sentence().to_string(),
            Self::TooLong => "That folder or command is too long to send.".into(),
            Self::NoProgram => "This agent has no chat program for another computer yet.".into(),
        }
    }
}

/// `x` then each byte as three octal digits. The alphabet is `x` and `0-7`.
pub fn encode(datum: &str) -> String {
    let mut out = String::with_capacity(1 + datum.len() * 3);
    out.push('x');
    for b in datum.bytes() {
        out.push(char::from(b'0' + (b >> 6)));
        out.push(char::from(b'0' + ((b >> 3) & 7)));
        out.push(char::from(b'0' + (b & 7)));
    }
    out
}

/// The inverse of [`encode`] (tests: proves the alphabet is closed and nothing is lost). `None` for anything else.
#[cfg(test)]
pub fn decode(word: &str) -> Option<String> {
    let rest = word.strip_prefix('x')?;
    if rest.len() % 3 != 0 || !rest.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return None;
    }
    let mut bytes = Vec::with_capacity(rest.len() / 3);
    for chunk in rest.as_bytes().chunks(3) {
        let v = u32::from(chunk[0] - b'0') * 64 + u32::from(chunk[1] - b'0') * 8 + u32::from(chunk[2] - b'0');
        bytes.push(u8::try_from(v).ok()?);
    }
    String::from_utf8(bytes).ok()
}

/// The hardened `ssh` argument list shared by every read over a saved machine (chat start, file and git reads): no screen, no prompt,
/// strict host keys, nothing forwarded, no connection sharing, ending with `--` and the destination. The caller appends ONE remote command.
pub fn ssh_base_args(host: &SshHost, connect_timeout_secs: u32) -> Vec<String> {
    let mut a = vec!["-T".to_string(), "-p".to_string(), host.port.to_string()];
    if let Some(key) = &host.key_file {
        a.push("-i".into());
        a.push(key.clone());
    }
    for o in [
        "BatchMode=yes".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        format!("ConnectTimeout={connect_timeout_secs}"),
        "NumberOfPasswordPrompts=0".to_string(),
        "ServerAliveInterval=30".to_string(),
        "ForwardAgent=no".to_string(),
        "ForwardX11=no".to_string(),
        "ClearAllForwardings=yes".to_string(),
        "PermitLocalCommand=no".to_string(),
        "RemoteCommand=none".to_string(),
        "RequestTTY=no".to_string(),
        "ControlPath=none".to_string(),
    ] {
        a.push("-o".into());
        a.push(o);
    }
    a.push("--".into());
    a.push(host.destination());
    a
}

/// The `ssh` arguments for a chat adapter on `host` in `folder`. `words` is the program (a bare name, checked with
/// `valid_program`) followed by its arguments (any text without a NUL).
pub fn acp_argv(host: &SshHost, folder: &str, words: &[String]) -> Result<Vec<String>, RemoteError> {
    if !valid_folder(folder) {
        return Err(RemoteError::Part(PartError::Folder));
    }
    let Some((program, args)) = words.split_first() else { return Err(RemoteError::NoProgram) };
    if !valid_program(program) {
        return Err(RemoteError::Part(PartError::Program));
    }
    let total = folder.len() + words.iter().map(String::len).sum::<usize>();
    if words.len() > MAX_WORDS || total > MAX_TOTAL || folder.len() > MAX_DATUM || words.iter().any(|w| w.len() > MAX_DATUM || w.contains('\0')) {
        return Err(RemoteError::TooLong);
    }
    let mut a = ssh_base_args(host, 15);
    // One remote command line: the far login shell splits it into these words.
    let mut line = format!("exec /bin/sh -lc '{FAR_SCRIPT}' sh {}", encode(folder));
    line.push(' ');
    line.push_str(&encode(program));
    for w in args {
        line.push(' ');
        line.push_str(&encode(w));
    }
    a.push(line);
    Ok(a)
}

/// What a chat on an SSH machine is called everywhere on THIS PC as its folder (the pane list, the sidebar, rules, summaries). It starts
/// with a NUL, so it is no path on any OS: every `create_dir_all`, `is_dir`, `current_dir` or git call on it fails, and nothing is ever
/// created, read or excluded at a same-named folder of this PC. The real folder is `remote_folder_of`.
pub const PANE_FOLDER_PREFIX: &str = "\0ssh://";

pub fn pane_folder(host_id: &str, folder: &str) -> String {
    format!("{PANE_FOLDER_PREFIX}{host_id}{folder}")
}

/// `(host id, folder on that machine)` of a marker made by [`pane_folder`].
pub fn remote_folder_of(pane_folder: &str) -> Option<(&str, &str)> {
    let rest = pane_folder.strip_prefix(PANE_FOLDER_PREFIX)?;
    // A host id holds only letters, digits and `-`; the folder starts at the first other character (`/`, or `~` of `~/x`).
    let at = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))?;
    (at > 0).then(|| (&rest[..at], &rest[at..]))
}

/// The environment `ssh` itself needs to start on this PC (where its config, known_hosts and keys are; how to find a
/// ProxyJump program; the local key agent for signing in). Names only; none of it is sent to the far machine.
/// `ProgramData` is needed by Windows OpenSSH: without it `ssh.exe` exits 255 at once with no message (found by the real-sshd proof).
pub const SSH_ENV: [&str; 13] = ["SystemRoot", "ProgramData", "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USER", "LOGNAME", "APPDATA", "TEMP", "SSH_AUTH_SOCK"];

/// What to start: `ssh` with `argv`. `env` is a list of `(name, value)` already read by the caller from [`SSH_ENV`].
pub struct RemoteSpawn {
    pub exe: PathBuf,
    pub args: Vec<OsString>,
}

pub fn remote_spawn(exe: PathBuf, host: &SshHost, folder: &str, words: &[String]) -> Result<RemoteSpawn, RemoteError> {
    Ok(RemoteSpawn { exe, args: acp_argv(host, folder, words)?.into_iter().map(OsString::from).collect() })
}

/// The sentence for a chat that did not start, from what `ssh` printed. `name` is what the person calls the machine,
/// `program` the chat program that was asked for. Far text is never copied into the sentence.
pub fn failure_sentence(name: &str, program: &str, stderr_lines: &[String]) -> Option<String> {
    let text = stderr_lines.join("\n");
    let low = text.to_ascii_lowercase();
    if low.contains("pm-ssh: the folder was not found") {
        return Some(format!("That folder was not found on {name}."));
    }
    match classify(false, false, &text) {
        SshState::HostKeyUnknown => return Some(HOST_KEY_UNKNOWN.to_string()),
        SshState::HostKeyChanged => return Some(format!("{name}'s key changed. Stopped. Do not continue unless you know why it changed.")),
        SshState::WrongKey => return Some(format!("{name} did not accept the sign-in. Check the key file, or open a terminal to it first.")),
        SshState::CannotReach => return Some(format!("Cannot reach {name}. Check that it is on and the address is right.")),
        _ => {}
    }
    if low.contains("not found") || low.contains("no such file") || low.contains("not executable") {
        return Some(format!("The chat program {program} is not installed on {name}, or is not on its PATH."));
    }
    None
}

/// The one sentence for a key this PC does not know yet (ACP cannot ask a question).
pub const HOST_KEY_UNKNOWN: &str = "Connect once in a terminal first so this computer's key is remembered.";

#[cfg(test)]
#[path = "acp_tests.rs"]
mod tests;
