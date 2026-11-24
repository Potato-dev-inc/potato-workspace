//! P5 rows (`calls_files.rs`, `preview.rs`): the levels, a path that escapes the chat's folder (`..`, an absolute path, a link that leads out)
//! refused through the far rows, what a PC below Full does not get, and the dev-server request made against a real loopback server.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::app_services::AppServices;
use super::tests::Fake;
use super::*;

/// Scratch folders go where the lab says (`PM_TEST_TMP`), else the system's.
fn scratch(tag: &str) -> PathBuf {
    let base = std::env::var_os("PM_TEST_TMP").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("p5-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn post(level: Option<Level>, fake: &Fake, cmd: &str, body: &Value) -> (u16, Value) {
    let who = Caller { node: "aa", name: "Laptop", level, now_ms: 1_000, marked: false };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap())
}

/// `(command, least level, names a chat)` for this block's table rows.
fn rows() -> Vec<(&'static str, Level, bool)> {
    use Level::*;
    vec![
        ("files_list", Full, true),
        ("files_read", Full, true),
        ("files_read_bytes", Full, true),
        ("files_marks", Full, true),
        ("files_diff", Full, true),
        ("files_search_contents", Full, true),
        ("files_search_cancel", Full, false),
        ("project_files_search", Full, true),
        ("files_write", Full, true),
        ("checkpoints_list", Full, true),
        ("checkpoint_diff", Full, true),
        ("checkpoint_turn_review", Full, true),
        ("checkpoint_file_patch", Full, true),
        ("checkpoint_put_back", Full, true),
        ("checkpoint_restore", Full, true),
        ("checkpoint_undo_last", Full, true),
        ("pane_git_branch", Full, true),
        ("artifacts_read", Watch, true),
        ("artifacts_sync", Answer, true),
        ("pane_previews", Watch, false),
        ("pane_usage", Watch, true),
        ("usage_snapshot", Watch, false),
        ("pane_open_bundle", Watch, true),
    ]
}

#[test]
fn the_block_names_exactly_these_rows_at_these_levels() {
    let start = calls::TABLE.iter().position(|(c, _, _)| *c == "files_list").expect("the P5 block");
    let ours: Vec<_> = calls::TABLE[start..start + rows().len()].iter().map(|(c, l, p)| (*c, *l, *p)).collect();
    assert_eq!(ours, rows(), "the P5 block is one run of rows");
    for (cmd, _, _) in rows() {
        assert!(!calls::refused(cmd), "{cmd}");
    }
}

#[test]
fn the_levels_hold_through_the_door_and_a_chat_shut_for_other_pcs_stays_shut() {
    for (cmd, needs, pane) in rows() {
        let body = json!({ "paneId": "p1", "path": "a.txt", "id": "x", "query": "q", "searchId": "s" });
        for level in [Level::Watch, Level::Answer, Level::Full] {
            let fake = Fake::default();
            let (status, answer) = post(Some(level), &fake, cmd, &body);
            if level >= needs {
                assert_eq!(status, 200, "{level:?} {cmd}: {answer}");
                assert_eq!(fake.calls().len(), 1, "{level:?} {cmd} reached the app once");
            } else {
                assert_eq!((status, answer["code"].as_str().is_some() || answer["error"].as_str().is_some()), (403, true), "{level:?} must not {cmd}");
                assert!(fake.calls().is_empty(), "{level:?} {cmd} ran nothing");
            }
        }
        assert_eq!(post(None, &Fake::default(), cmd, &body).1["code"], "REMOTE_OFF", "{cmd}");
        if pane {
            let fake = Fake::default();
            fake.locked.lock().unwrap().push("p1".into());
            assert_eq!(post(Some(Level::Full), &fake, cmd, &body).1["code"], "AGENT_LOCKED", "{cmd}");
            assert!(fake.calls().is_empty(), "{cmd}: a locked chat reaches nothing");
        }
    }
}

/// The P45 rows: a chat's own separate copy (its Changes, Keep, Discard) and a thumbnail. Full only; each names a chat; none is refused.
#[test]
fn the_separate_copy_rows_are_full_and_name_a_chat() {
    use Level::*;
    let ours = [("pane_worktree", Full, true), ("worktree_diff", Full, true), ("worktree_merge", Full, true), ("worktree_discard", Full, true), ("attachment_preview", Full, true)];
    let start = calls::TABLE.iter().position(|(c, _, _)| *c == "pane_worktree").expect("the P45 block");
    let got: Vec<_> = calls::TABLE[start..start + ours.len()].iter().map(|(c, l, p)| (*c, *l, *p)).collect();
    assert_eq!(got, ours);
    for (cmd, _, _) in ours {
        assert!(!calls::refused(cmd), "{cmd}");
        let body = json!({ "paneId": "p1", "handle": "h1", "path": "a.png" });
        for level in [Watch, Answer] {
            let fake = Fake::default();
            let (status, answer) = post(Some(level), &fake, cmd, &body);
            assert_eq!((status, answer["code"].as_str()), (403, Some("DEVICE_NOT_ALLOWED")), "{level:?} {cmd}");
            assert!(fake.calls().is_empty(), "{level:?} {cmd} reached nothing");
        }
        let fake = Fake::default();
        assert_eq!(post(Some(Full), &fake, cmd, &body).0, 200, "{cmd}");
        assert_eq!(fake.calls().len(), 1, "{cmd} reached the app once");
        let locked = Fake::default();
        locked.locked.lock().unwrap().push("p1".into());
        assert_eq!(post(Some(Full), &locked, cmd, &body).1["code"], "AGENT_LOCKED", "{cmd}");
    }
}

/// A copy's rows act on the copy THIS chat works in, whatever handle the asker names (and never on a chat that is not on a copy).
#[test]
fn a_worktree_row_only_acts_on_the_chats_own_copy() {
    assert!(calls_files::own_handle(Some("wt-1"), "wt-1").is_ok());
    for (own, given) in [(Some("wt-1"), "wt-2"), (Some(""), ""), (None, "wt-1")] {
        let (status, body) = calls_files::own_handle(own, given).unwrap_err();
        assert_eq!((status, body["code"].as_str()), (404, Some("UNKNOWN_WORKTREE")), "{own:?} {given}");
    }
}

#[test]
fn nothing_that_opens_a_window_a_program_or_the_disk_outside_the_folder_is_a_row() {
    for cmd in ["files_reveal", "files_open_default", "files_open_bytes", "artifacts_pop_out", "artifacts_open_in_browser", "artifacts_share_make"] {
        assert_eq!(calls::need(cmd), None, "{cmd}");
    }
}

#[test]
fn a_far_file_row_reads_the_chats_folder_and_nothing_outside_it() {
    let dir = scratch("root");
    let other = scratch("outside");
    std::fs::write(other.join("secret.txt"), "s").unwrap();
    std::fs::write(dir.join("a.txt"), "hello").unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    let root = dir.to_str().unwrap();
    let run = |cmd: &str, args: Value| calls_files::in_root(root, cmd, &args).expect("a file row");

    let (status, listing) = run("files_list", json!({ "paneId": "p1", "path": "" }));
    assert_eq!(status, 200);
    let names: Vec<&str> = listing["entries"].as_array().unwrap().iter().filter_map(|e| e["name"].as_str()).collect();
    assert_eq!(names, vec!["sub", "a.txt"]);
    assert_eq!(run("files_read", json!({ "path": "a.txt" })).1["text"], "hello");

    // `..`, an absolute path elsewhere and a path that is not a path are refused, in the link's error shape.
    for path in ["../secret.txt", "sub/../../secret.txt", other.join("secret.txt").to_str().unwrap()] {
        for cmd in ["files_read", "files_read_bytes", "files_diff", "files_list"] {
            let (status, answer) = run(cmd, json!({ "path": path }));
            assert_eq!(status, 400, "{cmd} {path}: {answer}");
            assert_eq!(answer["code"], "FILES_OUTSIDE", "{cmd} {path}");
        }
        let (status, answer) = run("files_write", json!({ "path": path, "text": "x" }));
        assert_eq!((status, answer["code"].as_str()), (400, Some("FILES_OUTSIDE")), "a save {path}");
    }
    assert!(!other.join("secret.txt").is_dir() && std::fs::read_to_string(other.join("secret.txt")).unwrap() == "s", "nothing was written outside");
    assert_eq!(run("files_read", json!({})).1["code"], "INVALID_ARGUMENT");

    // A link inside the folder that leads out: not listed, not read, not written through.
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&other, dir.join("out")).is_ok()
        || crate::proc_util::hidden_command("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("out")).arg(&other).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&other, dir.join("out")).is_ok();
    assert!(made, "this machine cannot make a link, so the test proves nothing");
    let (status, answer) = run("files_read", json!({ "path": "out/secret.txt" }));
    assert_eq!((status, answer["code"].as_str()), (400, Some("FILES_OUTSIDE")), "{answer}");
    let (_, listing) = run("files_list", json!({ "path": "" }));
    assert!(listing["entries"].as_array().unwrap().iter().all(|e| e["name"] != "out"), "the link is not listed");
    let (status, _) = run("files_write", json!({ "path": "out/secret.txt", "text": "changed", "overwrite": true }));
    assert_eq!(status, 400);
    assert_eq!(std::fs::read_to_string(other.join("secret.txt")).unwrap(), "s", "a save never goes through a link that leads out");
    assert_eq!(run("files_list", json!({ "path": "out" })).1["code"], "FILES_OUTSIDE");
}

#[test]
fn a_far_save_keeps_the_conflict_rule_of_the_editor() {
    let dir = scratch("save");
    std::fs::write(dir.join("a.txt"), "one").unwrap();
    let root = dir.to_str().unwrap();
    let read = calls_files::in_root(root, "files_read", &json!({ "path": "a.txt" })).unwrap().1;
    let version = read["version"].as_str().unwrap().to_string();
    let (status, saved) = calls_files::in_root(root, "files_write", &json!({ "path": "a.txt", "text": "two", "baseVersion": version })).unwrap();
    assert_eq!(status, 200, "{saved}");
    // The file changed since this version: the save is refused, with the code the editor reads.
    std::fs::write(dir.join("a.txt"), "three").unwrap();
    let (status, refused) = calls_files::in_root(root, "files_write", &json!({ "path": "a.txt", "text": "four", "baseVersion": version })).unwrap();
    assert_eq!((status, refused["code"].as_str()), (400, Some("FILES_CONFLICT")), "{refused}");
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "three");
}

#[test]
fn a_chat_key_of_another_pc_never_names_a_folder_of_this_one() {
    // `dev:<node>:<id>` is a far chat as the screen keeps it. A stray call with one must not fall back to this PC's default project.
    assert!(crate::acp::chat::is_remote_pane("dev:aa:p1") && !crate::acp::chat::is_remote_pane("p1"));
    assert!(crate::files::list_dir(crate::acp::chat::NOT_ON_THIS_PC, "", false).is_err());
}

#[test]
fn a_checkpoint_path_is_a_plain_path_of_the_project() {
    for bad in ["", "../a", "a/../../b", "/etc/passwd", "C:\\x", "a\\b", "..", "a/./.."] {
        assert!(calls_files::clean_path(&json!({ "path": bad })).is_err(), "{bad:?}");
    }
    assert_eq!(calls_files::clean_path(&json!({ "path": "src/a.rs" })).unwrap(), "src/a.rs");
    assert!(calls_files::clean_path(&json!({})).is_err());
}

#[test]
fn a_pc_below_full_gets_no_path_of_this_pcs_disk_in_a_page_or_a_usage_row() {
    let page = json!({ "artifact": { "id": "a", "source": "D:/work/x.html", "share": { "links": [] }, "title": "T" }, "version": 1, "content": "<p>", "path": "D:/work/.potato/artifacts/a/v1.html" });
    let scrubbed = calls_files::artifact_page(page.clone(), false);
    assert_eq!(scrubbed["path"], "");
    assert!(scrubbed["artifact"].get("source").is_none() && scrubbed["artifact"].get("share").is_none());
    assert_eq!((scrubbed["content"].as_str(), scrubbed["artifact"]["title"].as_str()), (Some("<p>"), Some("T")), "the page itself is still there");
    assert_eq!(calls_files::artifact_page(page.clone(), true), page, "Full sees all of it");
    let list = calls_files::artifact_list(json!([{ "id": "a", "source": "x", "share": {} }]), false);
    assert!(list[0].get("source").is_none() && list[0].get("share").is_none());
    let usage = json!({ "own": { "turns": 1 }, "helpers": [{ "paneId": "h", "accountLabel": "me@example.com", "turns": 2 }] });
    assert_eq!(calls_files::usage_view(usage.clone(), false)["helpers"][0]["accountLabel"], Value::Null);
    assert_eq!(calls_files::usage_view(usage, true)["helpers"][0]["accountLabel"], "me@example.com");
}

#[test]
fn an_audit_line_names_the_chat_and_the_file_and_never_its_text() {
    let line = calls_files::audit_detail("files_write", "p1", Some("src/a.rs")).to_string();
    assert!(line.contains("p1") && line.contains("src/a.rs") && !line.contains("text"), "{line}");
}

#[test]
fn the_real_services_say_so_when_the_app_is_not_ready_and_refuse_an_unlisted_preview() {
    let svc = AppServices::new(std::sync::Arc::new(|| "Desk".into()));
    // No app handle in a unit test: a files row says so and never reads a default folder.
    assert_eq!(svc.call("aa", "files_list", &json!({ "paneId": "p1", "path": "" })).0, 503);
    assert_eq!(svc.call("aa", "files_search_cancel", &json!({ "searchId": "s" })).0, 503);
    // Nothing is listed for this chat, so no port is reachable (S8); a bad request is a 400 before anything is looked up.
    let (status, answer) = svc.preview("aa", &json!({ "paneId": "no-such-pane", "port": 5173, "path": "/" }));
    assert_eq!((status, answer["code"].as_str()), (403, Some("PREVIEW_NOT_LISTED")), "{answer}");
    assert_eq!(svc.preview("aa", &json!({ "port": 5173 })).0, 400);
    assert_eq!(svc.call("aa", "pane_previews", &json!({})).1, json!({}), "no chat has a preview here");
}

// ---- the dev-server request ----

#[test]
fn a_preview_request_carries_only_a_path_a_method_and_a_few_headers() {
    let ok = preview::parse(&json!({ "paneId": "p1", "port": 5173, "method": "post", "path": "/a?b=1", "headers": [["Accept", "x"], ["Cookie", "s=1"], ["Authorization", "Bearer t"], ["content-type", "text/plain"]], "bodyB64": "aGk=" })).unwrap();
    assert_eq!((ok.method.as_str(), ok.path.as_str(), ok.port, ok.body.as_slice()), ("POST", "/a?b=1", 5173, &b"hi"[..]));
    assert_eq!(ok.headers, vec![("accept".to_string(), "x".to_string()), ("content-type".to_string(), "text/plain".to_string())], "no cookie, no login");
    for bad in [
        json!({ "port": 5173 }),
        json!({ "paneId": "p1" }),
        json!({ "paneId": "p1", "port": 0 }),
        json!({ "paneId": "p1", "port": 70000 }),
        json!({ "paneId": "p1", "port": 5173, "method": "CONNECT" }),
        json!({ "paneId": "p1", "port": 5173, "path": "http://evil.example/" }),
        json!({ "paneId": "p1", "port": 5173, "path": "//evil.example/" }),
        json!({ "paneId": "p1", "port": 5173, "path": "/a b" }),
        json!({ "paneId": "p1", "port": 5173, "path": "/a\r\nHost: x" }),
        json!({ "paneId": "p1", "port": 5173, "path": "/a\\b" }),
        json!({ "paneId": "p1", "port": 5173, "bodyB64": "!!!" }),
    ] {
        assert_eq!(preview::parse(&bad).unwrap_err().0, 400, "{bad}");
    }
}

#[test]
fn only_a_port_listed_for_the_chat_is_reachable_and_the_rows_leave_out_a_chat_shut_for_other_pcs() {
    let url = |port: u16| crate::pane_preview::PreviewUrl { url: format!("http://localhost:{port}/"), port, network_url: None };
    assert_eq!(preview::check_port(&[url(5173), url(3000)], 3000).unwrap(), "localhost", "the host the chat printed");
    assert_eq!(preview::check_port(&[url(5173)], 22).unwrap_err().1["code"], "PREVIEW_NOT_LISTED");
    assert_eq!(preview::check_port(&[], 5173).unwrap_err().1["code"], "PREVIEW_NOT_LISTED");
    // A chat can print any address. One of Potato Workspace's own ports is refused even when it is listed (the bridge trusts the loopback).
    let own = crate::pwa_server::PWA_PORT;
    assert_eq!(preview::check_port(&[url(own)], own).unwrap_err().1["code"], "PREVIEW_OWN_PORT");
    let rows = preview::rows(vec![("p1".into(), vec![("http://localhost:5173/".into(), 5173)]), ("p2".into(), vec![("http://localhost:3000/".into(), 3000)])], &|pane| pane == "p1");
    assert_eq!(rows, json!({ "p1": [{ "url": "http://localhost:5173/", "port": 5173 }] }));
}

/// A one-answer HTTP server on the loopback of this test (never a wildcard address).
fn serve_once(reply: &'static str) -> (u16, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut seen = vec![0u8; 4096];
        let n = stream.read(&mut seen).unwrap();
        stream.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&seen[..n]).to_string()
    });
    (port, handle)
}

#[test]
fn the_far_pc_makes_the_request_to_its_own_port_and_gives_back_the_page() {
    let (port, server) = serve_once("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: s=1\r\nContent-Length: 5\r\nConnection: close\r\n\r\n<p>x<");
    let req = preview::parse(&json!({ "paneId": "p1", "port": port, "path": "/index.html?x=1", "headers": [["accept", "text/html"], ["cookie", "secret=1"]] })).unwrap();
    let (status, answer) = preview::fetch("127.0.0.1", &req);
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["status"], 200);
    let headers = answer["headers"].to_string();
    assert!(headers.contains("text/html") && !headers.to_lowercase().contains("set-cookie"), "{headers}");
    assert_eq!(answer["bodyB64"], "PHA+eDw=");
    let sent = server.join().unwrap().to_lowercase();
    assert!(sent.starts_with("get /index.html?x=1 http/1.1") && sent.contains("accept: text/html") && !sent.contains("cookie"), "{sent}");
}

#[test]
fn a_dev_server_error_page_is_still_the_pages_answer_and_a_dead_port_is_one_plain_sentence() {
    let (port, server) = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno");
    let req = preview::parse(&json!({ "paneId": "p1", "port": port, "path": "/x" })).unwrap();
    let (status, answer) = preview::fetch("127.0.0.1", &req);
    server.join().unwrap();
    assert_eq!((status, answer["status"].as_u64()), (200, Some(404)));
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let req = preview::parse(&json!({ "paneId": "p1", "port": port, "path": "/" })).unwrap();
    let (status, answer) = preview::fetch("127.0.0.1", &req);
    assert_eq!((status, answer["code"].as_str()), (502, Some("PREVIEW_DOWN")));
}

#[test]
fn a_page_bigger_than_the_cap_is_refused_whole_not_cut() {
    let big: &'static str = Box::leak(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", preview::BODY_MAX + 10).into_boxed_str());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut seen = [0u8; 1024];
        let _ = stream.read(&mut seen);
        let _ = stream.write_all(big.as_bytes());
        let chunk = vec![b'a'; 64 * 1024];
        let mut sent = 0;
        while sent < preview::BODY_MAX + 10 && stream.write_all(&chunk).is_ok() {
            sent += chunk.len();
        }
    });
    let req = preview::parse(&json!({ "paneId": "p1", "port": port, "path": "/" })).unwrap();
    let (status, answer) = preview::fetch("127.0.0.1", &req);
    let _ = server.join();
    assert_eq!((status, answer["code"].as_str()), (413, Some("PREVIEW_TOO_BIG")));
}

/// `pane_open_bundle` is a Watch row; what it holds for an asker is exactly the rows that asker may call one by one, never more.
#[test]
fn the_open_bundle_holds_only_the_parts_the_askers_level_allows() {
    let level_of = |cmd: &str| calls::TABLE.iter().find(|(c, _, _)| *c == cmd).map(|(_, l, _)| *l).expect("a row");
    for (full, answer, level) in [(false, false, Level::Watch), (false, true, Level::Answer), (true, true, Level::Full)] {
        let parts = calls_files::bundle_parts(full, answer);
        assert!(parts.contains(&"pane_usage"), "{level:?}: the Watch part is always there");
        for part in &parts {
            assert!(level >= level_of(part), "{level:?} would get {part}, which needs {:?}", level_of(part));
            assert!(calls_files::mine(part) && calls::names_pane(part), "{part} runs in this block, for a chat");
        }
        // Everything this level may call is in it (nothing is left for a second round trip).
        let want = ["pane_usage", "artifacts_sync", "pane_git_branch", "pane_worktree", "checkpoints_list"].iter().filter(|c| level >= level_of(c)).count();
        assert_eq!(parts.len(), want, "{level:?}");
    }
    assert!(calls_files::mine("pane_open_bundle"));
}

#[test]
fn the_open_bundle_meets_the_chats_own_rule_like_its_parts() {
    let fake = Fake::default();
    assert_eq!(post(Some(Level::Watch), &fake, "pane_open_bundle", &json!({ "paneId": "p1" })).0, 200);
    let locked = Fake::default();
    locked.locked.lock().unwrap().push("p1".into());
    assert_eq!(post(Some(Level::Watch), &locked, "pane_open_bundle", &json!({ "paneId": "p1" })).1["code"], "AGENT_LOCKED");
}
