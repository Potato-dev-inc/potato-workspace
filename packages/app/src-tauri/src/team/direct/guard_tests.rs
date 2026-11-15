//! Guards: Pass a task is a desktop-window feature. No bridge route, MCP tool or phone route reaches it, it never starts an
//! agent or a process of its own, and it never touches a login.

use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn sources(path: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let mut todo = vec![path.to_path_buf()];
    while let Some(next) = todo.pop() {
        if next.is_file() {
            if next.extension().is_some_and(|e| e == "rs") {
                found.push((next.clone(), std::fs::read_to_string(&next).unwrap()));
            }
            continue;
        }
        for entry in std::fs::read_dir(&next).unwrap().flatten() {
            todo.push(entry.path());
        }
    }
    found
}

#[test]
fn tasks_are_not_reachable_from_bridge_mcp_or_phone_routes() {
    // Built from pieces so this file does not contain the words itself.
    let words = [["team", "::direct"].concat(), ["team_", "task_"].concat(), ["team_", "tasks_"].concat(), ["team/", "direct"].concat()];
    let places = [
        "bridge",
        "tool_registry",
        "mcp_shim",
        "mcp_sessions",
        "mobile_pairing",
        "agent_runs",
        "pane_mcp",
        "companion",
        "channels",
        "push",
        "pwa_server.rs",
        "mobile_tunnel.rs",
        "tunnel_config.rs",
        "mcp_runtime.rs",
        "team/mcp.rs",
        "team/phone.rs",
    ];
    let mut seen = 0;
    for place in places.iter().filter(|p| src_dir().join(p).exists()) {
        for (path, text) in sources(&src_dir().join(place)) {
            seen += 1;
            for word in &words {
                assert!(!text.contains(word.as_str()), "{} mentions {word}: tasks must not be a bridge route, MCP tool or phone route", path.display());
            }
        }
    }
    assert!(seen > 20, "only {seen} files scanned");
}

/// The files of this module that run in the app (not the tests).
fn module_sources() -> Vec<(PathBuf, String)> {
    sources(&src_dir().join("team").join("direct")).into_iter().filter(|(p, _)| !p.file_name().is_some_and(|n| n.to_string_lossy().ends_with("tests.rs"))).collect()
}

#[test]
fn accepting_a_task_never_starts_an_agent_a_pane_or_a_process() {
    let words = [
        ["agent", "_runs"].concat(),
        ["new", "_pane"].concat(),
        ["run", "_agent"].concat(),
        ["pty", "::"].concat(),
        ["std::process", "::Command"].concat(),
        ["Command", "::new"].concat(),
        ["pane", "_outbox"].concat(),
        ["send", "_input"].concat(),
    ];
    let files = module_sources();
    assert!(files.len() >= 6, "{} files scanned", files.len());
    for (path, text) in &files {
        for word in &words {
            assert!(!text.contains(word.as_str()), "{} mentions {word}: a teammate's task must never start anything", path.display());
        }
    }
}

#[test]
fn the_tasks_code_never_touches_a_login_or_the_credential_store() {
    let words = [["secrets", "::"].concat(), ["key", "ring"].concat(), ["accounts", "::"].concat(), ["launch", "_env"].concat(), ["link", "_secret"].concat(), ["Authorization", ""].concat()];
    for (path, text) in module_sources() {
        for word in &words {
            assert!(!text.contains(word.as_str()), "{} mentions {word}: no login or key may be handled here", path.display());
        }
    }
}

#[test]
fn only_the_one_bound_promise_answers_a_lend_without_a_click() {
    // `answer_if_promised` is the single caller of the gate, and the gate is the only thing that can say yes by itself.
    let text = std::fs::read_to_string(src_dir().join("capacity_proxy").join("service.rs")).unwrap();
    assert_eq!(text.matches("gate.claim(").count(), 1, "one place asks the promise");
    assert_eq!(text.matches("fn answer_if_promised").count(), 1);
    let service = std::fs::read_to_string(src_dir().join("team").join("direct").join("service.rs")).unwrap();
    assert!(service.contains("t.state.open()") && service.contains("!t.lend_used") && service.contains("profile_id == Some(offer.profile_id.as_str())"));
}
