//! Agent terminals, driven with real commands under the hidden console (Windows) or `sh` (elsewhere). Every command is
//! stopped by the test that started it; each test uses its own `Manager` so the caps of one never count another's.

use super::*;
use crate::agent_authority::terminal_gate;
use crate::proc_util::pid_alive;
use std::time::Duration;

/// A project folder of its own, removed when the test ends.
struct Project(PathBuf);

impl Project {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn project() -> Project {
    let dir = std::env::temp_dir().join(format!("pm-terminals-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp project");
    Project(dir)
}

/// A command that runs for a long time and prints one line first.
fn long_command() -> Cmd {
    if cfg!(windows) {
        Cmd::Line("echo up & ping -n 120 127.0.0.1 > nul".into())
    } else {
        Cmd::Line("echo up; sleep 120".into())
    }
}

fn request(owner: &str, dir: &Project, command: Cmd) -> StartRequest {
    StartRequest { owner: owner.into(), project: dir.path().to_path_buf(), command, cwd: None, name: None }
}

/// The one place these tests wait: asks the check every 50 ms until it is true or the limit passes.
fn poll_until(limit: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        if ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    ready()
}

fn wait_for_end(term: &Arc<Terminal>) {
    poll_until(Duration::from_secs(10), || !term.is_running());
}

fn gone_within(pid: u32, wait: Duration) -> bool {
    poll_until(wait, || !pid_alive(pid))
}

#[test]
fn a_command_runs_and_its_output_is_readable_with_a_cursor() {
    let dir = project();
    let manager = Manager::new(4, 12);
    let cmd = Cmd::Line(if cfg!(windows) { "echo first & echo second".into() } else { "echo first; echo second".into() });
    let term = manager.start(request("p1", &dir, cmd)).expect("start");
    wait_for_end(&term);
    assert_eq!(term.state(), State::Exited);
    assert_eq!(term.exit_code(), Some(0));
    let read = term.read(0, 50);
    assert!(read.lines.iter().any(|l| l == "first") && read.lines.iter().any(|l| l == "second"), "{:?}", read.lines);
    // Reading again from the cursor gives nothing new.
    assert!(term.read(read.next_cursor, 50).lines.is_empty());
}

#[test]
fn the_cap_per_agent_refuses_with_the_list_and_another_agent_is_not_counted() {
    let dir = project();
    let manager = Manager::new(2, 12);
    let a = manager.start(request("p1", &dir, long_command())).expect("first");
    let b = manager.start(request("p1", &dir, long_command())).expect("second");
    let refused = manager.start(request("p1", &dir, long_command())).err().expect("third is refused");
    assert_eq!(refused.code, "TOO_MANY_TERMINALS");
    assert_eq!(refused.context["running"].as_array().map(Vec::len), Some(2), "the list lets the agent pick one to stop");
    // Another agent has its own four.
    let other = manager.start(request("p2", &dir, long_command())).expect("another agent");
    assert!(manager.stop(&a.id, "the agent"));
    wait_for_end(&a);
    manager.start(request("p1", &dir, long_command())).map(|t| manager.stop(&t.id, "test")).expect("after a stop there is room");
    for t in [&b, &other] {
        manager.stop(&t.id, "test");
        wait_for_end(t);
    }
}

#[test]
fn the_cap_for_the_whole_app_counts_every_agent() {
    let dir = project();
    let manager = Manager::new(4, 2);
    let a = manager.start(request("p1", &dir, long_command())).expect("first");
    let b = manager.start(request("p2", &dir, long_command())).expect("second");
    let refused = manager.start(request("p3", &dir, long_command())).err().expect("the app is full");
    assert_eq!(refused.code, "TOO_MANY_TERMINALS");
    manager.stop_all();
    wait_for_end(&a);
    wait_for_end(&b);
}

#[test]
fn closing_the_chat_kills_the_whole_tree_and_only_that_chats() {
    let dir = project();
    let manager = Manager::new(4, 12);
    let mine = manager.start(request("chat-a", &dir, long_command())).expect("mine");
    let theirs = manager.start(request("chat-b", &dir, long_command())).expect("theirs");
    // Wait until the shell has started its long child, so there is a tree to kill.
    let mut tree = Vec::new();
    poll_until(Duration::from_secs(10), || {
        let procs = crate::pty::agent_proc::snapshot().unwrap_or_default();
        tree = crate::pane_jobs::descendants_of(&procs, mine.pid);
        !tree.is_empty()
    });
    assert!(!tree.is_empty(), "the command has a child to kill");
    assert_eq!(manager.stop_owned_by("chat-a"), 1);
    wait_for_end(&mine);
    assert_eq!(mine.state(), State::Stopped);
    assert!(gone_within(mine.pid, Duration::from_secs(5)), "the command itself is gone");
    for pid in tree {
        assert!(gone_within(pid, Duration::from_secs(5)), "{pid} was in its tree and must be gone");
    }
    assert!(theirs.is_running() && pid_alive(theirs.pid), "another chat's terminal is untouched");
    manager.stop_all();
    wait_for_end(&theirs);
}

#[test]
fn output_is_redacted_before_it_is_stored() {
    let dir = project();
    let manager = Manager::new(4, 12);
    let secret = ["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].concat();
    let term = manager.start(request("p1", &dir, Cmd::Line(format!("echo token {secret}")))).expect("start");
    wait_for_end(&term);
    let text = term.read(0, 50).lines.join("\n");
    assert!(text.contains("token"), "{text}");
    assert!(!text.contains("abcdefghijklmnopqrstuvwxyz"), "the secret must not be stored: {text}");
    // The command line the row shows is masked too.
    assert!(!term.command.contains("abcdefghijklmnopqrstuvwxyz"), "{}", term.command);
}

#[test]
fn a_wait_for_text_returns_when_the_line_arrives_and_times_out_otherwise() {
    let dir = project();
    let manager = Manager::new(4, 12);
    let term = manager.start(request("p1", &dir, long_command())).expect("start");
    let hit = manager.wait(&term, &Until::Line("up".into()), 0, Duration::from_secs(10));
    assert_eq!(hit.reason, Reason::Line);
    assert_eq!(hit.matched.as_deref(), Some("up"));
    let miss = manager.wait(&term, &Until::Line("never printed".into()), 0, Duration::from_millis(600));
    assert_eq!(miss.reason, Reason::Timeout);
    manager.stop(&term.id, "test");
    let ended = manager.wait(&term, &Until::Exit, 0, Duration::from_secs(10));
    assert_eq!(ended.reason, Reason::Exit);
    assert_eq!(term.stopped_by().as_deref(), Some("test"));
}

#[test]
fn a_folder_outside_the_project_is_refused_and_one_inside_is_allowed() {
    let dir = project();
    std::fs::create_dir(dir.path().join("web")).unwrap();
    let manager = Manager::new(4, 12);
    let mut outside = request("p1", &dir, long_command());
    outside.cwd = Some("..".into());
    assert_eq!(manager.start(outside).err().map(|e| e.code), Some("CWD_OUTSIDE_PROJECT".to_string()));
    let mut inside = request("p1", &dir, Cmd::Line(if cfg!(windows) { "cd".into() } else { "pwd".into() }));
    inside.cwd = Some("web".into());
    let term = manager.start(inside).expect("inside");
    wait_for_end(&term);
    assert!(term.read(0, 5).lines.iter().any(|l| l.ends_with("web")), "{:?}", term.read(0, 5).lines);
}

#[test]
fn an_agent_uses_its_own_terminals_and_those_of_the_agents_below_it() {
    let dir = project();
    let manager = Manager::new(4, 12);
    let term = manager.start(request("minion-1", &dir, Cmd::Line("echo hi".into()))).expect("start");
    wait_for_end(&term);
    let parent_of = |pane: &str| (pane == "minion-1").then(|| "chat-1".to_string());
    assert!(may_use("minion-1", &term, &parent_of));
    assert!(may_use("chat-1", &term, &parent_of), "the chat above a minion may read and stop its terminals");
    assert!(!may_use("chat-2", &term, &parent_of), "another chat may not");
}

#[test]
fn a_finished_terminal_is_kept_for_ten_minutes_and_then_forgotten() {
    let dir = project();
    let manager = Manager::new(4, 12);
    let term = manager.start(request("p1", &dir, Cmd::Line("echo bye".into()))).expect("start");
    wait_for_end(&term);
    assert!(manager.get(&term.id).is_some());
    term.live.lock().ended_ms = Some(now_ms() - KEEP_FINISHED_MS - 1);
    assert!(manager.get(&term.id).is_none());
}

#[test]
fn kinds_name_what_a_command_does() {
    assert_eq!(kind_of("npm test"), "test");
    assert_eq!(kind_of("cargo test --lib"), "test");
    assert_eq!(kind_of("npm run build"), "build");
    assert_eq!(kind_of("npm run dev"), "dev");
    assert_eq!(kind_of("python -m http.server 8080"), "dev");
    assert_eq!(kind_of("npm install"), "install");
    assert_eq!(kind_of("node tool.js"), "other");
    assert_eq!(program_of("\"C:\\Program Files\\nodejs\\node.exe\" a.js"), "node");
}

// ---- the Allow card -----------------------------------------------------------------------------------------------

fn unique(tag: &str) -> String {
    format!("{tag}-{}", uuid::Uuid::new_v4())
}

fn gate_request<'a>(chat: &'a str, caller: &'a str, command: &'a str, dir: &'a std::path::Path) -> terminal_gate::Request<'a> {
    terminal_gate::Request { session: "test-session", caller, chat, requester: "Claude".into(), target: "Dev server".into(), command, project: dir }
}

fn answer(error: &crate::operations::OperationError, choice: &str) {
    let id = error.context["consent_id"].as_str().expect("the card id").to_string();
    let resolution = crate::questions::store().answer(&id, Some(choice), None, "desktop", crate::questions::now_ms()).unwrap();
    assert!(resolution.accepted);
}

#[test]
fn the_first_start_asks_and_allow_for_this_chat_covers_the_next_ones() {
    let dir = project();
    let chat = unique("chat");
    let now = crate::questions::now_ms();
    let first = terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).unwrap_err();
    assert_eq!(first.code, "CONSENT_PENDING");
    let card = crate::questions::store().get(first.context["consent_id"].as_str().unwrap(), now).unwrap();
    let labels: Vec<&str> = card.choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["Allow once", "Allow for this chat", "No"]);
    assert_eq!(card.consent.as_ref().map(|c| c.action.as_str()), Some("background_command"));
    answer(&first, "always");
    terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).expect("allowed");
    // A different, ordinary command in the same chat does not ask again.
    terminal_gate::check(&gate_request(&chat, &chat, "npm test -- --watch", dir.path()), now).expect("the chat is allowed");
    // The grant ends with the chat.
    terminal_gate::forget_chat(&chat);
    assert_eq!(terminal_gate::check(&gate_request(&chat, &chat, "npm test", dir.path()), now).unwrap_err().code, "CONSENT_PENDING");
}

#[test]
fn allow_once_lets_one_command_through_and_a_no_is_a_no() {
    let dir = project();
    let chat = unique("chat");
    let now = crate::questions::now_ms();
    let first = terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).unwrap_err();
    answer(&first, "allow_once");
    terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).expect("once");
    // A second, different command asks again: "once" was for one command.
    let second = terminal_gate::check(&gate_request(&chat, &chat, "npm run watch", dir.path()), now).unwrap_err();
    assert_eq!(second.code, "CONSENT_PENDING");
    answer(&second, "deny");
    assert_eq!(terminal_gate::check(&gate_request(&chat, &chat, "npm run watch", dir.path()), now).unwrap_err().code, "CONSENT_DENIED");
}

#[test]
fn a_dangerous_command_asks_every_time_even_in_an_allowed_chat() {
    let dir = project();
    let chat = unique("chat");
    let now = crate::questions::now_ms();
    let first = terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).unwrap_err();
    answer(&first, "always");
    terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).expect("allowed");
    let risky = terminal_gate::check(&gate_request(&chat, &chat, "git push --force origin main", dir.path()), now).unwrap_err();
    assert_eq!(risky.code, "CONSENT_PENDING", "a push asks although the chat is allowed");
    let card = crate::questions::store().get(risky.context["consent_id"].as_str().unwrap(), now).unwrap();
    assert!(card.choices.iter().all(|c| c.id != "always"), "no 'for this chat' on a dangerous command");
    answer(&risky, "allow_once");
    terminal_gate::check(&gate_request(&chat, &chat, "git push --force origin main", dir.path()), now).expect("allowed once");
    assert_eq!(terminal_gate::check(&gate_request(&chat, &chat, "git push --force origin main", dir.path()), now).unwrap_err().code, "CONSENT_PENDING", "once is used up");
}

#[test]
fn a_minion_uses_the_grant_of_its_chat() {
    let dir = project();
    let chat = unique("chat");
    let minion = unique("minion");
    let now = crate::questions::now_ms();
    let first = terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).unwrap_err();
    answer(&first, "always");
    terminal_gate::check(&gate_request(&chat, &chat, "npm run dev", dir.path()), now).expect("the chat is allowed");
    // The minion's request names the chat as its grant.
    terminal_gate::check(&gate_request(&chat, &minion, "npm test", dir.path()), now).expect("the minion rides on its chat's yes");
}
