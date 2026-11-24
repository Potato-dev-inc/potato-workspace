//! What the bridge reads from an agent's definition beyond the headless command: the model-list command
//! (`[model] source = "probe_command"`) and the tool-event rules (`[headless.output.tool]`). Both are optional;
//! without them the bridge offers no model chip and no tool cards (it never guesses).

use serde_json::Value;

use crate::tui::declarative::schema::{ModelSource, ModelTable, OutputFormat, ToolTable};
use crate::tui::declarative::select::{parse_json, walk, CompiledSelector, MAX_LINE_BYTES};

/// The raw tables a profile hands to the bridge (`TuiProfile::bridge_tables`).
#[derive(Debug, Clone, Default)]
pub struct DefinitionTables {
    pub model: ModelTable,
    pub tool: Option<ToolTable>,
}

/// The agent's own model-list command: the arguments after its program, and how a line of output becomes a
/// model id (first capture group, else the whole match).
#[derive(Debug, Clone)]
pub struct ModelListCommand {
    pub args: Vec<String>,
    pub line: regex::Regex,
    pub default: Option<String>,
}

impl ModelListCommand {
    /// `None` unless the definition names a list command and a way to read it.
    pub fn from_table(model: &ModelTable) -> Option<ModelListCommand> {
        if model.source != ModelSource::ProbeCommand {
            return None;
        }
        let args = model.probe_argv.clone().filter(|a| !a.is_empty())?;
        if !crate::tui::declarative::wizard::bypass::list_argv_problems(&args).is_empty() {
            return None; // it runs on chat open: never a bypass, a prompt-like argument or a placeholder
        }
        let line = regex::RegexBuilder::new(model.probe_regex.as_deref()?).size_limit(1 << 20).build().ok()?;
        Some(ModelListCommand { args, line, default: model.default.clone().filter(|d| !d.trim().is_empty()) })
    }

    /// The model ids in `output`, in order, once each. Lines the pattern does not match are ignored.
    pub fn parse(&self, output: &str) -> Vec<String> {
        let mut found: Vec<String> = Vec::new();
        for line in output.lines().take(5000) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Some(caps) = self.line.captures(line) else { continue };
            let Some(group) = caps.name("value").or_else(|| caps.get(1)).or_else(|| caps.get(0)) else { continue };
            let id = group.as_str().trim();
            if id.is_empty() || id.starts_with('-') || id.len() > 200 || id.chars().any(char::is_control) || found.iter().any(|f| f == id) {
                continue;
            }
            found.push(id.to_string());
            if found.len() >= 500 {
                break;
            }
        }
        found
    }
}

/// One thing the tool rules saw in the agent's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolEvent {
    Started { id: String, title: String, input: Option<String> },
    Finished { id: String, failed: bool, output: Option<String> },
}

/// The compiled `[headless.output.tool]` table.
pub struct ToolRules {
    items: Option<String>,
    start: CompiledSelector,
    id: String,
    title: String,
    input: Option<String>,
    finish: Option<CompiledSelector>,
    finish_id: String,
    output: Option<String>,
    failed: Option<CompiledSelector>,
}

impl ToolRules {
    /// `None` when the output is not `json_lines` (tool events are read line by line) or a selector is bad.
    pub fn compile(tool: &ToolTable, format: OutputFormat) -> Option<ToolRules> {
        if format != OutputFormat::JsonLines {
            return None;
        }
        let one = |sel: &Option<crate::tui::declarative::schema::Selector>, at: &str| match sel {
            Some(s) => CompiledSelector::compile(s, at).ok().map(Some),
            None => Some(None),
        };
        Some(ToolRules {
            items: tool.items.clone().filter(|p| !p.is_empty()),
            start: CompiledSelector::compile(&tool.start, "headless.output.tool.start").ok()?,
            id: tool.id.clone(),
            title: tool.title.clone(),
            input: tool.input.clone(),
            finish: one(&tool.finish, "headless.output.tool.finish")?,
            finish_id: tool.finish_id.clone().unwrap_or_else(|| tool.id.clone()),
            output: tool.output.clone(),
            failed: one(&tool.failed, "headless.output.tool.failed")?,
        })
    }

    /// The events of one output line (not JSON, or no tool in it: none).
    pub fn events_of_line(&self, line: &str) -> Vec<ToolEvent> {
        let line = line.trim();
        if !line.starts_with('{') || line.len() > MAX_LINE_BYTES {
            return Vec::new();
        }
        let Some(value) = parse_json(line) else { return Vec::new() };
        let elements: Vec<&Value> = match &self.items {
            Some(path) => match walk(&value, path) {
                Some(Value::Array(list)) => list.iter().collect(),
                _ => return Vec::new(),
            },
            None => vec![&value],
        };
        let mut events = Vec::new();
        for element in elements {
            if self.start.matches(element) {
                if let Some(id) = text_at(element, &self.id).map(clip_id) {
                    let title = text_at(element, &self.title).unwrap_or_else(|| "Tool".to_string());
                    let input = self.input.as_deref().and_then(|p| text_at(element, p));
                    events.push(ToolEvent::Started { id, title, input });
                    continue;
                }
            }
            if self.finish.as_ref().is_some_and(|f| f.matches(element)) {
                if let Some(id) = text_at(element, &self.finish_id).map(clip_id) {
                    let failed = self.failed.as_ref().is_some_and(|f| f.matches(element));
                    let output = self.output.as_deref().and_then(|p| text_at(element, p));
                    events.push(ToolEvent::Finished { id, failed, output });
                }
            }
        }
        events
    }
}

/// Cards that can be open at once; more starts are ignored.
const MAX_OPEN_TOOLS: usize = 200;
/// Longest tool-card id sent to the app.
const MAX_ID_CHARS: usize = 200;

fn text_at(value: &Value, path: &str) -> Option<String> {
    let found = walk(value, path)?;
    let text = match found {
        Value::String(s) => s.clone(),
        Value::Null => return None,
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => serde_json::to_string(other).ok()?,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn clip_id(id: String) -> String {
    if id.chars().count() > MAX_ID_CHARS {
        id.chars().take(MAX_ID_CHARS).collect()
    } else {
        id
    }
}

/// Reads the complete lines of a growing output once each and turns them into tool events.
pub struct ToolScanner {
    rules: std::sync::Arc<ToolRules>,
    done: usize,
    /// Cards started and not finished: each is closed as failed when the turn ends.
    open: Vec<String>,
}

impl ToolScanner {
    pub fn new(rules: std::sync::Arc<ToolRules>) -> ToolScanner {
        ToolScanner { rules, done: 0, open: Vec::new() }
    }

    /// Events of the lines that became complete since the last call. `last` also reads a final line with no
    /// newline.
    pub fn scan(&mut self, output: &str, last: bool) -> Vec<ToolEvent> {
        let mut events = Vec::new();
        while self.done < output.len() {
            let rest = &output[self.done..];
            let (line, used) = match rest.find('\n') {
                Some(end) => (&rest[..end], end + 1),
                None if last => (rest, rest.len()),
                None => break,
            };
            for event in self.rules.events_of_line(line) {
                match &event {
                    ToolEvent::Started { id, .. } if self.open.contains(id) || self.open.len() >= MAX_OPEN_TOOLS => continue,
                    ToolEvent::Started { id, .. } => self.open.push(id.clone()),
                    // A finish for a card the client never saw is dropped.
                    ToolEvent::Finished { id, .. } => match self.open.iter().position(|o| o == id) {
                        Some(at) => {
                            self.open.remove(at);
                        }
                        None => continue,
                    },
                }
                events.push(event);
            }
            self.done += used;
        }
        events
    }

    /// The turn is over (done, failed, cancelled, time limit): every card still open ends as failed.
    pub fn close_open(&mut self) -> Vec<ToolEvent> {
        self.open.drain(..).map(|id| ToolEvent::Finished { id, failed: true, output: None }).collect()
    }
}
