//! Agents the user pointed Potato Workspace at: "Choose settings file…" in the install dialog.
//!
//! The user picks an agent's settings file (and optionally its skills folder). `inspect` reads the file
//! and works out where its MCP server list is and what an entry looks like; `save` keeps that choice in
//! `<app data>/agent-pack-custom.json`; `merge` hands it to the planner as the agent's `[mcp_host]` /
//! `[skills_host]`, so preview, install and undo are the ordinary ones.
//!
//! Trust: these hosts are trusted because the user picked them in this dialog. They are read only from
//! the app data folder, never from a store or project folder, and both paths must stay in the user's
//! home folder. Nothing here names an agent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::host::SkillsHostTable;
use super::plan::AgentSpec;
use super::record::sha_hex;
use crate::mcp_install::declarative::{render_entry, resolve_config_path, HostLaunch};
use crate::toolbelt::edit::Format;
use crate::tui::declarative::schema::McpHostTable;

/// Largest settings file that is read.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Key Potato Workspace's own entry goes under.
pub const ENTRY_KEY: &str = "potato-workspace";
/// Where a JSON file with no server list gets one.
const CREATED_KEY: &str = "mcpServers";
const NO_LIST: &str = "This file has no MCP list Potato Workspace recognises.";

/// Places looked at, in order. A dotted name is a nested key.
const CANDIDATES: &[&str] = &["mcpServers", "mcp_servers", "mcp.servers", "servers", "context_servers", "mcp"];

/// What `inspect` found, shown to the user before anything is saved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Inspection {
    pub path: String,
    /// `json`, `toml` or `yaml`.
    pub format: String,
    /// Dotted path of the server list, e.g. `mcpServers`.
    pub key_path: String,
    /// The list is not in the file yet and would be created (JSON only).
    pub creates_list: bool,
    /// Plain-English description of the entry shape.
    pub shape: String,
    /// The entry with `{command}`, `{args}` and `{env}` still in it.
    pub entry_template: Value,
    /// The exact entry that would be added.
    pub entry: Value,
    /// An entry for Potato Workspace is already in the list; it is left unchanged.
    pub already_present: bool,
}

/// What is kept for one agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CustomHost {
    /// A registered agent's id, or `custom-<name>` for an agent Workspace does not know.
    pub id: String,
    pub name: String,
    pub config_path: String,
    pub format: String,
    /// Dotted path of the server list (without the entry key).
    pub key_path: String,
    pub entry: Value,
    #[serde(default)]
    pub skills_dir: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    hosts: Vec<CustomHost>,
}

pub fn store_path(state_dir: &Path) -> PathBuf {
    state_dir.join("agent-pack-custom.json")
}

pub fn load(state_dir: &Path) -> Vec<CustomHost> {
    fs::read_to_string(store_path(state_dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Store>(&t).ok())
        .map(|s| s.hosts)
        .unwrap_or_default()
}

fn write_store(state_dir: &Path, hosts: Vec<CustomHost>) -> Result<(), String> {
    let path = store_path(state_dir);
    if hosts.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    fs::create_dir_all(state_dir).map_err(|e| format!("could not create {}: {e}", state_dir.display()))?;
    let text = serde_json::to_string_pretty(&Store { hosts }).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn format_name(f: Format) -> &'static str {
    match f {
        Format::Json => "json",
        Format::Toml => "toml",
        Format::Yaml => "yaml",
    }
}

pub fn format_from(name: &str) -> Option<Format> {
    match name {
        "json" => Some(Format::Json),
        "toml" => Some(Format::Toml),
        "yaml" => Some(Format::Yaml),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Picking a path
// ---------------------------------------------------------------------------------------------

/// The path must be inside the home folder and must not be a link.
fn check_home_path(path: &str, home: &Path) -> Result<PathBuf, String> {
    let raw = path.trim();
    if raw.is_empty() || !Path::new(raw).is_absolute() {
        return Err("Choose a file with the Choose button, so the full path is known.".into());
    }
    let p = resolve_config_path(raw, home, None)
        .map_err(|_| "Potato Workspace only edits files inside your home folder, so this one was not read.".to_string())?;
    let meta = fs::symlink_metadata(&p).map_err(|e| format!("could not read {}: {e}", p.display()))?;
    if meta.file_type().is_symlink() {
        return Err("This is a shortcut (link), not a real file or folder, so it was not used. Choose the real one.".into());
    }
    Ok(p)
}

/// A skills folder the user picked: inside home, a real folder (not a link).
pub fn check_skills_dir(path: &str, home: &Path) -> Result<PathBuf, String> {
    let p = check_home_path(path, home)?;
    if !p.is_dir() {
        return Err("That is not a folder.".into());
    }
    Ok(p)
}

// ---------------------------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------------------------

fn detect_format(path: &Path, text: &str) -> Result<Format, String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "json" | "jsonc" => return Ok(Format::Json),
        "toml" => return Ok(Format::Toml),
        "yaml" | "yml" => return Ok(Format::Yaml),
        _ => {}
    }
    let t = text.trim_start();
    if t.starts_with('{') {
        return Ok(Format::Json);
    }
    if !t.is_empty() && text.parse::<toml::Table>().is_ok() {
        return Ok(Format::Toml);
    }
    if t.lines().any(|l| l.trim_end().ends_with(':') || l.contains(": ")) {
        return Ok(Format::Yaml);
    }
    Err("Potato Workspace can't tell whether this is a JSON, TOML or YAML file.".into())
}

fn looks_like_entry(v: &Value) -> bool {
    v.as_object().is_some_and(|o| ["command", "url", "args", "type", "httpUrl", "serverUrl", "source"].iter().any(|k| o.contains_key(*k)))
}

/// Whether the members found under `cand` are plausibly MCP servers (the generic names need proof).
fn plausible(cand: &str, map: &Map<String, Value>) -> bool {
    match cand {
        "servers" => !map.is_empty() && map.values().all(looks_like_entry),
        "mcp" => map.values().all(Value::is_object),
        _ => true,
    }
}

fn walk<'a>(doc: &'a Value, dotted: &str) -> Option<&'a Value> {
    dotted.split('.').try_fold(doc, |cur, seg| cur.get(seg))
}

/// The first candidate list in `doc` that qualifies, with its members.
fn find_list(doc: &Value) -> Option<(&'static str, &Map<String, Value>)> {
    CANDIDATES.iter().find_map(|&cand| match walk(doc, cand) {
        Some(Value::Object(map)) if plausible(cand, map) => Some((cand, map)),
        _ => None,
    })
}

// YAML has no parser here, so the server list is found by indentation, as the writer does.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn skip_line(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

/// The members under the dotted key, as a JSON-ish map. `None` when the key is not there.
fn yaml_list(text: &str, dotted: &str) -> Option<Map<String, Value>> {
    let lines: Vec<&str> = text.lines().collect();
    let (mut start, mut end, mut min_indent) = (0usize, lines.len(), 0usize);
    for (n, seg) in dotted.split('.').enumerate() {
        let prefix = format!("{seg}:");
        let i = (start..end).find(|&i| {
            !skip_line(lines[i]) && lines[i].trim_start().starts_with(&prefix) && (n > 0 || indent_of(lines[i]) == 0) && indent_of(lines[i]) >= min_indent
        })?;
        let here = indent_of(lines[i]);
        let mut j = i + 1;
        while j < end && (skip_line(lines[j]) || indent_of(lines[j]) > here) {
            j += 1;
        }
        start = i + 1;
        end = j;
        min_indent = here + 1;
    }
    let mut out = Map::new();
    let Some(child) = (start..end).find(|&i| !skip_line(lines[i])).map(|i| indent_of(lines[i])) else { return Some(out) };
    let mut i = start;
    while i < end {
        let line = lines[i];
        let Some((k, rest)) = line.trim_start().split_once(':').filter(|_| !skip_line(line) && indent_of(line) == child) else {
            i += 1;
            continue;
        };
        let mut j = i + 1;
        while j < end && (skip_line(lines[j]) || indent_of(lines[j]) > child) {
            j += 1;
        }
        let value = serde_json::from_str::<Value>(rest.trim()).unwrap_or_else(|_| yaml_block_entry(&lines[i + 1..j]));
        out.insert(k.trim().trim_matches('"').to_string(), value);
        i = j;
    }
    Some(out)
}

/// A block-style entry reduced to its field names: a list field is `[]`, a text field `"x"`.
fn yaml_block_entry(body: &[&str]) -> Value {
    let mut obj = Map::new();
    let Some(inner) = body.iter().find(|l| !skip_line(l)).map(|l| indent_of(l)) else { return Value::Object(obj) };
    for (n, line) in body.iter().enumerate() {
        if skip_line(line) || indent_of(line) != inner {
            continue;
        }
        if let Some((fk, fv)) = line.trim_start().split_once(':') {
            let fv = fv.trim();
            let next_is_item = body[n + 1..].iter().find(|l| !skip_line(l)).is_some_and(|l| l.trim_start().starts_with('-'));
            let v = if fv.starts_with('[') || (fv.is_empty() && next_is_item) {
                json!([])
            } else if fv.is_empty() {
                json!({})
            } else {
                json!("x")
            };
            obj.insert(fk.trim().to_string(), v);
        }
    }
    Value::Object(obj)
}

/// Where the list is and what is in it: `(dotted key, members, would be created)`.
fn locate(format: Format, text: &str) -> Result<(String, Map<String, Value>, bool), String> {
    if format == Format::Yaml {
        if text.contains('\t') {
            return Err("This YAML file uses tab characters, so it was not changed.".into());
        }
        return CANDIDATES
            .iter()
            .find_map(|&cand| yaml_list(text, cand).filter(|m| plausible(cand, m)).map(|m| (cand.to_string(), m, false)))
            .ok_or_else(|| NO_LIST.to_string());
    }
    let doc: Value = if text.trim().is_empty() {
        Value::Object(Map::new())
    } else if format == Format::Json {
        serde_json::from_str(text).map_err(|_| {
            "This file has comments or other extras that Potato Workspace can't edit safely, so it was not changed. Remove the comments or pick a different file."
                .to_string()
        })?
    } else {
        let t: toml::Table = text.parse().map_err(|e| format!("This TOML file can't be read ({e}), so it was not changed."))?;
        serde_json::to_value(t).map_err(|e| e.to_string())?
    };
    if !doc.is_object() {
        return Err("The top of this file is not a list of settings, so it was not used.".into());
    }
    match find_list(&doc) {
        Some((key, map)) => Ok((key.to_string(), map.clone(), false)),
        None if format == Format::Json => Ok((CREATED_KEY.to_string(), Map::new(), true)),
        None => Err(NO_LIST.into()),
    }
}

/// The entry template and a plain description, from an existing sibling when there is one.
fn infer_shape(list: &Map<String, Value>) -> (Value, String) {
    for entry in list.values().filter_map(Value::as_object) {
        let mut t = Map::new();
        if let Some(ty) = entry.get("type").and_then(Value::as_str) {
            t.insert("type".into(), json!(ty));
        }
        match entry.get("command") {
            Some(Value::String(_)) => {
                t.insert("command".into(), json!("{command}"));
                t.insert("args".into(), json!("{args}"));
                t.insert("env".into(), json!("{env}"));
                return (Value::Object(t), "Copied from another entry in the list: a program (command), its arguments (args) and settings (env).".into());
            }
            Some(Value::Array(_)) => {
                t.insert("command".into(), json!(["{command}", "{args}"]));
                let env_key = if entry.contains_key("environment") { "environment" } else { "env" };
                t.insert(env_key.into(), json!("{env}"));
                return (
                    Value::Object(t),
                    "Copied from another entry in the list: the program and its arguments as one list (command), plus its settings.".into(),
                );
            }
            _ => {}
        }
    }
    (json!({ "command": "{command}", "args": "{args}", "env": "{env}" }), "The usual shape: a program (command), its arguments (args) and settings (env).".into())
}

/// Read the file the user picked and say what Potato Workspace would do to it. Nothing is written.
pub fn inspect(path: &str, home: &Path, launch: &HostLaunch) -> Result<Inspection, String> {
    let p = check_home_path(path, home)?;
    let meta = fs::metadata(&p).map_err(|e| format!("could not read {}: {e}", p.display()))?;
    if !meta.is_file() {
        return Err("This is not a file. Choose the agent's settings file.".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("This file is larger than 1 MB, which is too big for a settings file, so it was not read.".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("could not read {}: {e}", p.display()))?;
    let text = String::from_utf8(bytes).map_err(|_| "This file is not text, so it was not used.".to_string())?;
    let format = detect_format(&p, &text)?;
    let (key_path, list, creates_list) = locate(format, &text)?;
    let (template, shape) = infer_shape(&list);
    let table = host_table(&p.display().to_string(), format, &key_path, &template)?;
    let entry = render_entry(&table, launch)?;
    Ok(Inspection {
        path: p.display().to_string(),
        format: format_name(format).into(),
        key_path,
        creates_list,
        shape,
        entry_template: template,
        entry,
        already_present: list.contains_key(ENTRY_KEY),
    })
}

fn host_table(config_path: &str, format: Format, list_key: &str, template: &Value) -> Result<McpHostTable, String> {
    let entry: toml::Table = serde_json::from_value(template.clone()).map_err(|e| format!("entry shape: {e}"))?;
    Ok(McpHostTable {
        config_path: config_path.to_string(),
        format,
        key_path: format!("{list_key}.{ENTRY_KEY}"),
        entry,
        project_config_path: None,
        entry_http: None,
    })
}

// ---------------------------------------------------------------------------------------------
// Saving, forgetting, applying to a plan
// ---------------------------------------------------------------------------------------------

fn slug(name: &str) -> String {
    let s: String = name.trim().to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() {
        format!("agent-{}", &sha_hex(name)[..8])
    } else {
        s
    }
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Give the agent a name.".into());
    }
    if n.chars().count() > 40 || n.chars().any(char::is_control) {
        return Err("Use a short name (up to 40 letters, no special characters).".into());
    }
    Ok(n.to_string())
}

/// Save the user's choice. `agent` is a registered agent `(id, label)`, or `None` for an agent
/// Workspace does not know, which is then called `name`.
pub fn save(
    state_dir: &Path,
    home: &Path,
    launch: &HostLaunch,
    agent: Option<(&str, &str)>,
    name: &str,
    path: &str,
    skills_dir: Option<&str>,
) -> Result<CustomHost, String> {
    let (id, name) = match agent {
        Some((id, label)) => (id.to_string(), label.to_string()),
        None => {
            let n = clean_name(name)?;
            (format!("custom-{}", slug(&n)), n)
        }
    };
    let found = inspect(path, home, launch)?;
    let skills = match skills_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => Some(check_skills_dir(d, home)?.display().to_string()),
        None => None,
    };
    let host = CustomHost {
        id: id.clone(),
        name,
        config_path: found.path,
        format: found.format,
        key_path: found.key_path,
        entry: found.entry_template,
        skills_dir: skills,
    };
    let mut hosts = load(state_dir);
    hosts.retain(|h| h.id != id);
    hosts.push(host.clone());
    write_store(state_dir, hosts)?;
    Ok(host)
}

/// Remove the saved choice for `id`. Files already written are Undo's job. True when something was removed.
pub fn forget(state_dir: &Path, id: &str) -> Result<bool, String> {
    let mut hosts = load(state_dir);
    let before = hosts.len();
    hosts.retain(|h| h.id != id);
    let removed = hosts.len() != before;
    if removed {
        write_store(state_dir, hosts)?;
    }
    Ok(removed)
}

impl CustomHost {
    fn mcp_table(&self) -> Option<McpHostTable> {
        host_table(&self.config_path, format_from(&self.format)?, &self.key_path, &self.entry).ok()
    }
}

/// Give the planner the user's hosts: a registered agent takes them over, any other becomes its own agent.
pub fn merge(specs: &mut Vec<AgentSpec>, hosts: &[CustomHost]) {
    for h in hosts {
        let Some(mcp) = h.mcp_table() else { continue };
        let skills = h.skills_dir.as_ref().map(|d| SkillsHostTable { dir: d.clone() });
        match specs.iter_mut().find(|s| s.id == h.id) {
            Some(s) => {
                s.mcp = Some(mcp);
                if skills.is_some() {
                    s.skills = skills;
                }
                s.installed = true;
            }
            None => specs.push(AgentSpec { id: h.id.clone(), label: h.name.clone(), installed: true, mcp: Some(mcp), skills }),
        }
    }
}
