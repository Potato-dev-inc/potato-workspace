use super::*;

fn temp_store(name: &str) -> (Store, PathBuf) {
    let root = std::env::temp_dir().join(format!("pm-accounts-{name}-{}", uuid::Uuid::new_v4()));
    (Store::at(&root), root)
}

#[test]
fn crud_round_trips_through_accounts_json() {
    let (store, root) = temp_store("crud");
    assert!(store.list().is_empty());
    let work = store.add("claude", "Work", None).unwrap();
    let personal = store.add("claude", "Personal", None).unwrap();
    assert!(work.id.starts_with("acc_") && work.id != personal.id);
    assert_eq!(work.agent_id, "claude");
    assert!(Path::new(&work.home).is_dir(), "default home is created");
    assert!(Path::new(&work.home).starts_with(root.join("accounts")));
    assert_eq!(store.list().len(), 2);

    // persisted: a fresh Store on the same folder sees it, as one JSON file
    let again = Store::at(&root);
    assert_eq!(again.get(&work.id), Some(work.clone()));
    let text = std::fs::read_to_string(root.join("accounts.json")).unwrap();
    assert!(text.contains("\"agent_id\": \"claude\"") && text.contains("\"label\": \"Work\""));

    let renamed = store.rename(&work.id, "  Work (Max)  ").unwrap();
    assert_eq!(renamed.label, "Work (Max)");
    assert_eq!(store.get(&work.id).unwrap().label, "Work (Max)");
    assert!(store.rename("acc_missing", "x").is_err());

    assert_eq!(store.remove(&personal.id, false), Ok(false));
    assert_eq!(store.list().len(), 1);
    assert!(store.remove(&personal.id, false).is_err(), "already gone");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn labels_are_unique_per_agent_and_validated() {
    let (store, root) = temp_store("labels");
    store.add("claude", "Work", None).unwrap();
    assert!(store.add("claude", "work", None).unwrap_err().contains("already has"));
    store.add("codex", "Work", None).expect("same label under another agent is fine");
    assert!(store.add("claude", "   ", None).is_err());
    assert!(store.add("claude", &"x".repeat(41), None).is_err());
    let b = store.add("claude", "B", None).unwrap();
    assert!(store.rename(&b.id, "WORK").is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn only_agents_whose_profile_declares_a_scheme_get_accounts() {
    let (store, root) = temp_store("support");
    assert!(store.add("claude", "a", None).is_ok());
    assert!(store.add("codex", "a", None).is_ok());
    assert!(store.add("opencode", "a", None).is_ok());
    // no verified env var for these: left out on purpose (docs/features/account-profiles.md)
    for agent in ["opencode_native", "cursor_agent", "cmd"] {
        let err = store.add(agent, "a", None).unwrap_err();
        assert!(err.contains("does not support accounts") || err.contains("unknown agent"), "{agent}: {err}");
    }
    assert!(store.add("no_such_agent", "a", None).unwrap_err().contains("unknown agent"));
    let ids: Vec<String> = supporting_agents().into_iter().map(|a| a.agent_id).collect();
    assert!(ids.contains(&"claude".to_string()) && ids.contains(&"codex".to_string()));
    assert!(ids.contains(&"opencode".to_string()));
    assert!(!ids.contains(&"opencode_native".to_string()));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn account_maps_to_the_profiles_home_env_var() {
    let (store, root) = temp_store("env");
    let claude = store.add("claude", "Work", None).unwrap();
    let codex = store.add("codex", "Work", None).unwrap();
    let env = store.launch_env("claude", &claude.id).unwrap();
    assert_eq!(env.set, vec![("CLAUDE_CONFIG_DIR".to_string(), claude.home.clone())]);
    assert!(env.remove.is_empty());
    let env = store.launch_env("codex", &codex.id).unwrap();
    assert_eq!(env.set, vec![("CODEX_HOME".to_string(), codex.home.clone())]);
    let opencode = store.add("opencode", "Work", None).unwrap();
    let env = store.launch_env("opencode", &opencode.id).unwrap();
    assert_eq!(env.set, vec![("XDG_DATA_HOME".to_string(), opencode.home.clone())]);
    assert!(env.remove.is_empty());
    // an account belongs to one agent
    assert!(store.launch_env("codex", &claude.id).unwrap_err().contains("belongs to claude"));
    assert!(store.launch_env("claude", "acc_nope").unwrap_err().contains("unknown account"));
    // extra variables from the scheme ride along
    let scheme = AccountScheme {
        home_env: "X_HOME".into(),
        extra_env: vec![("X_FLAG".into(), "1".into())],
        login_hint: String::new(),
        credential_files: Vec::new(),
    };
    assert_eq!(env_for(&scheme, &claude).set, vec![("X_HOME".into(), claude.home.clone()), ("X_FLAG".into(), "1".into())]);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn removing_never_deletes_the_home_unless_asked_and_only_app_owned_ones() {
    let (store, root) = temp_store("remove");
    let kept = store.add("claude", "kept", None).unwrap();
    assert_eq!(store.remove(&kept.id, false), Ok(false));
    assert!(Path::new(&kept.home).is_dir(), "home survives a plain remove");

    let gone = store.add("claude", "gone", None).unwrap();
    assert_eq!(store.remove(&gone.id, true), Ok(true));
    assert!(!Path::new(&gone.home).exists(), "the explicit flag deletes the app-owned home");

    // a folder the user pointed at is never deleted, flag or not
    let user_dir = std::env::temp_dir().join(format!("pm-user-home-{}", uuid::Uuid::new_v4()));
    let custom = store.add("claude", "custom", Some(user_dir.to_str().unwrap())).unwrap();
    assert_eq!(custom.home, user_dir.to_string_lossy());
    assert_eq!(store.remove(&custom.id, true), Ok(false));
    assert!(user_dir.is_dir());
    assert!(store.add("claude", "rel", Some("relative/dir")).is_err());
    let _ = std::fs::remove_dir_all(user_dir);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn custom_homes_with_dotdot_or_overlapping_folders_are_refused_and_never_deleted() {
    let (store, root) = temp_store("overlap");
    let first = store.add("claude", "first", None).unwrap();
    std::fs::write(Path::new(&first.home).join("keep.txt"), "x").unwrap();
    // `..` is refused outright.
    let sneaky = format!("{}/accounts/../accounts/{}", root.display(), first.id);
    assert!(store.add("claude", "dots", Some(&sneaky)).is_err());
    // Another account's folder, the app's accounts folder, and the app data folder are all refused.
    assert!(store.add("claude", "dup", Some(&first.home)).is_err());
    assert!(store.add("claude", "root", Some(root.join("accounts").to_str().unwrap())).is_err());
    assert!(store.add("claude", "data", Some(root.to_str().unwrap())).is_err());
    assert!(store.add("claude", "inside", Some(root.join("accounts").join("x").to_str().unwrap())).is_err());
    assert!(store.add("claude", "parent", Some(root.parent().unwrap().to_str().unwrap())).is_err());
    assert!(Path::new(&first.home).join("keep.txt").is_file());
    // A hand-edited accounts.json that points an account at the app data folder deletes nothing.
    let mut file = store.read();
    file.accounts.push(Account { id: "acc_evil".into(), agent_id: "claude".into(), label: "evil".into(), home: root.join("accounts").join("..").to_string_lossy().into_owned(), lend_only: false });
    file.accounts.push(Account { id: "acc_other".into(), agent_id: "claude".into(), label: "other".into(), home: first.home.clone(), lend_only: false });
    store.write(&file).unwrap();
    assert_eq!(store.remove("acc_evil", true), Ok(false));
    assert_eq!(store.remove("acc_other", true), Ok(false), "a home that is not <accounts>/<its own id> is not app-created");
    assert!(Path::new(&first.home).join("keep.txt").is_file());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_leading_tilde_in_a_custom_home_is_expanded_first() {
    let (store, root) = temp_store("tilde");
    // "~" alone would be the real home folder; it must be treated as an absolute path, not "relative".
    let err = store.add("claude", "tilde", Some("~/pm-accounts-test-never-created-dir/..")).unwrap_err();
    assert!(!err.contains("absolute"), "{err}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_run_naming_an_unsupported_agent_or_unknown_account_is_refused_before_spawning() {
    assert!(validate_for_run("opencode_native", "acc_x").unwrap_err().contains("does not support accounts"));
    assert!(validate_for_run("claude", "acc_does_not_exist").unwrap_err().contains("unknown account"));
    assert!(validate_for_run("no_such_agent", "acc_x").unwrap_err().contains("unknown agent"));
}

#[test]
fn login_state_reads_the_profiles_credential_file() {
    let (store, root) = temp_store("login-state");
    let claude = store.add("claude", "Work", None).unwrap();
    let codex = store.add("codex", "Work", None).unwrap();
    let state = |agent: &str, account: &Account| login_state(&scheme_for(agent).unwrap(), account);
    // A fresh, empty folder: never logged in.
    assert_eq!(state("claude", &claude), "signed_out");
    // The folder has other files but no credential file: the login may live elsewhere.
    std::fs::write(Path::new(&claude.home).join("settings.json"), "{}").unwrap();
    assert_eq!(state("claude", &claude), "unknown");
    std::fs::write(Path::new(&claude.home).join(".credentials.json"), "{}").unwrap();
    assert_eq!(state("claude", &claude), "signed_in");
    // Each agent has its own file name.
    assert_eq!(state("codex", &codex), "signed_out");
    std::fs::write(Path::new(&codex.home).join("auth.json"), "{}").unwrap();
    assert_eq!(state("codex", &codex), "signed_in");
    // A profile that declares no credential file cannot tell.
    let none = AccountScheme { home_env: "X".into(), extra_env: Vec::new(), login_hint: String::new(), credential_files: Vec::new() };
    assert_eq!(login_state(&none, &codex), "unknown");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn capability_rows_list_each_account_with_its_login_state() {
    let (store, root) = temp_store("capability-rows");
    let work = store.add("claude", "Work", None).unwrap();
    store.add("codex", "Other", None).unwrap();
    std::fs::write(Path::new(&work.home).join(".credentials.json"), "{}").unwrap();
    let rows = capability_rows(&store, "claude");
    assert_eq!(rows, vec![serde_json::json!({"id": work.id, "label": "Work", "login_state": "signed_in"})]);
    assert!(capability_rows(&store, "opencode").is_empty(), "no accounts for an agent without them");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_agent_or_helper_run_may_not_use_a_borrowed_sign_in() {
    let error = validate_for_agent_run("claude", "lend:lg_abc").unwrap_err();
    assert_eq!(error, "A borrowed sign-in can only be used in a pane you start yourself, not by an agent or helper run.");
    // Even with stray spaces, and for any agent: it is refused before anything else is looked at.
    assert!(validate_for_agent_run("no_such_agent", "  lend:lg_abc").unwrap_err().contains("borrowed sign-in"));
    // Everything else is judged as before.
    assert!(validate_for_agent_run("claude", "acc_does_not_exist").unwrap_err().contains("unknown account"));
}
