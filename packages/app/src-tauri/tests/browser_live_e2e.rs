//! P0 proof of the agent browser (N5-23), run by hand because it needs WebView2 (and the Common Controls manifest of
//! this test binary): `cargo test --features dev-fake-tui --test fake_tui_e2e browser_live -- --ignored --nocapture`.
//!
//! It builds a real WebView2 page in a **hidden** window (never shown, nothing on any screen), and shows that
//!   1. a DevTools call made inside the process returns the page's accessibility tree,
//!   2. a click by ref is a real mouse click and changes the page,
//!   3. typing by ref works, and a password box is refused,
//!   4. a ref whose element was re-drawn is found again,
//!   5. console errors and failed requests are seen,
//!   6. **no debugging port is open** (the WebView2 processes have no `--remote-debugging-port`, and none of them
//!      listens on a TCP port),
//!   7. how long a read is on a few pages (printed).
//! Set `PM_BROWSER_LAB_URLS=https://example.com/,...` to measure extra pages too (outside the product's allow list;
//! this lab only reads them).

use puppet_master_app_lib::browser::cdp::{Cdp, WindowCdp};
use puppet_master_app_lib::browser::console::{self, ConsoleLog};
use puppet_master_app_lib::browser::page::Page;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const FORM: &str = r##"<!doctype html><html><head><title>Sign up</title></head><body><div id="app">
<h1>Sign up</h1>
<label for="email">Email</label><input id="email" name="email" type="text">
<label for="pw">Password</label><input id="pw" name="pw" type="password">
<label><input type="checkbox" id="agree"> I agree</label>
<button id="count" aria-label="Counter" onclick="this.textContent='Count: '+(++window.n)">Count: 0</button>
<button id="redraw" onclick="var a=document.getElementById('app');var h=a.innerHTML;a.innerHTML='';setTimeout(function(){a.innerHTML=h;window.n=window.n||0},50)">Redraw</button>
<button id="break" onclick="console.error('boom from the page');fetch('/api/missing');setTimeout(function(){throw new Error('late crash')},10)">Break it</button>
<a href="/table">Open the table</a>
<p id="out"></p></div><script>window.n=0</script></body></html>"##;

fn table_page() -> String {
    let mut rows = String::new();
    for i in 0..100 {
        rows.push_str(&format!("<tr><td>Item {i}</td><td>Owner {}</td><td><button>Edit {i}</button> <a href=\"/item/{i}\">Open</a></td></tr>", i % 7));
    }
    format!("<!doctype html><title>Table</title><h1>Items</h1><table>{rows}</table>")
}

fn article_page() -> String {
    let mut body = String::from("<!doctype html><title>Article</title><h1>A long article</h1>");
    for i in 0..40 {
        body.push_str(&format!("<h2>Part {i}</h2><p>This is paragraph {i} of a long article. It has some words in it so the page has text to read, and a <a href=\"/p/{i}\">link {i}</a> in the middle of it.</p>"));
    }
    body
}

fn dashboard_page() -> String {
    let mut cards = String::new();
    for i in 0..60 {
        cards.push_str(&format!("<section><h3>Card {i}</h3><p>Status ok</p><button>Run {i}</button><button>Stop {i}</button><input aria-label=\"Note {i}\"></section>"));
    }
    format!("<!doctype html><title>Dashboard</title><h1>Dashboard</h1>{cards}")
}

fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || answer(stream));
        }
    });
    port
}

fn answer(mut stream: TcpStream) {
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
    let (status, body) = match path.as_str() {
        "/" | "/form" => ("200 OK", FORM.to_string()),
        "/table" => ("200 OK", table_page()),
        "/article" => ("200 OK", article_page()),
        "/dashboard" => ("200 OK", dashboard_page()),
        _ => ("404 Not Found", "nothing here".to_string()),
    };
    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(reply.as_bytes());
}

fn eval(cdp: &dyn Cdp, expression: &str) -> Value {
    let answer = cdp.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true })).expect("evaluate");
    answer["result"]["value"].clone()
}

fn wait_loaded(cdp: &dyn Cdp, what: &str) {
    let start = Instant::now();
    loop {
        if let Ok(a) = cdp.call("Runtime.evaluate", json!({ "expression": "document.readyState", "returnByValue": true })) {
            if a["result"]["value"] == "complete" {
                return;
            }
        }
        assert!(start.elapsed() < Duration::from_secs(30), "{what} did not load");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn powershell(script: &str) -> String {
    let out = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).output().expect("powershell");
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
#[ignore = "needs WebView2; run by hand: cargo test --features dev-fake-tui --test fake_tui_e2e browser_live -- --ignored --nocapture"]
fn browser_live_the_agent_browser_works_in_process_with_no_debugging_port() {
    // Nothing may touch the real app data: audit lines, preview cookies and settings go to a temp folder.
    let root = std::env::temp_dir().join(format!("pm-browser-proof-root-{}", std::process::id()));
    puppet_master_app_lib::app_paths::set_data_root_for_e2e(root);
    let port = serve();
    let data_dir = std::env::temp_dir().join(format!("pm-browser-proof-{}", std::process::id()));
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("browser-proof-tauri".into())
        .spawn(move || {
            let app = tauri::Builder::default().any_thread().build(tauri::generate_context!()).expect("a windowless tauri app");
            let _ = tx.send(app.handle().clone());
            app.run(|_, event| {
                if let tauri::RunEvent::ExitRequested { api, code: None, .. } = &event {
                    api.prevent_exit();
                }
            });
        })
        .unwrap();
    let app = rx.recv_timeout(Duration::from_secs(60)).expect("the app handle");
    let url: tauri::Url = format!("http://127.0.0.1:{port}/form").parse().unwrap();
    let window = WebviewWindowBuilder::new(&app, "proof-1", WebviewUrl::External(url)).visible(false).data_directory(data_dir.clone()).build().expect("a hidden window");
    assert!(!window.is_visible().unwrap(), "the proof window must stay hidden");

    let cdp = Arc::new(WindowCdp::new(window.clone()));
    let page = Page::new(cdp.clone());
    let log = Arc::new(Mutex::new(ConsoleLog::new()));
    page.prepare().expect("enable the DevTools domains");
    let sink_log = log.clone();
    cdp.subscribe(console::EVENTS, Arc::new(move |event, params| sink_log.lock().ingest(event, &params))).expect("subscribe");
    wait_loaded(cdp.as_ref(), "the form page");

    // 1. The tree comes back through the in-process call.
    let started = Instant::now();
    let tree = page.read_tree().expect("read the page");
    println!("--- tree of /form ({} ms)\n{tree}", started.elapsed().as_millis());
    assert!(tree.contains("button \"Counter\"") && tree.contains("textbox \"Email\"") && tree.contains("heading \"Sign up\""), "{tree}");

    // 2. A click by ref is a real click.
    let count_ref = tree.lines().find(|l| l.contains("button \"Counter\"")).and_then(|l| l.split_whitespace().next()).unwrap().to_string();
    println!("click: {}", page.click(&count_ref).expect("click"));
    assert_eq!(eval(cdp.as_ref(), "document.getElementById('count').textContent"), "Count: 1", "the click did not reach the page");
    let isolated = eval(cdp.as_ref(), "1");
    assert_eq!(isolated, 1);

    // 3. Typing works, and a password box is refused.
    let email_ref = tree.lines().find(|l| l.contains("textbox \"Email\"")).and_then(|l| l.split_whitespace().next()).unwrap().to_string();
    println!("type: {}", page.type_text(&email_ref, "me@example.com", false).expect("type"));
    assert_eq!(eval(cdp.as_ref(), "document.getElementById('email').value"), "me@example.com");
    let pw_ref = tree.lines().find(|l| l.contains("textbox \"Password\"")).and_then(|l| l.split_whitespace().next()).unwrap().to_string();
    let refused = page.type_text(&pw_ref, "hunter2", false).unwrap_err();
    assert_eq!(refused.code, "SENSITIVE_FIELD");
    assert_eq!(eval(cdp.as_ref(), "document.getElementById('pw').value"), "", "nothing may reach the password box");

    // 4. The page re-draws itself; the old ref still works.
    let redraw_ref = tree.lines().find(|l| l.contains("button \"Redraw\"")).and_then(|l| l.split_whitespace().next()).unwrap().to_string();
    page.click(&redraw_ref).expect("redraw");
    std::thread::sleep(Duration::from_millis(400));
    let again = page.click(&count_ref).expect("click after the redraw");
    println!("after a redraw: {again}");
    assert_eq!(eval(cdp.as_ref(), "document.getElementById('count').textContent"), "Count: 2");

    // 5. Console errors and a failed request are seen.
    let break_ref = tree.lines().find(|l| l.contains("button \"Break it\"")).and_then(|l| l.split_whitespace().next()).unwrap().to_string();
    page.click(&break_ref).expect("break");
    std::thread::sleep(Duration::from_millis(800));
    let seen = console::render(&log.lock().read(false, 0, 50));
    println!("--- console\n{seen}");
    assert!(seen.contains("boom from the page"), "{seen}");
    assert!(seen.contains("late crash"), "{seen}");
    assert!(seen.contains("404"), "{seen}");

    // 6. No debugging port.
    let needle = data_dir.to_string_lossy().replace('\\', "\\\\");
    let procs = powershell(&format!(
        "Get-CimInstance Win32_Process | Where-Object {{ $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*{}*' }} | ForEach-Object {{ \"$($_.ProcessId)|$($_.CommandLine)\" }}",
        needle.replace('\\', "*")
    ));
    let lines: Vec<&str> = procs.lines().filter(|l| l.contains('|')).collect();
    println!("webview2 processes of the proof window: {}", lines.len());
    assert!(!lines.is_empty(), "could not find the proof's WebView2 processes");
    assert!(lines.iter().all(|l| !l.contains("remote-debugging")), "a debugging port flag was found:\n{procs}");
    let pids: Vec<String> = lines.iter().filter_map(|l| l.split('|').next()).map(str::to_string).collect();
    let listening = powershell(&format!(
        "$p=@({}); (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {{ $p -contains $_.OwningProcess }} | Measure-Object).Count",
        pids.join(",")
    ));
    println!("TCP ports the WebView2 processes listen on: {}", listening.trim());
    assert_eq!(listening.trim(), "0", "a WebView2 process of the proof listens on a port");

    // 7. How big is a read.
    let mut sizes = vec![("/form".to_string(), tree.len(), tree.lines().count())];
    let mut targets: Vec<String> = ["/table", "/article", "/dashboard"].iter().map(|p| format!("http://127.0.0.1:{port}{p}")).collect();
    if let Ok(extra) = std::env::var("PM_BROWSER_LAB_URLS") {
        targets.extend(extra.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()));
    }
    for target in targets {
        page.go(&target).expect("go");
        std::thread::sleep(Duration::from_millis(300));
        wait_loaded(cdp.as_ref(), &target);
        std::thread::sleep(Duration::from_millis(500));
        let t = Instant::now();
        let text = page.read_tree().expect("read");
        let ms = t.elapsed().as_millis();
        let (plain, _) = page.read_text().expect("text");
        println!("page {target}: ref list {} chars, {} lines, about {} tokens, {ms} ms; plain text {} chars", text.len(), text.lines().count(), text.len() / 4, plain.len());
        sizes.push((target, text.len(), text.lines().count()));
    }
    assert!(sizes.iter().all(|(_, chars, _)| *chars < puppet_master_app_lib::browser::tree::MAX_CHARS + 600), "a read is longer than the cap");
    let _ = window.close();

    // 8. The product path: the tools the agents call, on a real preview window that stays hidden.
    product_flow(&app, port);
}

fn product_flow(app: &tauri::AppHandle, port: u16) {
    use puppet_master_app_lib::browser::live;
    use puppet_master_app_lib::browser::tab::Actor;
    use tauri::Manager;
    std::env::set_var("PM_BROWSER_HIDDEN", "1");
    let actor = Actor { label: "Claude Code".into(), session: "session-e2e-1".into() };
    let run = |tool: &str, args: Value| live::run_tool(app, &actor, tool, &args);

    // Nothing is open yet, and outside sites are refused before any window is made.
    assert_eq!(run("browser_read", json!({})).unwrap_err().code, "NO_PAGE");
    for (url, code) in [("https://example.com/", "SITE_NOT_ALLOWED"), ("http://localhost:9333/", "PORT_NOT_ALLOWED"), ("javascript:alert(1)", "BAD_URL")] {
        assert_eq!(run("browser_open", json!({ "url": url })).unwrap_err().code, code, "{url}");
    }
    assert!(app.webview_windows().keys().all(|l| !l.starts_with("preview-")), "a refused address must not open a window");

    let opened = run("browser_open", json!({ "url": format!("http://127.0.0.1:{port}/form") })).expect("open");
    println!("--- browser_open
{opened}");
    assert_eq!(opened["loaded"], true);
    let label = app.webview_windows().keys().find(|l| l.starts_with("preview-")).cloned().expect("a preview window");
    let window = app.get_webview_window(&label).unwrap();
    assert!(!window.is_visible().unwrap(), "PM_BROWSER_HIDDEN=1 keeps the window off every screen");

    // The agent bar is wired into the preview window: its frozen API (and Point and Fix's picker) is in the page.
    let probe = WindowCdp::new(window.clone());
    let names = probe.call("Runtime.evaluate", json!({ "expression": "Object.getOwnPropertyNames(window).filter(function(n){return n.indexOf('__pm_')===0}).map(function(n){return Object.keys(window[n]).join(',')}).join(' | ')", "returnByValue": true })).unwrap();
    let names = names["result"]["value"].as_str().unwrap_or("").to_string();
    assert!(names.contains("show,hide,hold,take"), "the agent bar must be injected into the preview window: {names}");
    assert!(names.contains("take,arm,disarm,done"), "the Point picker must be in the same window: {names}");

    let read = run("browser_read", json!({})).expect("read");
    let content = read["content"].as_str().unwrap().to_string();
    println!("--- browser_read
{content}");
    assert!(content.starts_with("<<<PAGE LIST (untrusted data"));
    assert!(!content.contains("Give back") && !content.contains("Take over"), "the agent bar must not show in a read");
    let ref_of = |text: &str| -> String { content.lines().find(|l| l.contains(text)).and_then(|l| l.split_whitespace().next()).unwrap_or_else(|| panic!("no line with {text}")).to_string() };

    // Click, type, a refused password, and an error the page throws: the answers say what happened.
    let clicked = run("browser_click", json!({ "ref": ref_of("button \"Counter\"") })).expect("click");
    assert!(clicked["done"].as_str().unwrap().starts_with("Clicked e"));
    let typed = run("browser_type", json!({ "ref": ref_of("textbox \"Email\""), "text": "me@example.com" })).expect("type");
    assert_eq!(typed["new_console_problems"], 0);
    assert_eq!(run("browser_type", json!({ "ref": ref_of("textbox \"Password\""), "text": "hunter2" })).unwrap_err().code, "SENSITIVE_FIELD");
    let broke = run("browser_click", json!({ "ref": ref_of("button \"Break it\"") })).expect("break");
    std::thread::sleep(Duration::from_millis(800));
    let console = run("browser_console", json!({})).expect("console");
    println!("--- browser_console
{console}");
    let seen = console["entries"].as_str().unwrap();
    assert!(seen.contains("boom from the page") && seen.contains("late crash") && seen.contains("404"), "{seen}");
    let _ = broke;

    // The bar is up while the agent drives (its look is shown by the harness scenarios; a hidden window cannot be
    // photographed by DevTools). The person clicks a moment after the agent's last step.
    let cdp = WindowCdp::new(window.clone());
    std::thread::sleep(Duration::from_millis(1200));
    // The person clicks in the page: the agent is paused, every tool says so, and nothing reaches the page.
    let mouse = |kind: &str, x: f64, y: f64| cdp.call("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 })).unwrap();
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        mouse(kind, 300.0, 300.0);
    }
    let paused = live_wait(|| run("browser_read", json!({})).err().map(|e| e.code) == Some("PAUSED_BY_PERSON"));
    if !paused {
        let dump = cdp.call("Runtime.evaluate", json!({ "expression": "Object.getOwnPropertyNames(window).filter(function(n){return n.indexOf('__pm_')===0}).map(function(n){var o=window[n];return n+':'+Object.keys(o).join(',')}).join(' | ')", "returnByValue": true })).unwrap();
        eprintln!("page side: {}", dump["result"]["value"]);
    }
    assert!(paused, "a click by the person must pause the agent");
    for tool in ["browser_click", "browser_console", "browser_open"] {
        let args = if tool == "browser_open" { json!({ "url": format!("http://127.0.0.1:{port}/form") }) } else { json!({ "ref": "e1" }) };
        assert_eq!(run(tool, args).unwrap_err().code, "PAUSED_BY_PERSON", "{tool}");
    }
    // The person presses Give back (the last button on the bar).
    let width = cdp.call("Runtime.evaluate", json!({ "expression": "innerWidth", "returnByValue": true })).unwrap()["result"]["value"].as_f64().unwrap();
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        mouse(kind, width - 30.0, 15.0);
    }
    assert!(live_wait(|| run("browser_read", json!({})).is_ok()), "Give back must let the agent go on");
    let _ = window.destroy();
    println!("product flow ok");
}

fn live_wait(mut check: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(8) {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}
