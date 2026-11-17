//! Agent background terminals: a command an agent starts and then leaves running (a dev server, a watcher, a
//! test run), which the app hosts for it. Four tools (`start_terminal`, `read_terminal`, `wait_terminal`,
//! `stop_terminal`; `bridge/routes/terminals.rs`) and a row in Background tasks with an output view.
//!
//! * No window, no pane: a hidden pseudo console owned by the app (`spawn`), and one Windows job object per
//!   terminal, so the whole tree ends when it is stopped, when its chat closes (`pty` pane close), or when the
//!   app ends. No input is sent to it in this version.
//! * Output: a bounded ring (`ring`: 2,000 lines, 1 MB), secrets masked before a line is stored. A finished
//!   terminal can be read for ten minutes.
//! * Caps: 4 running per agent, 12 in the app (`TOO_MANY_TERMINALS`, with the list so the agent can stop one).
//! * Who: an agent reads and stops its own terminals and those of the agents below it; never another agent's.
//! * The Allow card (`agent_authority::terminal_gate`): the first start in a chat asks the person; a risky command asks every time.

pub mod ring;
mod spawn;
#[cfg(test)]
mod tests;

pub use spawn::Cmd;

use crate::operations::OperationError;
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use ring::Ring;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_PER_AGENT: usize = 4;
pub const MAX_IN_APP: usize = 12;
/// A finished terminal can still be read for this long.
pub const KEEP_FINISHED_MS: u64 = 10 * 60 * 1000;
/// The most a start waits for its text (`wait_for`).
pub const MAX_START_WAIT_MS: u64 = 120_000;
/// The most one wait call blocks (the tool shim waits again for longer asks).
pub const MAX_WAIT_SLICE_MS: u64 = 270_000;
pub const DEFAULT_READ_LINES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Running,
    /// Ended by itself.
    Exited,
    /// Ended because someone stopped it.
    Stopped,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Running => "running",
            State::Exited => "exited",
            State::Stopped => "stopped",
        }
    }
}

struct Live {
    state: State,
    exit_code: Option<i32>,
    ended_ms: Option<u64>,
    /// Who asked for the stop ("the person", "the agent").
    stopped_by: Option<String>,
}

/// One terminal. Cheap to share: the reader and waiter threads hold it too.
pub struct Terminal {
    pub id: String,
    /// The pane of the agent that started it.
    pub owner: String,
    pub name: String,
    /// The command as given, secrets masked. Shown in the fold only, never typed by a person.
    pub command: String,
    pub cwd: String,
    pub pid: u32,
    pub started_ms: u64,
    live: Mutex<Live>,
    ring: Mutex<Ring>,
    /// Bumped on every output chunk and state change; waiters sleep on it.
    tick: Mutex<u64>,
    wake: Condvar,
    job: Mutex<Option<spawn::JobBox>>,
}

impl Terminal {
    fn bump(&self) {
        *self.tick.lock() += 1;
        self.wake.notify_all();
    }

    pub fn state(&self) -> State {
        self.live.lock().state
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.live.lock().exit_code
    }

    pub fn ended_ms(&self) -> Option<u64> {
        self.live.lock().ended_ms
    }

    pub fn stopped_by(&self) -> Option<String> {
        self.live.lock().stopped_by.clone()
    }

    pub fn is_running(&self) -> bool {
        self.state() == State::Running
    }

    pub fn read(&self, after: u64, max: usize) -> ring::Read {
        self.ring.lock().read(after, max)
    }

    pub fn tail(&self, max: usize) -> ring::Read {
        self.ring.lock().tail(max)
    }

    /// The ports this terminal's tree listens on right now.
    pub fn ports(&self) -> Vec<u16> {
        if !self.is_running() {
            return Vec::new();
        }
        crate::pane_jobs::ports_below(self.pid)
    }

    /// Stops the whole tree. Safe to call twice.
    fn stop(&self, by: &str, deep: bool) {
        {
            let mut live = self.live.lock();
            if live.state != State::Running {
                return;
            }
            live.stopped_by = Some(by.to_string());
        }
        let job = self.job.lock();
        spawn::kill_tree(self.pid, job.as_ref(), deep);
    }

}

/// What a start asks for.
pub struct StartRequest {
    /// The pane of the agent that asks.
    pub owner: String,
    /// The folder the agent works in; the command may run there or below it.
    pub project: PathBuf,
    pub command: Cmd,
    pub cwd: Option<String>,
    pub name: Option<String>,
}

pub struct Manager {
    terms: Mutex<Vec<Arc<Terminal>>>,
    next: AtomicU64,
    max_per_agent: usize,
    max_in_app: usize,
}

static MANAGER: Lazy<Manager> = Lazy::new(|| Manager::new(MAX_PER_AGENT, MAX_IN_APP));

pub fn manager() -> &'static Manager {
    &MANAGER
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn err(code: &str, message: impl Into<String>, recoverable: bool) -> OperationError {
    OperationError::new(code, message, recoverable)
}

impl Manager {
    pub fn new(max_per_agent: usize, max_in_app: usize) -> Self {
        Manager { terms: Mutex::new(Vec::new()), next: AtomicU64::new(1), max_per_agent, max_in_app }
    }

    pub fn get(&self, id: &str) -> Option<Arc<Terminal>> {
        self.sweep();
        self.terms.lock().iter().find(|t| t.id == id).cloned()
    }

    pub fn all(&self) -> Vec<Arc<Terminal>> {
        self.sweep();
        self.terms.lock().clone()
    }

    /// Forgets finished terminals that nobody can read any more.
    pub fn sweep(&self) {
        let now = now_ms();
        self.terms.lock().retain(|t| t.ended_ms().is_none_or(|ended| now.saturating_sub(ended) < KEEP_FINISHED_MS));
    }

    pub fn start(&self, request: StartRequest) -> Result<Arc<Terminal>, OperationError> {
        let StartRequest { owner, project, command, cwd, name } = request;
        let line = command.display();
        if line.is_empty() || matches!(&command, Cmd::Argv(argv) if argv.iter().all(|a| a.trim().is_empty())) {
            return Err(err("INVALID_ARGUMENT", "command is empty. Give the command to run, as one line or as a list of the program and its arguments.", false));
        }
        let run_in = resolve_cwd(&project, cwd.as_deref())?;
        self.sweep();
        {
            let terms = self.terms.lock();
            let mine: Vec<&Arc<Terminal>> = terms.iter().filter(|t| t.owner == owner && t.is_running()).collect();
            let in_app = terms.iter().filter(|t| t.is_running()).count();
            if mine.len() >= self.max_per_agent || in_app >= self.max_in_app {
                let which = if mine.len() >= self.max_per_agent {
                    format!("You already have {} terminals running (the most is {}).", mine.len(), self.max_per_agent)
                } else {
                    format!("The app already runs {in_app} terminals (the most is {}).", self.max_in_app)
                };
                let mut e = err("TOO_MANY_TERMINALS", format!("{which} Stop one with stop_terminal, then start this one again."), true);
                e.context = json!({ "running": mine.iter().map(|t| brief(t)).collect::<Vec<_>>() });
                return Err(e);
            }
        }
        let id = format!("term-{}", self.next.fetch_add(1, Ordering::SeqCst));
        let launched = spawn::launch(&command, &run_in, &id).map_err(|m| err("TERMINAL_START_FAILED", m, true))?;
        let shown = crate::redact::text(&line).into_inner();
        let name = name.map(|n| n.trim().chars().take(60).collect::<String>()).filter(|n| !n.is_empty());
        let term = Arc::new(Terminal {
            id,
            owner,
            name: name.unwrap_or_default(),
            command: shown,
            cwd: run_in.to_string_lossy().into_owned(),
            pid: launched.pid,
            started_ms: now_ms(),
            live: Mutex::new(Live { state: State::Running, exit_code: None, ended_ms: None, stopped_by: None }),
            ring: Mutex::new(Ring::default()),
            tick: Mutex::new(0),
            wake: Condvar::new(),
            job: Mutex::new(launched.job),
        });
        self.terms.lock().push(term.clone());
        run_threads(term.clone(), launched.reader, launched.master, launched.child, launched.script);
        Ok(term)
    }

    /// Stops one terminal. `by` is who asked, for the note the agent reads.
    pub fn stop(&self, id: &str, by: &str) -> bool {
        match self.get(id) {
            Some(term) if term.is_running() => {
                term.stop(by, true);
                true
            }
            _ => false,
        }
    }

    /// Stops every running terminal an agent (pane) started. Called when its pane closes.
    pub fn stop_owned_by(&self, owner: &str) -> usize {
        let owned: Vec<Arc<Terminal>> = self.terms.lock().iter().filter(|t| t.owner == owner && t.is_running()).cloned().collect();
        for term in &owned {
            term.stop("its chat closing", false);
        }
        owned.len()
    }

    /// Stops everything (the app is ending).
    pub fn stop_all(&self) -> usize {
        let running: Vec<Arc<Terminal>> = self.terms.lock().iter().filter(|t| t.is_running()).cloned().collect();
        for term in &running {
            term.stop("the app ending", false);
        }
        running.len()
    }

    /// Waits until `until` holds for `term`, the terminal ends, or `timeout` passes.
    pub fn wait(&self, term: &Arc<Terminal>, until: &Until, after: u64, timeout: Duration) -> WaitOutcome {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(found) = check(term, until, after) {
                return found;
            }
            if !term.is_running() {
                // It ended and nothing matched: say so with what it printed.
                return WaitOutcome { reason: Reason::Exit, matched: None };
            }
            let now = Instant::now();
            if now >= deadline {
                return WaitOutcome { reason: Reason::Timeout, matched: None };
            }
            let mut tick = term.tick.lock();
            let seen = *tick;
            // Ports are not announced by anything; look again soon even with no output.
            let nap = (deadline - now).min(Duration::from_millis(400));
            if *tick == seen {
                term.wake.wait_for(&mut tick, nap);
            }
        }
    }
}

/// What a wait ends on.
#[derive(Debug, Clone)]
pub enum Until {
    /// A line with this text, or matching it as a regular expression.
    Line(String),
    /// The terminal listens on a port (a given one, or any).
    Port(Option<u16>),
    /// The command ends.
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Line,
    Port,
    Exit,
    Timeout,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Line => "line",
            Reason::Port => "port",
            Reason::Exit => "exit",
            Reason::Timeout => "timeout",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WaitOutcome {
    pub reason: Reason,
    pub matched: Option<String>,
}

/// A line matcher for `text`: a plain piece of text, or a regular expression when it is one.
pub fn line_matcher(text: &str) -> Box<dyn Fn(&str) -> bool + Send + Sync> {
    let plain = text.to_string();
    let re = (text.len() <= 300).then(|| regex::RegexBuilder::new(text).size_limit(1 << 20).build().ok()).flatten();
    Box::new(move |line: &str| line.contains(&plain) || re.as_ref().is_some_and(|re| re.is_match(line)))
}

fn check(term: &Arc<Terminal>, until: &Until, after: u64) -> Option<WaitOutcome> {
    match until {
        Until::Line(text) => {
            let matches = line_matcher(text);
            term.ring.lock().find(after, |l| matches(l)).map(|(_, line)| WaitOutcome { reason: Reason::Line, matched: Some(line) })
        }
        Until::Port(want) => {
            let ports = term.ports();
            let hit = match want {
                Some(port) => ports.contains(port).then_some(*port),
                None => ports.first().copied(),
            };
            hit.map(|port| WaitOutcome { reason: Reason::Port, matched: Some(port.to_string()) })
        }
        Until::Exit => (!term.is_running()).then_some(WaitOutcome { reason: Reason::Exit, matched: None }),
    }
}

/// The folder a command runs in: the project, or a folder inside it.
fn resolve_cwd(project: &Path, asked: Option<&str>) -> Result<PathBuf, OperationError> {
    let root = project.canonicalize().map_err(|_| err("INVALID_CWD", "The folder you work in is not there any more.", false))?;
    let Some(asked) = asked.map(str::trim).filter(|a| !a.is_empty()) else { return Ok(strip_verbatim(root)) };
    let wanted = Path::new(asked);
    let joined = if wanted.is_absolute() { wanted.to_path_buf() } else { root.join(wanted) };
    let real = joined.canonicalize().map_err(|_| err("INVALID_CWD", format!("The folder {asked} does not exist."), false))?;
    if !real.starts_with(&root) || !real.is_dir() {
        return Err(err("CWD_OUTSIDE_PROJECT", "A terminal runs in your project folder or one inside it. This folder is somewhere else.", false));
    }
    Ok(strip_verbatim(real))
}

/// `\\?\C:\x` is not understood by every program: use `C:\x`.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

/// A short line about a terminal, for lists and the cap error.
pub fn brief(term: &Terminal) -> Value {
    json!({
        "terminal_id": term.id,
        "name": display_name(term),
        "state": term.state().as_str(),
        "started_at_ms": term.started_ms,
    })
}

/// The name a person sees: the given one, else the program's name.
pub fn display_name(term: &Terminal) -> String {
    if !term.name.is_empty() {
        return term.name.clone();
    }
    program_of(&term.command)
}

/// The program a command line starts, without its folder or `.exe`.
pub fn program_of(command: &str) -> String {
    let t = command.trim();
    let first = match t.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        None => t.split_whitespace().next().unwrap_or(t),
    };
    let file = first.rsplit(['\\', '/']).next().unwrap_or(first);
    let file = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".cmd")).unwrap_or(file);
    if file.is_empty() { "command".to_string() } else { file.to_string() }
}

/// The reader and the waiter of one terminal. The reader fills the ring until the console closes; the waiter
/// owns the child and the console: when the child ends it records how, lets the last output arrive, and closes
/// the console (which is what ends the reader on Windows).
fn run_threads(
    term: Arc<Terminal>,
    mut reader: Box<dyn std::io::Read + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    script: Option<PathBuf>,
) {
    let reading = term.clone();
    let reader_thread = std::thread::Builder::new().name(format!("{}-out", term.id)).spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    reading.ring.lock().push_bytes(&buf[..n]);
                    reading.bump();
                }
            }
        }
    });
    let _ = std::thread::Builder::new().name(format!("{}-wait", term.id)).spawn(move || {
        let status = child.wait();
        // Let the console hand over what is left, then close it so the reader ends.
        std::thread::sleep(Duration::from_millis(250));
        drop(master);
        if let Ok(handle) = reader_thread {
            let _ = handle.join();
        }
        term.ring.lock().finish();
        {
            let mut live = term.live.lock();
            live.exit_code = status.ok().map(|s| s.exit_code() as i32);
            live.state = if live.stopped_by.is_some() { State::Stopped } else { State::Exited };
            live.ended_ms = Some(now_ms());
        }
        // Anything the command left behind goes with it: a finished terminal holds no process.
        #[cfg(windows)]
        if let Some(job) = term.job.lock().as_ref() {
            job.terminate();
        }
        if let Some(path) = script {
            let _ = std::fs::remove_file(path);
        }
        term.bump();
    });
}

// ---- views --------------------------------------------------------------------------------------------------

/// The answer of `start_terminal`, `read_terminal` (one terminal) and the list: what a terminal is now.
pub fn view(term: &Terminal, tail: usize) -> Value {
    let read = term.tail(tail);
    let mut out = json!({
        "terminal_id": term.id,
        "name": display_name(term),
        "state": term.state().as_str(),
        "pid": term.pid,
        "cwd": term.cwd,
        "started_at_ms": term.started_ms,
        "ports": term.ports(),
        "output_tail": read.lines,
        "next_cursor": read.next_cursor,
    });
    if let Some(partial) = read.partial {
        out["partial_line"] = json!(partial);
    }
    if let Some(code) = term.exit_code() {
        out["exit_code"] = json!(code);
    }
    if let Some(by) = term.stopped_by() {
        out["stopped_by"] = json!(by);
    }
    out
}

/// `read_terminal` with an id.
pub fn read_view(term: &Terminal, after: u64, max: usize) -> Value {
    let read = term.read(after, max);
    let mut out = json!({
        "terminal_id": term.id,
        "name": display_name(term),
        "state": term.state().as_str(),
        "lines": read.lines,
        "next_cursor": read.next_cursor,
        "ports": term.ports(),
    });
    if read.dropped > 0 {
        out["dropped_lines"] = json!(read.dropped);
    }
    if let Some(partial) = read.partial {
        out["partial_line"] = json!(partial);
    }
    if let Some(code) = term.exit_code() {
        out["exit_code"] = json!(code);
    }
    if let Some(by) = term.stopped_by() {
        out["stopped_by"] = json!(by);
    }
    out
}

/// The terminal rows the app shows (Background tasks): running ones, and the last finished ones.
#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub command: String,
    pub pid: u32,
    pub started_ms: u64,
    pub ended_ms: Option<u64>,
    pub state: State,
    pub exit_code: Option<i32>,
    pub stopped_by: Option<String>,
}

pub fn rows() -> Vec<Row> {
    let mut all: Vec<Row> = manager()
        .all()
        .iter()
        .map(|t| Row {
            id: t.id.clone(),
            owner: t.owner.clone(),
            name: t.name.clone(),
            command: t.command.clone(),
            pid: t.pid,
            started_ms: t.started_ms,
            ended_ms: t.ended_ms(),
            state: t.state(),
            exit_code: t.exit_code(),
            stopped_by: t.stopped_by(),
        })
        .collect();
    all.sort_by_key(|r| r.started_ms);
    all
}

pub fn stop_owned_by(owner: &str) {
    crate::agent_authority::terminal_gate::forget_chat(owner);
    let n = manager().stop_owned_by(owner);
    if n > 0 {
        tracing::info!(pane = owner, stopped = n, "agent terminals: stopped with their chat");
    }
}

pub fn stop_all() {
    let n = manager().stop_all();
    if n > 0 {
        tracing::info!(stopped = n, "agent terminals: stopped, the app is ending");
    }
}

/// For each owner, which panes may use its terminals: the owner, and every agent above it.
pub fn may_use(caller: &str, term: &Terminal, parent_of: &dyn Fn(&str) -> Option<String>) -> bool {
    let mut at = Some(term.owner.clone());
    for _ in 0..16 {
        match at {
            Some(pane) if pane == caller => return true,
            Some(pane) => at = parent_of(&pane),
            None => return false,
        }
    }
    false
}

/// A name for what a command does, for a row that has no name of its own: `test`, `build`, `dev`, `install`
/// or `other`. The app turns it into words (`rail.bg.kind.*`), so every language gets its own.
pub fn kind_of(command: &str) -> &'static str {
    let c = command.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| c.contains(w));
    if has(&[" test", "pytest", "vitest", "jest", "cargo t ", "go test", "mocha", "playwright test", "unittest"]) {
        "test"
    } else if has(&[" install", "pip install", " add ", "yarn", "pnpm i", "cargo fetch", "npm ci", "npm i "]) && !has(&["run dev", "start"]) {
        "install"
    } else if has(&["run dev", " dev", "vite", "serve", "http.server", "npm start", "webpack-dev", "next dev", "runserver", "uvicorn", "flask run"]) {
        "dev"
    } else if has(&[" build", "tsc", "cargo b", "make", "webpack", "esbuild", "rollup"]) {
        "build"
    } else {
        "other"
    }
}
