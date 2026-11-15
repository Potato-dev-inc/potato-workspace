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
    assert!(matches!(&got[2], Event::Send { request, to, .. } if request == "fix it" && to == "pane-1"));
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
