//! Chrome DevTools Protocol (CDP) calls into a preview window, in this process (N5-23, P0).
//!
//! WebView2 can run a DevTools method on the page it shows (`CallDevToolsProtocolMethod`) and tell us about
//! DevTools events (`GetDevToolsProtocolEventReceiver`). Both stay inside the app: **no debugging port is opened**,
//! so no other program on this computer can reach the page this way. (If a build ever needs a port, the fallback is
//! a random `127.0.0.1` port; the proof in `examples/browser_proof.rs` shows that this is not needed.)
//!
//! Threads: a call must come from a worker thread, never the main thread. It hands the WebView2 call to the main
//! thread with `with_webview` (which returns at once), the completion callback also runs on the main thread, sends
//! the answer over a channel, and this side waits on the channel with a timeout.

use serde_json::Value;
use std::sync::mpsc;
use std::time::Duration;

/// How long one DevTools call may take before we give up on it.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(8);

/// Why a DevTools call did not give an answer. `message()` is the sentence an agent sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpError {
    /// The window is closed.
    Closed,
    /// WebView2 never answered.
    Timeout,
    /// This computer has no DevTools bridge for pages (not Windows).
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    /// DevTools refused the call (the method, or the node it names, is not there).
    Failed(String),
}

impl CdpError {
    pub fn message(&self) -> String {
        match self {
            CdpError::Closed => "The browser window is closed.".into(),
            CdpError::Timeout => "The page did not answer in time.".into(),
            CdpError::Unsupported => "The agent browser needs Windows for now.".into(),
            CdpError::Failed(why) => format!("The page refused that ({why})."),
        }
    }
}

/// One DevTools session on one page. The live one is [`WindowCdp`]; tests use a fake that answers from a script.
pub trait Cdp: Send + Sync {
    /// Runs `method` with `params` and returns the `result` object.
    fn call(&self, method: &str, params: Value) -> Result<Value, CdpError>;
}

/// The answer text of one call as JSON (WebView2 gives an empty text or `{}` for methods with no result).
pub fn parse_answer(text: &str) -> Result<Value, CdpError> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str::<Value>(text).map_err(|e| CdpError::Failed(format!("bad answer: {e}")))
}

/// Waits for the answer on the channel; a closed channel means the callback never ran (the window went away).
pub fn wait_answer(rx: &mpsc::Receiver<Result<String, CdpError>>, timeout: Duration) -> Result<Value, CdpError> {
    match rx.recv_timeout(timeout) {
        Ok(result) => result.and_then(|text| parse_answer(&text)),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(CdpError::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CdpError::Closed),
    }
}

/// Where DevTools events go: the method name (`Runtime.consoleAPICalled`) and its parameters.
pub type EventSink = std::sync::Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The DevTools session of one Tauri webview window.
pub struct WindowCdp {
    window: tauri::WebviewWindow,
}

impl WindowCdp {
    pub fn new(window: tauri::WebviewWindow) -> Self {
        WindowCdp { window }
    }

    /// Sends each of `events` to `sink` (the domains are enabled by the caller). Call from a worker thread. The
    /// handlers live as long as the window.
    #[cfg(windows)]
    pub fn subscribe(&self, events: &'static [&'static str], sink: EventSink) -> Result<(), CdpError> {
        let (tx, rx) = mpsc::channel::<Result<String, CdpError>>();
        self.window.with_webview(move |pv| live::subscribe(&pv, events, sink, tx)).map_err(|_| CdpError::Closed)?;
        wait_answer(&rx, CALL_TIMEOUT).map(|_| ())
    }

    #[cfg(not(windows))]
    pub fn subscribe(&self, _events: &'static [&'static str], _sink: EventSink) -> Result<(), CdpError> {
        let _ = &self.window;
        Err(CdpError::Unsupported)
    }
}

#[cfg(windows)]
impl Cdp for WindowCdp {
    fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        let (tx, rx) = mpsc::channel::<Result<String, CdpError>>();
        let (method, params) = (method.to_string(), params.to_string());
        self.window.with_webview(move |pv| live::start(&pv, &method, &params, tx)).map_err(|_| CdpError::Closed)?;
        wait_answer(&rx, CALL_TIMEOUT)
    }
}

#[cfg(not(windows))]
impl Cdp for WindowCdp {
    fn call(&self, _method: &str, _params: Value) -> Result<Value, CdpError> {
        Err(CdpError::Unsupported)
    }
}

#[cfg(windows)]
mod live {
    use super::{CdpError, EventSink};
    use serde_json::Value;
    use std::sync::mpsc::Sender;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventArgs;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
    use windows::core::{HSTRING, PWSTR};

    /// Main thread only. Starts the call; the answer goes to `tx` from the completion callback.
    pub fn start(pv: &tauri::webview::PlatformWebview, method: &str, params: &str, tx: Sender<Result<String, CdpError>>) {
        // SAFETY: COM calls on the main (UI) thread, which owns the controller.
        unsafe {
            let core = match pv.controller().CoreWebView2() {
                Ok(core) => core,
                Err(_) => return drop(tx.send(Err(CdpError::Closed))),
            };
            let done = tx.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
                let _ = done.send(match hr {
                    Ok(()) => Ok(json),
                    Err(e) => Err(CdpError::Failed(format!("{e}"))),
                });
                Ok(())
            }));
            if let Err(e) = core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler) {
                let _ = tx.send(Err(CdpError::Failed(format!("{e}"))));
            }
        }
    }

    /// Main thread only. Adds one event handler per event name; answers `{}` on `tx` when all are added.
    pub fn subscribe(
        pv: &tauri::webview::PlatformWebview,
        events: &'static [&'static str],
        sink: EventSink,
        tx: Sender<Result<String, CdpError>>,
    ) {
        // SAFETY: COM calls on the main (UI) thread.
        unsafe {
            let core = match pv.controller().CoreWebView2() {
                Ok(core) => core,
                Err(_) => return drop(tx.send(Err(CdpError::Closed))),
            };
            for name in events {
                let receiver = match core.GetDevToolsProtocolEventReceiver(&HSTRING::from(*name)) {
                    Ok(receiver) => receiver,
                    Err(e) => return drop(tx.send(Err(CdpError::Failed(format!("{e}"))))),
                };
                let sink = sink.clone();
                let event = *name;
                let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    if let Some(json) = args.as_ref().and_then(parameters) {
                        sink(event, json);
                    }
                    Ok(())
                }));
                let mut token = 0i64;
                if let Err(e) = receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) {
                    return drop(tx.send(Err(CdpError::Failed(format!("{e}")))));
                }
            }
            let _ = tx.send(Ok("{}".to_string()));
        }
    }

    fn parameters(args: &ICoreWebView2DevToolsProtocolEventReceivedEventArgs) -> Option<Value> {
        let mut text = PWSTR::null();
        // SAFETY: WebView2 fills `text` with a CoTaskMem string that `take_pwstr` frees.
        unsafe { args.ParameterObjectAsJson(&mut text).ok()? };
        serde_json::from_str(&webview2_com::take_pwstr(text)).ok()
    }
}
