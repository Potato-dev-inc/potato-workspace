//! Starting `opencode serve`: the environment it gets and the wait until it answers.
//!
//! OpenCode keeps its data (database, login) in its normal folder (`~/.local/share/opencode`).
//! The app moves that folder only for an OpenCode account the person picked; a missing or
//! unconfigured key profile never does. The wait watches the child: one that exits before it is
//! healthy fails the start at once, carrying its own last output.

use std::io::Read;
use std::process::Child;
use std::sync::Arc;
use std::time::{Duration, Instant};

const OUTPUT_CAP: usize = 16 * 1024;
const TAIL_LINES: usize = 8;
const POLL: Duration = Duration::from_millis(100);

/// What the serve process has printed so far, shared with the threads that drain its pipes.
pub(super) type Output = Arc<parking_lot::Mutex<Vec<u8>>>;

/// The variables set on `opencode serve` for the data folder: none unless an account was picked.
/// (`XDG_DATA_HOME` is OpenCode's data folder; it comes only from the account's launch env.)
pub(super) fn data_env(account: Option<&crate::tui::LaunchEnv>) -> crate::tui::LaunchEnv {
    account.cloned().unwrap_or_default()
}

/// Put `env` on `command`.
pub(super) fn apply_env(command: &mut std::process::Command, env: &crate::tui::LaunchEnv) {
    for name in &env.remove {
        command.env_remove(name);
    }
    for (name, value) in &env.set {
        command.env(name, value);
    }
}

/// Collect the child's stdout and stderr into one capped buffer (drained on threads, so the child
/// never blocks on a full pipe). Call after `spawn`, with both streams piped.
pub(super) fn capture_output(child: &mut Child) -> Output {
    let buffer: Output = Arc::new(parking_lot::Mutex::new(Vec::new()));
    if let Some(pipe) = child.stdout.take() {
        drain(pipe, Arc::clone(&buffer));
    }
    if let Some(pipe) = child.stderr.take() {
        drain(pipe, Arc::clone(&buffer));
    }
    buffer
}

fn drain<R: Read + Send + 'static>(mut pipe: R, buffer: Output) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 2048];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut held = buffer.lock();
            held.extend_from_slice(&chunk[..n]);
            let over = held.len().saturating_sub(OUTPUT_CAP);
            if over > 0 {
                held.drain(..over);
            }
        }
    });
}

/// The last lines of the child's output, plain text, secrets masked.
pub(super) fn output_tail(output: &Output) -> String {
    let raw = String::from_utf8_lossy(&output.lock()).into_owned();
    let plain = crate::pty::ansi::strip_ansi(&raw);
    let lines: Vec<&str> = plain.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let start = lines.len().saturating_sub(TAIL_LINES);
    crate::redact::text(&lines[start..].join("\n")).into_inner()
}

/// Wait until `healthy` says the server answers. Fails at once when the child exits first (with its
/// own last output) and after `timeout` otherwise.
pub(super) fn wait_until_healthy(
    child: &mut Child,
    output: &Output,
    timeout: Duration,
    mut healthy: impl FnMut() -> bool,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            // The drain threads may still hold the last bytes.
            std::thread::sleep(Duration::from_millis(150));
            return Err(exited_message(&status.to_string(), &output_tail(output)));
        }
        if healthy() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let tail = output_tail(output);
            let mut message = format!("OpenCode server not healthy within {}s", timeout.as_secs());
            if !tail.is_empty() {
                message.push_str(&format!("; its output: {tail}"));
            }
            return Err(message);
        }
        std::thread::sleep(POLL);
    }
}

/// True when the child itself printed that it listens on `port`: the server answering that port is
/// the one we started, not another program's.
pub(super) fn reports_listening(output: &Output, port: u16) -> bool {
    let raw = String::from_utf8_lossy(&output.lock()).into_owned();
    let plain = crate::pty::ansi::strip_ansi(&raw);
    plain.lines().any(|line| {
        line.contains("listening on")
            && (line.contains(&format!("127.0.0.1:{port}")) || line.contains(&format!("localhost:{port}")))
    })
}

fn exited_message(status: &str, tail: &str) -> String {
    if tail.is_empty() {
        format!("OpenCode exited ({status}) before it was ready, with no output")
    } else {
        format!("OpenCode exited ({status}): {tail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn fake_child(script: &str) -> Child {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", script]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.args(["-c", script]);
            c
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.spawn().expect("spawn fake child")
    }

    #[test]
    fn no_account_means_no_data_folder_override() {
        let env = data_env(None);
        assert!(env.set.is_empty() && env.remove.is_empty());
        let account = crate::tui::LaunchEnv { set: vec![("XDG_DATA_HOME".into(), "C:/acct".into())], remove: Vec::new() };
        assert_eq!(data_env(Some(&account)).set, account.set);
    }

    #[test]
    fn a_child_that_exits_at_once_fails_the_wait_fast_with_its_stderr() {
        #[cfg(windows)]
        let script = "echo Error: Unexpected error 1>&2 & echo Database is not empty and has no session table 1>&2 & exit 1";
        #[cfg(not(windows))]
        let script = "echo 'Error: Unexpected error' >&2; echo 'Database is not empty and has no session table' >&2; exit 1";
        let mut child = fake_child(script);
        let output = capture_output(&mut child);
        let started = Instant::now();
        let err = wait_until_healthy(&mut child, &output, Duration::from_secs(45), || false).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
        assert!(err.starts_with("OpenCode exited"), "{err}");
        assert!(err.contains("Database is not empty and has no session table"), "{err}");
    }

    #[test]
    fn only_the_childs_own_listening_line_for_our_port_counts() {
        let out: Output = Arc::new(parking_lot::Mutex::new(Vec::new()));
        assert!(!reports_listening(&out, 4097));
        out.lock().extend_from_slice(b"Warning: not set
opencode server listening on http://127.0.0.1:4096
");
        assert!(!reports_listening(&out, 4097));
        out.lock().extend_from_slice(b"opencode server listening on http://127.0.0.1:4097
");
        assert!(reports_listening(&out, 4097));
    }

    #[test]
    fn a_port_taken_on_any_interface_is_not_picked() {
        let held = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let picked = super::super::process::pick_free_port(port, port);
        assert!(picked.is_err(), "{picked:?}");
    }

    #[test]
    fn a_secret_in_the_child_output_is_masked() {
        #[cfg(windows)]
        let script = "echo token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 1>&2 & exit 1";
        #[cfg(not(windows))]
        let script = "echo 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' >&2; exit 1";
        let mut child = fake_child(script);
        let output = capture_output(&mut child);
        let err = wait_until_healthy(&mut child, &output, Duration::from_secs(10), || false).unwrap_err();
        assert!(!err.contains("abcdefghijklmnopqrstuvwxyz0123456789"), "{err}");
    }

    #[test]
    fn a_healthy_running_child_passes_and_a_silent_one_times_out() {
        #[cfg(windows)]
        let script = "ping -n 30 127.0.0.1 >nul";
        #[cfg(not(windows))]
        let script = "sleep 30";
        let mut child = fake_child(script);
        let output = capture_output(&mut child);
        assert!(wait_until_healthy(&mut child, &output, Duration::from_secs(5), || true).is_ok());
        let err = wait_until_healthy(&mut child, &output, Duration::from_millis(300), || false).unwrap_err();
        assert!(err.contains("not healthy"), "{err}");
        crate::pty::proc_tree::kill_process_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}
