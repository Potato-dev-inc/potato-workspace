//! The headless probe against fake CLIs (`tests/fake-probe/fake_probe_cli.rs`, compiled once with rustc; the mode is the
//! exe name). No model, no cost. `probe_case_*` are the 14 cases of the lab's check_probe.py.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use super::*;
use crate::tui::declarative::loader::load_text;
use crate::tui::declarative::output::OutputParser;
use crate::tui::declarative::sources::Origin;
use crate::tui::declarative::validate::Source;

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

static BASE: OnceLock<PathBuf> = OnceLock::new();

/// The compiled fake, once per test run.
fn base_exe() -> &'static Path {
    BASE.get_or_init(|| {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tui/declarative/wizard/tests/fake-probe/fake_probe_cli.rs");
        let dir = std::env::temp_dir().join(format!("pm-headless-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp folder");
        let rustc = std::env::var_os("CARGO")
            .map(|c| PathBuf::from(c).with_file_name(if cfg!(windows) { "rustc.exe" } else { "rustc" }))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from("rustc"));
        let out = dir.join(exe_name("fake-probe-base"));
        let status = crate::proc_util::hidden_command(rustc)
            .args(["--edition", "2021", "-C", "opt-level=0", "-o"])
            .arg(&out)
            .arg(&source)
            .status()
            .expect("rustc");
        assert!(status.success(), "building the fake probe cli failed");
        out
    })
}

/// One fake CLI in its own folder (its own argument log), removed on drop.
struct Fake {
    dir: PathBuf,
    exe: PathBuf,
}

impl Fake {
    fn new(mode: &str, tag: &str) -> Self {
        let dir = base_exe().parent().unwrap().join(format!("{tag}-{mode}"));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(exe_name(&format!("probe-{mode}")));
        std::fs::copy(base_exe(), &exe).unwrap();
        Fake { dir, exe }
    }

    fn request(&self) -> ProbeRequest {
        ProbeRequest {
            tokens: vec![self.exe.to_string_lossy().into_owned()],
            helps: Vec::new(),
            work_dir: self.dir.clone(),
            limits: GuardLimits { first_byte: Duration::from_secs(4), idle: Duration::from_secs(4), total: Duration::from_secs(20) },
        }
    }

    /// Every start of the fake, as its argument list.
    fn calls(&self) -> Vec<Vec<String>> {
        let log = format!("{}.args.log", self.exe.display());
        std::fs::read_to_string(log).unwrap_or_default().lines().map(|l| l.split('\t').map(str::to_string).collect()).collect()
    }

    fn prompt_calls(&self) -> usize {
        self.calls().iter().filter(|c| c.iter().any(|a| a.contains("Reply with exactly"))).count()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn run(mode: &str, tag: &str) -> (Fake, ProbeResult) {
    let fake = Fake::new(mode, tag);
    let result = probe(&fake.request(), Some(ProbeConsent::granted(2)));
    (fake, result)
}

fn kinds(d: &HeadlessDraft) -> Vec<&'static str> {
    [("result", &d.result), ("session", &d.session), ("done", &d.done)].iter().filter(|(_, s)| s.is_some()).map(|(n, _)| *n).collect()
}

// ---- The 14 lab cases ----

#[test]
fn probe_case_json_rule_driver_written() {
    let (_f, r) = run("json", "c1");
    assert_eq!(r.outcome, ProbeOutcome::Found, "{:?}", r.evidence);
    assert_eq!(r.level, ProbeLevel::L2);
    assert_eq!(r.headless.as_ref().unwrap().format, DraftFormat::JsonLines);
    assert_eq!(r.runs_used, 1);
}

#[test]
fn probe_case_json_print_and_stream_json_flags() {
    let (_f, r) = run("json", "c2");
    let argv = r.headless.unwrap().argv;
    assert!(argv.contains(&"--print".to_string()), "{argv:?}");
    assert!(argv.windows(2).any(|w| w[0] == "-o" && w[1] == "stream-json"), "{argv:?}");
}

#[test]
fn probe_case_json_text_done_and_session_rules_inferred() {
    let (_f, r) = run("json", "c3");
    let d = r.headless.unwrap();
    assert_eq!(kinds(&d), vec!["result", "session", "done"]);
    assert_eq!(d.result.unwrap().path.as_deref(), Some("message.content.0.text"));
    assert_eq!(d.session.unwrap().path.as_deref(), Some("session_id"));
    assert!(d.error.is_some(), "the result line carries is_error");
}

#[test]
fn probe_case_json_model_option_from_list_models() {
    let (_f, r) = run("json", "c4");
    let opt = r.options.iter().find(|o| o.id == "model").expect("model option");
    assert_eq!(&opt.values[..2], &["default".to_string(), "alpha-1".to_string()]);
    assert_eq!(r.headless.unwrap().model_args, Some(vec!["--model".to_string(), "{model}".to_string()]));
}

#[test]
fn probe_case_json_no_bypass_flag_enabled() {
    let (_f, r) = run("json", "c5");
    let toml = r.headless_toml().unwrap().to_ascii_lowercase();
    // The comment lines name the flags the help showed; the table itself must not use them.
    let table: String = toml.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n");
    assert!(!table.contains("dangerous") && !table.contains("yolo"), "{table}");
}

#[test]
fn probe_case_json_resume_flag_mapped() {
    let (_f, r) = run("json", "c6");
    assert_eq!(r.headless.unwrap().resume_args, Some(vec!["--resume".to_string(), "{session}".to_string()]));
}

#[test]
fn probe_case_json_round_trip_through_the_definition_loader() {
    let (f, r) = run("json", "c7");
    let table = r.headless_toml().expect("a table");
    let text = format!(
        "schema_version = 1\n\n[agent]\nid = \"probed\"\nlabel = \"Probed\"\nexperimental = true\n\n[binary]\nnames = [\"probe-json\"]\nwindows_extensions = [\"exe\"]\nversion_args = [\"--version\"]\ninstall_hint = \"test\"\n\n{table}"
    );
    let loaded = load_text(Path::new("probed.toml"), &text, text.len(), Origin::new(Source::User), None, &[]);
    assert!(loaded.errors.is_empty(), "{:?}\n{text}", loaded.errors);
    let def = loaded.definition.unwrap();
    let headless = def.headless.as_ref().unwrap();
    // Run what the table says, the way the app would, and read the answer with the app's own parser.
    let mut args = headless.argv.clone();
    args.push(headless.task_separator.clone().unwrap());
    args.push("Reply with exactly: hello-xyz".to_string());
    let out = run_guarded(&f.exe, &args, &f.dir, &f.request().limits, 65536);
    let answer = OutputParser::compile(headless).unwrap().extract_result(&out.text, out.exit.unwrap_or(0));
    assert_eq!(answer.as_deref(), Some("hello-xyz"), "{}", out.text);
}

#[test]
fn probe_case_plain_text_driver_written() {
    let (_f, r) = run("plain", "c8");
    assert_eq!(r.outcome, ProbeOutcome::Found, "{:?}", r.evidence);
    let d = r.headless.as_ref().unwrap();
    assert_eq!(d.format, DraftFormat::PlainText);
    assert!(d.result.is_none() && d.session.is_none());
    assert!(r.headless_toml().unwrap().contains("format = \"plain_text\""));
}

#[test]
fn probe_case_tui_is_refused_quickly() {
    let started = Instant::now();
    let (_f, r) = run("tui", "c9");
    assert_eq!(r.outcome, ProbeOutcome::Stopped("tui".into()), "{:?}", r.evidence);
    assert!(r.headless.is_none() && r.level == ProbeLevel::L5);
    assert!(started.elapsed() < Duration::from_secs(12), "{:?}", started.elapsed());
}

#[test]
fn probe_case_silent_cli_hits_the_first_byte_timeout() {
    let started = Instant::now();
    let (_f, r) = run("silent", "c10");
    assert_eq!(r.outcome, ProbeOutcome::Stopped("no-output".into()), "{:?}", r.evidence);
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
}

#[test]
fn probe_case_signed_out_cli_is_told_to_sign_in() {
    let (_f, r) = run("signedout", "c11");
    assert_eq!(r.outcome, ProbeOutcome::SignedOut);
    assert!(r.headless.is_none() && r.level == ProbeLevel::L5, "a sign-in prompt is never a pass");
    assert!(r.evidence.iter().any(|e| e.contains("sign in")));
}

#[test]
fn probe_case_secret_is_masked_in_the_saved_sample() {
    let (_f, r) = run("secret", "c12");
    assert!(!r.samples.is_empty());
    let all: String = r.samples.iter().map(|s| s.text.clone()).collect::<Vec<_>>().join("\n");
    assert!(!all.contains("abcdefghijklmnopqrstuvwxyz0123456789"), "{all}");
    assert!(all.contains("ok"), "the rest of the sample stays: {all}");
}

#[test]
fn probe_case_no_headless_flag_is_said_plainly() {
    let (f, r) = run("nohelp", "c13");
    assert_eq!(r.outcome, ProbeOutcome::NoHeadlessFlag);
    assert_eq!(r.level, ProbeLevel::L5);
    assert_eq!(r.runs_used, 0);
    assert_eq!(f.prompt_calls(), 0);
}

#[test]
fn probe_case_budget_is_at_most_two_model_runs() {
    let (f, r) = run("silent", "c14");
    assert!(f.prompt_calls() <= MAX_PAID_RUNS as usize, "{}", f.prompt_calls());
    assert!(r.runs_used <= MAX_PAID_RUNS);
    assert_eq!(ProbeConsent::granted(9).runs(), MAX_PAID_RUNS, "a bigger yes is cut to the limit");
    // Two runs are really used when the first one does not settle it, and never a third.
    let (f, r) = run("echo", "c14b");
    assert_eq!(r.runs_used, 2);
    assert_eq!(f.prompt_calls(), 2);
}

// ---- The guards ----

#[test]
fn probe_never_uses_bypass_flag() {
    // The help shows bypass flags; none may reach the argv of any run.
    let (f, r) = run("json", "b1");
    assert_eq!(r.outcome, ProbeOutcome::Found);
    for call in f.calls() {
        let line = call.join(" ").to_ascii_lowercase();
        assert!(!line.contains("dangerous") && !line.contains("yolo") && !line.contains("skip-permission"), "{line}");
    }
    assert!(r.evidence.iter().any(|e| e.contains("none used")));
    // A help whose only "headless" line is a bypass flag is not a headless flag.
    let (f, r) = run("bait", "b2");
    assert_eq!(r.outcome, ProbeOutcome::NoHeadlessFlag);
    assert_eq!(f.prompt_calls(), 0);
    // A command that already carries a bypass flag is refused before anything starts.
    let fake = Fake::new("json", "b3");
    let mut req = fake.request();
    req.tokens.push("--yolo".to_string());
    let r = probe(&req, Some(ProbeConsent::granted(2)));
    assert!(matches!(r.outcome, ProbeOutcome::Refused(ref t) if t.contains(&"--yolo".to_string())), "{:?}", r.outcome);
    assert_eq!(r.runs_used, 0);
    assert!(fake.calls().is_empty(), "nothing was started: {:?}", fake.calls());
}

#[test]
fn probe_rejects_nonce_echo() {
    // Plain text that only repeats the prompt.
    let (_f, r) = run("echo", "e1");
    assert_eq!(r.outcome, ProbeOutcome::EchoOnly, "{:?}", r.evidence);
    assert!(r.headless.is_none() && r.level == ProbeLevel::L5);
    // JSON whose only leaf with the check word is the user's own prompt.
    let (_f, r) = run("echojson", "e2");
    assert_ne!(r.outcome, ProbeOutcome::Found, "{:?}", r.evidence);
    assert!(r.headless.is_none());
}

#[test]
fn probe_runs_no_prompt_without_consent() {
    let fake = Fake::new("json", "n1");
    let r = probe(&fake.request(), None);
    assert_eq!(r.outcome, ProbeOutcome::NeedsConsent);
    assert_eq!(r.runs_used, 0);
    assert_eq!(fake.prompt_calls(), 0, "{:?}", fake.calls());
    assert_eq!(r.level, ProbeLevel::L5, "nothing is proven without a run");
    assert!(r.headless.is_some(), "the help text alone still gives a draft");
    // Reading the help and the model list needed no consent.
    assert!(fake.calls().iter().any(|c| c.iter().any(|a| a == "--help")));
    assert_eq!(r.options.iter().filter(|o| o.id == "model").count(), 1);
    // A consent for zero runs sends nothing either.
    let r = probe(&fake.request(), Some(ProbeConsent::granted(0)));
    assert_eq!(fake.prompt_calls(), 0);
    assert_eq!(r.runs_used, 0);
}

#[test]
fn probe_stops_on_tui_escape_codes() {
    assert!(exec::has_tui_escapes(b"hello \x1b[?1049h"));
    assert!(exec::has_tui_escapes(b"\x1b[?25l"));
    assert!(exec::has_tui_escapes(b"\x1b[12;40Hx"));
    assert!(!exec::has_tui_escapes(b"\x1b[31mred\x1b[0m plain"));
    let (_f, r) = run("tui", "t1");
    assert_eq!(r.outcome, ProbeOutcome::Stopped("tui".into()));
    assert_eq!(r.samples.len(), 1, "stopped at once, no second run");
}

#[test]
fn probe_stdin_is_closed() {
    // The fake answers only when stdin ends at once; an open stdin would hang until a guard fired.
    let (_f, r) = run("stdin", "s1");
    assert_eq!(r.outcome, ProbeOutcome::Found, "{:?}", r.evidence);
}

#[test]
fn probe_idle_output_is_stopped() {
    let started = Instant::now();
    let (_f, r) = run("idle", "i1");
    assert_eq!(r.outcome, ProbeOutcome::Stopped("idle".into()), "{:?}", r.evidence);
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn probe_only_adds_flags_from_the_closed_list() {
    for t in ["--print", "-o", "stream-json", "--"] {
        assert!(in_closed_list(t), "{t}");
    }
    for t in ["--yolo", "--dangerously-skip-permissions", "--profile", "-c", "login"] {
        assert!(!in_closed_list(t), "{t}");
    }
}

// ---- Checkpoint 2 review fixes (P1, P2, P3) ----

const PRINT_HELP: &str = "Options:\n  -p, --print                Print response and exit (non-interactive)\n  -o, --output-format <fmt>  Output format (stream-json)\n";

fn helps_of(text: &str) -> Vec<String> {
    vec![text.to_string()]
}

#[test]
fn short_alias_of_bypass_is_refused() {
    // `-p` is only the print flag when its long name on the same line is a print flag.
    for line in [
        "  -p, --yolo        Skip all confirmations",
        "  -p, --provider <name>   The provider",
        "  -p, --port <n>    Port to use",
        "  -p, --project <dir>   Project folder",
        "  -q, --quiet       Less output",
        "  -m, --mode <mode>   Run mode",
        "  -m <mode>   Run mode",
    ] {
        assert!(scan_help(&helps_of(line)).headless.is_none(), "{line}");
    }
    // The real ones still count (the long name is written).
    assert_eq!(scan_help(&helps_of("  -p, --print     Print and exit")).headless, Some((Kind::Flag, "--print".to_string())));
    assert_eq!(scan_help(&helps_of("  -q, --query <text>   Ask")).headless, Some((Kind::Value, "--query".to_string())));
    // A short flag alone needs a describing word on its line.
    assert!(scan_help(&helps_of("  -p              Print and exit")).headless.is_some());
    assert!(scan_help(&helps_of("  -p              Do the thing")).headless.is_none());
    // Through the whole probe: nothing is run, with or without consent.
    let fake = Fake::new("json", "p1");
    let mut req = fake.request();
    req.helps = helps_of("  -p, --yolo        Skip all confirmations\n");
    let r = probe(&req, Some(ProbeConsent::granted(2)));
    assert_eq!(r.outcome, ProbeOutcome::NoHeadlessFlag, "{:?}", r.evidence);
    assert_eq!(fake.prompt_calls(), 0, "{:?}", fake.calls());
}

#[test]
fn model_list_word_form_needs_subcommand_line() {
    // The word "model" in a sentence is not a list command.
    let sentence = format!("{PRINT_HELP}  --model <name>   the model to use\n  models are listed on the web site\n");
    let fake = Fake::new("json", "p2a");
    let mut req = fake.request();
    req.helps = helps_of(&sentence);
    probe(&req, None);
    probe(&req, Some(ProbeConsent::granted(2)));
    let listed = |f: &Fake| f.calls().iter().any(|c| c.first().is_some_and(|a| a == "models" || a == "model"));
    assert!(!listed(&fake), "{:?}", fake.calls());

    // A subcommand line: not run without consent, run (and counted) with one.
    let with_line = format!("{PRINT_HELP}  --model <name>   the model to use\n\nCommands:\n  models    List the models\n");
    let fake = Fake::new("json", "p2b");
    let mut req = fake.request();
    req.helps = helps_of(&with_line);
    let r = probe(&req, None);
    assert!(!listed(&fake), "no consent, no word-form run: {:?}", fake.calls());
    assert_eq!(r.runs_used, 0);
    let r = probe(&req, Some(ProbeConsent::granted(2)));
    assert!(listed(&fake), "{:?}", fake.calls());
    assert!(r.runs_used >= 1, "the list run counts against the consent");
    assert!(r.runs_used <= MAX_PAID_RUNS);

    // `--list-models` as an option line needs no consent.
    let fake = Fake::new("json", "p2c");
    let mut req = fake.request();
    req.helps = helps_of(&format!("{PRINT_HELP}  --model <name>   Model\n  --list-models   List models\n"));
    let r = probe(&req, None);
    assert_eq!(r.runs_used, 0);
    assert!(fake.calls().iter().any(|c| c.iter().any(|a| a == "--list-models")));
}

#[test]
fn resume_needs_long_flag() {
    assert_eq!(scan_help(&helps_of("  -r, --remove <id>   Delete a saved session")).resume, None);
    assert_eq!(scan_help(&helps_of("  -r, --reset   Start over")).resume, None);
    assert_eq!(scan_help(&helps_of("  -r              Resume")).resume, None);
    assert_eq!(scan_help(&helps_of("  -r, --resume [id]   Resume a session")).resume.as_deref(), Some("--resume"));
    // Through the probe: a JSON run that prints a session id still writes no resume segment for `--remove`.
    let fake = Fake::new("json", "p3");
    let mut req = fake.request();
    req.helps = helps_of(&format!("{PRINT_HELP}  -r, --remove <id>   Delete a saved session\n"));
    let r = probe(&req, Some(ProbeConsent::granted(2)));
    assert_eq!(r.outcome, ProbeOutcome::Found, "{:?}", r.evidence);
    assert_eq!(r.headless.unwrap().resume_args, None);
}
