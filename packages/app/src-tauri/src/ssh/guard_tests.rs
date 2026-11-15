//! Source guards for the Over SSH rules. Tests only: they read the files and fail when a forbidden word shows up.

use std::fs;
use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// The non-test sources of `ssh/`.
fn ssh_sources() -> Vec<(String, String)> {
    let dir = src_dir().join("ssh");
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).expect("read src/ssh").flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if path.extension().is_some_and(|e| e == "rs") && name != "tests.rs" && name != "guard_tests.rs" {
            out.push((name, fs::read_to_string(&path).expect("read a source")));
        }
    }
    assert!(out.len() >= 6, "the ssh sources were found");
    out
}

fn code_lines(src: &str) -> Vec<&str> {
    src.lines().filter(|l| !l.trim_start().starts_with("//")).collect()
}

#[test]
fn host_key_checking_is_not_weakened_anywhere() {
    for (name, src) in ssh_sources() {
        for line in code_lines(&src) {
            let low = line.to_ascii_lowercase();
            for bad in ["stricthostkeychecking=no", "stricthostkeychecking=off", "stricthostkeychecking=accept", "userknownhostsfile", "-oStrict", "loglevel=quiet", "checkhostip=no"] {
                assert!(!low.contains(&bad.to_ascii_lowercase()), "{name}: {line}");
            }
        }
    }
}

#[test]
fn the_key_file_is_never_opened() {
    // Only the store touches files, and only its own JSON file. Nothing else names the file system or a reader.
    for (name, src) in ssh_sources() {
        if name == "store.rs" {
            continue;
        }
        for line in code_lines(&src) {
            for bad in ["std::fs", "fs::", "File::", "read_to_string", "read_to_end", "BufReader"] {
                assert!(!line.contains(bad), "{name}: {line}");
            }
        }
    }
}

#[test]
fn no_password_is_asked_or_kept() {
    for (name, src) in ssh_sources() {
        for line in code_lines(&src) {
            let low = line.to_ascii_lowercase();
            assert!(!low.contains("sshpass") && !low.contains("askpass") && !low.contains("ssh_askpass"), "{name}: {line}");
            // The only place a password is named is the sentence that says nobody stores one, and the options that stop prompts.
            if low.contains("password") {
                assert!(
                    low.contains("numberofpasswordprompts") || low.contains("wrong key or password") || low.contains("type the password there") || low.contains("no password"),
                    "{name}: {line}"
                );
            }
        }
    }
}

#[test]
fn the_bridge_and_the_agent_tools_do_not_know_about_ssh() {
    // Desktop only: no phone route, no MCP tool and no device-link request can start an ssh.
    for dir in ["bridge", "mcp_shim", "mobile_pairing", "device_link", "p2p"] {
        let mut stack = vec![src_dir().join(dir)];
        while let Some(d) = stack.pop() {
            let Ok(rd) = fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let text = fs::read_to_string(&p).unwrap_or_default();
                    assert!(!text.contains("crate::ssh"), "{} names the ssh module", p.display());
                }
            }
        }
    }
}

#[test]
fn an_ssh_pane_gets_no_login_hook_or_env_of_this_pc() {
    // The spawn skips accounts, hooks, pane MCP and the model bridge for a pane that runs on another machine.
    let spawn = fs::read_to_string(src_dir().join("pty").join("registry").join("spawn.rs")).unwrap();
    assert!(spawn.contains("let remote = linux.is_some() || ssh.is_some();"));
    assert!(spawn.contains("LaunchEnv::default()"));
}
