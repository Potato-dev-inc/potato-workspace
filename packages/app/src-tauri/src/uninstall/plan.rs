//! The dry run. `Scan::new` looks at the PC (read only), `Scan::plan` turns that into the grouped list
//! the person sees. The executor uses the same `Scan`, so what is shown is what is removed.

use std::path::{Path, PathBuf};

use super::entries::{self, HostFile};
use super::host::{Host, WorktreeInfo};
use super::roots::{dir_stats, human_size, Profile, Roots};
use super::{gid, Cant, Group, Item, Plan};
use crate::agent_pack::plan::AgentSpec;

/// Children of `<project>/.potato-workspace` that hold chats.
pub const PROJECT_CHAT_CHILDREN: &[&str] = &["messages", "turn-summaries.json", "operations"];
/// Children that may be shared through git and edited by people.
pub const PROJECT_SHARED_CHILDREN: &[&str] = &["memory.md", "agents"];
/// The mark our block carries in `CLAUDE.md` / `AGENTS.md`.
pub const MEMORY_START: &str = "<!-- potato-workspace:memory:start -->";
/// The files our memory block is written into.
pub const MEMORY_FILES: &[&str] = &["CLAUDE.md", "AGENTS.md"];

/// A project folder the app remembers, and what is in it.
#[derive(Debug, Clone)]
pub struct ProjectScan {
    pub path: PathBuf,
    pub worktrees: Vec<WorktreeInfo>,
    pub hosts: Vec<(HostFile, Vec<String>)>,
}

/// An account whose home the person picked (outside the app's own `accounts` folder).
#[derive(Debug, Clone)]
pub struct CustomHome {
    pub label: String,
    pub path: PathBuf,
}

pub struct Scan {
    pub profiles: Vec<Profile>,
    pub specs: Vec<AgentSpec>,
    pub global_hosts: Vec<(HostFile, Vec<String>)>,
    pub projects: Vec<ProjectScan>,
    pub custom_homes: Vec<CustomHome>,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn key_of(path: &Path) -> String {
    crate::project_path::comparable_project_path(path)
}

/// Project folders named by the app's own lists, mapped back from a copy to the real folder, existing
/// only, no repeats.
pub fn remembered_projects(profiles: &[Profile], extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |raw: &str| {
        let real = crate::worktrees::origin_of_cwd(raw.trim()).unwrap_or_else(|| raw.trim().to_string());
        if real.is_empty() {
            return;
        }
        let path = PathBuf::from(real);
        if path.is_dir() && !out.iter().any(|p| key_of(p) == key_of(&path)) {
            out.push(path);
        }
    };
    for p in extra {
        add(&p.to_string_lossy());
    }
    for profile in profiles {
        if let Some(list) = read_json(&profile.data_dir.join("recent-projects.json")).and_then(|v| v.as_array().cloned()) {
            for item in list {
                if let Some(path) = item.get("path").and_then(|p| p.as_str()) {
                    add(path);
                }
            }
        }
        if let Some(list) = read_json(&profile.data_dir.join("operation-project-index.json")).and_then(|v| v.as_array().cloned()) {
            for item in list {
                if let Some(path) = item.as_str() {
                    add(path);
                }
            }
        }
    }
    out
}

/// Account homes recorded in `accounts.json`: the app's own ones live in `accounts/`, the rest were picked.
fn account_homes(profile: &Profile) -> (Vec<(String, PathBuf)>, Vec<CustomHome>) {
    let (mut own, mut custom) = (Vec::new(), Vec::new());
    let root = profile.data_dir.join("accounts");
    let Some(doc) = read_json(&profile.data_dir.join("accounts.json")) else { return (own, custom) };
    for account in doc.get("accounts").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
        let label = format!(
            "{} ({})",
            account.get("label").and_then(|v| v.as_str()).unwrap_or("account"),
            account.get("agent_id").and_then(|v| v.as_str()).unwrap_or("agent")
        );
        let Some(home) = account.get("home").and_then(|v| v.as_str()).map(PathBuf::from) else { continue };
        if key_of(&home).starts_with(&format!("{}/", key_of(&root))) {
            own.push((label, home));
        } else {
            custom.push(CustomHome { label, path: home });
        }
    }
    (own, custom)
}

impl Scan {
    pub fn new(roots: &Roots, host: &dyn Host) -> Self {
        let profiles = roots.profiles();
        let mut specs = host.agent_specs(&profiles.first().map(|p| p.data_dir.clone()).unwrap_or_else(|| roots.appdata.clone()));
        for profile in &profiles {
            crate::agent_pack::custom::merge(&mut specs, &crate::agent_pack::custom::load(&profile.data_dir));
        }
        let with_keys = |hosts: Vec<HostFile>| -> Vec<(HostFile, Vec<String>)> {
            hosts.into_iter().map(|h| { let k = entries::our_keys(&h); (h, k) }).filter(|(_, k)| !k.is_empty()).collect()
        };
        let global_hosts = with_keys(entries::global_hosts(&specs, roots));
        let projects = remembered_projects(&profiles, &roots.projects)
            .into_iter()
            .map(|path| ProjectScan {
                worktrees: host.worktrees(&path),
                hosts: with_keys(entries::project_hosts(&specs, &path)),
                path,
            })
            .collect();
        let custom_homes = profiles.iter().flat_map(|p| account_homes(p).1).collect();
        Self { profiles, specs, global_hosts, projects, custom_homes }
    }

    /// Skill folders of ours, per agent skills folder (deduplicated).
    pub fn skill_dirs(&self, roots: &Roots) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for spec in &self.specs {
            let Some(table) = &spec.skills else { continue };
            let Ok(dir) = crate::mcp_install::declarative::resolve_config_path(&table.dir, &roots.home, None) else { continue };
            if !out.contains(&dir) {
                out.push(dir);
            }
        }
        out
    }

    /// Paths that hold chats, wherever they are. Deleting them is the "Your chats" group; "Keep my
    /// chats" zips them first.
    pub fn chat_paths(&self, roots: &Roots) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for p in &self.profiles {
            out.push(p.data_dir.join("acp").join("journals"));
            out.push(p.data_dir.join("chat-index.sqlite"));
        }
        out.push(roots.home.join(crate::app_paths::COMPANION_HOME_DIR_NAME).join("companions"));
        for project in &self.projects {
            let data = crate::app_paths::project_data_dir(&project.path);
            for child in PROJECT_CHAT_CHILDREN {
                out.push(data.join(child));
            }
        }
        out.retain(|p| p.exists());
        out
    }

    /// Paths inside the app data that a ticked group does not cover, so the helper must keep them.
    pub fn keep_inside_app_data(&self, selection: &super::Selection, roots: &Roots) -> Vec<PathBuf> {
        let mut keep = Vec::new();
        if !selection.has(gid::CHATS) {
            keep.extend(self.chat_paths(roots));
        }
        if !selection.has(gid::SIGN_INS) {
            for p in &self.profiles {
                keep.push(p.data_dir.join("accounts"));
                keep.push(p.data_dir.join("accounts.json"));
            }
        }
        keep
    }

    pub fn plan(&self, roots: &Roots, host: &dyn Host) -> Plan {
        let mut groups: Vec<Group> = Vec::new();
        let mut cant: Vec<Cant> = Vec::new();

        // Program.
        if let Some(dir) = roots.install_dir.as_ref().filter(|d| d.is_dir()) {
            let (bytes, files) = dir_stats(dir);
            groups.push(group(gid::PROGRAM, "The program", "Potato Workspace, its Start menu and desktop icons.", bytes, files, vec![
                Item { label: dir.display().to_string(), path: Some(dir.display().to_string()), bytes, files },
                Item::new("Start menu and desktop shortcuts", None),
            ]));
            cant.push(Cant {
                title: "Windows asks once for permission".into(),
                how: "The program is installed for every user, so removing it needs your OK. If you say no, open Settings > Apps > Potato Workspace and press Uninstall.".into(),
            });
        }

        // Start at sign-in.
        let on = host.autostart_on();
        let mut g = group(gid::AUTOSTART, "Open when I sign in", if on { "The Windows startup entry is on." } else { "The Windows startup entry is already off." }, 0, 0, vec![Item::new("Run entry: Potato Workspace", None)]);
        g.size = if on { "on".into() } else { "off".into() };
        groups.push(g);

        // App data.
        let mut items = Vec::new();
        let (mut bytes, mut files) = (0, 0);
        for p in &self.profiles {
            for (label, dir) in [("", &p.data_dir), (" (browser data)", &p.local_dir)] {
                if dir.is_dir() {
                    let (b, f) = dir_stats(dir);
                    bytes += b;
                    files += f;
                    items.push(Item { label: format!("{}{label}", dir.display()), path: Some(dir.display().to_string()), bytes: b, files: f });
                }
            }
        }
        for temp in temp_leftovers(&roots.temp) {
            let (b, f) = dir_stats(&temp);
            bytes += b;
            files += f;
            items.push(Item { label: temp.display().to_string(), path: Some(temp.display().to_string()), bytes: b, files: f });
        }
        if !items.is_empty() {
            let n = self.profiles.len();
            groups.push(group(gid::APP_DATA, "App data", &format!("Settings, logs and saved state, for {n} profile{}.", if n == 1 { "" } else { "s" }), bytes, files, items));
        }

        // Sign-ins made here.
        let mut items = Vec::new();
        let (mut bytes, mut files) = (0, 0);
        for p in &self.profiles {
            let (own, _) = account_homes(p);
            for (label, home) in own {
                if home.is_dir() {
                    let (b, f) = dir_stats(&home);
                    bytes += b;
                    files += f;
                    items.push(Item { label: format!("{} - {label}", home.display()), path: Some(home.display().to_string()), bytes: b, files: f });
                }
            }
        }
        if !items.is_empty() {
            let n = items.len();
            let mut g = group(gid::SIGN_INS, "Agent sign-ins made here", "Extra logins for helper agents. You sign in again later.", bytes, files, items);
            g.size = format!("{n} account{}", if n == 1 { "" } else { "s" });
            groups.push(g);
        }
        for custom in &self.custom_homes {
            cant.push(Cant {
                title: format!("Agent folder you picked: {}", custom.path.display()),
                how: format!("{} uses a folder of your own, so it is kept. It may be your real login.", custom.label),
            });
        }

        // Saved keys.
        match host.credential_targets() {
            Ok(targets) if !targets.is_empty() => {
                let mut g = group(gid::KEYS, "Saved keys and pairings", "Keys in Windows Credential Manager. Phones and teams unpair.", 0, 0, vec![Item::new("*.com.potatodev.workspace", None)]);
                g.size = format!("{} key{}", targets.len(), if targets.len() == 1 { "" } else { "s" });
                g.files = targets.len() as u64;
                groups.push(g);
            }
            Ok(_) => {}
            Err(e) => cant.push(Cant { title: "Saved keys".into(), how: format!("The credential store could not be read ({e}). Open Credential Manager and remove entries that end in com.potatodev.workspace.") }),
        }

        // Agent connections.
        let mut items = Vec::new();
        let mut connections = 0u64;
        for (h, keys) in &self.global_hosts {
            for key in keys {
                connections += 1;
                items.push(Item::new(format!("{} - {} - {key}", h.label, h.path.display()), Some(h.path.display().to_string())));
            }
        }
        for project in &self.projects {
            for (h, keys) in &project.hosts {
                for key in keys {
                    connections += 1;
                    items.push(Item::new(format!("{} - {} - {key}", h.label, h.path.display()), Some(h.path.display().to_string())));
                }
            }
        }
        for dir in self.skill_dirs(roots) {
            let ours = entries::our_skill_dirs(&dir);
            if !ours.is_empty() {
                connections += ours.len() as u64;
                items.push(Item::new(format!("{} - {} skills", dir.display(), ours.len()), Some(dir.display().to_string())));
            }
        }
        if !items.is_empty() {
            let mut g = group(gid::CONNECTIONS, "Agent connections", "Only our entry. Your other agent settings stay. Backed up first.", 0, 0, items);
            g.connections = connections;
            g.size = format!("{connections} entr{}", if connections == 1 { "y" } else { "ies" });
            groups.push(g);
        }

        // Files in projects.
        let mut items = Vec::new();
        let (mut bytes, mut files) = (0, 0);
        for project in &self.projects {
            let data = crate::app_paths::project_data_dir(&project.path);
            if data.is_dir() {
                let (b, f) = dir_stats(&data);
                bytes += b;
                files += f;
                items.push(Item { label: data.display().to_string(), path: Some(data.display().to_string()), bytes: b, files: f });
            }
            for file in MEMORY_FILES {
                let path = project.path.join(file);
                if std::fs::read_to_string(&path).is_ok_and(|t| t.contains(MEMORY_START)) {
                    items.push(Item::new(format!("{} - our block only", path.display()), Some(path.display().to_string())));
                }
            }
            if crate::git_exclude::has_our_block(&project.path) {
                items.push(Item::new(format!("{} - our lines only", project.path.join(".git").join("info").join("exclude").display()), None));
            }
            if let Some(flag) = entries::blanket_trust_flag(&project.path) {
                cant.push(Cant {
                    title: format!("A setting in {}", flag.display()),
                    how: "enableAllProjectMcpServers is on. We can't tell if we turned it on, so it is left. Remove that line if you don't want it.".into(),
                });
            }
        }
        if !items.is_empty() {
            let n = self.projects.len();
            let mut g = group(gid::PROJECTS, "Files in your projects", &format!("Our hidden folder, memory notes and git lines, in {n} project{}.", if n == 1 { "" } else { "s" }), bytes, files, items);
            g.size = format!("{n} project{}", if n == 1 { "" } else { "s" });
            groups.push(g);
        }

        // Copies and branches.
        let (mut safe, mut unsaved) = (Vec::new(), Vec::new());
        for project in &self.projects {
            for wt in &project.worktrees {
                let item = Item::new(format!("{} - {}", project.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), wt.branch), Some(wt.path.clone()));
                if wt.unsaved { unsaved.push(item) } else { safe.push(item) }
            }
        }
        if !safe.is_empty() {
            let n = safe.len();
            let mut g = group(gid::COPIES, "Copies and branches", "Safe copies agents worked in. Branches with no new work.", 0, 0, safe);
            g.size = format!("{n} cop{}", if n == 1 { "y" } else { "ies" });
            groups.push(g);
        }

        // Chats.
        let chat_paths = self.chat_paths(roots);
        if !chat_paths.is_empty() {
            let (mut bytes, mut files) = (0, 0);
            let items: Vec<Item> = chat_paths
                .iter()
                .map(|p| {
                    let (b, f) = dir_stats(p);
                    bytes += b;
                    files += f;
                    Item { label: p.display().to_string(), path: Some(p.display().to_string()), bytes: b, files: f }
                })
                .collect();
            groups.push(group(gid::CHATS, "Your chats", "Chat history and search. Untick it to keep them where they are, or use Keep my chats.", bytes, files, items));
        }

        // Unticked groups.
        if !unsaved.is_empty() {
            let n = unsaved.len();
            let mut g = group(gid::UNSAVED_BRANCHES, "Branches with unsaved work", "Kept unless you tick this. They hold work you have not merged.", 0, 0, unsaved);
            g.size = format!("{n} cop{}", if n == 1 { "y" } else { "ies" });
            g.default_on = false;
            g.keep_reason = Some("They hold work that is not merged.".into());
            groups.push(g);
        }
        let mut notes = Vec::new();
        for project in &self.projects {
            let data = crate::app_paths::project_data_dir(&project.path);
            for child in PROJECT_SHARED_CHILDREN {
                let path = data.join(child);
                if path.exists() {
                    notes.push(Item::new(path.display().to_string(), Some(path.display().to_string())));
                }
            }
        }
        if !notes.is_empty() {
            let n = notes.len();
            let mut g = group(gid::SHARED_NOTES, "Shared project notes", "memory.md and agent files. Teammates may use them in git.", 0, 0, notes);
            g.size = format!("{n} item{}", if n == 1 { "" } else { "s" });
            g.default_on = false;
            g.keep_reason = Some("Teammates may use them.".into());
            groups.push(g);
        }
        let store = store_programs(&self.profiles);
        if !store.is_empty() {
            let n = store.len();
            let items = store.iter().map(|(id, how)| Item::new(format!("{id} ({how})"), None)).collect();
            let mut g = group(gid::STORE_PROGRAMS, "Agent programs from the Agent Store", "You may use them without us.", 0, 0, items);
            g.size = format!("{n} program{}", if n == 1 { "" } else { "s" });
            g.default_on = false;
            g.keep_reason = Some("You may use them without Potato Workspace.".into());
            groups.push(g);
        }

        // Always-there things we cannot do.
        cant.push(Cant { title: "The relay in your Cloudflare account".into(), how: "If you set one up, delete the worker called pm-relay and any tunnel in your Cloudflare dashboard. We never keep your Cloudflare token.".into() });
        cant.push(Cant { title: "Telegram and Discord bots".into(), how: "They belong to your own account. In Telegram, message @BotFather and send /deletebot if you want it gone.".into() });
        cant.push(Cant { title: "Branches already pushed to GitHub".into(), how: "Branches that start with pm/ may be on GitHub. Delete them from the repository page.".into() });
        cant.push(Cant { title: "The Potato app on your phone's home screen".into(), how: "Press and hold the icon on your phone and remove it.".into() });
        cant.push(Cant { title: "OpenCode's sign-in file".into(), how: "Switching keys may have rewritten opencode's auth.json. There is no earlier copy, so sign in to OpenCode again if it asks.".into() });
        cant.push(Cant { title: "Project folders the app no longer remembers".into(), how: "Look for a hidden .potato-workspace folder and delete it.".into() });

        let total_files = groups.iter().filter(|g| g.default_on).map(|g| g.files).sum();
        let connections = groups.iter().map(|g| g.connections).sum();
        let keys = groups.iter().find(|g| g.id == gid::KEYS).map(|g| g.files).unwrap_or(0);
        Plan {
            groups,
            cant,
            profiles: self.profiles.iter().map(|p| p.id.clone()).collect(),
            total_files,
            connections,
            keys,
            chats_zip_name: super::chats::zip_name(super::chats::today()),
            keep_chats_default: false,
        }
    }
}

fn group(id: &str, title: &str, detail: &str, bytes: u64, files: u64, items: Vec<Item>) -> Group {
    Group {
        id: id.into(),
        title: title.into(),
        detail: detail.into(),
        size: if bytes > 0 { human_size(bytes) } else { String::new() },
        bytes,
        files,
        connections: 0,
        default_on: true,
        keep_reason: None,
        items,
    }
}

/// Leftover temp folders of ours.
pub fn temp_leftovers(temp: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(temp) else { return Vec::new() };
    let mut out: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name == "potato-workspace-doctor" || name.starts_with("pm-store-check-")
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// `(catalog id, install method)` for programs the Store installed, from each profile's record file.
pub fn store_programs(profiles: &[Profile]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for p in profiles {
        let record = crate::agent_store::record::load(&p.data_dir.join(crate::agent_store::record::FILE_NAME));
        for (id, agent) in record.agents {
            if let Some(install) = agent.install {
                if !out.iter().any(|(i, _)| *i == id) {
                    out.push((id, install.method));
                }
            }
        }
    }
    out
}
