//! The fake ACP agent lives in `pm-core` (`pm_core::acp::fake_agent`). The app's test program starts itself again as the
//! agent through the test path `acp::fake_agent::tests::child_entry`, so that test is here too and calls the same body.

pub use pm_core::acp::fake_agent::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// Not a test when run normally. As a child of another test (`PM_FAKE_ACP_ROLE` set) it is the agent.
    #[test]
    fn child_entry() {
        child_main();
    }

    /// A host whose `ssh` is this test program playing the `fakessh_unknown_key` role.
    struct FakeSshHost {
        dir: PathBuf,
    }

    impl crate::acp::config::HostEnv for FakeSshHost {
        fn var(&self, _: &str) -> Option<std::ffi::OsString> {
            None
        }
        fn which(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn adapters_dir(&self) -> PathBuf {
            self.dir.join("adapters")
        }
        fn homes_dir(&self) -> PathBuf {
            self.dir.join("homes")
        }
        fn ssh_program(&self) -> Option<crate::acp::config::SshProgram> {
            // `--` makes the real ssh arguments plain filters for the test harness.
            let mut pre: Vec<std::ffi::OsString> = HARNESS_ARGS.iter().map(std::ffi::OsString::from).collect();
            pre.push("--".into());
            Some(crate::acp::config::SshProgram { exe: std::env::current_exe().expect("test exe"), pre, env: vec![(ROLE_ENV.into(), "fakessh_unknown_key".into())] })
        }
    }

    /// End to end through a real session: `ssh` refuses an unknown host key, and the chat says the one plain sentence
    /// (the stderr of `ssh` reaches the start failure; nothing of it is copied into the sentence).
    #[test]
    fn a_remote_chat_on_an_unknown_host_key_says_to_connect_once_in_a_terminal() {
        if std::env::var(ROLE_ENV).is_ok() {
            return;
        }
        crate::engine_hooks::install();
        let dir = std::env::temp_dir().join(format!("pm-ssh-chat-{}", std::process::id()));
        let host: Arc<dyn crate::acp::config::HostEnv> = Arc::new(FakeSshHost { dir: dir.clone() });
        let cfg = crate::acp::config::for_remote(&crate::acp::config::find_builtin("claude").unwrap()).unwrap();
        let ssh = crate::ssh::model::SshHost::parse("h1", "Build box", "dev@build.local", None, None).unwrap();
        let session = crate::acp::session::AcpSession::new_remote(Arc::new(cfg), host, crate::acp::session::SessionParams { key: "ssh-fail".into(), cwd: PathBuf::from("\0ssh://h1/srv/app"), resume_session_id: None }, ssh, "/srv/app".into());
        assert!(session.ensure_running().is_err());
        assert_eq!(session.last_exit_reason().as_deref(), Some("Connect once in a terminal first so this computer's key is remembered."));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
