//! The env a guarded launch gets, resolved for the real app: the guard name must be known and the
//! empty `GH_CONFIG_DIR` folder must exist. Shared by the pane spawn and the headless launch, so
//! both fail closed the same way (an unknown guard name, or a folder that cannot be made, refuses
//! the launch; nothing starts unguarded).

use crate::tui::LaunchEnv;
use std::path::PathBuf;

/// The guard's folders live under the app data folder (`issue-intake`); tests never touch it.
fn guard_root() -> PathBuf {
    #[cfg(not(any(test, feature = "test-util")))]
    {
        crate::app_paths::app_data_dir().join("issue-intake")
    }
    #[cfg(any(test, feature = "test-util"))]
    {
        std::env::temp_dir().join(format!("pm-guard-launch-{}", std::process::id()))
    }
}

fn empty_dir(name: &str) -> Result<PathBuf, String> {
    let dir = guard_root().join(name);
    crate::secure_file::create_private_dir(&dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
    Ok(dir)
}

/// The guard's launch env, or the reason the launch is refused.
pub fn launch_env_for(guard: &str) -> Result<LaunchEnv, String> {
    if !super::env_guard::known(guard) {
        return Err(format!("unknown env guard {guard:?}; the launch is refused"));
    }
    // The private empty `GH_CONFIG_DIR` and the folder with the push-refusing hook.
    let dir = empty_dir("gh-empty").map_err(|err| format!("env guard {guard}: {err}"))?;
    let hooks = empty_dir("push-blocked-hooks").map_err(|err| format!("env guard {guard}: {err}"))?;
    super::env_guard::write_push_block_hook(&hooks).map_err(|err| format!("env guard {guard}: {err}"))?;
    super::env_guard::launch_env(guard, &dir, &hooks).ok_or_else(|| format!("unknown env guard {guard:?}; the launch is refused"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_guard_names_are_refused_not_dropped() {
        for name in ["", "nope", "NO_PUSH", "no-push", " no_push"] {
            let err = launch_env_for(name).unwrap_err();
            assert!(err.contains("refused"), "{name}: {err}");
        }
    }

    #[test]
    fn the_known_guard_points_git_at_the_push_refusing_hook_folder() {
        let env = launch_env_for(super::super::env_guard::NO_PUSH).expect("guard");
        let count: usize = env.set.iter().find(|(k, _)| k == "GIT_CONFIG_COUNT").map(|(_, v)| v.parse().unwrap()).expect("count");
        let value_of = |name: String| env.set.iter().find(|(k, _)| *k == name).map(|(_, v)| v.clone());
        let hooks = (0..count)
            .find(|i| value_of(format!("GIT_CONFIG_KEY_{i}")).as_deref() == Some("core.hooksPath"))
            .and_then(|i| value_of(format!("GIT_CONFIG_VALUE_{i}")))
            .expect("core.hooksPath is set");
        let hook = std::fs::read_to_string(PathBuf::from(hooks).join("pre-push")).expect("the pre-push hook exists");
        assert!(hook.contains("exit 1"), "{hook}");
    }

    #[test]
    fn the_known_guard_points_gh_at_an_existing_empty_folder() {
        let env = launch_env_for(super::super::env_guard::NO_PUSH).expect("guard");
        let dir = env.set.iter().find(|(k, _)| k == "GH_CONFIG_DIR").map(|(_, v)| PathBuf::from(v)).expect("dir");
        assert!(dir.is_dir(), "{}", dir.display());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the folder stays empty");
    }
}
