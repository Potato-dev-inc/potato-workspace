//! The REAL proof of the SSH chat transport: the real system `ssh` against a real `sshd` (a disposable container,
//! see `test-hosts/ssh/host.sh`). Ignored by default; it needs the host up and these variables:
//!
//! * `PM_SSH_REAL_HOST`      `127.0.0.1:2222` (the host key of that address must be in known_hosts: `host.sh up` does it)
//! * `PM_SSH_REAL_KEY`       path of the test private key
//! * `PM_SSH_REAL_CONTAINER` container name (default `pm-ssh-test-host`), used only to read the container (does `/tmp/pwned` exist)
//! * `PM_SSH_REAL_EXE`       the `ssh` program to run (default: the one the app finds)
//!
//! Only the echo adapter in `test-hosts/ssh/claude-agent-acp` runs there. It is not Claude.

use super::acp::*;
use super::model::SshHost;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub const BASE: &str = "/home/tester/h";

pub struct Env {
    pub host: SshHost,
    pub exe: PathBuf,
    pub container: String,
}

pub fn env() -> Option<Env> {
    let target = std::env::var("PM_SSH_REAL_HOST").ok()?;
    let key = std::env::var("PM_SSH_REAL_KEY").ok()?;
    let (h, port) = target.rsplit_once(':')?;
    let exe = std::env::var_os("PM_SSH_REAL_EXE").map(PathBuf::from).or_else(crate::ssh::run::ssh_exe)?;
    let container = std::env::var("PM_SSH_REAL_CONTAINER").unwrap_or_else(|_| "pm-ssh-test-host".into());
    Some(Env { host: SshHost::parse("real1", "Test box", &format!("tester@{h}"), Some(port.parse().ok()?), Some(&key)).ok()?, exe, container })
}

pub fn words(w: &[&str]) -> Vec<String> {
    w.iter().map(|s| s.to_string()).collect()
}

fn docker(args: &[&str], stdin: Option<&str>) -> (bool, String) {
    let mut c = Command::new("docker");
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = c.spawn().expect("docker starts");
    if let Some(s) = stdin {
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr))
}

/// Makes the folders (absolute paths) on the host, as the test user.
pub fn make_folders(e: &Env, folders: &[String]) {
    let (ok, out) = docker(&["exec", "-i", &e.container, "node", "/home/tester/mk-folders.js"], Some(&serde_json::to_string(folders).unwrap()));
    assert!(ok && out.contains("made"), "mk-folders: {out}");
}

pub fn container_has(e: &Env, path: &str) -> bool {
    docker(&["exec", &e.container, "test", "-e", path], None).0
}

pub fn container_sh(e: &Env) -> String {
    docker(&["exec", &e.container, "readlink", "-f", "/bin/sh"], None).1.trim().to_string()
}

/// What a start gave: the echo agent's answer, or why ssh ended.
#[derive(Debug)]
pub enum Outcome {
    Answered(Value),
    Ended { code: Option<i32>, stderr: Vec<String> },
}

fn lines_of(r: impl std::io::Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for l in BufReader::new(r).lines().map_while(Result::ok) {
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    rx
}

/// Runs the real `ssh` built by `remote_spawn` (the function the app uses), speaks ACP over its stdio: initialize, session/new
/// (with `folder` as cwd), one prompt. The echo adapter's one message chunk is parsed (it is JSON).
pub fn run_once(e: &Env, host: &SshHost, folder: &str, args: &[String], prompt: &str) -> Outcome {
    let spawn = remote_spawn(e.exe.clone(), host, folder, args).expect("argv builds");
    let mut child = Command::new(&spawn.exe).args(&spawn.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("ssh starts");
    let mut stdin = child.stdin.take().unwrap();
    let out = lines_of(child.stdout.take().unwrap());
    let err = lines_of(child.stderr.take().unwrap());
    let mut send = |v: Value| {
        let _ = writeln!(stdin, "{v}");
        let _ = stdin.flush();
    };
    let next = |id: u64| -> Option<Value> {
        loop {
            match out.recv_timeout(Duration::from_secs(30)) {
                Ok(l) => {
                    let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
                    if v.get("id").and_then(Value::as_u64) == Some(id) || v.get("method").is_some() {
                        return Some(v);
                    }
                }
                Err(_) => return None,
            }
        }
    };
    let mut result: Option<Value> = None;
    send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params": crate::acp::handshake::initialize_params("pm-ssh-real-test", "0")}));
    if let Some(init) = next(1) {
        assert_eq!(init["result"]["protocolVersion"], 1, "{init}");
        crate::acp::handshake::parse_initialize(&init["result"]).expect("the app's own parser accepts the echo agent's initialize");
        send(json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":folder,"mcpServers":[]}}));
        let new = next(2).expect("session/new answered");
        let sid = new["result"]["sessionId"].as_str().expect("sessionId").to_string();
        send(json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":prompt}]}}));
        let mut chunk: Option<String> = None;
        while let Some(v) = next(3) {
            if v["method"] == "session/update" {
                if let Some(t) = v.pointer("/params/update/content/text").and_then(Value::as_str) {
                    chunk = Some(t.to_string());
                }
            } else if v.get("id").is_some() {
                assert_eq!(v["result"]["stopReason"], "end_turn", "{v}");
                result = chunk.as_deref().map(|t| serde_json::from_str(t).expect("the echo chunk is JSON"));
                break;
            }
        }
    }
    drop(stdin);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break Some(s);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stderr: Vec<String> = std::iter::from_fn(|| err.recv_timeout(Duration::from_millis(300)).ok()).collect();
    match result {
        Some(v) => Outcome::Answered(v),
        None => Outcome::Ended { code: status.and_then(|s| s.code()), stderr },
    }
}

/// The names under [`BASE`] that must round-trip. (A newline or tab in a folder is refused before ssh: see the test.)
pub const FOLDER_NAMES: &[&str] = &[
    "plain",
    "with space",
    "it's",
    "two''quotes'",
    "say \"hi\"",
    "$(touch /tmp/pwned)",
    "`touch /tmp/pwned`",
    "semi;touch /tmp/pwned;x",
    "a && touch /tmp/pwned || b",
    "a|b>c<d",
    "-lead",
    "--help",
    "caf\u{e9} \u{65e5}\u{672c}\u{8a9e} \u{1f600}",
    "100%s %n %",
    "~tilde",
    "back\\slash",
    "*",
    "{a,b}",
    "!hist",
    "$HOME",
    "x y\\\\z",
];

/// Program arguments that must reach the far program byte for byte.
pub const ARGS: &[&str] = &[
    "plain",
    "with space",
    "it's",
    "say \"hi\"",
    "$(touch /tmp/pwned)",
    "`touch /tmp/pwned`",
    "a;b",
    "-rf",
    "--help",
    "line1\nline2",
    "trailing newline\n",
    "\ttab",
    "back\\slash",
    "~",
    "~/x",
    "*",
    "{a,b}",
    "!hist",
    "caf\u{e9} \u{65e5}\u{672c}\u{8a9e} \u{1f600}",
    "100%s %n %",
    "",
    "x",
    "x101",
];

pub struct Check {
    pub fails: Vec<String>,
    pub passes: usize,
}

impl Check {
    pub fn ok(&mut self, what: &str, cond: bool, detail: impl FnOnce() -> String) {
        if cond {
            self.passes += 1;
            eprintln!("PASS  {what}");
        } else {
            let d = detail();
            eprintln!("FAIL  {what}: {d}");
            self.fails.push(format!("{what}: {d}"));
        }
    }
}

pub fn known_hosts_path() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).expect("home")).join(".ssh").join("known_hosts")
}

/// Takes the host's own line(s) out of known_hosts for a while (and, if `replacement` is given, puts that one line in their place).
/// When dropped (also when the test panics) the replacement is removed again and the original lines are back.
pub struct KnownHostsSwap {
    path: PathBuf,
    removed: Vec<String>,
    replacement: Option<String>,
}

impl KnownHostsSwap {
    pub fn new(prefix: &str, replacement: Option<&str>) -> Self {
        let path = known_hosts_path();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let (removed, kept): (Vec<&str>, Vec<&str>) = text.lines().partition(|l| l.starts_with(prefix));
        assert!(!removed.is_empty(), "no known_hosts line starts with {prefix:?}: run host.sh up first");
        let mut out: String = kept.iter().map(|l| format!("{l}\n")).collect();
        if let Some(r) = replacement {
            out.push_str(r);
            out.push('\n');
        }
        std::fs::write(&path, out).unwrap();
        Self { path, removed: removed.iter().map(|l| l.to_string()).collect(), replacement: replacement.map(String::from) }
    }
}

impl Drop for KnownHostsSwap {
    fn drop(&mut self) {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        let mut out: String = text.lines().filter(|l| Some(*l) != self.replacement.as_deref()).map(|l| format!("{l}\n")).collect();
        for r in &self.removed {
            out.push_str(r);
            out.push('\n');
        }
        let _ = std::fs::write(&self.path, out);
    }
}

#[test]
#[ignore = "needs the disposable sshd container: test-hosts/ssh/host.sh up <dash|bash|ash>, then PM_SSH_REAL_HOST/PM_SSH_REAL_KEY"]
fn the_real_ssh_transport_against_a_real_sshd() {
    let Some(e) = env() else { panic!("set PM_SSH_REAL_HOST (127.0.0.1:2222) and PM_SSH_REAL_KEY") };
    eprintln!("ssh program: {}", e.exe.display());
    eprintln!("far /bin/sh is: {}", container_sh(&e));
    let mut c = Check { fails: vec![], passes: 0 };
    let echo = words(&["claude-agent-acp"]);
    assert!(!container_has(&e, "/tmp/pwned"), "a stale /tmp/pwned is in the container");

    // The detector itself works (control).
    docker(&["exec", &e.container, "touch", "/tmp/pwned"], None);
    c.ok("control: the /tmp/pwned check can see a file", container_has(&e, "/tmp/pwned"), || "detector blind".into());
    docker(&["exec", &e.container, "rm", "-f", "/tmp/pwned"], None);

    // 1. Plain start: the echo agent answers and runs in the requested folder.
    let plain = format!("{BASE}/plain");
    let mut folders: Vec<String> = FOLDER_NAMES.iter().map(|n| format!("{BASE}/{n}")).collect();
    folders.extend(["/home/tester/sp ace dir", "/home/tester/-dash", "/home/tester/$(touch /tmp/pwned)", "/home/tester/it's"].map(String::from));
    make_folders(&e, &folders);
    match run_once(&e, &e.host, &plain, &echo, "hello") {
        Outcome::Answered(v) => {
            c.ok("echo agent answers the prompt", v["prompt"] == "hello", || v.to_string());
            c.ok("its cwd is the requested folder", v["cwd"] == plain, || v.to_string());
        }
        o => c.ok("echo agent answers", false, || format!("{o:?}")),
    }

    // 2. Hostile folder names round-trip exactly; nothing runs.
    for name in FOLDER_NAMES {
        let f = format!("{BASE}/{name}");
        match run_once(&e, &e.host, &f, &echo, "p") {
            Outcome::Answered(v) => c.ok(&format!("folder {name:?} round-trips"), v["cwd"] == f.as_str(), || v.to_string()),
            o => c.ok(&format!("folder {name:?} round-trips"), false, || format!("{o:?}")),
        }
    }
    for (asked, real) in [
        ("~", "/home/tester"),
        ("~/sp ace dir", "/home/tester/sp ace dir"),
        ("~/-dash", "/home/tester/-dash"),
        ("~/$(touch /tmp/pwned)", "/home/tester/$(touch /tmp/pwned)"),
        ("~/it's", "/home/tester/it's"),
    ] {
        match run_once(&e, &e.host, asked, &echo, "p") {
            Outcome::Answered(v) => c.ok(&format!("home-relative {asked:?}"), v["cwd"] == real, || v.to_string()),
            o => c.ok(&format!("home-relative {asked:?}"), false, || format!("{o:?}")),
        }
    }
    // Control characters in a folder are refused before ssh runs (the app's own rule), so a newline cannot be a folder.
    for bad in ["/x\ny", "/x\ty", "/x\0y"] {
        c.ok(&format!("{bad:?} is refused before ssh"), acp_argv(&e.host, bad, &echo).is_err(), || "accepted".into());
    }

    // 3. Hostile program arguments arrive byte for byte.
    // (a start sends at most 16 words, so the list goes in chunks)
    for (i, chunk) in ARGS.chunks(12).enumerate() {
        let mut with_args = echo.clone();
        with_args.extend(chunk.iter().map(|s| s.to_string()));
        match run_once(&e, &e.host, &plain, &with_args, "p") {
            Outcome::Answered(v) => {
                let got: Vec<String> = v["argv"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or("?").to_string()).collect()).unwrap_or_default();
                let want: Vec<String> = chunk.iter().map(|s| s.to_string()).collect();
                c.ok(&format!("hostile program arguments, part {i}, arrive byte for byte"), got == want, || format!("got {got:?}"));
            }
            o => c.ok(&format!("hostile program arguments, part {i}"), false, || format!("{o:?}")),
        }
    }
    c.ok("nothing hostile ran: /tmp/pwned never existed", !container_has(&e, "/tmp/pwned"), || "/tmp/pwned EXISTS".into());

    // 4. A folder that is not there: exit 97 and the one fixed line.
    match run_once(&e, &e.host, &format!("{BASE}/does-not-exist"), &echo, "p") {
        Outcome::Ended { code, stderr } => {
            c.ok("missing folder: exit 97", code == Some(97), || format!("{code:?} {stderr:?}"));
            c.ok("missing folder: plain sentence", failure_sentence("Test box", "claude-agent-acp", &stderr).as_deref() == Some("That folder was not found on Test box."), || format!("{stderr:?}"));
        }
        o => c.ok("missing folder ends", false, || format!("{o:?}")),
    }

    // 5. A program that is not installed: exit 127 and the plain sentence.
    match run_once(&e, &e.host, &plain, &words(&["no-such-adapter-xyz"]), "p") {
        Outcome::Ended { code, stderr } => {
            c.ok("missing program: exit 127", code == Some(127), || format!("{code:?} {stderr:?}"));
            let s = failure_sentence("Test box", "no-such-adapter-xyz", &stderr);
            c.ok("missing program: plain sentence", s.as_deref().is_some_and(|s| s.contains("not installed on Test box")), || format!("{s:?} {stderr:?}"));
        }
        o => c.ok("missing program ends", false, || format!("{o:?}")),
    }

    // 6. A host key this PC does not know: the host's known_hosts line is taken out for a moment (put back by the guard).
    {
        let _hidden = KnownHostsSwap::new("[127.0.0.1]:2222 ", None);
        match run_once(&e, &e.host, &plain, &echo, "p") {
            Outcome::Ended { code, stderr } => {
                c.ok("unknown host key: ssh refuses (255)", code == Some(255), || format!("{code:?} {stderr:?}"));
                c.ok("unknown host key: the one plain sentence", failure_sentence("Test box", "claude-agent-acp", &stderr).as_deref() == Some(HOST_KEY_UNKNOWN), || format!("{stderr:?}"));
            }
            o => c.ok("unknown host key refused", false, || format!("{o:?}")),
        }
    }

    // 7. A changed host key: the line is replaced by one with a DIFFERENT key (the test user's public key), put back after.
    {
        let other = std::fs::read_to_string(format!("{}.pub", std::env::var("PM_SSH_REAL_KEY").unwrap())).expect("test public key");
        let mut parts = other.split_whitespace();
        let (kind, blob) = (parts.next().unwrap(), parts.next().unwrap());
        let _swapped = KnownHostsSwap::new("[127.0.0.1]:2222 ", Some(&format!("[127.0.0.1]:2222 {kind} {blob}")));
        match run_once(&e, &e.host, &plain, &echo, "p") {
            Outcome::Ended { code, stderr } => {
                c.ok("changed host key: ssh refuses (255)", code == Some(255), || format!("{code:?} {stderr:?}"));
                let s = failure_sentence("Test box", "claude-agent-acp", &stderr);
                c.ok("changed host key: stopped, plain sentence", s.as_deref().is_some_and(|s| s.contains("key changed. Stopped")), || format!("{s:?} {stderr:?}"));
            }
            o => c.ok("changed host key refused", false, || format!("{o:?}")),
        }
    }
    c.ok("the host's known_hosts line is back after both", std::fs::read_to_string(known_hosts_path()).unwrap_or_default().lines().any(|l| l.starts_with("[127.0.0.1]:2222 ssh-ed25519 ")), || "line missing".into());

    eprintln!("RESULT: {} passed, {} failed", c.passes, c.fails.len());
    assert!(c.fails.is_empty(), "failures:\n{}", c.fails.join("\n"));
}

/// Reading a project over the REAL ssh and sshd: the fixed script of `browse` run by the far login shell (dash, bash or ash),
/// with hostile names, text/binary/size limits, links that lead out, a FIFO, git, and a proof that nothing on the host was changed.
#[test]
#[ignore = "needs the disposable sshd container with git: test-hosts/ssh/host.sh up <dash|bash|ash>, then PM_SSH_REAL_HOST/PM_SSH_REAL_KEY"]
fn a_real_ssh_browse_is_read_only_and_cannot_leave_the_project() {
    use super::browse::{BrowseError, Far, FarListing, Gate, MAX_FILE};
    use super::run::LiveRunner;
    let Some(e) = env() else { panic!("set PM_SSH_REAL_HOST (127.0.0.1:2222) and PM_SSH_REAL_KEY") };
    eprintln!("ssh program: {}  far /bin/sh is: {}", e.exe.display(), container_sh(&e));
    let mut c = Check { fails: vec![], passes: 0 };
    let (ok, out) = docker(&["exec", "-i", "-u", "tester", &e.container, "sh", "-s"], Some(include_str!("../../test-hosts/ssh/mk-project.sh")));
    assert!(ok && out.contains("made"), "mk-project: {out}");
    // A marker after the fixture: nothing under the project, the sibling or the outside folder may be newer at the end.
    std::thread::sleep(Duration::from_millis(1100));
    docker(&["exec", "-u", "tester", &e.container, "touch", "/home/tester/mark"], None);
    std::thread::sleep(Duration::from_millis(1100));

    let runner = LiveRunner { exe: e.exe.clone(), pre: Vec::new() };
    let gate = Gate::default();
    let far_in = |folder: &'static str| Far { runner: &runner, host: &e.host, folder, gate: &gate };
    let far = far_in("/home/tester/pj");

    // 1. The project folder: hostile names show up (and are kept as data), the newline and escape names are counted and left out.
    let hostile: &[&str] = &[
        "with space",
        "$(touch tmp-pwned)",
        "`touch tmp-pwned`",
        "a;b|c&d>e<f",
        "-rf",
        "--help",
        "-oProxyCommand=x",
        "100%s %n",
        "$HOME",
        "{a,b}",
        "!hist",
        "back\\slash",
        "~tilde",
        "*",
        "say \"hi\"",
        "caf\u{e9} \u{65e5}",
    ];
    match far.list("") {
        Ok(l) => {
            for n in hostile.iter().chain(["it's changed.txt", "kept.txt", "staged.txt", ".hidden", "..two"].iter()) {
                c.ok(&format!("listed {n:?}"), l.entries.iter().any(|x| x.name == *n && x.kind == "file"), || format!("{:?}", l.entries.iter().map(|x| &x.name).collect::<Vec<_>>()));
            }
            c.ok("sub dir is a folder", l.entries.iter().any(|x| x.name == "sub dir" && x.kind == "dir"), || "missing".into());
            c.ok("a link is listed as a link", l.entries.iter().any(|x| x.name == "out-dir" && x.kind == "link") && l.entries.iter().any(|x| x.name == "out-file" && x.kind == "link"), || "links".into());
            c.ok("a fifo is listed as other", l.entries.iter().any(|x| x.name == "a-fifo" && x.kind == "other"), || "fifo".into());
            c.ok("newline and escape names are counted, not shown", l.skipped >= 2 && l.entries.iter().all(|x| !x.name.contains('\n') && !x.name.contains('\u{1b}')), || format!("skipped {}", l.skipped));
        }
        Err(err) => c.ok("list the project folder", false, || format!("{err:?}")),
    }
    let sub: Result<FarListing, _> = far.list("sub dir/it's");
    c.ok("a nested folder with a quote in its name lists", sub.as_ref().is_ok_and(|l| l.entries.len() == 1 && l.entries[0].name == "deep.txt"), || format!("{sub:?}"));
    c.ok("`~` is the far home", far_in("~/pj").list("").is_ok_and(|l| l.entries.iter().any(|x| x.name == "kept.txt")), || "home".into());

    // 2. Reading: every hostile name byte for byte; binary, too big and exactly-at-the-cap; a fifo does not hang.
    for n in hostile {
        match far.read(n) {
            Ok(f) => c.ok(&format!("read {n:?}"), f.text == format!("content of {n}\n"), || format!("{:?}", f.text)),
            Err(err) => c.ok(&format!("read {n:?}"), false, || format!("{err:?}")),
        }
    }
    c.ok("read a nested file", far.read("sub dir/it's/deep.txt").is_ok_and(|f| f.text == "deep\n"), || "deep".into());
    c.ok("a binary file is refused", far.read("bin.dat") == Err(BrowseError::Binary), || format!("{:?}", far.read("bin.dat")));
    c.ok("a file over the cap is refused", far.read("big.txt") == Err(BrowseError::TooBig), || format!("{:?}", far.read("big.txt")));
    c.ok("a file exactly at the cap is shown", far.read("edge.txt").is_ok_and(|f| f.size == MAX_FILE && f.text.len() == MAX_FILE), || "edge".into());
    c.ok("a fifo is not read (and does not hang)", far.read("a-fifo") == Err(BrowseError::NotFile), || format!("{:?}", far.read("a-fifo")));
    c.ok("a folder is not a file", far.read("sub dir") == Err(BrowseError::NotFile), || "folder".into());
    c.ok("a missing file", far.read("nope.txt") == Err(BrowseError::NotFile), || "missing".into());
    c.ok("a file is not a folder", far.list("kept.txt") == Err(BrowseError::NotFolder), || "file".into());

    // 3. Leaving the project is refused: by the far side for links, by this side for `..` and absolute paths.
    for (what, got, want) in [
        ("a link to a folder outside", far.list("out-dir"), BrowseError::Escape),
        ("a link to a sibling that starts with the project name", far.list("sibling-link"), BrowseError::Escape),
        ("a link up out of a sub folder", far.list("sub dir/up"), BrowseError::Escape),
        ("`..`", far.list("sub dir/.."), BrowseError::BadPath),
        ("`..` at the front", far.list("../outside"), BrowseError::BadPath),
        ("an absolute path", far.list("/home/tester/outside"), BrowseError::BadPath),
    ] {
        c.ok(what, got.as_ref().err() == Some(&want), || format!("{got:?}"));
    }
    for (what, got, want) in [
        ("a file below a link outside", far.read("out-dir/secret.txt"), BrowseError::Escape),
        ("a file below a sibling link", far.read("sibling-link/secret.txt"), BrowseError::Escape),
        ("a link to a file outside", far.read("out-file"), BrowseError::Link),
        ("a link to a file inside is not followed", far.read("in-file"), BrowseError::Link),
        ("`..` in a file path", far.read("../outside/secret.txt"), BrowseError::BadPath),
        ("an absolute file path", far.read("/etc/passwd"), BrowseError::BadPath),
    ] {
        c.ok(what, got.as_ref().err() == Some(&want), || format!("{got:?}"));
    }
    c.ok("a link to a folder inside the project is fine", far.list("in-dir").is_ok_and(|l| l.entries.iter().any(|x| x.name == "it's" && x.kind == "dir")), || "in-dir".into());
    c.ok("a missing project folder", far_in("/home/tester/no-such-folder").list("") == Err(BrowseError::NoFolder), || "nofolder".into());

    // 4. Git: the branch, the changes with hostile names, a staged file; a folder that is no repository.
    match far.status() {
        Ok(s) => {
            c.ok("branch is trunk", s.branch.as_deref() == Some("trunk"), || format!("{:?}", s.branch));
            let has = |p: &str, kind: &str, staged: bool| s.changes.iter().any(|x| x.path == p && x.kind == kind && x.staged == staged);
            c.ok("a modified file", has("it's changed.txt", "modified", false), || format!("{:?}", s.changes));
            c.ok("a hostile new file", has("$(touch tmp-pwned)", "new", false) && has("with space", "new", false), || format!("{:?}", s.changes));
            c.ok("a staged file", has("staged.txt", "added", true), || format!("{:?}", s.changes));
            c.ok("no change path holds a control character", s.changes.iter().all(|x| !x.path.chars().any(|ch| ch.is_control())), || "control".into());
        }
        Err(err) => c.ok("git status", false, || format!("{err:?}")),
    }
    let not_repo = far_in("/home/tester/outside").status();
    c.ok("not a git folder", not_repo.as_ref().err() == Some(&BrowseError::NotRepo), || format!("{not_repo:?}"));

    // 5. Two at a time per machine, and every call answers.
    let peak = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (runner, host, gate) = (&runner, &e.host, &gate);
        let hs: Vec<_> = (0..5).map(|_| s.spawn(move || Far { runner, host, folder: "/home/tester/pj", gate }.list("sub dir").is_ok())).collect();
        for _ in 0..40 {
            peak.fetch_max(gate.in_use(&host.id), std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(50));
        }
        c.ok("five parallel reads all answer", hs.into_iter().all(|h| h.join().unwrap()), || "a read failed".into());
    });
    c.ok("never more than two at once", peak.load(std::sync::atomic::Ordering::SeqCst) <= 2, || format!("peak {}", peak.load(std::sync::atomic::Ordering::SeqCst)));

    // 6. Nothing hostile ran and nothing on the host was changed.
    c.ok("no injected command ran", !container_has(&e, "/home/tester/pj/tmp-pwned") && !container_has(&e, "/home/tester/tmp-pwned") && !container_has(&e, "/tmp/pwned"), || "tmp-pwned EXISTS".into());
    let (_, newer) = docker(&["exec", "-u", "tester", &e.container, "find", "/home/tester/pj", "/home/tester/pj-evil", "/home/tester/outside", "-newer", "/home/tester/mark"], None);
    c.ok("nothing under the project, the sibling or the outside folder was changed", newer.trim().is_empty(), || format!("newer: {newer}"));

    eprintln!("RESULT: {} passed, {} failed", c.passes, c.fails.len());
    assert!(c.fails.is_empty(), "failures:\n{}", c.fails.join("\n"));
}
