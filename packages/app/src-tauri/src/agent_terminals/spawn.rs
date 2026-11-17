//! Starting one background command under a hidden pseudo console, inside its own job object.
//!
//! The command never gets a window: a ConPTY (portable-pty) hosts it, and nothing is shown. On Windows the
//! command line goes through a small batch file (`cmd /d /c script`) so a line with quotes, pipes or `&&`
//! means what the agent typed, and an argv list is quoted for cmd. Elsewhere it is `sh -c`.
//!
//! The process is put in a Windows job object (kill on close) right after it starts, so the whole tree ends
//! when the terminal is stopped, when its chat closes, or when the app quits or crashes. Stopping is by that
//! job (or by pid tree elsewhere), never by image name.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Read;
use std::path::{Path, PathBuf};

/// What the agent asked to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    /// One command line, as typed in a shell.
    Line(String),
    /// A program and its arguments.
    Argv(Vec<String>),
}

impl Cmd {
    /// The command as one line: what the person sees in the fold, and what the danger check reads.
    pub fn display(&self) -> String {
        match self {
            Cmd::Line(line) => line.trim().to_string(),
            Cmd::Argv(argv) => argv.iter().map(|a| quote_for_cmd(a)).collect::<Vec<_>>().join(" "),
        }
    }
}

/// An argument for a cmd line: quoted when it holds a character cmd or the program would split on.
pub fn quote_for_cmd(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || matches!(c, '&' | '|' | '<' | '>' | '^' | '(' | ')' | '"' | '%' | '!' | ';' | ',' | '=')) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\"\""))
}

pub struct Launched {
    pub pid: u32,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
    /// The batch file to delete when the command ends.
    pub script: Option<PathBuf>,
    pub job: Option<JobBox>,
}

/// The job object holding the command's tree (Windows). Elsewhere there is none and the pid tree is used.
#[cfg(windows)]
pub type JobBox = crate::proc_job::Job;
#[cfg(not(windows))]
pub struct JobBox;

pub const COLS: u16 = 200;
pub const ROWS: u16 = 50;

pub fn script_dir() -> PathBuf {
    std::env::temp_dir().join("potato-agent-terminals")
}

pub fn launch(cmd: &Cmd, cwd: &Path, id: &str) -> Result<Launched, String> {
    let (mut builder, script) = builder_for(cmd, id)?;
    builder.cwd(cwd);
    // No colours (fewer escapes), and the app's own secrets stay out: the same rule as a guarded agent pane.
    builder.env("NO_COLOR", "1");
    builder.env("FORCE_COLOR", "0");
    builder.env("TERM", "dumb");
    let names: Vec<String> = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).collect();
    for name in names {
        if crate::pty::env_guard::removable(&name) {
            builder.env_remove(&name);
        }
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows: ROWS, cols: COLS, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("could not open a console: {e}"))?;
    let child = match pair.slave.spawn_command(builder) {
        Ok(child) => child,
        Err(e) => {
            if let Some(path) = &script {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!("could not start the command: {e}"));
        }
    };
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let reader = pair.master.try_clone_reader().map_err(|e| format!("could not read the console: {e}"))?;
    #[cfg(not(windows))]
    let job: Option<JobBox> = None;
    #[cfg(windows)]
    let job = match crate::proc_job::Job::new() {
        Ok(job) => match job.assign_pid(pid) {
            Ok(()) => Some(job),
            Err(e) => {
                tracing::warn!(pid, error = %e, "agent terminal: could not put the command in a job object; stopping it kills its tree by pid");
                None
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "agent terminal: could not create a job object");
            None
        }
    };
    Ok(Launched { pid, master: pair.master, child, reader, script, job })
}

#[cfg(windows)]
fn builder_for(cmd: &Cmd, id: &str) -> Result<(CommandBuilder, Option<PathBuf>), String> {
    let dir = script_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare the command: {e}"))?;
    // Unique per start (two apps, or two managers in a test, can both have a "term-1").
    let path = dir.join(format!("{id}-{}.cmd", uuid::Uuid::new_v4().simple()));
    let body = format!("@echo off\r\n{}\r\n", cmd.display().replace('\n', "\r\n"));
    std::fs::write(&path, body).map_err(|e| format!("could not prepare the command: {e}"))?;
    let mut builder = CommandBuilder::new("cmd.exe");
    builder.args(["/d", "/c"]);
    builder.arg(&path);
    Ok((builder, Some(path)))
}

#[cfg(not(windows))]
fn builder_for(cmd: &Cmd, _id: &str) -> Result<(CommandBuilder, Option<PathBuf>), String> {
    match cmd {
        Cmd::Line(line) => {
            let mut builder = CommandBuilder::new("sh");
            builder.args(["-c", line]);
            Ok((builder, None))
        }
        Cmd::Argv(argv) => {
            let (first, rest) = argv.split_first().ok_or("the command is empty")?;
            let mut builder = CommandBuilder::new(first);
            builder.args(rest);
            Ok((builder, None))
        }
    }
}

/// Stops the whole tree while the command's process is still ours (its handle is open, so its pid cannot belong to
/// anything else yet): the job first (instant, takes everything the job holds), then the pid tree, which also takes a
/// child that started before the job got its member.
///
/// `deep: false` (a chat closing, the app ending: they must not wait) stops at the job when there is one.
pub fn kill_tree(pid: u32, job: Option<&JobBox>, deep: bool) {
    #[cfg(windows)]
    if let Some(job) = job {
        job.terminate();
        if !deep {
            return;
        }
    }
    #[cfg(not(windows))]
    let _ = (job, deep);
    crate::pty::proc_tree::kill_process_tree(pid);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_argv_is_quoted_for_cmd_only_where_it_must_be() {
        let cmd = Cmd::Argv(vec!["npm".into(), "run".into(), "dev".into(), "--name=a b".into(), "x&y".into()]);
        assert_eq!(cmd.display(), "npm run dev \"--name=a b\" \"x&y\"");
        assert_eq!(quote_for_cmd("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn a_line_shows_as_typed() {
        assert_eq!(Cmd::Line("  npm run dev  ".into()).display(), "npm run dev");
    }
}
