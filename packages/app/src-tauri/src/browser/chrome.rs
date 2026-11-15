//! The browser bar (B): back, forward, reload and an address box on top of the agent browser's window, so the
//! person can browse in it too. This file is the words, the script, what Rust tells the bar and what the bar tells
//! Rust (the same way the agent bar does it, `bar.rs`), and the reading of what the person typed.

use super::guard;
use serde::Deserialize;
use serde_json::{json, Value};

const CHROME_JS: &str = include_str!("chrome_bar.js");

/// The bar's height in CSS pixels. The agent bar sits right under it.
pub const HEIGHT: u32 = 36;

pub fn strings() -> Value {
    json!({
        "en": {
            "back": "Back",
            "forward": "Forward",
            "reload": "Reload",
            "address": "Web address",
            "placeholder": "Type a web address",
            "errBad": "That is not a web address.",
            "errPrivate": "Pages on a private network are not opened.",
            "errNotFound": "That address could not be found.",
            "errOwn": "That page belongs to Potato Workspace.",
            "side": "Back to side pane",
            "mark": "Mark up",
        },
        "zh-TW": {
            "back": "上一頁",
            "forward": "下一頁",
            "reload": "重新整理",
            "address": "網址",
            "placeholder": "輸入網址",
            "errBad": "這不是網址。",
            "errPrivate": "不會開啟私人網路上的頁面。",
            "errNotFound": "找不到這個網址。",
            "errOwn": "這個頁面屬於 Potato Workspace。",
            "side": "回到側邊窗格",
            "mark": "標記",
        },
    })
}

/// The bar's script for one window. `key` is the hidden property name, put in as a JSON string.
pub fn script(key: &str) -> String {
    let json = |v: &Value| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    CHROME_JS.replace("__PM_CHROME_KEY__", &json(&Value::String(key.to_string()))).replace("__PM_CHROME_STR__", &json(&strings()))
}

/// A call into the bar's frozen API, safe when the bar is absent.
pub fn call(key: &str, method: &str, args: &str) -> String {
    super::bar::call(key, method, args)
}

/// The script that tells the bar the page's address (and an error word to show, or none). The address of an artifact
/// tab is never shown (it holds a secret token): the bar shows a chip such as `Artifact · Pricing page · v3`.
pub fn set_script(key: &str, url: &str, error: &str) -> String {
    set_script_with(key, url, error, false)
}

/// `set_script`, and whether the "Mark up" button shows (the Labs switch is on).
pub fn set_script_with(key: &str, url: &str, error: &str, mark: bool) -> String {
    set_script_full(key, url, error, mark, false)
}

/// `set_script_with`, and whether the page is the app's own start page (the address box is then focused for typing).
pub fn set_script_full(key: &str, url: &str, error: &str, mark: bool, start: bool) -> String {
    let view = match crate::artifacts::chip_of(url) {
        Some(chip) => json!({ "url": chip, "error": error, "side": true, "mark": mark, "start": false }),
        None => json!({ "url": url, "error": error, "mark": mark, "start": start }),
    }
    .to_string();
    call(key, "set", &serde_json::to_string(&view).unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChromeEvent {
    pub kind: ChromeKind,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChromeKind {
    Back,
    Forward,
    Reload,
    Go,
    /// "Back to side pane" (an artifact tab only).
    Side,
    /// "Mark up" (the Labs switch is on): opens the mark-up bar.
    Mark,
}

pub fn parse_events(raw: &str) -> Vec<ChromeEvent> {
    serde_json::from_str::<Vec<ChromeEvent>>(raw).unwrap_or_default().into_iter().take(20).collect()
}

/// What the person typed, as an address: `example.com` is `https://example.com`, `localhost:5173` is
/// `http://localhost:5173`, a full address stays as it is. None for words that are not an address.
pub fn address_from_typed(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    if t.contains("://") {
        return Some(t.to_string());
    }
    // Other schemes (`javascript:x`, `data:...`) have a colon but no slashes: they are not an address, and the guard
    // would refuse them anyway. A `host:port` is told apart by the port being digits.
    let host = t.split(['/', '?', '#']).next().unwrap_or("");
    let looks_local = ["localhost", "127.0.0.1", "[::1]"].iter().any(|h| host == *h || host.starts_with(&format!("{h}:")));
    if looks_local {
        return Some(format!("http://{t}"));
    }
    let (name, port) = host.rsplit_once(':').map_or((host, None), |(n, p)| (n, Some(p)));
    if port.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    if name.contains('.') || name.starts_with('[') {
        return Some(format!("https://{t}"));
    }
    None
}

/// The bar's error word for a refusal code of the guard.
pub fn error_word(code: &str) -> &'static str {
    match code {
        "SITE_NOT_ALLOWED" => "errPrivate",
        "PAGE_NOT_REACHED" => "errNotFound",
        "PORT_NOT_ALLOWED" => "errOwn",
        _ => "errBad",
    }
}

/// What to do with what the person typed: the address to go to, or the error word to show.
pub fn go_target(typed: &str, dev_url_port: Option<u16>) -> Result<String, &'static str> {
    let address = address_from_typed(typed).ok_or("errBad")?;
    guard::check_url(&address, dev_url_port).map(|(url, _)| url).map_err(|(code, _)| error_word(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_gets_its_key_and_words_as_json_and_no_placeholder_is_left() {
        let js = script("__pm_0123456789abcdef");
        assert!(!js.contains("__PM_CHROME_KEY__") && !js.contains("__PM_CHROME_STR__"));
        assert!(js.contains("var KEY = \"__pm_0123456789abcdef\";"));
        assert!(js.contains("Type a web address") && js.contains("\u{8f38}\u{5165}\u{7db2}\u{5740}"));
    }

    #[test]
    fn a_key_with_a_quote_cannot_break_out_of_the_script() {
        assert!(script("a\";alert(1);\"").contains(r#"var KEY = "a\";alert(1);\"";"#));
    }

    #[test]
    fn both_languages_have_the_same_words_and_the_bar_writes_page_words_as_text_only() {
        let all = strings();
        let keys = |lang: &str| {
            let mut k: Vec<String> = all[lang].as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys("en"), keys("zh-TW"));
        assert!(!CHROME_JS.contains("innerHTML") && !CHROME_JS.contains("insertAdjacentHTML") && !CHROME_JS.contains("eval("));
        assert!(CHROME_JS.contains("setAttribute('aria-hidden', 'true')") && CHROME_JS.contains("mode: 'closed'"));
        assert!(CHROME_JS.contains("e.isTrusted"));
    }

    #[test]
    fn typed_text_becomes_an_address_or_nothing() {
        assert_eq!(address_from_typed("example.com").as_deref(), Some("https://example.com"));
        assert_eq!(address_from_typed(" docs.rs/std?q=1 ").as_deref(), Some("https://docs.rs/std?q=1"));
        assert_eq!(address_from_typed("localhost:5173").as_deref(), Some("http://localhost:5173"));
        assert_eq!(address_from_typed("127.0.0.1:3000/app").as_deref(), Some("http://127.0.0.1:3000/app"));
        assert_eq!(address_from_typed("http://example.com").as_deref(), Some("http://example.com"));
        assert_eq!(address_from_typed("example.com:8080").as_deref(), Some("https://example.com:8080"));
        for bad in ["", "   ", "hello", "two words.com", "javascript:alert(1)", "data:text/html,x", "file:c:/x", "exa:mple.com", "x\u{0}.com"] {
            assert_eq!(address_from_typed(bad), None, "{bad}");
        }
        // A typed scheme is not rewritten, so the guard sees exactly what was typed.
        assert_eq!(address_from_typed("file:///c:/x").as_deref(), Some("file:///c:/x"));
    }

    #[test]
    fn what_the_person_types_goes_through_the_same_guard_as_an_agent() {
        assert_eq!(go_target("localhost:5173", None).as_deref(), Ok("http://localhost:5173"));
        assert_eq!(go_target("file:///c:/x", None), Err("errBad"));
        assert_eq!(go_target("192.168.1.1", None), Err("errPrivate"));
        assert_eq!(go_target("http://192.168.1.1/", None), Err("errPrivate"));
        assert_eq!(go_target("http://169.254.169.254/", None), Err("errPrivate"));
        assert_eq!(go_target("localhost:9333", None), Err("errOwn"));
        assert_eq!(go_target("hello", None), Err("errBad"));
    }

    #[test]
    fn events_come_back_as_a_list_and_garbage_is_nothing() {
        let got = parse_events(r#"[{"kind":"back"},{"kind":"forward"},{"kind":"reload"},{"kind":"go","url":"example.com"}]"#);
        assert_eq!(got.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![ChromeKind::Back, ChromeKind::Forward, ChromeKind::Reload, ChromeKind::Go]);
        assert_eq!(got[3].url, "example.com");
        assert_eq!(parse_events(r#"[{"kind":"side"}]"#)[0].kind, ChromeKind::Side);
        assert!(parse_events("nope").is_empty() && parse_events(r#"[{"kind":"launch"}]"#).is_empty());
    }

    #[test]
    fn the_start_page_flag_reaches_the_bar_so_the_box_takes_the_focus() {
        let on = set_script_full("k", "", "", false, true);
        assert!(on.contains("\\\"start\\\":true"), "{on}");
        assert!(set_script_with("k", "https://example.com/", "", false).contains("\\\"start\\\":false"));
        // The bar's script asks for the focus on the start page and draws the refusal word as text only.
        assert!(CHROME_JS.contains("view.start") && CHROME_JS.contains("ui.input.focus()"));
    }

    #[test]
    fn a_refused_typed_address_gets_the_word_the_start_page_explains() {
        // The word the window navigates to the start page with is one the page knows, for every refusal.
        for typed in ["hello", "192.168.1.1", "localhost:9333"] {
            let word = go_target(typed, None).unwrap_err();
            assert!(super::super::start::is_start_address(&super::super::start::address(Some(word))), "{typed}");
        }
    }

    #[test]
    fn the_address_is_sent_to_the_bar_as_one_json_string() {
        let js = set_script("k", "https://example.com/?a=\"b\"", "");
        assert!(js.contains("a.set(\"") && js.contains("example.com"), "{js}");
    }
}

#[cfg(test)]
mod artifact_chip_tests {
    use super::*;

    #[test]
    fn an_artifact_tab_shows_a_chip_and_never_its_address() {
        let p = std::env::temp_dir().join(format!("pm-chrome-chip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        crate::artifacts::add_version_for_tests(&p, "pricing", "Pricing page", crate::artifacts::ArtifactKind::Html, "<h1>x</h1>");
        let address = crate::artifacts::open_tab_address(p, "pricing", "pane-1").unwrap();
        let js = set_script("k", &address, "");
        assert!(js.contains("Artifact") && js.contains("Pricing page") && js.contains("read-only") && js.contains("side"), "{js}");
        let token = address.trim_end_matches('/').rsplit('/').next().unwrap().to_string();
        assert!(!js.contains(&token), "the token must not reach the bar");
        // Any other address is shown as it is, with no side button.
        let plain = set_script("k", "http://localhost:5173/", "");
        assert!(plain.contains("localhost:5173") && !plain.contains("side"));
    }
}
