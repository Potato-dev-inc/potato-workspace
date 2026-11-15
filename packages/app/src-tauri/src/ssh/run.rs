//! Running the system `ssh` for the check (a terminal pane is a PTY and starts through the pane registry instead).
//! The runner is a trait so tests use a fake `ssh` on a `PATH` of their own; no real SSH host is ever contacted
//! by a test. Output is capped, and the call has a deadline after which the process is killed.

use crate::ssh::check::{self, Facts};
use crate::ssh::command::check_argv;
use crate::ssh::model::{classify, SshHost, SshState};
use std::ffi::OsStr;
use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

pub const CHECK_DEADLINE: Duration = Duration::from_secs(20);
pub const OUTPUT_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Default)]
pub struct Output {
    pub ok: bool,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait Runner {
    fn run(&self, argv: &[String], deadline: Duration) -> Result<Output, String>;
}

/// The system `ssh`, looked for in `path_var` (the process `PATH` when `None`), then in the Windows OpenSSH folder.
pub fn ssh_exe_in(path_var: Option<&OsStr>) -> Option<PathBuf> {
    let name = if cfg!(windows) { "ssh.exe" } else { "ssh" };
    let from_path = path_var.map(std::borrow::Cow::Borrowed).or_else(|| std::env::var_os("PATH").map(std::borrow::Cow::Owned));
    if let Some(p) = from_path {
        for dir in std::env::split_paths(&p) {
            let c = dir.join(name);
            if c.is_file() {
                return Some(c);
            }
        }
    }
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let c = root.join("System32").join("OpenSSH").join("ssh.exe");
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

pub fn ssh_exe() -> Option<PathBuf> {
    ssh_exe_in(None)
}

pub struct LiveRunner {
    pub exe: PathBuf,
    /// Arguments placed before the ssh arguments (empty for the real `ssh`; a test puts a script path here).
    pub pre: Vec<String>,
}

fn read_capped(mut r: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if buf.len() < OUTPUT_CAP {
                buf.extend_from_slice(&chunk[..n.min(OUTPUT_CAP - buf.len())]);
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

impl Runner for LiveRunner {
    fn run(&self, argv: &[String], deadline: Duration) -> Result<Output, String> {
        let mut cmd = crate::proc_util::hidden_command(&self.exe);
        cmd.args(&self.pre).args(argv).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ssh did not start: {e}"))?;
        let out = read_capped(child.stdout.take().ok_or("no stdout")?);
        let err = read_capped(child.stderr.take().ok_or("no stderr")?);
        let started = Instant::now();
        let (ok, timed_out) = loop {
            match child.try_wait() {
                Ok(Some(status)) => break (status.success(), false),
                Ok(None) if started.elapsed() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (false, true);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                Err(e) => return Err(format!("ssh failed: {e}")),
            }
        };
        Ok(Output { ok, timed_out, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
    }
}

/// What a check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    pub state: SshState,
    pub facts: Facts,
}

/// Runs the fixed read-only script over ssh and reads the answer. `programs` are the agent CLI names to look for.
pub fn check(runner: &dyn Runner, host: &SshHost, programs: &[String]) -> CheckResult {
    let argv = check_argv(host, &check::remote_command(programs));
    match runner.run(&argv, CHECK_DEADLINE) {
        Ok(out) => {
            let state = classify(out.ok, out.timed_out, &out.stderr);
            let facts = if state == SshState::Ok { check::parse(&out.stdout, programs) } else { Facts::default() };
            CheckResult { state, facts }
        }
        Err(line) => CheckResult { state: SshState::Other { line: crate::ssh::model::clean_line(&line, 160) }, facts: Facts::default() },
    }
}
