//! The page as a short text list with refs (N5-23).
//!
//! The agent does not look at pictures. It reads the page's accessibility tree (what a screen reader sees), keeps
//! only what a person can see or use, and gives each thing it can click or type in a short id (`e1`, `e2`, ...).
//! "Click e4" then means exactly one element. Everything in here is pure: it works on the JSON of
//! `Accessibility.getFullAXTree`, so it is tested without a browser.

use serde_json::Value;
use std::collections::HashMap;

/// Most lines one read returns, and most characters. Longer pages are cut with a note.
pub const MAX_LINES: usize = 300;
pub const MAX_CHARS: usize = 14_000;
/// Longest text on one line.
const MAX_LINE_TEXT: usize = 140;

/// What a ref points at. `nth` counts the same role and name in page order, so two "Delete" buttons stay apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefTarget {
    pub id: String,
    pub backend_id: i64,
    pub role: String,
    pub name: String,
    pub nth: usize,
}

/// One line of the read: a thing with a ref, or plain context (a heading, some text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub role: String,
    pub name: String,
    pub value: String,
    pub states: Vec<String>,
    pub level: Option<u32>,
    pub depth: usize,
    /// None for context lines.
    pub backend_id: Option<i64>,
    pub nth: usize,
}

impl Item {
    pub fn is_actionable(&self) -> bool {
        self.backend_id.is_some() && is_interactive(&self.role)
    }
}

/// Roles the agent can click or type in. Lower case.
pub fn is_interactive(role: &str) -> bool {
    matches!(
        role,
        "button" | "link" | "textbox" | "searchbox" | "checkbox" | "radio" | "combobox" | "menuitem" | "menuitemcheckbox"
            | "menuitemradio" | "tab" | "switch" | "slider" | "spinbutton" | "option" | "treeitem" | "disclosuretriangle"
    )
}

/// Roles that are useful even with no name (an empty text box is still a text box).
fn nameless_ok(role: &str) -> bool {
    matches!(role, "textbox" | "searchbox" | "combobox" | "checkbox" | "radio" | "switch" | "slider" | "spinbutton")
}

fn text_of(node: &Value, field: &str) -> String {
    node.get(field).and_then(|f| f.get("value")).map(|v| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }).unwrap_or_default()
}

fn clean(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cut(&one, MAX_LINE_TEXT)
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{head}\u{2026}")
}

fn property<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("properties")?.as_array()?.iter().find(|p| p.get("name").and_then(Value::as_str) == Some(name))?.get("value")?.get("value")
}

fn states_of(node: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let flag = |name: &str| property(node, name).map(|v| v == &Value::Bool(true) || v == "true").unwrap_or(false);
    if flag("disabled") {
        out.push("disabled".to_string());
    }
    if flag("required") {
        out.push("required".to_string());
    }
    if flag("readonly") {
        out.push("read-only".to_string());
    }
    if flag("focused") {
        out.push("focused".to_string());
    }
    if flag("selected") {
        out.push("selected".to_string());
    }
    if let Some(checked) = property(node, "checked") {
        match checked.as_str() {
            Some("true") => out.push("checked".to_string()),
            Some("mixed") => out.push("mixed".to_string()),
            _ if checked == &Value::Bool(true) => out.push("checked".to_string()),
            _ => {}
        }
    }
    if let Some(expanded) = property(node, "expanded") {
        out.push(if expanded == &Value::Bool(true) { "expanded" } else { "collapsed" }.to_string());
    }
    if property(node, "invalid").map(|v| v.as_str() == Some("true") || v == &Value::Bool(true)).unwrap_or(false) {
        out.push("invalid".to_string());
    }
    out
}

/// The kept items of an `Accessibility.getFullAXTree` answer, in page order. `result` is the answer object
/// (`{ "nodes": [...] }`).
pub fn items_from_ax(result: &Value) -> Vec<Item> {
    let Some(nodes) = result.get("nodes").and_then(Value::as_array) else { return Vec::new() };
    let by_id: HashMap<&str, &Value> = nodes.iter().filter_map(|n| Some((n.get("nodeId")?.as_str()?, n))).collect();
    // Roots: nodes that are nobody's child. The first node is the page.
    let children: std::collections::HashSet<&str> =
        nodes.iter().filter_map(|n| n.get("childIds")?.as_array()).flatten().filter_map(Value::as_str).collect();
    let roots: Vec<&Value> = nodes.iter().filter(|n| n.get("nodeId").and_then(Value::as_str).map(|id| !children.contains(id)).unwrap_or(false)).collect();
    let mut items = Vec::new();
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    for root in roots {
        walk(root, &by_id, 0, false, &mut items, &mut seen);
    }
    items
}

fn walk<'a>(
    node: &'a Value,
    by_id: &HashMap<&str, &'a Value>,
    depth: usize,
    parent_covers_text: bool,
    items: &mut Vec<Item>,
    seen: &mut HashMap<(String, String), usize>,
) {
    if items.len() > MAX_LINES * 4 {
        return;
    }
    let ignored = node.get("ignored").and_then(Value::as_bool).unwrap_or(false);
    let role = text_of(node, "role").to_ascii_lowercase();
    let name = clean(&text_of(node, "name"));
    let mut covers = parent_covers_text;
    let mut next_depth = depth;
    if !ignored {
        let backend = node.get("backendDOMNodeId").and_then(Value::as_i64);
        let interactive = is_interactive(&role) && backend.is_some() && (!name.is_empty() || nameless_ok(&role));
        if interactive {
            let nth = {
                let slot = seen.entry((role.clone(), name.clone())).or_insert(0);
                *slot += 1;
                *slot - 1
            };
            items.push(Item {
                role: role.clone(),
                name: name.clone(),
                value: clean(&text_of(node, "value")),
                states: states_of(node),
                level: None,
                depth,
                backend_id: backend,
                nth,
            });
            covers = true;
            next_depth = depth + 1;
        } else if role == "heading" && !name.is_empty() {
            let level = property(node, "level").and_then(Value::as_u64).map(|l| l as u32);
            items.push(Item { role: role.clone(), name: name.clone(), value: String::new(), states: Vec::new(), level, depth, backend_id: None, nth: 0 });
            covers = true;
        } else if role == "statictext" && !parent_covers_text && !name.is_empty() {
            items.push(Item { role: "text".to_string(), name: name.clone(), value: String::new(), states: Vec::new(), level: None, depth, backend_id: None, nth: 0 });
        } else if role == "img" && !name.is_empty() {
            items.push(Item { role: "image".to_string(), name: name.clone(), value: String::new(), states: Vec::new(), level: None, depth, backend_id: None, nth: 0 });
        }
    }
    if let Some(children) = node.get("childIds").and_then(Value::as_array) {
        for child in children.iter().filter_map(Value::as_str).filter_map(|id| by_id.get(id)) {
            walk(child, by_id, next_depth, covers, items, seen);
        }
    }
}

/// A read of the page: the text for the agent, and the refs it can use next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub text: String,
    pub refs: Vec<RefTarget>,
    pub cut: usize,
}

/// Gives refs to the actionable items and writes the list. `keep` maps (role, name, nth) of an older read to the
/// id it had, so a re-read keeps the ids the agent already knows. New things get the next free number.
pub fn snapshot(items: &[Item], title: &str, url: &str, keep: &HashMap<(String, String, usize), String>) -> Snapshot {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut next = 1usize;
    let mut refs = Vec::new();
    let mut ids: Vec<Option<String>> = Vec::with_capacity(items.len());
    for item in items {
        if !item.is_actionable() {
            ids.push(None);
            continue;
        }
        let key = (item.role.clone(), item.name.clone(), item.nth);
        let id = keep.get(&key).filter(|id| !used.contains(*id)).cloned().unwrap_or_else(|| loop {
            let candidate = format!("e{next}");
            next += 1;
            if !used.contains(&candidate) && !keep.values().any(|v| v == &candidate) {
                break candidate;
            }
        });
        used.insert(id.clone());
        refs.push(RefTarget { id: id.clone(), backend_id: item.backend_id.unwrap_or(0), role: item.role.clone(), name: item.name.clone(), nth: item.nth });
        ids.push(Some(id));
    }
    let mut out = String::new();
    out.push_str(&format!("page {} {}\n", quote(&clean(title)), cut(url, 200)));
    let mut written = 0usize;
    let mut cut_count = 0usize;
    for (item, id) in items.iter().zip(&ids) {
        let line = line_of(item, id.as_deref());
        if written >= MAX_LINES || out.len() + line.len() > MAX_CHARS {
            cut_count += 1;
            continue;
        }
        out.push_str(&line);
        out.push('\n');
        written += 1;
    }
    if cut_count > 0 {
        out.push_str(&format!("... {cut_count} more lines were left out. Use browser_read with mode \"text\" for the whole text.\n"));
    }
    if items.is_empty() {
        out.push_str("(nothing to read yet: the page may still be loading)\n");
    }
    Snapshot { text: out, refs, cut: cut_count }
}

fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "'"))
}

fn line_of(item: &Item, id: Option<&str>) -> String {
    let indent = "  ".repeat(item.depth.min(6));
    let mut line = String::new();
    line.push_str(&indent);
    if let Some(id) = id {
        line.push_str(id);
        line.push(' ');
    }
    line.push_str(&item.role);
    if !item.name.is_empty() {
        line.push(' ');
        line.push_str(&quote(&item.name));
    }
    if let Some(level) = item.level {
        line.push_str(&format!(" (level {level})"));
    }
    if !item.value.is_empty() && item.value != item.name {
        line.push_str(&format!(" value={}", quote(&item.value)));
    }
    if !item.states.is_empty() {
        line.push_str(&format!(" [{}]", item.states.join(", ")));
    }
    line
}

/// Finds the new item for an old ref: same role and name and the same count, else the first with the same role and
/// name. `None` when the thing is gone.
pub fn find_again<'a>(old: &RefTarget, refs: &'a [RefTarget]) -> Option<&'a RefTarget> {
    refs.iter()
        .find(|r| r.role == old.role && r.name == old.name && r.nth == old.nth)
        .or_else(|| refs.iter().find(|r| r.role == old.role && r.name == old.name))
}

/// The ids of an earlier read, for `snapshot`'s `keep`.
pub fn keep_of(refs: &[RefTarget]) -> HashMap<(String, String, usize), String> {
    refs.iter().map(|r| ((r.role.clone(), r.name.clone(), r.nth), r.id.clone())).collect()
}

/// The visible text of the page, cut to a size an agent can read.
pub fn cut_page_text(text: &str) -> (String, bool) {
    let trimmed: String = text.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
    if trimmed.chars().count() <= MAX_CHARS {
        return (trimmed, false);
    }
    (trimmed.chars().take(MAX_CHARS).collect(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, role: &str, name: &str, backend: Option<i64>, children: &[&str]) -> Value {
        let mut n = json!({ "nodeId": id, "ignored": false, "role": { "type": "role", "value": role }, "name": { "type": "computedString", "value": name }, "childIds": children });
        if let Some(b) = backend {
            n["backendDOMNodeId"] = json!(b);
        }
        n
    }

    fn sample() -> Value {
        let mut email = node("5", "textbox", "Email", Some(15), &[]);
        email["properties"] = json!([{ "name": "required", "value": { "type": "boolean", "value": true } }]);
        email["value"] = json!({ "type": "string", "value": "a@b.c" });
        let mut hidden = node("9", "button", "Secret", Some(19), &[]);
        hidden["ignored"] = json!(true);
        json!({ "nodes": [
            node("1", "RootWebArea", "Shop", Some(1), &["2", "3", "5", "6", "7", "8", "9"]),
            node("2", "heading", "Pricing", Some(12), &["10"]),
            node("3", "button", "Save", Some(13), &["11"]),
            email,
            node("6", "button", "Delete", Some(16), &[]),
            node("7", "button", "Delete", Some(17), &[]),
            node("8", "StaticText", "Welcome back", Some(18), &[]),
            hidden,
            node("10", "StaticText", "Pricing", Some(20), &[]),
            node("11", "StaticText", "Save", Some(21), &[]),
        ] })
    }

    #[test]
    fn reads_headings_things_to_click_and_loose_text_in_page_order() {
        let items = items_from_ax(&sample());
        let kinds: Vec<(&str, &str)> = items.iter().map(|i| (i.role.as_str(), i.name.as_str())).collect();
        assert_eq!(
            kinds,
            vec![("heading", "Pricing"), ("button", "Save"), ("textbox", "Email"), ("button", "Delete"), ("button", "Delete"), ("text", "Welcome back")]
        );
    }

    #[test]
    fn text_inside_a_button_or_heading_is_not_read_twice_and_hidden_nodes_are_skipped() {
        let text = snapshot(&items_from_ax(&sample()), "Shop", "http://localhost:5173/", &HashMap::new()).text;
        assert_eq!(text.matches("Save").count(), 1);
        assert_eq!(text.matches("Pricing").count(), 1);
        assert!(!text.contains("Secret"));
    }

    #[test]
    fn only_things_you_can_use_get_refs_and_two_same_buttons_stay_apart() {
        let snap = snapshot(&items_from_ax(&sample()), "Shop", "http://localhost:5173/", &HashMap::new());
        let ids: Vec<(&str, &str, usize)> = snap.refs.iter().map(|r| (r.id.as_str(), r.name.as_str(), r.nth)).collect();
        assert_eq!(ids, vec![("e1", "Save", 0), ("e2", "Email", 0), ("e3", "Delete", 0), ("e4", "Delete", 1)]);
        assert!(snap.text.contains("e1 button \"Save\""));
        assert!(snap.text.contains("e2 textbox \"Email\" value=\"a@b.c\" [required]"));
        assert!(snap.text.contains("heading \"Pricing\" (level") || snap.text.contains("heading \"Pricing\""));
        assert!(snap.text.starts_with("page \"Shop\" http://localhost:5173/"));
    }

    #[test]
    fn a_new_read_keeps_the_ids_the_agent_already_knows() {
        let first = snapshot(&items_from_ax(&sample()), "Shop", "u", &HashMap::new());
        // The page grows a new button in front of the others.
        let mut nodes = sample();
        nodes["nodes"].as_array_mut().unwrap().push(node("12", "button", "Help", Some(30), &[]));
        nodes["nodes"][0]["childIds"] = json!(["12", "2", "3", "5", "6", "7", "8"]);
        let second = snapshot(&items_from_ax(&nodes), "Shop", "u", &keep_of(&first.refs));
        let id = |name: &str, nth: usize| second.refs.iter().find(|r| r.name == name && r.nth == nth).unwrap().id.clone();
        assert_eq!(id("Save", 0), "e1");
        assert_eq!(id("Delete", 1), "e4");
        assert_eq!(id("Help", 0), "e5");
    }

    #[test]
    fn a_ref_is_found_again_by_role_and_name() {
        let first = snapshot(&items_from_ax(&sample()), "Shop", "u", &HashMap::new());
        let old = first.refs.iter().find(|r| r.name == "Delete" && r.nth == 1).unwrap().clone();
        let mut moved = first.refs.clone();
        for r in &mut moved {
            r.backend_id += 100;
        }
        assert_eq!(find_again(&old, &moved).unwrap().backend_id, old.backend_id + 100);
        let gone: Vec<RefTarget> = first.refs.iter().filter(|r| r.name != "Delete").cloned().collect();
        assert!(find_again(&old, &gone).is_none());
        // The second Delete is gone but the first is still there: the same words, so it is found.
        let one_left: Vec<RefTarget> = first.refs.iter().filter(|r| !(r.name == "Delete" && r.nth == 1)).cloned().collect();
        assert_eq!(find_again(&old, &one_left).unwrap().nth, 0);
    }

    #[test]
    fn a_long_page_is_cut_with_a_note() {
        let mut nodes = vec![node("1", "RootWebArea", "Long", Some(1), &[])];
        let ids: Vec<String> = (2..800).map(|i| i.to_string()).collect();
        for id in &ids {
            nodes.push(node(id, "button", &format!("Button number {id}"), Some(id.parse().unwrap()), &[]));
        }
        nodes[0]["childIds"] = json!(ids);
        let snap = snapshot(&items_from_ax(&json!({ "nodes": nodes })), "Long", "u", &HashMap::new());
        assert!(snap.cut > 0);
        assert!(snap.text.contains("more lines were left out"));
        assert!(snap.text.len() < MAX_CHARS + 400);
        assert!(snap.refs.len() >= 1);
    }

    #[test]
    fn an_empty_answer_says_the_page_may_still_be_loading() {
        let snap = snapshot(&items_from_ax(&json!({})), "", "about:blank", &HashMap::new());
        assert!(snap.text.contains("may still be loading"));
        assert!(snap.refs.is_empty());
    }

    #[test]
    fn page_text_is_cut_to_a_size_an_agent_can_read() {
        let (short, cut_short) = cut_page_text("hello  \nworld");
        assert_eq!((short.as_str(), cut_short), ("hello\nworld", false));
        let (long, was_cut) = cut_page_text(&"x".repeat(MAX_CHARS + 50));
        assert!(was_cut);
        assert_eq!(long.chars().count(), MAX_CHARS);
    }
}
