//! The headless probe (ladder level L2): find how a CLI answers one task without a screen, and write the app's
//! own `[headless]` table for it. Port of the lab's `probe_cli.py` and `probe_options.py`.
//!
//! Two parts:
//! 1. Reading (no consent needed): the help text is scanned for a headless flag, an output-format flag and a resume
//!    flag; the CLI's own `--list-models` option is run when the help has it. No prompt reaches a model. (Word forms
//!    such as `models` could be read as a prompt, so they run only with a consent and count against it.)
//! 2. Asking (needs a `ProbeConsent`): at most `MAX_PAID_RUNS` tiny runs, `<cmd> <headless> <format> -- "Reply with
//!    exactly: <nonce>"`. The only function that sends a prompt takes the consent token, so a run without it does
//!    not compile.
//!
//! Guards (`exec::run_guarded`): stdin closed, first byte 30 s, idle 20 s, whole process tree killed, stop on terminal-UI
//! escape codes. Further rules: flags come only from the closed lists below, an argv with a permission bypass
//! (`bypass.rs`) is refused before anything starts, "looks signed out" is a plain sign-in result and never a pass, and an
//! answer that only repeats the prompt is rejected. Samples are masked before they leave this module.
//!
//! How the ladder should call it (the ladder is not edited here): when the L0/L1 steps found nothing, build a
//! `ProbeRequest { tokens: vec![program, ..], helps: vec![], work_dir: temp folder, limits: Default }`, call
//! `probe(&req, None)` for the free reading, show the consent screen, and only after a yes call
//! `probe(&req, Some(ProbeConsent::granted(2)))`. `ProbeResult::headless_toml()` is the `[headless]` table to merge into
//! the draft definition; `level == L2` means it is proven, `L5` means terminal only.

use std::path::PathBuf;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::bypass;
use super::exec::{self, run_guarded, GuardLimits, GuardStop};

/// The most prompts one probe may send, whatever the caller asks.
pub const MAX_PAID_RUNS: u8 = 2;
const MAX_CAPTURE: usize = 256 * 1024;
const SAMPLE_CHARS: usize = 4000;
const SEPARATOR: &str = "--";

// ---- The closed lists: the only flags the probe ever adds to a command. ----
const PRINT_FLAGS: &[&str] = &["--print", "-p", "--non-interactive", "--headless", "--batch"];
const VALUE_FLAGS: &[&str] = &["--prompt", "-q", "--query", "--message", "-m"];
const SUBCOMMANDS: &[&str] = &["exec", "run", "ask"];
const FORMAT_FLAGS: &[&str] = &["-o", "--output-format", "--output", "--format", "--json"];
const FORMAT_VALUES: &[&str] = &["stream-json", "jsonl", "ndjson", "json"];
/// The list command that is a flag: it cannot be read as a prompt, so it needs no consent.
const LIST_FLAG: &str = "--list-models";

fn in_closed_list(token: &str) -> bool {
    [PRINT_FLAGS, VALUE_FLAGS, SUBCOMMANDS, FORMAT_FLAGS, FORMAT_VALUES].iter().any(|l| l.contains(&token))
        || token == SEPARATOR
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeLevel {
    /// A headless way was found and shown to answer.
    L2,
    /// Nothing proven: terminal only.
    L5,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// Proven by a real answer.
    Found,
    /// The help text names no headless flag.
    NoHeadlessFlag,
    /// A headless flag was found, but no run was allowed: only the draft from the help text exists.
    NeedsConsent,
    /// The CLI asked for a sign-in. Not a pass, not a failure of the CLI.
    SignedOut,
    /// A guard stopped the run (`tui`, `no-output`, `idle`, `total`) or the program did not start.
    Stopped(String),
    /// The output only repeated the prompt.
    EchoOnly,
    /// The run finished but its answer could not be found or read.
    NoAnswer,
    /// The command already contains a permission bypass; nothing was started.
    Refused(Vec<String>),
}

/// The person's yes to at most `runs` tiny paid runs. Not `Clone`, not `Default`: only a consent screen makes one.
#[derive(Debug)]
pub struct ProbeConsent {
    runs: u8,
}

impl ProbeConsent {
    /// `runs` is cut to `MAX_PAID_RUNS`.
    pub fn granted(runs: u8) -> Self {
        Self { runs: runs.min(MAX_PAID_RUNS) }
    }
    pub fn runs(&self) -> u8 {
        self.runs
    }
}

pub struct ProbeRequest {
    /// The program followed by the arguments that always start it (`["C:/tools/agent.exe"]`).
    pub tokens: Vec<String>,
    /// Help texts already read. Empty: the probe reads `--help` itself.
    pub helps: Vec<String>,
    /// A temp folder, never the person's project.
    pub work_dir: PathBuf,
    pub limits: GuardLimits,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WhereVal {
    Str(String),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SelectorDraft {
    pub where_eq: Vec<(String, WhereVal)>,
    pub path: Option<String>,
    pub pick: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftFormat {
    PlainText,
    JsonLines,
}

/// The `[headless]` table the probe found.
#[derive(Debug, Clone, PartialEq)]
pub struct HeadlessDraft {
    /// Arguments after the program, before the task.
    pub argv: Vec<String>,
    pub task_flag: Option<String>,
    pub task_separator: Option<String>,
    pub format: DraftFormat,
    pub result: Option<SelectorDraft>,
    pub session: Option<SelectorDraft>,
    pub done: Option<SelectorDraft>,
    pub error: Option<SelectorDraft>,
    /// `[flag, "{session}"]` when a resume flag exists and a session id was seen.
    pub resume_args: Option<Vec<String>>,
    /// `[flag, "{model}"]` when the CLI lists at least two models.
    pub model_args: Option<Vec<String>>,
}

/// A setting the CLI itself lists (model, effort). Recorded as evidence; only the model reaches the table.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeOption {
    pub id: &'static str,
    pub flag: String,
    /// Starts with "default" (adds nothing).
    pub values: Vec<String>,
}

/// One run, masked.
#[derive(Debug, Clone)]
pub struct ProbeSample {
    pub argv: Vec<String>,
    pub stopped: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub level: ProbeLevel,
    pub outcome: ProbeOutcome,
    pub headless: Option<HeadlessDraft>,
    pub options: Vec<ProbeOption>,
    /// Plain words, one fact per line.
    pub evidence: Vec<String>,
    pub runs_used: u8,
    pub samples: Vec<ProbeSample>,
}

impl ProbeResult {
    fn new(outcome: ProbeOutcome) -> Self {
        Self { level: ProbeLevel::L5, outcome, headless: None, options: Vec::new(), evidence: Vec::new(), runs_used: 0, samples: Vec::new() }
    }

    /// The `[headless]` tables as TOML text, with the evidence as comments. `None` when nothing was found.
    pub fn headless_toml(&self) -> Option<String> {
        self.headless.as_ref().map(|d| render_headless_toml(d, &self.evidence))
    }
}

// ---------------------------------------------------------------------------------------------------------
// Reading the help text
// ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Flag,
    Value,
    Sub,
}

#[derive(Debug, Default)]
struct HelpInfo {
    headless: Option<(Kind, String)>,
    format: Option<Vec<String>>,
    format_flag: Option<String>,
    resume: Option<String>,
    permission_flags: Vec<String>,
}

static HEADLESS_RX: Lazy<Vec<(Regex, Kind, i32)>> = Lazy::new(|| {
    let rx = |s: &str| Regex::new(s).expect("headless regex");
    vec![
        (rx(r"^\s*(?:-\w,\s*)?(--print|-p)(?:[\s,=<\[]|$)"), Kind::Flag, 5),
        (rx(r"^\s*(?:-\w,\s*)?(--non-interactive|--headless|--batch)(?:[\s,=<\[]|$)"), Kind::Flag, 5),
        (rx(r"^\s*(?:-\w,\s*)?(--prompt|-q|--query|--message|-m)\s*[<\[=]"), Kind::Value, 3),
        (rx(r"^\s*(exec|run|ask)\b"), Kind::Sub, 3),
    ]
});
static NOT_PRINT: Lazy<Regex> = Lazy::new(|| Regex::new(r"profile|prompt-interactive|--prompt").expect("rx"));
/// The names at the start of an option line: `-p, --print <x>` gives (`-p`, `--print`).
static LINE_NAMES: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(?:(-\w)(?:,\s*|\s+|$))?(--[A-Za-z][\w-]*)?").expect("rx"));
static PRINT_WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"--print").expect("rx"));
static BONUS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)non-?interactive|print|pipe|script|exit|headless|prompt|query").expect("rx"));
static FORMAT_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)(?:^|\s)(-o|--output-format|--output|--format)\b[^\n]*").expect("rx"));
static FORMAT_VALS: Lazy<Regex> = Lazy::new(|| Regex::new(r"stream-json|jsonl|ndjson|json|text").expect("rx"));
static JSON_FLAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*--json\b").expect("rx"));
static RESUME_RX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)(?:^|\s)(--resume|--continue)(?:[\s=\[<]|$)[^\n]*").expect("rx"));
static PERMISSION_RX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"--(?:permission-mode|allowed-?tools|yolo|dangerously-[\w-]+|approval[\w-]*|sandbox|auto-approve)").expect("rx")
});

/// A short flag counts only with its long name: the long name must be in the same closed list as the flag, and
/// neither name may be a permission bypass. A short flag alone needs a describing word on its line.
fn short_flag_is_safe(line: &str, flag: &str, kind: Kind) -> bool {
    let caps = LINE_NAMES.captures(line);
    let short = caps.as_ref().and_then(|c| c.get(1)).map(|m| m.as_str());
    let long = caps.as_ref().and_then(|c| c.get(2)).map(|m| m.as_str());
    let names: Vec<String> = short.iter().chain(long.iter()).map(|n| (*n).to_string()).collect();
    if !bypass::hits_in_argv(&names).is_empty() {
        return false;
    }
    if flag.starts_with("--") || flag.len() != 2 {
        return true; // a long flag is checked against the closed list by the regex itself
    }
    match long {
        Some(long) => {
            let list = if kind == Kind::Value { VALUE_FLAGS } else { PRINT_FLAGS };
            list.contains(&long)
        }
        None => BONUS.is_match(line),
    }
}

fn scan_help(texts: &[String]) -> HelpInfo {
    let text = texts.join("\n");
    let mut best: Option<(i32, Kind, String)> = None;
    for line in text.lines() {
        let not_print = NOT_PRINT.is_match(line) && !PRINT_WORD.is_match(line);
        for (rx, kind, base) in HEADLESS_RX.iter() {
            if not_print && *kind != Kind::Value {
                continue; // "-p, --profile" or "-p, --prompt <x>" is not a print flag
            }
            let Some(m) = rx.captures(line).and_then(|c| c.get(1)) else { continue };
            if *kind == Kind::Value && m.as_str() == "-m" && line.to_ascii_lowercase().contains("model") {
                continue; // "-m, --model <model>" is the model flag
            }
            if !short_flag_is_safe(line, m.as_str(), *kind) {
                continue; // "-p, --yolo" or "-p, --port": the short name is not the print flag
            }
            let score = base + i32::from(BONUS.is_match(line));
            if best.as_ref().map_or(true, |b| score > b.0) {
                best = Some((score, *kind, m.as_str().to_string()));
            }
        }
    }
    let mut info = HelpInfo { headless: best.map(|(_, k, f)| (k, f)), ..HelpInfo::default() };
    if let Some(m) = FORMAT_LINE.captures(&text).and_then(|c| c.get(1).map(|g| (g.as_str().to_string(), c.get(0).unwrap().end()))) {
        let after = exec::cut_bytes(&text[m.1..], 200);
        let hay = format!("{} {}", FORMAT_LINE.find(&text).map_or("", |f| f.as_str()), after);
        let vals: Vec<&str> = FORMAT_VALS.find_iter(&hay).map(|v| v.as_str()).collect();
        info.format_flag = Some(m.0.clone());
        info.format = ["stream-json", "jsonl", "ndjson", "json"].iter().find(|p| vals.contains(p)).map(|p| vec![m.0.clone(), (*p).to_string()]);
    } else if JSON_FLAG.is_match(&text) {
        info.format = Some(vec!["--json".to_string()]);
    }
    info.resume = RESUME_RX.captures(&text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string());
    let mut perms: Vec<String> = PERMISSION_RX.find_iter(&text).map(|m| m.as_str().to_string()).collect();
    perms.sort();
    perms.dedup();
    info.permission_flags = perms;
    info
}

fn model_flag(text: &str) -> Option<&'static str> {
    static LONG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*(?:-\w,\s*)?--model\b").expect("rx"));
    static SHORT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*-m,?\s+(?:--model\b)?").expect("rx"));
    static SHORT_MODEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)-m[, ].*model").expect("rx"));
    if LONG.is_match(text) {
        Some("--model")
    } else if SHORT.is_match(text) && SHORT_MODEL.is_match(text) {
        Some("-m")
    } else {
        None
    }
}

fn parse_models(out: &str) -> Vec<String> {
    const HEADERS: &[&str] = &["MODEL", "MODELS", "NAME", "ID", "NAMES", "AVAILABLE MODELS"];
    static TOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\w./:@+-]+$").expect("rx"));
    let mut values: Vec<String> = Vec::new();
    for line in out.lines() {
        let line = line.trim().trim_start_matches(|c: char| "-*\u{2022} ".contains(c)).trim();
        if line.is_empty() || line.chars().count() > 70 || HEADERS.contains(&line.to_uppercase().as_str()) || line.chars().all(|c| "-=_ ".contains(c)) {
            continue;
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.len() <= 3 && TOKEN.is_match(words[0]) && !values.iter().any(|v| v == words[0]) {
            values.push(words[0].to_string());
        }
    }
    values.truncate(80);
    values
}

/// `--list-models` as an option line of the help.
static LIST_FLAG_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*(?:-\w,\s*)?--list-models(?:[\s,=<\[]|$)").expect("rx"));
/// `models` / `model` as a subcommand line of the help (indented, then two spaces before the description).
static LIST_WORD_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s+(models?)\s{2,}\S").expect("rx"));

/// The list commands the help itself offers, in the order they are tried. `flag` ones run freely; the word forms
/// (`models`, `model list`) are subcommands that a CLI could also read as a prompt, so they run only with a consent
/// and count against it.
fn list_candidates(text: &str) -> (Option<Vec<String>>, Vec<Vec<String>>) {
    let flag = LIST_FLAG_LINE.is_match(text).then(|| vec![LIST_FLAG.to_string()]);
    let mut words: Vec<Vec<String>> = Vec::new();
    if let Some(m) = LIST_WORD_LINE.captures(text).and_then(|c| c.get(1)) {
        if m.as_str() == "models" {
            words.push(vec!["models".to_string()]);
            words.push(vec!["models".to_string(), "list".to_string()]);
        } else {
            words.push(vec!["model".to_string(), "list".to_string()]);
        }
    }
    (flag, words)
}

static EFFORT_RX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(--reasoning-effort|--effort|--thinking-effort)\b[^\n]*").expect("rx"));
static EFFORT_VALS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(minimal|low|medium|high|xhigh|max)\b").expect("rx"));

/// The CLI's own list of models and efforts. Runs only the list command of the closed list; no model call.
fn scan_options(req: &ProbeRequest, program: &std::path::Path, helps: &[String], budget: &mut Budget) -> Vec<ProbeOption> {
    let text = helps.join("
");
    let mut opts = Vec::new();
    if let Some(flag) = model_flag(&text) {
        let (flag_form, word_forms) = list_candidates(&text);
        let tries = flag_form.into_iter().map(|c| (c, false)).chain(word_forms.into_iter().map(|c| (c, true)));
        for (command, could_be_prompt) in tries {
            if could_be_prompt && !budget.take() {
                continue; // no consent (or none left): the word forms are not run
            }
            let mut args: Vec<String> = req.tokens[1..].to_vec();
            args.extend(command);
            let out = run_guarded(program, &args, &req.work_dir, &req.limits, MAX_CAPTURE);
            if out.stop.is_some() || out.spawn_error.is_some() {
                continue;
            }
            let values = parse_models(&out.text);
            if values.len() >= 2 {
                let mut all = vec!["default".to_string()];
                all.extend(values);
                opts.push(ProbeOption { id: "model", flag: flag.to_string(), values: all });
                break;
            }
        }
    }
    if let Some(m) = EFFORT_RX.captures(&text) {
        let whole = m.get(0).unwrap();
        let hay = format!("{} {}", whole.as_str(), exec::cut_bytes(&text[whole.end()..], 160));
        let mut vals: Vec<String> = Vec::new();
        for v in EFFORT_VALS.find_iter(&hay) {
            if !vals.iter().any(|x| x == v.as_str()) {
                vals.push(v.as_str().to_string());
            }
        }
        if vals.len() >= 2 {
            let mut all = vec!["default".to_string()];
            all.extend(vals);
            opts.push(ProbeOption { id: "effort", flag: m.get(1).unwrap().as_str().to_string(), values: all });
        }
    }
    opts
}

// ---------------------------------------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------------------------------------

static SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)(sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9+/=_-]{40,}|"(?:token|api_?key|authorization|cookie)"\s*:\s*"[^"]*")"#).expect("rx")
});
static SIGNED_OUT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)not logged in|unauthori[sz]ed|api key|please (?:log|sign) ?in|login required").expect("rx"));
static SESSION_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(?:.*\.)?(?:session_id|sessionId|conversation_id|thread_id)$").expect("rx"));

fn mask_sample(text: &str) -> String {
    exec::cut_chars(&exec::clean(&SECRET.replace_all(text, "<masked>")), SAMPLE_CHARS)
}

fn leaves<'a>(v: &'a Value, prefix: &str, out: &mut Vec<(String, &'a Value)>) {
    let join = |k: &str| if prefix.is_empty() { k.to_string() } else { format!("{prefix}.{k}") };
    match v {
        Value::Object(m) => m.iter().for_each(|(k, x)| leaves(x, &join(k), out)),
        Value::Array(a) => a.iter().enumerate().for_each(|(i, x)| leaves(x, &join(&i.to_string()), out)),
        _ => out.push((prefix.to_string(), v)),
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('.').map_or(path, |p| p.0)
}

fn top_discriminators(o: &Value, keys: &[&str]) -> Vec<(String, WhereVal)> {
    keys.iter().filter_map(|k| o.get(*k).and_then(Value::as_str).map(|s| ((*k).to_string(), WhereVal::Str(s.to_string())))).collect()
}

struct Inferred {
    result: Option<SelectorDraft>,
    session: Option<SelectorDraft>,
    done: Option<SelectorDraft>,
    error: Option<SelectorDraft>,
    text_path: Option<String>,
    session_seen: bool,
}

/// From parsed JSON lines, the selectors for the answer, the session id, the end marker and an error. A leaf that
/// contains the whole prompt can never be the answer (an echo of the prompt is not an answer).
fn infer_rules(lines: &[Value], nonce: &str, prompt: &str) -> Inferred {
    let mut text_rule: Option<(Vec<(String, WhereVal)>, String)> = None;
    'outer: for o in lines {
        if o.get("type").and_then(Value::as_str) == Some("result") {
            continue;
        }
        let mut all = Vec::new();
        leaves(o, "", &mut all);
        for (p, v) in &all {
            let Some(s) = v.as_str() else { continue };
            if !s.contains(nonce) || s.contains(prompt) {
                continue;
            }
            let mut disc = top_discriminators(o, &["type", "subtype", "event", "kind"]);
            for (q, w) in &all {
                if let (true, Some(w)) = (q.ends_with(".type"), w.as_str()) {
                    if parent(q) == parent(p) {
                        disc.push((q.clone(), WhereVal::Str(w.to_string())));
                    }
                }
            }
            text_rule = Some((disc, p.clone()));
            break 'outer;
        }
    }
    let mut sess: Option<(Vec<(String, WhereVal)>, String)> = None;
    'find: for o in lines {
        let mut all = Vec::new();
        leaves(o, "", &mut all);
        for (p, v) in &all {
            if SESSION_KEY.is_match(p) && v.as_str().is_some_and(|s| s.len() >= 8) {
                sess = Some((top_discriminators(o, &["type", "subtype"]), p.clone()));
                break 'find;
            }
        }
    }
    let last = lines.last();
    let done_where = last.map(|l| top_discriminators(l, &["type"])).unwrap_or_default();
    let done = (!done_where.is_empty() && text_rule.as_ref().map_or(true, |t| t.0 != done_where))
        .then(|| SelectorDraft { where_eq: done_where.clone(), path: None, pick: None });
    let error = last.and_then(|l| {
        let is_error = l.get("is_error").and_then(Value::as_bool).is_some();
        (is_error && !done_where.is_empty()).then(|| {
            let mut w = done_where.clone();
            w.push(("is_error".to_string(), WhereVal::Bool(true)));
            SelectorDraft { where_eq: w, path: l.get("result").and_then(Value::as_str).map(|_| "result".to_string()), pick: None }
        })
    });
    Inferred {
        result: text_rule.as_ref().map(|(d, p)| SelectorDraft { where_eq: d.clone(), path: Some(p.clone()), pick: Some("last") }),
        session: sess.as_ref().map(|(d, p)| SelectorDraft { where_eq: d.clone(), path: Some(p.clone()), pick: Some("first") }),
        done,
        error,
        text_path: text_rule.map(|t| t.1),
        session_seen: sess.is_some(),
    }
}

// ---------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------

fn q(s: &str) -> String {
    serde_json::to_string(s).expect("string")
}

fn list(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|s| q(s)).collect::<Vec<_>>().join(", "))
}

fn render_selector(out: &mut String, name: &str, s: &SelectorDraft) {
    out.push_str(&format!("\n[headless.output.{name}]\n"));
    if !s.where_eq.is_empty() {
        let parts: Vec<String> = s
            .where_eq
            .iter()
            .map(|(k, v)| match v {
                WhereVal::Str(x) => format!("{} = {}", q(k), q(x)),
                WhereVal::Bool(b) => format!("{} = {b}", q(k)),
            })
            .collect();
        out.push_str(&format!("where = {{ {} }}\n", parts.join(", ")));
    }
    if let Some(p) = &s.path {
        out.push_str(&format!("path = {}\n", q(p)));
    }
    if let Some(p) = s.pick {
        out.push_str(&format!("pick = {}\n", q(p)));
    }
}

/// The `[headless]` table (and its `optional` and `output` sub-tables) for a draft; evidence lines become comments.
pub fn render_headless_toml(d: &HeadlessDraft, evidence: &[String]) -> String {
    let mut out = String::new();
    for line in evidence {
        out.push_str(&format!("# {}\n", line.replace(['\n', '\r'], " ")));
    }
    out.push_str("[headless]\n");
    out.push_str(&format!("argv = {}\n", list(&d.argv)));
    if let Some(f) = &d.task_flag {
        out.push_str(&format!("task_flag = {}\n", q(f)));
    }
    if let Some(s) = &d.task_separator {
        out.push_str(&format!("task_separator = {}\n", q(s)));
    }
    if let Some(args) = &d.model_args {
        out.push_str(&format!("\n[[headless.optional]]\nwhen = \"model\"\nargs = {}\n", list(args)));
    }
    if let Some(args) = &d.resume_args {
        out.push_str(&format!("\n[[headless.optional]]\nwhen = \"resume\"\nargs = {}\n", list(args)));
    }
    let format = if d.format == DraftFormat::JsonLines { "json_lines" } else { "plain_text" };
    out.push_str(&format!("\n[headless.output]\nformat = {}\n", q(format)));
    for (name, sel) in [("result", &d.result), ("session", &d.session), ("done", &d.done), ("error", &d.error)] {
        if let Some(s) = sel {
            render_selector(&mut out, name, s);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------------------------

/// How the task reaches the program, and what comes before it.
struct Shape {
    kind: Kind,
    flag: String,
    format: Vec<String>,
}

impl Shape {
    /// Arguments after the program, before the task.
    fn lead(&self, tokens: &[String]) -> Vec<String> {
        let mut v: Vec<String> = tokens[1..].to_vec();
        if self.kind != Kind::Value {
            v.push(self.flag.clone());
        }
        v.extend(self.format.iter().cloned());
        v
    }

    fn draft(&self, tokens: &[String]) -> HeadlessDraft {
        HeadlessDraft {
            argv: self.lead(tokens),
            task_flag: (self.kind == Kind::Value).then(|| self.flag.clone()),
            task_separator: (self.kind != Kind::Value).then(|| SEPARATOR.to_string()),
            format: DraftFormat::PlainText,
            result: None,
            session: None,
            done: None,
            error: None,
            resume_args: None,
            model_args: None,
        }
    }

    /// The whole argument list for one run, and the added tokens (for the closed-list check).
    fn run_args(&self, tokens: &[String], prompt: &str) -> (Vec<String>, Vec<String>) {
        let mut added: Vec<String> = Vec::new();
        if self.kind != Kind::Value {
            added.push(self.flag.clone());
        }
        added.extend(self.format.iter().cloned());
        let mut args: Vec<String> = tokens[1..].to_vec();
        args.extend(added.iter().cloned());
        if self.kind == Kind::Value {
            added.push(self.flag.clone());
            args.push(self.flag.clone());
        } else {
            added.push(SEPARATOR.to_string());
            args.push(SEPARATOR.to_string());
        }
        args.push(prompt.to_string());
        (args, added)
    }
}

/// Read `--help` (then `-h`) of the command. No consent needed: no prompt is sent.
pub fn collect_help(req: &ProbeRequest) -> Vec<String> {
    let program = PathBuf::from(&req.tokens[0]);
    for flag in ["--help", "-h"] {
        let mut args: Vec<String> = req.tokens[1..].to_vec();
        args.push(flag.to_string());
        let out = run_guarded(&program, &args, &req.work_dir, &req.limits, MAX_CAPTURE);
        if out.stop != Some(GuardStop::Tui) && !out.text.trim().is_empty() {
            return vec![exec::plain(&out.text)];
        }
    }
    Vec::new()
}

fn fresh_nonce() -> String {
    format!("PONG-{}", &uuid::Uuid::new_v4().simple().to_string()[..6].to_ascii_uppercase())
}

enum Verdict {
    Stopped(String),
    SignedOut,
    EchoOnly,
    Json(Inferred),
    JsonNoAnswer,
    Plain,
    Nothing,
}

fn classify(text: &str, stop: Option<GuardStop>, nonce: &str, prompt: &str) -> Verdict {
    if let Some(s) = stop.filter(|s| *s != GuardStop::ExitNonzero) {
        return Verdict::Stopped(s.word().to_string());
    }
    let outside = text.replace(prompt, "");
    let answered = outside.contains(nonce);
    if SIGNED_OUT.is_match(text) && !answered {
        return Verdict::SignedOut;
    }
    if !answered {
        return if text.contains(nonce) { Verdict::EchoOnly } else { Verdict::Nothing };
    }
    let nonblank: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let parsed: Vec<Value> = nonblank.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object).collect();
    if !nonblank.is_empty() && parsed.len() * 10 >= nonblank.len() * 8 {
        let inferred = infer_rules(&parsed, nonce, prompt);
        return if inferred.result.is_some() && inferred.done.is_some() { Verdict::Json(inferred) } else { Verdict::JsonNoAnswer };
    }
    Verdict::Plain
}

/// The runs a consent allows, and how many were used. Every run that a CLI could read as a prompt is taken from
/// here first; with no consent the budget is zero. The consent token is used up when the budget is made.
struct Budget {
    allowed: u8,
    used: u8,
}

impl Budget {
    fn new(consent: Option<ProbeConsent>) -> Self {
        Self { allowed: consent.map_or(0, |c| c.runs()), used: 0 }
    }

    /// One more run, if the consent still has one.
    fn take(&mut self) -> bool {
        if self.used >= self.allowed {
            return false;
        }
        self.used += 1;
        true
    }
}

/// The only function that sends a prompt. It takes a run from the budget first.
fn paid_run(budget: &mut Budget, req: &ProbeRequest, program: &std::path::Path, args: &[String]) -> Option<exec::GuardedOutput> {
    budget.take().then(|| run_guarded(program, args, &req.work_dir, &req.limits, MAX_CAPTURE))
}

/// Find the headless way of a CLI. Without a consent token no prompt is sent (`runs_used` stays 0); the result then
/// holds the draft that the help text alone allows. With one, at most `consent.runs()` runs are made.
pub fn probe(req: &ProbeRequest, consent: Option<ProbeConsent>) -> ProbeResult {
    let mut res = ProbeResult::new(ProbeOutcome::NoHeadlessFlag);
    if req.tokens.is_empty() {
        res.evidence.push("no command given".to_string());
        return res;
    }
    let hits = bypass::hits_in_argv(&req.tokens[1..]);
    if !hits.is_empty() {
        res.evidence.push(bypass::refusal_text(&hits));
        res.outcome = ProbeOutcome::Refused(hits.into_iter().map(|h| h.token).collect());
        return res;
    }
    let program = PathBuf::from(&req.tokens[0]);
    let helps = if req.helps.is_empty() { collect_help(req) } else { req.helps.clone() };
    let info = scan_help(&helps);
    let Some((kind, flag)) = info.headless.clone() else {
        res.evidence.push("the help text names no headless flag: terminal only, or a hand-written definition".to_string());
        return res;
    };
    let has_consent = consent.is_some();
    let mut budget = Budget::new(consent);
    res.options = scan_options(req, &program, &helps, &mut budget);
    res.runs_used = budget.used; // a word-form list run counts too
    res.evidence.push(format!("headless: {flag}; format: {}; resume flag seen: {} (not tried)", info.format.as_ref().map_or("none".into(), |f| f.join(" ")), info.resume.as_deref().unwrap_or("none")));
    res.evidence.push(format!(
        "options: {}",
        if res.options.is_empty() { "none found".to_string() } else { res.options.iter().map(|o| format!("{} ({})", o.id, o.values.len() - 1)).collect::<Vec<_>>().join(", ") }
    ));
    res.evidence.push(format!("permission flags in the help (none used): {}", if info.permission_flags.is_empty() { "none".to_string() } else { info.permission_flags.join(", ") }));

    // The model chooser rides along in every draft.
    let model_args = res.options.iter().find(|o| o.id == "model").map(|o| vec![o.flag.clone(), "{model}".to_string()]);
    let mut variants: Vec<Vec<String>> = vec![info.format.clone().unwrap_or_default()];
    if info.format.is_none() {
        if let Some(ff) = &info.format_flag {
            variants.insert(0, vec![ff.clone(), "stream-json".to_string()]); // the help names a format flag but not its values
        }
    }
    let static_shape = Shape { kind, flag: flag.clone(), format: variants.last().cloned().unwrap_or_default() };
    let mut static_draft = static_shape.draft(&req.tokens);
    static_draft.model_args = model_args.clone();

    if !has_consent {
        res.outcome = ProbeOutcome::NeedsConsent;
        res.headless = Some(static_draft);
        res.evidence.push("no prompt was sent: it needs the person's yes (at most 2 tiny runs)".to_string());
        return res;
    }

    let nonce = fresh_nonce();
    let prompt = format!("Reply with exactly: {nonce}");
    let mut fallback: Option<Shape> = None;
    let mut last_problem = ProbeOutcome::NoAnswer;
    for format in variants {
        let shape = Shape { kind, flag: flag.clone(), format };
        let (args, added) = shape.run_args(&req.tokens, &prompt);
        // The closed list and the bypass list are checked on the exact argv, right before it starts.
        let mut not_prompt: Vec<String> = args.clone();
        not_prompt.pop();
        let bad = bypass::hits_in_argv(&not_prompt);
        if !bad.is_empty() || added.iter().any(|t| !in_closed_list(t)) {
            res.evidence.push("a flag outside the closed list was about to be used: nothing was started".to_string());
            res.outcome = ProbeOutcome::Refused(bad.into_iter().map(|h| h.token).collect());
            return res;
        }
        let ran = paid_run(&mut budget, req, &program, &args);
        res.runs_used = budget.used;
        let Some(out) = ran else { break };
        res.samples.push(ProbeSample { argv: args.clone(), stopped: out.stop.map(|s| s.word().to_string()), text: mask_sample(&out.text) });
        if let Some(e) = &out.spawn_error {
            res.evidence.push(format!("the program did not start: {}", exec::cut_chars(&mask_sample(e), 200)));
            res.outcome = ProbeOutcome::Stopped("spawn".to_string());
            return res;
        }
        match classify(&out.text, out.stop, &nonce, &prompt) {
            Verdict::Stopped(why) => {
                res.evidence.push(format!("run {} stopped: {why}", res.runs_used));
                res.outcome = ProbeOutcome::Stopped(why);
                return res;
            }
            Verdict::SignedOut => {
                res.evidence.push("the CLI looks signed out: sign in yourself and retry".to_string());
                res.outcome = ProbeOutcome::SignedOut;
                return res;
            }
            Verdict::EchoOnly => {
                res.evidence.push(format!("run {}: the output only repeats the prompt, not an answer", res.runs_used));
                last_problem = ProbeOutcome::EchoOnly;
            }
            Verdict::Nothing => {
                res.evidence.push(format!("run {}: the answer never contained the check word", res.runs_used));
                last_problem = ProbeOutcome::NoAnswer;
            }
            Verdict::JsonNoAnswer => {
                res.evidence.push(format!("run {}: JSON events, but no answer or end marker could be found", res.runs_used));
                last_problem = ProbeOutcome::NoAnswer;
            }
            Verdict::Json(inf) => {
                let mut d = shape.draft(&req.tokens);
                d.format = DraftFormat::JsonLines;
                d.model_args = model_args;
                // `--continue` takes no id, so only `--resume <id>` is written (and only as a draft: it was not tried).
                d.resume_args = (info.resume.as_deref() == Some("--resume") && inf.session_seen)
                    .then(|| vec!["--resume".to_string(), "{session}".to_string()]);
                d.result = inf.result;
                d.session = inf.session;
                d.done = inf.done;
                d.error = inf.error;
                res.evidence.push(format!("answer found at {} in JSON lines; tool cards not verified", inf.text_path.unwrap_or_default()));
                res.level = ProbeLevel::L2;
                res.outcome = ProbeOutcome::Found;
                res.headless = Some(d);
                return res;
            }
            Verdict::Plain => {
                res.evidence.push(format!("run {}: plain text answer (no streaming, no tool cards)", res.runs_used));
                fallback = Some(shape);
                break; // a second paid run would add nothing
            }
        }
    }
    if let Some(shape) = fallback {
        let mut d = shape.draft(&req.tokens);
        d.model_args = model_args;
        res.level = ProbeLevel::L2;
        res.outcome = ProbeOutcome::Found;
        res.headless = Some(d);
    } else {
        res.outcome = last_problem;
    }
    res
}

#[cfg(test)]
#[path = "headless_probe_tests.rs"]
mod tests;
