use super::*;
use std::process::Stdio;

fn host() -> SshHost {
    SshHost::parse("h1", "Build box", "dev@build.local", Some(2222), Some("C:/keys/id_ed25519")).unwrap()
}

fn words(w: &[&str]) -> Vec<String> {
    w.iter().map(|s| s.to_string()).collect()
}

/// Strings a hostile folder or program argument could be made of.
const HOSTILE: &[&str] = &[
    "plain",
    "with space",
    "it's",
    "two''quotes'",
    "say \"hi\"",
    "$HOME",
    "$(id)",
    "`id`",
    "a;b",
    "a && b || c",
    "a|b>c<d",
    "-rf",
    "--help",
    "line1\nline2",
    "tab\tin",
    "back\\slash",
    "trailing newline\n",
    "~",
    "~/x",
    "*",
    "{a,b}",
    "!history",
    "caf\u{e9} \u{65e5}\u{672c}\u{8a9e} \u{1f600}",
    "100%s %n %",
    "",
];

#[test]
fn the_pane_folder_marker_round_trips_including_a_home_folder() {
    for folder in ["/srv/my app", "~/x", "~", "/"] {
        let m = pane_folder("7d1c0a52-aaaa", folder);
        assert!(m.starts_with(PANE_FOLDER_PREFIX) && m.starts_with('\0'), "no path of this PC");
        assert_eq!(remote_folder_of(&m), Some(("7d1c0a52-aaaa", folder)), "{folder}");
    }
    assert_eq!(remote_folder_of("/srv/app"), None);
    assert_eq!(remote_folder_of(&pane_folder("", "/x")), None);
}

#[test]
fn encode_alphabet_is_x_and_octal_digits_only() {
    for s in HOSTILE {
        let e = encode(s);
        assert!(e.starts_with('x'), "{e}");
        assert!(e[1..].bytes().all(|b| (b'0'..=b'7').contains(&b)), "{s:?} -> {e}");
        assert_eq!(decode(&e).as_deref(), Some(*s), "round trip of {s:?}");
    }
    assert_eq!(encode("A"), "x101");
    assert_eq!(encode(""), "x");
    assert_eq!(decode("x18"), None);
    assert_eq!(decode("y101"), None);
}

#[test]
fn argv_shape_is_fixed_and_strict() {
    let a = acp_argv(&host(), "/srv/my app", &words(&["claude-agent-acp"])).unwrap();
    let head: Vec<&str> = a.iter().take(a.len() - 1).map(String::as_str).collect();
    assert_eq!(
        head,
        [
            "-T", "-p", "2222", "-i", "C:/keys/id_ed25519", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", "-o", "NumberOfPasswordPrompts=0", "-o", "ServerAliveInterval=30", "-o",
            "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", "-o", "ControlPath=none", "--", "dev@build.local"
        ]
    );
    let line = a.last().unwrap();
    assert_eq!(line, &format!("exec /bin/sh -lc '{FAR_SCRIPT}' sh {} {}", encode("/srv/my app"), encode("claude-agent-acp")));
    for bad in ["StrictHostKeyChecking=no", "StrictHostKeyChecking=ask", "accept-new", "StrictHostKeyChecking=off"] {
        assert!(!a.iter().any(|x| x == bad), "{bad}");
    }
}

#[test]
fn no_key_file_means_no_dash_i() {
    let mut h = host();
    h.key_file = None;
    let a = acp_argv(&h, "/x", &words(&["codex-acp"])).unwrap();
    assert!(!a.iter().any(|x| x == "-i"));
}

#[test]
fn the_fixed_script_has_no_single_quote_bang_or_newline() {
    assert!(!FAR_SCRIPT.contains('\''));
    assert!(!FAR_SCRIPT.contains('!'));
    assert!(!FAR_SCRIPT.contains('\n'));
}

#[test]
fn hostile_folders_never_reach_the_command_line_as_text() {
    for folder in HOSTILE {
        let f = format!("/{folder}");
        let result = acp_argv(&host(), &f, &words(&["claude-agent-acp"]));
        if f.chars().any(char::is_control) {
            assert_eq!(result.unwrap_err(), RemoteError::Part(PartError::Folder), "{f:?}");
            continue;
        }
        let a = result.unwrap();
        let line = a.last().unwrap();
        // Everything after the fixed script is words of the closed alphabet.
        let tail = line.strip_prefix(&format!("exec /bin/sh -lc '{FAR_SCRIPT}' sh ")).expect("fixed prefix");
        for w in tail.split(' ') {
            assert!(decode(w).is_some(), "{w}");
        }
        assert_eq!(decode(tail.split(' ').next().unwrap()).as_deref(), Some(f.as_str()));
        // The folder text appears nowhere in the arguments except through the encoding.
        if f.len() > 3 {
            assert!(!a.iter().any(|x| x.contains(&f)), "{f:?}");
        }
    }
}

#[test]
fn hostile_programs_are_refused_and_hostile_arguments_are_encoded() {
    for program in ["-x", "a b", "a;b", "$(id)", "`id`", "it's", "a/b", "../x", "x\ny", "", "~", "caf\u{e9}"] {
        assert_eq!(acp_argv(&host(), "/x", &words(&[program])).unwrap_err(), RemoteError::Part(PartError::Program), "{program:?}");
    }
    for arg in HOSTILE.iter().filter(|a| !a.contains('\0')) {
        let a = acp_argv(&host(), "/x", &words(&["opencode", arg])).unwrap();
        let line = a.last().unwrap();
        let tail = line.strip_prefix(&format!("exec /bin/sh -lc '{FAR_SCRIPT}' sh ")).unwrap();
        let w: Vec<&str> = tail.split(' ').collect();
        assert_eq!(w.len(), 3);
        assert_eq!(decode(w[2]).as_deref(), Some(*arg));
    }
}

#[test]
fn bad_folders_and_empty_programs_are_refused() {
    for folder in ["", "relative/path", "-rf", "\n", "/a\nb", "/a\0b"] {
        assert_eq!(acp_argv(&host(), folder, &words(&["codex-acp"])).unwrap_err(), RemoteError::Part(PartError::Folder), "{folder:?}");
    }
    assert_eq!(acp_argv(&host(), "/x", &[]).unwrap_err(), RemoteError::NoProgram);
    assert_eq!(acp_argv(&host(), &format!("/{}", "a".repeat(2000)), &words(&["codex-acp"])).unwrap_err(), RemoteError::Part(PartError::Folder));
    let many: Vec<String> = std::iter::once("codex-acp".to_string()).chain((0..20).map(|i| i.to_string())).collect();
    assert_eq!(acp_argv(&host(), "/x", &many).unwrap_err(), RemoteError::TooLong);
    assert_eq!(acp_argv(&host(), "/x", &words(&["codex-acp", &"a".repeat(2000)])).unwrap_err(), RemoteError::TooLong);
}

#[test]
fn no_secret_is_in_the_argument_list() {
    // The only secret-shaped input a host has is the key FILE PATH, and the contents are never read here.
    let a = acp_argv(&host(), "/x", &words(&["claude-agent-acp"])).unwrap().join(" ");
    // The one option that names a password turns prompting OFF (`NumberOfPasswordPrompts=0`).
    let a = a.replace("NumberOfPasswordPrompts=0", "");
    for needle in ["password", "passphrase", "token", "API_KEY", "SECRET", "ANTHROPIC", "OPENAI", "BEGIN PRIVATE KEY"] {
        assert!(!a.to_ascii_lowercase().contains(&needle.to_ascii_lowercase()), "{needle}");
    }
    // ssh gets no way to hand this PC's environment or agent to the far side.
    assert!(a.contains("ForwardAgent=no") && !a.contains("SendEnv") && !a.contains("SetEnv"));
}

#[test]
fn an_unknown_host_key_says_one_plain_sentence() {
    let lines = vec!["No ED25519 host key is known for build.local and you have requested strict checking.".to_string(), "Host key verification failed.".to_string()];
    assert_eq!(failure_sentence("Build box", "claude-agent-acp", &lines).as_deref(), Some("Connect once in a terminal first so this computer's key is remembered."));
    assert_eq!(HOST_KEY_UNKNOWN, "Connect once in a terminal first so this computer's key is remembered.");
}

#[test]
fn other_failures_have_plain_sentences_without_far_text() {
    let changed = vec!["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!".to_string()];
    assert!(failure_sentence("Box", "p", &changed).unwrap().contains("key changed"));
    let denied = vec!["dev@build.local: Permission denied (publickey).".to_string()];
    assert!(failure_sentence("Box", "p", &denied).unwrap().contains("did not accept"));
    let down = vec!["ssh: connect to host build.local port 22: Connection refused".to_string()];
    assert!(failure_sentence("Box", "p", &down).unwrap().contains("Cannot reach"));
    let missing = vec!["sh: 1: exec: claude-agent-acp: not found".to_string()];
    let s = failure_sentence("Box", "claude-agent-acp", &missing).unwrap();
    assert!(s.contains("claude-agent-acp") && s.contains("not installed on Box"));
    let folder = vec!["pm-ssh: the folder was not found".to_string()];
    assert_eq!(failure_sentence("Box", "p", &folder).as_deref(), Some("That folder was not found on Box."));
    // Far text that is not recognised is never copied into a sentence.
    assert_eq!(failure_sentence("Box", "p", &["something $(evil) odd".to_string()]), None);
}

// ---- the fixed script, run by a real POSIX shell when this machine has one ----------------------------------------

fn sh() -> Option<&'static str> {
    static SH: std::sync::OnceLock<Option<&'static str>> = std::sync::OnceLock::new();
    *SH.get_or_init(|| crate::proc_util::hidden_command("sh").arg("-c").arg("exit 0").stdin(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| "sh"))
}

fn run_script(folder_word: &str, program_words: &[String]) -> (bool, String) {
    let mut cmd = crate::proc_util::hidden_command(sh().unwrap());
    cmd.arg("-c").arg(FAR_SCRIPT).arg("sh").arg(folder_word);
    for w in program_words {
        cmd.arg(w);
    }
    let out = cmd.stdin(Stdio::null()).output().unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn the_script_rebuilds_every_hostile_argument_byte_for_byte() {
    if sh().is_none() || crate::proc_util::hidden_command("printf").arg("x").output().is_err() {
        eprintln!("no POSIX sh or printf program here: skipped");
        return;
    }
    let mut args: Vec<String> = vec![encode("printf"), encode("[%s]")];
    let mut expect = String::new();
    for h in HOSTILE.iter().filter(|h| !h.is_empty()) {
        args.push(encode(h));
        expect.push_str(&format!("[{h}]"));
    }
    let (ok, out) = run_script(&encode("."), &args);
    assert!(ok);
    assert_eq!(out, expect);
}

#[test]
fn the_script_runs_nothing_hostile_and_creates_no_files() {
    if sh().is_none() || crate::proc_util::hidden_command("printf").arg("x").output().is_err() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("pm-ssh-acp-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("pwned");
    let hostile = format!("x; touch '{}'; $(touch '{}') `touch '{}'`", marker.display(), marker.display(), marker.display());
    let args = vec![encode("printf"), encode("%s"), encode(&hostile)];
    let (ok, out) = run_script(&encode("."), &args);
    assert!(ok);
    assert_eq!(out, hostile);
    assert!(!marker.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_whole_remote_line_survives_a_real_shell_parse() {
    if sh().is_none() || crate::proc_util::hidden_command("printf").arg("x").output().is_err() {
        return;
    }
    let a = acp_argv(&host(), "/", &words(&["printf", "[%s]", "a b", "it's", "$(id)", "line1\nline2", "-x"])).unwrap();
    let line = a.last().unwrap().replacen("exec /bin/sh -lc", "exec sh -c", 1);
    assert!(line.starts_with("exec sh -c '"));
    let out = crate::proc_util::hidden_command("sh").arg("-c").arg(&line).stdin(Stdio::null()).output().unwrap();
    // The folder `/` is not changed into on every OS the same way, so only the program output is compared.
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(text, "[a b][it's][$(id)][line1\nline2][-x]", "stderr: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_missing_folder_exits_97_with_the_fixed_line() {
    if sh().is_none() {
        return;
    }
    let mut cmd = crate::proc_util::hidden_command("sh");
    cmd.arg("-c").arg(FAR_SCRIPT).arg("sh").arg(encode("/definitely/not/here-xyz")).arg(encode("true"));
    let out = cmd.stdin(Stdio::null()).output().unwrap();
    assert_eq!(out.status.code(), Some(97));
    assert!(String::from_utf8_lossy(&out.stderr).contains("pm-ssh: the folder was not found"));
}

#[test]
fn the_ssh_environment_has_what_windows_openssh_needs_to_start() {
    // Found against a real sshd: with the cleared environment of a chat start, Windows `ssh.exe` exits 255 with no output at all
    // unless `ProgramData` (where its system config lives) is there. A chat start then said only "closed right away".
    assert!(SSH_ENV.contains(&"ProgramData") && SSH_ENV.contains(&"SystemRoot") && SSH_ENV.contains(&"USERPROFILE"));
    // Nothing secret-shaped is ever in the list.
    for name in SSH_ENV {
        let low = name.to_ascii_lowercase();
        assert!(!["key", "token", "secret", "pass"].iter().any(|n| low.contains(n)), "{name}");
    }
}
