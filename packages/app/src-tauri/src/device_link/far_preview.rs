//! P5.2, this PC's side of a far dev-server preview. A window labelled `farprev-<n>` loads `pmfar://localhost/`, and this file answers every
//! request that window makes: it turns the request into one `POST /pclink/stream/preview` to the far PC (`pclink/preview.rs`) and gives the
//! page back what the far PC's dev server said. No port is opened on this PC: the page never touches a socket of ours, only the
//! app's own custom protocol (the guard test below fails on a listener in this file).
//!
//! Which far chat and port a window shows is fixed when it is opened from an app window (`far_preview_open`); a page cannot choose another.
//! The window is in no capability (it is the far PC's page, untrusted), may not leave its own address, open new windows or download.
//! An open socket (hot reload) or a stream is not carried: the page loads, and reloads by hand.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::http::{Request, Response};
use tauri::{AppHandle, Runtime, UriSchemeContext, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::app as dl;

/// Every far preview window's label starts with this. No capability may match it (pinned by a test).
pub const LABEL_PREFIX: &str = "farprev-";
const BODY_MAX: usize = 4 * 1024 * 1024;

/// Tauri counts a page on our own `pmfar` scheme as a local origin and, with no app manifest, lets a local page call every app command.
/// So the far PC's page would reach `files_read` and the rest. Any webview whose label is `farprev-*` is refused here, for every command.
pub fn refuses_commands(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Wraps the app's one invoke handler: far preview windows get one plain error, every other window goes on to the real handler.
pub fn guarded<R: Runtime>(real: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if refuses_commands(invoke.message.webview().label()) {
            invoke.resolver.reject("A preview page cannot use the app.");
            return true;
        }
        real(invoke)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    node: String,
    pane: String,
    port: u16,
}

static TARGETS: Lazy<Mutex<HashMap<String, Target>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT: AtomicU32 = AtomicU32::new(1);

/// The body of one `POST /pclink/stream/preview` for a request the page made.
fn request_body(target: &Target, method: &str, path_and_query: &str, headers: &[(String, String)], body: &[u8]) -> Value {
    json!({
        "paneId": target.pane, "port": target.port, "method": method, "path": path_and_query,
        "headers": headers.iter().map(|(n, v)| json!([n, v])).collect::<Vec<_>>(),
        "bodyB64": if body.is_empty() { String::new() } else { STANDARD.encode(body) },
    })
}

/// A redirect to the far server's own address goes to the same path on the protocol; any other address stays what it was (the page's
/// navigation guard then refuses it).
fn local_location(location: &str, port: u16) -> String {
    for host in ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"] {
        if let Some(rest) = location.strip_prefix(&format!("http://{host}:{port}")) {
            return if rest.is_empty() { "/".to_string() } else { rest.to_string() };
        }
    }
    location.to_string()
}

/// What the far PC answered, as `(status, headers, body)`; an error answer is a plain page with its sentence.
fn answer(status: u16, body: &Value, port: u16) -> (u16, Vec<(String, String)>, Vec<u8>) {
    if status != 200 {
        let said = body.get("error").and_then(Value::as_str).unwrap_or("The preview is not available.");
        let page = format!("<!doctype html><meta charset=\"utf-8\"><body style=\"font:16px sans-serif;padding:32px\"><p>{}</p>", said.replace('&', "&amp;").replace('<', "&lt;"));
        let code = if status == 413 { 413 } else { 502 };
        return (code, vec![("content-type".into(), "text/html; charset=utf-8".into())], page.into_bytes());
    }
    let code = body.get("status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()).filter(|s| (100..600).contains(s)).unwrap_or(502);
    let mut headers: Vec<(String, String)> = Vec::new();
    for pair in body.get("headers").and_then(Value::as_array).into_iter().flatten() {
        if let (Some(name), Some(value)) = (pair.get(0).and_then(Value::as_str), pair.get(1).and_then(Value::as_str)) {
            let value = if name == "location" { local_location(value, port) } else { value.to_string() };
            headers.push((name.to_string(), value));
        }
    }
    let bytes = body.get("bodyB64").and_then(Value::as_str).and_then(|b| STANDARD.decode(b).ok()).unwrap_or_default();
    (code, headers, bytes)
}

fn respond(responder: UriSchemeResponder, status: u16, headers: Vec<(String, String)>, body: Vec<u8>) {
    let mut builder = Response::builder().status(status);
    for (name, value) in &headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    responder.respond(builder.body(body).unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).expect("empty response")));
}

/// The handler registered in `lib.rs` for the `pmfar` scheme. Only a window opened by `far_preview_open` is answered.
pub fn serve<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let Some(target) = TARGETS.lock().get(ctx.webview_label()).cloned() else {
        return respond(responder, 404, vec![], Vec::new());
    };
    let method = request.method().as_str().to_string();
    let uri = request.uri();
    let path = format!("{}{}", uri.path(), uri.query().map(|q| format!("?{q}")).unwrap_or_default());
    let headers: Vec<(String, String)> = request.headers().iter().filter_map(|(n, v)| v.to_str().ok().map(|v| (n.as_str().to_string(), v.to_string()))).collect();
    let body = request.into_body();
    if body.len() > BODY_MAX {
        return respond(responder, 413, vec![], Vec::new());
    }
    tauri::async_runtime::spawn(async move {
        let sent = request_body(&target, &method, &path, &headers, &body);
        let asked = match dl::app_service() {
            Ok(link) => link.request(&target.node, "POST", "/pclink/stream/preview", Some(sent)).await,
            Err(text) => Err(text),
        };
        let (status, headers, bytes) = match asked {
            Ok((status, value)) => answer(status, &value, target.port),
            Err(_) => answer(502, &json!({ "error": "That PC is not answering. Is it on?" }), target.port),
        };
        respond(responder, status, headers, bytes);
    });
}

/// Opens one far dev server (`port` of far chat `pane` on `node`) in its own window. Called from an app window only.
pub fn open(app: &AppHandle, node: &str, pane: &str, port: u16) -> Result<(), String> {
    let label = format!("{LABEL_PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    TARGETS.lock().insert(label.clone(), Target { node: node.to_string(), pane: pane.to_string(), port });
    let url = tauri::Url::parse("pmfar://localhost/").map_err(|e| e.to_string())?;
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title("Preview")
        .inner_size(1100.0, 760.0)
        .data_directory(crate::app_paths::app_data_dir().join("far-preview-web"))
        // The page stays on its own address; a link out, a new window and a download are all refused.
        .on_navigation(|next| matches!(next.scheme(), "pmfar") || next.host_str().is_some_and(|h| h == "pmfar.localhost"))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()
        .map_err(|e| {
            TARGETS.lock().remove(&label);
            format!("The preview window did not open: {e}")
        })?;
    let gone = label.clone();
    built.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            TARGETS.lock().remove(&gone);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target { node: "aa".into(), pane: "p1".into(), port: 5173 }
    }

    #[test]
    fn a_request_becomes_one_body_with_its_pane_and_port_fixed_by_the_window() {
        let body = request_body(&target(), "POST", "/api/x?y=1", &[("content-type".into(), "text/plain".into())], b"hi");
        assert_eq!((body["paneId"].as_str(), body["port"].as_u64(), body["path"].as_str()), (Some("p1"), Some(5173), Some("/api/x?y=1")));
        assert_eq!(body["bodyB64"], STANDARD.encode(b"hi"));
        assert_eq!(request_body(&target(), "GET", "/", &[], b"")["bodyB64"], "");
    }

    #[test]
    fn a_redirect_to_the_far_servers_own_address_stays_on_the_protocol() {
        assert_eq!(local_location("http://localhost:5173/login", 5173), "/login");
        assert_eq!(local_location("http://127.0.0.1:5173", 5173), "/");
        assert_eq!(local_location("http://localhost:3000/x", 5173), "http://localhost:3000/x", "another port is left for the guard to refuse");
        assert_eq!(local_location("/rel", 5173), "/rel");
    }

    #[test]
    fn the_answer_carries_status_headers_and_bytes_and_an_error_is_a_plain_escaped_page() {
        let far = json!({ "status": 404, "headers": [["content-type", "text/css"], ["location", "http://localhost:5173/a"]], "bodyB64": STANDARD.encode(b"body{}") });
        let (status, headers, bytes) = answer(200, &far, 5173);
        assert_eq!((status, bytes.as_slice()), (404, &b"body{}"[..]));
        assert!(headers.contains(&("location".into(), "/a".into())) && headers.contains(&("content-type".into(), "text/css".into())));
        let (status, headers, page) = answer(403, &json!({ "error": "<script>x</script>" }), 5173);
        assert_eq!(status, 502);
        assert!(headers[0].1.starts_with("text/html") && !String::from_utf8(page).unwrap().contains("<script>"));
        assert_eq!(answer(200, &json!({ "status": 99, "bodyB64": "" }), 5173).0, 502, "a status that is not HTTP is not passed on");
    }

    /// No new loopback listener on this PC (S1, S8): this file, the far side's `preview.rs` and the app command only ever connect out.
    #[test]
    fn no_port_is_opened_on_this_pc_for_a_far_preview() {
        for (name, source) in [("far_preview.rs", include_str!("far_preview.rs")), ("pclink/preview.rs", include_str!("pclink/preview.rs"))] {
            let code: String = source.split("#[cfg(test)]").next().unwrap_or("").to_string();
            for bad in ["TcpListener", "bind(", "UdpSocket", "tiny_http", "hyper::Server", "axum", "warp::"] {
                assert!(!code.contains(bad), "{name} names {bad}");
            }
        }
    }

    /// `*` matches any run of characters (Tauri's label patterns).
    fn glob(pattern: &str, text: &str) -> bool {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 1 {
            return pattern == text;
        }
        let (first, last) = (parts[0], parts[parts.len() - 1]);
        if text.len() < first.len() + last.len() || !text.starts_with(first) || !text.ends_with(last) {
            return false;
        }
        let mut rest = &text[first.len()..text.len() - last.len()];
        for mid in &parts[1..parts.len() - 1] {
            match rest.find(mid) {
                Some(at) => rest = &rest[at + mid.len()..],
                None => return false,
            }
        }
        true
    }

    fn has_key(json: &Value, key: &str) -> bool {
        match json {
            Value::Object(m) => m.contains_key(key) || m.values().any(|v| has_key(v, key)),
            Value::Array(a) => a.iter().any(|v| has_key(v, key)),
            _ => false,
        }
    }

    /// The window is the far PC's page: no capability file may name its label (`windows` or `webviews`), none may open IPC to a remote origin
    /// (`remote`), and no permission URL pattern may match the `pmfar` pages. Reads every `capabilities/*.json` at test time.
    #[test]
    fn only_far_preview_labels_are_refused_every_app_command() {
        for yes in ["farprev-1", "farprev-99", "farprev-"] {
            assert!(refuses_commands(yes), "{yes}");
        }
        for no in ["main", "cockpit", "settings", "detached-pane-3", "artifact-window-1", "tab-window-2", "askbar", "pointbox", "preview-1", "mini-bar", "pet", "far-preview", "xfarprev-1"] {
            assert!(!refuses_commands(no), "{no}");
        }
    }

    #[test]
    fn no_capability_matches_a_far_preview_window_or_its_pages() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            seen += 1;
            let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            for key in ["windows", "webviews"] {
                for entry in json.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                    for label in [format!("{LABEL_PREFIX}1"), format!("{LABEL_PREFIX}12"), LABEL_PREFIX.to_string()] {
                        assert!(!glob(entry, &label), "{}: `{entry}` matches `{label}`", path.display());
                    }
                }
            }
            assert!(!has_key(&json, "remote"), "{} opens IPC to remote origins", path.display());
            assert!(!has_key(&json, "urls"), "{} has URL patterns", path.display());
        }
        assert!(seen > 0, "no capability files were read");
        assert!(glob("farprev-*", "farprev-1") && !glob("main", "farprev-1") && glob("*", "farprev-1"), "the matcher itself");
    }
}
