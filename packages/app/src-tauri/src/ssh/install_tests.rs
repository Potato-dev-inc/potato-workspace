//! The one-button install against a fake `ssh`: no real machine is contacted. The fake answers by the fixed line it is sent.

use super::install::*;
use super::model::SshHost;
use super::run::{Output, Runner};
use std::cell::RefCell;
use std::time::Duration;

const SHA: &str = "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11";
const LOOK_OK: &str = "os=Linux\narch=x86_64\nglibc=glibc 2.39\nfree_kb=9000000\nsystemd=1\n";
const PAIR_OK: &str = "{\"potato_host\":1,\"node\":\"0101010101010101010101010101010101010101010101010101010101010101\",\"device_pub\":\"0202020202020202020202020202020202020202020202020202020202020202\",\"name\":\"box\"}\n{\"paired\":true,\"name\":\"My PC\"}\n";

fn host() -> SshHost {
    SshHost::parse("h1", "box", "dev@box.local", Some(2222), Some("C:/k")).unwrap()
}

fn ok(stdout: &str) -> Output {
    Output { ok: true, timed_out: false, stdout: stdout.into(), stderr: String::new() }
}

fn bad(stderr: &str) -> Output {
    Output { ok: false, timed_out: false, stdout: String::new(), stderr: stderr.into() }
}

type Call = (Vec<String>, Option<Vec<u8>>);

/// Answers each fixed line from a function; remembers every call (the argv, and what went to stdin).
struct Fake {
    answer: Box<dyn Fn(&str, usize) -> Output>,
    calls: RefCell<Vec<Call>>,
}

impl Fake {
    fn new(answer: impl Fn(&str, usize) -> Output + 'static) -> Self {
        Self { answer: Box::new(answer), calls: RefCell::new(Vec::new()) }
    }
    fn lines(&self) -> Vec<String> {
        self.calls.borrow().iter().map(|(a, _)| a.last().unwrap().clone()).collect()
    }
    fn count(&self, line: &str) -> usize {
        self.lines().iter().filter(|l| *l == line).count()
    }
    fn go(&self, argv: &[String], input: Option<&[u8]>) -> Result<Output, String> {
        let line = argv.last().unwrap().clone();
        let n = self.count(&line);
        self.calls.borrow_mut().push((argv.to_vec(), input.map(<[u8]>::to_vec)));
        Ok((self.answer)(&line, n))
    }
}

impl Runner for Fake {
    fn run(&self, argv: &[String], _d: Duration) -> Result<Output, String> {
        self.go(argv, None)
    }
    fn run_input(&self, argv: &[String], input: &[u8], _d: Duration) -> Result<Output, String> {
        self.go(argv, Some(input))
    }
}

fn healthy(line: &str, _n: usize) -> Output {
    match line {
        l if l == LOOK => ok(LOOK_OK),
        l if l == VERIFY => ok(&format!("{SHA}\n")),
        l if l == PAIR => ok(PAIR_OK),
        _ => ok(""),
    }
}

fn run_plan(fake: &Fake, pair: Option<&str>) -> (Result<Done, Failure>, Vec<Event>) {
    let bytes = b"ELF-bytes";
    let pause = |_: Duration| {};
    let plan = Plan { asset: Asset { bytes, sha256: SHA }, pair_line: pair, pause: &pause };
    let mut events = Vec::new();
    let r = run(fake, &host(), &plan, &mut |e| events.push(e));
    (r, events)
}

#[test]
fn a_clean_machine_gets_look_copy_check_swap_pair_then_start_in_that_order() {
    let fake = Fake::new(healthy);
    let (r, _) = run_plan(&fake, Some("{\"node\":\"x\"}"));
    let done = r.unwrap();
    assert_eq!(done.paired.unwrap().name, "box");
    assert!(!done.already_current);
    assert_eq!(fake.lines(), [LOOK, COPY, VERIFY, FINISH, PAIR, STOP, SERVICE, RUNNING]);
    let calls = fake.calls.borrow();
    assert_eq!(calls[1].1.as_deref(), Some(&b"ELF-bytes"[..]), "the program goes on stdin");
    assert_eq!(calls[4].1.as_deref(), Some(&b"{\"node\":\"x\"}\n"[..]), "this PC's line goes on stdin, with its newline");
}

#[test]
fn no_systemd_means_the_background_start() {
    let fake = Fake::new(|l, n| if l == LOOK { ok("os=Linux\narch=x86_64\nglibc=glibc 2.40\nfree_kb=900000\n") } else { healthy(l, n) });
    run_plan(&fake, None).0.unwrap();
    assert_eq!(fake.count(NOHUP), 1);
    assert_eq!(fake.count(SERVICE), 0);
}

#[test]
fn an_update_of_a_paired_machine_does_not_pair_again() {
    let fake = Fake::new(healthy);
    let (r, _) = run_plan(&fake, None);
    assert_eq!(r.unwrap().paired, None);
    assert_eq!(fake.count(PAIR), 0);
}

#[test]
fn the_same_program_already_running_changes_nothing() {
    let fake = Fake::new(|l, n| if l == LOOK { ok(&format!("{LOOK_OK}host_sha={SHA}\nrunning=1\n")) } else { healthy(l, n) });
    let done = run_plan(&fake, None).0.unwrap();
    assert!(done.already_current);
    assert_eq!(fake.lines(), [LOOK]);
}

#[test]
fn the_same_program_not_running_is_only_started() {
    let fake = Fake::new(|l, n| if l == LOOK { ok(&format!("{LOOK_OK}host_sha={SHA}\n")) } else { healthy(l, n) });
    run_plan(&fake, None).0.unwrap();
    assert_eq!(fake.count(COPY), 0);
    assert_eq!(fake.count(SERVICE), 1);
}

#[test]
fn a_step_that_keeps_failing_is_tried_three_times_then_hands_off_with_its_fixed_line() {
    let fake = Fake::new(|l, n| if l == SERVICE { bad("Failed to connect to bus: No medium found") } else { healthy(l, n) });
    let (r, events) = run_plan(&fake, None);
    let f = r.unwrap_err();
    assert_eq!((f.step, f.why, f.handoff), (Step::Start, "step_failed", Some(SERVICE)));
    assert_eq!(fake.count(SERVICE), 3);
    assert_eq!(events.iter().filter(|e| matches!(e, Event::Retrying(Step::Start, _))).count(), 2);
}

#[test]
fn a_wrong_key_or_a_changed_host_key_stops_at_the_first_try() {
    for (stderr, why) in [("dev@box: Permission denied (publickey).", "wrong_key"), ("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "host_key_changed"), ("Host key verification failed.", "host_key_unknown")] {
        let fake = Fake::new(move |_, _| bad(stderr));
        let f = run_plan(&fake, None).0.unwrap_err();
        assert_eq!((f.step, f.why), (Step::Look, why));
        assert_eq!(fake.lines().len(), 1, "{why}");
    }
}

#[test]
fn a_copy_that_does_not_match_the_checksum_is_never_swapped_in() {
    let fake = Fake::new(|l, n| if l == VERIFY { ok(&format!("{}\n", "bb".repeat(32))) } else { healthy(l, n) });
    let f = run_plan(&fake, None).0.unwrap_err();
    assert_eq!((f.step, f.why), (Step::Copy, "hash_mismatch"));
    assert_eq!(fake.count(COPY), 3);
    assert_eq!(fake.count(FINISH), 0);
    assert_eq!(fake.count(SERVICE) + fake.count(NOHUP), 0);
}

#[test]
fn a_machine_that_cannot_take_the_program_is_refused_before_anything_is_copied() {
    for (look, why) in [
        ("os=Darwin\narch=arm64\n", "not_linux"),
        ("os=Linux\narch=aarch64\nglibc=glibc 2.39\n", "not_x86_64"),
        ("os=Linux\narch=x86_64\nglibc=glibc 2.17\n", "glibc_old"),
        ("os=Linux\narch=x86_64\n", "glibc_old"),
        ("os=Linux\narch=x86_64\nglibc=glibc 2.39\nfree_kb=1000\n", "disk_full"),
    ] {
        let fake = Fake::new(move |_, _| ok(look));
        let f = run_plan(&fake, None).0.unwrap_err();
        assert_eq!(f.why, why);
        assert_eq!(fake.lines(), [LOOK], "{why}");
    }
}

#[test]
fn a_bad_or_refused_pairing_answer_is_not_retried_and_not_trusted() {
    let refused = PAIR_OK.replace("true", "false");
    for out in ["", "{\"potato_host\":1,\"node\":\"zz\",\"device_pub\":\"zz\"}\n{\"paired\":true}\n", refused.as_str()] {
        let out = out.to_string();
        let fake = Fake::new(move |l, n| if l == PAIR { ok(&out) } else { healthy(l, n) });
        let f = run_plan(&fake, Some("{}")).0.unwrap_err();
        assert_eq!((f.step, f.why), (Step::Pair, "pair_refused"));
        assert_eq!(fake.count(PAIR), 1);
        assert_eq!(fake.count(SERVICE) + fake.count(NOHUP), 0, "the program is not started after a failed pairing");
    }
}

#[test]
fn only_fixed_lines_with_no_forwarding_ever_reach_ssh() {
    let fake = Fake::new(healthy);
    run_plan(&fake, Some("{}")).0.unwrap();
    for (argv, _) in fake.calls.borrow().iter() {
        assert!(ALL_LINES.contains(&argv.last().unwrap().as_str()), "{argv:?}");
        for must in ["BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "ForwardAgent=no"] {
            assert!(argv.iter().any(|a| a == must), "{must}");
        }
        let at = argv.iter().position(|a| a == "--").unwrap();
        assert_eq!(argv[at + 1], "dev@box.local");
        assert_eq!(argv.len(), at + 3, "the destination and the one line, nothing else");
    }
}

#[test]
fn the_look_is_read_tolerantly() {
    let l = parse_look("os=Linux\narch=x86_64\nglibc=glibc 2.39\nfree_kb=12\nhost_sha=nothex\nrunning=1\njunk\n=\n");
    assert_eq!((l.os.as_str(), l.glibc, l.free_kb, l.running, l.host_sha), ("Linux", Some((2, 39)), Some(12), true, None));
}
