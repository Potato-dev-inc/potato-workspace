use super::*;

#[test]
fn the_script_gets_its_key_spec_and_words_and_no_placeholder_is_left() {
    let js = script("__pm_0123456789abcdef", 36);
    for left in ["__PM_MARKUP_KEY__", "__PM_MARKUP_SPEC__", "__PM_MARKUP_STR__", "__PM_MARKUP_TOP__"] {
        assert!(!js.contains(left), "{left}");
    }
    assert!(js.contains("var KEY = \"__pm_0123456789abcdef\";"));
    assert!(js.contains("var TOP = 36;"));
    assert!(js.contains("Send to chat") && js.contains("\u{50b3}\u{5230}\u{804a}\u{5929}"));
}

#[test]
fn a_key_with_a_quote_cannot_break_out_of_the_script() {
    assert!(script("a\";alert(1);\"", 36).contains(r#"var KEY = "a\";alert(1);\"";"#));
}

#[test]
fn both_languages_have_the_same_words() {
    let all = strings();
    let keys = |lang: &str| {
        let mut k: Vec<String> = all[lang].as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(keys("en"), keys("zh-TW"));
}

#[test]
fn the_bar_writes_page_words_as_text_only_and_keeps_to_the_top_document_in_a_closed_root() {
    let js = BAR_JS;
    assert!(!js.contains("innerHTML") && !js.contains("insertAdjacentHTML") && !js.contains("eval(") && !js.contains("document.write"));
    assert!(js.contains("mode: 'closed'") && js.contains("window.top !== window.self"));
    // It never reaches out: no network, no storage, no navigation, no app calls.
    for bad in ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "indexedDB", "WebSocket", "sendBeacon", "__TAURI", "window.open", "postMessage"] {
        assert!(!js.contains(bad), "{bad}");
    }
    // Clicks on its own buttons only count when they are the person's.
    assert!(js.contains("e.isTrusted"));
    // Built-ins are taken before page scripts can change them.
    assert!(js.contains("Document.prototype.createElement") && js.contains("Document.prototype.elementFromPoint"));
}

#[test]
fn the_shared_spec_is_the_one_the_app_bar_reads_and_has_what_the_injected_bar_needs() {
    let spec: Value = serde_json::from_str(SPEC_JSON).unwrap();
    for id in ["select", "pen", "rect", "arrow", "ellipse", "text", "undo", "clear", "close", "more", "send", "caret"] {
        assert!(spec["icons"][id].is_string(), "{id}");
    }
    assert_eq!(spec["colors"][0]["id"], "orange");
    assert_eq!(spec["blob"]["ms"], 160);
    assert!(spec["blob"]["curve"].as_str().unwrap().starts_with("cubic-bezier("));
    // Every colour and shape name the bar looks up in its words exists there.
    let words = strings();
    for lang in ["en", "zh-TW"] {
        for c in spec["colors"].as_array().unwrap() {
            assert!(words[lang][c["id"].as_str().unwrap()].is_string(), "{lang} {c}");
        }
        for s in spec["shapes"].as_array().unwrap() {
            assert!(words[lang][s["id"].as_str().unwrap()].is_string(), "{lang} {s}");
        }
    }
}

#[test]
fn events_come_back_as_a_list_a_bad_one_does_not_drop_the_good_ones_and_garbage_is_nothing() {
    let raw = r#"[{"kind":"open"},{"kind":"launch"},{"kind":"prepare","marks":[{"type":"rect","near":{"tag":"div","selector":"div.a","text":"x","attrs":[]}}],"area":{"x":0,"y":0,"w":100,"h":80},"vw":100},{"kind":"send","request":"fix it","marks":[],"to":"pane-1"},{"kind":"close"}]"#;
    let got = parse_events(raw);
    assert_eq!(got.len(), 4);
    assert!(matches!(got[0], Event::Open) && matches!(got[3], Event::Close));
    assert!(matches!(&got[2], Event::Send { request, to, fix, .. } if request == "fix it" && to == "pane-1" && !*fix));
    assert!(parse_events("nope").is_empty() && parse_events("{}").is_empty());
}

#[test]
fn the_marks_are_cleaned_kinds_from_a_list_tags_plain_and_at_most_forty() {
    let wire = |kind: &str, tag: &str| WireMark { kind: kind.into(), near: Some(WireNear { tag: tag.into(), selector: "div > a".into(), text: "t".into(), attrs: vec![] }), text: None };
    let marks = clean_marks(&[wire("rect", "DIV"), wire("launch", "div"), wire("pick", "<script>"), wire("arrow", "a")]);
    assert_eq!(marks.len(), 3);
    assert_eq!(marks[0].near.as_ref().unwrap().tag, "div");
    // "<script>" keeps only plain letters, so it cannot carry markup.
    assert_eq!(marks[1].near.as_ref().unwrap().tag, "script");
    let many: Vec<WireMark> = (0..80).map(|_| wire("rect", "div")).collect();
    assert_eq!(clean_marks(&many).len(), 40);
}

#[test]
fn the_state_pushed_to_the_bar_is_one_json_string() {
    let js = set_script("k", &json!({ "theme": "dark", "status": "a\"b" }));
    assert!(js.contains(".set(\"") && js.contains("theme"), "{js}");
}

#[test]
fn the_picture_is_drawn_from_bytes_not_loaded_by_address() {
    // A page's img-src rule blocks `<img src="data:...">`; the bar keeps the picture in a canvas it paints itself.
    let js = BAR_JS;
    assert!(!js.contains("el('img')") && !js.contains("createElement('img')") && !js.contains("setAttribute('src'"));
    assert!(js.contains("createImageBitmap") && js.contains("el('canvas')"));
    // Looks are set through the style object (allowed under style-src), never as markup or a style element.
    assert!(!js.contains("<style") && !js.contains("createElement('style')") && !js.contains("el('style')") && !js.contains("setAttribute('style'"));
}

/// A loopback page that sets `Content-Security-Policy: default-src 'none'`.
fn strict_page() -> (std::net::SocketAddr, std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            let mut stream = stream;
            let mut buf = [0_u8; 2048];
            let _ = stream.read(&mut buf);
            let body = "<!doctype html><title>strict</title><body style=\"margin:0\"><p>strict page</p></body>";
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
        }
    });
    (addr, stop)
}

fn find_chromium() -> Option<std::path::PathBuf> {
    let mut candidates = vec![
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    candidates.retain(|p| std::path::Path::new(p).is_file());
    candidates.first().map(std::path::PathBuf::from)
}

#[test]
fn the_picture_shows_on_a_page_that_forbids_everything_with_content_security_policy() {
    use std::sync::atomic::Ordering;
    let Some(browser) = find_chromium() else {
        eprintln!("skipped: no Chrome or Edge on this computer");
        return;
    };
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    if crate::proc_util::hidden_command(node).arg("--version").output().is_err() {
        eprintln!("skipped: no node on this computer");
        return;
    }
    let dir = std::env::temp_dir().join(format!("pm-markup-csp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = "__pm_0123456789abcdef";
    let bar = dir.join("bar.js");
    std::fs::write(&bar, script(key, 0)).unwrap();
    let checker = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/markup/csp_check.mjs");
    let (addr, stop) = strict_page();
    // Headless: no window opens.
    let out = crate::proc_util::hidden_command(node)
        .arg(&checker)
        .arg(&browser)
        .arg(&bar)
        .arg(format!("http://127.0.0.1:{}/", addr.port()))
        .arg(key)
        .output()
        .expect("run the check");
    stop.store(true, Ordering::SeqCst);
    let _ = std::net::TcpStream::connect(addr);
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(said.starts_with("OK "), "{said} {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn the_send_choice_defaults_to_asking_and_the_bar_has_both_words() {
    let ask = parse_events(r#"[{"kind":"send","request":"x","marks":[]}]"#);
    assert!(matches!(&ask[0], Event::Send { fix, .. } if !*fix));
    let fix = parse_events(r#"[{"kind":"send","request":"x","marks":[],"fix":true}]"#);
    assert!(matches!(&fix[0], Event::Send { fix, .. } if *fix));
    let words = strings();
    for lang in ["en", "zh-TW"] {
        for k in ["askAbout", "fixIt", "intent"] {
            assert!(words[lang][k].is_string(), "{lang} {k}");
        }
    }
    assert!(BAR_JS.contains("fix: st.fix"));
    // One Tab stop for the pair, arrow keys move it, and the choice is hidden on a page the agent made itself.
    assert!(BAR_JS.contains("ArrowRight") && BAR_JS.contains("'tabindex'") && BAR_JS.contains("st.own ? 'none'"));
}
