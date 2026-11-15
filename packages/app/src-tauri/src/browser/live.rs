//! The live side of the agent browser: the preview window, the tab behind it, the bar loop and the tool entry (N5-23).
//!
//! The rules are in the other files (`guard`, `driver`, `page`, `tab`); this file puts a real window under them.
//! The window is the Point and Fix preview window (`point::window`), so Point is a button in the same page.

use super::bar::{self, BarKind};
use super::cdp::WindowCdp;
use super::console::{self, ConsoleLog};
use super::driver::Phase;
use super::guard;
use super::page::{Page, ToolError};
use super::tab::{Actor, Env, Tab};
use crate::audit::{self, Kind, Who};
use crate::point::window::{self, Show};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

/// The setting behind the Labs switch (Settings > Labs > Agent browser). A development build reads it as on.
pub const LABS_KEY: &str = "agent_browser_enabled";
/// How long `browser_open` waits for the page to finish loading.
const LOAD_WAIT: Duration = Duration::from_secs(15);
/// The bar loop: how often it looks at the page while an agent is using it, and otherwise.
const FAST: Duration = Duration::from_millis(300);
const SLOW: Duration = Duration::from_millis(1500);

struct LiveTab {
    tab: Arc<Tab>,
    preview_id: String,
    origin: crate::point::origin::PreviewOrigin,
}

static TABS: Lazy<Mutex<HashMap<String, Arc<LiveTab>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// The preview window the agents used last: the one `browser_read` and the others work on.
static CURRENT: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

struct LiveEnv;

impl Env for LiveEnv {
    fn now_ms(&self) -> u64 {
        audit::now_ms()
    }

    fn audit(&self, actor: &Actor, line: &str, site: &str) {
        audit::record(Kind::Browser, Who::Agent(actor.session.clone()), &format!("{} used the browser: {line}", actor.label), json!({ "site": site }));
    }
}

/// Whether the Labs switch is on now.
pub fn enabled(app: &AppHandle) -> bool {
    crate::settings_store::read_public_settings(app).get(LABS_KEY).and_then(Value::as_bool).unwrap_or(false)
}

/// The name on the bar for an MCP connection. It is the host's own claim, so it is only a label.
pub fn actor_for(session: &str) -> Actor {
    let label = crate::mcp_sessions::session_client_name(session).unwrap_or_else(|| "An agent".to_string());
    Actor { label, session: session.to_string() }
}

/// The tool entry: `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_console`.
/// Call from a worker thread (it waits for the page).
pub fn run_tool(app: &AppHandle, actor: &Actor, tool: &str, args: &Value) -> Result<Value, ToolError> {
    if tool == "browser_open" {
        return open(app, actor, args);
    }
    let live = current(app)?;
    match tool {
        "browser_read" => live.tab.read(actor, args),
        "browser_click" => live.tab.click(actor, args),
        "browser_type" => live.tab.type_text(actor, args),
        "browser_console" => live.tab.console(actor, args),
        _ => Err(ToolError::new("UNKNOWN_TOOL", "That is not a browser tool.")),
    }
}

fn current(app: &AppHandle) -> Result<Arc<LiveTab>, ToolError> {
    let id = CURRENT.lock().clone();
    let live = id.and_then(|id| TABS.lock().get(&id).cloned());
    match live {
        Some(live) if window::browser_window(app, &live.preview_id).is_some() => Ok(live),
        _ => Err(ToolError::new("NO_PAGE", "No page is open. Call browser_open with the address of the app first.")),
    }
}

fn open(app: &AppHandle, actor: &Actor, args: &Value) -> Result<Value, ToolError> {
    let url = args.get("url").and_then(Value::as_str).ok_or_else(|| ToolError::new("INVALID_ARGUMENT", "url is required, for example http://localhost:5173/."))?;
    let dev_port = app.config().build.dev_url.as_ref().and_then(|u| u.port());
    let (url, origin) = guard::check_url(url, dev_port).map_err(|(code, message)| ToolError::new(code, message))?;
    // The person may have the page: do not even touch the window then.
    let known = TABS.lock().values().find(|t| t.origin == origin && window::browser_window(app, &t.preview_id).is_some()).cloned();
    if let Some(known) = &known {
        match known.tab.driver.lock().phase() {
            Phase::Paused { stopped: true } => return Err(ToolError::new(super::driver::STOPPED.code, super::driver::STOPPED.message)),
            Phase::Paused { stopped: false } => return Err(ToolError::new(super::driver::PAUSED.code, super::driver::PAUSED.message)),
            _ => {}
        }
    }
    let show = if std::env::var("PM_BROWSER_HIDDEN").map(|v| v == "1").unwrap_or(false) { Show::Hidden } else { Show::Beside };
    let info = window::open_for_browser(app, &url, origin.clone(), show).map_err(|m| ToolError::new("WINDOW_FAILED", m))?;
    let live = tab_for(app, &info.preview_id, origin.clone())?;
    *CURRENT.lock() = Some(info.preview_id.clone());
    let site = format!("{}:{}", origin.host, origin.port);
    live.tab.set_site(&site);
    live.tab.step(actor, &format!("Open {site}"), || {
        live.tab.log.lock().clear();
        live.tab.page.go(&url)?;
        let loaded = live.tab.page.wait_ready(LOAD_WAIT);
        let (now_url, title) = live.tab.page.where_am_i()?;
        let value = json!({
            "opened": now_url,
            "title": guard::untrusted("TITLE", &title),
            "loaded": loaded,
            "console_problems": live.tab.log.lock().problems_since(0),
            "tip": "Call browser_read to see the page.",
        });
        Ok((format!("Opened {site}"), value))
    })
}

/// The tab of a preview window; made on first use (domains on, console listening, bar loop running).
fn tab_for(app: &AppHandle, preview_id: &str, origin: crate::point::origin::PreviewOrigin) -> Result<Arc<LiveTab>, ToolError> {
    if let Some(existing) = TABS.lock().get(preview_id).cloned() {
        return Ok(existing);
    }
    let (win, webview) = window::browser_window(app, preview_id).ok_or_else(|| ToolError::new("BROWSER_CLOSED", "The browser window is closed."))?;
    let cdp = Arc::new(WindowCdp::new(webview));
    let page = Page::new(cdp.clone()).with_bar(&win.bar_key);
    page.prepare()?;
    let log = Arc::new(Mutex::new(ConsoleLog::new()));
    let sink_log = log.clone();
    cdp.subscribe(console::EVENTS, Arc::new(move |event, params| sink_log.lock().ingest(event, &params))).map_err(ToolError::from)?;
    let tab = Arc::new(Tab::new(page, log, Arc::new(LiveEnv)));
    let live = Arc::new(LiveTab { tab, preview_id: preview_id.to_string(), origin });
    TABS.lock().insert(preview_id.to_string(), live.clone());
    let (loop_app, loop_live, bar_key) = (app.clone(), live.clone(), win.bar_key);
    std::thread::spawn(move || bar_loop(loop_app, loop_live, bar_key));
    Ok(live)
}

/// Keeps the bar in step with the driver and carries the person's clicks on it back to the driver.
fn bar_loop(app: AppHandle, live: Arc<LiveTab>, key: String) {
    let mut shown = false;
    loop {
        let Some((_, webview)) = window::browser_window(&app, &live.preview_id) else { break };
        let active = live.tab.driver.lock().phase() != Phase::Idle;
        std::thread::sleep(if active { FAST } else { SLOW });
        let now = live.tab.now();
        if let Some(raw) = window::ask_text(&webview, bar::call(&key, "take", "")) {
            let mut driver = live.tab.driver.lock();
            for event in bar::parse_events(&raw) {
                match event.kind {
                    BarKind::Takeover => driver.take_over(),
                    BarKind::Stop => driver.stop(),
                    BarKind::Giveback => driver.give_back(now),
                    BarKind::Point => {
                        window::arm_preview(&app, &live.preview_id);
                    }
                    BarKind::Input => {
                        driver.person_input(event.at);
                    }
                }
            }
        }
        let view = live.tab.driver.lock().view(now);
        // A new page forgets the bar, so a visible bar is sent every time; a hidden one only once.
        if view.visible || shown {
            let _ = webview.eval(bar::show_script(&key, &view));
        }
        shown = view.visible;
    }
    TABS.lock().remove(&live.preview_id);
    let mut current = CURRENT.lock();
    if current.as_deref() == Some(live.preview_id.as_str()) {
        *current = None;
    }
}
