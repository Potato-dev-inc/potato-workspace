//! "Work on a copy": a chat started with the switch works only inside its copy. Keep brings the changes into the
//! project, Throw away leaves the project as it was. Real git, the fake agent, real temp folders.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use pm_core::test_support::chat_rig::{agents, conversations_in, deps_for};
use super::{copy, start::start, trial, AcpChat, StartDeps, StartRequest};
use crate::acp::conversations::Conversations;
use crate::test_support::wait::wait_until;

struct Rig {
    dir: PathBuf,
    project: PathBuf,
    store: PathBuf,
    conversations: Conversations,
    deps: StartDeps,
    started: parking_lot::Mutex<Vec<Arc<AcpChat>>>,
    _gate: crate::test_support::wait::Permit<'static>,
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

impl Rig {
    fn new(with_git: bool) -> Rig {
        let gate = crate::test_support::wait::process_permit();
        let dir = std::env::temp_dir().join(format!("pm-chat-copy-{}", uuid::Uuid::new_v4()));
        let project = dir.join("project");
        let store = dir.join("store");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(project.join("readme.txt"), "one\n").unwrap();
        std::fs::write(project.join("keep.txt"), "stay\n").unwrap();
        if with_git {
            git(&project, &["init", "-q"]);
            git(&project, &["config", "user.email", "t@example.com"]);
            git(&project, &["config", "user.name", "t"]);
            git(&project, &["config", "commit.gpgsign", "false"]);
            git(&project, &["add", "-A"]);
            git(&project, &["commit", "-q", "-m", "first"]);
        }
        let conversations = conversations_in(&dir, "");
        let deps = deps_for(&dir, &conversations);
        Rig { dir, project, store, conversations, deps, started: parking_lot::Mutex::new(Vec::new()), _gate: gate }
    }

    fn start(&self, separate_copy: bool) -> Result<Arc<AcpChat>, super::StartError> {
        let cfg = agents("", &self.dir).0["fake"].as_ref().clone();
        let chat = start(&self.deps, cfg, StartRequest { agent_id: "fake".into(), folder: self.project.clone(), explicit: true, separate_copy, copy_store: Some(self.store.clone()), ..Default::default() })?;
        self.started.lock().push(chat.clone());
        Ok(chat)
    }

    fn say(&self, chat: &AcpChat, text: &str) {
        chat.send(text).unwrap_or_else(|e| panic!("send {text:?}: {e:?}"));
        let turn = chat.session().snapshot().turn;
        assert!(wait_until(30, || chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["id"] == format!("end:{turn}"))), "the turn did not end");
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.project.join(rel)).ok()
    }

    fn folder_of(&self, chat: &AcpChat) -> PathBuf {
        PathBuf::from(self.conversations.record(chat.pane_id()).unwrap().cwd)
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for chat in self.started.lock().iter() {
            chat.retire();
        }
        let _ = Command::new("git").args(["worktree", "prune"]).current_dir(&self.project).output();
        // Read-only git objects block a plain delete on Windows.
        fn clear_readonly(dir: &Path) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        let mut perms = meta.permissions();
                        if perms.readonly() {
                            #[allow(clippy::permissions_set_readonly_false)]
                            perms.set_readonly(false);
                            let _ = std::fs::set_permissions(entry.path(), perms);
                        }
                        if meta.is_dir() {
                            clear_readonly(&entry.path());
                        }
                    }
                }
            }
        }
        clear_readonly(&self.dir);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_chat_started_without_the_switch_works_in_the_project_and_says_no_copy() {
    let rig = Rig::new(true);
    let chat = rig.start(false).expect("starts");
    assert_eq!(rig.conversations.record(chat.pane_id()).unwrap().cwd, rig.project.to_string_lossy());
    assert!(rig.conversations.copy_of(chat.pane_id()).is_none());
    assert!(chat.state().get("copy").is_none());
}

#[test]
fn a_git_chat_on_a_copy_writes_only_inside_the_copy_and_keep_merges_it() {
    let rig = Rig::new(true);
    let chat = rig.start(true).expect("starts on a copy");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).expect("the link is stored on the conversation");
    assert_eq!(link.kind, "git");
    assert_eq!(link.origin, rig.project.to_string_lossy());
    assert_eq!(chat.state()["copy"]["kind"], "git");
    let folder = rig.folder_of(&chat);
    assert!(folder.to_string_lossy().replace('\\', "/").contains("/.potato-workspace/worktrees/"), "{folder:?}");

    rig.say(&chat, "autowrite made-by-chat.txt");
    assert!(folder.join("made-by-chat.txt").is_file(), "written inside the copy");
    assert!(rig.read("made-by-chat.txt").is_none(), "the project is untouched while the chat works");
    assert_eq!(copy::summary(&link).unwrap()["files"], 1);

    let kept = copy::keep(&link, &id, &rig.deps.registry).expect("keep");
    assert_eq!(kept["kept"], true);
    assert_eq!(rig.read("made-by-chat.txt").as_deref(), Some("fake"), "the project has the change after Keep");
    assert!(!folder.exists(), "the copy is gone after Keep");
}

#[test]
fn throw_away_removes_the_copy_and_leaves_the_project_untouched() {
    let rig = Rig::new(true);
    let chat = rig.start(true).expect("starts on a copy");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).unwrap();
    let folder = rig.folder_of(&chat);
    rig.say(&chat, "autowrite scratch.txt");
    assert!(folder.join("scratch.txt").is_file());
    copy::throw_away(&link, &id, &rig.deps.registry).expect("throw away");
    assert!(!folder.exists(), "the copy is gone");
    assert!(rig.read("scratch.txt").is_none(), "nothing reached the project");
    assert_eq!(rig.read("readme.txt").as_deref(), Some("one\n"));
    assert!(copy::summary(&link).is_none(), "the copy is not listed any more");
}

#[test]
fn a_folder_without_git_gets_a_plain_trial_copy_that_keep_copies_back() {
    let rig = Rig::new(false);
    let chat = rig.start(true).expect("starts on a trial copy");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).unwrap();
    assert_eq!(link.kind, "plain");
    assert_eq!(chat.state()["copy"]["kind"], "plain");
    let folder = rig.folder_of(&chat);
    assert!(folder.starts_with(&rig.store), "the trial copy lives in the store, not in the project");
    assert_eq!(std::fs::read_to_string(folder.join("readme.txt")).unwrap(), "one\n");

    rig.say(&chat, "autowrite new-file.txt");
    std::fs::write(folder.join("readme.txt"), "two\n").unwrap();
    std::fs::remove_file(folder.join("keep.txt")).unwrap();
    assert!(rig.read("new-file.txt").is_none() && rig.read("readme.txt").as_deref() == Some("one\n"), "the project is untouched until Keep");
    assert_eq!(copy::summary(&link).unwrap()["files"], 3);

    let kept = copy::keep(&link, &id, &rig.deps.registry).expect("keep");
    assert_eq!(kept["files"], 3);
    assert_eq!(rig.read("new-file.txt").as_deref(), Some("fake"));
    assert_eq!(rig.read("readme.txt").as_deref(), Some("two\n"));
    assert!(rig.read("keep.txt").is_none(), "a file the chat deleted is deleted in the project");
    assert!(!trial::exists(&rig.store, &link.handle), "the copy is gone");
}

#[test]
fn a_plain_copy_thrown_away_leaves_the_project_as_it_was() {
    let rig = Rig::new(false);
    let chat = rig.start(true).expect("starts");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).unwrap();
    rig.say(&chat, "autowrite scratch.txt");
    copy::throw_away(&link, &id, &rig.deps.registry).expect("throw away");
    assert!(!trial::exists(&rig.store, &link.handle));
    assert!(rig.read("scratch.txt").is_none());
    assert_eq!(rig.read("readme.txt").as_deref(), Some("one\n"));
}

#[test]
fn keep_refuses_a_plain_copy_when_the_project_changed_the_same_file() {
    let rig = Rig::new(false);
    let chat = rig.start(true).expect("starts");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).unwrap();
    let folder = rig.folder_of(&chat);
    std::fs::write(folder.join("readme.txt"), "from the chat\n").unwrap();
    std::fs::write(rig.project.join("readme.txt"), "from the person\n").unwrap();
    let refused = copy::keep(&link, &id, &rig.deps.registry).expect_err("refused");
    assert!(refused.contains("readme.txt") && refused.contains("Nothing was kept"), "{refused}");
    assert_eq!(rig.read("readme.txt").as_deref(), Some("from the person\n"), "the file of the person is not overwritten");
    assert!(trial::exists(&rig.store, &link.handle), "the copy stays so nothing is lost");
}

#[test]
fn a_folder_that_is_too_big_for_a_trial_copy_is_refused_with_one_plain_sentence() {
    let rig = Rig::new(false);
    for i in 0..=trial::MAX_FILES {
        std::fs::write(rig.project.join(format!("f{i}.txt")), "x").unwrap();
    }
    let error = rig.start(true).err().expect("refused");
    assert_eq!(error.code, "ACP_COPY_FAILED");
    assert!(error.message.contains("too big") && !error.fallback, "{error}");
    let left = std::fs::read_dir(rig.store.join("trial-copies")).map(|d| d.count()).unwrap_or(0);
    assert_eq!(left, 0, "no half copy is left");
}

#[test]
fn closing_a_chat_removes_a_copy_it_never_changed_and_keeps_one_with_changes() {
    let rig = Rig::new(true);
    let untouched = rig.start(true).expect("starts");
    let untouched_id = untouched.pane_id().to_string();
    let untouched_folder = rig.folder_of(&untouched);
    let changed = rig.start(true).expect("starts");
    let changed_id = changed.pane_id().to_string();
    let changed_link = rig.conversations.copy_of(&changed_id).unwrap();
    let changed_folder = rig.folder_of(&changed);
    rig.say(&changed, "autowrite work.txt");

    super::on_pane_closed(&untouched_id);
    super::on_pane_closed(&changed_id);
    assert!(!untouched_folder.exists(), "the empty copy goes with its chat");
    assert!(rig.conversations.copy_of(&untouched_id).is_none());
    assert!(changed_folder.join("work.txt").is_file(), "a copy with changes stays for the person to decide");
    assert!(copy::summary(&changed_link).is_some());
}

#[test]
fn the_start_sweep_removes_copies_of_closed_chats_that_changed_nothing() {
    let rig = Rig::new(false);
    let chat = rig.start(true).expect("starts");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).unwrap();
    // The close hook did not get to the copy: the record is closed but still points at it.
    chat.retire();
    let _ = rig.conversations.close(&id);
    assert!(trial::exists(&rig.store, &link.handle));
    assert_eq!(copy::sweep_closed(&rig.conversations), 1);
    assert!(!trial::exists(&rig.store, &link.handle));
}

// ---- fences: "Keep" refuses a copy that changed a fenced file --------------------------------------------------

fn keep_refuses_fenced_changes(with_git: bool) {
    let rig = Rig::new(with_git);
    let project = rig.project.to_string_lossy().into_owned();
    crate::agent_rules::store().add_fence(&project, "fenced.txt").unwrap();
    let chat = rig.start(true).expect("starts on a copy");
    let id = chat.pane_id().to_string();
    let link = rig.conversations.copy_of(&id).unwrap();
    let folder = rig.folder_of(&chat);
    // The first message carries the fence rules in front of it, so the agent is told first and asked after.
    rig.say(&chat, "hello");
    rig.say(&chat, "autowrite fenced.txt");
    assert!(folder.join("fenced.txt").is_file());

    let refused = copy::keep(&link, &id, &rig.deps.registry).expect_err("a fenced file blocks Keep");
    assert!(refused.starts_with("FENCED:") && refused.contains("fenced.txt"), "{refused}");
    assert!(rig.read("fenced.txt").is_none(), "nothing moved into the project");
    assert!(folder.exists(), "the copy is still there");

    // Taking the fence off lets Keep through.
    crate::agent_rules::store().remove_fence(&project, "fenced.txt").unwrap();
    let kept = copy::keep(&link, &id, &rig.deps.registry).expect("keep after the fence is gone");
    assert_eq!(kept["kept"], true);
    assert_eq!(rig.read("fenced.txt").as_deref(), Some("fake"));
}

#[test]
fn keep_refuses_a_git_copy_that_changed_a_fenced_file() {
    keep_refuses_fenced_changes(true);
}

#[test]
fn keep_refuses_a_plain_copy_that_changed_a_fenced_file() {
    keep_refuses_fenced_changes(false);
}

#[test]
fn a_chat_on_a_copy_uses_the_fences_of_its_project() {
    let rig = Rig::new(true);
    let project = rig.project.to_string_lossy().into_owned();
    crate::agent_rules::store().add_fence(&project, "secrets").unwrap();
    let chat = rig.start(true).expect("starts on a copy");
    assert_eq!(chat.project(), project, "the project, not the copy's folder");
    assert_eq!(chat.fences(), ["secrets"]);
}
