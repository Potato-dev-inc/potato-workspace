//! The mark-up bar in the agent browser's window: the script that draws it, its words (English and Traditional
//! Chinese), what Rust tells it and what it tells Rust. The same pattern as the agent bar (`browser::bar`): the page
//! cannot call Potato Workspace; Rust pushes state in (`window.eval`) and pulls the person's actions out (`take`).
//!
//! Icons, sizes, keys, colours and the outline's spring come from `lib/markup/markup-spec.json`, the file the app's own
//! bar reads too (a test fails if the two drift).

use crate::point::message_marks::{MarkIn, MarkKind, Near};
use serde::Deserialize;
use serde_json::{json, Value};

const BAR_JS: &str = include_str!("bar.js");
/// The shared spec (one file, read by the app's bar and by this one).
/// The brand marks of the agents (path, dark and light colour), one file made from the app's logo table.
pub const LOGOS_JSON: &str = include_str!("../../../src/lib/markup/agent-logos.json");
pub const SPEC_JSON: &str = include_str!("../../../src/lib/markup/markup-spec.json");

pub fn strings() -> Value {
    json!({
        "en": {
            "bar": "Mark up",
            "select": "Select an element",
            "pen": "Pen",
            "shape": "Shape",
            "moreShapes": "More shapes",
            "text": "Text note",
            "colour": "Colour",
            "undo": "Undo",
            "clear": "Clear all",
            "more": "More",
            "close": "Close",
            "send": "Send",
            "sendToChat": "Send to chat",
            "sendCount": "Send to chat \u{b7} {n}",
            "rect": "Rectangle",
            "arrow": "Arrow",
            "ellipse": "Ellipse",
            "orange": "Orange",
            "red": "Red",
            "blue": "Blue",
            "black": "Black",
            "cleared": "Cleared",
            "held": "Send or clear to scroll",
            "resized": "The page changed size, so the marks were cleared.",
            "frame": "embedded frame \u{b7} draw on it instead",
            "notePlaceholder": "Type a note, press Enter",
            "noteLabel": "Text note",
            "request": "What should change?",
            "requestNeeded": "Write what should change, or add a text note.",
            "count1": "1 mark",
            "countN": "{n} marks",
            "element1": "1 element",
            "elementsN": "{n} elements",
            "to": "To",
            "toPick": "Choose an agent",
            "thisPage": "made this page",
            "working": "Working",
            "waiting": "Waiting for you",
            "idle": "Idle",
            "stopped": "Stopped",
            "newAgent": "New agent",
            "noAgents": "No agent is running.",
            "startAgent": "Start an agent",
            "toOwner": "This picture goes to {agent}",
            "askAbout": "Ask about it",
            "fixIt": "Fix it in this project",
            "intent": "What to do with this page",
            "sent": "Sent to the chat.",
            "shotOf": "Picture of the page with your marks",
            "taking": "Taking the picture\u{2026}",
            "noPicture": "The picture could not be taken. Your marks will go as words.",
        },
        "zh-TW": {
            "bar": "標記",
            "select": "選取元素",
            "pen": "畫筆",
            "shape": "形狀",
            "moreShapes": "更多形狀",
            "text": "文字註解",
            "colour": "顏色",
            "undo": "復原",
            "clear": "全部清除",
            "more": "更多",
            "close": "關閉",
            "send": "傳送",
            "sendToChat": "傳到聊天",
            "sendCount": "傳到聊天 \u{b7} {n}",
            "rect": "矩形",
            "arrow": "箭頭",
            "ellipse": "橢圓",
            "orange": "橘色",
            "red": "紅色",
            "blue": "藍色",
            "black": "黑色",
            "cleared": "已清除",
            "held": "傳送或清除後才能捲動",
            "resized": "頁面大小改變了，所以標記已清除。",
            "frame": "嵌入的框架 \u{b7} 請直接在上面畫",
            "notePlaceholder": "輸入註解，按 Enter",
            "noteLabel": "文字註解",
            "request": "要改什麼？",
            "requestNeeded": "請寫下要改什麼，或加一則文字註解。",
            "count1": "1 個標記",
            "countN": "{n} 個標記",
            "element1": "1 個元素",
            "elementsN": "{n} 個元素",
            "to": "傳給",
            "toPick": "選擇 AI 助理",
            "thisPage": "做了這個頁面",
            "working": "工作中",
            "waiting": "等你回應",
            "idle": "閒置",
            "stopped": "已停止",
            "newAgent": "新增 AI 助理",
            "noAgents": "目前沒有執行中的 AI 助理。",
            "startAgent": "啟動 AI 助理",
            "toOwner": "這張圖片會傳給 {agent}",
            "askAbout": "問問看",
            "fixIt": "在這個專案裡修改",
            "intent": "要怎麼處理這個頁面",
            "sent": "已傳到聊天。",
            "shotOf": "附有你的標記的頁面圖片",
            "taking": "正在拍下圖片\u{2026}",
            "noPicture": "無法拍下圖片。你的標記會以文字傳送。",
        },
    })
}

/// The bar's script for one window. `key` is the hidden property name, put in as a JSON string.
pub fn script(key: &str, top: u32) -> String {
    let json = |v: &Value| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    BAR_JS
        .replace("__PM_MARKUP_KEY__", &json(&Value::String(key.to_string())))
        .replace("__PM_MARKUP_SPEC__", SPEC_JSON)
        .replace("__PM_MARKUP_LOGOS__", LOGOS_JSON)
        .replace("__PM_MARKUP_STR__", &json(&strings()))
        .replace("__PM_MARKUP_TOP__", &top.to_string())
}

/// A call into the bar's frozen API, safe when the bar is absent.
pub fn call(key: &str, method: &str, args: &str) -> String {
    crate::browser::bar::call(key, method, args)
}

/// The script that pushes state into the bar (`set`): one JSON text, given to the bar as a string.
pub fn set_script(key: &str, view: &Value) -> String {
    let text = serde_json::to_string(&view.to_string()).unwrap_or_default();
    call(key, "set", &text)
}

// ---- what the bar tells Rust ----

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireNear {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub selector: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attrs: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireMark {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub near: Option<WireNear>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WireArea {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    Open,
    Close,
    /// "New agent" at the end of the send list.
    #[serde(rename = "newagent")]
    NewAgent,
    Prepare { marks: Vec<WireMark>, area: WireArea, vw: f64 },
    Send { request: String, marks: Vec<WireMark>, #[serde(default)] to: String, #[serde(default)] fix: bool },
}

/// At most 30 events, and nothing at all for text that is not the bar's own.
pub fn parse_events(raw: &str) -> Vec<Event> {
    // A bad event must not drop the good ones: each is read on its own.
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(raw) else { return Vec::new() };
    list.into_iter().take(30).filter_map(|v| serde_json::from_value::<Event>(v).ok()).collect()
}

const MAX_MARKS: usize = 40;

/// The marks as the message composer reads them: kinds from a fixed list, words cut to one short line each. Whatever the
/// page managed to put into the queue, only these shapes get through.
pub fn clean_marks(wire: &[WireMark]) -> Vec<MarkIn> {
    wire.iter()
        .take(MAX_MARKS)
        .filter_map(|m| {
            let kind = MarkKind::from_word(&m.kind)?;
            let near = m.near.as_ref().map(|n| Near {
                tag: n.tag.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(20).collect(),
                selector: n.selector.clone(),
                text: n.text.clone(),
            });
            Some(MarkIn { kind, near: near.filter(|n| !n.tag.is_empty()), text: m.text.clone(), reference: None })
        })
        .collect()
}

#[cfg(test)]
#[path = "bar_tests.rs"]
mod bar_tests;
