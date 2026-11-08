//! Agent pack tests: temp home folders, the built-in agents' real declarations, golden config files,
//! undo, and checks that the pack text matches the real MCP tool catalog.
//!
//! Golden files live in `golden/`. `UPDATE_GOLDEN=1 cargo test --lib agent_pack` rewrites them; read
//! the diff before committing.

use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::plan::{self, AgentSpec, FileKind, Options};
use super::service::{self, Env};
use super::{assets, MARKER_PREFIX};
use crate::mcp_install::declarative::HostLaunch;

fn temp(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("pm-agent-pack-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn launch() -> HostLaunch {
    HostLaunch {
        command: "npx".into(),
        args: vec!["-y".into(), "@potato-workspace/mcp".into()],
        env: vec![("POTATO_WORKSPACE_BRIDGE_PORT_FILE".into(), "C:/pm/potato-workspace.bridge.port".into())],
        ..Default::default()
    }
}

fn spec(id: &str, installed: bool) -> AgentSpec {
    let p = crate::tui::profile_for(id);
    AgentSpec { id: id.into(), label: id.to_uppercase(), installed, mcp: p.mcp_host(), skills: p.skills_host() }
}

fn env(agents: Vec<AgentSpec>, home: &Path) -> Env {
    Env::new(agents, home.to_path_buf(), home.join("appdata"), launch())
}

/// Every file (bytes) and directory under `root`, relative, ignoring the app-data state folder.
fn tree(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if rel.starts_with("appdata") {
                continue;
            }
            if p.is_dir() {
                out.insert(format!("{rel}/"), None);
                walk(&p, root, out);
            } else {
                out.insert(rel, Some(fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn read(p: &Path) -> String {
    fs::read_to_string(p).unwrap().replace("\r\n", "\n")
}

fn golden(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent_pack/golden").join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() || !path.exists() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, actual).unwrap();
    }
    let want = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    assert_eq!(actual, want, "golden file {name} differs (run with UPDATE_GOLDEN=1 to rewrite)");
}

/// (agent id, the agent's config file under home, what the user already had there, golden name)
const CONFIGS: &[(&str, &str, &str, &str)] = &[
    (
        "claude",
        ".claude.json",
        "{\n  \"numStartups\": 12,\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"mine\": {\n      \"command\": \"my-server\"\n    }\n  }\n}\n",
        "claude.json.golden",
    ),
    ("codex", ".codex/config.toml", "# my config\nmodel = \"gpt-5\"\n\n[mcp_servers.mine]\ncommand = \"mine\"\n", "codex.toml.golden"),
    (
        "cursor_agent",
        ".cursor/mcp.json",
        "{\n  \"mcpServers\": {\n    \"mine\": {\n      \"command\": \"my-server\"\n    }\n  }\n}\n",
        "cursor_agent.json.golden",
    ),
    (
        "opencode",
        ".config/opencode/opencode.json",
        "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"theme\": \"tokyonight\"\n}\n",
        "opencode.json.golden",
    ),
];

fn seed(home: &Path, rel: &str, text: &str) {
    let p = home.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

#[test]
fn builtin_agents_declare_where_skills_and_mcp_live() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("decl");
    for id in ["claude", "codex", "cursor_agent", "opencode", "opencode_native"] {
        let s = spec(id, true);
        let dir = s.skills.as_ref().unwrap_or_else(|| panic!("{id} declares a skills folder")).dir.clone();
        assert!(crate::mcp_install::declarative::resolve_config_path(&dir, &home, None).is_ok(), "{id}: {dir}");
        assert!(s.mcp.is_some(), "{id} declares an MCP host");
    }
    let live = service::live_specs();
    assert!(live.iter().all(|s| s.id != "powershell" && s.id != "bash"), "shells are not agents here");
}

#[test]
fn golden_files_per_agent() {
    let _serial = crate::tui::registry::test_serial();
    for (id, rel, user_text, golden_name) in CONFIGS {
        let home = temp(id);
        seed(&home, rel, user_text);
        let e = env(vec![spec(id, true)], &home);

        // Preview writes nothing.
        let before = tree(&home);
        let v = service::call(&e, "preview").unwrap();
        assert_eq!(v["dry_run"], true);
        assert_eq!(tree(&home), before, "{id}: preview must not write");
        assert!(!home.join("appdata").exists(), "{id}: preview must not create state");
        assert_eq!(v["agents"][0]["skills"]["status"], "ready", "{id}");
        assert_eq!(v["agents"][0]["mcp"]["status"], "ready", "{id}");

        // Apply writes the config entry and the four skills.
        let v = service::call(&e, "apply").unwrap();
        assert_eq!(v["agents"][0]["skills"]["written"], true, "{id}");
        assert_eq!(v["agents"][0]["mcp"]["written"], true, "{id}");
        golden(golden_name, &read(&home.join(rel)));
        let dir = crate::mcp_install::declarative::resolve_config_path(&spec(id, true).skills.unwrap().dir, &home, None).unwrap();
        for (name, text) in assets::files() {
            assert_eq!(read(&dir.join(&name)), text, "{id}: {name}");
        }
        assert_eq!(fs::read_to_string(format!("{}.bak", home.join(rel).display())).unwrap(), *user_text, "{id}: .bak is the user's file");

        // A second apply changes nothing.
        let after = tree(&home);
        let v = service::call(&e, "apply").unwrap();
        assert_eq!(v["agents"][0]["skills"]["status"], "unchanged", "{id}");
        assert_eq!(v["agents"][0]["mcp"]["status"], "unchanged", "{id}");
        assert_eq!(tree(&home), after, "{id}: idempotent");
    }
}

#[test]
fn undo_restores_the_originals_byte_for_byte() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("undo");
    for (_, rel, user_text, _) in CONFIGS.iter().filter(|c| c.0 != "opencode") {
        seed(&home, rel, user_text);
    }
    // A skill of the user's own at one of our paths: replaced on apply, restored on undo.
    seed(&home, ".claude/skills/potato-workspace/SKILL.md", "---\nname: potato-workspace\ndescription: mine\n---\nMy own notes.\n");
    let agents: Vec<AgentSpec> = ["claude", "codex", "cursor_agent", "opencode", "opencode_native"].iter().map(|id| spec(id, true)).collect();
    let e = env(agents, &home);
    let original = tree(&home);

    let v = service::call(&e, "apply").unwrap();
    let claude = v["agents"].as_array().unwrap().iter().find(|a| a["id"] == "claude").unwrap();
    let replaced = claude["skills"]["files"].as_array().unwrap().iter().find(|f| f["name"] == "potato-workspace/SKILL.md").unwrap();
    assert_eq!(replaced["kind"], "replace", "a file that is not ours is replaced (and backed up)");
    assert_ne!(tree(&home), original);
    assert!(v["recorded"].as_u64().unwrap() >= 8);
    assert!(home.join(".agents/skills/pm-review/SKILL.md").exists());

    let u = service::call(&e, "undo").unwrap();
    assert!(u["skipped"].as_array().unwrap().is_empty(), "{u}");
    assert_eq!(u["recorded"], 0);
    assert_eq!(tree(&home), original, "files, bytes and directories are back as they were");
}

#[test]
fn an_entry_that_is_already_there_is_never_rewritten() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("existing");
    let user = "{\n  \"mcpServers\": {\n    \"potato-workspace\": {\n      \"command\": \"C:/mine/pm-mcp.exe\"\n    }\n  }\n}\n";
    seed(&home, ".cursor/mcp.json", user);
    let e = env(vec![spec("cursor_agent", true)], &home);
    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["status"], "unchanged");
    assert_eq!(read(&home.join(".cursor/mcp.json")), user);
    assert!(!home.join(".cursor/mcp.json.bak").exists());
    // The skills were still added, and undo leaves the user's entry alone.
    service::call(&e, "undo").unwrap();
    assert_eq!(read(&home.join(".cursor/mcp.json")), user);
    assert!(!home.join(".agents").exists());
}

#[test]
fn undo_leaves_files_the_user_changed_since() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("changed");
    let e = env(vec![spec("claude", true)], &home);
    service::call(&e, "apply").unwrap();
    let edited = home.join(".claude/skills/pm-status/SKILL.md");
    fs::write(&edited, format!("{}\nMy addition.\n", read(&edited))).unwrap();
    let u = service::call(&e, "undo").unwrap();
    assert_eq!(u["skipped"].as_array().unwrap().len(), 1, "{u}");
    assert!(read(&edited).contains("My addition."));
    assert!(!home.join(".claude/skills/pm-review/SKILL.md").exists(), "the untouched files are removed");
    // The config the apply created is removed too (it is exactly what apply wrote).
    assert!(!home.join(".claude.json").exists());
}

#[test]
fn undo_says_so_when_the_user_broke_the_config_since_and_keeps_the_record() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("broken");
    seed(&home, ".codex/config.toml", "model = \"gpt-6\"\n");
    let e = env(vec![spec("codex", true)], &home);
    service::call(&e, "apply").unwrap();
    let cfg = home.join(".codex/config.toml");
    fs::write(&cfg, format!("{}\n// not toml\n", read(&cfg))).unwrap();
    let u = service::call(&e, "undo").unwrap();
    let skipped = u["skipped"].as_array().unwrap();
    assert!(skipped.iter().any(|s| s["path"].as_str().unwrap().ends_with("config.toml")), "the broken config is reported, not forgotten: {u}");
    assert!(read(&cfg).contains("potato-workspace"), "nothing was guessed at in a file that cannot be parsed");
    assert!(u["recorded"].as_u64().unwrap() >= 1, "the record stays so Undo can be pressed again: {u}");
}

#[test]
fn agents_that_read_one_folder_share_one_write() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("shared");
    let agents = vec![spec("codex", true), spec("opencode", true), spec("opencode_native", true)];
    let e = env(agents, &home);
    let v = service::call(&e, "apply").unwrap();
    let rows = v["agents"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for r in rows {
        assert_eq!(r["skills"]["path"], rows[0]["skills"]["path"], "one skills folder");
        assert!(!r["skills"]["shared_with"].as_array().unwrap().is_empty());
    }
    // 4 skill files + the MCP entry of codex + the MCP entry of the OpenCode file (shared by two agents).
    assert_eq!(v["recorded"], 6);
    assert_eq!(rows[1]["mcp"]["path"], rows[2]["mcp"]["path"], "the two OpenCode profiles share a config file");
}

#[test]
fn an_agent_that_is_not_installed_is_skipped_and_nothing_is_created() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("absent");
    let e = env(vec![spec("claude", false)], &home);
    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["skills"]["status"], "skipped");
    assert_eq!(v["agents"][0]["mcp"]["status"], "skipped");
    assert!(tree(&home).is_empty(), "{:?}", tree(&home).keys().collect::<Vec<_>>());
}

#[test]
fn a_config_that_is_not_valid_is_left_untouched_and_the_skills_still_install() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("invalid");
    seed(&home, ".claude.json", "{ not json");
    let e = env(vec![spec("claude", true)], &home);
    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["status"], "error");
    assert!(v["agents"][0]["mcp"]["reason"].as_str().unwrap().contains("left untouched"));
    assert_eq!(read(&home.join(".claude.json")), "{ not json");
    assert_eq!(v["agents"][0]["skills"]["written"], true);
}

#[test]
fn a_folder_outside_home_is_refused() {
    let home = temp("outside");
    let mut s = spec("claude", true);
    s.skills = super::skills_host_from_toml("dir = \"~/../elsewhere/skills\"");
    s.mcp = None;
    let v = service::call(&env(vec![s], &home), "apply").unwrap();
    assert_eq!(v["agents"][0]["skills"]["status"], "error");
    assert!(v["agents"][0]["skills"]["reason"].as_str().unwrap().contains("HST-3"));
}

#[test]
fn an_older_copy_of_the_pack_is_updated_and_a_foreign_file_is_replaced() {
    let home = temp("kinds");
    let mut s = spec("claude", true);
    s.mcp = None;
    let old = format!("---\nname: pm-status\ndescription: old\n---\n<!-- {MARKER_PREFIX} 0 -->\nold text\n");
    seed(&home, ".claude/skills/pm-status/SKILL.md", &old);
    seed(&home, ".claude/skills/pm-review/SKILL.md", "my own review skill\n");
    let o = Options { home: home.clone(), state_dir: home.join("appdata"), launch: launch() };
    let r = plan::run(&[s], &o, false).unwrap();
    let files = &r.agents[0].skills.as_ref().unwrap().files;
    let kind = |n: &str| files.iter().find(|f| f.name == n).unwrap().kind;
    assert_eq!(kind("pm-status/SKILL.md"), FileKind::Update);
    assert_eq!(kind("pm-review/SKILL.md"), FileKind::Replace);
    assert_eq!(kind("potato-workspace/SKILL.md"), FileKind::Add);
}

// ---------------------------------------------------------------------------------------------
// The pack text
// ---------------------------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

fn lf(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())).replace("\r\n", "\n")
}

#[test]
fn pack_files_match_canonical() {
    let root = repo_root().join("integrations");
    for (name, text) in assets::files() {
        assert_eq!(lf(&root.join("skills").join(&name)), text, "embedded copy of {name}");
        for plugin in ["claude-code", "codex", "cursor"] {
            let copy = lf(&root.join(plugin).join("plugin/skills").join(&name));
            assert_eq!(copy, text, "{plugin} plugin copy of {name} drifted: run `node scripts/sync-skill-pack.mjs`");
        }
    }
    assert_eq!(lf(&root.join("cursor/rules/potato-workspace.mdc")), lf(&root.join("cursor/plugin/rules/potato-workspace.mdc")));
    assert_eq!(lf(&root.join("cursor/mcp.json")), lf(&root.join("cursor/plugin/mcp.json")));
}

/// The tools the pack teaches (the 5-tool path, receipts, worktrees, ask_user) and the parameters it names.
const TAUGHT: &[(&str, &[&str])] = &[
    ("quick_ask", &["task"]),
    ("run_agent", &["agent_type", "project_path", "task", "checks", "isolation", "read_only", "headless", "keep_pane", "idempotency_key", "worker_id"]),
    ("wait_agents", &["handles", "timeout_ms"]),
    ("followup_task", &["handle", "task"]),
    ("send_message", &["handle", "message"]),
    ("list_agents", &["active_only"]),
    ("review_worktree", &["handle", "action"]),
    ("ask_user", &["question", "choices"]),
    ("answer_prompt", &["handle", "prompt_id", "choice"]),
    ("interrupt_agent", &["handle"]),
];

/// Tools another lead is hiding from the list: the pack must not teach them.
const ALIASES: &[&str] = &["list_workers", "send_agent", "wait_for_model", "wait_for_task", "wait_for_worker", "cancel_agent"];


fn pack_texts() -> Vec<(String, String)> {
    let root = repo_root().join("integrations");
    let mut out: Vec<(String, String)> = assets::files();
    for rel in [
        "cursor/rules/potato-workspace.mdc",
        "codex/AGENTS.snippet.md",
        "opencode/agents/pm-delegator.md",
        "opencode/commands/pm-review.md",
        "opencode/commands/pm-delegate.md",
        "opencode/commands/pm-status.md",
    ] {
        out.push((rel.to_string(), lf(&root.join(rel))));
    }
    out
}

#[test]
fn the_pack_teaches_real_tools_and_real_parameters() {
    // What an agent sees by default: the curated core, with the aliases hidden.
    let catalog = crate::tool_registry::tools_for_mode(crate::tool_registry::McpMode::Agent);
    for (tool, params) in TAUGHT {
        let def = catalog.iter().find(|t| t.name == *tool).unwrap_or_else(|| panic!("{tool} is not in the default tool list"));
        let props = def.input_schema.get("properties").and_then(Value::as_object).unwrap();
        for p in *params {
            assert!(props.contains_key(*p), "{tool} has no parameter {p}");
        }
    }
    // Check kinds named in the text are the real enum.
    let run = catalog.iter().find(|t| t.name == "run_agent").unwrap();
    let kinds: Vec<&str> = run.input_schema["properties"]["checks"]["items"]["properties"]["type"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for k in ["command_exits", "file_exists", "file_contains", "file_absent", "result_contains"] {
        assert!(kinds.contains(&k), "{k}");
    }
    for (file, text) in pack_texts() {
        for alias in ALIASES.iter().copied().chain(crate::tool_registry::ALIASES.iter().map(|(a, _)| *a)) {
            assert!(!contains_word(&text, alias), "{file} teaches the hidden alias {alias}");
        }
        // Every `name(` in backticks is a real, visible tool.
        for token in text.split('`').skip(1).step_by(2) {
            if let Some(name) = token.split('(').next().filter(|_| token.contains('(')) {
                if name.chars().all(|c| c.is_ascii_lowercase() || c == '_') && !name.is_empty() {
                    assert!(catalog.iter().any(|t| t.name == name), "{file}: `{token}` names an unknown tool {name}");
                }
            }
        }
    }
    // The five-tool happy path is in the main skill.
    let main = assets::files().into_iter().find(|(n, _)| n == "potato-workspace/SKILL.md").unwrap().1;
    for tool in ["quick_ask", "run_agent", "wait_agents", "followup_task", "list_agents", "review_worktree", "ask_user"] {
        assert!(main.contains(tool), "the main skill teaches {tool}");
    }
}

fn contains_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + word.len()..].chars().next();
        let is_word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        !is_word(before) && !is_word(after)
    })
}

#[test]
fn skill_files_follow_the_skill_format() {
    for (rel, text) in assets::files() {
        let name = rel.split('/').next().unwrap();
        let rest = text.strip_prefix("---\n").unwrap_or_else(|| panic!("{rel}: frontmatter"));
        let (front, body) = rest.split_once("\n---\n").unwrap_or_else(|| panic!("{rel}: frontmatter end"));
        let field = |k: &str| front.lines().find_map(|l| l.strip_prefix(&format!("{k}: "))).map(str::to_string);
        assert_eq!(field("name").as_deref(), Some(name), "{rel}: name matches the folder");
        assert!(name.split('-').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())), "{rel}");
        let desc = field("description").unwrap_or_else(|| panic!("{rel}: description"));
        assert!(desc.len() <= 1024 && !desc.is_empty(), "{rel}: description length {}", desc.len());
        assert!(text.contains(MARKER_PREFIX), "{rel}: ownership marker");
        assert!(body.lines().count() < 100, "{rel}: keep skills short");
    }
}

#[test]
fn manifests_are_consistent() {
    let root = repo_root();
    let json = |rel: &str| -> Value { serde_json::from_str(&lf(&root.join(rel))).unwrap_or_else(|e| panic!("{rel}: {e}")) };

    let market = json(".claude-plugin/marketplace.json");
    let entry = &market["plugins"][0];
    let src = entry["source"].as_str().unwrap();
    assert!(src.starts_with("./") && !src.contains(".."));
    let manifest = json(&format!("{}/.claude-plugin/plugin.json", src.trim_start_matches("./")));
    assert_eq!(manifest["name"], entry["name"], "entry name and manifest name must match");
    let mcp = json(&format!("{}/.mcp.json", src.trim_start_matches("./")));
    assert_eq!(mcp["mcpServers"]["potato-workspace"]["command"], "npx");
    assert_eq!(mcp["mcpServers"]["potato-workspace"]["args"][1], "@potato-workspace/mcp");

    let codex = json(".agents/plugins/marketplace.json");
    let path = codex["plugins"][0]["source"]["path"].as_str().unwrap();
    assert!(path.starts_with("./") && root.join(path.trim_start_matches("./")).join(".codex-plugin/plugin.json").exists());

    // MCP Registry draft: the constraints of the published schema that matter for this file.
    let server = json("integrations/mcp-registry/server.json");
    let name = server["name"].as_str().unwrap();
    assert!(name.contains('/') && name.starts_with("io.github."), "{name}");
    assert!(server["description"].as_str().unwrap().len() <= 100);
    assert!(server["title"].as_str().unwrap().len() <= 100);
    let pkg = &server["packages"][0];
    assert_eq!(pkg["registryType"], "npm");
    assert_eq!(pkg["transport"]["type"], "stdio");
    let pkg_json: Value = serde_json::from_str(&lf(&root.join("packages/mcp-server/package.json"))).unwrap();
    assert_eq!(pkg["identifier"], pkg_json["name"], "server.json names the npm package the repo publishes");
    assert_eq!(server["version"], pkg_json["version"], "keep server.json in step with the package version");
    assert_eq!(pkg["version"], pkg_json["version"]);

    let oc = json("integrations/opencode/opencode.json");
    assert_eq!(oc["mcp"]["potato-workspace"]["type"], "local");
    assert!(oc["mcp"]["potato-workspace"]["command"].is_array());
    let cursor = json("integrations/cursor/mcp.json");
    assert_eq!(cursor["mcpServers"]["potato-workspace"]["command"], "npx");
    let toml: toml::Table = lf(&root.join("integrations/codex/config.toml")).parse().unwrap();
    assert_eq!(toml["mcp_servers"]["potato-workspace"]["command"].as_str(), Some("npx"));
    assert!(toml["mcp_servers"]["potato-workspace"]["tool_timeout_sec"].as_integer().unwrap() > 300, "run_agent may wait 300 s");
}

#[test]
fn the_record_survives_a_restart() {
    let home = temp("record");
    let e = env(vec![spec("claude", true)], &home);
    service::call(&e, "apply").unwrap();
    // A new Env (as after an app restart) can still undo.
    let e2 = env(vec![spec("claude", true)], &home);
    let u = service::call(&e2, "undo").unwrap();
    assert_eq!(u["removed"].as_array().unwrap().len(), 5, "four skills and the created config");
    assert!(tree(&home).is_empty());
}

mod declarative_agents {
    use super::*;
    use crate::tui::declarative::{parse_definition, validate, DeclarativeProfile, Source, ValidationContext};
    use crate::tui::TuiProfile;

    const DEF: &str = r##"schema_version = 1
[agent]
id = "fakehost"
label = "Fake Host"
[binary]
names = ["fakehost"]
[features]
dispatchable = false
not_dispatchable_reason = "test"
[mcp_host]
config_path = "~/.fakehost/mcp.json"
format = "json"
key_path = "mcpServers.potato-workspace"
[mcp_host.entry]
command = "{command}"
args = "{args}"
env = "{env}"
[skills_host]
dir = "~/.fakehost/skills"
"##;

    fn errors(text: &str) -> Vec<String> {
        let def = parse_definition(text).expect("parse");
        let ctx = ValidationContext { source: Source::User, code_ids: &["claude"], raw_len: text.len() };
        validate(&def, &ctx).into_iter().map(|e| e.path).collect()
    }

    #[test]
    fn skills_host_parses_validates_and_reaches_the_profile() {
        assert!(errors(DEF).iter().all(|p| !p.starts_with("skills_host")));
        let def = parse_definition(DEF).unwrap();
        assert_eq!(def.skills_host.as_ref().unwrap().dir, "~/.fakehost/skills");
        let profile = DeclarativeProfile::new(def).unwrap();
        assert_eq!(profile.skills_host().unwrap().dir, "~/.fakehost/skills");
        assert!(errors(&DEF.replace("~/.fakehost/skills", "~/../x")).contains(&"skills_host.dir".to_string()));
        assert!(errors(&DEF.replace("~/.fakehost/skills", "/etc/skills")).contains(&"skills_host.dir".to_string()));
        assert!(parse_definition(&DEF.replace("dir = ", "folder = ")).is_err());
    }

    #[test]
    fn a_declarative_agent_with_both_hosts_is_in_the_plan_and_the_unsupported_one_says_why() {
        let profile = DeclarativeProfile::new(parse_definition(DEF).unwrap()).unwrap();
        let home = temp("decl");
        let both = AgentSpec { id: "fakehost".into(), label: "Fake Host".into(), installed: true, mcp: profile.mcp_host(), skills: profile.skills_host() };
        let bare = AgentSpec { id: "bare".into(), label: "Bare Agent".into(), installed: true, mcp: None, skills: None };
        let v = service::call(&env(vec![both, bare], &home), "apply").unwrap();
        assert_eq!(v["agents"][0]["id"], "fakehost");
        assert_eq!(v["agents"][0]["skills"]["written"], true);
        assert_eq!(v["agents"][0]["mcp"]["written"], true);
        assert!(home.join(".fakehost/skills/potato-workspace/SKILL.md").is_file());
        let cfg = read(&home.join(".fakehost/mcp.json"));
        assert!(cfg.contains("potato-workspace"), "{cfg}");
        assert_eq!(v["unsupported"][0]["id"], "bare");
        assert_eq!(v["unsupported"][0]["label"], "Bare Agent");
        assert!(!v["unsupported"][0]["reason"].as_str().unwrap().is_empty());
    }

    #[test]
    fn store_definitions_may_not_carry_either_host() {
        let only_skills = parse_definition(&format!("{}[skills_host]\ndir = \"~/.x/skills\"\n", DEF.split("[mcp_host]").next().unwrap())).unwrap();
        assert!(crate::agent_store::check::forbidden_in_store(&only_skills).is_some_and(|r| r.contains("skills_host")));
        let both = parse_definition(DEF).unwrap();
        assert!(crate::agent_store::check::forbidden_in_store(&both).is_some_and(|r| r.contains("mcp_host")));
    }

    const CATALOG: &str = "catalog/agents";

    fn catalog_text(id: &str) -> Option<String> {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(CATALOG).join(id).join("definition.toml")).ok()
    }

    #[test]
    fn the_trusted_overlay_parses_and_every_entry_validates() {
        use crate::tui::declarative::hosts_overlay;
        let text = include_str!("../tui/declarative/agent-hosts.toml");
        assert_eq!(hosts_overlay::problems(text), Vec::<String>::new());
        let ids = hosts_overlay::ids();
        assert!(ids.len() >= 8, "{ids:?}");
        // Every overlay id is a catalog agent (the overlay is for agents that have a definition).
        for id in &ids {
            assert!(catalog_text(id).is_some(), "overlay id {id} has no catalog definition");
        }
        // A bad entry is reported, not accepted.
        let bad = text.replace("~/.gemini/skills", "~/../skills");
        assert!(!hosts_overlay::problems(&bad).is_empty());
        let bad = format!("{text}
[nobody.mcp_host]
config_path = \"~/x.json\"
format = \"json\"
key_path = \"a b\"
[nobody.mcp_host.entry]
command = \"{{nope}}\"
");
        assert!(!hosts_overlay::problems(&bad).is_empty());
    }

    #[test]
    fn a_store_like_agent_without_hosts_gets_them_from_the_overlay_and_is_planned() {
        use crate::tui::declarative::hosts_overlay;
        let home = temp("overlay");
        let mut specs = Vec::new();
        for id in hosts_overlay::ids() {
            let def = parse_definition(&catalog_text(&id).unwrap()).unwrap();
            assert!(def.mcp_host.is_none() && def.skills_host.is_none(), "{id}: the catalog stays host-free");
            assert!(crate::agent_store::check::forbidden_in_store(&def).is_none());
            let p = DeclarativeProfile::new(def).unwrap();
            specs.push(AgentSpec { id: id.clone(), label: id.clone(), installed: true, mcp: p.mcp_host(), skills: p.skills_host() });
        }
        let v = service::call(&env(specs, &home), "apply").unwrap();
        let rows = v["agents"].as_array().unwrap();
        let un: Vec<_> = v["unsupported"].as_array().unwrap().iter().map(|u| u["id"].as_str().unwrap().to_string()).collect();
        assert!(un.is_empty(), "{un:?}");
        assert_eq!(rows.len(), hosts_overlay::ids().len());
        let cfg: Value = serde_json::from_str(&read(&home.join(".copilot/mcp-config.json"))).unwrap();
        let entry = &cfg["mcpServers"]["potato-workspace"];
        assert_eq!(entry["type"], "local");
        assert_eq!(entry["tools"][0], "*");
        assert!(entry["command"].is_string() && entry["args"].is_array());
        assert!(home.join(".gemini/skills/potato-workspace/SKILL.md").is_file());
        assert!(home.join(".vibe/skills/potato-workspace/SKILL.md").is_file());
        assert!(!home.join(".vibe/mcp.json").exists());
        assert!(read(&home.join(".kiro/settings/mcp.json")).contains("potato-workspace"));
    }

    #[test]
    fn a_definitions_own_hosts_win_over_the_overlay_and_store_still_refuses_hosts() {
        // Same id as an overlay agent, but the definition declares its own hosts.
        let text = DEF.replace("id = \"fakehost\"", "id = \"gemini\"");
        let p = DeclarativeProfile::new(parse_definition(&text).unwrap()).unwrap();
        assert_eq!(p.skills_host().unwrap().dir, "~/.fakehost/skills");
        assert_eq!(p.mcp_host().unwrap().config_path, "~/.fakehost/mcp.json");
        // A host-less definition for an id the overlay does not know gets nothing.
        let none = DEF.split("[mcp_host]").next().unwrap().replace("id = \"fakehost\"", "id = \"unlisted\"");
        let p = DeclarativeProfile::new(parse_definition(&none).unwrap()).unwrap();
        assert!(p.mcp_host().is_none() && p.skills_host().is_none());
        // The store check still refuses a definition that carries hosts, whatever the overlay holds.
        let carrying = parse_definition(&text).unwrap();
        assert!(crate::agent_store::check::forbidden_in_store(&carrying).is_some());
    }
}

// ---- the broken npm-package entry written by 1.0.6 ----

fn bundled_launch() -> HostLaunch {
    HostLaunch {
        command: "C:/Program Files/Potato Workspace/resources/bin/puppet-master-mcp.exe".into(),
        args: vec![],
        env: vec![("POTATO_WORKSPACE_BRIDGE_PORT_FILE".into(), "C:/pm/potato-workspace.bridge.port".into())],
        ..Default::default()
    }
}

fn missing_launch() -> HostLaunch {
    HostLaunch { program_missing: true, ..launch() }
}

const BROKEN_CODEX: &str = "model = \"gpt-5\"\n\n[mcp_servers.potato-workspace]\ncommand = \"npx\"\nargs = [\"-y\", \"@potato-workspace/mcp\"]\n\n[mcp_servers.potato-workspace.env]\nPOTATO_WORKSPACE_BRIDGE_PORT_FILE = \"C:/pm/potato-workspace.bridge.port\"\n";

fn env_with(agents: Vec<AgentSpec>, home: &Path, launch: HostLaunch) -> Env {
    Env::new(agents, home.to_path_buf(), home.join("appdata"), launch)
}

#[test]
fn the_unpublished_npm_entry_is_repaired_with_a_backup_and_undo() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("repair");
    seed(&home, ".codex/config.toml", BROKEN_CODEX);
    let e = env_with(vec![spec("codex", true)], &home, bundled_launch());

    let v = service::call(&e, "preview").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["status"], "ready");
    assert_eq!(v["agents"][0]["mcp"]["change"], "update");
    assert_eq!(read(&home.join(".codex/config.toml")), BROKEN_CODEX, "preview writes nothing");

    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["written"], true);
    let fixed = read(&home.join(".codex/config.toml"));
    assert!(fixed.contains("puppet-master-mcp.exe"), "{fixed}");
    assert!(!fixed.contains("@potato-workspace/mcp"), "{fixed}");
    assert!(fixed.contains("model = \"gpt-5\""), "the rest of the file stays");
    let backup = v["agents"][0]["mcp"]["backup"].as_str().unwrap();
    assert_eq!(fs::read_to_string(backup).unwrap().replace("\r\n", "\n"), BROKEN_CODEX);

    // A second run has nothing left to fix.
    let again = service::call(&e, "apply").unwrap();
    assert_eq!(again["agents"][0]["mcp"]["status"], "unchanged");

    let u = service::call(&e, "undo").unwrap();
    assert!(u["skipped"].as_array().unwrap().is_empty(), "{u}");
    assert_eq!(read(&home.join(".codex/config.toml")), BROKEN_CODEX, "Undo puts the old file back");
}

#[test]
fn only_the_exact_fallback_shape_counts_as_broken() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("not-broken");
    // A different package version, an extra argument, a user's own program: all untouched.
    let variants = [
        "{\n  \"mcpServers\": {\n    \"potato-workspace\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@potato-workspace/mcp@1.2.3\"]\n    }\n  }\n}\n",
        "{\n  \"mcpServers\": {\n    \"potato-workspace\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@potato-workspace/mcp\", \"--verbose\"]\n    }\n  }\n}\n",
        "{\n  \"mcpServers\": {\n    \"potato-workspace\": {\n      \"command\": \"C:/mine/pm-mcp.exe\"\n    }\n  }\n}\n",
    ];
    for user in variants {
        seed(&home, ".cursor/mcp.json", user);
        let e = env_with(vec![spec("cursor_agent", true)], &home, bundled_launch());
        let v = service::call(&e, "apply").unwrap();
        assert_eq!(v["agents"][0]["mcp"]["status"], "unchanged", "{user}");
        assert_eq!(read(&home.join(".cursor/mcp.json")), user);
    }
}

#[test]
fn the_exact_fallback_in_json_is_repaired_too() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("repair-json");
    seed(&home, ".cursor/mcp.json", "{\n  \"mcpServers\": {\n    \"potato-workspace\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@potato-workspace/mcp\"],\n      \"env\": {\"POTATO_WORKSPACE_BRIDGE_PORT_FILE\": \"C:/pm/potato-workspace.bridge.port\"}\n    },\n    \"other\": { \"command\": \"x\" }\n  }\n}\n");
    let e = env_with(vec![spec("cursor_agent", true)], &home, bundled_launch());
    service::call(&e, "apply").unwrap();
    let doc: Value = serde_json::from_str(&read(&home.join(".cursor/mcp.json"))).unwrap();
    assert_eq!(doc["mcpServers"]["potato-workspace"]["command"], bundled_launch().command);
    assert_eq!(doc["mcpServers"]["other"]["command"], "x");
}

#[test]
fn with_no_bundled_program_nothing_is_written_and_the_agent_says_why() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("missing");
    seed(&home, ".cursor/mcp.json", "{\n  \"theme\": \"dark\"\n}\n");
    seed(&home, ".codex/config.toml", BROKEN_CODEX);
    let e = env_with(vec![spec("cursor_agent", true), spec("codex", true)], &home, missing_launch());
    let before = read(&home.join(".cursor/mcp.json"));
    let v = service::call(&e, "apply").unwrap();
    for row in v["agents"].as_array().unwrap() {
        assert_eq!(row["mcp"]["status"], "skipped", "{row}");
        assert_eq!(row["mcp"]["reason"], plan::MISSING_PROGRAM);
        assert_eq!(row["mcp"]["written"], false);
    }
    assert_eq!(read(&home.join(".cursor/mcp.json")), before);
    assert_eq!(read(&home.join(".codex/config.toml")), BROKEN_CODEX, "a broken entry is not swapped for another broken one");
    assert!(!fs::read_to_string(home.join(".cursor/mcp.json")).unwrap().contains("npx"));
    // The skills still install.
    assert_eq!(v["agents"][0]["skills"]["written"], true);
}

#[test]
fn a_user_entry_stays_untouched_even_when_the_program_is_missing() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("missing-user");
    let user = "{\n  \"mcpServers\": {\n    \"potato-workspace\": {\n      \"command\": \"C:/mine/pm-mcp.exe\"\n    }\n  }\n}\n";
    seed(&home, ".cursor/mcp.json", user);
    let e = env_with(vec![spec("cursor_agent", true)], &home, missing_launch());
    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["status"], "unchanged");
    assert_eq!(read(&home.join(".cursor/mcp.json")), user);
}

// ---- the approval setting under `--ask-for-approval never` ----

const CODEX_WITHOUT_APPROVAL: &str = "model = \"gpt-5\"\n\n[mcp_servers.potato-workspace]\ncommand = \"C:/Program Files/Potato Workspace/resources/bin/puppet-master-mcp.exe\"\nargs = []\n\n[mcp_servers.potato-workspace.env]\nPOTATO_WORKSPACE_BRIDGE_PORT_FILE = \"C:/pm/potato-workspace.bridge.port\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";

#[test]
fn a_new_codex_entry_pre_approves_only_our_server() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("approve-new");
    let e = env_with(vec![spec("codex", true)], &home, bundled_launch());
    service::call(&e, "apply").unwrap();
    let doc: toml::Value = toml::from_str(&read(&home.join(".codex/config.toml"))).unwrap();
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["default_tools_approval_mode"].as_str(), Some("approve"));
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["command"].as_str(), Some(bundled_launch().command.as_str()));
}

#[test]
fn the_other_servers_a_host_takes_are_never_pre_approved() {
    let _serial = crate::tui::registry::test_serial();
    let table = spec("codex", true).mcp.unwrap();
    assert!(!table.entry.contains_key("default_tools_approval_mode"), "the shared template carries no approval");
    assert_eq!(table.own_entry_extra.get("default_tools_approval_mode").and_then(|v| v.as_str()), Some("approve"));
}

#[test]
fn an_entry_without_the_approval_gets_just_that_key_and_undo_puts_the_file_back() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("approve-repair");
    seed(&home, ".codex/config.toml", CODEX_WITHOUT_APPROVAL);
    let e = env_with(vec![spec("codex", true)], &home, bundled_launch());

    let v = service::call(&e, "preview").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["status"], "ready");
    assert_eq!(v["agents"][0]["mcp"]["change"], "update");
    let diff = v["agents"][0]["mcp"]["diff"].as_str().unwrap();
    assert!(diff.contains("default_tools_approval_mode"), "{diff}");
    assert!(!diff.contains("command"), "only the one key is shown: {diff}");
    assert_eq!(read(&home.join(".codex/config.toml")), CODEX_WITHOUT_APPROVAL, "preview writes nothing");

    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["written"], true);
    let doc: toml::Value = toml::from_str(&read(&home.join(".codex/config.toml"))).unwrap();
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["default_tools_approval_mode"].as_str(), Some("approve"));
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["command"], toml::from_str::<toml::Value>(CODEX_WITHOUT_APPROVAL).unwrap()["mcp_servers"]["potato-workspace"]["command"]);
    assert!(doc["mcp_servers"]["other"].get("default_tools_approval_mode").is_none(), "another server is not approved");
    assert_eq!(doc["model"].as_str(), Some("gpt-5"));

    let again = service::call(&e, "apply").unwrap();
    assert_eq!(again["agents"][0]["mcp"]["status"], "unchanged");

    let u = service::call(&e, "undo").unwrap();
    assert!(u["skipped"].as_array().unwrap().is_empty(), "{u}");
    assert_eq!(read(&home.join(".codex/config.toml")), CODEX_WITHOUT_APPROVAL);
}

#[test]
fn the_unpublished_npm_entry_gets_the_approval_with_the_repair() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("approve-broken");
    seed(&home, ".codex/config.toml", BROKEN_CODEX);
    let e = env_with(vec![spec("codex", true)], &home, bundled_launch());
    service::call(&e, "apply").unwrap();
    let doc: toml::Value = toml::from_str(&read(&home.join(".codex/config.toml"))).unwrap();
    assert_eq!(doc["mcp_servers"]["potato-workspace"]["default_tools_approval_mode"].as_str(), Some("approve"));
    assert!(doc["mcp_servers"]["potato-workspace"]["command"].as_str().unwrap().contains("puppet-master-mcp.exe"));
}

#[test]
fn an_entry_that_already_has_the_approval_is_left_as_it_is() {
    let _serial = crate::tui::registry::test_serial();
    let home = temp("approve-has");
    let mine = CODEX_WITHOUT_APPROVAL.replace("args = []\n", "args = []\ndefault_tools_approval_mode = \"prompt\"\n");
    seed(&home, ".codex/config.toml", &mine);
    let e = env_with(vec![spec("codex", true)], &home, bundled_launch());
    let v = service::call(&e, "apply").unwrap();
    assert_eq!(v["agents"][0]["mcp"]["status"], "unchanged");
    assert_eq!(read(&home.join(".codex/config.toml")), mine, "the person's own choice stands");
}
