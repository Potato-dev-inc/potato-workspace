//! "Set it up": the one button that puts `potato-host` on an SSH machine and pairs this PC with it (plan 3.3).
//!
//! The rule that keeps this safe: **the only remote command lines are the fixed ones in this file.** No text from the
//! person or from the far machine is ever put into one (there is no `format!` here, a guard test reads the source).
//! The program's bytes and this PC's pairing line travel on stdin. The far side prints its own checksum and this PC
//! compares it, so nothing is spliced into a command. No scp, no forwarding (`ClearAllForwardings=yes`), no password,
//! no root: everything lives under the SSH user's home.
//!
//! The runner and the bytes come from outside (`commands/ssh.rs` reads the file, the tests pass a fake), so this module
//! touches no file and starts no process of its own.

use crate::ssh::command::setup_argv;
use crate::ssh::model::{classify, clean_line, SshHost, SshState};
use crate::ssh::run::{Output, Runner};
use serde::Serialize;
use std::time::Duration;

/// What the far machine is: one read-only script (the check's cousin).
pub const LOOK: &str = r#"/bin/sh -lc 'echo "os=$(uname -s 2>/dev/null)"; echo "arch=$(uname -m 2>/dev/null)"; echo "glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null)"; echo "free_kb=$(df -Pk "$HOME" 2>/dev/null | tail -n 1 | tr -s " " | cut -d" " -f4)"; if systemctl --user show-environment >/dev/null 2>&1; then echo "systemd=1"; fi; B="$HOME/.local/share/potato-workspace/bin/potato-host"; if [ -x "$B" ] && [ -f "$B.tar.gz" ]; then echo "host_sha=$(sha256sum "$B.tar.gz" 2>/dev/null | cut -d" " -f1)"; fi; if pgrep -x potato-host >/dev/null 2>&1; then echo "running=1"; fi'"#;
/// The release file (`potato-host-linux-x86_64.tar.gz`) arrives on stdin and lands beside the real program, private to the user (umask 077).
pub const COPY: &str = r#"/bin/sh -c 'umask 077; D="$HOME/.local/share/potato-workspace/bin"; mkdir -p "$D" && cat > "$D/potato-host.tar.gz.new"'"#;
/// The far side's own checksum of the copy (the release's `.sha256` is of this file); this PC compares it with the one it expects.
pub const VERIFY: &str = r#"/bin/sh -c 'sha256sum "$HOME/.local/share/potato-workspace/bin/potato-host.tar.gz.new" | cut -d" " -f1'"#;
/// Unpacks the checked copy into a scratch folder, makes the program runnable and swaps it in (a rename: a running old program keeps
/// running until it is restarted). The checked tarball is kept as `potato-host.tar.gz`: its checksum says which release is installed.
pub const FINISH: &str = r#"/bin/sh -c 'D="$HOME/.local/share/potato-workspace/bin"; rm -rf "$D/.new" && mkdir -p "$D/.new" && tar -xzf "$D/potato-host.tar.gz.new" -C "$D/.new" potato-host && chmod 700 "$D/.new/potato-host" && mv -f "$D/.new/potato-host" "$D/potato-host" && mv -f "$D/potato-host.tar.gz.new" "$D/potato-host.tar.gz" && rm -rf "$D/.new"'"#;
/// Asks a running program to stop (an update restarts it). Fine when nothing runs.
pub const STOP: &str = r#"/bin/sh -c '"$HOME/.local/share/potato-workspace/bin/potato-host" stop'"#;
/// Writes and starts the user unit (systemd --user).
pub const SERVICE: &str = r#"/bin/sh -lc '"$HOME/.local/share/potato-workspace/bin/potato-host" install-service'"#;
/// The start for a machine with no `systemctl --user`: in the background, nothing on its output.
pub const NOHUP: &str = r#"/bin/sh -c 'nohup "$HOME/.local/share/potato-workspace/bin/potato-host" run </dev/null >/dev/null 2>&1 &'"#;
/// Waits a moment and says (by its exit code) whether the program is running.
pub const RUNNING: &str = r#"/bin/sh -c 'sleep 2; pgrep -x potato-host >/dev/null'"#;
/// Prints the machine's ids as one line, reads this PC's line on stdin, trusts it. SSH already proved both ends.
pub const PAIR: &str = r#"/bin/sh -c '"$HOME/.local/share/potato-workspace/bin/potato-host" pair --stdio'"#;

/// Every line this module may send. A guard test checks the argv of every call against this list.
pub const ALL_LINES: [&str; 9] = [LOOK, COPY, VERIFY, FINISH, STOP, SERVICE, NOHUP, RUNNING, PAIR];

pub const ATTEMPTS: u8 = 3;
/// Version 1 is x86_64 glibc only (plan 3.6). The newest glibc symbol the built host needs is 2.34 (measured with `readelf -V`; the build script
/// fails if it drifts). shortcut: build on an older base to reach boxes older than 2.34, then lower this.
pub const MIN_GLIBC: (u32, u32) = (2, 34);
pub const MIN_FREE_KB: u64 = 200 * 1024;
const COPY_DEADLINE: Duration = Duration::from_secs(300);
const LINE_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Look,
    Copy,
    Finish,
    Pair,
    Start,
}

/// What `LOOK` found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Look {
    pub os: String,
    pub arch: String,
    pub glibc: Option<(u32, u32)>,
    pub free_kb: Option<u64>,
    pub systemd_user: bool,
    /// The checksum of the program already there, if any.
    pub host_sha: Option<String>,
    pub running: bool,
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn parse_look(stdout: &str) -> Look {
    let mut l = Look::default();
    for line in stdout.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        let v: String = v.chars().filter(|c| !c.is_control()).take(80).collect();
        match k {
            "os" => l.os = v,
            "arch" => l.arch = v,
            // "glibc 2.35"
            "glibc" => {
                l.glibc = v.rsplit(' ').next().and_then(|n| n.split_once('.')).and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)));
            }
            "free_kb" => l.free_kb = v.parse().ok(),
            "systemd" => l.systemd_user = v == "1",
            "host_sha" if is_hex64(&v) => l.host_sha = Some(v.to_ascii_lowercase()),
            "running" => l.running = v == "1",
            _ => {}
        }
    }
    l
}

/// Why a machine cannot take the program (before anything is copied).
pub fn refusal(l: &Look) -> Option<&'static str> {
    if l.os != "Linux" {
        return Some("not_linux");
    }
    if l.arch != "x86_64" {
        return Some("not_x86_64");
    }
    if l.glibc.map_or(true, |g| g < MIN_GLIBC) {
        return Some("glibc_old");
    }
    if l.free_kb.is_some_and(|k| k < MIN_FREE_KB) {
        return Some("disk_full");
    }
    None
}

/// The program to put on the machine: its bytes and the checksum it must have (hex, from a verified source).
pub struct Asset<'a> {
    pub bytes: &'a [u8],
    pub sha256: &'a str,
}

/// The far machine's answer to `PAIR`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paired {
    pub node: String,
    pub device_pub: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    /// Set when this run paired (not for an update of a machine that is already paired).
    pub paired: Option<Paired>,
    /// Nothing had to be copied: the same program was already there and running.
    pub already_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub step: Step,
    /// A code the screen turns into a sentence: `cannot_reach`, `wrong_key`, `host_key_unknown`, `host_key_changed`, `not_linux`,
    /// `not_x86_64`, `glibc_old`, `disk_full`, `hash_mismatch`, `pair_refused`, `step_failed`.
    pub why: &'static str,
    /// The far machine's own first line, cleaned. Untrusted text, shown as text only.
    pub line: String,
    /// What to paste in a shell on the machine when this step cannot be done from here (the same fixed line, not new text).
    pub handoff: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Doing(Step),
    /// The attempt that just failed (1 or 2); another follows.
    Retrying(Step, u8),
    Done(Step),
}

pub struct Plan<'a> {
    pub asset: Asset<'a>,
    /// This PC's pairing line (one JSON line). `None` when the machine is already paired (an update).
    pub pair_line: Option<&'a str>,
    /// Waits between attempts (a no-op in tests).
    pub pause: &'a dyn Fn(Duration),
}

fn fail(step: Step, why: &'static str, line: &str, handoff: Option<&'static str>) -> Failure {
    Failure { step, why, line: clean_line(line, 160), handoff }
}

/// One line over ssh. A wrong key or a changed host key stops at once (retrying only locks the account out or hides a warning);
/// a machine that cannot be reached, or a command that failed, may work next time.
fn send(runner: &dyn Runner, host: &SshHost, line: &str, input: Option<&[u8]>, step: Step, handoff: Option<&'static str>) -> Result<Output, (Failure, bool)> {
    let argv = setup_argv(host, line);
    let out = match input {
        Some(b) => runner.run_input(&argv, b, if step == Step::Copy { COPY_DEADLINE } else { LINE_DEADLINE }),
        None => runner.run(&argv, LINE_DEADLINE),
    };
    let out = out.map_err(|e| (fail(step, "cannot_reach", &e, None), true))?;
    if out.ok && !out.timed_out {
        return Ok(out);
    }
    Err(match classify(false, out.timed_out, &out.stderr) {
        SshState::WrongKey => (fail(step, "wrong_key", "", None), false),
        SshState::HostKeyUnknown => (fail(step, "host_key_unknown", "", None), false),
        SshState::HostKeyChanged => (fail(step, "host_key_changed", "", None), false),
        SshState::CannotReach => (fail(step, "cannot_reach", "", None), true),
        _ => (fail(step, "step_failed", &out.stderr, handoff), true),
    })
}

/// Up to `ATTEMPTS` tries of one step; stops early on a failure that retrying cannot fix.
fn attempt<T>(plan: &Plan, step: Step, report: &mut dyn FnMut(Event), mut f: impl FnMut() -> Result<T, (Failure, bool)>) -> Result<T, Failure> {
    report(Event::Doing(step));
    for n in 1..=ATTEMPTS {
        match f() {
            Ok(v) => {
                report(Event::Done(step));
                return Ok(v);
            }
            Err((fl, retry)) if !retry || n == ATTEMPTS => return Err(fl),
            Err(_) => {
                report(Event::Retrying(step, n));
                (plan.pause)(Duration::from_secs(2 * u64::from(n)));
            }
        }
    }
    unreachable!("the loop returns on its last attempt")
}

fn parse_pair(stdout: &str) -> Result<Paired, Failure> {
    let refused = |m: &str| fail(Step::Pair, "pair_refused", m, None);
    let mut lines = stdout.lines().map(str::trim).filter(|l| l.starts_with('{'));
    let mine: serde_json::Value = lines.next().and_then(|l| serde_json::from_str(l).ok()).ok_or_else(|| refused("The machine did not answer."))?;
    let done: serde_json::Value = lines.next().and_then(|l| serde_json::from_str(l).ok()).ok_or_else(|| refused("The machine did not confirm."))?;
    if done["paired"] != serde_json::Value::Bool(true) {
        return Err(refused(done["error"].as_str().unwrap_or("The machine refused.")));
    }
    let (node, device_pub) = (mine["node"].as_str().unwrap_or(""), mine["device_pub"].as_str().unwrap_or(""));
    if mine["potato_host"] != 1 || !is_hex64(node) || !is_hex64(device_pub) {
        return Err(refused("The machine's ids were not valid."));
    }
    let name: String = mine["name"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(40).collect();
    Ok(Paired { node: node.to_ascii_lowercase(), device_pub: device_pub.to_ascii_lowercase(), name })
}

/// Look, copy, check, swap in, pair (first time only), start. Each step is tried up to three times.
pub fn run(runner: &dyn Runner, host: &SshHost, plan: &Plan, report: &mut dyn FnMut(Event)) -> Result<Done, Failure> {
    let want = plan.asset.sha256.to_ascii_lowercase();
    let look = attempt(plan, Step::Look, report, || {
        send(runner, host, LOOK, None, Step::Look, None).map(|o| parse_look(&o.stdout))
    })?;
    if let Some(why) = refusal(&look) {
        return Err(fail(Step::Look, why, "", None));
    }
    let current = look.host_sha.as_deref() == Some(want.as_str());
    if !current {
        attempt(plan, Step::Copy, report, || {
            send(runner, host, COPY, Some(plan.asset.bytes), Step::Copy, None)?;
            let got = send(runner, host, VERIFY, None, Step::Copy, None)?;
            if got.stdout.trim().to_ascii_lowercase() == want {
                Ok(())
            } else {
                Err((fail(Step::Copy, "hash_mismatch", "", None), true))
            }
        })?;
        attempt(plan, Step::Finish, report, || send(runner, host, FINISH, None, Step::Finish, Some(FINISH)).map(|_| ()))?;
    }
    // Pair BEFORE the program starts: a running program reads its trust list once.
    let paired = match plan.pair_line {
        Some(line) => {
            let mut input = line.trim_end().as_bytes().to_vec();
            input.push(b'\n');
            Some(attempt(plan, Step::Pair, report, || {
                let out = send(runner, host, PAIR, Some(&input), Step::Pair, None)?;
                parse_pair(&out.stdout).map_err(|f| (f, false))
            })?)
        }
        None => None,
    };
    if current && look.running {
        return Ok(Done { paired, already_current: true });
    }
    attempt(plan, Step::Start, report, || {
        // A new program replaces a running one: ask the old one to stop first (it is fine when none runs).
        let _ = send(runner, host, STOP, None, Step::Start, None);
        if look.systemd_user {
            send(runner, host, SERVICE, None, Step::Start, Some(SERVICE))?;
        } else {
            send(runner, host, NOHUP, None, Step::Start, Some(NOHUP))?;
        }
        send(runner, host, RUNNING, None, Step::Start, Some(NOHUP)).map(|_| ())
    })?;
    Ok(Done { paired, already_current: false })
}

