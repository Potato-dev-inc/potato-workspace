//! Reading and acting on one page through DevTools (N5-23): read as text or as a ref list, click, type.
//!
//! Everything goes through the [`Cdp`] trait, so the rules (a stale ref is found again, a password box is never typed
//! in, a click is a real mouse click at the middle of the element) are tested with a fake page.

use super::cdp::{Cdp, CdpError};
use super::guard::{self, FieldFacts};
use super::tree::{self, RefTarget};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// An error with a stable code and a sentence for the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        ToolError { code, message: message.into() }
    }
}

impl From<CdpError> for ToolError {
    fn from(e: CdpError) -> Self {
        let code = match e {
            CdpError::Closed => "BROWSER_CLOSED",
            CdpError::Timeout => "PAGE_TIMEOUT",
            CdpError::Unsupported => "UNSUPPORTED",
            CdpError::Failed(_) => "PAGE_ERROR",
        };
        ToolError::new(code, e.message())
    }
}

/// True when a password box is on the screen (not hidden, not zero size).
const SIGN_IN_JS: &str = "(function(){var p=document.querySelectorAll('input[type=password]');for(var i=0;i<p.length;i++){var e=p[i];var r=e.getBoundingClientRect();var s=getComputedStyle(e);if(r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none')return true}return false})()";

/// The page and the refs the agent was last given.
pub struct Page {
    cdp: Arc<dyn Cdp>,
    refs: Mutex<Vec<RefTarget>>,
    /// How long to wait after a click or typing for the page to react.
    settle: Duration,
    /// The agent bar's hidden name in the page: it is moved out of the way while the agent clicks.
    bar_key: Option<String>,
    /// `performance.timeOrigin` of the page before the last `go` (a new page has a new one).
    origin_before: Mutex<Option<f64>>,
}

/// What one ref is now: the node to act on.
struct Resolved {
    target: RefTarget,
    object_id: String,
    /// Said to the agent when the ref had to be found again.
    note: Option<String>,
}

impl Page {
    pub fn new(cdp: Arc<dyn Cdp>) -> Self {
        Page { cdp, refs: Mutex::new(Vec::new()), settle: Duration::from_millis(200), bar_key: None, origin_before: Mutex::new(None) }
    }

    /// This page has an agent bar under this name (`bar::script`).
    pub fn with_bar(mut self, key: &str) -> Self {
        self.bar_key = Some(key.to_string());
        self
    }

    /// Takes the bar out of the way while the agent clicks (`on`), and shows a soft dot where it clicked.
    fn hold_bar(&self, on: bool, at: Option<(f64, f64)>) {
        let Some(key) = &self.bar_key else { return };
        let args = match at {
            Some((x, y)) => format!("{on},{x},{y}"),
            None => on.to_string(),
        };
        let _ = self.cdp.call("Runtime.evaluate", json!({ "expression": super::bar::call(key, "hold", &args), "returnByValue": true }));
    }

    #[cfg(test)]
    pub fn without_settle(cdp: Arc<dyn Cdp>) -> Self {
        Page { cdp, refs: Mutex::new(Vec::new()), settle: Duration::ZERO, bar_key: None, origin_before: Mutex::new(None) }
    }

    /// Turns on the DevTools domains this page needs. Safe to call again.
    pub fn prepare(&self) -> Result<(), ToolError> {
        for method in ["DOM.enable", "Accessibility.enable", "Runtime.enable", "Log.enable", "Network.enable"] {
            self.cdp.call(method, json!({}))?;
        }
        Ok(())
    }

    fn eval(&self, expression: &str) -> Result<Value, ToolError> {
        let answer = self.cdp.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true }))?;
        if answer.get("exceptionDetails").is_some() {
            return Err(ToolError::new("PAGE_ERROR", "The page could not read that."));
        }
        Ok(answer.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
    }

    /// The address and title of the page now.
    pub fn where_am_i(&self) -> Result<(String, String), ToolError> {
        let v = self.eval("({u:location.href,t:document.title})")?;
        Ok((v.get("u").and_then(Value::as_str).unwrap_or("").to_string(), v.get("t").and_then(Value::as_str).unwrap_or("").to_string()))
    }

    /// The page as a ref list. The ids of an earlier read are kept for things that are still there.
    pub fn read_tree(&self) -> Result<String, ToolError> {
        let (url, title) = self.where_am_i()?;
        let items = self.items()?;
        let keep = tree::keep_of(&self.refs.lock());
        let snap = tree::snapshot(&items, &title, &url, &keep);
        *self.refs.lock() = snap.refs;
        Ok(snap.text)
    }

    fn items(&self) -> Result<Vec<tree::Item>, ToolError> {
        let tree = self.cdp.call("Accessibility.getFullAXTree", json!({}))?;
        Ok(tree::items_from_ax(&tree))
    }

    /// The visible text of the page, and whether it was cut.
    pub fn read_text(&self) -> Result<(String, bool), ToolError> {
        let v = self.eval("document.body ? document.body.innerText : ''")?;
        Ok(tree::cut_page_text(v.as_str().unwrap_or("")))
    }

    /// Finds the element behind a ref. A ref that no longer points at a live element is looked for again by role
    /// and name; the ids the agent holds stay the same.
    fn resolve(&self, id: &str) -> Result<Resolved, ToolError> {
        let target = self
            .refs
            .lock()
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or_else(|| ToolError::new("UNKNOWN_REF", format!("There is no {id} on this page read. Call browser_read to get the current list.")))?;
        if let Some(object_id) = self.object_of(target.backend_id) {
            return Ok(Resolved { target, object_id, note: None });
        }
        // Stale: read the page again and look for the same role and name.
        let (url, title) = self.where_am_i()?;
        let items = self.items()?;
        let keep = tree::keep_of(&self.refs.lock());
        let snap = tree::snapshot(&items, &title, &url, &keep);
        let found = snap.refs.iter().find(|r| r.id == id).cloned().or_else(|| tree::find_again(&target, &snap.refs).cloned());
        *self.refs.lock() = snap.refs;
        let Some(now) = found else {
            return Err(ToolError::new(
                "STALE_REF",
                format!("{id} ({} \"{}\") is not on the page any more. The page changed: call browser_read for the current list.", target.role, target.name),
            ));
        };
        let object_id = self
            .object_of(now.backend_id)
            .ok_or_else(|| ToolError::new("STALE_REF", format!("{id} could not be found again. Call browser_read for the current list.")))?;
        let note = format!("({id} was out of date; found the same {} \"{}\" again as {}.)", now.role, now.name, now.id);
        Ok(Resolved { target: now, object_id, note: Some(note) })
    }

    /// The live element behind a backend id. A node the page threw away can still be resolved while DevTools holds it:
    /// only one that is still in the page counts (a click on a removed button would run its handler for nothing).
    fn object_of(&self, backend_id: i64) -> Option<String> {
        let answer = self.cdp.call("DOM.resolveNode", json!({ "backendNodeId": backend_id })).ok()?;
        let object_id = answer.get("object")?.get("objectId")?.as_str()?.to_string();
        let attached = self
            .cdp
            .call("Runtime.callFunctionOn", json!({ "objectId": object_id, "functionDeclaration": "function(){return this.isConnected}", "returnByValue": true }))
            .ok()
            .and_then(|a| a.get("result")?.get("value")?.as_bool());
        // An answer that is not a yes or a no is taken as a yes: the click then fails on its own if the node is gone.
        (attached != Some(false)).then_some(object_id)
    }

    /// A real mouse click at the middle of the element.
    pub fn click(&self, id: &str) -> Result<String, ToolError> {
        let r = self.resolve(id)?;
        let backend = json!({ "backendNodeId": r.target.backend_id });
        let _ = self.cdp.call("DOM.scrollIntoViewIfNeeded", backend.clone());
        match self.middle_of(&backend) {
            Some((x, y)) => {
                self.hold_bar(true, None);
                let sent = (|| -> Result<(), CdpError> {
                    self.cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }))?;
                    self.cdp.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }))?;
                    self.cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }))?;
                    Ok(())
                })();
                self.hold_bar(false, Some((x, y)));
                sent?;
            }
            None => {
                // Not drawn (or off the page): ask the element itself, so a covered or hidden-by-script control still works.
                self.cdp
                    .call("Runtime.callFunctionOn", json!({ "objectId": r.object_id, "functionDeclaration": "function(){this.click()}", "returnByValue": true }))
                    .map_err(|_| ToolError::new("NOT_VISIBLE", format!("{id} is not shown on the page, so it cannot be clicked.")))?;
            }
        }
        std::thread::sleep(self.settle);
        Ok(with_note(format!("Clicked {id} ({} \"{}\").", r.target.role, r.target.name), r.note))
    }

    /// The middle of the element's box, in page pixels.
    fn middle_of(&self, backend: &Value) -> Option<(f64, f64)> {
        let answer = self.cdp.call("DOM.getBoxModel", backend.clone()).ok()?;
        let quad = answer.get("model")?.get("content")?.as_array()?;
        let n: Vec<f64> = quad.iter().filter_map(Value::as_f64).collect();
        if n.len() < 8 {
            return None;
        }
        let (xs, ys) = ([n[0], n[2], n[4], n[6]], [n[1], n[3], n[5], n[7]]);
        let (w, h) = (xs.iter().cloned().fold(f64::MIN, f64::max) - xs.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MIN, f64::max) - ys.iter().cloned().fold(f64::MAX, f64::min));
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        Some((xs.iter().sum::<f64>() / 4.0, ys.iter().sum::<f64>() / 4.0))
    }

    /// Types text into a text box (replacing what is there), like a person typing. Never into a password, card or
    /// code box. `submit` presses Enter afterwards.
    pub fn type_text(&self, id: &str, text: &str, submit: bool) -> Result<String, ToolError> {
        let r = self.resolve(id)?;
        if !matches!(r.target.role.as_str(), "textbox" | "searchbox" | "combobox" | "spinbutton") {
            return Err(ToolError::new("NOT_A_TEXT_BOX", format!("{id} is a {}, not a text box. Use browser_click for it.", r.target.role)));
        }
        // The box's own facts decide, never the text to type.
        let facts = self.cdp.call("Runtime.callFunctionOn", json!({ "objectId": r.object_id, "functionDeclaration": guard::FACTS_FUNCTION, "returnByValue": true }))?;
        let facts: FieldFacts = facts.get("result").and_then(|v| v.get("value")).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
        if let Some(why) = guard::classify(&facts, &r.target.name) {
            return Err(ToolError::new("SENSITIVE_FIELD", why.refusal()));
        }
        self.cdp.call("DOM.focus", json!({ "backendNodeId": r.target.backend_id }))?;
        let _ = self.cdp.call("Runtime.callFunctionOn", json!({ "objectId": r.object_id, "functionDeclaration": "function(){if(this.select){this.select()}}", "returnByValue": true }));
        if text.is_empty() {
            self.cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46 }))?;
            self.cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46 }))?;
        } else {
            self.cdp.call("Input.insertText", json!({ "text": text }))?;
        }
        if submit {
            self.cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r" }))?;
            self.cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }))?;
        }
        std::thread::sleep(self.settle);
        let done = if submit { "Typed and pressed Enter in" } else { "Typed in" };
        Ok(with_note(format!("{done} {id} ({} \"{}\"). {} characters.", r.target.role, r.target.name, text.chars().count()), r.note))
    }

    /// Whether the page in front asks for a password: a password box the person can see. That is a sign-in page, and
    /// the person signs in (R4-12). It looks at the box's own type, never at what is typed in it.
    pub fn shows_sign_in(&self) -> bool {
        self.eval(SIGN_IN_JS).ok().and_then(|v| v.as_bool()).unwrap_or(false)
    }

    /// A picture of the page as it looks now (base64 JPEG, no prefix). Used by "Check it".
    pub fn screenshot(&self) -> Result<String, ToolError> {
        let answer = self.cdp.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 65 }))?;
        match answer.get("data").and_then(Value::as_str) {
            Some(data) if !data.is_empty() => Ok(data.to_string()),
            _ => Err(ToolError::new("PAGE_ERROR", "The page gave no picture.")),
        }
    }

    /// Goes to a (checked) address. The caller has already checked it.
    pub fn go(&self, url: &str) -> Result<(), ToolError> {
        *self.origin_before.lock() = self.eval("performance.timeOrigin").ok().and_then(|v| v.as_f64());
        let answer = self.cdp.call("Page.navigate", json!({ "url": url }))?;
        if let Some(error) = answer.get("errorText").and_then(Value::as_str) {
            return Err(ToolError::new("PAGE_NOT_REACHED", format!("The page did not load ({error}). Is the dev server running?")));
        }
        self.refs.lock().clear();
        Ok(())
    }

    /// Waits until the page after the last `go` has finished loading. False when it is still loading after `limit`.
    pub fn wait_ready(&self, limit: Duration) -> bool {
        let before = *self.origin_before.lock();
        let start = std::time::Instant::now();
        loop {
            if let Ok(v) = self.eval("({r:document.readyState,o:performance.timeOrigin,u:location.href})") {
                let loaded = v.get("r").and_then(Value::as_str) == Some("complete") && v.get("u").and_then(Value::as_str) != Some("about:blank");
                let new_page = match (before, v.get("o").and_then(Value::as_f64)) {
                    (Some(b), Some(o)) => (o - b).abs() > 1.0,
                    _ => true,
                };
                if loaded && new_page {
                    return true;
                }
            }
            if start.elapsed() >= limit {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The refs the last read made (empty before the agent has read the page).
    pub fn known_refs(&self) -> Vec<RefTarget> {
        self.refs.lock().clone()
    }
}

fn with_note(text: String, note: Option<String>) -> String {
    match note {
        Some(note) => format!("{text} {note}"),
        None => text,
    }
}

#[cfg(test)]
pub mod fake {
    //! A page that answers from a script, and remembers what it was asked.
    use super::*;

    pub type Handler = Box<dyn FnMut(&str, &Value) -> Result<Value, CdpError> + Send>;

    pub struct FakeCdp {
        pub calls: Mutex<Vec<(String, Value)>>,
        handler: Mutex<Handler>,
    }

    impl FakeCdp {
        pub fn new(handler: Handler) -> Arc<Self> {
            Arc::new(FakeCdp { calls: Mutex::new(Vec::new()), handler: Mutex::new(handler) })
        }
        pub fn methods(&self) -> Vec<String> {
            self.calls.lock().iter().map(|(m, _)| m.clone()).collect()
        }
        pub fn params_of(&self, method: &str) -> Vec<Value> {
            self.calls.lock().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
        }
    }

    impl Cdp for FakeCdp {
        fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
            self.calls.lock().push((method.to_string(), params.clone()));
            (self.handler.lock())(method, &params)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeCdp;
    use super::*;

    fn ax(nodes: Vec<Value>) -> Value {
        json!({ "nodes": nodes })
    }

    fn button(id: &str, name: &str, backend: i64) -> Value {
        json!({ "nodeId": id, "ignored": false, "role": { "value": "button" }, "name": { "value": name }, "backendDOMNodeId": backend, "childIds": [], "parentId": "1" })
    }

    fn textbox(id: &str, name: &str, backend: i64) -> Value {
        json!({ "nodeId": id, "ignored": false, "role": { "value": "textbox" }, "name": { "value": name }, "backendDOMNodeId": backend, "childIds": [], "parentId": "1" })
    }

    fn root(children: &[&str]) -> Value {
        json!({ "nodeId": "1", "ignored": false, "role": { "value": "RootWebArea" }, "name": { "value": "Shop" }, "backendDOMNodeId": 1, "childIds": children })
    }

    /// A page where only the backend ids in `alive` still exist, and whose tree is `tree`.
    fn page_with(tree: Arc<Mutex<Value>>, alive: Arc<Mutex<Vec<i64>>>, facts: Value) -> Arc<FakeCdp> {
        FakeCdp::new(Box::new(move |method, params| match method {
            "Runtime.evaluate" => Ok(json!({ "result": { "value": { "u": "http://localhost:5173/", "t": "Shop" } } })),
            "Accessibility.getFullAXTree" => Ok(tree.lock().clone()),
            "DOM.resolveNode" => {
                let id = params["backendNodeId"].as_i64().unwrap();
                if alive.lock().contains(&id) {
                    Ok(json!({ "object": { "objectId": format!("obj-{id}") } }))
                } else {
                    Err(CdpError::Failed("No node with given id found".into()))
                }
            }
            "DOM.getBoxModel" => Ok(json!({ "model": { "content": [10.0, 20.0, 110.0, 20.0, 110.0, 60.0, 10.0, 60.0] } })),
            "Runtime.callFunctionOn" if params["functionDeclaration"] == guard::FACTS_FUNCTION => Ok(json!({ "result": { "value": facts } })),
            _ => Ok(json!({})),
        }))
    }

    fn simple() -> (Arc<FakeCdp>, Page, Arc<Mutex<Value>>, Arc<Mutex<Vec<i64>>>) {
        let tree = Arc::new(Mutex::new(ax(vec![root(&["2", "3"]), button("2", "Save", 12), textbox("3", "Email", 13)])));
        let alive = Arc::new(Mutex::new(vec![12, 13]));
        let cdp = page_with(tree.clone(), alive.clone(), json!({ "tag": "INPUT", "type": "text", "name": "email" }));
        let page = Page::without_settle(cdp.clone());
        (cdp, page, tree, alive)
    }

    #[test]
    fn a_read_lists_refs_and_a_click_is_a_real_mouse_click_in_the_middle() {
        let (cdp, page, _, _) = simple();
        let text = page.read_tree().unwrap();
        assert!(text.contains("e1 button \"Save\"") && text.contains("e2 textbox \"Email\""), "{text}");
        let said = page.click("e1").unwrap();
        assert_eq!(said, "Clicked e1 (button \"Save\").");
        let mouse = cdp.params_of("Input.dispatchMouseEvent");
        let kinds: Vec<&str> = mouse.iter().map(|p| p["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["mouseMoved", "mousePressed", "mouseReleased"]);
        assert_eq!((mouse[1]["x"].as_f64(), mouse[1]["y"].as_f64()), (Some(60.0), Some(40.0)));
        assert_eq!(mouse[1]["button"], "left");
    }

    #[test]
    fn an_unknown_ref_asks_for_a_new_read() {
        let (_, page, _, _) = simple();
        page.read_tree().unwrap();
        let err = page.click("e9").unwrap_err();
        assert_eq!(err.code, "UNKNOWN_REF");
        assert!(err.message.contains("browser_read"));
    }

    #[test]
    fn a_stale_ref_is_read_again_and_found_by_role_and_name_keeping_its_id() {
        let (cdp, page, tree, alive) = simple();
        page.read_tree().unwrap();
        // The page re-drew: the same buttons now have new nodes, and a new button sits in front.
        *tree.lock() = ax(vec![root(&["9", "2", "3"]), button("9", "Help", 40), button("2", "Save", 52), textbox("3", "Email", 53)]);
        *alive.lock() = vec![40, 52, 53];
        let said = page.click("e1").unwrap();
        assert!(said.starts_with("Clicked e1 (button \"Save\")."), "{said}");
        assert!(said.contains("out of date"), "{said}");
        // The click went to the new node, and the old ids still mean the same things.
        assert_eq!(cdp.params_of("DOM.getBoxModel").last().unwrap()["backendNodeId"], 52);
        let ids: Vec<(String, String)> = page.known_refs().iter().map(|r| (r.id.clone(), r.name.clone())).collect();
        assert!(ids.contains(&("e1".into(), "Save".into())) && ids.contains(&("e2".into(), "Email".into())) && ids.contains(&("e3".into(), "Help".into())), "{ids:?}");
    }

    #[test]
    fn a_node_the_page_threw_away_but_devtools_still_holds_counts_as_stale() {
        // resolveNode still works for the old nodes (12, 13), but they are no longer in the page.
        let tree = Arc::new(Mutex::new(ax(vec![root(&["2", "3"]), button("2", "Save", 12), textbox("3", "Email", 13)])));
        let in_page = Arc::new(Mutex::new(vec![12i64, 13]));
        let cdp = FakeCdp::new(Box::new({
            let (tree, in_page) = (tree.clone(), in_page.clone());
            move |method, params| match method {
                "Runtime.evaluate" => Ok(json!({ "result": { "value": { "u": "u", "t": "t" } } })),
                "Accessibility.getFullAXTree" => Ok(tree.lock().clone()),
                "DOM.resolveNode" => Ok(json!({ "object": { "objectId": format!("obj-{}", params["backendNodeId"]) } })),
                "Runtime.callFunctionOn" if params["functionDeclaration"].as_str().unwrap_or("").contains("isConnected") => {
                    let id: i64 = params["objectId"].as_str().unwrap().trim_start_matches("obj-").parse().unwrap();
                    Ok(json!({ "result": { "type": "boolean", "value": in_page.lock().contains(&id) } }))
                }
                "DOM.getBoxModel" => Ok(json!({ "model": { "content": [0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0] } })),
                _ => Ok(json!({})),
            }
        }));
        let page = Page::without_settle(cdp.clone());
        page.read_tree().unwrap();
        *tree.lock() = ax(vec![root(&["2", "3"]), button("2", "Save", 52), textbox("3", "Email", 53)]);
        *in_page.lock() = vec![52, 53];
        let said = page.click("e1").unwrap();
        assert!(said.contains("out of date"), "{said}");
        assert_eq!(cdp.params_of("DOM.getBoxModel").last().unwrap()["backendNodeId"], 52, "the click must go to the live node");
    }

    #[test]
    fn a_ref_whose_thing_is_gone_says_the_page_changed() {
        let (_, page, tree, alive) = simple();
        page.read_tree().unwrap();
        *tree.lock() = ax(vec![root(&["3"]), textbox("3", "Email", 13)]);
        *alive.lock() = vec![13];
        let err = page.click("e1").unwrap_err();
        assert_eq!(err.code, "STALE_REF");
        assert!(err.message.contains("button \"Save\"") && err.message.contains("browser_read"));
    }

    #[test]
    fn typing_inserts_text_like_a_person_and_can_press_enter() {
        let (cdp, page, _, _) = simple();
        page.read_tree().unwrap();
        let said = page.type_text("e2", "me@example.com", true).unwrap();
        assert!(said.contains("Typed and pressed Enter in e2") && said.contains("14 characters"), "{said}");
        assert_eq!(cdp.params_of("Input.insertText")[0]["text"], "me@example.com");
        assert_eq!(cdp.params_of("DOM.focus")[0]["backendNodeId"], 13);
        let keys: Vec<String> = cdp.params_of("Input.dispatchKeyEvent").iter().map(|p| format!("{}:{}", p["type"].as_str().unwrap(), p["key"].as_str().unwrap())).collect();
        assert_eq!(keys, vec!["keyDown:Enter", "keyUp:Enter"]);
    }

    #[test]
    fn a_password_box_is_never_typed_in_and_nothing_is_typed_before_the_check() {
        let tree = Arc::new(Mutex::new(ax(vec![root(&["3"]), textbox("3", "Password", 13)])));
        let cdp = page_with(tree, Arc::new(Mutex::new(vec![13])), json!({ "tag": "INPUT", "type": "password" }));
        let page = Page::without_settle(cdp.clone());
        page.read_tree().unwrap();
        let err = page.type_text("e1", "hunter2", true).unwrap_err();
        assert_eq!(err.code, "SENSITIVE_FIELD");
        assert!(!err.message.contains("hunter2"));
        let methods = cdp.methods();
        for forbidden in ["Input.insertText", "Input.dispatchKeyEvent", "DOM.focus"] {
            assert!(!methods.iter().any(|m| m == forbidden), "{forbidden} must not run: {methods:?}");
        }
    }

    #[test]
    fn a_box_that_is_only_called_a_code_or_card_box_is_refused_too() {
        for (facts, label) in [(json!({ "type": "text", "autocomplete": "one-time-code" }), "Code"), (json!({ "type": "tel", "name": "cardnumber" }), "Number")] {
            let tree = Arc::new(Mutex::new(ax(vec![root(&["3"]), textbox("3", label, 13)])));
            let cdp = page_with(tree, Arc::new(Mutex::new(vec![13])), facts);
            let page = Page::without_settle(cdp.clone());
            page.read_tree().unwrap();
            assert_eq!(page.type_text("e1", "123456", false).unwrap_err().code, "SENSITIVE_FIELD");
            assert!(!cdp.methods().iter().any(|m| m == "Input.insertText"));
        }
    }

    #[test]
    fn typing_into_a_button_is_refused_with_a_hint() {
        let (_, page, _, _) = simple();
        page.read_tree().unwrap();
        let err = page.type_text("e1", "x", false).unwrap_err();
        assert_eq!(err.code, "NOT_A_TEXT_BOX");
        assert!(err.message.contains("browser_click"));
    }

    #[test]
    fn a_thing_with_no_box_on_screen_is_clicked_through_the_element_itself() {
        let tree = Arc::new(Mutex::new(ax(vec![root(&["2"]), button("2", "Save", 12)])));
        let alive = Arc::new(Mutex::new(vec![12]));
        let cdp = FakeCdp::new(Box::new({
            let (tree, alive) = (tree.clone(), alive.clone());
            move |method, params| match method {
                "Runtime.evaluate" => Ok(json!({ "result": { "value": { "u": "u", "t": "t" } } })),
                "Accessibility.getFullAXTree" => Ok(tree.lock().clone()),
                "DOM.resolveNode" => alive.lock().contains(&params["backendNodeId"].as_i64().unwrap()).then(|| json!({ "object": { "objectId": "o" } })).ok_or(CdpError::Failed("gone".into())),
                "DOM.getBoxModel" => Err(CdpError::Failed("Could not compute box model".into())),
                _ => Ok(json!({})),
            }
        }));
        let page = Page::without_settle(cdp.clone());
        page.read_tree().unwrap();
        page.click("e1").unwrap();
        assert!(cdp.methods().iter().any(|m| m == "Runtime.callFunctionOn"));
        assert!(!cdp.methods().iter().any(|m| m == "Input.dispatchMouseEvent"));
    }

    #[test]
    fn a_page_that_cannot_be_reached_says_so() {
        let cdp = FakeCdp::new(Box::new(|method, _| match method {
            "Page.navigate" => Ok(json!({ "errorText": "net::ERR_CONNECTION_REFUSED" })),
            _ => Ok(json!({})),
        }));
        let err = Page::without_settle(cdp).go("http://localhost:5999/").unwrap_err();
        assert_eq!(err.code, "PAGE_NOT_REACHED");
        assert!(err.message.contains("dev server"));
    }
}
