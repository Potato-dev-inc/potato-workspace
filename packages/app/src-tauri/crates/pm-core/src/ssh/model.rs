//! The validated parts of an SSH place. Every field has one rule; anything else is refused, so the argument list
//! built from them (`command.rs`) cannot carry a second option or a second command.

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 22;

/// Why a part was refused. The sentence is for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartError {
    User,
    Host,
    Port,
    KeyFile,
    Folder,
    Program,
}

impl PartError {
    pub fn sentence(&self) -> &'static str {
        match self {
            Self::User => "That user name is not usable. Use letters, numbers, dots, dashes and underscores.",
            Self::Host => "That address is not usable. Use a name like build.local or a number like 192.168.1.20.",
            Self::Port => "The port must be a number from 1 to 65535.",
            Self::KeyFile => "That key file path is not usable.",
            Self::Folder => "That folder is not usable. Start it with / or ~.",
            Self::Program => "That program name is not usable.",
        }
    }
}

/// `^[A-Za-z_][A-Za-z0-9._-]{0,31}$`.
pub fn valid_user(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && s.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A host name or IPv4 address (`[A-Za-z0-9][A-Za-z0-9._-]{0,252}`), or an IPv6 address (hex digits and colons).
pub fn valid_host(s: &str) -> bool {
    if s.contains(':') {
        return s.len() <= 45 && s.matches(':').count() >= 2 && s.chars().all(|c| c.is_ascii_hexdigit() || c == ':');
    }
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 253
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A path as typed. It is handed to `ssh -i` as one argument and never opened. No control characters, and it cannot
/// start with `-` (it would look like an option in logs and tools).
pub fn valid_key_file(s: &str) -> bool {
    !s.is_empty() && s.len() <= 400 && !s.starts_with('-') && !s.chars().any(char::is_control)
}

/// A program name on the far machine: a bare name, never a path or a command line.
pub fn valid_program(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
}

/// A folder on the far machine: `/...`, `~` or `~/...`, no control characters.
pub fn valid_folder(s: &str) -> bool {
    !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control) && (s.starts_with('/') || s == "~" || s.starts_with("~/"))
}

/// One saved SSH place. Holds no password and no key contents: `key_file` is a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshHost {
    pub id: String,
    /// What the person calls it (`Build box`). Display only.
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_file: Option<String>,
}

impl SshHost {
    /// Validates every part. `target` is `user@host`.
    pub fn parse(id: &str, name: &str, target: &str, port: Option<u16>, key_file: Option<&str>) -> Result<Self, PartError> {
        let (user, host) = target.trim().rsplit_once('@').ok_or(PartError::Host)?;
        if !valid_user(user) {
            return Err(PartError::User);
        }
        if !valid_host(host) {
            return Err(PartError::Host);
        }
        let port = port.unwrap_or(DEFAULT_PORT);
        if port == 0 {
            return Err(PartError::Port);
        }
        let key_file = key_file.map(str::trim).filter(|k| !k.is_empty());
        if let Some(k) = key_file {
            if !valid_key_file(k) {
                return Err(PartError::KeyFile);
            }
        }
        let name: String = name.chars().filter(|c| !c.is_control()).take(40).collect();
        let name = if name.trim().is_empty() { host.to_string() } else { name.trim().to_string() };
        Ok(Self { id: id.to_string(), name, user: user.to_string(), host: host.to_string(), port, key_file: key_file.map(str::to_string) })
    }

    /// Re-checks a host read from disk: a hand-edited file never gets past the rules.
    pub fn is_valid(&self) -> bool {
        valid_user(&self.user)
            && valid_host(&self.host)
            && self.port != 0
            && self.key_file.as_deref().map_or(true, valid_key_file)
            && !self.id.is_empty()
            && self.id.len() <= 64
            && self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }

    /// `user@host`, only ever built from validated parts.
    pub fn destination(&self) -> String {
        format!("{}@{}", self.user, self.host)
    }
}

/// What the person is told when a connection does not work. One state, one plain sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SshState {
    Ok,
    /// The machine did not answer (wrong address, off, or no network).
    CannotReach,
    /// The key or login was not accepted. The terminal asks for a password itself; nothing is stored.
    WrongKey,
    /// The machine's key is not known yet. Open a terminal to it once and say yes there.
    HostKeyUnknown,
    /// The machine's key is not the one saved before. Never accepted automatically.
    HostKeyChanged,
    /// Anything else. `line` is the first line ssh printed, cleaned and short.
    Other { line: String },
}

/// Control characters out, length capped, first non-empty line only. Text from another machine is shown as text only.
pub fn clean_line(s: &str, max: usize) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().filter(|c| !c.is_control()).take(max).collect()
}

/// What `ssh` printed and how it ended, as one state.
pub fn classify(exit_ok: bool, timed_out: bool, stderr: &str) -> SshState {
    if exit_ok && !timed_out {
        return SshState::Ok;
    }
    let low = stderr.to_ascii_lowercase();
    if low.contains("remote host identification has changed") || (low.contains("host key for") && low.contains("has changed")) {
        return SshState::HostKeyChanged;
    }
    if low.contains("host key verification failed") || low.contains("host key is known") {
        return SshState::HostKeyUnknown;
    }
    if low.contains("permission denied") || low.contains("too many authentication failures") || low.contains("no more authentication methods") {
        return SshState::WrongKey;
    }
    const UNREACHABLE: [&str; 9] = [
        "could not resolve",
        "connection refused",
        "timed out",
        "no route to host",
        "network is unreachable",
        "connection closed by",
        "connection reset",
        "name or service not known",
        "host is down",
    ];
    if timed_out || UNREACHABLE.iter().any(|m| low.contains(m)) {
        return SshState::CannotReach;
    }
    SshState::Other { line: clean_line(stderr, 160) }
}

impl SshState {
    /// Plain words for logs and errors (the screens use their own i18n strings).
    pub fn sentence(&self) -> String {
        match self {
            Self::Ok => "Connected.".into(),
            Self::CannotReach => "Cannot reach this machine. Check the address and that it is on.".into(),
            Self::WrongKey => "Wrong key or password. Check the key file, or open a terminal and type the password there.".into(),
            Self::HostKeyUnknown => "This machine is new to this PC. Open a terminal to it once and say yes to its key.".into(),
            Self::HostKeyChanged => "This machine's key changed. Stopped. Do not continue unless you know why it changed.".into(),
            Self::Other { line } if line.is_empty() => "The connection did not work.".into(),
            Self::Other { line } => format!("The connection did not work: {line}"),
        }
    }
}
