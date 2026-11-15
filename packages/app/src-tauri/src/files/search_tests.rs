use super::*;
use std::path::{Path, PathBuf};

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("potato-fsearch-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn git(dir: &Path, args: &[&str]) -> bool {
    crate::proc_util::hidden_command("git").args(args).current_dir(dir).output().map(|o| o.status.success()).unwrap_or(false)
}

fn run(root: &Path, folder: Option<&str>, q: &str) -> Result<ContentSearch, String> {
    search_contents(s(root), folder, q, &AtomicBool::new(false))
}

#[test]
fn it_finds_a_line_ignoring_case_and_says_where_the_match_is() {
    let dir = scratch("basic");
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("src/a.ts"), "one\n  const Hello = 1;\nthree\n").unwrap();
    let found = run(&dir, None, "hello").unwrap();
    assert_eq!(found.hits.len(), 1);
    let hit = &found.hits[0];
    assert_eq!((hit.path.as_str(), hit.name.as_str(), hit.line), ("src/a.ts", "a.ts", 2));
    assert_eq!(hit.text, "const Hello = 1;");
    assert_eq!(&hit.text[hit.start as usize..hit.end as usize], "Hello");
    assert!(!found.truncated && !found.cancelled);
}

#[test]
fn a_file_that_git_ignores_is_not_searched() {
    let dir = scratch("gitignore");
    if !git(&dir, &["init", "-q"]) {
        return; // no git on this machine: the plain-walk fallback has no .gitignore
    }
    fs::write(dir.join(".gitignore"), "secret.log\nbuild/\n").unwrap();
    fs::write(dir.join("secret.log"), "needle here\n").unwrap();
    fs::create_dir_all(dir.join("build")).unwrap();
    fs::write(dir.join("build/out.js"), "needle here\n").unwrap();
    fs::write(dir.join("keep.txt"), "needle here\n").unwrap();
    let found = run(&dir, None, "needle").unwrap();
    let paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, vec!["keep.txt"]);
}

#[test]
fn a_binary_file_and_a_file_over_two_megabytes_are_skipped() {
    let dir = scratch("skip");
    fs::write(dir.join("bin.dat"), b"needle\0\x01\x02").unwrap();
    let mut big = b"needle\n".to_vec();
    big.resize((MAX_READ_BYTES + 10) as usize, b'x');
    fs::write(dir.join("big.txt"), big).unwrap();
    fs::write(dir.join("ok.txt"), "needle\n").unwrap();
    let found = run(&dir, None, "needle").unwrap();
    let paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, vec!["ok.txt"]);
    assert_eq!(found.files_scanned, 1);
}

#[test]
fn the_results_stop_at_the_cap_and_say_so() {
    let dir = scratch("cap");
    let text: String = (0..MAX_HITS + 50).map(|i| format!("needle {i}\n")).collect();
    fs::write(dir.join("many.txt"), text).unwrap();
    let found = run(&dir, None, "needle").unwrap();
    assert_eq!(found.hits.len(), MAX_HITS);
    assert!(found.truncated);
    assert_eq!(found.hits.last().unwrap().line as usize, MAX_HITS);
}

#[test]
fn a_cancelled_search_stops_and_says_so() {
    let dir = scratch("cancel");
    fs::write(dir.join("a.txt"), "needle\n").unwrap();
    let flag = AtomicBool::new(true);
    let found = search_contents(s(&dir), None, "needle", &flag).unwrap();
    assert!(found.cancelled);
    assert!(found.hits.is_empty());
}

#[test]
fn a_newer_search_with_the_same_id_cancels_the_older_one() {
    let first = begin_search("pane-x");
    assert!(!first.load(Ordering::Relaxed));
    let second = begin_search("pane-x");
    assert!(first.load(Ordering::Relaxed), "the older search was told to stop");
    assert!(!second.load(Ordering::Relaxed));
    cancel_search("pane-x");
    assert!(second.load(Ordering::Relaxed));
    end_search("pane-x", &first); // an old search ending does not forget the newer one
    cancel_search("pane-x");
    end_search("pane-x", &second);
}

#[test]
fn a_folder_outside_the_project_is_refused() {
    let dir = scratch("escape");
    let other = scratch("escape-other");
    fs::write(other.join("x.txt"), "needle\n").unwrap();
    let err = run(&dir, Some("../x"), "needle").unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
    let err = run(&dir, Some(s(&other)), "needle").unwrap_err();
    assert!(err.starts_with("FILES_OUTSIDE"), "{err}");
}

#[test]
fn a_listed_path_that_leaves_the_project_is_never_read() {
    let dir = scratch("listed");
    let other = scratch("listed-other");
    fs::write(other.join("secret.txt"), "needle\n").unwrap();
    fs::write(dir.join("in.txt"), "needle\n").unwrap();
    let paths = vec!["../".to_string() + other.file_name().unwrap().to_str().unwrap() + "/secret.txt", s(&other.join("secret.txt")).to_string(), "in.txt".to_string()];
    let found = scan(s(&dir), &paths, "needle", &AtomicBool::new(false));
    let hit_paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(hit_paths, vec!["in.txt"]);
}

#[test]
fn a_link_that_leads_out_is_not_searched() {
    let dir = scratch("link");
    let other = scratch("link-other");
    fs::write(other.join("secret.txt"), "needle\n").unwrap();
    fs::write(dir.join("ok.txt"), "needle\n").unwrap();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&other, dir.join("out")).is_ok()
        || crate::proc_util::hidden_command("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("out")).arg(&other).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&other, dir.join("out")).is_ok();
    assert!(made, "this machine cannot make a link, so the test proves nothing");
    let found = run(&dir, None, "needle").unwrap();
    let paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, vec!["ok.txt"]);
}

#[test]
fn a_folder_scope_only_searches_inside_it() {
    let dir = scratch("scope");
    fs::create_dir_all(dir.join("a")).unwrap();
    fs::create_dir_all(dir.join("ab")).unwrap();
    fs::write(dir.join("a/in.txt"), "needle\n").unwrap();
    fs::write(dir.join("ab/near.txt"), "needle\n").unwrap();
    fs::write(dir.join("top.txt"), "needle\n").unwrap();
    let found = run(&dir, Some("a"), "needle").unwrap();
    let paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, vec!["a/in.txt"]);
}

#[test]
fn a_long_line_is_cut_around_the_match() {
    let dir = scratch("long");
    let line = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
    fs::write(dir.join("long.txt"), line).unwrap();
    let hit = run(&dir, None, "needle").unwrap().hits.remove(0);
    assert!(hit.text.chars().count() <= MAX_LINE_CHARS);
    let shown: String = hit.text.chars().skip(hit.start as usize).take((hit.end - hit.start) as usize).collect();
    assert_eq!(shown, "needle");
}

#[test]
fn an_empty_query_finds_nothing() {
    let dir = scratch("empty");
    fs::write(dir.join("a.txt"), "x\n").unwrap();
    assert!(run(&dir, None, "   ").unwrap().hits.is_empty());
}
