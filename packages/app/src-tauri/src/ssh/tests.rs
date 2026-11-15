//! Tests of the SSH place. No real SSH host: the runner runs a fake `ssh` shell script, and nothing leaves this PC.

use super::check;
use super::command::{check_argv, quote_folder, remote_script, terminal_argv, Remote};
use super::model::*;
use super::once::{self, SshLaunch};
use super::run::{self, LiveRunner};
use super::store::{Saved, Store};
use std::path::PathBuf;

fn host() -> SshHost {
    SshHost::parse("h1", "Build box", "dev@build.local", Some(2222), Some("C:/keys/id_ed25519")).unwrap()
}

/// A tiny deterministic generator, so a failure repeats.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// Half the time a plain word (so valid inputs are reached), half the time hostile text.
    fn mixed(&mut self) -> String {
        if self.next() % 2 == 0 {
            let n = 1 + (self.next() % 8) as usize;
            (0..n).map(|_| (b'a' + (self.next() % 26) as u8) as char).collect()
        } else {
            self.hostile()
        }
    }
    fn hostile(&mut self) -> String {
        const PIECES: &[&str] = &[
            "a", "Z", "0", "-", "_", ".", "@", "'", "\"", "`", "$", "(", ")", ";", "|", "&", "<", ">", "\\", "/", "~", " ", "\n", "\t", "\0", "%", "!", "#", "*", "?",
            "{", "}", "[", "]", ":", ",", "=", "e\u{301}", "\u{1f4a5}", "$(id)", "`id`", "'; rm -rf ~; echo '", "-oProxyCommand=x", "$HOME", "&&", "||", "..",
        ];
        let n = (self.next() % 9) as usize;
        (0..n).map(|_| PIECES[(self.next() % PIECES.len() as u64) as usize]).collect()
    }
}

/// Reads one POSIX shell word the way `sh` does for the forms we write: `'...'` (literal), `"$HOME"` (kept as `$HOME`)
/// and plain safe characters. Anything else unquoted (space, `;`, `$`, a backtick, ...) is an error: it would be a second
/// word or a command.
fn one_word(s: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => loop {
                match chars.next() {
                    Some('\'') => break,
                    Some(x) => out.push(x),
                    None => return Err("unterminated single quote".into()),
                }
            },
            '"' => {
                let mut inner = String::new();
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some(x) => inner.push(x),
                        None => return Err("unterminated double quote".into()),
                    }
                }
                if inner != "$HOME" {
                    return Err(format!("unexpected double quoted text {inner:?}"));
                }
                out.push_str("$HOME");
            }
            '\\' => match chars.next() {
                Some(x) => out.push(x),
                None => return Err("dangling backslash".into()),
            },
            c if c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-') => out.push(c),
            other => return Err(format!("unquoted {other:?}")),
        }
    }
    Ok(out)
}

/// The folder word out of `cd WORD 2>/dev/null || ...`.
fn folder_word(script: &str) -> &str {
    let rest = script.strip_prefix("cd ").expect("script starts with cd");
    &rest[..rest.find(" 2>/dev/null || echo ").expect("cd is followed by the redirect")]
}

#[test]
fn the_destination_always_follows_double_dash_and_options_are_only_ours() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut accepted = 0;
    for _ in 0..6000 {
        let user = rng.mixed();
        let host_text = rng.mixed();
        let key = rng.mixed();
        let port = (1 + rng.next() % 65000) as u16;
        let target = format!("{user}@{host_text}");
        let parsed = SshHost::parse("id1", "n", &target, Some(port), Some(&key));
        let Ok(h) = parsed else { continue };
        accepted += 1;
        assert!(valid_user(&h.user) && valid_host(&h.host), "{target:?}");
        for argv in [terminal_argv(&h, None, &Remote::Shell).unwrap(), check_argv(&h, &check::remote_command(&[]))] {
            let dd = argv.iter().position(|a| a == "--").expect("a -- is present");
            assert_eq!(argv.len(), dd + 3, "exactly the destination and one remote word follow --");
            assert_eq!(argv[dd + 1], format!("{}@{}", h.user, h.host));
            assert!(!argv[dd + 1].starts_with('-'));
            // Before `--`: fixed option words, the port, and the key path right after -i. Nothing else.
            let mut i = 0;
            while i < dd {
                let a = argv[i].as_str();
                match a {
                    "-t" | "-T" => {}
                    "-p" => {
                        assert_eq!(argv[i + 1], h.port.to_string());
                        i += 1;
                    }
                    "-i" => {
                        assert_eq!(Some(&argv[i + 1]), h.key_file.as_ref());
                        i += 1;
                    }
                    "-o" => {
                        assert!(
                            ["StrictHostKeyChecking=ask", "StrictHostKeyChecking=yes", "ServerAliveInterval=30", "ForwardAgent=no", "ForwardX11=no", "BatchMode=yes", "ConnectTimeout=8", "NumberOfPasswordPrompts=0"]
                                .contains(&argv[i + 1].as_str()),
                            "unknown option {:?}",
                            argv[i + 1]
                        );
                        i += 1;
                    }
                    other => panic!("unexpected argument before --: {other:?}"),
                }
                i += 1;
            }
        }
    }
    assert!(accepted > 20, "the generator reached accepted inputs ({accepted})");
}

#[test]
fn hostile_names_are_refused_by_the_obvious_cases() {
    for bad in ["-oProxyCommand=evil@host", "a b@host", "dev@host;rm", "dev@-host", "dev@ho st", "dev@$(id)", "dev@`id`", "dev@ho\nst", "@host", "dev@", "dev", "d'ev@host", "dev@host'", "dev@ho/st"] {
        assert!(SshHost::parse("i", "n", bad, None, None).is_err(), "{bad:?} must be refused");
    }
    assert!(SshHost::parse("i", "n", "dev@host", Some(0), None).is_err(), "port 0");
    assert!(SshHost::parse("i", "n", "dev@host", None, Some("-oProxyCommand=x")).is_err(), "key path that looks like an option");
    assert!(SshHost::parse("i", "n", "dev@host", None, Some("a\nb")).is_err());
    assert!(SshHost::parse("i", "n", "dev@2001:db8::1", None, None).is_ok(), "an IPv6 address");
    assert!(SshHost::parse("i", "n", "dev@192.168.1.20", Some(22), None).is_ok());
}

#[test]
fn a_folder_is_quoted_into_exactly_one_word_or_refused() {
    let mut rng = Rng(0xDEAD_BEEF_1234_5678);
    let mut ok = 0;
    for _ in 0..8000 {
        let mut folder = rng.hostile();
        if rng.next() % 2 == 0 {
            folder = format!("/{folder}");
        } else if rng.next() % 3 == 0 {
            folder = format!("~/{folder}");
        }
        match quote_folder(&folder) {
            Err(_) => {
                assert!(!valid_folder(&folder));
            }
            Ok(word) => {
                ok += 1;
                let read = one_word(&word).unwrap_or_else(|e| panic!("{folder:?} -> {word:?}: {e}"));
                let want = match folder.strip_prefix('~') {
                    Some("/") => "$HOME".to_string(),
                    Some(rest) => format!("$HOME{rest}"),
                    None => folder.clone(),
                };
                assert_eq!(read, want, "quoting {folder:?}");
                let script = remote_script(Some(&folder), &Remote::Shell).unwrap();
                assert_eq!(one_word(folder_word(&script)).unwrap(), want);
            }
        }
    }
    assert!(ok > 200, "the generator reached accepted folders ({ok})");
    // The named hostile folders.
    for f in ["/tmp/a'; rm -rf ~; echo '", "/x$(id)", "/x`id`", "/a b/c", "/a\\b", "~/a;b", "/it's"] {
        let word = quote_folder(f).unwrap();
        assert!(one_word(&word).is_ok(), "{f:?} -> {word:?}");
    }
    assert!(quote_folder("relative/dir").is_err());
    assert!(quote_folder("/a\nb").is_err());
    assert!(quote_folder("").is_err());
}

#[test]
fn a_program_is_a_bare_name_or_refused() {
    for ok in ["claude", "codex", "opencode", "node", "g++", "a.b-c_d"] {
        assert!(remote_script(None, &Remote::Program(ok.into())).is_ok(), "{ok}");
    }
    for bad in ["", "-x", "a b", "a;b", "$(id)", "`id`", "a/b", "a'b", "a\nb", "../x", &"a".repeat(65)] {
        assert!(remote_script(None, &Remote::Program(bad.into())).is_err(), "{bad:?}");
    }
    assert_eq!(remote_script(None, &Remote::Program("claude".into())).unwrap(), "exec /bin/sh -lc 'exec claude'");
}

#[test]
fn host_key_checking_is_never_turned_off() {
    let h = host();
    let mut all = terminal_argv(&h, Some("/srv/app"), &Remote::Shell).unwrap();
    all.extend(check_argv(&h, &check::remote_command(&["claude".into()])));
    let joined = all.join(" ").to_ascii_lowercase();
    assert!(!joined.contains("stricthostkeychecking=no"), "{joined}");
    assert!(!joined.contains("stricthostkeychecking=off"));
    assert!(!joined.contains("accept-new"));
    assert!(!joined.contains("userknownhostsfile"), "the known hosts file is never redirected");
    assert!(terminal_argv(&h, None, &Remote::Shell).unwrap().contains(&"StrictHostKeyChecking=ask".to_string()));
    assert!(check_argv(&h, "x").contains(&"StrictHostKeyChecking=yes".to_string()));
    // A check can never ask for a password.
    assert!(check_argv(&h, "x").contains(&"BatchMode=yes".to_string()));
}

#[test]
fn the_key_file_is_passed_by_path_and_never_read() {
    // A path that does not exist builds the same argument list: nothing opens it.
    let h = SshHost::parse("i", "n", "dev@host", None, Some("Z:/definitely/not/here/id_rsa")).unwrap();
    let argv = terminal_argv(&h, None, &Remote::Shell).unwrap();
    let i = argv.iter().position(|a| a == "-i").unwrap();
    assert_eq!(argv[i + 1], "Z:/definitely/not/here/id_rsa");
    // And it is stored as a path only.
    let dir = scratch("key-path");
    let store = Store::at(&dir);
    store.add(Saved { host: h, os: None, found: vec![], checked_at: None }).unwrap();
    let text = std::fs::read_to_string(dir.join(super::store::FILE_NAME)).unwrap();
    assert!(text.contains("Z:/definitely/not/here/id_rsa"));
    assert!(!text.to_ascii_lowercase().contains("password"));
}

#[test]
fn states_are_told_apart_from_what_ssh_prints() {
    assert_eq!(classify(true, false, ""), SshState::Ok);
    assert_eq!(classify(false, false, "ssh: Could not resolve hostname nope: Name or service not known"), SshState::CannotReach);
    assert_eq!(classify(false, false, "ssh: connect to host 10.0.0.9 port 22: Connection refused"), SshState::CannotReach);
    assert_eq!(classify(false, true, ""), SshState::CannotReach);
    assert_eq!(classify(false, false, "dev@h: Permission denied (publickey,password)."), SshState::WrongKey);
    assert_eq!(
        classify(false, false, "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."),
        SshState::HostKeyChanged,
        "a changed key is never read as a new one"
    );
    assert_eq!(classify(false, false, "No ED25519 host key is known for h and you have requested strict checking.\nHost key verification failed."), SshState::HostKeyUnknown);
    match classify(false, false, "weird\u{7} thing\nsecond line") {
        SshState::Other { line } => assert_eq!(line, "weird thing"),
        other => panic!("{other:?}"),
    }
    assert!(SshState::WrongKey.sentence().contains("Wrong key or password"));
}

#[test]
fn the_check_script_is_fixed_and_read_only() {
    let s = check::script(&["claude".into(), "codex".into(), "bad name".into(), "$(id)".into(), "claude".into()]);
    assert_eq!(s, "echo \"os=$(uname -s 2>/dev/null)\"; for p in git node claude codex; do if command -v \"$p\" >/dev/null 2>&1; then echo \"has=$p\"; fi; done");
    assert!(!s.contains('\''), "no single quote can end the outer word");
    for forbidden in ["rm ", "curl", "wget", "apt", "npm", "sudo", ">>", " > /", "mkdir", "chmod", "tee"] {
        assert!(!s.contains(forbidden), "{forbidden}");
    }
    assert!(check::remote_command(&[]).starts_with("/bin/sh -lc '") && check::remote_command(&[]).ends_with('\''));
}

#[test]
fn the_check_output_lists_only_what_was_asked() {
    let facts = check::parse("os=Linux\nhas=git\nhas=claude\nhas=evil\nnoise\nhas=git\nos=\n", &["claude".into(), "codex".into()]);
    assert_eq!(facts.os.as_deref(), Some("Linux"));
    assert_eq!(facts.found, vec!["git".to_string(), "claude".to_string()]);
    assert_eq!(check::parse("os=Dar$(win)\n", &[]).os.as_deref(), Some("Darwin"), "characters outside a plain name are dropped");
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-ssh-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sh_available() -> bool {
    std::process::Command::new("sh").arg("-c").arg("exit 0").status().map(|s| s.success()).unwrap_or(false)
}

/// A fake `ssh`: records its arguments, and answers by the host name in them.
fn shim(dir: &std::path::Path) -> LiveRunner {
    let script = dir.join("ssh-shim.sh");
    let argv_file = dir.join("argv.txt").to_string_lossy().replace('\\', "/");
    std::fs::write(
        &script,
        format!(
            "printf '%s\\n' \"$@\" > '{argv_file}'\ncase \"$*\" in\n\
             *wrongkey.test*) echo 'dev@wrongkey.test: Permission denied (publickey).' >&2; exit 255;;\n\
             *changed.test*) echo '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@' >&2; exit 255;;\n\
             *down.test*) echo 'ssh: connect to host down.test port 22: Connection timed out' >&2; exit 255;;\n\
             *) echo os=Linux; echo has=git; echo has=claude; echo has=evil; exit 0;;\nesac\n"
        ),
    )
    .unwrap();
    LiveRunner { exe: PathBuf::from("sh"), pre: vec![script.to_string_lossy().replace('\\', "/")] }
}

#[test]
fn a_check_through_a_fake_ssh_lists_what_is_there() {
    if !sh_available() {
        eprintln!("skipped: no sh on this machine");
        return;
    }
    let dir = scratch("shim-ok");
    let runner = shim(&dir);
    let h = host();
    let result = run::check(&runner, &h, &["claude".into(), "codex".into()]);
    assert_eq!(result.state, SshState::Ok);
    assert_eq!(result.facts.os.as_deref(), Some("Linux"));
    assert_eq!(result.facts.found, vec!["git".to_string(), "claude".to_string()], "a program the shim invented is dropped");
    // The fake saw the exact argument list, with the destination after `--`.
    let seen = std::fs::read_to_string(dir.join("argv.txt")).unwrap();
    let lines: Vec<&str> = seen.lines().collect();
    let dd = lines.iter().position(|l| *l == "--").unwrap();
    assert_eq!(lines[dd + 1], "dev@build.local");
    assert!(lines.contains(&"BatchMode=yes") && lines.contains(&"StrictHostKeyChecking=yes"));
}

#[test]
fn each_failure_through_the_fake_ssh_is_its_own_state() {
    if !sh_available() {
        eprintln!("skipped: no sh on this machine");
        return;
    }
    let dir = scratch("shim-bad");
    let runner = shim(&dir);
    let state = |target: &str| run::check(&runner, &SshHost::parse("i", "n", target, None, None).unwrap(), &[]).state;
    assert_eq!(state("dev@wrongkey.test"), SshState::WrongKey);
    assert_eq!(state("dev@changed.test"), SshState::HostKeyChanged);
    assert_eq!(state("dev@down.test"), SshState::CannotReach);
}

#[test]
fn a_missing_ssh_is_found_or_reported_never_guessed() {
    let dir = scratch("path");
    let name = if cfg!(windows) { "ssh.exe" } else { "ssh" };
    std::fs::write(dir.join(name), b"").unwrap();
    let found = run::ssh_exe_in(Some(dir.as_os_str())).expect("the file on PATH is found");
    assert_eq!(found, dir.join(name));
    let empty = scratch("path-empty");
    if !cfg!(windows) {
        assert_eq!(run::ssh_exe_in(Some(empty.as_os_str())), None);
    }
}

#[test]
fn saved_places_round_trip_and_a_bad_entry_is_dropped() {
    let dir = scratch("store");
    let store = Store::at(&dir);
    store.add(Saved { host: host(), os: None, found: vec![], checked_at: None }).unwrap();
    assert_eq!(store.list().len(), 1);
    store.set_check("h1", &check::Facts { os: Some("Linux".into()), found: vec!["git".into()] }, 42).unwrap();
    let got = store.get("h1").unwrap();
    assert_eq!((got.os.as_deref(), got.found.clone(), got.checked_at), (Some("Linux"), vec!["git".to_string()], Some(42)));
    // A hand-edited file with a hostile host is ignored.
    std::fs::write(
        dir.join(super::store::FILE_NAME),
        r#"{"version":1,"hosts":[{"id":"x","name":"n","user":"a","host":"h;rm","port":22},{"id":"y","name":"n","user":"a","host":"ok.local","port":22}]}"#,
    )
    .unwrap();
    let ids: Vec<String> = store.list().into_iter().map(|s| s.host.id).collect();
    assert_eq!(ids, vec!["y".to_string()]);
    assert!(store.remove("y").unwrap());
    assert!(!store.remove("y").unwrap());
}

#[test]
fn a_launch_applies_to_one_spawn_and_makes_an_ssh_place() {
    let launch = SshLaunch { exe: PathBuf::from("ssh"), argv: vec!["-t".into()], name: "Build box".into(), folder: Some("/srv".into()) };
    once::request("pane-ssh-1", launch.clone());
    assert_eq!(once::take("pane-ssh-1"), Some(launch.clone()));
    assert_eq!(once::take("pane-ssh-1"), None, "it applies to one spawn only");
    let place = once::pane_place(&launch);
    assert_eq!((place.kind.as_str(), place.distro.as_str(), place.cwd.as_str()), ("ssh", "Build box", "/srv"));
}
