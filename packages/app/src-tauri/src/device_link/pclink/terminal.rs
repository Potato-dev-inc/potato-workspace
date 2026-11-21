//! P2.3: a terminal pane on this PC, for a paired PC. The rows are in `calls.rs` (`// ---- P2.3 terminal ----`); each one runs the
//! same inner function the Tauri pane command runs (`commands/panes.rs`), against this PC's own pane registry.
//!
//! - A far keystroke only ever goes into the pty (`registry_write_input`). It is never read as a command by this app, and not logged.
//! - A far PC opens a shell, never an arbitrary program (`shell_agent`), in a folder this PC already knows, up to [`MAX_SHELLS_PER_PC`] at once.
//! - Terminal output reaches a PC as `app` frames (`events.rs`); [`throttle`] keeps one PC from being fed more than [`RATE`] bytes a second.
//!   What it drops the viewer redraws from the screen replay (it is told with a `terminal-lag` frame).

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

type Reply = (u16, Value);

/// Shells one paired PC may have open on this PC at the same time.
pub const MAX_SHELLS_PER_PC: usize = 8;
/// Output a PC is fed: bytes a second, and the burst that may build up.
pub const RATE: f64 = 256.0 * 1024.0;
pub const BURST: f64 = 1024.0 * 1024.0;
/// A viewer that was told to redraw is told again no sooner than this (it redraws a little later than this).
const LAG_EVERY: Duration = Duration::from_millis(500);

/// The shell a far PC gets when it asks for "a shell": this machine's own login shell.
pub fn shell_agent(agent_type: &str) -> Option<&'static str> {
    match agent_type {
        "shell" => Some(if cfg!(windows) { "powershell" } else if cfg!(target_os = "macos") { "cmd" } else { "bash" }),
        "cmd" => Some("cmd"),
        "powershell" => Some("powershell"),
        "bash" => Some("bash"),
        _ => None,
    }
}

/// Whether `node` may open one more shell, given the panes that are alive now. Forgets the ones that are gone.
pub(super) fn admit(shells: &mut HashMap<String, HashSet<String>>, node: &str, alive: &HashSet<String>, cap: usize) -> bool {
    let mine = shells.entry(node.to_string()).or_default();
    mine.retain(|id| alive.contains(id));
    mine.len() < cap
}

/// What the app gives the terminal rows: its pane registry and (for the shell) a known folder.
#[cfg_attr(test, allow(dead_code))] // (a test never reaches a real pane: see `run`)
pub struct Env<'a> {
    pub registry: &'a std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    pub app: &'a tauri::AppHandle,
    /// A folder (path or project id) to the path of the project this PC knows by it.
    pub folder: &'a dyn Fn(&str) -> Option<String>,
}

/// Whether `cmd` is one of the terminal rows of `calls.rs`.
pub fn handles(cmd: &str) -> bool {
    matches!(cmd, "list_panes" | "spawn_pane" | "write_pane_input" | "resize_pane" | "kill_pane_cmd" | "read_pane_screen_replay" | "read_pane_raw_buffer")
}

/// The real work: it reaches the pane registry and the window, which a test exe cannot load (`0xc0000139`), so tests do not build it.
#[cfg(not(test))]
mod run {
    use std::collections::{HashMap, HashSet};
    use std::sync::{LazyLock, Mutex};

    use serde_json::{json, Value};

    use super::super::calls::{arg, text_arg};
    use super::{admit, shell_agent, Env, Reply, MAX_SHELLS_PER_PC};

    /// Text one keystroke call may carry.
    const MAX_INPUT_BYTES: usize = 64 * 1024;
    /// The most lines of raw history one read returns.
    const MAX_RAW_LINES: usize = 10_000;

    fn bad(code: &str, message: &str) -> Reply {
        (400, json!({ "code": code, "error": message }))
    }

    fn failed(text: &str) -> Reply {
        (409, json!({ "code": "COMMAND_FAILED", "error": text }))
    }

    /// The shells each paired PC opened here and that may still be open.
    static SHELLS: LazyLock<Mutex<HashMap<String, HashSet<String>>>> = LazyLock::new(Default::default);

    fn is_terminal(env: &Env<'_>, pane: &str) -> Result<(), Reply> {
        if env.registry.lock().get(pane).is_none() || crate::pty::hidden::is_hidden(pane) {
            return Err((404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(pane) })));
        }
        if crate::acp::chat::is_chat_pane(env.registry, pane) {
            return Err((409, json!({ "code": "NOT_A_TERMINAL", "error": "This is a chat. Send it a message instead." })));
        }
        Ok(())
    }

    fn audit(node: &str, pane: &str, summary: &str) {
        crate::audit::record(crate::audit::Kind::ShellExec, crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))), summary, json!({ "pane_id": pane }));
    }

    fn grid(args: &Value, key: &str, low: u16, high: u16) -> Option<u16> {
        arg(args, key).and_then(Value::as_u64).map(|n| (n.min(u64::from(high)) as u16).max(low))
    }

    /// One terminal call from a paired PC; `None` when `cmd` is not a terminal row. The level and the pane's own rule were checked before.
    pub fn call(env: &Env<'_>, node: &str, cmd: &str, args: &Value) -> Option<Reply> {
        Some(match cmd {
            "list_panes" => {
                // Terminal panes only, none the person shut for other PCs. Chats have their own list.
                let rows: Vec<_> = env.registry.lock().list().into_iter().filter(|p| p.lane.as_deref() != Some(crate::acp::chat::LANE) && crate::mobile_pairing::pane_rules::rule(&p.id).remote).collect();
                (200, serde_json::to_value(rows).unwrap_or(Value::Null))
            }
            "spawn_pane" => spawn(env, node, args),
            "write_pane_input" => {
                let Some(pane) = text_arg(args, "paneId") else { return Some(bad("INVALID_ARGUMENT", "paneId is required")) };
                let inner = arg(args, "args").unwrap_or(args);
                let Some(text) = arg(inner, "text").and_then(Value::as_str) else { return Some(bad("INVALID_ARGUMENT", "text is required")) };
                if text.len() > MAX_INPUT_BYTES {
                    return Some((413, json!({ "code": "PAYLOAD_TOO_LARGE", "error": "That is too much to type at once." })));
                }
                let newline = arg(inner, "appendNewline").and_then(Value::as_bool).unwrap_or(true);
                if let Err(refused) = is_terminal(env, &pane) {
                    return Some(refused);
                }
                // The text goes into the pty and nowhere else: no opencode API route, no model.
                match crate::pty::registry_write_input(env.registry, env.app, &pane, text, newline, false, None, crate::pty::WriteOrigin::User) {
                    Ok(()) => (200, Value::Null),
                    Err(text) => failed(&text),
                }
            }
            "resize_pane" => {
                let (Some(pane), Some(cols), Some(rows)) = (text_arg(args, "paneId"), grid(args, "cols", 20, 400), grid(args, "rows", 5, 200)) else {
                    return Some(bad("INVALID_ARGUMENT", "paneId, cols and rows are required"));
                };
                if let Err(refused) = is_terminal(env, &pane) {
                    return Some(refused);
                }
                match crate::commands::resize_applied(env.registry, &pane, cols, rows) {
                    Ok(()) => (200, Value::Null),
                    Err(text) => failed(&text),
                }
            }
            "read_pane_screen_replay" | "read_pane_raw_buffer" | "kill_pane_cmd" => {
                let Some(pane) = text_arg(args, "paneId") else { return Some(bad("INVALID_ARGUMENT", "paneId is required")) };
                if let Err(refused) = is_terminal(env, &pane) {
                    return Some(refused);
                }
                match cmd {
                    "read_pane_screen_replay" => match crate::pty::registry_read_screen_replay_at(env.registry, &pane) {
                        Ok((data, cols, rows, offset)) => {
                            // Looking at it: its output comes from here on (before the screen is read, so no byte falls between).
                            super::watch(node, &pane);
                            (200, json!({ "data": data, "cols": cols, "rows": rows, "offset": offset }))
                        }
                        Err(text) => failed(&text),
                    },
                    "read_pane_raw_buffer" => {
                        let lines = arg(args, "lines").and_then(Value::as_u64).map_or(MAX_RAW_LINES, |n| (n as usize).min(MAX_RAW_LINES));
                        match crate::pty::registry_read_raw_buffer(env.registry, &pane, lines) {
                            Ok(bytes) => (200, json!(bytes)),
                            Err(text) => failed(&text),
                        }
                    }
                    _ => match crate::pty::registry_kill_pane_and_helpers(env.registry, &pane, None) {
                        Ok(()) => {
                            audit(node, &pane, "A paired PC closed a terminal");
                            (200, Value::Null)
                        }
                        Err(text) => failed(&text),
                    },
                }
            }
            _ => return None,
        })
    }

    fn spawn(env: &Env<'_>, node: &str, args: &Value) -> Reply {
        let inner = arg(args, "args").unwrap_or(args);
        let Some(agent) = shell_agent(&text_arg(inner, "agentType").unwrap_or_else(|| "shell".into())) else {
            return bad("NOT_A_SHELL", "A PC can open a shell here. To start an agent, use New agent.");
        };
        let Some(folder) = text_arg(inner, "cwd").and_then(|c| (env.folder)(&c)) else {
            return (404, json!({ "code": "UNKNOWN_PROJECT", "error": "This PC does not know that folder. Open it here first." }));
        };
        {
            let alive: HashSet<String> = env.registry.lock().list_all().into_iter().map(|p| p.id).collect();
            if !admit(&mut SHELLS.lock().unwrap_or_else(|p| p.into_inner()), node, &alive, MAX_SHELLS_PER_PC) {
                return (429, json!({ "code": "TOO_MANY_SHELLS", "error": format!("That PC already has {MAX_SHELLS_PER_PC} terminals open here. Close one first.") }));
            }
        }
        let spawn_args = crate::pty::SpawnPaneArgs {
            agent_type: agent.to_string(),
            cwd: Some(folder),
            cols: grid(inner, "cols", 20, 400),
            rows: grid(inner, "rows", 5, 200),
            extra_args: None,
            pane_id: None,
            read_only: false,
            account: None,
            guard_env: None,
        };
        match crate::pty::registry_spawn_pane(env.registry, env.app, spawn_args) {
            Ok(id) => {
                SHELLS.lock().unwrap_or_else(|p| p.into_inner()).entry(node.to_string()).or_default().insert(id.clone());
                audit(node, &id, "A paired PC opened a terminal");
                (200, json!(id))
            }
            Err(text) => failed(&text),
        }
    }
}

#[cfg(not(test))]
pub use run::call;
/// A test never reaches a real pane.
#[cfg(test)]
pub fn call(_: &Env<'_>, _: &str, _: &str, _: &Value) -> Option<Reply> {
    None
}

// ----- the output rate -----

/// One PC's allowance of output bytes.
pub struct Bucket {
    tokens: f64,
    at: Instant,
    told: Option<Instant>,
}

/// What to do with one chunk of terminal output.
#[derive(Debug, PartialEq, Eq)]
pub enum Take {
    Send,
    /// Over the rate: not sent. Tell the viewer to redraw.
    Lag,
    /// Over the rate: not sent. The viewer was told a moment ago.
    Drop,
}

impl Bucket {
    pub fn new(now: Instant) -> Self {
        Self { tokens: BURST, at: now, told: None }
    }

    pub fn take(&mut self, now: Instant, bytes: usize) -> Take {
        self.tokens = (self.tokens + now.saturating_duration_since(self.at).as_secs_f64() * RATE).min(BURST);
        self.at = now;
        if self.tokens >= bytes as f64 {
            self.tokens -= bytes as f64;
            return Take::Send;
        }
        if self.told.is_some_and(|t| now.saturating_duration_since(t) < LAG_EVERY) {
            return Take::Drop;
        }
        self.told = Some(now);
        Take::Lag
    }
}

/// The terminals each PC has read the screen of: only their output and size are sent to it (a PC is not fed every pane on this PC).
static WATCHED: LazyLock<Mutex<HashMap<String, HashSet<String>>>> = LazyLock::new(Default::default);
/// Terminals one PC may have in view at once.
const MAX_WATCHED: usize = 64;

/// `node` is looking at terminal `pane`: its output reaches that PC from now on.
pub fn watch(node: &str, pane: &str) {
    let mut all = WATCHED.lock().unwrap_or_else(|p| p.into_inner());
    let mine = all.entry(node.to_string()).or_default();
    if mine.len() < MAX_WATCHED {
        mine.insert(pane.to_string());
    }
}

fn watching(node: &str, pane: &str) -> bool {
    WATCHED.lock().unwrap_or_else(|p| p.into_inner()).get(node).is_some_and(|mine| mine.contains(pane))
}

static BUCKETS: LazyLock<Mutex<HashMap<String, Bucket>>> = LazyLock::new(Default::default);

/// The frame `node` is sent for one `app` frame: terminal output and size go only for terminals it looks at, and output is metered; a chunk over the rate becomes a `terminal-lag` frame
/// (or nothing). Every other frame passes.
pub fn throttle(node: &str, frame: String) -> Option<String> {
    if !frame.contains("\"terminal-data\"") && !frame.contains("\"pty://resized\"") {
        return Some(frame);
    }
    let data: Value = frame.split_once("data: ").and_then(|(_, d)| serde_json::from_str(d.trim()).ok())?;
    // A terminal this PC never read the screen of, or one that is a hidden helper's, sends it nothing.
    let pane = data["payload"]["pane_id"].as_str()?;
    if !watching(node, pane) || crate::pty::hidden::is_hidden(pane) {
        return None;
    }
    if data["event"] == "pty://resized" {
        return Some(frame);
    }
    let bytes = data["payload"]["b64"].as_str().map_or(0, |b| b.len() / 4 * 3);
    let take = BUCKETS.lock().unwrap_or_else(|p| p.into_inner()).entry(node.to_string()).or_insert_with(|| Bucket::new(Instant::now())).take(Instant::now(), bytes);
    match take {
        Take::Send => Some(frame),
        Take::Lag => Some(super::events::app_frame("terminal-lag", &json!({ "pane_id": data["payload"]["pane_id"] }))),
        Take::Drop => None,
    }
}
