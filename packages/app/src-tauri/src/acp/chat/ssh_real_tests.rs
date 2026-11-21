//! The chat start of a remote pane (`start` with `remote: Some(host)`, the code `ssh_chat_start` calls) against the REAL system `ssh`
//! and the disposable sshd of `test-hosts/ssh`. Ignored by default; same variables as `ssh::real_tests`. Only the echo adapter runs there.

use super::*;
use crate::ssh::real_tests as real;

/// A host whose `ssh` is the real one (what `HostEnv::ssh_program` returns on a real machine), with this process's environment.
struct RealSshEnv {
    root: PathBuf,
    exe: PathBuf,
}

impl HostEnv for RealSshEnv {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
    fn ssh_program(&self) -> Option<crate::acp::config::SshProgram> {
        Some(crate::acp::config::SshProgram { exe: self.exe.clone(), pre: Vec::new(), env: Vec::new() })
    }
}

fn echo_texts(v: &Value, out: &mut Vec<Value>) {
    match v {
        Value::String(s) => {
            if let Ok(j) = serde_json::from_str::<Value>(s) {
                if j.get("requestedCwd").is_some() {
                    out.push(j);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| echo_texts(x, out)),
        Value::Object(o) => o.values().for_each(|x| echo_texts(x, out)),
        _ => {}
    }
}

#[test]
#[ignore = "needs the disposable sshd container (see ssh::real_tests)"]
fn a_remote_chat_start_runs_the_real_echo_agent_over_real_ssh() {
    let Some(e) = real::env() else { panic!("set PM_SSH_REAL_HOST and PM_SSH_REAL_KEY") };
    let mut c = real::Check { fails: vec![], passes: 0 };
    let dir = std::env::temp_dir().join(format!("pm-ssh-real-chat-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let hostile = format!("{}/it's $(touch /tmp/pwned) `x`;y z", real::BASE);
    real::make_folders(&e, &[hostile.clone()]);
    // The built-in Claude definition, as the app has it: its far program is `claude-agent-acp`.
    let cfg = crate::acp::config::find_builtin("claude").expect("claude definition");
    assert_eq!(cfg.remote_command, vec!["claude-agent-acp".to_string()]);
    let registry = Arc::new(Mutex::new(PaneRegistry::new()));
    let deps = StartDeps { registry: registry.clone(), host: Arc::new(Recorder::default()), env: Arc::new(RealSshEnv { root: dir.clone(), exe: e.exe.clone() }), conversations: None };
    let chat = start(&deps, cfg.clone(), StartRequest { agent_id: "claude".into(), folder: PathBuf::from(&hostile), explicit: true, remote: Some(e.host.clone()), ..Default::default() }).expect("the remote chat starts over real ssh");
    chat.send("hello from the app").unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        seen.clear();
        echo_texts(&serde_json::to_value(chat.items()).unwrap(), &mut seen);
        if !seen.is_empty() && chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["kind"] == "turnEnd") {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    c.ok("the chat shows the echo agent's answer", seen.len() == 1, || format!("{seen:?}"));
    if let Some(v) = seen.first() {
        c.ok("echo saw the prompt the app sent", v["prompt"] == "hello from the app", || v.to_string());
        c.ok("the agent runs in the remote folder (cwd)", v["cwd"] == hostile.as_str(), || v.to_string());
        c.ok("the app sent that same folder in session/new", v["requestedCwd"] == hostile.as_str(), || v.to_string());
    }
    c.ok("the chat reached turnEnd", chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["kind"] == "turnEnd"), || "no turnEnd".into());
    // The pane folder on this PC is the marker, not a path; nothing exists here at the remote path.
    let cwd = registry.lock().get(chat.pane_id()).expect("the pane").info().cwd;
    c.ok("pane folder is the marker", crate::ssh::acp::remote_folder_of(&cwd) == Some(("real1", hostile.as_str())), || cwd.clone());
    c.ok("the marker is no path on this PC", !Path::new(&cwd).exists() && std::fs::create_dir_all(Path::new(&cwd).join("x")).is_err(), || "a folder can be made".into());
    c.ok("nothing exists at the remote path on this PC", !Path::new(&hostile).exists(), || "exists".into());
    c.ok("is_remote_pane", crate::acp::chat::is_remote_pane(chat.pane_id()), || "not remote".into());
    c.ok("external panes (phone, agents) never list it", crate::acp::chat::external_panes(&registry).iter().all(|p| p.id != chat.pane_id()), || "listed".into());
    c.ok("the app window's own list does", registry.lock().list_including_remote().iter().any(|p| p.id == chat.pane_id()), || "missing".into());
    c.ok("no conversation saved for it (lives as long as the app)", deps.conversations.is_none(), || "".into());
    c.ok("nothing hostile ran on the host", !real::container_has(&e, "/tmp/pwned"), || "/tmp/pwned EXISTS".into());
    chat.retire();

    // A folder that is not there: the start fails with the plain sentence, no pane is left.
    let before = registry.lock().list_including_remote().len();
    let err = start(&deps, cfg.clone(), StartRequest { agent_id: "claude".into(), folder: PathBuf::from(format!("{}/no-such-folder", real::BASE)), explicit: true, remote: Some(e.host.clone()), ..Default::default() }).err();
    c.ok("missing folder: start fails with the plain sentence", err.as_ref().is_some_and(|x| x.message == "That folder was not found on Test box."), || format!("{:?}", err.map(|x| x.message)));
    c.ok("missing folder: no pane left behind", registry.lock().list_including_remote().len() == before, || "pane left".into());

    // A program that is not installed (a definition whose far program is missing there).
    let mut missing = cfg.clone();
    missing.remote_command = vec!["no-such-adapter-xyz".into()];
    let err = start(&deps, missing, StartRequest { agent_id: "claude".into(), folder: PathBuf::from(format!("{}/plain", real::BASE)), explicit: true, remote: Some(e.host.clone()), ..Default::default() }).err();
    c.ok("missing program: plain sentence", err.as_ref().is_some_and(|x| x.message.contains("not installed on Test box")), || format!("{:?}", err.map(|x| x.message)));

    // An unknown host key (the host's known_hosts line is out for a moment): the one sentence.
    {
        let _hidden = real::KnownHostsSwap::new("[127.0.0.1]:2222 ", None);
        let err = start(&deps, cfg.clone(), StartRequest { agent_id: "claude".into(), folder: PathBuf::from(format!("{}/plain", real::BASE)), explicit: true, remote: Some(e.host.clone()), ..Default::default() }).err();
        c.ok("unknown host key: the one sentence", err.as_ref().is_some_and(|x| x.message == crate::ssh::acp::HOST_KEY_UNKNOWN), || format!("{:?}", err.map(|x| x.message)));
    }

    eprintln!("RESULT: {} passed, {} failed", c.passes, c.fails.len());
    let _ = std::fs::remove_dir_all(&dir);
    assert!(c.fails.is_empty(), "failures:\n{}", c.fails.join("\n"));
}
