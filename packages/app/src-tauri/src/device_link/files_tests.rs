//! Files between devices (phase 4): the path rules on the serving side, the archive, the streaming rule (a counted reader,
//! never a whole file in memory), and the story on the in-memory net: browse, copy to this PC, send a file there, resume
//! after a dropped link, never overwrite without a yes, both-side log lines with no names in them.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::files::{self, copy_exact, name_denied, rel_parts, unique_in, Deny, Refuse, Root, Sandbox, CHUNK, DROP_AFTER};
use super::tests::{instance_with, pair, real_now, Instance};
use super::Options;
use crate::p2p::pairing::SystemClock;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-files-test-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, rel: &str, bytes: &[u8]) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

fn sandbox(dir: &Path) -> Sandbox {
    Sandbox::new(vec![Root { name: "proj".into(), path: dir.to_path_buf() }], Deny::new(&[]))
}

// ----- path rules -----

#[test]
fn a_path_with_dots_drives_or_device_names_is_refused_here_on_the_serving_side() {
    for bad in ["../x", "a/../../x", "/etc/passwd", "C:/Windows", "C:\\Windows", "\\\\server\\share", "a\\b", "nul", "CON.txt", "dir/com1", "a/lpt9.log", "x:y", "a*b", "name.", "name "] {
        assert_eq!(rel_parts(bad), Err(Refuse::BadPath), "{bad:?} must be refused");
    }
    assert_eq!(rel_parts("a/b/./c.txt").unwrap(), vec!["a", "b", "c.txt"]);
    assert_eq!(rel_parts("").unwrap(), Vec::<&str>::new());
}

#[test]
fn sign_ins_and_keys_are_never_served_by_name() {
    for n in [".claude", ".codex", ".ssh", ".aws", "credentials.json", ".credentials.json", "auth.json", "id_rsa", "id_ed25519.pub", "server.pem", "my.key", ".env", ".env.local", ".npmrc"] {
        assert!(name_denied(n), "{n}");
    }
    for n in ["main.rs", "README.md", ".env.example", "keyboard.txt", "notes.txt", ".gitignore"] {
        assert!(!name_denied(n), "{n}");
    }
}

#[test]
fn the_sandbox_stays_inside_its_folder_and_off_the_deny_list() {
    let dir = scratch("sandbox");
    write(&dir, "src/main.rs", b"fn main() {}");
    write(&dir, ".ssh/id_rsa", b"secret");
    write(&dir, ".claude/settings.json", b"{}");
    write(&dir, "notes/token.pem", b"secret");
    let sb = sandbox(&dir);
    assert!(sb.existing("proj", "src/main.rs", false).is_ok());
    assert_eq!(sb.existing("proj", "../x", false), Err(Refuse::BadPath));
    assert_eq!(sb.existing("proj", "C:/Windows", false), Err(Refuse::BadPath));
    assert_eq!(sb.existing("other", "src", false), Err(Refuse::NoRoot));
    assert_eq!(sb.existing("proj", ".ssh/id_rsa", false), Err(Refuse::NotShared));
    assert_eq!(sb.existing("proj", ".claude", false), Err(Refuse::NotShared));
    assert_eq!(sb.existing("proj", "notes/token.pem", false), Err(Refuse::NotShared));
    // Nothing may be written inside .git, or under a denied name.
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    assert_eq!(sb.new_file("proj", ".git/hooks"), Err(Refuse::NotShared));
    assert_eq!(sb.new_file("proj", "id_rsa"), Err(Refuse::NotShared));
    assert_eq!(sb.new_file("proj", "missing-dir/a.txt"), Err(Refuse::NotFound));
    assert!(sb.new_file("proj", "fresh.txt").is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_link_that_points_out_of_the_folder_is_refused_after_it_is_resolved() {
    let dir = scratch("links");
    let outside = scratch("outside");
    write(&outside, "secret.txt", b"nope");
    let link = dir.join("out");
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
    if !made {
        // Making a link needs a privilege on some Windows setups: the rule is still covered by the checks above.
        eprintln!("(no link could be made here; skipped)");
        return;
    }
    let sb = sandbox(&dir);
    assert_eq!(sb.existing("proj", "out/secret.txt", false), Err(Refuse::NotShared));
    assert_eq!(sb.existing("proj", "out", false), Err(Refuse::NotShared));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn a_taken_name_gets_a_number_and_keeps_its_ending() {
    let dir = scratch("unique");
    write(&dir, "a.txt", b"1");
    assert_eq!(unique_in(&dir, "b.txt"), dir.join("b.txt"));
    assert_eq!(unique_in(&dir, "a.txt"), dir.join("a (2).txt"));
    write(&dir, "a (2).txt", b"2");
    assert_eq!(unique_in(&dir, "a.txt"), dir.join("a (3).txt"));
    let _ = std::fs::remove_dir_all(&dir);
}

// ----- the archive -----

#[test]
fn an_archive_leaves_out_sign_ins_and_unpacks_into_a_new_folder_without_overwriting() {
    let dir = scratch("arch");
    write(&dir, "app/src/a.rs", b"fn a() {}");
    write(&dir, "app/README.md", b"hello");
    write(&dir, "app/.env", b"TOKEN=1");
    write(&dir, "app/keys/server.pem", b"secret");
    let sb = sandbox(&dir);
    let out = dir.join("out.pmar");
    files::build_archive(&sb, "proj", &["app".into()], true, &out).unwrap();
    let dest = scratch("dest");
    assert_eq!(files::unpack(&out, &dest, false).unwrap(), 2);
    assert_eq!(std::fs::read(dest.join("src/a.rs")).unwrap(), b"fn a() {}");
    assert!(!dest.join(".env").exists() && !dest.join("keys/server.pem").exists());
    // A second unpack into the same folder never overwrites.
    assert_eq!(files::unpack(&out, &dest, false), Err(Refuse::Exists));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dest);
}

#[test]
fn a_hostile_archive_is_refused_before_anything_is_written() {
    let dest = scratch("hostile");
    for bad in ["../evil.txt", "a/../../evil.txt", "C:/evil.txt", "/abs.txt", "nul", ".git/hooks/pre-commit", ".ssh/id_rsa"] {
        let file = dest.join("bad.pmar");
        let mut w = files::ArchiveWriter::new(std::fs::File::create(&file).unwrap()).unwrap();
        w.file("good.txt", 2, &mut &b"ok"[..]).unwrap();
        w.file(bad, 3, &mut &b"bad"[..]).unwrap();
        w.finish().unwrap();
        let into = dest.join("into");
        std::fs::create_dir_all(&into).unwrap();
        assert!(files::unpack(&file, &into, true).is_err(), "{bad:?} must be refused");
        assert!(!into.join("good.txt").exists(), "the first file must not be written when a later name is bad ({bad:?})");
        let _ = std::fs::remove_dir_all(&into);
    }
    let _ = std::fs::remove_dir_all(&dest);
}

// ----- streaming: a counted reader, never a whole file -----

/// A reader of `left` zero bytes that never holds them, and notes the largest piece anyone asked of it.
struct Zeros {
    left: u64,
    largest: Arc<AtomicUsize>,
}

impl AsyncRead for Zeros {
    fn poll_read(mut self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let n = (buf.remaining() as u64).min(self.left) as usize;
        self.largest.fetch_max(buf.remaining(), Ordering::SeqCst);
        let fill = buf.initialize_unfilled_to(n);
        fill.fill(0);
        buf.advance(n);
        self.left -= n as u64;
        Poll::Ready(Ok(()))
    }
}

struct Count(Arc<AtomicU64>);

impl AsyncWrite for Count {
    fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        self.0.fetch_add(buf.len() as u64, Ordering::SeqCst);
        Poll::Ready(Ok(buf.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn a_two_gigabyte_file_streams_through_one_small_buffer() {
    const TWO_GB: u64 = 2 * 1024 * 1024 * 1024;
    let largest = Arc::new(AtomicUsize::new(0));
    let written = Arc::new(AtomicU64::new(0));
    let mut r = Zeros { left: TWO_GB, largest: largest.clone() };
    let mut w = Count(written.clone());
    let seen = Arc::new(AtomicU64::new(0));
    let seen2 = seen.clone();
    let copied = copy_exact(&mut r, &mut w, TWO_GB, &mut |piece| {
        assert!(piece.len() <= CHUNK);
        seen2.fetch_add(piece.len() as u64, Ordering::SeqCst);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(copied, TWO_GB);
    assert_eq!(written.load(Ordering::SeqCst), TWO_GB);
    assert_eq!(seen.load(Ordering::SeqCst), TWO_GB);
    assert!(largest.load(Ordering::SeqCst) <= CHUNK, "the reader was never asked for more than one buffer: {}", largest.load(Ordering::SeqCst));
    // A stream that ends early is an error, not a short file.
    let mut short = Zeros { left: 10, largest: Arc::default() };
    assert!(copy_exact(&mut short, &mut Count(Arc::default()), 11, &mut |_| Ok(())).await.is_err());
}

// ----- the story on the in-memory net -----

/// The tests that arm the link-drop hook share one lock, so no other read takes it.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Duo {
    _net: crate::p2p::memory::MemoryNet,
    /// The device that copies and sends.
    a: Instance,
    /// The device whose folders are shared.
    b: Instance,
    shared: PathBuf,
    downloads: PathBuf,
    a_node: String,
    b_node: String,
}

async fn duo(name: &str) -> Duo {
    let net = crate::p2p::memory::MemoryNet::new();
    let shared = scratch(&format!("{name}-b"));
    let downloads = scratch(&format!("{name}-a"));
    let mut b_options = Options::memory();
    let sh = shared.clone();
    b_options.project_folders = Arc::new(move || vec![sh.clone()]);
    let mut a_options = Options::memory();
    let dl = downloads.clone();
    a_options.downloads = Arc::new(move || dl.clone());
    let b = instance_with("beta", net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), b_options);
    let a = instance_with("alpha", net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), a_options);
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    Duo { _net: net, a, b, shared, downloads, a_node, b_node }
}

async fn done(a: &Instance, id: u64) -> Value {
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let row = a.link.view()["transfers"].as_array().and_then(|t| t.iter().find(|r| r["id"] == id).cloned());
        if let Some(r) = row {
            if r["state"] != "running" {
                return r;
            }
        }
        assert!(tokio::time::Instant::now() < end, "the transfer never finished");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn files_are_off_until_the_person_turns_them_on_and_a_path_escape_is_refused_on_the_far_side() {
    let d = duo("browse").await;
    write(&d.shared, "src/main.rs", b"fn main() {}");
    write(&d.shared, ".ssh/id_rsa", b"secret");
    write(&d.shared, "id_rsa", b"secret");
    write(&d.shared, "notes.txt", b"hello there");
    let shown = d.a.link.view();
    assert_eq!(shown["devices"][0]["lets_files"], false);
    // Off: the far device says so, in plain words.
    let off = d.a.link.far_roots(&d.b_node).await.unwrap();
    assert_eq!(off["ok"], false, "{off}");
    assert!(off["error"].as_str().unwrap().contains("does not let this PC use its files"), "{off}");
    // The person at B turns it on.
    d.b.link.set_files(&d.a_node, true).unwrap();
    assert_eq!(d.b.link.view()["devices"][0]["lets_files"], true);
    let roots = d.a.link.far_roots(&d.b_node).await.unwrap();
    let root = roots["roots"][0].as_str().unwrap().to_string();
    let top = d.a.link.far_list(&d.b_node, &root, "").await.unwrap();
    let names: Vec<&str> = top["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["src", "notes.txt"], "folders first, and nothing that holds a sign-in or a key");
    // Everything that reaches outside, or at a sign-in, is refused by B itself.
    for (path, code) in [("..", "BAD_PATH"), ("../x", "BAD_PATH"), ("C:/Windows", "BAD_PATH"), ("a\\b", "BAD_PATH"), ("nul", "BAD_PATH"), ("/etc", "BAD_PATH"), (".ssh", "NOT_SHARED"), ("id_rsa", "NOT_SHARED")] {
        let r = d.a.link.far_list(&d.b_node, &root, path).await.unwrap();
        assert_eq!((r["ok"].clone(), r["code"].as_str().unwrap_or("")), (json!(false), code), "{path}: {r}");
    }
    let other = d.a.link.far_list(&d.b_node, "Documents", "").await.unwrap();
    assert_eq!(other["code"], "NO_ROOT");
    let copy = d.a.link.far_copy(&d.b_node, &root, &["id_rsa".into()], None, "ask").await.unwrap();
    assert_eq!(copy["ok"], false);
    assert!(std::fs::read_dir(&d.downloads).unwrap().next().is_none(), "nothing was copied");
    // The refusals are lines on B's log: a kind, never a path.
    let log = d.b.link.activity(None).unwrap().to_string();
    assert!(log.contains("refused"), "{log}");
    assert!(!log.contains("id_rsa") && !log.contains(".ssh"), "{log}");
    // Preview: text, and a binary file says what it is.
    let p = d.a.link.far_preview(&d.b_node, &root, "notes.txt").await.unwrap();
    assert_eq!((p["kind"].as_str(), p["text"].as_str()), (Some("text"), Some("hello there")));
    // Turning the switch off closes the door at once.
    d.b.link.set_files(&d.a_node, false).unwrap();
    let after = d.a.link.far_list(&d.b_node, &root, "").await.unwrap();
    assert_eq!(after["ok"], false, "{after}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn copy_to_this_pc_checks_the_file_never_overwrites_without_a_yes_and_logs_on_both_sides_without_names() {
    let d = duo("copy").await;
    let body = pattern(300_000);
    write(&d.shared, "canary-report-7.bin", &body);
    d.b.link.set_files(&d.a_node, true).unwrap();
    let root = d.a.link.far_roots(&d.b_node).await.unwrap()["roots"][0].as_str().unwrap().to_string();
    let started = d.a.link.far_copy(&d.b_node, &root, &["canary-report-7.bin".into()], None, "ask").await.unwrap();
    let row = done(&d.a, started["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "done", "{row}");
    assert_eq!(std::fs::read(d.downloads.join("canary-report-7.bin")).unwrap(), body);
    assert!(!d.downloads.join("canary-report-7.bin.pm-part").exists(), "no part file is left");
    // The name is taken: nothing happens until the person says what to do.
    let again = d.a.link.far_copy(&d.b_node, &root, &["canary-report-7.bin".into()], None, "ask").await.unwrap();
    assert_eq!(again["exists"], true, "{again}");
    assert_eq!(std::fs::read(d.downloads.join("canary-report-7.bin")).unwrap(), body);
    // Keep both: a second file with a number.
    let both = d.a.link.far_copy(&d.b_node, &root, &["canary-report-7.bin".into()], None, "both").await.unwrap();
    let row = done(&d.a, both["id"].as_u64().unwrap()).await;
    assert_eq!(row["saved_as"], "canary-report-7 (2).bin");
    assert!(d.downloads.join("canary-report-7 (2).bin").exists());
    // Replace: only now is the first one written over.
    write(&d.shared, "canary-report-7.bin", b"newer");
    let replaced = d.a.link.far_copy(&d.b_node, &root, &["canary-report-7.bin".into()], None, "replace").await.unwrap();
    assert_eq!(done(&d.a, replaced["id"].as_u64().unwrap()).await["state"], "done");
    assert_eq!(std::fs::read(d.downloads.join("canary-report-7.bin")).unwrap(), b"newer");
    // Both logs have a "copied" line; neither has a file name, a path or a size.
    let a_log = d.a.link.activity(None).unwrap();
    let b_log = d.b.link.activity(None).unwrap();
    assert!(a_log.as_array().unwrap().iter().any(|r| r["kind"] == "copied" && r["dir"] == "out"), "{a_log}");
    assert!(b_log.as_array().unwrap().iter().any(|r| r["kind"] == "copied" && r["dir"] == "in"), "{b_log}");
    for log in [a_log.to_string(), b_log.to_string()] {
        assert!(!log.contains("canary") && !log.contains(".bin"), "{log}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_comes_as_one_archive_into_a_new_folder() {
    let d = duo("folder").await;
    write(&d.shared, "app/src/a.rs", b"fn a() {}");
    write(&d.shared, "app/README.md", b"hello");
    write(&d.shared, "app/.env", b"TOKEN=1");
    d.b.link.set_files(&d.a_node, true).unwrap();
    let root = d.a.link.far_roots(&d.b_node).await.unwrap()["roots"][0].as_str().unwrap().to_string();
    let first = d.a.link.far_copy(&d.b_node, &root, &["app".into()], None, "ask").await.unwrap();
    let row = done(&d.a, first["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "done", "{row}");
    assert_eq!(row["saved_as"], "app");
    assert_eq!(std::fs::read(d.downloads.join("app/src/a.rs")).unwrap(), b"fn a() {}");
    assert!(!d.downloads.join("app/.env").exists(), "a secrets file is never packed");
    // Again: a new folder, nothing is written over the first.
    let second = d.a.link.far_copy(&d.b_node, &root, &["app".into()], None, "ask").await.unwrap();
    assert_eq!(done(&d.a, second["id"].as_u64().unwrap()).await["saved_as"], "app (2)");
    // Several things at once: one folder named after the device.
    let many = d.a.link.far_copy(&d.b_node, &root, &["app/README.md".into(), "app/src".into()], None, "ask").await.unwrap();
    let row = done(&d.a, many["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "done", "{row}");
    let folder = d.downloads.join(row["saved_as"].as_str().unwrap());
    assert_eq!(std::fs::read(folder.join("README.md")).unwrap(), b"hello");
    assert_eq!(std::fs::read(folder.join("src/a.rs")).unwrap(), b"fn a() {}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_copy_resumes_after_the_link_drops_part_of_the_way() {
    let _gate = GATE.lock().await;
    let d = duo("resume").await;
    d.a.link.files_retry_wait_for_tests(Duration::from_millis(10));
    let body = pattern(3 * 1024 * 1024);
    write(&d.shared, "big.bin", &body);
    d.b.link.set_files(&d.a_node, true).unwrap();
    let root = d.a.link.far_roots(&d.b_node).await.unwrap()["roots"][0].as_str().unwrap().to_string();
    DROP_AFTER.store(1024 * 1024, Ordering::SeqCst);
    let started = d.a.link.far_copy(&d.b_node, &root, &["big.bin".into()], None, "ask").await.unwrap();
    let row = done(&d.a, started["id"].as_u64().unwrap()).await;
    assert_eq!(DROP_AFTER.load(Ordering::SeqCst), 0, "the link really was dropped once");
    assert_eq!(row["state"], "done", "{row}");
    assert_eq!(std::fs::read(d.downloads.join("big.bin")).unwrap(), body, "the whole file is right after the resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_a_file_there_lands_whole_and_never_over_a_file_without_a_yes() {
    let d = duo("send").await;
    d.b.link.set_files(&d.a_node, true).unwrap();
    let root = d.a.link.far_roots(&d.b_node).await.unwrap()["roots"][0].as_str().unwrap().to_string();
    std::fs::create_dir_all(d.shared.join("inbox")).unwrap();
    let local = scratch("send-local");
    let body = pattern(500_000);
    write(&local, "canary-notes.txt", &body);
    let path = local.join("canary-notes.txt").to_string_lossy().into_owned();
    let sent = d.a.link.far_send(&d.b_node, &root, "inbox", &[path.clone()], "ask").await.unwrap();
    let row = done(&d.a, sent["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "done", "{row}");
    assert_eq!(std::fs::read(d.shared.join("inbox/canary-notes.txt")).unwrap(), body);
    assert!(std::fs::read_dir(d.shared.join("inbox")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")), "no part file is left");
    // The name is taken there: asked, not written.
    write(&local, "canary-notes.txt", b"second version");
    let ask = d.a.link.far_send(&d.b_node, &root, "inbox", &[path.clone()], "ask").await.unwrap();
    assert_eq!(ask["exists"], true, "{ask}");
    assert_eq!(std::fs::read(d.shared.join("inbox/canary-notes.txt")).unwrap(), body, "the file there is untouched");
    // Keep both: a numbered name; replace: written over.
    let both = d.a.link.far_send(&d.b_node, &root, "inbox", &[path.clone()], "both").await.unwrap();
    assert_eq!(done(&d.a, both["id"].as_u64().unwrap()).await["state"], "done");
    assert_eq!(std::fs::read(d.shared.join("inbox/canary-notes (2).txt")).unwrap(), b"second version");
    let over = d.a.link.far_send(&d.b_node, &root, "inbox", &[path.clone()], "replace").await.unwrap();
    assert_eq!(done(&d.a, over["id"].as_u64().unwrap()).await["state"], "done");
    assert_eq!(std::fs::read(d.shared.join("inbox/canary-notes.txt")).unwrap(), b"second version");
    // A sign-in file is never sent, from either end.
    write(&local, "id_rsa", b"secret");
    let bad = d.a.link.far_send(&d.b_node, &root, "inbox", &[local.join("id_rsa").to_string_lossy().into_owned()], "ask").await.unwrap();
    assert_eq!(bad["ok"], false);
    // A path that tries to leave the folder is refused over there.
    let escape = d.a.link.far_send(&d.b_node, &root, "../outside", &[path.clone()], "replace").await.unwrap();
    let row = done(&d.a, escape["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "failed", "{row}");
    assert!(!d.shared.parent().unwrap().join("outside").exists());
    // Both logs: a "sent" line, no names.
    let a_log = d.a.link.activity(None).unwrap();
    let b_log = d.b.link.activity(None).unwrap();
    assert!(a_log.as_array().unwrap().iter().any(|r| r["kind"] == "sent" && r["dir"] == "out"), "{a_log}");
    assert!(b_log.as_array().unwrap().iter().any(|r| r["kind"] == "sent" && r["dir"] == "in"), "{b_log}");
    for log in [a_log.to_string(), b_log.to_string()] {
        assert!(!log.contains("canary") && !log.contains(".txt") && !log.contains("inbox"), "{log}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_part_file_with_a_wrong_start_is_thrown_away_and_a_good_one_is_used() {
    let d = duo("part").await;
    d.b.link.set_files(&d.a_node, true).unwrap();
    let root = d.a.link.far_roots(&d.b_node).await.unwrap()["roots"][0].as_str().unwrap().to_string();
    let local = scratch("part-local");
    let body = pattern(400_000);
    write(&local, "f.bin", &body);
    let sum = files::sha256_file(&local.join("f.bin")).await.unwrap();
    let part = d.shared.join(format!(".pm-{}.part", &sum[..16]));
    let path = local.join("f.bin").to_string_lossy().into_owned();
    // A good first half is kept and finished.
    std::fs::write(&part, &body[..200_000]).unwrap();
    let r = d.a.link.far_send(&d.b_node, &root, "", &[path.clone()], "ask").await.unwrap();
    assert_eq!(done(&d.a, r["id"].as_u64().unwrap()).await["state"], "done");
    assert_eq!(std::fs::read(d.shared.join("f.bin")).unwrap(), body);
    // A wrong first half fails the check: the file is not written and the part file is gone.
    std::fs::remove_file(d.shared.join("f.bin")).unwrap();
    std::fs::write(&part, vec![7u8; 200_000]).unwrap();
    let r = d.a.link.far_send(&d.b_node, &root, "", &[path.clone()], "ask").await.unwrap();
    let row = done(&d.a, r["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "failed", "{row}");
    assert!(!d.shared.join("f.bin").exists() && !part.exists());
    // And the next try works from the start.
    let r = d.a.link.far_send(&d.b_node, &root, "", &[path], "ask").await.unwrap();
    assert_eq!(done(&d.a, r["id"].as_u64().unwrap()).await["state"], "done");
    assert_eq!(std::fs::read(d.shared.join("f.bin")).unwrap(), body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_sent_there_is_unpacked_into_a_new_folder_and_a_bad_name_is_refused() {
    let d = duo("sendfolder").await;
    d.b.link.set_files(&d.a_node, true).unwrap();
    let root = d.a.link.far_roots(&d.b_node).await.unwrap()["roots"][0].as_str().unwrap().to_string();
    let local = scratch("sendfolder-local");
    write(&local, "pack/a.txt", b"A");
    write(&local, "pack/deep/b.txt", b"B");
    write(&local, "pack/.env", b"TOKEN=1");
    let r = d.a.link.far_send(&d.b_node, &root, "", &[local.join("pack").to_string_lossy().into_owned()], "ask").await.unwrap();
    let row = done(&d.a, r["id"].as_u64().unwrap()).await;
    assert_eq!(row["state"], "done", "{row}");
    assert_eq!(std::fs::read(d.shared.join("pack/deep/b.txt")).unwrap(), b"B");
    assert!(!d.shared.join("pack/.env").exists());
    // Again: another new folder, the first is not touched.
    let r = d.a.link.far_send(&d.b_node, &root, "", &[local.join("pack").to_string_lossy().into_owned()], "ask").await.unwrap();
    assert_eq!(done(&d.a, r["id"].as_u64().unwrap()).await["saved_as"], "pack (2)");
}
