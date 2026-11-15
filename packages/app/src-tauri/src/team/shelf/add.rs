//! "Add with one click": install a shelf item into the agents the person picked, through the paths the
//! app already has (the toolbelt's config writer for tools, an agent's skills folder for skills).
//!
//! [`preview`] and [`apply`] share ONE plan, so what is shown is what is written:
//!
//! - a tool: only its own `pm-toolbelt-<id>` entry in each chosen agent's config (`sync::run_only`: nothing
//!   else in any file is added, changed or removed), and the same server in the toolbelt list;
//! - a skill: `<skills folder>/team-<name>/SKILL.md`, never over a file that is already there.
//!
//! The text came from a teammate, so it is untrusted: a tool that runs a shell, a path or a program the app
//! does not know is refused here (not only in the screen) until the call says the person ticked "I trust this".
//! Undo is kept in memory for a while (never on disk: it holds the config text as it was).

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use super::gate::{self, Risk};
use super::local::Env;
use super::model::{item_id, slug, ItemKind, ShelfItem, ToolTransport};
use crate::agent_pack::record::sha_hex;
use crate::toolbelt::import::same_server;
use crate::toolbelt::store::{self, Scope, ToolServer, Transport};
use crate::toolbelt::sync::{self, AgentRef, ChangeKind};

pub const TRUST_NEEDED: &str = "This runs a command on your PC. Tick \"I trust this\" to add it.";
pub const NEWER_NEEDED: &str = "This needs a newer Potato Workspace.";
/// How long Undo stays available.
const UNDO_MS: u64 = 30 * 60_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriteView {
    /// `tool` or `skill`.
    pub kind: &'static str,
    pub agents: Vec<AgentRef>,
    pub path: String,
    /// `add`, `unchanged`, `conflict`, `skipped` or `error`.
    pub status: &'static str,
    pub reason: Option<String>,
    /// What goes in: the changed lines of a config (secrets masked), or the skill text.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub name: String,
    pub kind: ItemKind,
    pub risk: Option<Risk>,
    /// Names of the keys the person adds themselves.
    pub needs: Vec<String>,
    pub skipped_files: u32,
    pub writes: Vec<WriteView>,
    /// Something would be written.
    pub can_add: bool,
    /// Why nothing can be added, in a sentence.
    pub blocked: Option<String>,
}

/// One file the add touched, so Undo can put it back.
#[derive(Debug, Clone)]
struct FileUndo {
    path: PathBuf,
    /// The file as it was (`None`: it did not exist).
    before: Option<String>,
    after_sha: String,
    created_dirs: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default)]
struct UndoRecord {
    files: Vec<FileUndo>,
    toolbelt_id: Option<String>,
    at_ms: u64,
}

static UNDO: Mutex<Option<HashMap<String, UndoRecord>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub id: String,
    pub name: String,
    pub kind: ItemKind,
    /// The agents that got it (labels).
    pub added_to: Vec<String>,
    pub agent_ids: Vec<String>,
    pub writes: Vec<WriteView>,
    pub undo: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Undone {
    pub restored: usize,
    pub skipped: Vec<String>,
}

fn now_ms() -> u64 {
    crate::team::service::now_ms()
}

// -------------------------------------------------------------------------------------- planning

struct SkillWrite {
    view_index: usize,
    path: PathBuf,
    text: String,
}

struct Plan {
    views: Vec<WriteView>,
    /// Tool: the server to write, and whether it is new to the toolbelt.
    server: Option<(ToolServer, bool)>,
    chosen_hosts: Vec<sync::HostSpec>,
    skills: Vec<SkillWrite>,
}

fn pick<'a>(ids: &[String], all: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<(String, String)> {
    all.filter(|(id, _)| ids.iter().any(|i| i == id)).map(|(i, l)| (i.to_string(), l.to_string())).collect()
}

fn tool_server(item: &ShelfItem, existing: &[ToolServer]) -> Result<(ToolServer, bool), String> {
    let tool = item.tool.as_ref().ok_or("This item has no tool in it.")?;
    let blank = |m: &BTreeMap<String, String>| m.keys().map(|k| (k.clone(), String::new())).collect::<BTreeMap<_, _>>();
    let mut server = ToolServer {
        id: String::new(),
        name: item.name.clone(),
        transport: if tool.transport == Some(ToolTransport::Http) { Transport::Http } else { Transport::Stdio },
        command: tool.command.clone(),
        args: tool.args.clone(),
        env: blank(&tool.env),
        url: tool.url.clone(),
        headers: blank(&tool.headers),
        enabled: true,
        scope: Scope::Global,
    };
    if let Some(have) = existing.iter().find(|e| same_server(e, &server) && e.scope == Scope::Global) {
        return Ok((have.clone(), false));
    }
    let base = slug(&item.name);
    let mut id = base.clone();
    let mut n = 2;
    while existing.iter().any(|s| s.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    server.id = id;
    Ok((server, true))
}

fn plan(env: &Env, item: &ShelfItem, agent_ids: &[String]) -> Result<Plan, String> {
    let mut views: Vec<WriteView> = Vec::new();
    let mut plan = Plan { views: Vec::new(), server: None, chosen_hosts: Vec::new(), skills: Vec::new() };
    let chosen = pick(agent_ids, env.agents.iter().map(|a| (a.id.as_str(), a.label.as_str())));
    if chosen.is_empty() {
        return Err("Pick at least one agent.".into());
    }
    match item.kind {
        ItemKind::Unknown => return Err(NEWER_NEEDED.into()),
        ItemKind::Tool => {
            let existing = store::load_servers(&env.store_path)?;
            let (server, new) = tool_server(item, &existing)?;
            plan.chosen_hosts = env.hosts().into_iter().filter(|h| agent_ids.contains(&h.agent_id)).collect();
            for (id, label) in &chosen {
                if !plan.chosen_hosts.iter().any(|h| &h.agent_id == id) {
                    views.push(WriteView {
                        kind: "tool",
                        agents: vec![AgentRef { id: id.clone(), label: label.clone() }],
                        path: String::new(),
                        status: "skipped",
                        reason: Some(format!("{label} does not say where it keeps tools, so nothing can be written for it.")),
                        text: String::new(),
                    });
                }
            }
            let report = sync::run_only(std::slice::from_ref(&server), &plan.chosen_hosts, &env.sync_options(), false);
            for h in report.hosts {
                let wrote = h.changes.iter().any(|c| matches!(c.kind, ChangeKind::Add | ChangeKind::Update));
                let status = match h.status {
                    "ready" if wrote => "add",
                    "ready" | "unchanged" => "unchanged",
                    "skipped" => "skipped",
                    _ => "error",
                };
                views.push(WriteView { kind: "tool", agents: h.agents, path: h.path, status, reason: h.reason, text: h.diff });
            }
            plan.server = Some((server, new));
        }
        ItemKind::Skill => {
            let text = item.skill.clone().ok_or("This item has no skill text.")?;
            let folder = format!("team-{}", slug(&item.name));
            let mut dirs: Vec<(PathBuf, Vec<AgentRef>, bool)> = Vec::new();
            for a in env.agents.iter().filter(|a| agent_ids.contains(&a.id)) {
                let agent = AgentRef { id: a.id.clone(), label: a.label.clone() };
                let Some(h) = &a.skills else {
                    views.push(WriteView {
                        kind: "skill",
                        agents: vec![agent.clone()],
                        path: String::new(),
                        status: "skipped",
                        reason: Some(format!("{} does not say where it keeps skills, so nothing can be written for it.", a.label)),
                        text: String::new(),
                    });
                    continue;
                };
                match crate::mcp_install::declarative::resolve_config_path(&h.dir, &env.home, None) {
                    Ok(dir) => match dirs.iter_mut().find(|(d, _, _)| *d == dir) {
                        Some((_, agents, installed)) => {
                            agents.push(agent);
                            *installed |= a.installed;
                        }
                        None => dirs.push((dir, vec![agent], a.installed)),
                    },
                    Err(e) => views.push(WriteView { kind: "skill", agents: vec![agent], path: String::new(), status: "error", reason: Some(e), text: String::new() }),
                }
            }
            for (dir, agents, installed) in dirs {
                let path = dir.join(&folder).join("SKILL.md");
                let existing = fs::read_to_string(&path).ok().map(|t| t.replace("\r\n", "\n"));
                let (status, reason): (&'static str, Option<String>) = match existing {
                    Some(t) if t == text.replace("\r\n", "\n") => ("unchanged", None),
                    Some(_) => ("conflict", Some(format!("A skill called {folder} is already there. It was not changed."))),
                    None if !installed && !dir.exists() => ("skipped", Some("Not installed on this computer.".into())),
                    None => ("add", None),
                };
                if status == "add" {
                    plan.skills.push(SkillWrite { view_index: views.len(), path: path.clone(), text: text.clone() });
                }
                views.push(WriteView { kind: "skill", agents, path: path.display().to_string(), status, reason, text: if status == "add" { text.clone() } else { String::new() } });
            }
        }
    }
    plan.views = views;
    Ok(plan)
}

fn risk_of(item: &ShelfItem) -> Option<Risk> {
    item.tool.as_ref().map(gate::assess)
}

/// Exactly what Add would write for these agents. Writes nothing.
pub fn preview(env: &Env, item: &ShelfItem, agent_ids: &[String]) -> Result<Preview, String> {
    let plan = plan(env, item, agent_ids)?;
    let can_add = plan.views.iter().any(|v| v.status == "add");
    let blocked = (!can_add).then(|| {
        if plan.views.iter().all(|v| v.status == "unchanged") && !plan.views.is_empty() {
            "It is already added.".to_string()
        } else {
            plan.views.iter().find_map(|v| v.reason.clone()).unwrap_or_else(|| "Nothing can be added for these agents.".into())
        }
    });
    Ok(Preview { id: item_id(item), name: item.name.clone(), kind: item.kind, risk: risk_of(item), needs: item.needs(), skipped_files: item.skipped_files, writes: plan.views, can_add, blocked })
}

// -------------------------------------------------------------------------------------- writing

fn missing_dirs(path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut cur = path.parent();
    while let Some(dir) = cur {
        if dir.exists() {
            break;
        }
        out.push(dir.to_path_buf());
        cur = dir.parent();
    }
    out.reverse();
    out
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let tmp = PathBuf::from(format!("{}.pm-tmp", path.display()));
    fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn remember(record: UndoRecord) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut guard = UNDO.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    let now = now_ms();
    map.retain(|_, r| now.saturating_sub(r.at_ms) < UNDO_MS);
    map.insert(token.clone(), record);
    token
}

/// Write what [`preview`] showed. `trusted` is the person's "I trust this" tick: without it a tool that
/// runs a shell, a file by path or an unknown program is refused.
pub fn apply(env: &Env, item: &ShelfItem, agent_ids: &[String], trusted: bool) -> Result<Applied, String> {
    if item.kind == ItemKind::Unknown {
        return Err(NEWER_NEEDED.into());
    }
    if let Some(risk) = risk_of(item) {
        if risk.needs_trust && !trusted {
            return Err(TRUST_NEEDED.into());
        }
    }
    let plan = plan(env, item, agent_ids)?;
    if !plan.views.iter().any(|v| v.status == "add") {
        return Err(plan.views.iter().find_map(|v| v.reason.clone()).unwrap_or_else(|| "Nothing to add: it is already there.".into()));
    }
    let mut record = UndoRecord { at_ms: now_ms(), ..UndoRecord::default() };
    let mut views = plan.views.clone();

    if let Some((server, new)) = &plan.server {
        // The config files as they are now, for Undo.
        let before: Vec<(PathBuf, Option<String>)> =
            plan.views.iter().filter(|v| v.kind == "tool" && v.status == "add").map(|v| (PathBuf::from(&v.path), fs::read_to_string(&v.path).ok())).collect();
        if *new {
            store::add(&env.store_path, server.clone())?;
            record.toolbelt_id = Some(server.id.clone());
        }
        let report = sync::run_only(std::slice::from_ref(server), &plan.chosen_hosts, &env.sync_options(), true);
        let mut failed = None;
        for h in &report.hosts {
            if h.status == "error" {
                failed = Some(h.reason.clone().unwrap_or_else(|| "A file could not be written.".into()));
            }
        }
        for (path, was) in before {
            let after = fs::read_to_string(&path).ok();
            if after != was {
                let after_sha = sha_hex(after.as_deref().unwrap_or(""));
                record.files.push(FileUndo { path: path.clone(), before: was, after_sha, created_dirs: Vec::new() });
            }
        }
        if let Some(why) = failed {
            undo_record(env, &record);
            return Err(why);
        }
    }
    for s in &plan.skills {
        let created_dirs = missing_dirs(&s.path);
        if let Err(e) = write_atomic(&s.path, &s.text) {
            undo_record(env, &record);
            return Err(e);
        }
        record.files.push(FileUndo { path: s.path.clone(), before: None, after_sha: sha_hex(&s.text), created_dirs });
        views[s.view_index].reason = None;
    }

    let mut agents: Vec<AgentRef> = Vec::new();
    for v in views.iter().filter(|v| v.status == "add" || v.status == "unchanged") {
        for a in &v.agents {
            if !agents.contains(a) {
                agents.push(a.clone());
            }
        }
    }
    let token = (!record.files.is_empty() || record.toolbelt_id.is_some()).then(|| remember(record));
    Ok(Applied {
        id: item_id(item),
        name: item.name.clone(),
        kind: item.kind,
        added_to: agents.iter().map(|a| a.label.clone()).collect(),
        agent_ids: agents.into_iter().map(|a| a.id).collect(),
        writes: views,
        undo: token,
    })
}

// ---------------------------------------------------------------------------------------- undo

fn undo_record(env: &Env, record: &UndoRecord) -> Undone {
    let mut out = Undone::default();
    for f in record.files.iter().rev() {
        let now = fs::read_to_string(&f.path).ok();
        if sha_hex(now.as_deref().unwrap_or("")) != f.after_sha {
            out.skipped.push(format!("{} changed since, so it was left as it is.", f.path.display()));
            continue;
        }
        let done = match &f.before {
            Some(text) => write_atomic(&f.path, text).is_ok(),
            None => fs::remove_file(&f.path).is_ok(),
        };
        if done {
            out.restored += 1;
            for dir in f.created_dirs.iter().rev() {
                let _ = fs::remove_dir(dir);
            }
        } else {
            out.skipped.push(format!("{} could not be put back.", f.path.display()));
        }
    }
    if let Some(id) = &record.toolbelt_id {
        match store::remove(&env.store_path, id) {
            Ok(_) => out.restored += 1,
            Err(e) => out.skipped.push(e),
        }
    }
    out
}

/// Put back what the add with this token changed. A file that changed since is left alone.
pub fn undo(env: &Env, token: &str) -> Result<Undone, String> {
    let record = {
        let mut guard = UNDO.lock();
        guard.as_mut().and_then(|m| m.remove(token))
    };
    let record = record.ok_or("There is nothing to undo any more.")?;
    Ok(undo_record(env, &record))
}
