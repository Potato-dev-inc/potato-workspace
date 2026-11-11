//! The environment of a pane started on a borrowed grant, from the spec's `[hookup]` table: the shim's address and
//! a placeholder token are set, and every other provider variable the pane would inherit is removed, so the pane can
//! only talk to the shim.

use super::spec::Hookup;
use crate::tui::LaunchEnv;

fn same(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn starts_with(name: &str, prefix: &str) -> bool {
    name.get(..prefix.len()).is_some_and(|head| same(head, prefix))
}

/// `inherited` is the names of the app's own environment (`std::env::vars`), so prefix matches can be removed.
pub fn hookup_env(hookup: &Hookup, base_url: &str, inherited: &[String]) -> LaunchEnv {
    let set: Vec<(String, String)> = hookup.set.iter().map(|nv| (nv.name.clone(), nv.value.replace("{base_url}", base_url))).collect();
    let is_set = |n: &str| set.iter().any(|(s, _)| same(s, n));
    let mut remove: Vec<String> = Vec::new();
    let mut add = |n: &str| {
        if !is_set(n) && !remove.iter().any(|r| same(r, n)) {
            remove.push(n.to_string());
        }
    };
    for name in &hookup.remove {
        add(name);
    }
    for name in inherited {
        if hookup.remove_prefixes.iter().any(|p| starts_with(name, p)) {
            add(name);
        }
    }
    LaunchEnv { set, remove }
}

/// The hookup's scratch folder for one lend: `dir` gets the hookup's files (placeholders only, `{base_url}` filled in) and the
/// agent's config-folder variable is pointed at it. `None`: the hookup has no `home_env`. A file already holding the same
/// text is left alone (the agent may be using the folder).
pub fn write_home(hookup: &Hookup, base_url: &str, dir: &std::path::Path) -> Result<Option<(String, String)>, String> {
    let Some(name) = &hookup.home_env else { return Ok(None) };
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not prepare the borrowed sign-in: {e}"))?;
    for file in &hookup.files {
        let path = file.path.split('/').fold(dir.to_path_buf(), |p, part| p.join(part));
        let text = file.content.replace("{base_url}", base_url);
        if std::fs::read_to_string(&path).is_ok_and(|old| old == text) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not prepare the borrowed sign-in: {e}"))?;
        }
        std::fs::write(&path, text).map_err(|e| format!("Could not prepare the borrowed sign-in: {e}"))?;
    }
    Ok(Some((name.clone(), dir.to_string_lossy().into_owned())))
}

/// Puts the scratch folder variable into `env` (and keeps it out of the removals).
pub fn set_home(env: &mut LaunchEnv, home: Option<(String, String)>) {
    let Some((name, dir)) = home else { return };
    env.remove.retain(|r| !same(r, &name));
    env.set.retain(|(s, _)| !same(s, &name));
    env.set.push((name, dir));
}

/// The names of this process's environment.
pub fn inherited_names() -> Vec<String> {
    std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capacity_proxy::spec::ProxySpec;

    fn claude() -> ProxySpec {
        ProxySpec::parse(include_str!("../tui/claude/lend_proxy.toml")).unwrap()
    }

    const HOME_VAR: &str = "CODEX_HOME";

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_borrowed_pane_points_at_the_shim_with_a_placeholder_token() {
        let env = hookup_env(&claude().hookup, "http://127.0.0.1:5123/abc", &[]);
        assert!(env.set.contains(&("ANTHROPIC_BASE_URL".into(), "http://127.0.0.1:5123/abc".into())));
        assert!(env.set.contains(&("ANTHROPIC_AUTH_TOKEN".into(), "pm-lend".into())));
        assert_eq!(env.set.len(), 2);
        // The set variables are never also removed.
        assert!(!env.remove.iter().any(|r| r == "ANTHROPIC_BASE_URL" || r == "ANTHROPIC_AUTH_TOKEN"));
        for must in ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR"] {
            assert!(env.remove.iter().any(|r| r == must), "{must} is not removed");
        }
    }

    #[test]
    fn a_home_folder_gets_the_files_and_the_variable_and_is_never_also_removed() {
        let spec = ProxySpec::parse(include_str!("../tui/codex/lend_proxy.toml")).unwrap();
        let dir = std::env::temp_dir().join(format!("pm-lend-home-{}", uuid::Uuid::new_v4()));
        let inherited = names(&["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_MODEL", "PATH"]);
        let mut env = hookup_env(&spec.hookup, "http://127.0.0.1:5123/abc", &inherited);
        assert!(env.remove.iter().any(|r| r == HOME_VAR), "the prefix removes the borrower's own home first");
        set_home(&mut env, write_home(&spec.hookup, "http://127.0.0.1:5123/abc", &dir).unwrap());
        assert!(!env.remove.iter().any(|r| r == HOME_VAR));
        assert_eq!(env.set.iter().filter(|(k, _)| k == HOME_VAR).count(), 1);
        assert!(env.set.contains(&("LEND_KEY".into(), "pm-lend".into())));
        assert!(env.remove.iter().any(|r| r == "OPENAI_API_KEY") && env.remove.iter().any(|r| r == "OPENAI_MODEL"));
        let config = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(config.contains("base_url = \"http://127.0.0.1:5123/abc/v1\""), "{config}");
        // Writing again changes nothing (the agent may be using the folder).
        let stamp = std::fs::metadata(dir.join("config.toml")).unwrap().modified().unwrap();
        write_home(&spec.hookup, "http://127.0.0.1:5123/abc", &dir).unwrap();
        assert_eq!(std::fs::metadata(dir.join("config.toml")).unwrap().modified().unwrap(), stamp);
        // No home_env: nothing is written.
        assert_eq!(write_home(&claude().hookup, "http://x", &dir.join("none")).unwrap(), None);
        assert!(!dir.join("none").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inherited_provider_variables_are_removed_and_others_kept() {
        let inherited = names(&["ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "PATH", "OPENAI_API_KEY", "HOME", "anthropic_lower"]);
        let env = hookup_env(&claude().hookup, "http://127.0.0.1:1/x", &inherited);
        assert!(env.remove.iter().any(|r| r == "ANTHROPIC_SMALL_FAST_MODEL"));
        assert!(env.remove.iter().any(|r| r == "CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
        assert!(!env.remove.iter().any(|r| r == "PATH" || r == "HOME" || r == "OPENAI_API_KEY"));
        assert_eq!(env.remove.iter().any(|r| r == "anthropic_lower"), cfg!(windows), "case folds only on Windows");
        // No duplicates.
        let mut sorted = env.remove.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), env.remove.len());
    }
}
