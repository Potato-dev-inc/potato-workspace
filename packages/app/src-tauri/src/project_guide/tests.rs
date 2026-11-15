use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use regex::Regex;

use super::check::*;
use super::consent::*;
use super::dry::DryRunAgent;
use super::mermaid::{compile, safe_label};
use super::model::*;
use super::prompts::{TASK_GRAPH, TASK_OUTLINE, TASK_PAGE};
use super::run::*;
use super::scan::*;
use super::stale::*;
use super::store::*;

fn project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-guide-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn put(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn lines(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// A small project with real files, and with files that must never be read.
fn fixture(name: &str) -> PathBuf {
    let d = project(name);
    put(&d, "README.md", "# Tide notes\nA small notes app.\n");
    put(&d, "package.json", "{\"name\":\"tide-notes\"}\n");
    put(&d, "src/main.ts", &format!("import {{ queue }} from './sync/queue';\n{}", lines(30)));
    put(&d, "src/sync/queue.ts", &lines(100));
    put(&d, "src/sync/net.ts", &format!("import {{ queue }} from './queue';\n{}", lines(20)));
    put(&d, "src/ui/app.ts", &format!("import {{ queue }} from '../sync/queue';\n{}", lines(40)));
    put(&d, "src/ui/button.ts", &lines(12));
    put(&d, "docs/design.md", "# Design\nWords.\n");
    put(&d, ".env", "API_KEY=sk-live-aaaaaaaaaaaaaaaa\n");
    put(&d, "keys/id_rsa", "-----BEGIN PRIVATE KEY-----\n");
    put(&d, "node_modules/dep/index.js", "module.exports = 1;\n");
    put(&d, "package-lock.json", "{}\n");
    d
}

// ---------------------------------------------------------------- scan

#[test]
fn the_skip_list_never_lets_a_secret_through() {
    for secret in [
        ".env", ".env.local", ".env.production", ".envrc", "id_rsa", "id_ed25519", "id_rsa.pub", "server.pem", "tls.key", "cert.p12", "store.pfx", "my.keystore",
        "credentials.json", "credentials", "service-account.json", ".npmrc", ".netrc", ".git-credentials", "secrets.yml", "secrets.json", "x.kdbx",
    ] {
        assert_eq!(classify(secret, 10), Some(SkipReason::Secret), "{secret}");
        assert_eq!(classify(&format!("deep/dir/{secret}"), 10), Some(SkipReason::Secret), "deep {secret}");
    }
    assert_eq!(classify("src/secrets.rs", 10), None, "source code named secrets is code");
    assert_eq!(classify(".ssh/config", 10), Some(SkipReason::Generated));
    let d = fixture("scan-secrets");
    let scan = scan_with(&d, &Steering::default(), None);
    let read: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
    assert!(!read.iter().any(|p| p.contains(".env") || p.contains("id_rsa") || p.contains("node_modules") || p.contains("package-lock")), "{read:?}");
    assert!(scan.skipped.iter().any(|s| s.path == ".env" && s.reason == SkipReason::Secret));
    assert!(scan.skipped.iter().any(|s| s.path == "keys/id_rsa" && s.reason == SkipReason::Secret));
    // The prompt text built from a scan never carries the secret either.
    let index = super::prompts::source_index(&d, &scan);
    assert!(!index.contains("sk-live") && !index.contains("PRIVATE KEY") && !index.contains(".env"));
}

#[test]
fn binaries_big_files_lock_files_and_gitignored_files_are_skipped() {
    let d = fixture("scan-skips");
    put(&d, "logo.png", "not really a png");
    put(&d, "src/blob.dat", "ab\0cd");
    put(&d, "data/huge.json", &"x".repeat(300 * 1024));
    put(&d, ".gitignore", "*.log\nsecret-notes/\n/scratch\n");
    put(&d, "run.log", "log\n");
    put(&d, "secret-notes/a.md", "x\n");
    put(&d, "scratch/a.ts", "x\n");
    let scan = scan_with(&d, &Steering::default(), None);
    let why = |p: &str| scan.skipped.iter().find(|s| s.path == p).map(|s| s.reason);
    assert_eq!(why("logo.png"), Some(SkipReason::Binary));
    assert_eq!(why("src/blob.dat"), Some(SkipReason::Binary));
    assert_eq!(why("data/huge.json"), Some(SkipReason::TooBig));
    assert_eq!(why("package-lock.json"), Some(SkipReason::Lock));
    assert_eq!(why("run.log"), Some(SkipReason::Ignored));
    assert!(!scan.files.iter().any(|f| f.path.starts_with("secret-notes") || f.path.starts_with("scratch")));
}

#[test]
fn manifests_readme_entry_points_and_imported_files_score_highest() {
    let d = fixture("scan-score");
    let scan = scan_with(&d, &Steering::default(), None);
    let order: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
    let rank = |p: &str| order.iter().position(|x| *x == p).unwrap();
    assert!(rank("README.md") < rank("src/ui/button.ts"));
    assert!(rank("package.json") < rank("src/ui/button.ts"));
    assert!(rank("src/main.ts") < rank("src/ui/button.ts"));
    // queue.ts is imported by three files; button.ts by none.
    assert!(rank("src/sync/queue.ts") < rank("src/ui/button.ts"));
    // Same input, same order (no randomness).
    let again = scan_with(&d, &Steering::default(), None);
    assert_eq!(order, again.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>());
}

#[test]
fn the_steering_file_can_skip_folders() {
    let d = fixture("scan-steer");
    let steer = Steering { skip: vec!["docs".into()], ..Default::default() };
    let scan = scan_with(&d, &steer, None);
    assert!(!scan.files.iter().any(|f| f.path.starts_with("docs/")));
}

// ---------------------------------------------------------------- check

#[test]
fn citation_check_catches_missing_files_bad_ranges_and_absolute_paths() {
    let d = fixture("check-cite");
    let md = "ok [[src/sync/queue.ts:10-20]] and [[src/main.ts]] and [[src/sync/queue.ts:5]]\n\
              missing [[src/gone.ts:1-2]] range [[src/sync/queue.ts:90-120]] backwards [[src/sync/queue.ts:20-10]] zero [[src/sync/queue.ts:0-3]]\n\
              abs [[/etc/passwd:1-2]] win [[C:\\Windows\\win.ini:1-2]] home [[~/x.ts]] up [[../outside.ts:1]] dir [[src/sync]]";
    let c = check_page(&d, md, 1);
    assert_eq!(c.good.len(), 3, "{:?}", c.bad);
    let problem = |raw: &str| c.bad.iter().find(|(x, _)| x.raw.contains(raw)).map(|(_, p)| p.clone());
    assert_eq!(problem("src/gone.ts"), Some(Problem::Missing));
    assert_eq!(problem("90-120"), Some(Problem::BadRange(100)));
    assert_eq!(problem("20-10"), Some(Problem::BadRange(100)));
    assert_eq!(problem("0-3"), Some(Problem::BadRange(100)));
    assert_eq!(problem("/etc/passwd"), Some(Problem::Absolute));
    assert_eq!(problem("C:"), Some(Problem::Absolute));
    assert_eq!(problem("~/x.ts"), Some(Problem::Absolute));
    assert_eq!(problem("../outside"), Some(Problem::Escapes));
    assert_eq!(problem("[[src/sync]]"), Some(Problem::Missing), "a folder is not a file");
    assert!(!c.passes());
    let cut = strip_bad(md, &c);
    assert!(cut.contains("[[src/sync/queue.ts:10-20]]") && !cut.contains("gone.ts") && !cut.contains("passwd"));
    assert!(check_page(&d, &cut, 1).passes());
    assert_eq!(cited_paths(&c), vec!["src/sync/queue.ts".to_string(), "src/main.ts".to_string()]);
}

#[test]
fn a_page_needs_enough_distinct_cited_files() {
    let d = fixture("check-few");
    assert!(check_page(&d, "no citations at all", 1).too_few);
    assert!(check_page(&d, "[[src/main.ts]] [[src/main.ts:1-2]]", 2).too_few);
    assert!(check_page(&d, "[[src/main.ts]] [[src/sync/net.ts]]", 2).passes());
}

#[test]
fn a_link_that_leaves_the_project_is_refused() {
    // Only where a link can be made (Windows needs a privilege): the check must refuse it when it can.
    let d = project("check-link");
    let outside = project("check-link-outside");
    put(&outside, "secret.txt", "top secret\n");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, d.join("out")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(&outside, d.join("out")).is_err() {
        return;
    }
    assert_eq!(check_citation(&d, &parse_citations("[[out/secret.txt:1]]")[0]), Err(Problem::Escapes));
}

fn page(id: &str, files: &[&str]) -> OutlinePage {
    OutlinePage { id: id.into(), title: id.into(), purpose: "p".into(), files: files.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn the_outline_check_refuses_bad_ids_missing_files_and_dropped_important_files() {
    let d = fixture("check-outline");
    let good = Outline { pages: vec![page("overview", &["README.md", "src/main.ts"]), page("sync", &["src/sync/queue.ts"])] };
    assert!(check_outline(&d, &good, &["README.md".into()]).is_ok());
    for bad in ["Overview", "a/b", "../x", "a b", "", "-x", "ÿ", &"a".repeat(49)] {
        let o = Outline { pages: vec![page(bad, &["README.md"])] };
        assert!(check_outline(&d, &o, &[]).is_err(), "{bad:?}");
    }
    let twice = Outline { pages: vec![page("a", &["README.md"]), page("a", &["README.md"])] };
    assert!(check_outline(&d, &twice, &[]).unwrap_err().iter().any(|e| e.contains("twice")));
    let missing = Outline { pages: vec![page("a", &["nope.ts", "/abs", "../up"])] };
    assert_eq!(check_outline(&d, &missing, &[]).unwrap_err().len(), 3);
    let dropped = check_outline(&d, &good, &["package.json".into()]).unwrap_err();
    assert!(dropped[0].contains("package.json"));
    let many = Outline { pages: (0..31).map(|i| page(&format!("p{i}"), &["README.md"])).collect() };
    assert!(check_outline(&d, &many, &[]).unwrap_err().iter().any(|e| e.contains("31 pages")));
    assert!(check_outline(&d, &Outline::default(), &[]).is_err());
}

fn node(id: &str, label: &str, shape: &str) -> Node {
    Node { id: id.into(), label: label.into(), shape: shape.into(), ..Default::default() }
}

#[test]
fn the_graph_check_refuses_dangling_arrows_bad_paths_and_too_many_boxes() {
    let d = fixture("check-graph");
    let mut g = Graph { nodes: vec![node("a", "A", "box"), node("b", "B", "db")], edges: vec![Edge { from: "a".into(), to: "b".into(), label: None }], groups: vec![] };
    assert!(check_graph(&d, &g, &[]).is_ok());
    g.edges.push(Edge { from: "a".into(), to: "zzz".into(), label: None });
    assert!(check_graph(&d, &g, &[]).unwrap_err()[0].contains("zzz"));
    g.edges.pop();
    g.nodes[0].path = Some("nope/missing.ts".into());
    assert!(check_graph(&d, &g, &[]).is_err());
    g.nodes[0].path = Some("src/sync".into());
    assert!(check_graph(&d, &g, &[]).is_ok(), "a folder is a fine target");
    g.nodes[0].page = Some("ghost".into());
    assert!(check_graph(&d, &g, &["overview".into()]).is_err());
    g.nodes[0].page = None;
    g.nodes[1].id = "A B".into();
    assert!(check_graph(&d, &g, &[]).is_err());
    g.nodes[1].id = "a".into();
    assert!(check_graph(&d, &g, &[]).unwrap_err().iter().any(|e| e.contains("twice")));
    g.nodes[1].id = "b".into();
    g.nodes[1].shape = "star".into();
    assert!(check_graph(&d, &g, &[]).is_err());
    let big = Graph { nodes: (0..41).map(|i| node(&format!("n{i}"), "x", "box")).collect(), ..Default::default() };
    assert!(check_graph(&d, &big, &[]).unwrap_err().iter().any(|e| e.contains("41 boxes")));
}

// ---------------------------------------------------------------- mermaid

fn line_ok(line: &str) -> bool {
    let x = r"[\p{L}\p{N} .,_/+()-]+";
    let shapes = format!(r#"(\["{x}"\]|\("{x}"\)|\[\("{x}"\)\]|\(\("{x}"\)\)|\{{\{{"{x}"\}}\}})"#);
    let patterns = [
        r"^flowchart LR$".to_string(),
        format!(r#"^  subgraph g\d+\["{x}"\]$"#),
        r"^  end$".to_string(),
        format!(r"^ {{2,4}}n\d+{shapes}$"),
        format!(r#"^  n\d+ -->(\|"{x}"\|)? n\d+$"#),
    ];
    patterns.iter().any(|p| Regex::new(p).unwrap().is_match(line))
}

#[test]
fn the_compiler_output_is_safe_and_well_formed_for_twenty_hostile_graphs() {
    let hostile = [
        "\"]; click x href \"javascript:alert(1)",
        "<img src=x onerror=alert(1)>",
        "%%{init: {\"securityLevel\":\"loose\"}}%%",
        "a\nb --> c\nclick a href \"http://evil\"",
        "end",
        "x\"]\n    subgraph evil[\"",
        "`code` | pipe & amp ; semi # hash",
        "",
    ];
    let mut fixtures = 0;
    for (si, shape) in ["box", "round", "db", "circle", "hex"].iter().enumerate() {
        for label in hostile.iter().take(4).chain(hostile.iter().skip(4 + si % 2).take(2)) {
            let g = Graph {
                groups: vec![Group { id: "g".into(), label: label.to_string() }],
                nodes: vec![
                    Node { group: Some("g".into()), ..node("a", label, shape) },
                    node("b", label, shape),
                ],
                edges: vec![Edge { from: "a".into(), to: "b".into(), label: Some(label.to_string()) }, Edge { from: "b".into(), to: "a".into(), label: None }],
            };
            let out = compile(&g);
            fixtures += 1;
            for line in out.lines() {
                assert!(line_ok(line), "line not in the output grammar: {line:?}\nlabel {label:?}\n{out}");
                let t = line.trim_start();
                assert!(!t.starts_with("click") && !t.starts_with("%%") && !t.starts_with("linkStyle") && !t.starts_with("classDef"), "{line}");
            }
            assert!(!out.contains("javascript:") && !out.contains("href=") && !out.contains('<'), "{out}");
            assert_eq!(out.matches('>').count(), out.matches("-->").count(), "{out}");
            assert!(!out.contains("://") && !out.contains("http:"), "{out}");
        }
    }
    assert!(fixtures >= 20, "{fixtures}");
}

#[test]
fn compiled_boxes_do_not_use_the_agents_ids_and_a_dangling_edge_is_dropped() {
    let g = Graph {
        nodes: vec![node("overview", "Overview", "box")],
        edges: vec![Edge { from: "overview".into(), to: "ghost".into(), label: None }],
        groups: vec![],
    };
    let out = compile(&g);
    assert_eq!(out, "flowchart LR\n  n0[\"Overview\"]\n");
    assert_eq!(safe_label(""), "?");
    assert_eq!(safe_label(&"x".repeat(100)).len(), 40);
}

// ---------------------------------------------------------------- store

#[test]
fn page_ids_outside_a_to_z_0_to_9_and_dashes_are_refused_everywhere() {
    let d = project("store-ids");
    for bad in ["../x", "a/b", "A", "a_b", "", "a.md", "..", "a\\b"] {
        assert!(!valid_id(bad), "{bad:?}");
        assert!(write_page(&d, bad, "x").is_err(), "{bad:?}");
        assert!(read_page(&d, bad).is_none());
        assert!(super::read::page(&d, bad).is_none());
    }
    write_page(&d, "how-to-run", "# x").unwrap();
    assert_eq!(read_page(&d, "how-to-run").as_deref(), Some("# x"));
    assert!(guide_dir(&d).join("pages").join("how-to-run.md").is_file());
}

#[test]
fn deleting_the_guide_only_removes_the_guide_folder() {
    let d = fixture("store-delete");
    write_page(&d, "overview", "x").unwrap();
    put(&d, ".potato/artifacts/keep/meta.json", "{}");
    assert!(delete_guide(&d).unwrap());
    assert!(!guide_dir(&d).exists());
    assert!(d.join(".potato/artifacts/keep/meta.json").is_file() && d.join("README.md").is_file());
    assert!(!delete_guide(&d).unwrap());
}

// ---------------------------------------------------------------- stale

fn rec(id: &str, d: &Path, files: &[&str]) -> PageRecord {
    PageRecord {
        id: id.into(),
        title: id.into(),
        purpose: String::new(),
        cited: files.iter().map(|f| Cited { path: f.to_string(), hash: file_hash(d, f).unwrap() }).collect(),
        needs_review: false,
    }
}

#[test]
fn the_stale_set_is_exactly_the_pages_citing_a_changed_file() {
    let d = fixture("stale");
    let m = Manifest {
        pages: vec![rec("overview", &d, &["README.md", "src/main.ts"]), rec("sync", &d, &["src/sync/queue.ts", "src/sync/net.ts"]), rec("ui", &d, &["src/ui/app.ts"])],
        diagram: Some(DiagramRecord { cited: vec![Cited { path: "src/ui/button.ts".into(), hash: file_hash(&d, "src/ui/button.ts").unwrap() }] }),
        ..Default::default()
    };
    assert!(stale_pages(&d, &m).is_empty() && !diagram_stale(&d, &m));
    put(&d, "src/sync/queue.ts", "changed\n");
    assert_eq!(stale_pages(&d, &m), vec![Stale { id: "sync".into(), changed: vec!["src/sync/queue.ts".into()] }]);
    // A file that is gone counts as changed; an untouched page stays fresh.
    fs::remove_file(d.join("README.md")).unwrap();
    let ids: Vec<String> = stale_pages(&d, &m).into_iter().map(|s| s.id).collect();
    assert_eq!(ids, vec!["overview", "sync"]);
    // Touching a file with the same bytes is not a change.
    put(&d, "src/ui/app.ts", &fs::read_to_string(d.join("src/ui/app.ts")).unwrap());
    assert!(!ids.contains(&"ui".to_string()));
    assert!(!diagram_stale(&d, &m));
    put(&d, "src/ui/button.ts", "new\n");
    assert!(diagram_stale(&d, &m));
}

// ---------------------------------------------------------------- consent

#[test]
fn a_run_needs_a_token_that_works_once_for_one_project_for_thirty_minutes() {
    let a = fixture("consent-a");
    let b = fixture("consent-b");
    assert!(start_checked(&a, "").is_err());
    assert!(start_checked(&a, "made-up").unwrap_err().starts_with("GUIDE_NO_CONSENT"));
    let t = issue_token(&a);
    assert!(!consume_token(&b, &t), "another project's token");
    assert!(start_checked(&a, &t).is_ok());
    assert!(start_checked(&a, &t).is_err(), "used up");
    let old = issue_token_at(&a, 1_000);
    assert!(!consume_token_at(&a, &old, 1_000 + 31 * 60 * 1000), "expired");
    let fresh = issue_token_at(&a, 5_000);
    assert!(consume_token_at(&a, &fresh, 5_000 + 29 * 60 * 1000));
}

#[test]
fn the_estimate_is_a_range_in_chats_and_says_it_is_not_measured() {
    let d = fixture("estimate");
    let scan = scan_with(&d, &Steering::default(), None);
    let e = estimate_for(&scan, Size::Normal, "t".into());
    assert!(e.too_small, "{} source files", scan.source_count());
    assert_eq!(e.project_size, "small");
    assert!(!e.measured && e.chats_lo >= 1 && e.chats_hi >= e.chats_lo && e.pages_hi >= e.pages_lo);
    assert!(e.files_skipped >= 3 && e.skipped_by_reason.get("secret") == Some(&2));
    let short = estimate_for(&scan, Size::Short, "t".into());
    let deep = estimate_for(&scan, Size::Deep, "t".into());
    assert!(short.pages_hi <= e.pages_hi && e.pages_hi <= deep.pages_hi && deep.pages_hi <= MAX_PAGES);
}

// ---------------------------------------------------------------- run

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Good,
    BadThenGood,
    AlwaysBad,
    BadOutline,
}

struct Fake {
    mode: Mode,
    calls: AtomicUsize,
    page_asks: Mutex<HashMap<String, usize>>,
    /// Flip this when the Nth page ask comes in (a stop in the middle).
    stop_at_page_ask: Option<(usize, Arc<AtomicBool>)>,
    secret_in_pages: bool,
}

impl Fake {
    fn new(mode: Mode) -> Self {
        Self { mode, calls: AtomicUsize::new(0), page_asks: Mutex::new(HashMap::new()), stop_at_page_ask: None, secret_in_pages: false }
    }
    fn total_page_asks(&self) -> usize {
        self.page_asks.lock().values().sum()
    }
}

impl GuideAgent for Fake {
    fn label(&self) -> String {
        "fake".into()
    }
    fn ask(&self, task: &str, project: &Path, stop: &AtomicBool) -> Result<Reply, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let good = DryRunAgent.ask(task, project, stop)?;
        if task.starts_with(TASK_OUTLINE) && self.mode == Mode::BadOutline {
            return Ok(Reply { text: "{\"pages\":[{\"id\":\"Bad Id\",\"title\":\"x\",\"files\":[\"nope.ts\"]}]}".into(), tokens: None });
        }
        if let Some(id) = task.strip_prefix(TASK_PAGE).map(|r| r.lines().next().unwrap().trim().to_string()) {
            let n = {
                let mut asks = self.page_asks.lock();
                let n = asks.entry(id).or_insert(0);
                *n += 1;
                *n
            };
            if let Some((at, flag)) = &self.stop_at_page_ask {
                if self.total_page_asks() >= *at {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            let bad = Reply { text: "A claim with no real source. [[nope/missing.ts:1-3]] [[/etc/passwd:1]]".into(), tokens: Some(10) };
            return Ok(match self.mode {
                Mode::AlwaysBad => bad,
                Mode::BadThenGood if n == 1 => bad,
                _ if self.secret_in_pages => Reply { text: format!("{} Key: sk-abcdefghijklmnop1234", good.text), tokens: Some(10) },
                _ => good,
            });
        }
        let _ = TASK_GRAPH;
        Ok(good)
    }
}

fn run_fresh(name: &str, fake: &Fake, parallel: usize) -> (PathBuf, Result<Manifest, String>, Progress) {
    let d = fixture(name);
    let progress = Progress::new();
    let stop = AtomicBool::new(false);
    let opts = RunOptions { parallel, ..Default::default() };
    let result = generate(&d, fake, &opts, &progress, &stop);
    (d, result, progress)
}

#[test]
fn a_good_agent_gives_pages_a_diagram_and_a_manifest_with_hashes() {
    let fake = Fake::new(Mode::Good);
    let (d, result, progress) = run_fresh("run-good", &fake, 3);
    let m = result.unwrap();
    assert!(m.complete && m.agent == "fake" && m.pages.len() >= 2, "{m:?}");
    for p in &m.pages {
        assert!(!p.needs_review && !p.cited.is_empty(), "{p:?}");
        assert!(read_page(&d, &p.id).unwrap().contains("[["));
        assert!(p.cited.iter().all(|c| c.hash.len() == 16));
    }
    assert!(m.diagram.is_some() && read_diagram(&d).unwrap().starts_with("flowchart LR"));
    assert_eq!(read_graph(&d).unwrap().nodes.len(), m.pages.len());
    let s = progress.snapshot();
    assert_eq!((s.phase.as_str(), s.pages_done, s.pages_total), ("done", m.pages.len(), m.pages.len()));
    assert!(s.tokens > 0 && m.tokens == Some(s.tokens) && s.finished_ms.is_some());
    // One outline + one ask per page + one diagram.
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2 + m.pages.len());
    // Reading it back: nothing is stale yet.
    let st = super::read::structure(&d).unwrap();
    assert!(st.complete && st.diagram && st.pages.iter().all(|p| !p.stale));
    assert!(super::read::diagram(&d).unwrap().boxes.iter().all(|b| b.path.is_some()));
}

#[test]
fn a_page_that_is_bad_first_and_good_on_the_retry_passes() {
    let fake = Fake::new(Mode::BadThenGood);
    let (_d, result, _p) = run_fresh("run-retry", &fake, 3);
    let m = result.unwrap();
    assert!(m.complete && m.pages.iter().all(|p| !p.needs_review), "{m:?}");
    assert_eq!(fake.total_page_asks(), m.pages.len() * 2, "each page asked exactly twice");
}

#[test]
fn a_page_that_is_always_bad_ends_needs_review_with_the_bad_citations_cut_and_the_run_still_finishes() {
    let fake = Fake::new(Mode::AlwaysBad);
    let (d, result, progress) = run_fresh("run-bad", &fake, 3);
    let m = result.unwrap();
    assert!(m.complete, "the run finishes");
    assert_eq!(progress.snapshot().phase, "done");
    for p in &m.pages {
        assert!(p.needs_review && p.cited.is_empty(), "{p:?}");
        let text = read_page(&d, &p.id).unwrap();
        assert!(!text.contains("nope/missing") && !text.contains("/etc/passwd") && text.contains("A claim"), "{text}");
    }
    assert_eq!(fake.total_page_asks(), m.pages.len() * 2, "one retry only");
    assert!(super::read::structure(&d).unwrap().pages.iter().all(|p| p.needs_review));
}

#[test]
fn an_outline_that_never_passes_fails_the_run_and_writes_no_pages() {
    let fake = Fake::new(Mode::BadOutline);
    let (d, result, progress) = run_fresh("run-outline", &fake, 3);
    assert!(result.unwrap_err().contains("outline did not pass"));
    assert_eq!(progress.snapshot().phase, "failed");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2, "one try and one retry, then stop");
    assert!(!has_guide(&d) && read_page(&d, "overview").is_none());
}

#[test]
fn stop_keeps_the_finished_pages_and_resume_finishes_only_the_rest() {
    let d = fixture("run-stop");
    let flag = Arc::new(AtomicBool::new(false));
    let mut fake = Fake::new(Mode::Good);
    fake.stop_at_page_ask = Some((2, flag.clone()));
    let progress = Progress::new();
    let opts = RunOptions { parallel: 1, ..Default::default() };
    let m = generate(&d, &fake, &opts, &progress, &flag).unwrap();
    assert!(!m.complete && m.pages.len() == 1, "{m:?}");
    assert_eq!(progress.snapshot().phase, "stopped");
    assert!(read_page(&d, &m.pages[0].id).is_some() && m.diagram.is_none());
    // The manifest on disk says the same.
    assert!(!read_manifest(&d).unwrap().complete);
    // Resume: the outline and the finished page are kept.
    let outline_pages = read_outline(&d).unwrap().pages.len();
    let fake2 = Fake::new(Mode::Good);
    let resumed = generate(&d, &fake2, &RunOptions { parallel: 1, resume: true, ..Default::default() }, &Progress::new(), &AtomicBool::new(false)).unwrap();
    assert!(resumed.complete && resumed.pages.len() == outline_pages);
    assert_eq!(fake2.total_page_asks(), outline_pages - 1);
    assert!(resumed.diagram.is_some());
}

#[test]
fn a_secret_in_an_answer_is_redacted_before_the_page_is_saved() {
    let mut fake = Fake::new(Mode::Good);
    fake.secret_in_pages = true;
    let (d, result, _p) = run_fresh("run-redact", &fake, 2);
    let m = result.unwrap();
    for p in &m.pages {
        assert!(!read_page(&d, &p.id).unwrap().contains("sk-abcdefghijklmnop1234"));
    }
}

#[test]
fn refresh_rewrites_only_the_stale_pages_and_the_diagram_only_if_a_file_on_it_changed() {
    let fake = Fake::new(Mode::Good);
    let (d, result, _p) = run_fresh("run-refresh", &fake, 3);
    let m = result.unwrap();
    let nothing = Fake::new(Mode::Good);
    let r = refresh(&d, &nothing, &RunOptions::default(), &Progress::new(), &AtomicBool::new(false)).unwrap();
    assert_eq!((r.rewritten.len(), r.diagram, nothing.calls.load(Ordering::SeqCst)), (0, false, 0), "a fresh guide costs nothing");

    // Change a file that exactly one page cites and that is not on the diagram.
    let on_diagram: Vec<String> = m.diagram.as_ref().unwrap().cited.iter().map(|c| c.path.clone()).collect();
    let all: Vec<String> = m.pages.iter().flat_map(|p| p.cited.iter().map(|c| c.path.clone())).collect();
    let pick = all.iter().find(|p| !on_diagram.contains(p) && all.iter().filter(|x| x == p).count() == 1).cloned().expect("a file on one page only");
    put(&d, &pick, &format!("{}\nmore\n", fs::read_to_string(d.join(&pick)).unwrap()));
    let expected: Vec<String> = m.pages.iter().filter(|p| p.cited.iter().any(|c| c.path == pick)).map(|p| p.id.clone()).collect();
    assert_eq!(expected.len(), 1);
    let counting = Fake::new(Mode::Good);
    let r = refresh(&d, &counting, &RunOptions::default(), &Progress::new(), &AtomicBool::new(false)).unwrap();
    assert_eq!(r.rewritten, expected);
    assert!(!r.diagram);
    assert_eq!(counting.total_page_asks(), 1, "one page asked, not the whole guide");
    assert_eq!(counting.calls.load(Ordering::SeqCst), 1);
    let after = super::read::structure(&d).unwrap();
    assert!(after.pages.iter().all(|p| !p.stale), "the rewritten page is fresh again");

    // Now a file on the diagram changes: the diagram is redrawn too.
    let first = on_diagram[0].clone();
    put(&d, &first, &format!("{}\nmore\n", fs::read_to_string(d.join(&first)).unwrap()));
    let again = Fake::new(Mode::Good);
    let r = refresh(&d, &again, &RunOptions::default(), &Progress::new(), &AtomicBool::new(false)).unwrap();
    assert!(r.diagram && !r.rewritten.is_empty());
}

#[test]
fn the_stale_page_text_for_an_agent_starts_with_a_warning_naming_the_files() {
    let fake = Fake::new(Mode::Good);
    let (d, result, _p) = run_fresh("read-stale", &fake, 3);
    let m = result.unwrap();
    let id = m.pages[0].id.clone();
    let file = m.pages[0].cited[0].path.clone();
    let fresh = super::read::page(&d, &id).unwrap();
    assert!(!fresh.stale && !super::read::page_for_agent(&fresh).starts_with("Parts of this page"));
    put(&d, &file, "different now\n");
    let stale = super::read::page(&d, &id).unwrap();
    assert!(stale.stale && stale.changed.contains(&file));
    assert!(super::read::page_for_agent(&stale).starts_with(&format!("Parts of this page may be out of date: {file}")));
}

#[test]
fn nothing_in_the_module_commits_or_pushes() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("project_guide");
    let (push, commit) = (["pu", "sh"].concat(), ["comm", "it"].concat());
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.file_name().is_some_and(|n| n == "tests.rs") || path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        for needle in [format!("\"{push}\""), format!("\"{commit}\"")] {
            assert!(!text.contains(&needle), "{} uses git {needle}", path.display());
        }
    }
}

#[test]
fn the_dry_run_agent_only_exists_where_the_build_allows_it() {
    assert_eq!(super::dry::dry_run_allowed(), cfg!(debug_assertions) || std::env::var("PM_GUIDE_DRY_RUN").is_ok_and(|v| v == "1"));
}
