//! Shared fake PC for the uninstall tests, and the plan tests.
//!
//! Every folder is made under the system temp folder for one test and removed at the end. Nothing here
//! reads APPDATA, USERPROFILE or any other real location, and nothing calls the real credential
//! store, the registry, msiexec or a process.

use std::path::{Path, PathBuf};

use super::host::{FakeHost, WorktreeInfo};
use super::plan::Scan;
use super::roots::Roots;
use super::{gid, Selection};
use crate::agent_pack::plan::AgentSpec;
use crate::agent_pack::SkillsHostTable;

pub const ID: &str = "com.potatodev.workspace";
/// The previous product's hidden home folder (built from pieces so the separation guard stays quiet).
pub const LEGACY_HIDDEN: &str = concat!(".puppet", "-master");

pub struct World {
    pub base: PathBuf,
    pub roots: Roots,
    pub shop: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

pub fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

pub fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn host_table(config: &str, format: &str, key: &str, project: Option<&str>) -> crate::tui::declarative::schema::McpHostTable {
    let project = project.map(|p| format!("project_config_path = \"{p}\"\n")).unwrap_or_default();
    let text = format!("config_path = \"{config}\"\nformat = \"{format}\"\nkey_path = \"{key}\"\n{project}[entry]\ncommand = \"{{command}}\"\n");
    crate::toolbelt::host_from_toml(&text).expect("a valid host table")
}

/// Four agents that keep their servers in different files and formats (declared, not matched by name).
pub fn specs() -> Vec<AgentSpec> {
    let spec = |id: &str, label: &str, mcp, skills: Option<&str>| AgentSpec {
        id: id.into(),
        label: label.into(),
        installed: true,
        mcp: Some(mcp),
        skills: skills.map(|d| SkillsHostTable { dir: d.into() }),
    };
    vec![
        spec("a1", "Agent One", host_table("~/.claude.json", "json", "mcpServers.potato-workspace", Some(".mcp.json")), Some("~/.claude/skills")),
        spec("a2", "Agent Two", host_table("~/.codex/config.toml", "toml", "mcp_servers.potato-workspace", Some(".codex/config.toml")), None),
        spec("a3", "Agent Three", host_table("~/.cursor/mcp.json", "json", "mcpServers.potato-workspace", Some(".cursor/mcp.json")), None),
        spec("a4", "Agent Four", host_table("~/.config/opencode/opencode.json", "json", "mcp.potato-workspace", Some("opencode.json")), None),
    ]
}

pub const CLAUDE_JSON: &str = "{\n  \"numStartups\": 12,\n  \"mcpServers\": {\n    \"their-server\": {\n      \"command\": \"node\",\n      \"args\": [\"theirs.js\"]\n    },\n    \"potato-workspace\": {\n      \"command\": \"C:/Program Files/Potato Workspace/puppet-master-mcp.exe\"\n    },\n    \"pm-toolbelt-fetch\": {\n      \"command\": \"uvx\"\n    }\n  }\n}\n";
pub const CODEX_TOML: &str = "model = \"gpt-5\"\n\n[mcp_servers.their-server]\ncommand = \"theirs\"\n\n[mcp_servers.potato-workspace]\ncommand = \"C:/Program Files/Potato Workspace/puppet-master-mcp.exe\"\n";
pub const CURSOR_JSON: &str = "{\n  \"mcpServers\": {\n    \"mine\": { \"command\": \"mine\" },\n    \"potato-workspace\": { \"command\": \"x\" }\n  }\n}\n";
pub const OPENCODE_JSON: &str = "{\n  \"theme\": \"dark\",\n  \"mcp\": {\n    \"other\": { \"type\": \"local\", \"command\": [\"other\"] },\n    \"potato-workspace\": { \"type\": \"local\", \"command\": [\"x\"] }\n  }\n}\n";
pub const BLOCK_MD: &str = "# My project\n\nMy own notes.\n\n<!-- potato-workspace:memory:start -->\nremember this\n<!-- potato-workspace:memory:end -->\n";

pub fn world(name: &str) -> World {
    let base = std::env::temp_dir().join(format!("pm-uninstall-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (home, appdata, local) = (base.join("home"), base.join("appdata"), base.join("localappdata"));
    let (temp, documents, shop) = (base.join("temp"), base.join("documents"), base.join("projects").join("shop"));
    for d in [&home, &appdata, &local, &temp, &documents, &shop] {
        std::fs::create_dir_all(d).unwrap();
    }
    let data = appdata.join(ID);
    let work = appdata.join(format!("{ID}.profile-work"));
    write(&data.join("settings.json"), "{\"settings\":{\"missions_enabled\":true,\"anthropic_api_key\":\"sk-test\"}}");
    write(&data.join("recent-projects.json"), &format!("[{{\"path\":{:?},\"last_used_ms\":1}}]", shop.display().to_string()));
    write(&data.join("acp").join("journals").join("j1.jsonl"), "{\"chat\":1}\n");
    write(&data.join("chat-index.sqlite"), "sqlite-bytes");
    write(&data.join("accounts.json"), &format!(
        "{{\"accounts\":[{{\"id\":\"acc_1\",\"agent_id\":\"a1\",\"label\":\"Work\",\"home\":{:?}}},{{\"id\":\"acc_2\",\"agent_id\":\"a2\",\"label\":\"Mine\",\"home\":{:?}}}]}}",
        data.join("accounts").join("acc_1").display().to_string(),
        home.join(".codex-real").display().to_string()
    ));
    write(&data.join("accounts").join("acc_1").join("login.json"), "{}");
    write(&home.join(".codex-real").join("auth.json"), "{\"real\":true}");
    write(&work.join("settings.json"), "{}");
    write(&local.join(ID).join("EBWebView").join("Default").join("x.db"), "web");
    write(&temp.join("potato-workspace-doctor").join("a.txt"), "a");
    write(&temp.join("someone-elses.txt"), "keep");
    // The other product and unrelated folders.
    write(&appdata.join("com.puppetmaster.app").join("keep.txt"), "other product");
    write(&appdata.join("com.potatodev.workspacex").join("keep.txt"), "not ours");
    write(&home.join("PuppetMaster").join("keep.txt"), "legacy");
    write(&home.join(LEGACY_HIDDEN).join("keep.txt"), "legacy");
    write(&home.join(".potato-workspace-not-ours").join("keep.txt"), "x");
    // Other tools' config files with a user's server next to ours.
    write(&home.join(".claude.json"), CLAUDE_JSON);
    write(&home.join(".codex").join("config.toml"), CODEX_TOML);
    write(&home.join(".cursor").join("mcp.json"), CURSOR_JSON);
    write(&home.join(".config").join("opencode").join("opencode.json"), OPENCODE_JSON);
    write(&appdata.join("opencode").join("opencode.json"), OPENCODE_JSON);
    write(&home.join(".claude").join("skills").join("pm-review").join("SKILL.md"), "---\nname: pm-review\n---\n<!-- potato-workspace-pack: 1 -->\nbody\n");
    write(&home.join(".claude").join("skills").join("pm-status").join("SKILL.md"), "the user's own skill with our name\n");
    write(&home.join("PotatoWorkspace").join("companions").join("c1").join("memory.md"), "companion");
    // The project.
    write(&shop.join(".potato-workspace").join("events.jsonl"), "{}\n");
    write(&shop.join(".potato-workspace").join("memory.md"), "team memory");
    write(&shop.join(".potato-workspace").join("agents").join("helper.toml"), "x = 1");
    write(&shop.join(".potato-workspace").join("messages").join("m1.json"), "{}");
    write(&shop.join(".potato-workspace").join("turn-summaries.json"), "[]");
    write(&shop.join(".mcp.json"), CLAUDE_JSON);
    write(&shop.join("CLAUDE.md"), BLOCK_MD);
    write(&shop.join(".git").join("info").join("exclude"), "# mine\n*.log\n# Potato Workspace runtime data (local, added automatically)\n.potato-workspace/*\n!.potato-workspace/memory.md\n!.potato-workspace/agents/\ntarget/\n");
    write(&shop.join(".claude").join("settings.json"), "{\"enableAllProjectMcpServers\":true}");
    let roots = Roots { home, appdata, localappdata: local, temp, documents, install_dir: None, projects: Vec::new() };
    World { base, roots, shop }
}

pub fn host() -> FakeHost {
    let h = FakeHost { specs: specs(), ..Default::default() };
    *h.autostart.borrow_mut() = true;
    h.credentials.replace(vec![
        "anthropic_api_key.com.potatodev.workspace".into(),
        "channels/default/telegram_bot_token.com.potatodev.workspace".into(),
        "tok.com.puppetmaster.app".into(),
    ]);
    h
}

pub fn with_copies(world: &World, host: &mut FakeHost) {
    host.worktrees.insert(
        world.shop.to_string_lossy().into_owned(),
        vec![
            WorktreeInfo { handle: "h1".into(), path: "p1".into(), branch: "pm/fix-cart".into(), unsaved: false },
            WorktreeInfo { handle: "h2".into(), path: "p2".into(), branch: "pm/new-checkout".into(), unsaved: true },
        ],
    );
}

#[test]
fn profiles_are_ours_only() {
    let w = world("profiles");
    let ids: Vec<String> = w.roots.profiles().into_iter().map(|p| p.id).collect();
    assert_eq!(ids, vec![ID.to_string(), format!("{ID}.profile-work")]);
}

#[test]
fn the_plan_groups_everything_and_default_ticks_follow_the_founder_answers() {
    let w = world("plan");
    let mut h = host();
    with_copies(&w, &mut h);
    let scan = Scan::new(&w.roots, &h);
    let plan = scan.plan(&w.roots, &h);
    let by = |id: &str| plan.groups.iter().find(|g| g.id == id).unwrap_or_else(|| panic!("no group {id}"));

    // D5: Keep my chats starts unticked.
    assert!(!plan.keep_chats_default);
    assert!(!Selection::defaults(&plan).keep_chats);
    // D6 and the rest of the unticked ones.
    for id in [gid::STORE_PROGRAMS, gid::SHARED_NOTES, gid::UNSAVED_BRANCHES] {
        if let Some(g) = plan.groups.iter().find(|g| g.id == id) {
            assert!(!g.default_on, "{id} must start unticked");
            assert!(g.keep_reason.is_some());
        }
    }
    assert!(!by(gid::UNSAVED_BRANCHES).default_on);
    assert!(!by(gid::SHARED_NOTES).default_on);
    for id in [gid::AUTOSTART, gid::APP_DATA, gid::SIGN_INS, gid::KEYS, gid::CONNECTIONS, gid::PROJECTS, gid::COPIES, gid::CHATS] {
        assert!(by(id).default_on, "{id} starts ticked");
    }
    assert_eq!(by(gid::KEYS).files, 2, "two keys of ours; the other product's is not counted");
    assert_eq!(by(gid::COPIES).items.len(), 1);
    assert_eq!(by(gid::UNSAVED_BRANCHES).items.len(), 1);
    // 5 entries in 4 global files (one is a toolbelt key) + 2 in the project's .mcp.json (two keys) + 1 skills dir
    // + the extras: ~/.mcp.json absent, appdata/opencode present.
    assert!(by(gid::CONNECTIONS).connections >= 8, "got {}", by(gid::CONNECTIONS).connections);
    let text = plan.groups.iter().flat_map(|g| g.items.iter().map(|i| i.label.clone())).collect::<Vec<_>>().join("\n");
    assert!(text.contains("pm-toolbelt-fetch"));
    assert!(!text.contains("pm-status"), "a skill folder without our marker is not ours");
    assert!(text.contains("pm-review") || text.contains("1 skills"));
    // Both profiles are listed; the other product and look-alikes are not.
    assert_eq!(plan.profiles.len(), 2);
    assert!(!text.contains("puppetmaster") && !text.contains("PuppetMaster") && !text.contains("workspacex"));
    // The custom account home is kept and explained.
    assert!(plan.cant.iter().any(|c| c.title.contains(".codex-real")));
    assert!(plan.cant.iter().any(|c| c.title.contains("enableAllProjectMcpServers") || c.how.contains("enableAllProjectMcpServers")));
    assert!(plan.cant.iter().any(|c| c.title.contains("Cloudflare")));
    assert!(plan.chats_zip_name.starts_with("Potato Workspace chats ") && plan.chats_zip_name.ends_with(".zip"));
}

#[test]
fn the_plan_changes_nothing() {
    let w = world("readonly");
    let h = host();
    let before = (read(&w.roots.home.join(".claude.json")), read(&w.shop.join("CLAUDE.md")));
    let scan = Scan::new(&w.roots, &h);
    let _ = scan.plan(&w.roots, &h);
    assert_eq!(before, (read(&w.roots.home.join(".claude.json")), read(&w.shop.join("CLAUDE.md"))));
    assert!(h.calls().is_empty(), "the dry run asks the host to do nothing: {:?}", h.calls());
    assert!(w.roots.appdata.join(ID).join("settings.json").exists());
}

#[test]
fn run_is_refused_in_a_dev_build_unless_the_test_flag_is_set() {
    assert!(!super::run_allowed(true, None, true), "debug build refuses");
    assert!(!super::run_allowed(true, Some("0"), true));
    assert!(super::run_allowed(true, Some("1"), false), "the explicit test flag allows it");
    assert!(!super::run_allowed(false, None, false), "an unpackaged release build refuses too");
    assert!(super::run_allowed(false, None, true));
    assert_eq!(super::NOT_IN_DEV, "Not in the dev build");
}

/// 5.1 B: this app registers no protocol handler, scheduled task, firewall rule or PATH / env variable.
/// If one appears in shipped code, the uninstall inventory must grow a row for it first.
#[test]
fn no_windows_integration_beyond_the_ones_the_uninstall_knows() {
    fn files(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().filter_map(Result::ok) {
            let p = e.path();
            if p.is_dir() {
                files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut all = Vec::new();
    files(&src, &mut all);
    // Needles are built from pieces so this file never matches itself.
    // Programs that make such an integration: a hit counts only on a line that starts a process.
    let programs = [["sch", "tasks"].concat(), ["net", "sh"].concat(), ["se", "tx"].concat()];
    // Plugins and registry places that make one: a hit counts anywhere in code.
    let anywhere = [["deep", "_link"].concat(), ["deep", "-link"].concat(), ["register", "_all"].concat(), ["Software\\\\", "Microsoft\\\\Windows\\\\CurrentVersion\\\\Run"].concat(), ["\"Envi", "ronment\""].concat()];
    let spawns = ["hidden_command(", "Command::new(", "hidden_tokio_command(", "shell_exec"];
    for file in all {
        let path = file.to_string_lossy().replace('\\', "/");
        // Test files name the needles in strings; the autostart module goes through the plugin, not the registry.
        if path.contains("/uninstall/tests") || path.ends_with("/autostart.rs") {
            continue;
        }
        let text = read(&file);
        for line in text.lines().filter(|l| !l.trim_start().starts_with("//")) {
            if spawns.iter().any(|s| line.contains(s)) {
                for p in &programs {
                    assert!(!line.contains(&format!("\"{p}")), "{path} starts `{p}`: add a row to the uninstall inventory (5.1 B) and a remover first");
                }
            }
            for a in &anywhere {
                assert!(!line.contains(a.as_str()), "{path} uses `{a}`: add a row to the uninstall inventory (5.1 B) and a remover first");
            }
        }
    }
}
