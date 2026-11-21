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
        if path.extension().is_some_and(|e| e == "rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
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

#[test]
fn the_bridge_refuses_a_chat_on_another_computer_before_any_route_runs() {
    // Chats over SSH are the app window's alone: the router checks the request for a remote pane's id before authorization and routing.
    let router = fs::read_to_string(src_dir().join("bridge").join("router.rs")).unwrap();
    let guard = router.find("remote_pane_refusal(&crate::acp::chat::remote_pane_ids()").expect("the router calls the guard");
    let authorize = router.find("crate::mcp_sessions::authorize(session, method, &route_path").expect("the router authorizes");
    assert!(guard < authorize, "the remote-pane check comes first");
    // And the pane list a phone or an agent reads leaves remote chats out.
    let panes = fs::read_to_string(src_dir().join("bridge").join("routes").join("panes.rs")).unwrap();
    assert!(panes.contains("crate::acp::chat::external_panes(registry)"));
}

#[test]
fn every_pane_list_a_phone_or_an_agent_reads_leaves_remote_chats_out() {
    // The first frames of the event streams, the pushed pane list, the agent list and the adoption candidates all go through
    // `acp::chat::external_panes`; none of them reads the registry list directly.
    for (file, needle) in [
        ("bridge/sse.rs", "first_frames(&viewer, &crate::acp::chat::external_panes(&registry), &settings)"),
        ("bridge/sse.rs", "let panes = crate::acp::chat::external_panes(registry);"),
        ("bridge/ws.rs", "first_frames(&viewer, &crate::acp::chat::external_panes(&registry), &settings)"),
        ("bridge/routes/panes.rs", "let panes = crate::acp::chat::external_panes(registry);"),
        ("agent_runs/routes/list.rs", "crate::acp::chat::external_panes(registry)"),
        ("bridge/dispatch.rs", "let existing_panes = crate::acp::chat::external_panes(registry);"),
    ] {
        let text = fs::read_to_string(src_dir().join(file)).unwrap().replace("\r\n", "\n");
        assert!(text.contains(needle), "{file} must list panes through external_panes: {needle}");
    }
}

/// Every file a phone, another PC, an agent (MCP) or an event stream can reach, and the shared helper it must use so a chat that runs on
/// another computer is never listed, read, driven, approved or announced there. A new route in one of these files that forgets it is
/// caught here only if the file loses ALL its references; each file also has its own behavioural test (see the chat tests).
const MUST_USE_REMOTE_PANE_CHECK: &[&str] = &[
    "bridge/router.rs",
    "bridge/ws.rs",
    "bridge/sse.rs",
    "bridge/routes/panes.rs",
    "bridge/dispatch.rs",
    "questions/routes.rs",
    "device_link/pclink/app_services.rs",
    "turn_summary/mod.rs",
    "companion/live.rs",
    "agent_runs/routes/list.rs",
    "agent_runs/headless/bind.rs",
    "agent_runs/headless/supervise.rs",
    "pane_outbox/mod.rs",
    "pane_outbox/live.rs",
    "push/mod.rs",
    "attention/answer.rs",
    "pty/registry/mod.rs",
    "questions/mod.rs",
];

#[test]
fn every_bridge_phone_pclink_and_event_file_uses_the_shared_remote_pane_check() {
    for file in MUST_USE_REMOTE_PANE_CHECK {
        let text = fs::read_to_string(src_dir().join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
        assert!(
            text.contains("is_remote_pane") || text.contains("external_panes") || text.contains("remote_refusal") || text.contains("remote_pane_refusal"),
            "{file} must ask the shared check (acp::chat::is_remote_pane / external_panes)"
        );
    }
}

#[test]
fn the_default_accessors_are_the_safe_ones_and_the_window_names_its_own() {
    let crlf = String::from("\r\n");
    let read = |file: &str| fs::read_to_string(src_dir().join(file)).unwrap().replace(crlf.as_str(), "\n");
    let registry = read("pty/registry/mod.rs");
    assert!(registry.contains("&& !crate::acp::chat::is_remote_pane(&pane.info.id)"));
    assert!(registry.contains("pub fn list_including_remote("));
    let questions = read("questions/mod.rs");
    for name in ["pub fn list_pending(", "pub fn answer(", "pub fn dismiss("] {
        let at = questions.find(name).unwrap_or_else(|| panic!("{name}"));
        assert!(questions[at..].lines().take(6).any(|l| l.contains("is_remote")), "{name} must be the safe default");
    }
    let outbox = read("pane_outbox/mod.rs");
    assert!(outbox.contains("pub fn send_including_remote("));
    // Only the app window's own files name an `including_remote` call.
    let windowed = ["commands/panes.rs", "commands/cockpit.rs", "cockpit.rs", "commands/questions.rs", "commands/pane_outbox.rs", "commands/app_update.rs", "tray.rs", "panic.rs", "ambient/mod.rs", "ambient/badge.rs", "attention/mod.rs"];
    let mut stack = vec![src_dir()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().map_or(true, |e| e != "rs") {
                continue;
            }
            let rel = path.strip_prefix(src_dir()).unwrap().to_string_lossy().replace('\\', "/");
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if rel.ends_with("tests.rs") || name.ends_with("_tests.rs") || rel.starts_with("ssh/") || rel == "questions/mod.rs" || rel == "pty/registry/mod.rs" || rel == "pty/registry/virtual_pane.rs" || rel == "pane_outbox/mod.rs" || rel == "acp/chat/mod.rs" || rel == "acp/chat/start.rs" || windowed.contains(&rel.as_str()) {
                continue;
            }
            let text = fs::read_to_string(&path).unwrap_or_default();
            assert!(!text.contains("including_remote"), "{rel} is not an app-window file but asks for remote chats: use the safe default");
        }
    }
}

#[test]
fn the_websocket_refuses_input_and_watch_for_a_remote_pane_and_the_status_hooks_skip_it() {
    let ws = fs::read_to_string(src_dir().join("bridge").join("ws.rs")).unwrap().replace("
", "
");
    assert!(ws.matches("is_remote_pane").count() >= 3, "watch, input and write_input each ask");
    let sse = fs::read_to_string(src_dir().join("bridge").join("sse.rs")).unwrap().replace("
", "
");
    assert!(sse.contains("is_remote_pane(pane_id) && !matches!(hook, StatusHook::PaneActivity | StatusHook::Ambient)"));
    for push in ["push_pane_status_sse", "push_pane_activity_sse", "push_pane_preview_sse", "push_loop_signal_sse", "push_pane_resize_sse", "push_terminal_sse"] {
        let at = sse.find(&format!("pub fn {push}(")).unwrap_or_else(|| panic!("{push}"));
        assert!(sse[at..].lines().take(14).any(|l| l.contains("is_remote_pane")), "{push} must skip a remote pane");
    }
    let pc = fs::read_to_string(src_dir().join("device_link").join("pclink").join("app_services.rs")).unwrap().replace("
", "
");
    for handler in ["transcript", "transcript_earlier", "picture", "screen", "outbox", "send", "cancel_message", "interrupt", "set_config", "input", "close"] {
        let at = pc.find(&format!("    fn {handler}(&self,")).unwrap_or_else(|| panic!("{handler}"));
        assert!(pc[at..].lines().take(3).any(|l| l.contains("remote_refusal")), "pclink {handler} must refuse a remote pane");
    }
}

/// A raw read of the pane map (`.panes.keys()`, `.iter()`, `.values()`) bypasses the safe `list()`. Such a file must either be on this
/// allow-list (the window's and the process lifecycle's own code, or a struct whose own field is named `panes`) or filter with the shared
/// check itself (`is_remote_pane` / `resolvable_pane_ids`). A new file that enumerates the registry fails here.
#[test]
fn no_file_enumerates_the_raw_pane_map_without_the_shared_check_or_an_allow_list_entry() {
    const ALLOWED: &[&str] = &[
        "pty/registry/",
        "companion/caller.rs",
        "commands/session_chat.rs",
        "fake_tui/",
        "attention/derive.rs",
        "attention/store.rs",
        "collision/alerts.rs",
        "review_desk/marks.rs",
        "switch_anim/glue.rs",
        "crews/follow.rs",
    ];
    let mut stack = vec![src_dir()];
    let mut flagged = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if path.extension().map_or(true, |e| e != "rs") || name.contains("test") {
                continue;
            }
            let rel = path.strip_prefix(src_dir()).unwrap().to_string_lossy().replace('\\', "/");
            if rel.starts_with("ssh/") || ALLOWED.iter().any(|a| rel.starts_with(a)) {
                continue;
            }
            let text = fs::read_to_string(&path).unwrap_or_default();
            let mut at = 0;
            let mut raw_read = false;
            while let Some(found) = text[at..].find(".panes") {
                let after = text[at + found + ".panes".len()..].trim_start();
                let before = text[..at + found].trim_end();
                let own_field = before.ends_with("self") || before.ends_with("store") || before.ends_with("inner") || before.ends_with("facts") || before.ends_with("state");
                if !own_field && [".keys(", ".iter(", ".values(", ".iter_mut(", ".values_mut("].iter().any(|m| after.starts_with(m)) {
                    raw_read = true;
                    break;
                }
                at += found + ".panes".len();
            }
            if raw_read && !(text.contains("is_remote_pane") || text.contains("resolvable_pane_ids")) {
                flagged.push(rel);
            }
        }
    }
    assert!(flagged.is_empty(), "these files read the raw pane map without the shared remote check: {flagged:?}");
}

#[test]
fn reading_a_remote_project_is_window_only_gated_and_read_only() {
    // The three read commands are known to the window alone: no bridge route, MCP tool, phone, PC link or pairing code names them.
    let names = ["ssh_fs_list", "ssh_fs_read", "ssh_git_status", "ssh::browse"];
    for dir in ["bridge", "mcp_shim", "mobile_pairing", "device_link", "p2p", "agent_runs", "mcp_sessions", "questions"] {
        let mut stack = vec![src_dir().join(dir)];
        while let Some(d) = stack.pop() {
            let Ok(rd) = fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let text = fs::read_to_string(&p).unwrap_or_default();
                    for n in names {
                        assert!(!text.contains(n), "{} names {n}", p.display());
                    }
                }
            }
        }
    }
    // Each command checks the Labs switch first, and the screen never names the machine or the folder (only the pane).
    let cmds = fs::read_to_string(src_dir().join("commands").join("ssh.rs")).unwrap().replace("\r\n", "\n");
    let body = &cmds[cmds.find("async fn browse_command").expect("browse_command")..];
    assert!(body[..body.find("#[tauri::command]").unwrap()].contains("ssh_chat_gate(ssh_chat_on(app))?"));
    for name in ["ssh_fs_list", "ssh_fs_read", "ssh_git_status"] {
        let at = cmds.find(&format!("pub async fn {name}(")).unwrap_or_else(|| panic!("{name}"));
        let sig = &cmds[at..cmds[at..].find(") ->").unwrap() + at];
        assert!(sig.contains("pane_id: String") && !sig.contains("host") && !sig.contains("folder"), "{name}: {sig}");
        assert!(cmds[at..].contains("browse_command("), "{name} goes through the gated path");
    }
    // The far script has no writing word, and the browse module never runs a command of this PC.
    let browse = fs::read_to_string(src_dir().join("ssh").join("browse.rs")).unwrap();
    assert!(!browse.contains("Command::new") && !browse.contains("hidden_command"), "browse.rs starts no process itself; the runner does");
}
