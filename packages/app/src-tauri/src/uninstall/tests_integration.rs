//! The whole run on a fake PC: order, what is removed, what must stay, and the hand-off.

use std::cell::RefCell;

use super::helper::HelperArgs;
use super::host::FakeHost;
use super::plan::Scan;
use super::run::{run, Launcher, Outcome};
use super::tests::*;
use super::{gid, Plan, Progress, Selection};

#[derive(Default)]
struct FakeLauncher {
    started: RefCell<Vec<HelperArgs>>,
    fail: bool,
}

impl Launcher for FakeLauncher {
    fn start_helper(&self, args: &HelperArgs) -> Result<(), String> {
        if self.fail {
            return Err("could not copy the app".into());
        }
        self.started.borrow_mut().push(args.clone());
        Ok(())
    }
}

fn go(w: &World, host: &FakeHost, launcher: &FakeLauncher, sel: impl FnOnce(&Plan) -> Selection) -> (Outcome, Vec<Progress>, Plan) {
    let plan = Scan::new(&w.roots, host).plan(&w.roots, host);
    let selection = sel(&plan);
    let mut events = Vec::new();
    let outcome = run(&w.roots, host, launcher, &plan, &selection, 4242, &mut |p| events.push(p));
    (outcome, events, plan)
}

fn defaults(plan: &Plan) -> Selection {
    Selection::defaults(plan)
}

#[test]
fn a_default_run_removes_ours_keeps_the_rest_and_hands_off() {
    let w = world("run-default");
    let mut h = host();
    with_copies(&w, &mut h);
    let l = FakeLauncher::default();
    let (out, events, plan) = go(&w, &h, &l, defaults);

    assert!(out.aborted.is_none(), "{:?}", out.aborted);
    assert!(out.failures.is_empty(), "{:?}", out.failures);
    assert!(out.handed_off);

    // Our entries are gone from every tool, the user's own servers are not.
    for file in [".claude.json", ".codex/config.toml", ".cursor/mcp.json", ".config/opencode/opencode.json"] {
        let text = read(&w.roots.home.join(file));
        assert!(!text.contains("potato-workspace") && !text.contains("pm-toolbelt"), "{file}");
    }
    assert!(read(&w.roots.home.join(".claude.json")).contains("their-server"));
    assert!(read(&w.shop.join(".mcp.json")).contains("their-server"));
    assert!(!read(&w.shop.join(".mcp.json")).contains("potato-workspace"));
    assert!(!w.roots.home.join(".claude").join("skills").join("pm-review").exists());
    assert!(w.roots.home.join(".claude").join("skills").join("pm-status").join("SKILL.md").exists());
    assert_eq!(out.removed_connections as u64, plan.connections, "what was shown is what was removed");
    // The backup exists with the original bytes.
    let backup = out.backup_dir.clone().expect("backup folder");
    assert!(backup.starts_with(&w.roots.temp), "no Keep my chats: the backup goes to the temp folder");
    assert!(std::fs::read_dir(&backup).unwrap().filter_map(Result::ok).any(|e| read(&e.path()) == CLAUDE_JSON));

    // Project: runtime data and chats gone; shared notes (memory.md, agents) stay, so the git lines stay too.
    let data = w.shop.join(".potato-workspace");
    assert!(!data.join("events.jsonl").exists() && !data.join("messages").exists() && !data.join("turn-summaries.json").exists());
    assert!(data.join("memory.md").exists() && data.join("agents").join("helper.toml").exists());
    assert!(read(&w.shop.join(".git").join("info").join("exclude")).contains("Potato Workspace runtime data"));
    // Companions and sign-ins made here are gone; a folder the person picked is kept.
    assert!(!w.roots.home.join("PotatoWorkspace").exists());
    assert!(!w.roots.appdata.join(ID).join("accounts").join("acc_1").exists());
    assert!(w.roots.home.join(".codex-real").join("auth.json").exists());
    // Temp leftovers of ours go; other files in temp stay.
    assert!(!w.roots.temp.join("potato-workspace-doctor").exists());
    assert!(w.roots.temp.join("someone-elses.txt").exists());
    // Never touched: the other product, legacy folders, look-alike names.
    for keep in [
        w.roots.appdata.join("com.puppetmaster.app").join("keep.txt"),
        w.roots.appdata.join("com.potatodev.workspacex").join("keep.txt"),
        w.roots.home.join("PuppetMaster").join("keep.txt"),
        w.roots.home.join(LEGACY_HIDDEN).join("keep.txt"),
    ] {
        assert!(keep.exists(), "{} must stay", keep.display());
    }
    // The app data itself is the helper's job (the app is still running).
    assert!(w.roots.appdata.join(ID).join("settings.json").exists());

    // Host calls: autostart off; only OUR credentials; only the safe copy discarded.
    let calls = h.calls();
    assert!(calls.contains(&"autostart_off".to_string()));
    assert!(calls.contains(&"delete_credential anthropic_api_key.com.potatodev.workspace".to_string()));
    assert!(!calls.iter().any(|c| c.contains("puppetmaster")));
    assert!(calls.contains(&"discard pm/fix-cart".to_string()));
    assert!(!calls.contains(&"discard pm/new-checkout".to_string()), "a branch with unsaved work is kept unless ticked");
    assert!(calls.iter().any(|c| c.starts_with("sweep ")));
    assert!(!calls.iter().any(|c| c.starts_with("store_uninstall")), "D6: Store programs stay by default");
    assert!(calls.iter().position(|c| c == "stop_own_processes") < calls.iter().position(|c| c == "autostart_off"));
    assert_eq!(h.credentials.borrow().as_slice(), ["tok.com.puppetmaster.app"]);

    // Progress: every step ran in order, ending with the hand-off.
    let running: Vec<&str> = events.iter().filter(|e| e.state == "running").map(|e| e.step.as_str()).collect();
    assert_eq!(running, ["stop", "backup", "connections", "projects", "autostart", "keys", "store", "sign_ins", "report", "handoff"]);
    assert!(events.iter().all(|e| e.state != "failed"), "{events:?}");
    assert!(events.iter().filter(|e| e.step == "store").any(|e| e.state == "skipped"));

    // The report lists what is left; the helper got the right job.
    let report = read(out.report_path.as_ref().unwrap());
    assert!(report.contains("Cloudflare") && report.contains(".codex-real") && report.contains("Shared project notes"));
    let started = l.started.borrow();
    assert_eq!(started.len(), 1);
    let args = &started[0];
    assert_eq!(args.app_pid, 4242);
    assert_eq!(args.ids, vec![ID.to_string(), format!("{ID}.profile-work")]);
    assert!(args.remove_data && !args.remove_program, "no install dir in this fake PC");
    assert!(args.keep.is_empty());
}

#[test]
fn keep_my_chats_zips_them_first_then_deletes() {
    let w = world("run-keep");
    let h = host();
    let l = FakeLauncher::default();
    let (out, events, _) = go(&w, &h, &l, |p| Selection { keep_chats: true, ..Selection::defaults(p) });
    assert!(out.aborted.is_none(), "{:?}", out.aborted);
    assert_eq!(events.first().map(|e| e.step.as_str()), Some("chats_zip"));
    let zip = out.zip_path.clone().expect("zip written");
    assert!(zip.starts_with(&w.roots.documents));
    let name = zip.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("Potato Workspace chats ") && name.ends_with(".zip"), "{name}");
    let entries = crate::flight::zip::read_back(&std::fs::read(&zip).unwrap()).unwrap();
    let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.iter().any(|n| n.ends_with("journals/j1.jsonl")), "{names:?}");
    assert!(names.iter().any(|n| n.ends_with("chat-index.sqlite")));
    assert!(names.iter().any(|n| n.starts_with("companions/") && n.ends_with("memory.md")));
    assert!(names.iter().any(|n| n.contains("shop") && n.ends_with("messages/m1.json")));
    assert_eq!(entries.iter().find(|(n, _)| n.ends_with("chat-index.sqlite")).unwrap().1, b"sqlite-bytes");
    // The chats are gone from disk afterwards (zipped before), the report sits beside the zip, backups in Documents.
    assert!(!w.shop.join(".potato-workspace").join("messages").exists());
    assert!(out.report_path.as_ref().unwrap().starts_with(&w.roots.documents));
    assert!(out.backup_dir.as_ref().unwrap().starts_with(&w.roots.documents));
}

#[test]
fn a_zip_that_cannot_be_written_stops_everything_before_any_delete() {
    let w = world("run-zipfail");
    // Documents is a file, so the zip folder cannot be made.
    std::fs::remove_dir_all(&w.roots.documents).unwrap();
    write(&w.roots.documents, "I am a file");
    let h = host();
    let l = FakeLauncher::default();
    let (out, events, _) = go(&w, &h, &l, |p| Selection { keep_chats: true, ..Selection::defaults(p) });
    assert!(out.aborted.as_deref().unwrap_or("").starts_with("Nothing was removed"), "{:?}", out.aborted);
    assert!(!out.handed_off && l.started.borrow().is_empty());
    assert_eq!(read(&w.roots.home.join(".claude.json")), CLAUDE_JSON, "nothing was touched");
    assert!(w.shop.join(".potato-workspace").join("events.jsonl").exists());
    assert!(h.calls().is_empty(), "no processes stopped, no keys deleted: {:?}", h.calls());
    assert_eq!(events.last().map(|e| e.state.as_str()), Some("failed"));
}

#[test]
fn unticking_chats_and_sign_ins_keeps_them_and_tells_the_helper() {
    let w = world("run-untick");
    let h = host();
    let l = FakeLauncher::default();
    let (out, _, _) = go(&w, &h, &l, |p| {
        let mut s = Selection::defaults(p);
        s.groups.retain(|g| g != gid::CHATS && g != gid::SIGN_INS);
        s
    });
    assert!(out.aborted.is_none());
    assert!(w.shop.join(".potato-workspace").join("messages").join("m1.json").exists());
    assert!(w.roots.home.join("PotatoWorkspace").join("companions").exists());
    assert!(w.roots.appdata.join(ID).join("accounts").join("acc_1").join("login.json").exists());
    let keep: Vec<String> = l.started.borrow()[0].keep.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();
    assert!(keep.iter().any(|k| k.ends_with("acp/journals")), "{keep:?}");
    assert!(keep.iter().any(|k| k.ends_with("chat-index.sqlite")));
    assert!(keep.iter().any(|k| k.ends_with("/accounts")));
}

#[test]
fn ticking_the_unticked_groups_removes_them_too() {
    let w = world("run-tickall");
    let mut h = host();
    with_copies(&w, &mut h);
    // Pretend the Store installed a program.
    write(&w.roots.appdata.join(ID).join("agent-store.json"), "{\"v\":1,\"agents\":{\"aider\":{\"install\":{\"method\":\"uv\",\"package\":\"aider-chat\",\"version\":\"0.86.1\",\"date\":\"2026-11-01\"}}}}");
    let l = FakeLauncher::default();
    let (out, _, plan) = go(&w, &h, &l, |p| Selection { groups: p.groups.iter().map(|g| g.id.clone()).collect(), keep_chats: false });
    assert!(plan.groups.iter().any(|g| g.id == gid::STORE_PROGRAMS), "the Store program is listed (unticked) in the plan");
    assert!(out.failures.is_empty(), "{:?}", out.failures);
    let calls = h.calls();
    assert!(calls.contains(&"discard pm/new-checkout".to_string()));
    assert!(calls.contains(&"store_uninstall aider".to_string()));
    let data = w.shop.join(".potato-workspace");
    assert!(!data.exists(), "with the shared notes ticked the whole folder goes");
    assert!(!read(&w.shop.join(".git").join("info").join("exclude")).contains("Potato Workspace"), "and so do our git lines");
    assert_eq!(read(&w.shop.join(".git").join("info").join("exclude")), "# mine\n*.log\ntarget/\n");
}

#[test]
fn a_helper_that_cannot_start_is_reported_and_the_app_does_not_exit() {
    let w = world("run-nohelper");
    let h = host();
    let l = FakeLauncher { fail: true, ..Default::default() };
    let (out, events, _) = go(&w, &h, &l, defaults);
    assert!(!out.handed_off);
    assert!(out.aborted.as_deref().unwrap_or("").contains("could not copy"));
    assert_eq!(events.last().map(|e| (e.step.as_str(), e.state.as_str())), Some(("handoff", "failed")));
}

#[test]
fn deleting_outside_our_folders_is_refused() {
    let w = world("run-guard");
    let allowed = vec![w.roots.appdata.join(ID)];
    let outside = w.roots.home.join("PuppetMaster").join("keep.txt");
    let err = super::run::remove_all(&outside, &allowed).unwrap_err();
    assert!(err.contains("not a place Potato Workspace owns"));
    assert!(outside.exists());
    // A sibling whose name only starts the same is outside too.
    assert!(super::run::remove_all(&w.roots.appdata.join("com.potatodev.workspacex"), &allowed).is_err());
    assert!(super::run::remove_all(&w.roots.appdata.join(ID).join("settings.json"), &allowed).is_ok());
}

#[test]
fn the_real_memory_remover_takes_only_our_block_out_of_the_project_notes() {
    let w = world("memory");
    let report = crate::one_brain::sync(&w.shop, &crate::one_brain::targets(), false);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let text = read(&w.shop.join("CLAUDE.md"));
    assert!(text.contains("My own notes."), "the person's own text stays: {text:?}");
    assert!(!text.contains("potato-workspace:memory") && !text.contains("remember this"));
}
