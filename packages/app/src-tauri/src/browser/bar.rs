//! The agent bar: the script that draws it, the words on it (English and Traditional Chinese), what Rust tells it,
//! and what it tells Rust (N5-23).
//!
//! The page cannot call Potato Workspace. Rust pushes the bar's state in (`window.eval`) and pulls the person's
//! clicks out (`take`), the same way Point and Fix pulls picks. The words live here, in one table, because the bar
//! is drawn inside a web page and the app's translation layer is not there. The bar follows the language of the
//! system (the web view's language), like the app's "auto" choice.

use super::driver::BarView;
use serde::Deserialize;
use serde_json::{json, Value};

const BAR_JS: &str = include_str!("agent_bar.js");

/// The words on the bar. `{agent}` and `{n}` are filled in by the page. Plain, short, no jargon.
pub fn strings() -> Value {
    json!({
        "en": {
            "using": "{agent} is using this page",
            "agent": "An agent",
            "paused": "You took over. The agent waits.",
            "stopped": "Stopped. The agent will not use this page.",
            "takeOver": "Take over",
            "stop": "Stop",
            "giveBack": "Give back",
            "point": "Point",
            "steps": "Steps ({n})",
        },
        "zh-TW": {
            "using": "{agent} 正在使用這個頁面",
            "agent": "代理程式",
            "paused": "你接手了，代理程式在等待。",
            "stopped": "已停止，代理程式不會再使用這個頁面。",
            "takeOver": "我來接手",
            "stop": "停止",
            "giveBack": "交還",
            "point": "指一下",
            "steps": "步驟 ({n})",
        },
    })
}

/// The bar's script for one window. `key` is the hidden property name, put in as a JSON string.
pub fn script(key: &str) -> String {
    let json = |v: &Value| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    BAR_JS.replace("__PM_BAR_KEY__", &json(&Value::String(key.to_string()))).replace("__PM_BAR_STR__", &json(&strings()))
}

/// A call into the bar's frozen API, safe when the bar is absent (another page).
pub fn call(key: &str, method: &str, args: &str) -> String {
    let key = serde_json::to_string(key).unwrap_or_default();
    format!("(function(){{try{{var a=window[{key}];return a&&a.{method}?a.{method}({args}):null}}catch(e){{return null}}}})()")
}

/// The script that shows `view` (or hides the bar when it is not visible).
pub fn show_script(key: &str, view: &BarView) -> String {
    if !view.visible {
        return call(key, "hide", "");
    }
    let text = serde_json::to_string(view).unwrap_or_default();
    call(key, "show", &serde_json::to_string(&text).unwrap_or_default())
}

/// What the person did on the bar or on the page. `at` is the page's clock (ms since the epoch).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BarEvent {
    pub kind: BarKind,
    pub at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BarKind {
    Takeover,
    Stop,
    Giveback,
    /// "Point" on the bar: arm Point and Fix in this page (the same window, the same picker).
    Point,
    /// A click or key press in the page (the driver decides whether it was the agent's own).
    Input,
}

/// The events of one `take` answer (a JSON array in a JSON string). Anything else is nothing.
pub fn parse_events(raw: &str) -> Vec<BarEvent> {
    serde_json::from_str::<Vec<BarEvent>>(raw).unwrap_or_default().into_iter().take(50).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::driver::BarView;

    #[test]
    fn the_script_gets_its_key_and_words_as_json_and_no_placeholder_is_left() {
        let js = script("__pm_0123456789abcdef");
        assert!(!js.contains("__PM_BAR_KEY__") && !js.contains("__PM_BAR_STR__"));
        assert!(js.contains("var KEY = \"__pm_0123456789abcdef\";"));
        assert!(js.contains("\"Take over\"") && js.contains("\u{6211}\u{4f86}\u{63a5}\u{624b}"));
    }

    #[test]
    fn a_key_with_a_quote_cannot_break_out_of_the_script() {
        let js = script("a\";alert(1);\"");
        assert!(js.contains(r#"var KEY = "a\";alert(1);\"";"#));
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
        for lang in ["en", "zh-TW"] {
            for (key, value) in all[lang].as_object().unwrap() {
                assert!(!value.as_str().unwrap().trim().is_empty(), "{lang}.{key}");
            }
        }
        // The page fills these in, so both languages must keep them.
        assert!(all["zh-TW"]["using"].as_str().unwrap().contains("{agent}"));
        assert!(all["zh-TW"]["steps"].as_str().unwrap().contains("{n}"));
    }

    #[test]
    fn the_script_only_writes_page_words_as_text_never_as_html() {
        assert!(!BAR_JS.contains("innerHTML") && !BAR_JS.contains("insertAdjacentHTML") && !BAR_JS.contains("eval("));
    }

    #[test]
    fn the_bar_is_hidden_from_the_page_read_so_an_agent_never_sees_its_buttons() {
        assert!(BAR_JS.contains("setAttribute('aria-hidden', 'true')"));
    }

    #[test]
    fn calls_are_guarded_so_a_page_without_the_bar_answers_null() {
        let js = call("__pm_ab", "hide", "");
        assert!(js.contains("window[\"__pm_ab\"]") && js.contains("catch(e){return null}"));
    }

    #[test]
    fn a_hidden_view_hides_the_bar_and_a_visible_one_is_sent_as_one_json_string() {
        let hidden = BarView::hidden();
        assert!(show_script("k", &hidden).contains("a.hide()"));
        let view = BarView { visible: true, state: "driving".into(), reason: String::new(), agent: "Claude \"Code\"".into(), steps: vec![] };
        let js = show_script("k", &view);
        assert!(js.contains("a.show(\""), "{js}");
        assert!(js.contains("Claude \\\\\\\"Code\\\\\\\"") || js.contains("Claude"), "{js}");
    }

    #[test]
    fn events_come_back_as_a_list_and_garbage_is_nothing() {
        let got = parse_events(r#"[{"kind":"stop","at":5},{"kind":"input","at":9},{"kind":"giveback","at":10},{"kind":"takeover","at":11},{"kind":"point","at":12}]"#);
        assert_eq!(got.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![BarKind::Stop, BarKind::Input, BarKind::Giveback, BarKind::Takeover, BarKind::Point]);
        assert!(parse_events("not json").is_empty());
        assert!(parse_events(r#"[{"kind":"launch","at":1}]"#).is_empty());
        assert!(parse_events("null").is_empty());
    }
}
