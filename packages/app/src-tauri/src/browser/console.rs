//! What the page complained about: console errors, crashes and failed requests (N5-23).
//!
//! This is what a coding agent wants most from a browser: "what broke on that page". The log is filled from
//! DevTools events (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.*`) and
//! keeps the newest entries. Pure: tests feed it events as JSON.

use serde_json::Value;
use std::collections::{HashMap, VecDeque};

/// Entries kept, and the longest text of one.
pub const KEEP: usize = 200;
const MAX_TEXT: usize = 600;
/// Requests remembered to name a failed one.
const KEEP_REQUESTS: usize = 400;

/// The DevTools events this log listens to.
pub const EVENTS: &[&str] = &[
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Log.entryAdded",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFailed",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `console.error` or a failed assertion.
    Error,
    /// `console.warn`.
    Warning,
    /// `console.log`, `info`, `debug`.
    Log,
    /// An error nobody caught.
    Crash,
    /// A request that failed or answered 400 or more.
    Request,
}

impl Kind {
    pub fn word(self) -> &'static str {
        match self {
            Kind::Error => "error",
            Kind::Warning => "warning",
            Kind::Log => "log",
            Kind::Crash => "crash",
            Kind::Request => "request",
        }
    }

    /// Part of "errors only" (the default of `browser_console`).
    fn is_problem(self) -> bool {
        matches!(self, Kind::Error | Kind::Crash | Kind::Request)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub seq: u64,
    pub kind: Kind,
    pub text: String,
    pub url: Option<String>,
}

#[derive(Default)]
pub struct ConsoleLog {
    entries: VecDeque<Entry>,
    next_seq: u64,
    requests: HashMap<String, String>,
    request_order: VecDeque<String>,
}

fn cut(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= MAX_TEXT {
        return one;
    }
    format!("{}\u{2026}", one.chars().take(MAX_TEXT - 1).collect::<String>())
}

/// One remote object of a console call, as text.
fn arg_text(arg: &Value) -> String {
    if let Some(value) = arg.get("value") {
        return match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }
    arg.get("description").and_then(Value::as_str).or_else(|| arg.get("unserializableValue").and_then(Value::as_str)).unwrap_or("").to_string()
}

impl ConsoleLog {
    pub fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, kind: Kind, text: String, url: Option<String>) {
        let text = cut(&text);
        if text.is_empty() {
            return;
        }
        // The same line twice in a row is one entry (a render loop can print thousands).
        if self.entries.back().map(|e| e.kind == kind && e.text == text && e.url == url).unwrap_or(false) {
            return;
        }
        self.next_seq += 1;
        self.entries.push_back(Entry { seq: self.next_seq, kind, text, url });
        while self.entries.len() > KEEP {
            self.entries.pop_front();
        }
    }

    /// Takes in one DevTools event.
    pub fn ingest(&mut self, method: &str, params: &Value) {
        match method {
            "Runtime.consoleAPICalled" => {
                let kind = match params.get("type").and_then(Value::as_str).unwrap_or("log") {
                    "error" | "assert" => Kind::Error,
                    "warning" => Kind::Warning,
                    _ => Kind::Log,
                };
                let text = params.get("args").and_then(Value::as_array).map(|a| a.iter().map(arg_text).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                self.push(kind, text, None);
            }
            "Runtime.exceptionThrown" => {
                let details = params.get("exceptionDetails").cloned().unwrap_or(Value::Null);
                let text = details
                    .get("exception")
                    .and_then(|e| e.get("description"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| details.get("text").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default();
                let url = details.get("url").and_then(Value::as_str).map(|u| match details.get("lineNumber").and_then(Value::as_i64) {
                    Some(line) => format!("{u}:{}", line + 1),
                    None => u.to_string(),
                });
                self.push(Kind::Crash, text, url);
            }
            "Log.entryAdded" => {
                let entry = params.get("entry").cloned().unwrap_or(Value::Null);
                let kind = match entry.get("level").and_then(Value::as_str).unwrap_or("info") {
                    "error" => Kind::Error,
                    "warning" => Kind::Warning,
                    _ => Kind::Log,
                };
                // "Failed to load resource" lines are also reported as requests below; keep this one only for others.
                let text = entry.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                if text.starts_with("Failed to load resource") {
                    return;
                }
                self.push(kind, text, entry.get("url").and_then(Value::as_str).map(str::to_string));
            }
            "Network.requestWillBeSent" => {
                if let (Some(id), Some(url)) = (params.get("requestId").and_then(Value::as_str), params.get("request").and_then(|r| r.get("url")).and_then(Value::as_str)) {
                    if self.requests.insert(id.to_string(), url.to_string()).is_none() {
                        self.request_order.push_back(id.to_string());
                    }
                    while self.request_order.len() > KEEP_REQUESTS {
                        if let Some(old) = self.request_order.pop_front() {
                            self.requests.remove(&old);
                        }
                    }
                }
            }
            "Network.responseReceived" => {
                let response = params.get("response").cloned().unwrap_or(Value::Null);
                let status = response.get("status").and_then(Value::as_i64).unwrap_or(0);
                if status >= 400 {
                    let url = response.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                    self.push(Kind::Request, format!("{status} {}", response.get("statusText").and_then(Value::as_str).unwrap_or("")).trim().to_string(), Some(url));
                }
            }
            "Network.loadingFailed" => {
                if params.get("canceled").and_then(Value::as_bool).unwrap_or(false) {
                    return;
                }
                let url = params.get("requestId").and_then(Value::as_str).and_then(|id| self.requests.get(id)).cloned();
                let why = params.get("errorText").and_then(Value::as_str).unwrap_or("failed");
                self.push(Kind::Request, format!("request failed: {why}"), url);
            }
            _ => {}
        }
    }

    /// The newest entry number (0 when nothing was logged yet).
    pub fn last_seq(&self) -> u64 {
        self.next_seq
    }

    /// How many problems (errors, crashes, failed requests) came after `seq`.
    pub fn problems_since(&self, seq: u64) -> usize {
        self.entries.iter().filter(|e| e.seq > seq && e.kind.is_problem()).count()
    }

    /// The entries after `since`, oldest first. `all` also gives warnings and plain logs.
    pub fn read(&self, all: bool, since: u64, limit: usize) -> Vec<Entry> {
        let mut out: Vec<Entry> = self.entries.iter().filter(|e| e.seq > since && (all || e.kind.is_problem())).cloned().collect();
        let extra = out.len().saturating_sub(limit);
        out.drain(..extra);
        out
    }

    /// Forgets everything (the page was opened again).
    pub fn clear(&mut self) {
        let next = self.next_seq;
        *self = ConsoleLog::default();
        self.next_seq = next;
    }
}

/// The text of a read, for the agent. `entries` are page words: the caller wraps them as untrusted.
pub fn render(entries: &[Entry]) -> String {
    if entries.is_empty() {
        return "(nothing)".to_string();
    }
    entries
        .iter()
        .map(|e| match &e.url {
            Some(url) => format!("#{} {} {} ({url})", e.seq, e.kind.word(), e.text),
            None => format!("#{} {} {}", e.seq, e.kind.word(), e.text),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn console(kind: &str, args: Value) -> (String, Value) {
        ("Runtime.consoleAPICalled".to_string(), json!({ "type": kind, "args": args }))
    }

    #[test]
    fn errors_and_crashes_are_kept_and_plain_logs_are_not_problems() {
        let mut log = ConsoleLog::new();
        for (m, p) in [
            console("log", json!([{ "type": "string", "value": "hello" }])),
            console("error", json!([{ "type": "string", "value": "Cannot read" }, { "type": "string", "value": "x" }])),
            console("warning", json!([{ "type": "string", "value": "careful" }])),
        ] {
            log.ingest(&m, &p);
        }
        log.ingest("Runtime.exceptionThrown", &json!({ "exceptionDetails": { "text": "Uncaught", "url": "http://localhost:5173/src/App.tsx", "lineNumber": 41, "exception": { "description": "TypeError: x is undefined\n    at App" } } }));
        let problems = log.read(false, 0, 50);
        let words: Vec<(&str, &str)> = problems.iter().map(|e| (e.kind.word(), e.text.as_str())).collect();
        assert_eq!(words, vec![("error", "Cannot read x"), ("crash", "TypeError: x is undefined at App")]);
        assert_eq!(problems[1].url.as_deref(), Some("http://localhost:5173/src/App.tsx:42"));
        assert_eq!(log.read(true, 0, 50).len(), 4);
        assert_eq!(log.problems_since(0), 2);
    }

    #[test]
    fn a_failed_request_is_named_by_its_address() {
        let mut log = ConsoleLog::new();
        log.ingest("Network.requestWillBeSent", &json!({ "requestId": "7", "request": { "url": "http://localhost:3000/api/items" } }));
        log.ingest("Network.loadingFailed", &json!({ "requestId": "7", "errorText": "net::ERR_CONNECTION_REFUSED" }));
        log.ingest("Network.responseReceived", &json!({ "response": { "url": "http://localhost:3000/missing.png", "status": 404, "statusText": "Not Found" } }));
        log.ingest("Network.responseReceived", &json!({ "response": { "url": "http://localhost:3000/ok", "status": 200 } }));
        // The browser's own "Failed to load resource" line is not counted twice.
        log.ingest("Log.entryAdded", &json!({ "entry": { "level": "error", "text": "Failed to load resource: the server responded with a status of 404", "url": "http://localhost:3000/missing.png" } }));
        let got = log.read(false, 0, 50);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].text, "request failed: net::ERR_CONNECTION_REFUSED");
        assert_eq!(got[0].url.as_deref(), Some("http://localhost:3000/api/items"));
        assert_eq!(got[1].text, "404 Not Found");
    }

    #[test]
    fn a_cancelled_request_is_not_a_problem() {
        let mut log = ConsoleLog::new();
        log.ingest("Network.loadingFailed", &json!({ "requestId": "1", "errorText": "net::ERR_ABORTED", "canceled": true }));
        assert!(log.read(true, 0, 10).is_empty());
    }

    #[test]
    fn the_same_line_in_a_row_is_one_entry_and_the_log_keeps_only_the_newest() {
        let mut log = ConsoleLog::new();
        for _ in 0..50 {
            let (m, p) = console("error", json!([{ "type": "string", "value": "again" }]));
            log.ingest(&m, &p);
        }
        assert_eq!(log.read(true, 0, 999).len(), 1);
        for i in 0..(KEEP + 30) {
            let (m, p) = console("error", json!([{ "type": "string", "value": format!("line {i}") }]));
            log.ingest(&m, &p);
        }
        let all = log.read(true, 0, 999);
        assert_eq!(all.len(), KEEP);
        assert_eq!(all.last().unwrap().text, format!("line {}", KEEP + 29));
    }

    #[test]
    fn reading_after_a_number_gives_only_what_is_new() {
        let mut log = ConsoleLog::new();
        let (m, p) = console("error", json!([{ "type": "string", "value": "one" }]));
        log.ingest(&m, &p);
        let mark = log.last_seq();
        let (m, p) = console("error", json!([{ "type": "string", "value": "two" }]));
        log.ingest(&m, &p);
        assert_eq!(log.problems_since(mark), 1);
        let got = log.read(false, mark, 10);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "two");
        assert_eq!(render(&got), "#2 error two");
        assert_eq!(render(&[]), "(nothing)");
    }

    #[test]
    fn long_text_is_cut() {
        let mut log = ConsoleLog::new();
        let (m, p) = console("error", json!([{ "type": "string", "value": "x".repeat(5000) }]));
        log.ingest(&m, &p);
        assert_eq!(log.read(true, 0, 1)[0].text.chars().count(), MAX_TEXT);
    }
}
