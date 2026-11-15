use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const CLAUDE: &str = include_str!("../tui/claude/lend_proxy.toml");
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
