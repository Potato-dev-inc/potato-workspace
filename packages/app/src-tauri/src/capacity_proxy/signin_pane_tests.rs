use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const CLAUDE: &str = include_str!("../../crates/pm-core/src/tui/claude/lend_proxy.toml");
const FAR: u64 = 9_999_999_999_999;

#[derive(Default)]
struct Fake {
    spawned: Mutex<Vec<SpawnPaneArgs>>,
    /// Whether the pane id was already hidden at the moment the spawn ran.
    hidden_at_spawn: Mutex<Vec<bool>>,
    killed: Mutex<Vec<String>>,
    fail: Mutex<bool>,
    dead: Mutex<bool>,
    count: AtomicUsize,
}

impl Ports for Fake {
    fn spawn(&self, args: SpawnPaneArgs) -> Result<String, String> {
        if *self.fail.lock().unwrap() {
            return Err("no such agent".into());
        }
        let id = args.pane_id.clone().unwrap();
        self.hidden_at_spawn.lock().unwrap().push(crate::pty::hidden::is_hidden(&id));
        self.spawned.lock().unwrap().push(args);
        self.count.fetch_add(1, Ordering::SeqCst);
        Ok(id)
    }
    fn kill(&self, pane_id: &str) {
        self.killed.lock().unwrap().push(pane_id.to_string());
        crate::pty::hidden::forget(pane_id);
    }
    fn alive(&self, pane_id: &str) -> bool {
        !*self.dead.lock().unwrap() && !self.killed.lock().unwrap().iter().any(|k| k == pane_id)
    }
}

fn store(name: &str) -> (Store, PathBuf) {
    let root = std::env::temp_dir().join(format!("pm-signinpane-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    (Store::at(&root), root)
}

fn spec() -> ProxySpec {
    ProxySpec::parse(CLAUDE).unwrap()
}

fn sign_in(acc: &Account) {
    std::fs::create_dir_all(&acc.home).unwrap();
    std::fs::write(PathBuf::from(&acc.home).join(".credentials.json"), format!(r#"{{"claudeAiOauth":{{"accessToken":"x","expiresAt":{FAR}}}}}"#)).unwrap();
    std::fs::write(PathBuf::from(&acc.home).join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"ren@example.com"}}"#).unwrap();
}

#[test]
fn start_hides_the_pane_before_it_is_spawned_and_runs_it_as_the_lend_account_in_the_given_folder() {
    let (store, root) = store("start");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let cwd = root.join("lend").join("signin");
    let id = panes.start(fake.clone(), &acc, cwd.clone()).unwrap();
    assert!(crate::pty::hidden::is_hidden(&id), "no pane list may show it");
    assert_eq!(*fake.hidden_at_spawn.lock().unwrap(), vec![true], "hidden BEFORE the spawn");
    let args = fake.spawned.lock().unwrap()[0].clone();
    assert_eq!((args.agent_type.as_str(), args.account.as_deref(), args.pane_id.as_deref()), ("claude", Some(acc.id.as_str()), Some(id.as_str())));
    assert_eq!(args.cwd.as_deref(), Some(cwd.to_string_lossy().as_ref()));
    assert!(cwd.is_dir(), "the app-owned folder was made");
    assert_eq!(panes.pane_of(&acc.id).as_deref(), Some(id.as_str()));
    // A hidden pane is left out of the registry's own list (the filter every pane list goes through).
    let reg = crate::pty::PaneRegistry::new();
    assert!(reg.list().iter().all(|p| p.id != id));
    panes.stop(&acc.id);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn this_file_never_presents_a_pane() {
    // The regression for "sign-in cuts off the create flow": a presented pane is a selected pane, and a new selection sends
    // the view home. The pane of the sign-in step must never be presented, selected or announced to the cockpit.
    let text = include_str!("signin_pane.rs");
    let code = text.split("#[cfg(test)]").next().unwrap();
    let code: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    for word in [["present", "_pane"].concat(), ["emit", "_select"].concat(), ["cockpit:", "//select"].concat(), ["open_pane", "_window"].concat(), ["new_pane", "_on_model"].concat()] {
        assert!(!code.contains(&word), "signin_pane.rs must not use {word}");
    }
}

#[test]
fn a_second_start_for_the_same_account_reuses_the_pane_and_a_dead_one_is_replaced() {
    let (store, root) = store("reuse");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let first = panes.start(fake.clone(), &acc, root.clone()).unwrap();
    let second = panes.start(fake.clone(), &acc, root.clone()).unwrap();
    assert_eq!(first, second);
    assert_eq!(fake.count.load(Ordering::SeqCst), 1, "one spawn only");
    // The pane's process ended: the next start replaces it.
    *fake.dead.lock().unwrap() = true;
    let third = panes.start(fake.clone(), &acc, root.clone()).unwrap();
    *fake.dead.lock().unwrap() = false;
    assert_ne!(first, third);
    assert_eq!(fake.count.load(Ordering::SeqCst), 2);
    panes.stop_all();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn stop_kills_the_pane_forgets_it_and_stop_all_ends_every_one() {
    let (store, root) = store("stop");
    let (a, b) = (store.add_lend("claude", "A").unwrap(), store.add_lend("claude", "B").unwrap());
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let (pa, pb) = (panes.start(fake.clone(), &a, root.clone()).unwrap(), panes.start(fake.clone(), &b, root.clone()).unwrap());
    panes.stop(&a.id);
    assert!(fake.killed.lock().unwrap().contains(&pa));
    assert!(panes.pane_of(&a.id).is_none() && !panes.alive(&a.id));
    assert!(!crate::pty::hidden::is_hidden(&pa), "the registry forgets the hidden mark when the pane is taken");
    panes.stop(&a.id);
    assert_eq!(fake.killed.lock().unwrap().len(), 1, "stopping twice is harmless");
    panes.stop_all();
    assert!(fake.killed.lock().unwrap().contains(&pb));
    assert!(panes.pane_of(&b.id).is_none());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_sign_in_nobody_finishes_is_stopped_after_the_time_limit() {
    let (store, root) = store("timeout");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let id = panes.start(fake.clone(), &acc, root.clone()).unwrap();
    std::thread::sleep(TIMEOUT + Duration::from_millis(400));
    assert!(fake.killed.lock().unwrap().contains(&id), "the time-out stopped it");
    assert!(panes.pane_of(&acc.id).is_none());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_old_timer_does_not_stop_a_newer_pane_of_the_same_account() {
    let (store, root) = store("generation");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let first = panes.start(fake.clone(), &acc, root.clone()).unwrap();
    panes.stop(&acc.id);
    std::thread::sleep(Duration::from_millis(200));
    let second = panes.start(fake.clone(), &acc, root.clone()).unwrap();
    // The first pane's timer fires now; the second pane must survive it.
    std::thread::sleep(Duration::from_millis(150));
    assert!(!fake.killed.lock().unwrap().contains(&second), "the first pane's timer left the second alone");
    assert_ne!(first, second);
    assert!(panes.alive(&acc.id), "the newer pane is still there");
    panes.stop_all();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_failed_spawn_leaves_nothing_hidden_and_nothing_remembered() {
    let (store, root) = store("fail");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    *fake.fail.lock().unwrap() = true;
    assert!(panes.start(fake.clone(), &acc, root.clone()).is_err());
    assert!(panes.pane_of(&acc.id).is_none());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn only_a_lend_only_account_that_is_not_borrowed_can_be_signed_in_to() {
    let (store, root) = store("guard");
    let lend = store.add_lend("claude", "Lend Claude").unwrap();
    let own = store.add("claude", "My own", None).unwrap();
    assert!(check_account(&store, &lend.id).is_ok());
    assert!(check_account(&store, &own.id).unwrap_err().contains("lend sign-in"), "a person's own account is refused");
    assert!(check_account(&store, "lend:lg_123456789abc").unwrap_err().contains("borrowed"), "a borrowed id is refused");
    assert!(check_account(&store, "acc_nope").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn status_reads_signed_out_then_signed_in_with_who_it_is() {
    let (store, root) = store("status");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let spec = spec();
    assert_eq!(status_of(&spec, &acc, 1).unwrap(), (SigninState::SignedOut, None));
    sign_in(&acc);
    assert_eq!(status_of(&spec, &acc, 1).unwrap(), (SigninState::SignedIn, Some("ren@example.com".to_string())));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn reuse_returns_the_same_signed_out_account_and_makes_a_new_one_otherwise() {
    let (store, root) = store("addreuse");
    let spec = spec();
    let first = add_or_reuse(&store, &spec, "claude", "Lend Claude", None, 1).unwrap();
    let again = add_or_reuse(&store, &spec, "claude", "Lend Claude", Some(&first.id), 1).unwrap();
    assert_eq!(again.id, first.id, "no second Lend Claude");
    assert_eq!(store.list().len(), 1);
    sign_in(&first);
    let fresh = add_or_reuse(&store, &spec, "claude", "Lend Claude", Some(&first.id), 1).unwrap();
    assert_ne!(fresh.id, first.id, "a signed-in account is not handed out again for 'sign in to another account'");
    assert_eq!(fresh.label, "Lend Claude 2", "the store wants a free name");
    let gone = add_or_reuse(&store, &spec, "claude", "Lend Claude", Some("acc_missing"), 1).unwrap();
    assert!(![first.id.as_str(), fresh.id.as_str()].contains(&gone.id.as_str()));
    let own = store.add("claude", "My own", None).unwrap();
    let not_mine = add_or_reuse(&store, &spec, "claude", "Lend Claude", Some(&own.id), 1).unwrap();
    assert_ne!(not_mine.id, own.id, "a person's own account is never reused as a lend sign-in");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn remove_if_empty_removes_only_a_folder_with_no_sign_in() {
    let (store, root) = store("empty");
    let spec = spec();
    let empty = store.add_lend("claude", "Empty").unwrap();
    let signed = store.add_lend("claude", "Signed").unwrap();
    sign_in(&signed);
    assert!(remove_if_empty(&store, &spec, &empty).unwrap());
    assert!(store.get(&empty.id).is_none());
    assert!(!remove_if_empty(&store, &spec, &signed).unwrap());
    assert!(store.get(&signed.id).is_some(), "a signed-in account stays");
    assert!(PathBuf::from(&signed.home).join(".credentials.json").is_file());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_agents_own_sign_in_runs_hidden_with_its_normal_login_and_is_stopped_on_request() {
    let root = std::env::temp_dir().join(format!("pm-signinpane-agent-{}", std::process::id()));
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let id = panes.start_for_agent(fake.clone(), "chat-signin:claude", "claude", root.clone()).unwrap();
    assert!(crate::pty::hidden::is_hidden(&id), "no pane list may show it");
    assert_eq!(*fake.hidden_at_spawn.lock().unwrap(), vec![true], "hidden BEFORE the spawn");
    let args = fake.spawned.lock().unwrap()[0].clone();
    assert_eq!((args.agent_type.as_str(), args.account.as_deref()), ("claude", None), "the login the agent normally uses");
    assert_eq!(args.cwd.as_deref(), Some(root.to_string_lossy().as_ref()));
    // The same agent again: the same pane, one spawn.
    assert_eq!(panes.start_for_agent(fake.clone(), "chat-signin:claude", "claude", root.clone()).unwrap(), id);
    assert_eq!(fake.count.load(Ordering::SeqCst), 1);
    assert_eq!(panes.pane_alive("chat-signin:claude").as_deref(), Some(id.as_str()));
    panes.stop("chat-signin:claude");
    assert_eq!(panes.pane_alive("chat-signin:claude"), None);
    assert!(fake.killed.lock().unwrap().contains(&id));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_lend_sign_in_is_labelled_with_its_profile_name_not_lend_claude() {
    let (store, root) = store("relabel");
    let old = store.add_lend("claude", "Lend Claude 3").unwrap();
    let other = store.add_lend("claude", "Work account").unwrap();
    let own = store.add("claude", "Mine", None).unwrap();
    relabel_for_profile(&store, &old.id, "Work account");
    assert_eq!(store.get(&old.id).unwrap().label, "Work account 2", "the store refuses two with one name");
    relabel_for_profile(&store, &old.id, "Work account");
    assert_eq!(store.get(&old.id).unwrap().label, "Work account 2", "a second run changes nothing");
    relabel_for_profile(&store, &other.id, "Family");
    assert_eq!(store.get(&other.id).unwrap().label, "Family");
    relabel_for_profile(&store, &own.id, "Family");
    assert_eq!(store.get(&own.id).unwrap().label, "Mine", "a person's own account is never renamed");
    relabel_for_profile(&store, &other.id, "  ");
    assert_eq!(store.get(&other.id).unwrap().label, "Family", "a blank name changes nothing");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_sign_in_again_with_no_chat_runs_hidden_as_the_chosen_account_and_never_selects_anything() {
    let (store, root) = store("standalone");
    let acc = store.add("claude", "Work", None).unwrap();
    let key = standalone_key("claude", Some(&acc.id));
    assert_ne!(key, standalone_key("claude", None), "the main login and an extra sign-in are different panes");
    assert!(check_standalone(&store, "claude", Some(&acc.id)).is_ok());
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    let cwd = root.join("lend").join("signin");
    let id = panes.start_for_agent_account(fake.clone(), &key, "claude", Some(acc.id.clone()), cwd.clone()).unwrap();
    assert!(crate::pty::hidden::is_hidden(&id), "no pane list may show it");
    assert_eq!(*fake.hidden_at_spawn.lock().unwrap(), vec![true], "hidden BEFORE the spawn");
    let args = fake.spawned.lock().unwrap()[0].clone();
    assert_eq!(args.account.as_deref(), Some(acc.id.as_str()));
    assert_eq!(args.cwd.as_deref(), Some(cwd.to_string_lossy().as_ref()), "an app-owned folder, not a project");
    // The same sign-in again: the same pane (reuse), one spawn.
    assert_eq!(panes.start_for_agent_account(fake.clone(), &key, "claude", Some(acc.id.clone()), cwd).unwrap(), id);
    assert_eq!(fake.count.load(Ordering::SeqCst), 1);
    panes.stop(&key);
    assert_eq!(panes.pane_alive(&key), None);
    assert!(fake.killed.lock().unwrap().contains(&id));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_standalone_sign_in_refuses_a_borrowed_a_missing_or_another_agents_account() {
    let (store, root) = store("standalone-check");
    let codex = store.add("codex", "Home", None).unwrap();
    assert!(check_standalone(&store, "claude", None).is_ok(), "the main login always passes");
    assert!(check_standalone(&store, "claude", Some("")).is_ok());
    assert!(check_standalone(&store, "claude", Some("lend:abc")).is_err(), "a borrowed sign-in");
    assert!(check_standalone(&store, "claude", Some("nope")).is_err(), "unknown");
    assert!(check_standalone(&store, "claude", Some(&codex.id)).is_err(), "another agent's account");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_standalone_sign_in_commands_never_present_a_pane() {
    let src = include_str!("../commands/chat_signin.rs");
    assert!(!src.contains("present_pane") && !src.contains("cockpit://select") && !src.contains("emit_select"));
}

#[test]
fn the_start_time_is_kept_before_the_agent_runs_and_after_its_pane_ends() {
    let (store, root) = store("started-at");
    let acc = store.add_lend("claude", "Lend Claude").unwrap();
    let (panes, fake) = (SigninPanes::new(), Arc::new(Fake::default()));
    assert!(panes.started_at(&acc.id).is_none(), "nothing started yet: nothing to prove a sign-in against");
    let before = std::time::SystemTime::now();
    panes.start(fake.clone(), &acc, root.join("lend").join("signin")).unwrap();
    let started = panes.started_at(&acc.id).expect("kept");
    assert!(started >= before && started <= std::time::SystemTime::now());
    // The pane ends; the start time stays, so a credential file written meanwhile still counts as a sign-in made after the start.
    panes.stop(&acc.id);
    assert_eq!(panes.started_at(&acc.id), Some(started));
    let _ = std::fs::remove_dir_all(&root);
}
