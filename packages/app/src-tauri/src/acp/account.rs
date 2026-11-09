//! Chat sessions under an account (`run_agent` with `lane: "acp"` and `account`): the same accounts the terminal
//! lane uses (`accounts::Store`). The agent's profile says whether it has accounts and which variable points it at
//! one (`TuiProfile::account_scheme`); nothing here names an agent.

use crate::accounts::{self, Store};
use crate::tui::LaunchEnv;

/// Why an account cannot be used for a chat session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountProblem {
    /// `ACCOUNT_NOT_FOUND` or `ACCOUNT_UNSUPPORTED`.
    pub code: &'static str,
    pub message: String,
    /// The agents that do support accounts (for `ACCOUNT_UNSUPPORTED`).
    pub supported: Vec<String>,
}

/// The agents whose profile declares an account scheme.
pub fn supporting_agent_ids() -> Vec<String> {
    accounts::supporting_agents().into_iter().map(|a| a.agent_id).collect()
}

/// The environment that points `agent_id`'s adapter at account `account`.
pub fn launch_env(store: &Store, agent_id: &str, account: &str) -> Result<LaunchEnv, AccountProblem> {
    let has_scheme = crate::tui::is_registered(agent_id) && crate::tui::profile_for(agent_id).account_scheme().is_some();
    if !has_scheme {
        let supported = supporting_agent_ids();
        return Err(AccountProblem {
            code: "ACCOUNT_UNSUPPORTED",
            message: format!("{agent_id} does not support accounts. Agents that do: {}. Leave out account to use the agent's own login.", supported.join(", ")),
            supported,
        });
    }
    store.launch_env(agent_id, account).map_err(|why| AccountProblem {
        code: "ACCOUNT_NOT_FOUND",
        message: format!("{why}. Pick an account of {agent_id} from Settings > Agents > Accounts, or leave out account."),
        supported: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::config::{build_env, find_builtin, with_account_env, HostEnv};
    use std::ffi::OsString;

    fn temp_store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("pm-acp-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (Store::at(&dir), dir)
    }

    fn lookup(env: &[(OsString, OsString)], name: &str) -> Option<String> {
        env.iter().find(|(n, _)| n.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v.to_string_lossy().into_owned())
    }

    struct Host;
    impl HostEnv for Host {
        fn var(&self, name: &str) -> Option<OsString> {
            (name == "CLAUDE_CONFIG_DIR").then(|| OsString::from("/main-login"))
        }
        fn which(&self, _program: &str) -> Option<std::path::PathBuf> {
            None
        }
        fn adapters_dir(&self) -> std::path::PathBuf {
            "adapters".into()
        }
        fn homes_dir(&self) -> std::path::PathBuf {
            "homes".into()
        }
    }

    #[test]
    fn claude_chat_under_an_account_gets_the_accounts_home_not_the_apps() {
        let (store, dir) = temp_store();
        let account = store.add("claude", "Work", None).unwrap();
        let launch = launch_env(&store, "claude", &account.id).expect("claude has accounts");
        let mut cfg = find_builtin("claude").expect("claude has an ACP definition");
        assert_eq!(lookup(&build_env(&cfg, &Host, None), "CLAUDE_CONFIG_DIR").as_deref(), Some("/main-login"), "without an account the app's own value passes through");
        with_account_env(&mut cfg, &launch);
        assert_eq!(lookup(&build_env(&cfg, &Host, None), "CLAUDE_CONFIG_DIR"), Some(account.home.clone()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_chat_under_an_account_gets_codex_home() {
        let (store, dir) = temp_store();
        let account = store.add("codex", "Second", None).unwrap();
        let launch = launch_env(&store, "codex", &account.id).unwrap();
        let mut cfg = find_builtin("codex").unwrap();
        with_account_env(&mut cfg, &launch);
        assert_eq!(lookup(&build_env(&cfg, &Host, None), "CODEX_HOME"), Some(account.home.clone()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unknown_account_is_account_not_found() {
        let (store, dir) = temp_store();
        let problem = launch_env(&store, "claude", "nope").unwrap_err();
        assert_eq!(problem.code, "ACCOUNT_NOT_FOUND");
        // An account of another agent is not found for this one either.
        let other = store.add("codex", "x", None).unwrap();
        assert_eq!(launch_env(&store, "claude", &other.id).unwrap_err().code, "ACCOUNT_NOT_FOUND");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_agent_without_accounts_is_account_unsupported_and_the_error_lists_who_has_them() {
        let (store, dir) = temp_store();
        let agents = crate::tui::registry::registry().ordered();
        let without = agents.iter().find(|p| p.account_scheme().is_none()).expect("some agent has no accounts").id().to_string();
        let problem = launch_env(&store, &without, "any").unwrap_err();
        assert_eq!(problem.code, "ACCOUNT_UNSUPPORTED");
        assert!(problem.supported.iter().any(|a| a == "claude") && problem.message.contains("claude"), "{problem:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
