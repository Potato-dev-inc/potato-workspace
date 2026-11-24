use super::*;

fn p(pid: u32, parent: u32, image: &str, cmdline: &str) -> Proc {
    Proc { pid, parent, image: image.into(), cmdline: cmdline.into() }
}

const M: &str = "pmacp.4242.0123456789abcdef0123456789abcdef";
const OTHER: &str = "pmacp.4242.ffffffffffffffffffffffffffffffff";

fn images() -> Vec<String> {
    vec!["opencode".into()]
}

fn arg(marker: &str) -> String {
    format!("\"C:/Program Files/Potato Workspace/puppet-master-mcp.exe\" {MARKER_FLAG}{marker}")
}

#[test]
fn a_marked_child_under_the_shared_server_is_ours() {
    let procs = vec![
        p(10, 1, "opencode.exe", "opencode.exe serve --service"),
        p(11, 10, "puppet-master-mcp.exe", &arg(M)),
        p(12, 10, "mcp-server-windows-x64.exe", "pencil --app cursor"),
    ];
    assert_eq!(owned_by_marker(&procs, M, &images()), vec![11], "only the marked child, never the person's other server");
}

#[test]
fn a_grandchild_is_found_through_the_chain() {
    let procs = vec![p(10, 1, "opencode.exe", "serve"), p(20, 10, "cmd.exe", "cmd /c x"), p(11, 20, "puppet-master-mcp.exe", &arg(M))];
    assert_eq!(owned_by_marker(&procs, M, &images()), vec![11]);
}

#[test]
fn another_sessions_marker_is_not_ours() {
    let procs = vec![p(10, 1, "opencode.exe", "serve"), p(11, 10, "puppet-master-mcp.exe", &arg(OTHER))];
    assert!(owned_by_marker(&procs, M, &images()).is_empty());
}

#[test]
fn a_marker_with_no_proof_of_the_parent_is_left_alone() {
    // The parent (10) is not in the list: nothing proves where it runs.
    let missing = vec![p(11, 10, "puppet-master-mcp.exe", &arg(M))];
    assert!(owned_by_marker(&missing, M, &images()).is_empty(), "missing parent");
    // The parent is there but is not the agent's server.
    let wrong = vec![p(10, 1, "explorer.exe", "explorer"), p(11, 10, "puppet-master-mcp.exe", &arg(M))];
    assert!(owned_by_marker(&wrong, M, &images()).is_empty(), "parent chain does not lead to the agent");
    // No images configured: nothing is ever matched.
    let right = vec![p(10, 1, "opencode.exe", "serve"), p(11, 10, "puppet-master-mcp.exe", &arg(M))];
    assert!(owned_by_marker(&right, M, &[]).is_empty());
}

#[test]
fn a_cycle_in_the_chain_proves_nothing() {
    let procs = vec![p(10, 11, "x.exe", ""), p(11, 10, "puppet-master-mcp.exe", &arg(M))];
    assert!(owned_by_marker(&procs, M, &images()).is_empty());
}

#[test]
fn the_marker_must_be_a_whole_argument_and_well_formed() {
    let glued = vec![p(10, 1, "opencode.exe", "serve"), p(11, 10, "x.exe", &format!("x {MARKER_FLAG}{M}extra"))];
    assert!(owned_by_marker(&glued, M, &images()).is_empty(), "a longer value is a different marker");
    assert!(owned_by_marker(&glued, "pmacp.1.short", &images()).is_empty(), "a malformed marker matches nothing");
    assert_eq!(marker_app_pid(M), Some(4242));
    assert_eq!(marker_app_pid("pmacp.x.0123456789abcdef"), None);
    assert!(marker_app_pid(&new_marker()).is_some());
}

#[test]
fn stale_ones_need_a_dead_app_run() {
    let procs = vec![
        p(10, 1, "opencode.exe", "serve --service"),
        p(11, 10, "puppet-master-mcp.exe", &arg(M)),
        p(13, 99, "puppet-master-mcp.exe", &arg(OTHER)), // parent gone
        p(14, 10, "puppet-master-mcp.exe", "puppet-master-mcp.exe"), // no marker
    ];
    let dead = |_pid: u32| false;
    let mut got = stale_pids(&procs, &images(), &dead);
    got.sort();
    assert_eq!(got, vec![11, 13], "marked, from a dead run; the unmarked one is never touched");
    let alive = |pid: u32| pid == 4242;
    assert!(stale_pids(&procs, &images(), &alive).is_empty(), "the run that made the marker is still there");
    assert!(stale_pids(&procs, &[], &dead).is_empty());
}

#[test]
fn a_foreign_parent_is_not_stale_work() {
    let procs = vec![p(10, 1, "explorer.exe", "explorer"), p(11, 10, "puppet-master-mcp.exe", &arg(M))];
    assert!(stale_pids(&procs, &images(), &|_| false).is_empty());
}

#[test]
fn only_our_own_entry_gets_the_marker() {
    let servers = vec![
        serde_json::json!({"name": "potato-workspace", "command": "x", "args": ["a"]}),
        serde_json::json!({"name": "pencil", "command": "p", "args": []}),
    ];
    let marked = mark_own_server(servers, "potato-workspace", M);
    assert_eq!(marked[0]["args"], serde_json::json!(["a", format!("{MARKER_FLAG}{M}")]));
    assert_eq!(marked[1]["args"], serde_json::json!([]));
}

/// REAL PROOF, not run by default: needs OpenCode installed and `PM_REAL_OPENCODE_PROOF=<evidence folder>`. It opens a
/// real chat session through `AcpSession` (the code the app uses), then closes it, and writes the process list of
/// our marked tool server before and after. Run: `cargo test --lib acp::leak::tests::real_opencode -- --ignored`.
#[test]
#[ignore]
fn real_opencode_close_ends_only_our_marked_tool_server() {
    use crate::acp::config::{find_builtin, RealHost};
    use crate::acp::session::{AcpSession, SessionParams};
    use std::sync::Arc;

    let Some(out_dir) = std::env::var_os("PM_REAL_OPENCODE_PROOF") else { return };
    let out_dir = std::path::PathBuf::from(out_dir);
    std::fs::create_dir_all(&out_dir).unwrap();
    let mcp = std::env::var("PM_REAL_MCP_EXE").unwrap_or_else(|_| "C:/Program Files/Potato Workspace/puppet-master-mcp.exe".into());
    let mut cfg = find_builtin("opencode").expect("opencode");
    // The same entry shape `default_mcp_servers` builds for the app's own tool server.
    cfg.mcp_servers = vec![serde_json::json!({ "name": crate::mcp_install::MCP_SERVER_NAME, "command": mcp, "args": [], "env": [] })];
    assert_eq!(cfg.shared_server_images, vec!["opencode".to_string()]);
    // CONTROL run (`PM_REAL_CONTROL=1`): the session is marked but the sweep is told a program that is not OpenCode, so it
    // can prove nothing and ends nothing. Shows the child really outlives `session/close`; the test then ends it by its own pid.
    let control = std::env::var_os("PM_REAL_CONTROL").is_some();
    if control {
        cfg.shared_server_images = vec!["not-the-agent".into()];
    }
    let cwd = std::env::temp_dir().join(format!("pm-mcp-leak-proof-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cwd).unwrap();
    let session = AcpSession::new(Arc::new(cfg.clone()), Arc::new(RealHost), SessionParams { key: "mcp-leak-proof".into(), cwd: cwd.clone(), resume_session_id: None });
    let marker = session.marker_for_proof();

    let list = |label: &str| -> Vec<Proc> {
        let procs = list_processes().expect("process list");
        let mut lines = vec![format!("== {label} ==")];
        let marked_count = procs.iter().filter(|p| p.cmdline.contains(&marker)).count();
        for p in procs.iter().filter(|p| p.cmdline.contains(&marker)) {
            lines.push(format!("pid {} parent {} image {} cmdline {}", p.pid, p.parent, p.image, p.cmdline));
            let mut at = p.parent;
            for _ in 0..6 {
                match procs.iter().find(|q| q.pid == at) {
                    Some(q) => {
                        lines.push(format!("    ancestor pid {} image {}", q.pid, q.image));
                        at = q.parent;
                    }
                    None => break,
                }
            }
        }
        lines.push(format!("(marked processes: {})", marked_count));
        let all_mcp = procs.iter().filter(|p| p.image.contains("mcp")).count();
        lines.push(format!("(all processes with mcp in the image, marked or not: {all_mcp})"));
        let path = out_dir.join(format!("{}.txt", label.replace(' ', "-")));
        std::fs::write(path, lines.join("\n")).unwrap();
        procs
    };
    let before_all: Vec<u32> = list_processes().unwrap().iter().filter(|p| p.image.contains("mcp")).map(|p| p.pid).collect();

    session.ensure_running().expect("real OpenCode chat starts");
    if let Some(model) = std::env::var_os("PM_REAL_MODEL") {
        let _ = session.set_config_option("model", serde_json::json!(model.to_string_lossy()));
    }
    std::fs::write(out_dir.join("0-session-mcp-servers.json"), serde_json::to_string_pretty(&session.config().mcp_servers).unwrap()).unwrap();
    let mut running = list("1 chat open");
    for _ in 0..12 {
        if running.iter().any(|p| p.cmdline.contains(&marker)) {
            break;
        }
        pause(2);
        running = list("1 chat open");
    }
    let marked: Vec<&Proc> = running.iter().filter(|p| p.cmdline.contains(&marker)).collect();
    assert!(!marked.is_empty(), "OpenCode started our marked tool server for the open chat");
    let marked_pids: Vec<u32> = marked.iter().map(|p| p.pid).collect();

    session.close();
    pause(8);
    let after = list("2 chat closed");
    if control {
        let leaked: Vec<u32> = marked_pids.iter().copied().filter(|pid| after.iter().any(|p| p.pid == *pid)).collect();
        std::fs::write(out_dir.join("4-control-leaked-pids.txt"), format!("without the sweep these marked tool servers outlived the closed chat: {leaked:?}
")).unwrap();
        for pid in &leaked {
            crate::pty::proc_tree::kill_process_tree(*pid); // our own marked pid, ended by pid
        }
        assert!(!leaked.is_empty(), "control: the leak reproduces");
        return;
    }
    for pid in &marked_pids {
        assert!(!after.iter().any(|p| p.pid == *pid), "marked tool server {pid} is gone after the chat closed");
    }
    // Nothing else of the person's was ended.
    let still: Vec<u32> = after.iter().filter(|p| p.image.contains("mcp")).map(|p| p.pid).collect();
    let lost: Vec<u32> = before_all.iter().copied().filter(|p| !still.contains(p)).collect();
    std::fs::write(out_dir.join("3-other-mcp-processes-lost.txt"), format!("mcp-like processes present before the chat and gone after: {lost:?}\n")).unwrap();
    assert!(lost.is_empty(), "no other tool server was ended: {lost:?}");
    let _ = std::fs::remove_dir_all(&cwd);
}

/// REAL PROOF 2, not run by default (same variable). The leak itself: our own `opencode acp` (a pid we started) keeps
/// the session's tool server alive after `session/close` while the adapter lives (the shared-server case). The sweep must
/// then end exactly the marked one, found through its parent chain to `opencode`, and nothing else.
#[test]
#[ignore]
fn real_opencode_sweep_ends_a_tool_server_that_outlives_session_close() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let Some(out_dir) = std::env::var_os("PM_REAL_OPENCODE_PROOF") else { return };
    let out_dir = std::path::PathBuf::from(out_dir);
    std::fs::create_dir_all(&out_dir).unwrap();
    let mcp = std::env::var("PM_REAL_MCP_EXE").unwrap_or_else(|_| "C:/Program Files/Potato Workspace/puppet-master-mcp.exe".into());
    let marker = new_marker();
    let cwd = std::env::temp_dir().join(format!("pm-mcp-leak-proof2-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cwd).unwrap();

    let mut cmd = crate::proc_util::hidden_command("cmd");
    cmd.args(["/c", "opencode", "acp"]).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().expect("start opencode acp");
    let root = child.id();
    let mut stdin = child.stdin.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let mut send = |v: serde_json::Value| writeln!(stdin, "{v}").unwrap();
    let wait_for = |id: u64| -> serde_json::Value {
        let end = Instant::now() + Duration::from_secs(60);
        while Instant::now() < end {
            if let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) && v.get("method").is_none() {
                        return v;
                    }
                }
            }
        }
        panic!("no answer to request {id}");
    };
    send(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}));
    wait_for(1);
    let servers = mark_own_server(
        vec![serde_json::json!({ "name": crate::mcp_install::MCP_SERVER_NAME, "command": mcp, "args": [], "env": [] })],
        crate::mcp_install::MCP_SERVER_NAME,
        &marker,
    );
    send(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd": cwd.to_string_lossy(), "mcpServers": servers}}));
    let session_id = wait_for(2)["result"]["sessionId"].as_str().expect("session id").to_string();

    let snapshot = |label: &str| -> Vec<Proc> {
        let procs = list_processes().expect("process list");
        let mut lines = vec![format!("== {label} (our opencode acp root pid {root}) ==")];
        for p in procs.iter().filter(|p| markers_in(&p.cmdline).contains(&marker.as_str())) {
            lines.push(format!("MARKED pid {} parent {} image {}", p.pid, p.parent, p.image));
            let mut at = p.parent;
            for _ in 0..6 {
                let Some(q) = procs.iter().find(|q| q.pid == at) else { break };
                lines.push(format!("    ancestor pid {} image {}", q.pid, q.image));
                at = q.parent;
            }
        }
        std::fs::write(out_dir.join(format!("shared-{}.txt", label.replace(' ', "-"))), lines.join("\n")).unwrap();
        procs
    };
    let mut procs = snapshot("1-session-open");
    for _ in 0..10 {
        if procs.iter().any(|p| markers_in(&p.cmdline).contains(&marker.as_str())) {
            break;
        }
        pause(2);
        procs = snapshot("1-session-open");
    }
    let marked: Vec<u32> = procs.iter().filter(|p| markers_in(&p.cmdline).contains(&marker.as_str())).map(|p| p.pid).collect();
    assert!(!marked.is_empty(), "the tool server started");
    let others_before: Vec<u32> = procs.iter().filter(|p| p.image.contains("mcp") && !marked.contains(&p.pid)).map(|p| p.pid).collect();
    let others_detail: Vec<String> = procs.iter().filter(|p| p.image.contains("mcp") && !marked.contains(&p.pid)).map(|p| format!("pid {} parent {} image {}", p.pid, p.parent, p.image)).collect();
    std::fs::write(out_dir.join("shared-0-other-mcp-before.txt"), others_detail.join("
")).unwrap();

    send(serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/close","params":{"sessionId": session_id}}));
    wait_for(3);
    pause(6);
    let procs = snapshot("2-after-session-close");
    let leaked: Vec<u32> = marked.iter().copied().filter(|pid| procs.iter().any(|p| p.pid == *pid)).collect();
    std::fs::write(out_dir.join("shared-3-leak.txt"), format!("tool servers still alive 6 s after session/close (adapter alive): {leaked:?}\n")).unwrap();

    let ended = sweep_session(&marker, &["opencode".to_string()]);
    pause(3);
    let procs = snapshot("4-after-sweep");
    let still: Vec<u32> = marked.iter().copied().filter(|pid| procs.iter().any(|p| p.pid == *pid)).collect();
    let lost_others: Vec<u32> = others_before.iter().copied().filter(|pid| !procs.iter().any(|p| p.pid == *pid)).collect();
    std::fs::write(
        out_dir.join("shared-5-result.txt"),
        format!("sweep asked to end {ended} pid(s); marked still alive: {still:?}; other mcp-like processes lost: {lost_others:?}\n"),
    )
    .unwrap();
    crate::pty::proc_tree::kill_process_tree(root); // our own opencode acp, by pid
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&cwd);
    assert!(!leaked.is_empty(), "the leak reproduces: session/close alone leaves the tool server");
    assert!(still.is_empty(), "the sweep ended the marked tool server");
    assert!(lost_others.is_empty(), "nothing else was ended");
}

/// A fixed wait for real processes to go away (these tests are ignored and run by hand). One sleep line for all of them.
fn pause(secs: u64) {
    std::thread::sleep(std::time::Duration::from_secs(secs));
}
