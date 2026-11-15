use super::model::*;
use super::share::*;
use super::share_page::*;
use super::store::*;
use std::fs;
use std::path::PathBuf;

fn project(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("pm-share-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let index = dir.join("data").join("artifact-shares.json");
    (dir, index)
}

const NOW: u64 = 1_800_000_000_000;

fn two_pages(p: &std::path::Path) {
    add_version(p, "report", "Report", ArtifactKind::Html, "<h1>report one</h1>", None).unwrap();
    add_version(p, "secret-plan", "Secret plan", ArtifactKind::Html, "<h1>the other page</h1>", None).unwrap();
}

fn body(page: &SharePage) -> String {
    String::from_utf8(page.body.clone()).unwrap()
}

#[test]
fn a_link_shows_the_one_version_it_was_made_for_and_never_a_later_one() {
    let (p, index) = project("one-version");
    two_pages(&p);
    let link = create_link(&index, &p, "report", None, None, NOW).unwrap();
    assert_eq!(link.version, 1);
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report two</h1>", None).unwrap();
    let page = respond(&index, "GET", &["share", &link.token], NOW + 1000).unwrap();
    assert_eq!(page.status, 200);
    assert_eq!(body(&page), "<h1>report one</h1>");
    // A link made after that one is for version two.
    let later = create_link(&index, &p, "report", None, None, NOW).unwrap();
    assert_eq!(later.version, 2);
    assert_eq!(body(&respond(&index, "GET", &["share", &later.token], NOW).unwrap()), "<h1>report two</h1>");
}

#[test]
fn a_link_ends_at_its_time_and_not_before() {
    let (p, index) = project("expires");
    two_pages(&p);
    let link = create_link(&index, &p, "report", None, Some(3600), NOW).unwrap();
    assert_eq!(link.expires_at, NOW + 3_600_000);
    assert_eq!(respond(&index, "GET", &["share", &link.token], link.expires_at - 1).unwrap().status, 200);
    let ended = respond(&index, "GET", &["share", &link.token], link.expires_at).unwrap();
    assert_eq!(ended.status, 410);
    assert!(!body(&ended).contains("report one"));
    assert_eq!(respond(&index, "GET", &["share", &link.token], link.expires_at + 86_400_000).unwrap().status, 410);
    assert!(active_links(&p, "report", link.expires_at).is_empty());
    assert_eq!(active_links(&p, "report", NOW).len(), 1);
}

#[test]
fn the_time_is_kept_between_a_minute_and_seven_days() {
    let (p, index) = project("ttl");
    two_pages(&p);
    let long = create_link(&index, &p, "report", None, Some(10 * 365 * 86_400), NOW).unwrap();
    assert_eq!(long.expires_at, NOW + MAX_TTL_SECS * 1000);
    let short = create_link(&index, &p, "report", None, Some(0), NOW).unwrap();
    assert_eq!(short.expires_at, NOW + 60_000);
    let usual = create_link(&index, &p, "report", None, None, NOW).unwrap();
    assert_eq!(usual.expires_at, NOW + DEFAULT_TTL_SECS * 1000);
}

#[test]
fn a_link_for_one_page_never_shows_another_page() {
    let (p, index) = project("other-page");
    two_pages(&p);
    let link = create_link(&index, &p, "report", None, None, NOW).unwrap();
    // The route takes no id: naming the other page in the path is just another (unknown) secret.
    let guess = respond(&index, "GET", &["share", "secret-plan"], NOW).unwrap();
    assert_eq!(guess.status, 404);
    let guess = respond(&index, "GET", &["share", &"a".repeat(32)], NOW).unwrap();
    assert_eq!(guess.status, 404);
    // Extra path parts are not this route at all (the bridge's normal rules apply to them).
    assert!(respond(&index, "GET", &["share", &link.token, "secret-plan"], NOW).is_none());
    assert!(respond(&index, "GET", &["share"], NOW).is_none());
    assert!(respond(&index, "GET", &["panes", "1", "artifacts", "secret-plan"], NOW).is_none());
    assert!(respond(&index, "GET", &["artifacts", "show"], NOW).is_none());
    let page = respond(&index, "GET", &["share", &link.token], NOW).unwrap();
    assert!(!body(&page).contains("the other page"));
    // A link for the other page shows only that page.
    let theirs = create_link(&index, &p, "secret-plan", None, None, NOW).unwrap();
    assert_eq!(body(&respond(&index, "GET", &["share", &theirs.token], NOW).unwrap()), "<h1>the other page</h1>");
}

#[test]
fn a_link_is_read_only() {
    let (p, index) = project("read-only");
    two_pages(&p);
    let link = create_link(&index, &p, "report", None, None, NOW).unwrap();
    for method in ["POST", "PUT", "PATCH", "DELETE", "HEAD"] {
        let page = respond(&index, method, &["share", &link.token], NOW).unwrap();
        assert_eq!(page.status, 405, "{method}");
        assert_eq!(page.header("allow"), Some("GET"));
        assert!(!body(&page).contains("report one"));
    }
    // Nothing a request does changes the page.
    assert_eq!(read(&p, "report", None).unwrap().content, "<h1>report one</h1>");
}

#[test]
fn stopping_sharing_ends_every_link_of_that_page_only() {
    let (p, index) = project("revoke");
    two_pages(&p);
    let a = create_link(&index, &p, "report", None, None, NOW).unwrap();
    let b = create_link(&index, &p, "report", None, None, NOW).unwrap();
    let other = create_link(&index, &p, "secret-plan", None, None, NOW).unwrap();
    assert_eq!(revoke_links(&index, &p, "report").unwrap(), 2);
    for t in [&a.token, &b.token] {
        assert_eq!(respond(&index, "GET", &["share", t], NOW).unwrap().status, 404);
    }
    assert_eq!(respond(&index, "GET", &["share", &other.token], NOW).unwrap().status, 200);
    assert!(active_links(&p, "report", NOW).is_empty());
}

#[test]
fn only_a_hash_of_the_secret_is_written_down() {
    let (p, index) = project("hash-only");
    two_pages(&p);
    let link = create_link(&index, &p, "report", None, None, NOW).unwrap();
    assert_eq!(link.token.len(), 32);
    let meta = fs::read_to_string(artifacts_dir(&p).join("report").join("meta.json")).unwrap();
    assert!(!meta.contains(&link.token));
    assert!(!fs::read_to_string(&index).unwrap().contains(&link.token));
    // Two links never share a secret.
    let again = create_link(&index, &p, "report", None, None, NOW).unwrap();
    assert_ne!(again.token, link.token);
}

#[test]
fn an_unknown_wrong_shaped_or_missing_page_gets_the_same_plain_answer() {
    let (p, index) = project("same-answer");
    two_pages(&p);
    let link = create_link(&index, &p, "report", None, None, NOW).unwrap();
    let unknown = respond(&index, "GET", &["share", &"B".repeat(32)], NOW).unwrap();
    let wrong = respond(&index, "GET", &["share", "../../etc/passwd"], NOW).unwrap();
    assert_eq!((unknown.status, wrong.status), (404, 404));
    assert_eq!(unknown.body, wrong.body);
    // The page is deleted from the project: the link goes with it.
    fs::remove_dir_all(artifacts_dir(&p).join("report")).unwrap();
    assert_eq!(respond(&index, "GET", &["share", &link.token], NOW).unwrap().status, 404);
}

#[test]
fn a_shared_page_is_kept_in_a_box_that_cannot_reach_the_app() {
    let (p, index) = project("headers");
    add_version(&p, "note", "Note", ArtifactKind::Markdown, "# hi <script>alert(1)</script>", None).unwrap();
    add_version(&p, "pic", "Pic", ArtifactKind::Svg, "<svg viewBox=\"0 0 1 1\"><script>alert(1)</script></svg>", None).unwrap();
    two_pages(&p);
    let html = create_link(&index, &p, "report", None, None, NOW).unwrap();
    let md = create_link(&index, &p, "note", None, None, NOW).unwrap();
    let svg = create_link(&index, &p, "pic", None, None, NOW).unwrap();
    for t in [&html.token, &md.token, &svg.token] {
        let page = respond(&index, "GET", &["share", t], NOW).unwrap();
        let csp = page.header("content-security-policy").unwrap();
        assert!(csp.starts_with("sandbox"), "{csp}");
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("connect-src"));
        assert!(csp.contains("default-src 'none'"));
        assert_eq!(page.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(page.header("cache-control"), Some("no-store"));
        assert_eq!(page.header("referrer-policy"), Some("no-referrer"));
        assert!(page.header("content-type").unwrap().starts_with("text/html"));
    }
    // Only an HTML page may run its own script; a note and a picture never may.
    assert!(respond(&index, "GET", &["share", &html.token], NOW).unwrap().header("content-security-policy").unwrap().starts_with("sandbox allow-scripts"));
    for t in [&md.token, &svg.token] {
        let csp = respond(&index, "GET", &["share", t], NOW).unwrap().header("content-security-policy").unwrap().to_string();
        assert!(!csp.contains("allow-scripts") && !csp.contains("script-src"), "{csp}");
    }
    // The note is text, not markup.
    let note = body(&respond(&index, "GET", &["share", &md.token], NOW).unwrap());
    assert!(note.contains("&lt;script&gt;") && !note.contains("<script>"));
}

#[test]
fn an_artifact_cannot_have_endless_links() {
    let (p, index) = project("many");
    two_pages(&p);
    for _ in 0..20 {
        create_link(&index, &p, "report", None, None, NOW).unwrap();
    }
    assert_eq!(create_link(&index, &p, "report", None, None, NOW).unwrap_err(), ShareError::TooMany);
    // Once they have ended, a new one is allowed again.
    assert!(create_link(&index, &p, "report", None, None, NOW + 2 * 86_400_000).is_ok());
}

#[test]
fn a_version_that_does_not_exist_cannot_be_shared() {
    let (p, index) = project("no-version");
    two_pages(&p);
    assert_eq!(create_link(&index, &p, "report", Some(9), None, NOW).unwrap_err(), ShareError::Artifact(ArtifactError::NotFound));
    assert_eq!(create_link(&index, &p, "../x", None, None, NOW).unwrap_err(), ShareError::Artifact(ArtifactError::BadId));
}
