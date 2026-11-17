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
use tauri::{AppHandle, Manager};

/// The setting behind the Labs switch (Settings > Labs > Agent browser). A development build reads it as on.
pub const LABS_KEY: &str = "agent_browser_enabled";
/// How long `browser_open` waits for the page to finish loading.
const LOAD_WAIT: Duration = Duration::from_secs(15);
/// The bar loop: how often it looks at the page while an agent is using it, and otherwise.
const FAST: Duration = Duration::from_millis(300);
const SLOW: Duration = Duration::from_millis(1500);

struct LiveTab {
    /// The chat the agent that opened the page runs in (where a mark-up goes), when it said.
    owner: Mutex<Option<String>>,
    tab: Arc<Tab>,
    preview_id: String,
    origin: crate::point::origin::PreviewOrigin,
    cdp: Arc<WindowCdp>,
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
    // "Leaving my desk" with the screen lock on: agents do not use this PC's pages until the person is back.
    if crate::mobile_pairing::desk_away::screen_locked() {
        return Err(ToolError::new("SCREEN_LOCKED", "Screen control is locked while the person is away. It opens again when they press I'm back."));
    }
    if tool == "browser_open" {
        return open(app, actor, args, true);
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

/// The open tab for this origin, or the one in the window the person opened (every agent joins that one).
fn known_tab(app: &AppHandle, origin: &crate::point::origin::PreviewOrigin) -> Option<Arc<LiveTab>> {
    let shared = window::shared_window_id();
    TABS.lock().values().find(|t| (t.origin == *origin || Some(&t.preview_id) == shared.as_ref()) && window::browser_window(app, &t.preview_id).is_some()).cloned()
}

/// The person opened the browser window (the globe button) and may say "use this page": it is the window the agent's
/// tools work on now. Nothing is attached to it until an agent uses a tool (and only with the Labs switch on).
pub fn adopt_person_window(id: &str) {
    *CURRENT.lock() = Some(id.to_string());
}

fn current(app: &AppHandle) -> Result<Arc<LiveTab>, ToolError> {
    let shared = window::shared_window_id();
    let id = CURRENT.lock().clone().or_else(|| shared.clone());
    let existing = id.as_ref().and_then(|id| TABS.lock().get(id).cloned());
    let live = match (existing, &id) {
        (Some(live), _) => Some(live),
        (None, Some(id)) if Some(id) == shared.as_ref() => {
            // The person's window has no tab yet: the first tool call joins it.
            let origin = crate::point::origin::PreviewOrigin { scheme: "about".into(), host: "blank".into(), port: 0 };
            Some(tab_for(app, id, origin)?)
        }
        _ => None,
    };
    match live {
        Some(live) if window::browser_window(app, &live.preview_id).is_some() => Ok(live),
        _ => Err(ToolError::new("NO_PAGE", "No page is open. Call browser_open with the address of the app first.")),
    }
}

/// "Check it in the browser" (R4-11): opens the page, then answers pass or fail with the console problems and a
/// picture. The person asked for it (a button), so it gives them the page back first: a take-over, or a sign-in
/// wait they have finished, does not stand in the way. Call from a worker thread.
pub fn check_it(app: &AppHandle, url: &str, session: &str) -> Result<Value, ToolError> {
    if !enabled(app) {
        return Err(ToolError::new("BROWSER_OFF", "The agent browser is off. Turn it on in Settings > Labs > Agent browser."));
    }
    if crate::mobile_pairing::desk_away::screen_locked() {
        return Err(ToolError::new("SCREEN_LOCKED", "Screen control is locked while the person is away. It opens again when they press I'm back."));
    }
    let actor = Actor { label: "Check it".to_string(), session: session.to_string() };
    let dev_port = app.config().build.dev_url.as_ref().and_then(|u| u.port());
    let (_, origin) = guard::check_url(url, dev_port).map_err(|(code, message)| ToolError::new(code, message))?;
    let known = known_tab(app, &origin);
    if let Some(known) = known {
        known.tab.give_back();
    }
    let opened = open(app, &actor, &json!({ "url": url }), false)?;
    let loaded = opened.get("loaded").and_then(Value::as_bool).unwrap_or(false);
    current(app)?.tab.check(&actor, loaded)
}

fn open(app: &AppHandle, actor: &Actor, args: &Value, watch_sign_in: bool) -> Result<Value, ToolError> {
    // `artifact`: the agent's own page, on this computer (the app-only address; see `artifacts::serve`). Only the chat the
    // agent is in can open its pages, and the answer never carries the address (it holds a secret token).
    let artifact = args.get("artifact").and_then(Value::as_str);
    let made;
    let url = match artifact {
        Some(id) => {
            made = artifact_address(app, actor, id)?;
            made.as_str()
        }
        None => args.get("url").and_then(Value::as_str).ok_or_else(|| ToolError::new("INVALID_ARGUMENT", "url is required, for example http://localhost:5173/. Or pass artifact with the id of your own page."))?,
    };
    let dev_port = app.config().build.dev_url.as_ref().and_then(|u| u.port());
    let (url, origin) = guard::check_url(url, dev_port).map_err(|(code, message)| ToolError::new(code, message))?;
    // The person may have the page: do not even touch the window then.
    let known = known_tab(app, &origin);
    if let Some(known) = &known {
        match known.tab.driver.lock().phase() {
            Phase::Paused { stopped: true } => return Err(ToolError::new(super::driver::STOPPED.code, super::driver::STOPPED.message)),
            Phase::Paused { stopped: false } => return Err(ToolError::new(super::driver::PAUSED.code, super::driver::PAUSED.message)),
            Phase::SignIn => return Err(ToolError::new(super::driver::SIGN_IN.code, super::driver::SIGN_IN.message)),
            _ => {}
        }
    }
    let show = if std::env::var("PM_BROWSER_HIDDEN").map(|v| v == "1").unwrap_or(false) { Show::Hidden } else { Show::Beside };
    let owner = crate::mcp_sessions::claimed_session_pane(&actor.session);
    let info = window::open_for_browser(app, &url, origin.clone(), show, owner).map_err(|m| ToolError::new("WINDOW_FAILED", m))?;
    let live = tab_for(app, &info.preview_id, origin.clone())?;
    if let Some(pane) = crate::mcp_sessions::claimed_session_pane(&actor.session) {
        *live.owner.lock() = Some(pane);
    }
    *CURRENT.lock() = Some(info.preview_id.clone());
    let site = format!("{}:{}", origin.host, origin.port);
    live.tab.set_site(&site);
    let opened = live.tab.step(actor, &format!("Open {site}"), || {
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
    })?;
    let mut opened = if watch_sign_in { live.tab.watch_sign_in(actor, opened) } else { opened };
    if let (Some(id), Some(map)) = (artifact, opened.as_object_mut()) {
        map.insert("opened".to_string(), Value::String(format!("artifact:{id}")));
    }
    Ok(opened)
}

/// The app-only address of one of the calling agent's own pages. The chat is the one the agent's MCP connection says it
/// runs in; another chat's page, or a page that is not there, is the same answer (no path in it).
fn artifact_address(app: &AppHandle, actor: &Actor, id: &str) -> Result<String, ToolError> {
    const NOT_YOURS: (&str, &str) = ("NOT_YOUR_PAGE", "That page is not one of yours. Open a page you made with show_artifact.");
    let pane = crate::mcp_sessions::claimed_session_pane(&actor.session).ok_or_else(|| ToolError::new(NOT_YOURS.0, NOT_YOURS.1))?;
    let state = app.state::<crate::commands::AppState>();
    let cwd = state.registry.lock().get(&pane).map(|p| p.info.cwd.clone()).filter(|c| !c.trim().is_empty()).ok_or_else(|| ToolError::new(NOT_YOURS.0, NOT_YOURS.1))?;
    crate::artifacts::open_tab_address(std::path::PathBuf::from(cwd), id, &pane).map_err(|_| ToolError::new(NOT_YOURS.0, NOT_YOURS.1))
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
    let live = Arc::new(LiveTab { owner: Mutex::new(None), tab, preview_id: preview_id.to_string(), origin, cdp });
    TABS.lock().insert(preview_id.to_string(), live.clone());
    let (loop_app, loop_live, bar_key, markup_key) = (app.clone(), live.clone(), win.bar_key, win.markup_key);
    std::thread::spawn(move || bar_loop(loop_app, loop_live, bar_key, markup_key));
    Ok(live)
}

/// Keeps the bar in step with the driver and carries the person's clicks on it back to the driver.
fn bar_loop(app: AppHandle, live: Arc<LiveTab>, key: String, markup_key: String) {
    let mut shown = false;
    loop {
        let Some((_, webview)) = window::browser_window(&app, &live.preview_id) else { break };
        let active = live.tab.driver.lock().phase() != Phase::Idle;
        std::thread::sleep(if active { FAST } else { SLOW });
        let now = live.tab.now();
        if let Some(raw) = window::ask_text(&webview, bar::call(&key, "take", "")) {
            let mut gave_back = false;
            let mut driver = live.tab.driver.lock();
            for event in bar::parse_events(&raw) {
                match event.kind {
                    BarKind::Takeover => driver.take_over(),
                    BarKind::Stop => driver.stop(),
                    BarKind::Giveback => gave_back = true,
                    BarKind::Point => {
                        // One tool: with "Mark up pages" on, Point is the mark-up bar's Select tool.
                        if window::markup_on(&app) {
                            let _ = webview.eval(crate::markup::bar::set_script(&markup_key, &json!({ "open": true })));
                        } else {
                            window::arm_preview(&app, &live.preview_id);
                        }
                    }
                    BarKind::Input => {
                        driver.person_input(event.at);
                    }
                }
                if gave_back {
                    // Give back and Continue are one button; after a sign-in wait the tab also remembers the page.
                    drop(driver);
                    live.tab.give_back();
                    gave_back = false;
                    driver = live.tab.driver.lock();
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

/// The page of this preview moved to a new webview (pop out, dock back): the tools and the console follow it.
pub fn rebind(app: &AppHandle, preview_id: &str) {
    let Some(live) = TABS.lock().get(preview_id).cloned() else { return };
    let Some((_, webview)) = window::browser_window(app, preview_id) else { return };
    live.cdp.rebind(webview);
    let sink_log = live.tab.log.clone();
    let _ = live.tab.page.prepare();
    let _ = live.cdp.subscribe(console::EVENTS, Arc::new(move |event, params| sink_log.lock().ingest(event, &params)));
}

// ---- the mark-up bar's hooks (see `markup::live`) ----

/// The chat of the agent that opened the page in this window, if it said.
pub fn owner_pane(preview_id: &str) -> Option<String> {
    TABS.lock().get(preview_id).and_then(|t| t.owner.lock().clone())
}

/// While the person marks up, the agent waits (the same gate as Take over). Returns whether this call paused the agent
/// (so only that one gives it back). A window no agent has used has no tab and nothing to pause.
pub fn pause_for_markup(preview_id: &str, on: bool, we_paused: bool) -> bool {
    let Some(live) = TABS.lock().get(preview_id).cloned() else { return false };
    if on {
        let mut driver = live.tab.driver.lock();
        if driver.phase() == Phase::Idle {
            return false;
        }
        let was_paused = matches!(driver.phase(), Phase::Paused { .. });
        driver.take_over();
        audit::record(Kind::Browser, Who::Desktop, "Paused the agent while the person marks up the page.", json!({}));
        return !was_paused;
    }
    if we_paused {
        live.tab.give_back();
        audit::record(Kind::Browser, Who::Desktop, "Gave the page back to the agent after the mark-up.", json!({}));
    }
    false
}

/// The id the agent would use for a marked element (`e17`), when it has read the page and one thing has that name.
pub fn ref_for(preview_id: &str, text: &str, label: &str) -> Option<String> {
    let live = TABS.lock().get(preview_id).cloned()?;
    let refs = live.tab.page.known_refs();
    let wanted: Vec<String> = [label, text].iter().map(|w| w.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|w| !w.is_empty()).collect();
    for want in &wanted {
        let mut hits = refs.iter().filter(|r| !r.name.is_empty() && (r.name == *want || (want.chars().count() >= 8 && want.starts_with(&r.name))));
        if let (Some(first), None) = (hits.next(), hits.next()) {
            return Some(first.id.clone());
        }
    }
    None
}
