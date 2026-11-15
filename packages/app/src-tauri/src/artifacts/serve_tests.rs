use super::*;
use crate::artifacts::model::ArtifactKind;
use crate::artifacts::store::add_version;
use std::fs;

fn project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-artifacts-serve-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn token_of(address: &str) -> String {
    address.trim_end_matches('/').rsplit('/').next().unwrap().to_string()
}

fn body(page: &SharePage) -> String {
    String::from_utf8(page.body.clone()).unwrap()
}

#[test]
fn an_unknown_or_malformed_token_is_a_plain_404_and_gives_no_hint() {
    let p = project("unknown");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report</h1>", None).unwrap();
    open(p, "report", "pane-1").unwrap();
    for path in ["/", "/nope/", "/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/", "/report/", "/../etc/passwd", "/a/b/c"] {
        let page = respond("GET", path);
        assert_eq!(page.status, 404, "{path}");
        assert!(!body(&page).contains("report"), "{path}");
    }
}

#[test]
fn only_get_is_answered_everything_else_is_405_even_with_a_good_token() {
    let p = project("methods");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report</h1>", None).unwrap();
    let address = open(p, "report", "pane-1").unwrap();
    let path = format!("/{}/", token_of(&address));
    for m in ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] {
        let page = respond(m, &path);
        assert_eq!(page.status, 405, "{m}");
        assert!(page.headers.iter().any(|(k, v)| *k == "Allow" && v == "GET"));
        assert!(!body(&page).contains("<h1>report</h1>"));
    }
    assert_eq!(respond("GET", &path).status, 200);
}

#[test]
fn the_lock_headers_are_exact() {
    let p = project("headers");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report</h1><script>1</script>", None).unwrap();
    let address = open(p, "report", "pane-1").unwrap();
    let page = respond("GET", &format!("/{}/", token_of(&address)));
    let h = |name: &str| page.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let csp = h("content-security-policy").unwrap();
    assert!(csp.starts_with("sandbox allow-scripts;"), "{csp}");
    assert!(!csp.contains("allow-same-origin"));
    for needle in ["default-src 'none'", "img-src data: blob:", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'", "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com"] {
        assert!(csp.contains(needle), "{needle} in {csp}");
    }
    assert!(!csp.contains("connect-src https") && !csp.contains("http:"));
    assert_eq!(h("cache-control").as_deref(), Some("no-store"));
    assert_eq!(h("x-content-type-options").as_deref(), Some("nosniff"));
    assert_eq!(h("referrer-policy").as_deref(), Some("no-referrer"));
    assert!(h("content-type").unwrap().starts_with("text/html"));
    assert!(h("access-control-allow-origin").is_none());
}

#[test]
fn a_picture_is_served_without_allow_scripts() {
    let p = project("svg");
    add_version(&p, "pic", "Pic", ArtifactKind::Svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", None).unwrap();
    let address = open(p, "pic", "pane-1").unwrap();
    let page = respond("GET", &format!("/{}/", token_of(&address)));
    let csp = page.headers.iter().find(|(k, _)| *k == "Content-Security-Policy").unwrap().1.clone();
    assert!(csp.starts_with("sandbox;") && !csp.contains("script-src"), "{csp}");
}

#[test]
fn a_token_opens_its_own_page_and_never_another() {
    let p = project("two");
    add_version(&p, "first", "First", ArtifactKind::Html, "<h1>first page</h1>", None).unwrap();
    add_version(&p, "second", "Second", ArtifactKind::Html, "<h1>second page</h1>", None).unwrap();
    let a = open(p.clone(), "first", "pane-1").unwrap();
    let b = open(p, "second", "pane-1").unwrap();
    let ta = token_of(&a);
    let tb = token_of(&b);
    assert!(body(&respond("GET", &format!("/{ta}/"))).contains("first page"));
    assert!(!body(&respond("GET", &format!("/{ta}/"))).contains("second page"));
    assert!(body(&respond("GET", &format!("/{tb}/"))).contains("second page"));
    // The id is not an address: a path with an id and no token gets nothing.
    assert_eq!(respond("GET", "/second/").status, 404);
    // Neither token reaches a path below it.
    assert_eq!(respond("GET", &format!("/{ta}/second")).status, 404);
}

#[test]
fn the_tab_follows_the_newest_version() {
    let p = project("newest");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>version one</h1>", None).unwrap();
    let address = open(p.clone(), "report", "pane-1").unwrap();
    let path = format!("/{}/", token_of(&address));
    assert!(body(&respond("GET", &path)).contains("version one"));
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>version two</h1>", None).unwrap();
    assert!(body(&respond("GET", &path)).contains("version two"));
    assert!(chip_of(&address).unwrap().contains("v2"));
}

#[test]
fn the_token_is_gone_after_the_tab_closes_and_a_token_is_never_made_for_a_missing_page() {
    let p = project("close");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report</h1>", None).unwrap();
    let address = open(p.clone(), "report", "pane-1").unwrap();
    let token = token_of(&address);
    assert!(is_live_address(&address));
    close(&token);
    assert!(!is_live_address(&address));
    assert_eq!(respond("GET", &format!("/{token}/")).status, 404);
    assert!(open(p, "not-there", "pane-1").is_err());
}

#[test]
fn only_a_live_address_of_ours_counts_as_one() {
    let p = project("live");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report</h1>", None).unwrap();
    let address = open(p, "report", "pane-1").unwrap();
    let token = token_of(&address);
    assert!(is_live_address(&address));
    for bad in [
        format!("http://localhost/{token}/"),
        format!("http://127.0.0.1/{token}/"),
        format!("https://example.com/{token}/"),
        format!("{address}extra"),
        format!("{}?x=1", address),
        "http://potato-artifact.localhost/".to_string(),
        "http://potato-artifact.localhost/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/".to_string(),
    ] {
        assert!(!is_live_address(&bad), "{bad}");
    }
}

#[test]
fn tokens_are_long_random_and_different_each_time() {
    let p = project("random");
    add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>report</h1>", None).unwrap();
    let a = token_of(&open(p.clone(), "report", "pane-1").unwrap());
    let b = token_of(&open(p, "report", "pane-1").unwrap());
    assert_eq!(a.len(), 32);
    assert_ne!(a, b);
}
