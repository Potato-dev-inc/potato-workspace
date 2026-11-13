//! The ACP side of the bridge: JSON-RPC lines on stdin/stdout. Requests are answered in order by the reading
//! thread, except `session/prompt`, which runs on its own thread so `session/cancel` is read while a turn runs.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::extras::{ModelListCommand, ToolEvent, ToolRules};
use super::models::{self, DEFAULT_MODEL_VALUE};
use super::store::{Remembered, Store};
use super::turn::{run_turn, TurnControl, TurnEnd, TurnLimits, TurnRequest};
use super::{info_for_profile, NO_MEMORY_NOTICE};
use crate::tui::TuiProfile;

/// A line longer than this is skipped (the host never sends one: a prompt is a few KiB).
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// JSON-RPC "internal error": the turn failed; `message` is one plain sentence.
const RPC_FAILED: i64 = -32603;
const RPC_INVALID_PARAMS: i64 = -32602;
const RPC_METHOD_NOT_FOUND: i64 = -32601;

#[derive(Debug, Clone, Default)]
pub struct ServeOptions {
    /// Start the agent's headless mode read-only (refused when the definition cannot enforce it).
    pub read_only: bool,
    pub limits: TurnLimits,
    /// Where chats are remembered for `session/load` (one file per agent). `None`: nothing is remembered,
    /// so a restarted bridge cannot bring a chat back.
    pub store_dir: Option<std::path::PathBuf>,
    /// How long the agent's model-list command may run. `None`: 15 seconds.
    pub list_timeout: Option<std::time::Duration>,
}

struct Session {
    cwd: String,
    /// The agent's own conversation id from the last finished turn.
    provider_session: Option<String>,
    /// The "no memory" sentence was already sent.
    noticed: bool,
    /// The model picked from the agent's own list; empty = the agent's default (no flag).
    model: String,
}

struct Active {
    session: String,
    ctl: Arc<TurnControl>,
}

struct Shared {
    out: Mutex<Box<dyn Write + Send>>,
    profile: Arc<dyn TuiProfile>,
    label: String,
    options: ServeOptions,
    has_memory: bool,
    /// The agent's model-list command (definition) when the profile also takes a per-run model.
    model_list: Option<ModelListCommand>,
    /// The list once it was read (`Some(empty)`: it ran and gave nothing, so there is no chip).
    models: Mutex<Option<Vec<String>>>,
    tools: Option<Arc<ToolRules>>,
    store: Store,
    sessions: Mutex<HashMap<String, Session>>,
    active: Mutex<Option<Active>>,
    next_session: Mutex<u64>,
}

impl Shared {
    fn send(&self, value: Value) {
        let mut out = self.out.lock();
        let written = writeln!(out, "{value}").and_then(|_| out.flush());
        drop(out);
        if written.is_err() {
            // The host is gone: nobody reads the answer, so stop the agent.
            if let Some(active) = self.active.lock().as_ref() {
                active.ctl.cancel();
            }
        }
    }

    fn reply(&self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn fail(&self, id: &Value, code: i64, message: &str) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }

    fn update(&self, session: &str, update: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": update}}));
    }

    /// A tool card (or the end of one) from what the agent printed. Text is redacted and short.
    fn tool_event(&self, session: &str, event: ToolEvent) {
        let clip = |text: &str, max: usize| {
            let text = crate::redact::text(text).into_inner();
            if text.chars().count() > max {
                format!("{}...", text.chars().take(max).collect::<String>())
            } else {
                text
            }
        };
        let event = match event {
            ToolEvent::Started { id, title, input } => ToolEvent::Started { id: clip(&id, 200), title, input },
            ToolEvent::Finished { id, failed, output } => ToolEvent::Finished { id: clip(&id, 200), failed, output },
        };
        match event {
            ToolEvent::Started { id, title, input } => {
                let mut update = json!({"sessionUpdate": "tool_call", "toolCallId": id, "title": clip(&title, 200), "kind": "other", "status": "in_progress"});
                if let Some(input) = input {
                    update["rawInput"] = json!(clip(&input, 2000));
                }
                self.update(session, update);
            }
            ToolEvent::Finished { id, failed, output } => {
                let mut update = json!({"sessionUpdate": "tool_call_update", "toolCallId": id, "status": if failed { "failed" } else { "completed" }});
                if let Some(output) = output {
                    update["content"] = json!([{"type": "content", "content": {"type": "text", "text": clip(&output, 2000)}}]);
                }
                self.update(session, update);
            }
        }
    }

    /// The model list, read once (the first time a chat opens). `None`: no chip (no list command in the
    /// definition, the profile takes no per-run model, or the command gave nothing).
    fn model_list(&self, cwd: &str) -> Option<Vec<String>> {
        let list = self.model_list.as_ref()?;
        let mut cached = self.models.lock();
        if cached.is_none() {
            let timeout = self.options.list_timeout.unwrap_or(std::time::Duration::from_secs(15));
            *cached = Some(models::list_models(&*self.profile, list, std::path::Path::new(cwd), timeout));
        }
        cached.clone().filter(|m| !m.is_empty())
    }

    /// The config options of a chat: the model chip when there is a list.
    fn config_options(&self, cwd: &str, model: &str) -> Vec<Value> {
        self.model_list(cwd).map(|list| vec![models::model_option(&list, model)]).unwrap_or_default()
    }

    fn remember(&self, chat: &str, session: &Session) {
        if let Some(provider) = session.provider_session.clone() {
            self.store.put(chat, Remembered { provider_session: provider, cwd: session.cwd.clone(), model: session.model.clone(), seq: 0 });
        }
    }

    fn chunk(&self, session: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}
        }));
    }
}

fn read_line<R: BufRead>(input: &mut R, buf: &mut Vec<u8>) -> Option<String> {
    loop {
        buf.clear();
        match input.read_until(b'\n', buf) {
            Ok(0) | Err(_) => return None,
            Ok(_) if buf.len() > MAX_LINE_BYTES => continue,
            Ok(_) => return Some(String::from_utf8_lossy(buf).trim().to_string()),
        }
    }
}

/// Before `initialize` can succeed: answer it (and anything else) with the reason, then stop. The host shows
/// the sentence instead of "the adapter closed the connection".
pub fn refuse_initialize<R: BufRead, W: Write>(mut input: R, mut output: W, sentence: &str) {
    let mut buf = Vec::new();
    while let Some(line) = read_line(&mut input, &mut buf) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = message.get("id").filter(|_| message.get("method").is_some()) else { continue };
        let reply = json!({"jsonrpc": "2.0", "id": id, "error": {"code": RPC_FAILED, "message": sentence}});
        let _ = writeln!(output, "{reply}").and_then(|_| output.flush());
        if message.get("method").and_then(Value::as_str) == Some("initialize") {
            return;
        }
    }
}

/// Serves ACP for `profile` until the host closes stdin. A turn still running then is stopped.
pub fn serve<R: BufRead, W: Write + Send + 'static>(profile: Arc<dyn TuiProfile>, label: String, mut input: R, output: W, options: ServeOptions) {
    let info = info_for_profile(&*profile, &label);
    let has_memory = info.as_ref().map(|i| i.has_memory).unwrap_or(false);
    let tables = profile.bridge_tables().unwrap_or_default();
    let model_list = ModelListCommand::from_table(&tables.model).filter(|_| profile.accepts_headless_model());
    let tools = tables
        .tool
        .as_ref()
        .and_then(|tool| ToolRules::compile(tool, crate::tui::declarative::schema::OutputFormat::JsonLines))
        .map(Arc::new);
    let store = Store::new(options.store_dir.as_deref(), profile.id());
    let shared = Arc::new(Shared {
        out: Mutex::new(Box::new(output)),
        profile,
        label,
        options,
        has_memory,
        model_list,
        models: Mutex::new(None),
        tools,
        store,
        sessions: Mutex::new(HashMap::new()),
        active: Mutex::new(None),
        next_session: Mutex::new(0),
    });
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut buf = Vec::new();
    while let Some(line) = read_line(&mut input, &mut buf) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_string) else { continue };
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method.as_str(), id) {
            ("initialize", Some(id)) => match &info {
                Ok(_) => shared.reply(&id, initialize_result(&shared.label, has_memory)),
                Err(sentence) => {
                    shared.fail(&id, RPC_FAILED, sentence);
                    break;
                }
            },
            ("session/new", Some(id)) => new_session(&shared, &id, &params),
            ("session/load", Some(id)) if has_memory => load_session(&shared, &id, &params),
            ("session/set_config_option", Some(id)) => set_config_option(&shared, &id, &params),
            ("session/prompt", Some(id)) => {
                workers.retain(|worker| !worker.is_finished());
                if let Some(worker) = start_prompt(&shared, id, &params) {
                    workers.push(worker);
                }
            }
            ("session/cancel", id) => {
                cancel(&shared, params.get("sessionId").and_then(Value::as_str));
                if let Some(id) = id {
                    shared.reply(&id, json!({}));
                }
            }
            (other, Some(id)) => shared.fail(&id, RPC_METHOD_NOT_FOUND, &format!("method not found: {other}")),
            (_, None) => {}
        }
    }
    // The host closed the pipe (or initialize was refused): no turn outlives the conversation.
    if let Some(active) = shared.active.lock().as_ref() {
        active.ctl.cancel();
    }
    for worker in workers {
        let _ = worker.join();
    }
}

fn initialize_result(label: &str, load_session: bool) -> Value {
    json!({
        "protocolVersion": 1,
        "agentInfo": {"name": label, "title": label, "version": crate::app_lifecycle::app_version()},
        "agentCapabilities": {
            "loadSession": load_session,
            "promptCapabilities": {"image": false, "audio": false, "embeddedContext": false}
        },
        "authMethods": []
    })
}

fn new_session(shared: &Arc<Shared>, id: &Value, params: &Value) {
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .map(str::to_string)
        .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let session_id = {
        let mut next = shared.next_session.lock();
        *next += 1;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        format!("bridge-{}-{}-{}", std::process::id(), *next, nanos)
    };
    let options = shared.config_options(&cwd, DEFAULT_MODEL_VALUE);
    shared.sessions.lock().insert(session_id.clone(), Session { cwd, provider_session: None, noticed: false, model: String::new() });
    let mut result = json!({"sessionId": session_id});
    if !options.is_empty() {
        result["configOptions"] = Value::Array(options);
    }
    shared.reply(id, result);
}

/// The same folder, whatever the spelling (slashes, a trailing separator, case on Windows, a link).
fn same_folder(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let real = std::fs::canonicalize(p).map(|c| c.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string());
        let real = real.trim_start_matches(r"\\?\").replace('\\', "/");
        let real = real.trim_end_matches('/').to_string();
        if cfg!(windows) { real.to_lowercase() } else { real }
    };
    norm(a) == norm(b)
}

/// `session/load`: brings a chat back (in this run, or from an earlier run through the store) by pointing it at
/// the agent's own conversation id, so the next message goes out with the definition's resume flag. The agent
/// has no history to replay. An id nobody remembers is `-32602`, and the app starts a fresh chat.
fn load_session(shared: &Arc<Shared>, id: &Value, params: &Value) {
    let Some(chat) = params.get("sessionId").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) else {
        shared.fail(id, RPC_INVALID_PARAMS, "The message has no session.");
        return;
    };
    let asked_cwd = params.get("cwd").and_then(Value::as_str).filter(|c| !c.trim().is_empty()).map(str::to_string);
    let known = shared.sessions.lock().get(chat).map(|s| (s.cwd.clone(), s.model.clone()));
    let (cwd, model) = match known {
        Some(found) => found,
        None => {
            // An id that starts with `-` would be read as a flag by the agent: it is never resumed.
            let Some(saved) =
                shared.store.get(chat).filter(|r| !r.provider_session.trim().is_empty() && !r.provider_session.trim_start().starts_with('-'))
            else {
                shared.fail(id, RPC_INVALID_PARAMS, "That chat is not remembered here, so it cannot be brought back.");
                return;
            };
            if asked_cwd.as_deref().is_some_and(|asked| !same_folder(asked, &saved.cwd)) {
                shared.fail(id, RPC_INVALID_PARAMS, "That chat belongs to another folder, so it cannot be brought back here.");
                return;
            }
            let cwd = saved.cwd.clone();
            shared.sessions.lock().insert(
                chat.to_string(),
                Session { cwd: cwd.clone(), provider_session: Some(saved.provider_session), noticed: false, model: saved.model.clone() },
            );
            (cwd, saved.model)
        }
    };
    if asked_cwd.as_deref().is_some_and(|asked| !same_folder(asked, &cwd)) {
        shared.fail(id, RPC_INVALID_PARAMS, "That chat belongs to another folder, so it cannot be brought back here.");
        return;
    }
    // A model that is no longer in the agent's list is dropped (the default is used), never passed blindly.
    let options = shared.config_options(&cwd, &model);
    let model_known = options.iter().any(|o| o["options"].as_array().is_some_and(|l| l.iter().any(|m| m["value"] == model)));
    if !model_known && !model.is_empty() {
        if let Some(session) = shared.sessions.lock().get_mut(chat) {
            session.model.clear();
        }
    }
    let options = if model_known { options } else { shared.config_options(&cwd, DEFAULT_MODEL_VALUE) };
    let mut result = json!({});
    if !options.is_empty() {
        result["configOptions"] = Value::Array(options);
    }
    shared.reply(id, result);
}

/// `session/set_config_option` for the model chip: the value must be one of the agent's own list (or empty for
/// its default). The next message carries it as the definition's model flag.
fn set_config_option(shared: &Arc<Shared>, id: &Value, params: &Value) {
    let (Some(chat), Some(config), Some(value)) = (
        params.get("sessionId").and_then(Value::as_str),
        params.get("configId").and_then(Value::as_str),
        params.get("value").and_then(Value::as_str),
    ) else {
        shared.fail(id, RPC_INVALID_PARAMS, "The message needs a session, an option and a value.");
        return;
    };
    let cwd = match shared.sessions.lock().get(chat) {
        Some(session) => session.cwd.clone(),
        None => {
            shared.fail(id, RPC_INVALID_PARAMS, "That chat session does not exist.");
            return;
        }
    };
    let list = shared.model_list(&cwd);
    let allowed = config == "model" && list.as_ref().is_some_and(|l| value == DEFAULT_MODEL_VALUE || l.iter().any(|m| m == value));
    if !allowed {
        shared.fail(id, RPC_INVALID_PARAMS, "This chat has no such option or value.");
        return;
    }
    if let Some(session) = shared.sessions.lock().get_mut(chat) {
        session.model = value.to_string();
        shared.remember(chat, session);
    }
    shared.reply(id, json!({"configOptions": shared.config_options(&cwd, value)}));
}

fn cancel(shared: &Arc<Shared>, session: Option<&str>) {
    if let Some(active) = shared.active.lock().as_ref() {
        if session.is_none_or(|s| s == active.session) {
            active.ctl.cancel();
        }
    }
}

/// The text of a prompt: its text blocks, in order, and a line with the path for each file block (`resource_link`
/// is baseline, `resource` may come anyway). Images are not offered in `initialize` and are left out.
fn prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                    Some("resource_link" | "resource") => crate::attach::blocks::attachment_of_block(b)
                        .filter(|a| a.kind != crate::attach::AttachKind::Image)
                        .map(|a| format!("[attached file: {}]", a.path)),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn start_prompt(shared: &Arc<Shared>, id: Value, params: &Value) -> Option<std::thread::JoinHandle<()>> {
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str).map(str::to_string) else {
        shared.fail(&id, RPC_INVALID_PARAMS, "The message has no session.");
        return None;
    };
    let text = prompt_text(params);
    if text.trim().is_empty() {
        shared.fail(&id, RPC_INVALID_PARAMS, "This chat takes text messages only.");
        return None;
    }
    let (cwd, resume, notice, model) = {
        let mut sessions = shared.sessions.lock();
        let Some(session) = sessions.get_mut(&session_id) else {
            drop(sessions);
            shared.fail(&id, RPC_INVALID_PARAMS, "That chat session does not exist.");
            return None;
        };
        let notice = !shared.has_memory && !session.noticed;
        session.noticed = true;
        let resume = if shared.has_memory { session.provider_session.clone() } else { None };
        (session.cwd.clone(), resume, notice, Some(session.model.clone()).filter(|m| !m.is_empty()))
    };
    let ctl = TurnControl::new();
    {
        let mut active = shared.active.lock();
        if active.is_some() {
            drop(active);
            shared.fail(&id, RPC_FAILED, "A message is still being answered; wait for it or stop it first.");
            return None;
        }
        *active = Some(Active { session: session_id.clone(), ctl: ctl.clone() });
    }
    let on_failure = (shared.clone(), id.clone());
    let spawned = std::thread::Builder::new()
        .name("acp-bridge-turn".into())
        .spawn({
            let shared = shared.clone();
            move || {
            if notice {
                shared.chunk(&session_id, &format!("{NO_MEMORY_NOTICE}\n\n"));
            }
            let request = TurnRequest { cwd: cwd.into(), prompt: text, resume, read_only: shared.options.read_only, model };
            let end = {
                let mut emit = |text: &str| shared.chunk(&session_id, text);
                let mut on_tool = |event: ToolEvent| shared.tool_event(&session_id, event);
                run_turn(&*shared.profile, &shared.label, &request, &shared.options.limits, &ctl, shared.tools.as_ref(), &mut emit, &mut on_tool)
            };
            // The next prompt may arrive the moment the answer is out, so the slot is freed first.
            *shared.active.lock() = None;
            match end {
                TurnEnd::Done { provider_session } => {
                    if let (Some(provider), true) = (provider_session.filter(|p| !p.trim_start().starts_with('-')), shared.has_memory) {
                        if let Some(session) = shared.sessions.lock().get_mut(&session_id) {
                            session.provider_session = Some(provider);
                            shared.remember(&session_id, session);
                        }
                    }
                    shared.reply(&id, json!({"stopReason": "end_turn"}));
                }
                TurnEnd::Cancelled => shared.reply(&id, json!({"stopReason": "cancelled"})),
                TurnEnd::Failed(sentence) => shared.fail(&id, RPC_FAILED, &sentence),
            }
            }
        });
    match spawned {
        Ok(handle) => Some(handle),
        Err(_) => {
            turn_not_started(&on_failure.0, &on_failure.1);
            None
        }
    }
}

/// The turn thread could not be created: free the slot (or every later message would be refused as
/// "still being answered") and tell the host, which is waiting for this request's answer.
fn turn_not_started(shared: &Shared, id: &Value) {
    *shared.active.lock() = None;
    shared.fail(id, RPC_FAILED, "Could not start answering this message. Try again.");
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_turn_thread_that_cannot_start_frees_the_slot_and_answers_the_request() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let shared = Shared {
            out: Mutex::new(Box::new(Capture(written.clone()))),
            profile: crate::tui::profile_for("claude"),
            label: "claude".into(),
            options: ServeOptions::default(),
            has_memory: false,
            model_list: None,
            models: Mutex::new(None),
            tools: None,
            store: Store::new(None, "x"),
            sessions: Mutex::new(HashMap::new()),
            active: Mutex::new(Some(Active { session: "s".into(), ctl: TurnControl::new() })),
            next_session: Mutex::new(0),
        };
        turn_not_started(&shared, &json!(7));
        assert!(shared.active.lock().is_none(), "the next message must not be refused as busy");
        let out = String::from_utf8(written.lock().clone()).unwrap();
        let reply: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(reply["id"], json!(7));
        assert!(reply["error"]["message"].is_string());
    }

    #[test]
    fn file_blocks_become_a_line_with_the_path_and_images_stay_refused() {
        let link = json!({"type": "resource_link", "uri": "file:///C:/my%20files/a.txt", "name": "a.txt"});
        let embedded = json!({"type": "resource", "resource": {"uri": "file:///h/b.rs", "text": "fn main() {}"}});
        let image = json!({"type": "image", "data": "AQID", "mimeType": "image/png"});
        let only_link = json!({"prompt": [link.clone()]});
        assert_eq!(prompt_text(&only_link), "[attached file: C:/my files/a.txt]");
        let all = json!({"prompt": [{"type": "text", "text": "read"}, link, embedded, image.clone()]});
        assert_eq!(prompt_text(&all), "read\n\n[attached file: C:/my files/a.txt]\n\n[attached file: /h/b.rs]");
        assert_eq!(prompt_text(&json!({"prompt": [image]})), "", "an image alone is still refused");
    }
}
