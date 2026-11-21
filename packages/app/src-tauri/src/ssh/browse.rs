//! Reading a folder, one file and the git state of a project that lives on an SSH machine. READ ONLY: nothing here writes, stages,
//! commits or creates anything on the far machine, and nothing here touches a path of this PC.
//!
//! One fixed far script ([`BROWSE_SCRIPT`]) does three things, chosen by a fixed word: `ls`, `cat`, `status`. The command line is
//!
//! ```text
//! ssh <the hardened options of ssh::acp::ssh_base_args> -- user@host \
//!     exec /bin/sh -lc '<BROWSE_SCRIPT>' sh <ls|cat|status> x<folder octal> x<relative path octal>
//! ```
//!
//! Review notes (assumptions are also in the report):
//! * The folder and the relative path are text from a person or from the far machine's own file names. They travel ONLY as
//!   `x` + three octal digits per byte (`ssh::acp::encode`), so no shell finds a quote, space, `$`, backtick, `;`, `-` or newline in them.
//!   The fixed script rebuilds them with `printf` and uses them only inside double quotes after `--` or after a `/`.
//! * Rust refuses a relative path that is absolute, holds `..`, a control character (newline, tab, NUL), or is long ([`normalize_rel`]).
//!   `.` and empty parts are dropped. Everything else (space, quote, `$()`, backtick, leading `-`, unicode) is allowed and stays data.
//! * The far script then resolves the project folder with `cd` + `pwd -P` and the target the same way, and refuses unless
//!   `"$target/"` starts with `"$root/"` (trailing slash: `/srv/app-evil` is not inside `/srv/app`). That catches a symlinked
//!   directory that leads out. The last part of a file path is refused when it is a symlink (a link inside the folder is not followed)
//!   or not a regular file (a FIFO or a device would hang). Check-then-read is not atomic: a process on the far machine that
//!   can already write the project folder could swap a part between the check and the read. That user is the person's own, and the agent
//!   they run there can already read everything they can; it is not a boundary this code claims.
//! * Everything the far machine prints is untrusted text: only what follows the begin line is read (login-profile noise comes before
//!   it), file names with a control character or invalid UTF-8 are left out and counted, text is stripped of terminal escapes and
//!   bidirectional controls ([`neutralise`]), every length is capped, and the screen renders it as text.
//! * Limits: 500 entries per folder, 512 KiB per file (text only; a NUL or invalid UTF-8 is "binary" and refused), 256 KiB of git
//!   output, 20 seconds per call, 10 seconds to connect, two calls at a time per machine, results kept 4 seconds.
//! * `git` runs with `core.fsmonitor=false` and `GIT_OPTIONAL_LOCKS=0`, so `status` does not rewrite the index or run a monitor hook.
//!   It reads the far repository's own config, as the agent there does anyway.

use crate::ssh::acp::{encode, ssh_base_args};
use crate::ssh::model::{classify, valid_folder, SshHost, SshState};
use crate::ssh::run::{Output, Runner};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const BEGIN: &str = "pm-ssh-begin";
pub const MAX_ENTRIES: usize = 500;
pub const MAX_FILE: usize = 524_288;
pub const MAX_REL: usize = 1024;
pub const MAX_DEPTH: usize = 40;
pub const DEADLINE: Duration = Duration::from_secs(20);
pub const CONNECT_SECS: u32 = 10;
pub const PER_HOST: usize = 2;
const NAME_MAX: usize = 255;
/// Output the runner keeps: a file's most, plus the few framing lines.
const OUTPUT_CAP: usize = MAX_FILE + 4096;

/// The fixed far script. Facts for review: no single quote (it is exactly one single-quoted word for the far login shell), no `!`
/// (csh history), no newline, nothing taken from a person; `dec` is the one of `ssh::acp::FAR_SCRIPT`. No negated pattern (`[^..]`
/// is a literal set in dash and `[!..]` needs a `!`): hidden names are `./.*` minus `.` and `..`, and a number is checked with `[ -ge ]`.
pub const BROWSE_SCRIPT: &str = concat!(
    r#"LC_ALL=C; export LC_ALL; unset CDPATH; GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS; "#,
    r#"bs=$(printf "\134"); "#,
    r#"dec() { s=${1#x}; f=; while [ -n "$s" ]; do t=${s%"${s#???}"}; f="$f$bs$t"; s=${s#???}; done; printf "${f}x"; }; "#,
    r#"op=$1; c=$(dec "$2"); c=${c%x}; r=$(dec "$3"); r=${r%x}; "#,
    r#"echo pm-ssh-begin; "#,
    r#"case "$c" in "~") c=$HOME;; "~/"*) c=$HOME/${c#"~/"};; esac; "#,
    r#"cd -- "$c" 2>/dev/null || { echo "err nofolder"; exit 0; }; "#,
    r#"root=$(pwd -P) || { echo "err nofolder"; exit 0; }; "#,
    r#"pre=${root%/}; "#,
    r#"inside() { case "$1/" in "$pre"/*) return 0;; esac; return 1; }; "#,
    r#"case "$op" in "#,
    // ls: one folder, names only, newline names left out and counted
    r#"ls) if [ -n "$r" ]; then cd -- "$root/$r" 2>/dev/null || { echo "err notdir"; exit 0; }; fi; "#,
    r#"p=$(pwd -P); inside "$p" || { echo "err escape"; exit 0; }; "#,
    r#"nl=$(printf "\nx"); nl=${nl%x}; n=0; sk=0; echo ok; "#,
    r#"for e in ./* ./.*; do "#,
    r#"[ -e "$e" ] || [ -L "$e" ] || continue; "#,
    r#"nm=${e#./}; case "$nm" in .|..) continue;; esac; "#,
    r#"case "$nm" in *"$nl"*) sk=$((sk+1)); continue;; esac; "#,
    r#"if [ "$n" -ge 500 ]; then echo more; break; fi; "#,
    r#"n=$((n+1)); "#,
    r#"if [ -L "$e" ]; then k=l; elif [ -d "$e" ]; then k=d; elif [ -f "$e" ]; then k=f; else k=o; fi; "#,
    r#"printf "%s %s\n" "$k" "$nm"; "#,
    r#"done; echo "skipped $sk";; "#,
    // cat: one regular file inside the folder, size checked before it is read
    r#"cat) [ -n "$r" ] || { echo "err notfile"; exit 0; }; "#,
    r#"d=${r%/*}; b=${r##*/}; [ "$d" = "$r" ] && d=; "#,
    r#"if [ -n "$d" ]; then cd -- "$root/$d" 2>/dev/null || { echo "err notfile"; exit 0; }; fi; "#,
    r#"p=$(pwd -P); inside "$p" || { echo "err escape"; exit 0; }; "#,
    r#"if [ -L "./$b" ]; then echo "err link"; exit 0; fi; "#,
    r#"[ -f "./$b" ] || { echo "err notfile"; exit 0; }; "#,
    r#"[ -r "./$b" ] || { echo "err unreadable"; exit 0; }; "#,
    r#"sz=$(wc -c < "./$b") || { echo "err unreadable"; exit 0; }; sz=${sz##* }; "#,
    r#"[ "$sz" -ge 0 ] 2>/dev/null || { echo "err unreadable"; exit 0; }; "#,
    r#"if [ "$sz" -gt 524288 ]; then echo "err big"; exit 0; fi; "#,
    r#"echo ok; echo "size $sz"; head -c 524289 < "./$b";; "#,
    // status: the branch line and the changes of the project folder, in one read-only git call
    r#"status) command -v git >/dev/null 2>&1 || { echo "err nogit"; exit 0; }; "#,
    r#"pfx=$(git -c core.fsmonitor=false rev-parse --show-prefix 2>/dev/null) || { echo "err notrepo"; exit 0; }; "#,
    r#"echo ok; printf "prefix %s\n" "$pfx"; "#,
    r#"git -c core.fsmonitor=false status --porcelain=v1 -b -z --untracked-files=normal -- . 2>/dev/null | head -c 262144;; "#,
    r#"*) echo "err bad";; esac"#,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    List,
    Read,
    Status,
}

impl Op {
    fn word(self) -> &'static str {
        match self {
            Op::List => "ls",
            Op::Read => "cat",
            Op::Status => "status",
        }
    }
}

/// Why a read did not give an answer. `sentence` never copies far text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowseError {
    BadFolder,
    BadPath,
    NoFolder,
    Escape,
    NotFolder,
    NotFile,
    Link,
    TooBig,
    Binary,
    Unreadable,
    NoGit,
    NotRepo,
    NoAnswer,
    Busy,
    TimedOut,
    HostKeyUnknown,
    HostKeyChanged,
    WrongKey,
    CannotReach,
    Other,
}

impl BrowseError {
    /// A stable code per reason (`SSH_FS_...`), so the screen can say it in the person's language. `sentence` is the English fallback.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadFolder => "SSH_FS_BAD_FOLDER",
            Self::BadPath => "SSH_FS_BAD_PATH",
            Self::NoFolder => "SSH_FS_NO_FOLDER",
            Self::Escape => "SSH_FS_ESCAPE",
            Self::NotFolder => "SSH_FS_NOT_FOLDER",
            Self::NotFile => "SSH_FS_NOT_FILE",
            Self::Link => "SSH_FS_LINK",
            Self::TooBig => "SSH_FS_TOO_BIG",
            Self::Binary => "SSH_FS_BINARY",
            Self::Unreadable => "SSH_FS_UNREADABLE",
            Self::NoGit => "SSH_FS_NO_GIT",
            Self::NotRepo => "SSH_FS_NOT_REPO",
            Self::NoAnswer => "SSH_FS_NO_ANSWER",
            Self::Busy => "SSH_FS_BUSY",
            Self::TimedOut => "SSH_FS_TIMED_OUT",
            Self::HostKeyUnknown => "SSH_FS_HOST_KEY_UNKNOWN",
            Self::HostKeyChanged => "SSH_FS_HOST_KEY_CHANGED",
            Self::WrongKey => "SSH_FS_WRONG_KEY",
            Self::CannotReach => "SSH_FS_CANNOT_REACH",
            Self::Other => "SSH_FS_OTHER",
        }
    }

    pub fn sentence(&self, name: &str) -> String {
        match self {
            Self::BadFolder => "That folder is not usable. Start it with / or ~.".into(),
            Self::BadPath => "That path is not usable. It must stay inside the project folder.".into(),
            Self::NoFolder => format!("The project folder was not found on {name}."),
            Self::Escape => "That path leads outside the project folder, so it is not shown.".into(),
            Self::NotFolder => "That is not a folder any more.".into(),
            Self::NotFile => "That is not a plain file.".into(),
            Self::Link => "That is a link. Links are not followed.".into(),
            Self::TooBig => "That file is too big to show here (the limit is 512 KB).".into(),
            Self::Binary => "That file is not plain text, so it is not shown.".into(),
            Self::Unreadable => format!("{name} would not let this file be read."),
            Self::NoGit => format!("git is not installed on {name}."),
            Self::NotRepo => "This folder is not a git folder.".into(),
            Self::NoAnswer => format!("{name} did not answer as expected."),
            Self::Busy => format!("Still busy reading from {name}. Try again in a moment."),
            Self::TimedOut => format!("{name} took too long to answer."),
            Self::HostKeyUnknown => crate::ssh::acp::HOST_KEY_UNKNOWN.to_string(),
            Self::HostKeyChanged => format!("{name}'s key changed. Stopped. Do not continue unless you know why it changed."),
            Self::WrongKey => format!("{name} did not accept the sign-in. Check the key file, or open a terminal to it first."),
            Self::CannotReach => format!("Cannot reach {name}. Check that it is on and the address is right."),
            Self::Other => format!("Could not read from {name}."),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What goes out

/// A path inside the project folder as plain `/` text: `""` is the folder itself. Never `Path::join` (this PC's rules do not apply).
pub fn normalize_rel(rel: &str) -> Result<String, BrowseError> {
    if rel.len() > MAX_REL || rel.chars().any(|c| c.is_control() || is_bidi(c)) || rel.starts_with('/') {
        return Err(BrowseError::BadPath);
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(BrowseError::BadPath),
            p => parts.push(p),
        }
    }
    if parts.len() > MAX_DEPTH {
        return Err(BrowseError::BadPath);
    }
    Ok(parts.join("/"))
}

/// The `ssh` argument list of one read.
pub fn browse_argv(host: &SshHost, op: Op, folder: &str, rel: &str) -> Result<Vec<String>, BrowseError> {
    if !valid_folder(folder) {
        return Err(BrowseError::BadFolder);
    }
    let rel = normalize_rel(rel)?;
    if op == Op::Read && rel.is_empty() {
        return Err(BrowseError::BadPath);
    }
    let mut a = ssh_base_args(host, CONNECT_SECS);
    a.push(format!("exec /bin/sh -lc '{BROWSE_SCRIPT}' sh {} {} {}", op.word(), encode(folder), encode(&rel)));
    Ok(a)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What comes back (untrusted)

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{FEFF}')
}

/// Far text made safe to show: no terminal escape (the ESC byte and every other control but newline and tab are dropped), no
/// bidirectional control, `\r\n` as `\n`. The screen shows it as text, never as markup.
pub fn neutralise(text: &str) -> String {
    text.replace("\r\n", "\n").chars().filter(|&c| (c == '\n' || c == '\t' || !c.is_control()) && !is_bidi(c)).collect()
}

/// A file name this screen can show AND send back byte for byte: no control character, no invalid UTF-8 (which reads as U+FFFD),
/// no `/`, not `.` or `..`.
fn clean_name(name: &str) -> Option<String> {
    let ok = !name.is_empty()
        && name.len() <= NAME_MAX
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\u{FFFD}')
        && !name.chars().any(|c| c.is_control() || is_bidi(c));
    ok.then(|| name.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FarEntry {
    pub name: String,
    /// `dir`, `file`, `link` or `other`.
    pub kind: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FarListing {
    /// The folder shown, relative to the project folder (`""` is the project folder).
    pub path: String,
    pub entries: Vec<FarEntry>,
    /// There are more entries than the cap.
    pub more: bool,
    /// Names left out (a control character or invalid text in the name).
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FarFile {
    pub path: String,
    pub size: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FarChange {
    pub path: String,
    /// `modified`, `added`, `deleted`, `renamed`, `copied`, `new`, `conflict` or `changed`.
    pub kind: &'static str,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FarStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    /// Commits ahead of and behind the upstream branch (numbers read from git's `[ahead 1, behind 2]`), and whether the upstream is gone.
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub changes: Vec<FarChange>,
    pub more: bool,
}

/// The text after the begin line, or `NoAnswer` when it is not there (the far login profile may print before it).
fn framed(stdout: &str) -> Result<&str, BrowseError> {
    let mut at = 0;
    for line in stdout.split_inclusive('\n') {
        if line.trim_end_matches(['\n', '\r']) == BEGIN {
            return Ok(&stdout[at + line.len()..]);
        }
        at += line.len();
    }
    Err(BrowseError::NoAnswer)
}

/// The first line of the body is `ok` or `err <word>`; the rest is what the word promised.
fn status_line(body: &str) -> Result<&str, BrowseError> {
    let (first, rest) = body.split_once('\n').unwrap_or((body, ""));
    match first.trim_end_matches('\r') {
        "ok" => Ok(rest),
        "err nofolder" => Err(BrowseError::NoFolder),
        "err notdir" => Err(BrowseError::NotFolder),
        "err notfile" => Err(BrowseError::NotFile),
        "err escape" => Err(BrowseError::Escape),
        "err link" => Err(BrowseError::Link),
        "err big" => Err(BrowseError::TooBig),
        "err unreadable" => Err(BrowseError::Unreadable),
        "err nogit" => Err(BrowseError::NoGit),
        "err notrepo" => Err(BrowseError::NotRepo),
        _ => Err(BrowseError::NoAnswer),
    }
}

pub fn parse_list(stdout: &str, path: &str) -> Result<FarListing, BrowseError> {
    let rest = status_line(framed(stdout)?)?;
    let mut entries = Vec::new();
    let (mut more, mut skipped, mut complete) = (false, 0usize, false);
    for line in rest.lines() {
        let line = line.trim_end_matches('\r');
        if line == "more" {
            more = true;
        } else if let Some(n) = line.strip_prefix("skipped ") {
            complete = true;
            skipped +=n.trim().parse::<usize>().unwrap_or(0).min(1_000_000);
        } else if let Some((k, name)) = line.split_once(' ') {
            let kind = match k {
                "d" => "dir",
                "f" => "file",
                "l" => "link",
                "o" => "other",
                _ => continue,
            };
            match clean_name(name) {
                Some(name) if entries.len() < MAX_ENTRIES => entries.push(FarEntry { name, kind }),
                Some(_) => more = true,
                None => skipped += 1,
            }
        }
    }
    // The script's last line: a listing without it was cut off.
    if !complete {
        return Err(BrowseError::NoAnswer);
    }
    // Folders first, then by name (case-insensitive), the way the local tree reads.
    entries.sort_by(|a, b| (a.kind != "dir", a.name.to_lowercase(), &a.name).cmp(&(b.kind != "dir", b.name.to_lowercase(), &b.name)));
    Ok(FarListing { path: path.to_string(), entries, more, skipped })
}

pub fn parse_read(stdout: &str, path: &str) -> Result<FarFile, BrowseError> {
    let rest = status_line(framed(stdout)?)?;
    let (size_line, content) = rest.split_once('\n').ok_or(BrowseError::NoAnswer)?;
    let size: usize = size_line.strip_prefix("size ").and_then(|n| n.trim().parse().ok()).ok_or(BrowseError::NoAnswer)?;
    if size > MAX_FILE || content.len() > MAX_FILE {
        return Err(BrowseError::TooBig);
    }
    if content.contains('\0') || content.contains('\u{FFFD}') {
        return Err(BrowseError::Binary);
    }
    // A read that was cut off (the connection ended, the deadline passed) is shorter than the size the script measured first.
    if content.len() != size {
        return Err(BrowseError::NoAnswer);
    }
    Ok(FarFile { path: path.to_string(), size, text: neutralise(content) })
}

fn change_kind(x: char, y: char) -> &'static str {
    if x == '?' && y == '?' {
        return "new";
    }
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return "conflict";
    }
    match if y != ' ' { y } else { x } {
        'M' | 'T' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        _ => "changed",
    }
}

/// `main...origin/main [ahead 1, behind 2]` and the other forms of the `##` line of `status -b`:
/// `(branch, detached, unborn, ahead, behind, gone)`. Only numbers are taken from the bracket, never its text.
fn parse_branch(head: &str) -> (Option<String>, bool, bool, u32, u32, bool) {
    if let Some(b) = head.strip_prefix("No commits yet on ").or_else(|| head.strip_prefix("Initial commit on ")) {
        return (clean_name_loose(b), false, true, 0, 0, false);
    }
    if head.starts_with("HEAD (no branch)") {
        return (None, true, false, 0, 0, false);
    }
    let (names, tail) = match head.split_once(" [") {
        Some((n, t)) => (n, Some(t.trim_end_matches(']'))),
        None => (head, None),
    };
    let branch = names.split("...").next().unwrap_or("");
    let (mut ahead, mut behind, mut gone) = (0u32, 0u32, false);
    for part in tail.unwrap_or("").split(", ") {
        if part == "gone" {
            gone = true;
        } else if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0).min(1_000_000);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0).min(1_000_000);
        }
    }
    (clean_name_loose(branch), false, false, ahead, behind, gone)
}

/// A branch name for display: controls and bidi dropped, length capped. (Not used to run anything.)
fn clean_name_loose(s: &str) -> Option<String> {
    let t: String = neutralise(s).chars().filter(|c| *c != '\n' && *c != '\t').take(120).collect();
    (!t.is_empty()).then_some(t)
}

pub fn parse_status(stdout: &str) -> Result<FarStatus, BrowseError> {
    let rest = status_line(framed(stdout)?)?;
    let (prefix_line, records) = rest.split_once('\n').ok_or(BrowseError::NoAnswer)?;
    let prefix = prefix_line.strip_prefix("prefix ").unwrap_or("");
    // Every record ends with a NUL. What follows the last NUL is empty, or a record that `head -c` cut in half: that one is dropped.
    let mut parts: Vec<&str> = records.split('\0').collect();
    let cut_off = parts.pop().is_some_and(|last| !last.is_empty());
    let mut it = parts.into_iter();
    let head = it.next().and_then(|h| h.strip_prefix("## ")).ok_or(BrowseError::NoAnswer)?;
    let (branch, detached, unborn, ahead, behind, gone) = parse_branch(head);
    let mut changes = Vec::new();
    let mut more = cut_off;
    while let Some(rec) = it.next() {
        let mut chars = rec.chars();
        let (Some(x), Some(y), Some(' ')) = (chars.next(), chars.next(), chars.next()) else { continue };
        let path = chars.as_str();
        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            it.next(); // the old name follows as its own record
        }
        if x == '!' && y == '!' || path.is_empty() {
            continue;
        }
        if changes.len() >= MAX_ENTRIES {
            more = true;
            break;
        }
        let shown = path.strip_prefix(prefix).unwrap_or(path);
        changes.push(FarChange { path: neutralise(shown).replace(['\n', '\t'], " "), kind: change_kind(x, y), staged: x != ' ' && x != '?' });
    }
    Ok(FarStatus { branch, detached, unborn, ahead, behind, gone, changes, more })
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The call, with its limits

#[derive(Default)]
struct GateInner {
    busy: Mutex<HashMap<String, usize>>,
    freed: Condvar,
}

/// At most `max` calls at a time per machine id; a caller waits a while for a place, then gives up as `Busy`.
#[derive(Clone, Default)]
pub struct Gate(Arc<GateInner>);

pub struct Permit {
    gate: Arc<GateInner>,
    key: String,
}

impl Gate {
    pub fn enter(&self, key: &str, max: usize, wait: Duration) -> Option<Permit> {
        let give_up = Instant::now() + wait;
        let mut busy = self.0.busy.lock().ok()?;
        loop {
            if busy.get(key).copied().unwrap_or(0) < max {
                *busy.entry(key.to_string()).or_insert(0) += 1;
                return Some(Permit { gate: self.0.clone(), key: key.to_string() });
            }
            let left = give_up.checked_duration_since(Instant::now())?;
            busy = self.0.freed.wait_timeout(busy, left).ok()?.0;
        }
    }

    #[cfg(test)]
    pub fn in_use(&self, key: &str) -> usize {
        self.0.busy.lock().map(|b| b.get(key).copied().unwrap_or(0)).unwrap_or(0)
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.gate.busy.lock() {
            if let Some(n) = busy.get_mut(&self.key) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    busy.remove(&self.key);
                }
            }
        }
        self.gate.freed.notify_all();
    }
}

static GATE: Lazy<Gate> = Lazy::new(Gate::default);

/// The reads of one project on one machine.
pub struct Far<'a> {
    pub runner: &'a dyn Runner,
    pub host: &'a SshHost,
    pub folder: &'a str,
    pub gate: &'a Gate,
}

fn failure(out: &Output) -> BrowseError {
    if out.timed_out {
        return BrowseError::TimedOut;
    }
    match classify(out.ok, out.timed_out, &out.stderr) {
        SshState::HostKeyUnknown => BrowseError::HostKeyUnknown,
        SshState::HostKeyChanged => BrowseError::HostKeyChanged,
        SshState::WrongKey => BrowseError::WrongKey,
        SshState::CannotReach => BrowseError::CannotReach,
        _ => BrowseError::Other,
    }
}

impl<'a> Far<'a> {
    pub fn new(runner: &'a dyn Runner, host: &'a SshHost, folder: &'a str) -> Far<'a> {
        Far { runner, host, folder, gate: &GATE }
    }

    fn call(&self, op: Op, rel: &str) -> Result<String, BrowseError> {
        let argv = browse_argv(self.host, op, self.folder, rel)?;
        let _place = self.gate.enter(&self.host.id, PER_HOST, DEADLINE + Duration::from_secs(5)).ok_or(BrowseError::Busy)?;
        let out = self.runner.run_capped(&argv, DEADLINE, OUTPUT_CAP).map_err(|_| BrowseError::Other)?;
        // A call that hit the deadline or whose connection ended badly is never read as a whole answer, even when it got as far as the
        // begin line: a cut-off file, listing or status would look complete. The script itself always ends well (`exit 0`).
        if out.timed_out || !out.ok || !out.stdout.lines().any(|l| l.trim_end() == BEGIN) {
            return Err(failure(&out));
        }
        Ok(out.stdout)
    }

    pub fn list(&self, rel: &str) -> Result<FarListing, BrowseError> {
        let rel = normalize_rel(rel)?;
        parse_list(&self.call(Op::List, &rel)?, &rel)
    }

    pub fn read(&self, rel: &str) -> Result<FarFile, BrowseError> {
        let rel = normalize_rel(rel)?;
        parse_read(&self.call(Op::Read, &rel)?, &rel)
    }

    pub fn status(&self) -> Result<FarStatus, BrowseError> {
        parse_status(&self.call(Op::Status, "")?)
    }
}

/// A small, short-lived memory of answers (so a screen that asks twice in a moment costs one ssh).
pub struct Remember {
    ttl: Duration,
    max: usize,
    items: Mutex<HashMap<String, (Instant, serde_json::Value)>>,
}

impl Remember {
    pub fn new(ttl: Duration, max: usize) -> Self {
        Self { ttl, max, items: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, key: &str) -> Option<serde_json::Value> {
        let items = self.items.lock().ok()?;
        items.get(key).filter(|(at, _)| at.elapsed() < self.ttl).map(|(_, v)| v.clone())
    }

    pub fn put(&self, key: String, value: serde_json::Value) {
        if let Ok(mut items) = self.items.lock() {
            items.retain(|_, (at, _)| at.elapsed() < self.ttl);
            if items.len() >= self.max {
                items.clear();
            }
            items.insert(key, (Instant::now(), value));
        }
    }
}

pub static REMEMBER: Lazy<Remember> = Lazy::new(|| Remember::new(Duration::from_secs(4), 64));

#[cfg(test)]
#[path = "browse_tests.rs"]
mod tests;
