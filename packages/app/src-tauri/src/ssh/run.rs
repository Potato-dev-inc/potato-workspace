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
    /// The same with a bigger (or smaller) stdout cap in bytes. A runner that has no cap of its own (a fake) answers as `run`.
    fn run_capped(&self, argv: &[String], deadline: Duration, _cap: usize) -> Result<Output, String> {
        self.run(argv, deadline)
    }
    /// Like `run`, with `input` written to the far command's stdin and then closed (the program copy and the pairing line).
    fn run_input(&self, _argv: &[String], _input: &[u8], _deadline: Duration) -> Result<Output, String> {
        Err("this runner cannot send input".into())
    }
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

fn read_capped(mut r: impl Read + Send + 'static, cap: usize) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if buf.len() < cap {
                buf.extend_from_slice(&chunk[..n.min(cap - buf.len())]);
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

impl Runner for LiveRunner {
    fn run(&self, argv: &[String], deadline: Duration) -> Result<Output, String> {
        self.run_capped(argv, deadline, OUTPUT_CAP)
    }

    fn run_capped(&self, argv: &[String], deadline: Duration, cap: usize) -> Result<Output, String> {
        self.exec(argv, None, deadline, cap)
    }

    fn run_input(&self, argv: &[String], input: &[u8], deadline: Duration) -> Result<Output, String> {
        self.exec(argv, Some(input), deadline, OUTPUT_CAP)
    }
}

impl LiveRunner {
    fn exec(&self, argv: &[String], input: Option<&[u8]>, deadline: Duration, cap: usize) -> Result<Output, String> {
        let mut cmd = crate::proc_util::hidden_command(&self.exe);
        cmd.args(&self.pre).args(argv).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ssh did not start: {e}"))?;
        // The input goes in from its own thread so a full pipe never blocks the reads; the pipe closes once it is all written.
        if let (Some(bytes), Some(mut stdin)) = (input.map(<[u8]>::to_vec), child.stdin.take()) {
            std::thread::spawn(move || {
                let _ = std::io::Write::write_all(&mut stdin, &bytes);
            });
        }
        let out = read_capped(child.stdout.take().ok_or("no stdout")?, cap);
        let err = read_capped(child.stderr.take().ok_or("no stderr")?, OUTPUT_CAP);
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
