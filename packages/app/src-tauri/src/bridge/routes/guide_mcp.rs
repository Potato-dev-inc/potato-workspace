//! `/guide/*`: the project guide tools for agents (`read_guide_structure`, `read_guide_page`, `ask_guide`; logic in
//! `crate::project_guide::agent_tools`).
//!
//! Who may call: only an MCP session of an agent on **this computer**, and only while the Labs switch "Project
//! guide" is on. The router has already checked the bearer token and the device caps; on top of that these routes
//! refuse every paired phone, every request with a forwarder header, a foreign `Host` or a foreign `Origin` (the
//! bridge-auth invariant), and every caller without an MCP session. The project must be one the app knows (a pane's
//! folder or the open project), so an agent cannot point the tool at some other folder on the disk. Read-only.

use super::{Ctx, RouteResult};
use crate::mobile_pairing::Caller;
use crate::project_guide::agent_tools::{self, GuideToolError};
use serde_json::{json, Value};
use std::path::PathBuf;

const OPS: [&str; 3] = ["structure", "page", "ask"];

/// What the route needs from the app. The live one is [`LiveGuide`]; tests use a fake.
pub(crate) trait GuideBackend {
    fn enabled(&self) -> bool;
    /// The project folders the app knows: the open project and every pane's folder.
    fn known_projects(&self) -> Vec<PathBuf>;
}

pub(crate) struct LiveGuide<'a> {
    app: &'a tauri::AppHandle,
    registry: &'a std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
}

impl GuideBackend for LiveGuide<'_> {
    fn enabled(&self) -> bool {
        let public = crate::settings_store::read_public_settings(self.app);
        public.get(crate::project_guide::LABS_KEY).and_then(Value::as_bool).unwrap_or(false)
    }
    fn known_projects(&self) -> Vec<PathBuf> {
        let registry = self.registry.lock();
        let mut out = vec![PathBuf::from(&registry.project_path)];
        out.extend(registry.panes.values().map(|pane| PathBuf::from(&pane.info.cwd)));
        out.retain(|p| !p.as_os_str().is_empty());
        out
    }
}

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    handle_request(cx.method, cx.segments, &cx.request_body, cx.headers, cx.peer_loopback, cx.session, &LiveGuide { app: cx.app, registry: cx.registry })
}

fn refuse(status: u16, code: &str, message: &str, recoverable: bool) -> RouteResult {
    Err((status, json!({ "code": code, "error": message, "message": message, "recoverable": recoverable, "context": {} })))
}

fn status_of(error: &GuideToolError) -> (u16, bool) {
    match error.code {
        "INVALID_ARGUMENT" => (400, true),
        "NO_GUIDE" | "UNKNOWN_PAGE" => (404, true),
        "PATH_NOT_ALLOWED" | "PROJECT_NOT_ALLOWED" => (403, false),
        _ => (500, false),
    }
}

fn text<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `None` when the request is not a `/guide/*` route.
pub(crate) fn handle_request(
    method: &str,
    raw_segments: &[&str],
    body: &Value,
    headers: &str,
    peer_loopback: bool,
    session: Option<&str>,
    backend: &dyn GuideBackend,
) -> Option<RouteResult> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(raw_segments);
    let ["guide", op] = segments else { return None };
    match crate::mobile_pairing::authorize_caller(headers, peer_loopback, raw_segments, method) {
        Ok(Caller::Local) => {}
        Ok(_) | Err(_) => {
            return Some(refuse(403, "GUIDE_LOCAL_ONLY", "The project guide tools are for the agents on this computer. A phone or any remote caller cannot use them.", false))
        }
    }
    if session.map(str::trim).filter(|s| !s.is_empty()).is_none() {
        return Some(refuse(400, "SESSION_REQUIRED", "The project guide tools need an MCP session id.", false));
    }
    if method != "POST" {
        return Some(refuse(405, "METHOD_NOT_ALLOWED", "Use POST.", false));
    }
    if !OPS.contains(op) {
        return Some(refuse(404, "NOT_FOUND", "Unknown guide tool route.", false));
    }
    if !backend.enabled() {
        return Some(refuse(409, "GUIDE_OFF", "The project guide is off. The person can turn it on in Settings > Labs > Project guide.", false));
    }
    let project_path = text(body, "project_path");
    let allowed = agent_tools::checked_project(project_path).and_then(|real| {
        if agent_tools::inside_known(&real, &backend.known_projects()) {
            Ok(())
        } else {
            Err(GuideToolError::new("PROJECT_NOT_ALLOWED", "That folder is not a project this app has open. Use the project folder of your own pane."))
        }
    });
    let result = allowed.and_then(|()| match *op {
        "structure" => agent_tools::structure(project_path),
        "page" => agent_tools::page(project_path, text(body, "page_id")),
        _ => agent_tools::ask(project_path, text(body, "question")),
    });
    Some(match result {
        Ok(value) => Ok((200, value)),
        Err(error) => {
            let (status, recoverable) = status_of(&error);
            refuse(status, error.code, &error.message, recoverable)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        on: bool,
        projects: Vec<PathBuf>,
    }

    impl GuideBackend for Fake {
        fn enabled(&self) -> bool {
            self.on
        }
        fn known_projects(&self) -> Vec<PathBuf> {
            self.projects.clone()
        }
    }

    const LOCAL: &str = "Host: 127.0.0.1:17421\r\nContent-Type: application/json\r\n";

    fn call(f: &Fake, op: &str, body: Value, headers: &str, loopback: bool, session: Option<&str>) -> RouteResult {
        handle_request("POST", &["guide", op], &body, headers, loopback, session, f).expect("a guide route")
    }

    fn refused_with(result: RouteResult, status: u16, code: &str) {
        match result {
            Err((got, body)) => {
                assert_eq!(got, status, "{body}");
                assert_eq!(body["code"], code, "{body}");
            }
            Ok(ok) => panic!("expected {code}, got {ok:?}"),
        }
    }

    fn project_with_guide(name: &str) -> PathBuf {
        use crate::project_guide::model::{Cited, Manifest, PageRecord};
        let dir = std::env::temp_dir().join(format!("pm-guide-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/queue.ts"), "a\nb\nc\nd\n").unwrap();
        let hash = crate::project_guide::store::file_hash(&dir, "src/queue.ts").unwrap();
        let manifest = Manifest {
            version: 1,
            written_at_ms: crate::project_guide::store::now_ms(),
            agent: "Claude Code".into(),
            complete: true,
            pages: vec![PageRecord { id: "sync".into(), title: "Sync queue".into(), purpose: "How changes are sent".into(), cited: vec![Cited { path: "src/queue.ts".into(), hash }], needs_review: false }],
            ..Default::default()
        };
        crate::project_guide::store::write_manifest(&dir, &manifest).unwrap();
        crate::project_guide::store::write_page(&dir, "sync", "# Sync queue\n\nChanges wait in a queue and are sent in order [[src/queue.ts:1-3]].\n\nUnrelated words about colours.\n").unwrap();
        dir
    }

    fn fake_for(dir: &PathBuf) -> Fake {
        Fake { on: true, projects: vec![dir.clone()] }
    }

    #[test]
    fn a_local_session_reads_the_structure_a_page_and_an_answer() {
        let dir = project_with_guide("ok");
        let f = fake_for(&dir);
        let path = dir.to_string_lossy().to_string();
        let s = call(&f, "structure", json!({ "project_path": path }), LOCAL, true, Some("s1")).unwrap().1;
        assert_eq!(s["pages"][0]["id"], "sync");
        assert_eq!(s["pages"][0]["stale"], false);
        let p = call(&f, "page", json!({ "project_path": path, "page_id": "sync" }), LOCAL, true, Some("s1")).unwrap().1;
        assert!(p["markdown"].as_str().unwrap().contains("queue"));
        let a = call(&f, "ask", json!({ "project_path": path, "question": "how does the sync queue send changes?" }), LOCAL, true, Some("s1")).unwrap().1;
        assert_eq!(a["found"], true);
        assert_eq!(a["matches"][0]["page_id"], "sync");
        assert_eq!(a["matches"][0]["citations"][0], "src/queue.ts:1-3");
        assert!(a["answered_by"].as_str().unwrap().contains("no model"));
    }

    #[test]
    fn a_stale_page_starts_with_the_warning() {
        let dir = project_with_guide("stale");
        std::fs::write(dir.join("src/queue.ts"), "changed\n").unwrap();
        let f = fake_for(&dir);
        let path = dir.to_string_lossy().to_string();
        let p = call(&f, "page", json!({ "project_path": path, "page_id": "sync" }), LOCAL, true, Some("s1")).unwrap().1;
        assert!(p["markdown"].as_str().unwrap().starts_with("Parts of this page may be out of date: src/queue.ts"));
        assert_eq!(p["stale"], true);
        let s = call(&f, "structure", json!({ "project_path": path }), LOCAL, true, Some("s1")).unwrap().1;
        assert_eq!(s["stale_pages"], 1);
    }

    #[test]
    fn a_page_id_cannot_leave_the_guide_folder() {
        let dir = project_with_guide("trav");
        std::fs::write(dir.join("secret.md"), "secret").unwrap();
        let f = fake_for(&dir);
        let path = dir.to_string_lossy().to_string();
        for bad in ["../secret", "..\\..\\secret", "../../.potato/guide/manifest", "a/b", "/etc/passwd", "C:\\x", ""] {
            refused_with(call(&f, "page", json!({ "project_path": path, "page_id": bad }), LOCAL, true, Some("s1")), 400, "INVALID_ARGUMENT");
        }
        refused_with(call(&f, "page", json!({ "project_path": path, "page_id": "nope" }), LOCAL, true, Some("s1")), 404, "UNKNOWN_PAGE");
    }

    #[test]
    fn a_project_the_app_does_not_know_is_refused() {
        let dir = project_with_guide("known");
        let other = project_with_guide("other");
        let f = fake_for(&dir);
        refused_with(call(&f, "structure", json!({ "project_path": other.to_string_lossy() }), LOCAL, true, Some("s1")), 403, "PROJECT_NOT_ALLOWED");
        refused_with(call(&f, "structure", json!({ "project_path": "" }), LOCAL, true, Some("s1")), 400, "INVALID_ARGUMENT");
        refused_with(call(&f, "structure", json!({ "project_path": dir.join("..").to_string_lossy() }), LOCAL, true, Some("s1")), 403, "PROJECT_NOT_ALLOWED");
    }

    #[test]
    fn no_guide_off_and_no_session_are_plain_errors() {
        let dir = project_with_guide("errs");
        let empty = std::env::temp_dir().join(format!("pm-guide-mcp-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let f = Fake { on: true, projects: vec![dir.clone(), empty.clone()] };
        refused_with(call(&f, "structure", json!({ "project_path": empty.to_string_lossy() }), LOCAL, true, Some("s1")), 404, "NO_GUIDE");
        let off = Fake { on: false, projects: vec![dir.clone()] };
        refused_with(call(&off, "structure", json!({ "project_path": dir.to_string_lossy() }), LOCAL, true, Some("s1")), 409, "GUIDE_OFF");
        refused_with(call(&f, "structure", json!({ "project_path": dir.to_string_lossy() }), LOCAL, true, None), 400, "SESSION_REQUIRED");
        refused_with(call(&f, "ask", json!({ "project_path": dir.to_string_lossy(), "question": "  " }), LOCAL, true, Some("s1")), 400, "INVALID_ARGUMENT");
    }

    #[test]
    fn a_remote_caller_or_phone_gets_403() {
        let dir = project_with_guide("remote");
        let f = fake_for(&dir);
        let body = json!({ "project_path": dir.to_string_lossy() });
        let cases = [
            format!("{LOCAL}X-Forwarded-For: 203.0.113.9\r\n"),
            format!("{LOCAL}Cf-Connecting-Ip: 203.0.113.9\r\n"),
            format!("{LOCAL}X-Potato-Workspace-Proxied: 1\r\n"),
            format!("{LOCAL}Origin: https://evil.example\r\n"),
            "Host: guide.example.com\r\n".to_string(),
            format!("{LOCAL}Authorization: Bearer not-a-token\r\nX-Forwarded-For: 1.2.3.4\r\n"),
        ];
        for headers in cases {
            for op in OPS {
                refused_with(call(&f, op, body.clone(), &headers, true, Some("s1")), 403, "GUIDE_LOCAL_ONLY");
            }
        }
        refused_with(call(&f, "structure", body.clone(), LOCAL, false, Some("s1")), 403, "GUIDE_LOCAL_ONLY");
    }

    #[test]
    fn other_paths_and_methods_are_not_ours() {
        let f = Fake { on: true, projects: vec![] };
        assert!(handle_request("POST", &["browser", "open"], &json!({}), LOCAL, true, Some("s"), &f).is_none());
        assert!(handle_request("POST", &["guide"], &json!({}), LOCAL, true, Some("s"), &f).is_none());
        refused_with(handle_request("GET", &["guide", "structure"], &json!({}), LOCAL, true, Some("s"), &f).unwrap(), 405, "METHOD_NOT_ALLOWED");
        refused_with(handle_request("POST", &["guide", "write"], &json!({}), LOCAL, true, Some("s"), &f).unwrap(), 404, "NOT_FOUND");
    }
}
