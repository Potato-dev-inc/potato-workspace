//! Tests of the read-only file and git reads. No real SSH host: a fake runner, or the fixed script run by a local `sh` on a temp folder.

use super::*;
use crate::ssh::acp::decode;
use std::sync::atomic::{AtomicUsize, Ordering};

fn host() -> SshHost {
    SshHost::parse("h1", "Build box", "dev@build.local", Some(2222), Some("C:/keys/id_ed25519")).unwrap()
}

const HOSTILE: &[&str] = &[
    "plain",
    "with space",
    "it's",
    "say \"hi\"",
    "$(touch tmp-pwned)",
    "`touch tmp-pwned`",
    "a;b|c&d>e<f",
    "-rf",
    "--help",
    "-oProxyCommand=x",
    "caf\u{e9} \u{65e5}\u{672c}\u{8a9e} \u{1f600}",
    "100%s %n",
    "$HOME",
    "{a,b}",
    "!hist",
    "back\\slash",
    "~tilde",
    "x101",
];

/// A name this OS can make as a file (Windows refuses `<>:"|?*` and the backslash is a separator there).
fn creatable(name: &str) -> bool {
    !cfg!(windows) || !name.contains(['<', '>', ':', '"', '|', '?', '*', '\\'])
}

// ---- the script -------------------------------------------------------------------------------------------------------------------

#[test]
fn the_far_script_is_one_single_quoted_word() {
    assert!(!BROWSE_SCRIPT.contains('\''), "a single quote would end the quoted word");
    assert!(!BROWSE_SCRIPT.contains('!'), "csh history");
    assert!(!BROWSE_SCRIPT.contains('\n') && !BROWSE_SCRIPT.contains('\0') && !BROWSE_SCRIPT.contains('\r'));
    assert!(BROWSE_SCRIPT.is_ascii());
    // `[^x]` is a plain set in dash and `[!x]` needs a `!`: the script uses neither.
    assert!(!BROWSE_SCRIPT.contains("[^") && !BROWSE_SCRIPT.contains("[!"));
}

#[test]
fn the_far_script_only_reads() {
    // A word that writes, deletes, moves, stages or commits would be a different feature. The script names none of them.
    for bad in [" rm ", " mv ", " cp ", "mkdir", "touch", "chmod", "chown", " tee ", "git add", "git commit", "git checkout", "git reset", "git stash", "git clean", "git push", "git fetch", "git pull", "git merge", ">>", "> \"", "> /"] {
        assert!(!BROWSE_SCRIPT.contains(bad), "the script contains {bad:?}");
    }
    // The one place a `>` is used is to drop an error message into the bit bucket.
    for part in BROWSE_SCRIPT.split('>').skip(1) {
        assert!(part.starts_with("/dev/null") || part.starts_with("&1"), "unexpected redirect target near {part:.20?}");
    }
    assert!(BROWSE_SCRIPT.contains("GIT_OPTIONAL_LOCKS=0") && BROWSE_SCRIPT.contains("core.fsmonitor=false"));
}

#[test]
fn the_command_line_carries_the_ops_and_data_as_x_and_octal_only() {
    for name in HOSTILE {
        let argv = browse_argv(&host(), Op::Read, "/srv/it's an app", &format!("sub dir/{name}")).unwrap();
        let line = argv.last().unwrap();
        let tail = line.split_once(&format!("{BROWSE_SCRIPT}' sh ")).expect("script then words").1;
        let words: Vec<&str> = tail.split(' ').collect();
        assert_eq!(words.len(), 3, "{tail}");
        assert_eq!(words[0], "cat");
        for w in &words[1..] {
            assert!(w.starts_with('x') && w[1..].bytes().all(|b| (b'0'..=b'7').contains(&b)), "{w}");
        }
        assert_eq!(decode(words[1]).unwrap(), "/srv/it's an app");
        assert_eq!(decode(words[2]).unwrap(), format!("sub dir/{name}"));
        // The hostile text itself appears nowhere in the command line.
        let outside = line.replace(BROWSE_SCRIPT, "");
        if name.len() > 4 {
            assert!(!outside.contains(name), "{name} leaked into the command line");
        }
    }
}

#[test]
fn the_ssh_options_are_the_hardened_ones_and_no_sharing() {
    let argv = browse_argv(&host(), Op::List, "/srv/app", "").unwrap();
    let all = argv.join(" ");
    for need in ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10", "ForwardAgent=no", "ClearAllForwardings=yes", "ControlPath=none", "RequestTTY=no", "NumberOfPasswordPrompts=0"] {
        assert!(all.contains(need), "{need} missing: {all}");
    }
    assert!(!all.contains("ControlMaster") && !all.contains("ControlPersist"));
    let dash = argv.iter().position(|a| a == "--").unwrap();
    assert_eq!(argv[dash + 1], "dev@build.local");
    assert_eq!(argv.len(), dash + 3, "exactly one remote command after the destination");
}

#[test]
fn a_bad_folder_or_path_is_refused_before_ssh() {
    for folder in ["relative", "", "/x\ny", "/x\0y", "/a\tb"] {
        assert_eq!(browse_argv(&host(), Op::List, folder, "").unwrap_err(), BrowseError::BadFolder, "{folder:?}");
    }
    assert_eq!(browse_argv(&host(), Op::Read, "/srv/app", "").unwrap_err(), BrowseError::BadPath, "a file read needs a file");
    assert!(browse_argv(&host(), Op::List, "~", "src").is_ok());
    assert!(browse_argv(&host(), Op::List, "~/work", "").is_ok());
}

// ---- the relative path ------------------------------------------------------------------------------------------------------------

#[test]
fn a_relative_path_stays_inside_or_is_refused() {
    for ok in ["", ".", "./", "a", "a/b", "a//b", "./a/./b/", "sp ace/it's", "-lead/--x", "$(id)/`id`", "caf\u{e9}/\u{65e5}", "a..b", "..a", "a..", "...", "x/.hidden"] {
        assert!(normalize_rel(ok).is_ok(), "{ok:?}");
    }
    for bad in ["/", "/etc/passwd", "..", "../x", "a/../b", "a/..", "a/b/../../..", "a\nb", "a\tb", "a\0b", "a\rb", "\u{1b}[31m", "a\u{202e}b", "./../x"] {
        assert_eq!(normalize_rel(bad), Err(BrowseError::BadPath), "{bad:?}");
    }
    assert_eq!(normalize_rel("./a//b/./c/").unwrap(), "a/b/c");
    assert_eq!(normalize_rel(".").unwrap(), "");
    assert_eq!(normalize_rel("-x").unwrap(), "-x");
    assert!(normalize_rel(&"a/".repeat(MAX_DEPTH + 1)).is_err());
    assert!(normalize_rel(&"a".repeat(MAX_REL + 1)).is_err());
    assert!(normalize_rel(&"a".repeat(MAX_REL)).is_ok());
}

// ---- parsing ----------------------------------------------------------------------------------------------------------------------

fn framed_out(body: &str) -> String {
    format!("Last login: Mon\n\u{1b}[1mwelcome\u{1b}[0m\n{BEGIN}\n{body}")
}

#[test]
fn a_listing_is_read_sorted_and_bounded() {
    let out = framed_out("ok\nf zeta.txt\nd src\nl link\nf Alpha\nd .git\no sock\nf with space\nskipped 2\n");
    let l = parse_list(&out, "").unwrap();
    let names: Vec<(&str, &str)> = l.entries.iter().map(|e| (e.kind, e.name.as_str())).collect();
    assert_eq!(names, vec![("dir", ".git"), ("dir", "src"), ("file", "Alpha"), ("link", "link"), ("other", "sock"), ("file", "with space"), ("file", "zeta.txt")]);
    assert_eq!(l.skipped, 2);
    assert!(!l.more);
    // Names with a control character or bad text are left out and counted; the rest still shows.
    let l = parse_list(&framed_out("ok\nf a\u{1b}[2Jb\nf bad\u{fffd}\nf fine\nf ok\u{202e}x\nf \nskipped 0\n"), "").unwrap();
    assert_eq!(l.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["fine"]);
    assert_eq!(l.skipped, 4);
    // More than the cap: kept to the cap, `more` set.
    let many: String = (0..MAX_ENTRIES + 25).map(|i| format!("f n{i}\n")).collect();
    let l = parse_list(&framed_out(&format!("ok\n{many}skipped 0\n")), "").unwrap();
    assert_eq!(l.entries.len(), MAX_ENTRIES);
    assert!(l.more);
    // The far script's own cap marker.
    assert!(parse_list(&framed_out("ok\nf a\nmore\nskipped 0\n"), "").unwrap().more);
}

#[test]
fn text_before_the_begin_line_is_ignored_and_a_missing_begin_is_no_answer() {
    assert!(parse_list(&framed_out("ok\nf a\nskipped 0\n"), "x").is_ok());
    assert_eq!(parse_list("ok\nf a\n", ""), Err(BrowseError::NoAnswer));
    assert_eq!(parse_list(&framed_out("garbage\n"), ""), Err(BrowseError::NoAnswer));
    // A profile that prints a line that LOOKS like an entry before the begin line is not an entry.
    let l = parse_list(&format!("f sneaky\n{BEGIN}\nok\nf real\nskipped 0\n"), "").unwrap();
    assert_eq!(l.entries.len(), 1);
}

#[test]
fn every_refusal_word_has_a_plain_sentence_that_copies_no_far_text() {
    for (word, err) in [
        ("nofolder", BrowseError::NoFolder),
        ("notdir", BrowseError::NotFolder),
        ("notfile", BrowseError::NotFile),
        ("escape", BrowseError::Escape),
        ("link", BrowseError::Link),
        ("big", BrowseError::TooBig),
        ("unreadable", BrowseError::Unreadable),
        ("nogit", BrowseError::NoGit),
        ("notrepo", BrowseError::NotRepo),
    ] {
        assert_eq!(parse_list(&framed_out(&format!("err {word}\n")), ""), Err(err.clone()), "{word}");
        let s = err.sentence("Build box");
        assert!(!s.is_empty() && !s.contains("err "), "{s}");
    }
    assert_eq!(parse_list(&framed_out("err ../../etc\n"), ""), Err(BrowseError::NoAnswer));
}

#[test]
fn a_file_is_text_only_and_made_safe() {
    let body = "line one\r\n\u{1b}[31mred\u{1b}[0m\u{7}\ttab\u{202e}\n";
    let out = framed_out(&format!("ok\nsize {}\n{body}", body.len()));
    let f = parse_read(&out, "src/a.txt").unwrap();
    assert_eq!(f.text, "line one\n[31mred[0m\ttab\n");
    assert!(!f.text.contains('\u{1b}') && !f.text.contains('\u{7}') && !f.text.contains('\r') && !f.text.contains('\u{202e}'));
    assert_eq!(f.path, "src/a.txt");
    assert_eq!(parse_read(&framed_out("ok\nsize 4\na\0b\n"), "x"), Err(BrowseError::Binary));
    assert_eq!(parse_read(&framed_out("ok\nsize 4\na\u{fffd}b\n"), "x"), Err(BrowseError::Binary));
    assert_eq!(parse_read(&framed_out("ok\nsize 9999999\nabc\n"), "x"), Err(BrowseError::TooBig));
    assert_eq!(parse_read(&framed_out(&format!("ok\nsize 10\n{}", "a".repeat(MAX_FILE + 1))), "x"), Err(BrowseError::TooBig));
    assert_eq!(parse_read(&framed_out("ok\nnonsense\nabc\n"), "x"), Err(BrowseError::NoAnswer));
    assert_eq!(parse_read(&framed_out("ok\nsize 0\n"), "x").unwrap().text, "");
    assert_eq!(parse_read(&framed_out("err link\n"), "x"), Err(BrowseError::Link));
}

fn z(records: &[&str]) -> String {
    records.iter().map(|r| format!("{r}\0")).collect()
}

#[test]
fn git_status_is_read_with_branch_changes_and_renames() {
    let out = framed_out(&format!("ok\nprefix \n{}", z(&["## main...origin/main [ahead 1, behind 2]", " M src/a.rs", "M  b.rs", "A  new file.txt", "R  new.rs", "old.rs", "?? untracked/", "!! ignored", " D gone", "UU conflict", "MM both", "?? sp ace"])));
    let s = parse_status(&out).unwrap();
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!((s.ahead, s.behind, s.gone), (1, 2, false));
    assert!(!s.detached && !s.unborn && !s.more);
    let got: Vec<(&str, &str, bool)> = s.changes.iter().map(|c| (c.path.as_str(), c.kind, c.staged)).collect();
    assert_eq!(
        got,
        vec![
            ("src/a.rs", "modified", false),
            ("b.rs", "modified", true),
            ("new file.txt", "added", true),
            ("new.rs", "renamed", true),
            ("untracked/", "new", false),
            ("gone", "deleted", false),
            ("conflict", "conflict", true),
            ("both", "modified", true),
            ("sp ace", "new", false)
        ],
        "the old name of a rename is not an entry, an ignored file is not shown"
    );
}

#[test]
fn git_status_branch_forms() {
    let one = |h: &str| parse_status(&framed_out(&format!("ok\nprefix \n{}", z(&[h])))).unwrap();
    let s = one("## No commits yet on trunk");
    assert_eq!((s.branch.as_deref(), s.unborn, s.detached), (Some("trunk"), true, false));
    let s = one("## HEAD (no branch)");
    assert_eq!((s.branch, s.detached), (None, true));
    let s = one("## feature/x");
    assert_eq!((s.branch.as_deref(), s.ahead, s.behind, s.gone), (Some("feature/x"), 0, 0, false));
    let s = one("## dev...origin/dev [ahead 3]");
    assert_eq!((s.branch.as_deref(), s.ahead, s.behind), (Some("dev"), 3, 0));
    let s = one("## dev...origin/dev [gone]");
    assert!(s.gone);
    // Only numbers are taken from the bracket: its other text is never shown.
    let s = one("## dev...origin/dev [ahead 1x, behind \u{1b}[2J]");
    assert_eq!((s.ahead, s.behind, s.gone), (0, 0, false));
    let s = one("## evil\u{1b}[2J\u{202e}name");
    assert_eq!(s.branch.as_deref(), Some("evil[2Jname"));
    assert_eq!(parse_status(&framed_out("ok\nprefix \nnot a header\0")), Err(BrowseError::NoAnswer));
    assert_eq!(parse_status(&framed_out("err notrepo\n")), Err(BrowseError::NotRepo));
    assert_eq!(parse_status(&framed_out("err nogit\n")), Err(BrowseError::NoGit));
}

#[test]
fn git_status_in_a_sub_folder_shows_paths_below_the_project_folder() {
    let s = parse_status(&framed_out(&format!("ok\nprefix web/app/\n{}", z(&["## main", " M web/app/src/x.ts", "?? web/app/y"])))).unwrap();
    assert_eq!(s.changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["src/x.ts", "y"]);
}

#[test]
fn git_status_names_with_newlines_and_escapes_cannot_break_the_list_or_the_screen() {
    let s = parse_status(&framed_out(&format!("ok\nprefix \n{}", z(&["## main", "?? a\nb", "?? \u{1b}[31mred", " M tab\there"])))).unwrap();
    assert_eq!(s.changes.len(), 3);
    for c in &s.changes {
        assert!(!c.path.contains('\n') && !c.path.contains('\t') && !c.path.contains('\u{1b}'), "{:?}", c.path);
    }
}

#[test]
fn git_status_is_cut_at_the_cap() {
    let recs: Vec<String> = (0..MAX_ENTRIES + 10).map(|i| format!("?? f{i}")).collect();
    let mut all = vec!["## main".to_string()];
    all.extend(recs);
    let refs: Vec<&str> = all.iter().map(String::as_str).collect();
    let s = parse_status(&framed_out(&format!("ok\nprefix \n{}", z(&refs)))).unwrap();
    assert_eq!(s.changes.len(), MAX_ENTRIES);
    assert!(s.more);
}

// ---- the call: gate, errors, no write ---------------------------------------------------------------------------------------------

struct Fake {
    answer: Result<Output, String>,
    seen: Mutex<Vec<Vec<String>>>,
    caps: Mutex<Vec<usize>>,
}

impl Fake {
    fn new(answer: Result<Output, String>) -> Self {
        Self { answer, seen: Mutex::new(vec![]), caps: Mutex::new(vec![]) }
    }
}

impl Runner for Fake {
    fn run(&self, argv: &[String], _d: Duration) -> Result<Output, String> {
        self.seen.lock().unwrap().push(argv.to_vec());
        self.answer.clone()
    }
    fn run_capped(&self, argv: &[String], d: Duration, cap: usize) -> Result<Output, String> {
        self.caps.lock().unwrap().push(cap);
        self.run(argv, d)
    }
}

fn ok_out(stdout: &str) -> Output {
    Output { ok: true, timed_out: false, stdout: stdout.into(), stderr: String::new() }
}

#[test]
fn far_list_read_and_status_run_one_ssh_each_with_the_capped_runner() {
    let fake = Fake::new(Ok(ok_out(&framed_out("ok\nf a\nskipped 0\n"))));
    let h = host();
    let far = Far::new(&fake, &h, "/srv/app");
    assert_eq!(far.list("./src/").unwrap().path, "src");
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
    assert!(fake.caps.lock().unwrap()[0] >= MAX_FILE);
    let words_of = |i: usize| -> Vec<String> { fake.seen.lock().unwrap()[i].last().unwrap().rsplit(' ').take(3).map(String::from).collect() };
    assert_eq!(words_of(0)[2], "ls");
    assert_eq!(decode(&words_of(0)[0]).unwrap(), "src");
}

#[test]
fn a_bad_path_never_reaches_ssh() {
    let fake = Fake::new(Ok(ok_out("")));
    let h = host();
    let far = Far::new(&fake, &h, "/srv/app");
    assert_eq!(far.list("../etc").unwrap_err(), BrowseError::BadPath);
    assert_eq!(far.read("/etc/passwd").unwrap_err(), BrowseError::BadPath);
    assert_eq!(far.read("").unwrap_err(), BrowseError::BadPath);
    assert_eq!(far.read("a\nb").unwrap_err(), BrowseError::BadPath);
    assert!(fake.seen.lock().unwrap().is_empty());
}

#[test]
fn an_ssh_refusal_becomes_a_plain_sentence() {
    let h = host();
    let run = |ok, timed_out, err: &str| {
        let fake = Fake::new(Ok(Output { ok, timed_out, stdout: String::new(), stderr: err.into() }));
        Far::new(&fake, &h, "/srv/app").status().unwrap_err()
    };
    assert_eq!(run(false, false, "Host key verification failed."), BrowseError::HostKeyUnknown);
    assert_eq!(run(false, false, "ssh: connect to host build.local port 22: Connection refused"), BrowseError::CannotReach);
    assert_eq!(run(false, false, "dev@build.local: Permission denied (publickey)."), BrowseError::WrongKey);
    assert_eq!(run(false, true, ""), BrowseError::TimedOut);
    assert_eq!(run(false, false, "something odd"), BrowseError::Other);
    assert!(BrowseError::WrongKey.sentence("Build box").contains("Build box"));
    let fake = Fake::new(Err("ssh did not start: nope".into()));
    assert_eq!(Far::new(&fake, &h, "/srv/app").status().unwrap_err(), BrowseError::Other);
}

#[test]
fn only_two_calls_run_at_a_time_per_machine() {
    let gate = Gate::default();
    let a = gate.enter("h1", 2, Duration::from_millis(10)).unwrap();
    let _b = gate.enter("h1", 2, Duration::from_millis(10)).unwrap();
    assert_eq!(gate.in_use("h1"), 2);
    assert!(gate.enter("h1", 2, Duration::from_millis(30)).is_none(), "a third waits, then gives up");
    assert!(gate.enter("h2", 2, Duration::from_millis(10)).is_some(), "another machine has its own places");
    drop(a);
    assert!(gate.enter("h1", 2, Duration::from_millis(10)).is_some(), "a place is free again");
    // A waiter gets in when one ends.
    let gate2 = gate.clone();
    let p = gate.enter("h9", 1, Duration::from_millis(10)).unwrap();
    let t = std::thread::spawn(move || gate2.enter("h9", 1, Duration::from_secs(5)).is_some());
    std::thread::sleep(Duration::from_millis(50));
    drop(p);
    assert!(t.join().unwrap());
}

#[test]
fn many_parallel_calls_never_run_more_than_two_at_once() {
    struct Slow {
        now: AtomicUsize,
        peak: AtomicUsize,
    }
    impl Runner for Slow {
        fn run(&self, _a: &[String], _d: Duration) -> Result<Output, String> {
            let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(40));
            self.now.fetch_sub(1, Ordering::SeqCst);
            Ok(ok_out(&framed_out("ok\nskipped 0\n")))
        }
    }
    let slow = Arc::new(Slow { now: AtomicUsize::new(0), peak: AtomicUsize::new(0) });
    let gate = Gate::default();
    let h = host();
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| {
                let far = Far { runner: &*slow, host: &h, folder: "/srv/app", gate: &gate };
                far.list("").unwrap();
            });
        }
    });
    assert!(slow.peak.load(Ordering::SeqCst) <= PER_HOST, "peak {}", slow.peak.load(Ordering::SeqCst));
}

#[test]
fn answers_are_remembered_for_a_moment_only() {
    let r = Remember::new(Duration::from_millis(60), 2);
    r.put("a".into(), serde_json::json!(1));
    assert_eq!(r.get("a"), Some(serde_json::json!(1)));
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(r.get("a"), None);
    r.put("a".into(), serde_json::json!(1));
    r.put("b".into(), serde_json::json!(2));
    r.put("c".into(), serde_json::json!(3));
    assert!(r.items.lock().unwrap().len() <= 2, "bounded");
}

// ---- the real script, run by a local sh on a temp folder --------------------------------------------------------------------------

fn local_sh() -> Option<std::path::PathBuf> {
    let candidates = ["/bin/sh", "C:\\Program Files\\Git\\usr\\bin\\sh.exe", "C:\\Program Files\\Git\\bin\\sh.exe"];
    candidates.iter().map(std::path::PathBuf::from).find(|p| p.is_file())
}

/// `C:\a\b` is `/c/a/b` for the MSYS shell; a unix path stays.
fn far_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    match s.split_once(":/") {
        Some((drive, rest)) if drive.len() == 1 => format!("/{}/{rest}", drive.to_ascii_lowercase()),
        _ => s,
    }
}

/// Runs the remote command line (the last argument) in a local `sh`, the way the far login shell would split it.
struct LocalSh(std::path::PathBuf);

impl Runner for LocalSh {
    fn run(&self, argv: &[String], _d: Duration) -> Result<Output, String> {
        let line = argv.last().unwrap();
        let out = crate::proc_util::hidden_command(&self.0).arg("-c").arg(line).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
        Ok(Output { ok: out.status.success(), timed_out: false, stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
    }
}

fn temp_project(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pm-browse-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn the_real_script_lists_reads_and_refuses_with_hostile_names() {
    let Some(sh) = local_sh() else { return };
    let proj = temp_project("fs");
    for name in HOSTILE.iter().filter(|n| creatable(n)) {
        std::fs::write(proj.join(name), format!("content of {name}\n")).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
    std::fs::create_dir_all(proj.join("sub dir").join("it's")).unwrap();
    std::fs::write(proj.join(".hidden"), "h
").unwrap();
    std::fs::write(proj.join("..two"), "t
").unwrap();
    std::fs::write(proj.join("sub dir").join("it's").join("deep.txt"), "deep\n").unwrap();
    std::fs::write(proj.join("bin.dat"), [0u8, 159, 146, 150, 0]).unwrap();
    std::fs::write(proj.join("big.txt"), vec![b'a'; MAX_FILE + 1]).unwrap();
    std::fs::write(proj.join("edge.txt"), vec![b'b'; MAX_FILE]).unwrap();
    let outside = temp_project("fs-outside");
    std::fs::write(outside.join("secret.txt"), "SECRET\n").unwrap();
    let evil_sibling = std::path::PathBuf::from(format!("{}-evil", proj.display()));
    std::fs::create_dir_all(&evil_sibling).unwrap();
    std::fs::write(evil_sibling.join("secret.txt"), "SIBLING SECRET\n").unwrap();

    let h = host();
    let folder = far_path(&proj);
    let runner = LocalSh(sh);
    let far = Far::new(&runner, &h, &folder);
    let gate = Gate::default();
    let far = Far { gate: &gate, ..far };

    let l = far.list("").expect("list the project");
    for name in HOSTILE.iter().filter(|n| creatable(n)) {
        assert!(l.entries.iter().any(|e| e.name == *name && e.kind == "file"), "{name} missing from {:?}", l.entries.iter().map(|e| &e.name).collect::<Vec<_>>());
    }
    assert!(l.entries.iter().any(|e| e.name == "sub dir" && e.kind == "dir"));
    assert!(l.entries.iter().any(|e| e.name == ".hidden" && e.kind == "file") && l.entries.iter().any(|e| e.name == "..two"), "hidden names are listed");
    assert!(l.entries.iter().all(|e| e.name != "." && e.name != ".."));
    let sub = far.list("sub dir/it's").unwrap();
    assert_eq!(sub.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["deep.txt"]);
    assert_eq!(far.list("./sub dir//it's/").unwrap().path, "sub dir/it's");

    for name in HOSTILE.iter().filter(|n| creatable(n)) {
        let f = far.read(name).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(f.text, format!("content of {name}\n"), "{name}");
    }
    assert_eq!(far.read("sub dir/it's/deep.txt").unwrap().text, "deep\n");
    assert_eq!(far.read("bin.dat").unwrap_err(), BrowseError::Binary);
    assert_eq!(far.read("big.txt").unwrap_err(), BrowseError::TooBig);
    assert_eq!(far.read("edge.txt").unwrap().size, MAX_FILE, "exactly the cap is fine");
    assert_eq!(far.read("nope.txt").unwrap_err(), BrowseError::NotFile);
    assert_eq!(far.read("sub dir").unwrap_err(), BrowseError::NotFile, "a folder is not a file");
    assert_eq!(far.list("nope").unwrap_err(), BrowseError::NotFolder);
    assert_eq!(far.list("plain").unwrap_err(), BrowseError::NotFolder, "a file is not a folder");
    // `..` never gets to the far side.
    assert_eq!(far.read("../secret.txt").unwrap_err(), BrowseError::BadPath);
    assert_eq!(far.list("sub dir/../..").unwrap_err(), BrowseError::BadPath);
    // A missing project folder.
    let missing = Far { folder: "/no/such/place/here", ..Far { gate: &gate, ..Far::new(&runner, &h, "/x") } };
    assert_eq!(missing.list("").unwrap_err(), BrowseError::NoFolder);
    // Nothing was written anywhere.
    assert!(!proj.join("tmp-pwned").exists() && !std::env::current_dir().unwrap().join("tmp-pwned").exists(), "an injected touch would have made this file");

    // Symlinks (a unix temp dir, or a Windows one where the account may make links).
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(&outside, proj.join("out-dir")).unwrap();
        symlink(outside.join("secret.txt"), proj.join("out-file")).unwrap();
        symlink(&evil_sibling, proj.join("sibling-link")).unwrap();
        symlink("plain", proj.join("in-file")).unwrap();
        symlink("sub dir", proj.join("in-dir")).unwrap();
        symlink("../../etc", proj.join("sub dir").join("up")).unwrap();
        assert_eq!(far.list("out-dir").unwrap_err(), BrowseError::Escape);
        assert_eq!(far.list("sibling-link").unwrap_err(), BrowseError::Escape, "a folder whose name starts with the project's is still outside");
        assert_eq!(far.read("out-dir/secret.txt").unwrap_err(), BrowseError::Escape);
        assert_eq!(far.read("sibling-link/secret.txt").unwrap_err(), BrowseError::Escape);
        assert_eq!(far.read("out-file").unwrap_err(), BrowseError::Link);
        assert_eq!(far.read("in-file").unwrap_err(), BrowseError::Link, "a link inside is not followed either");
        assert_eq!(far.list("sub dir/up").unwrap_err(), BrowseError::Escape);
        assert!(far.list("in-dir").unwrap().entries.iter().any(|e| e.name == "it's"), "a link to a folder inside the project is listed");
        let l = far.list("").unwrap();
        assert!(l.entries.iter().any(|e| e.name == "out-file" && e.kind == "link"));
        assert!(l.entries.iter().any(|e| e.name == "out-dir" && e.kind == "link"), "links are shown as links");
    }
    // A name with a newline is counted, not shown (unix only: Windows cannot make one).
    #[cfg(unix)]
    {
        std::fs::write(proj.join("two\nlines"), "x").unwrap();
        std::fs::write(proj.join("esc\u{1b}[2J"), "x").unwrap();
        let l = far.list("").unwrap();
        assert!(l.skipped >= 2, "{}", l.skipped);
        assert!(l.entries.iter().all(|e| !e.name.contains('\n') && !e.name.contains('\u{1b}')));
    }
    let _ = std::fs::remove_dir_all(&proj);
    let _ = std::fs::remove_dir_all(&outside);
    let _ = std::fs::remove_dir_all(&evil_sibling);
}

#[test]
fn the_real_script_reports_git_status_of_a_temp_repo() {
    let Some(sh) = local_sh() else { return };
    if crate::proc_util::hidden_command("git").arg("--version").output().is_err() {
        return;
    }
    let proj = temp_project("git");
    let git = |args: &[&str]| {
        let o = crate::proc_util::hidden_command("git").args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=trunk"]).args(args).current_dir(&proj).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(proj.join("kept.txt"), "1\n").unwrap();
    std::fs::write(proj.join("it's changed.txt"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    std::fs::write(proj.join("it's changed.txt"), "2\n").unwrap();
    std::fs::write(proj.join("$(new) file.txt"), "n\n").unwrap();
    std::fs::write(proj.join("staged.txt"), "s\n").unwrap();
    git(&["add", "staged.txt"]);
    let before = std::fs::read(proj.join(".git").join("index")).unwrap();

    let h = host();
    let runner = LocalSh(sh);
    let gate = Gate::default();
    let proj_path = far_path(&proj);
    let far = Far { gate: &gate, ..Far::new(&runner, &h, &proj_path) };
    let s = far.status().expect("status");
    assert_eq!(s.branch.as_deref(), Some("trunk"));
    let got: Vec<(&str, &str, bool)> = s.changes.iter().map(|c| (c.path.as_str(), c.kind, c.staged)).collect();
    assert!(got.contains(&("it's changed.txt", "modified", false)), "{got:?}");
    assert!(got.contains(&("$(new) file.txt", "new", false)), "{got:?}");
    assert!(got.contains(&("staged.txt", "added", true)), "{got:?}");
    assert_eq!(std::fs::read(proj.join(".git").join("index")).unwrap(), before, "status did not rewrite the index");
    // Not a repo.
    let plain = temp_project("git-plain");
    let plain_path = far_path(&plain);
    let far2 = Far { gate: &gate, ..Far::new(&runner, &h, &plain_path) };
    assert_eq!(far2.status().unwrap_err(), BrowseError::NotRepo);
    let _ = std::fs::remove_dir_all(&proj);
    let _ = std::fs::remove_dir_all(&plain);
}

#[test]
fn an_answer_that_was_cut_off_is_never_shown_as_whole() {
    // A file shorter than the size the script measured.
    assert_eq!(parse_read(&framed_out("ok\nsize 10\nabcde"), "x"), Err(BrowseError::NoAnswer));
    // A listing that never reached its last line.
    assert_eq!(parse_list(&framed_out("ok\nf a\nf b\n"), ""), Err(BrowseError::NoAnswer));
    // A git record cut in half by the output cap is dropped, and the list says there is more.
    let out = framed_out("ok\nprefix \n## main\0 M a.rs\0?? half-writ");
    let s = parse_status(&out).unwrap();
    assert_eq!(s.changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["a.rs"]);
    assert!(s.more);
    // A call that hit the deadline, or whose connection ended badly, after the begin line.
    let h = host();
    let timed = Fake::new(Ok(Output { ok: false, timed_out: true, stdout: framed_out("ok\nf a\n"), stderr: String::new() }));
    assert_eq!(Far::new(&timed, &h, "/srv/app").list("").unwrap_err(), BrowseError::TimedOut);
    let dropped = Fake::new(Ok(Output { ok: false, timed_out: false, stdout: framed_out("ok\nsize 3\nabc"), stderr: "Connection reset".into() }));
    assert!(Far::new(&dropped, &h, "/srv/app").read("a.txt").is_err());
}

#[test]
fn every_reason_has_its_own_code_and_an_english_sentence() {
    let all = [
        BrowseError::BadFolder,
        BrowseError::BadPath,
        BrowseError::NoFolder,
        BrowseError::Escape,
        BrowseError::NotFolder,
        BrowseError::NotFile,
        BrowseError::Link,
        BrowseError::TooBig,
        BrowseError::Binary,
        BrowseError::Unreadable,
        BrowseError::NoGit,
        BrowseError::NotRepo,
        BrowseError::NoAnswer,
        BrowseError::Busy,
        BrowseError::TimedOut,
        BrowseError::HostKeyUnknown,
        BrowseError::HostKeyChanged,
        BrowseError::WrongKey,
        BrowseError::CannotReach,
        BrowseError::Other,
    ];
    let mut codes: Vec<&str> = all.iter().map(BrowseError::code).collect();
    assert!(codes.iter().all(|c| c.starts_with("SSH_FS_") && c.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_')));
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), all.len());
    assert!(all.iter().all(|e| !e.sentence("Build box").is_empty()));
}
