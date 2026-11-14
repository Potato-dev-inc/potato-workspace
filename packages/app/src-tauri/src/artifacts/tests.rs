use super::model::*;
use super::service::*;
use super::store::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-artifacts-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_new_page_is_version_one_and_a_changed_page_is_the_next_version() {
    let p = project("versions");
    let (a, v) = add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>one</h1>", None).unwrap();
    assert_eq!((v, a.latest()), (Some(1), 1));
    let (a, v) = add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>two</h1>", None).unwrap();
    assert_eq!((v, a.latest()), (Some(2), 2));
    // The same page again adds nothing.
    let (a, v) = add_version(&p, "report", "Report", ArtifactKind::Html, "<h1>two</h1>", None).unwrap();
    assert_eq!((v, a.versions.len()), (None, 2));
    // Every version stays readable, and the latest is the default.
    assert_eq!(read(&p, "report", Some(1)).unwrap().content, "<h1>one</h1>");
    assert_eq!(read(&p, "report", None).unwrap().content, "<h1>two</h1>");
    assert_eq!(read(&p, "report", Some(3)).unwrap_err(), ArtifactError::NotFound);
    assert_eq!(list(&p).len(), 1);
    assert!(artifacts_dir(&p).join("report").join("v2.html").is_file());
}

#[test]
fn a_page_over_sixteen_megabytes_is_refused_and_nothing_is_written() {
    let p = project("cap");
    let big = "x".repeat(MAX_BYTES + 1);
    assert_eq!(add_version(&p, "big", "Big", ArtifactKind::Markdown, &big, None).unwrap_err(), ArtifactError::TooBig);
    assert!(list(&p).is_empty());
    let exactly = "y".repeat(MAX_BYTES);
    assert!(add_version(&p, "big", "Big", ArtifactKind::Markdown, &exactly, None).is_ok());
}

#[test]
fn an_id_can_never_leave_the_folder() {
    let p = project("ids");
    for bad in ["../x", "a/b", "A", "", "-x", "a b", "a\\b", "x.html"] {
        assert_eq!(add_version(&p, bad, "T", ArtifactKind::Html, "<p>x</p>", None).unwrap_err(), ArtifactError::BadId, "{bad}");
        assert_eq!(read(&p, bad, None).unwrap_err(), ArtifactError::BadId, "{bad}");
    }
    assert_eq!(slug("../../Etc Passwd!"), "etc-passwd");
    assert_eq!(slug("   "), "artifact");
    assert_eq!(slug("日本語"), "artifact");
    assert!(slug(&"a".repeat(200)).len() <= 48);
}

#[test]
fn an_artifact_keeps_its_kind() {
    let p = project("kind");
    add_version(&p, "x", "X", ArtifactKind::Html, "<p>a</p>", None).unwrap();
    assert_eq!(add_version(&p, "x", "X", ArtifactKind::Markdown, "# a", None).unwrap_err(), ArtifactError::KindChanged(ArtifactKind::Html));
}

#[test]
fn a_page_dropped_into_the_folder_becomes_an_artifact_and_each_edit_a_version() {
    let p = project("folder");
    let dir = artifacts_dir(&p);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("quarterly-report.html"), "<h1>Q1</h1>").unwrap();
    fs::write(dir.join("notes.txt"), "not a page").unwrap();
    fs::write(dir.join("empty.md"), "").unwrap();
    let found = sync_folder(&p);
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].0.id.as_str(), found[0].0.title.as_str(), found[0].1), ("quarterly-report", "Quarterly report", 1));
    // Nothing new: nothing announced.
    assert!(sync_folder(&p).is_empty());
    // The agent edits the file: the next sync adds version 2.
    fs::write(dir.join("quarterly-report.html"), "<h1>Q1 final</h1>").unwrap();
    let again = sync_folder(&p);
    assert_eq!((again.len(), again[0].1), (1, 2));
    assert_eq!(read(&p, "quarterly-report", Some(1)).unwrap().content, "<h1>Q1</h1>");
}

#[test]
fn show_makes_a_page_from_inline_text_or_from_a_file_of_the_project() {
    let p = project("show");
    let one = show(&p, &json!({ "title": "Plan", "content": "# Plan\n\n- a" })).unwrap();
    assert_eq!((one.artifact.id.as_str(), one.artifact.kind, one.version, one.added), ("plan", ArtifactKind::Markdown, 1, true));
    fs::write(p.join("chart.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>").unwrap();
    let two = show(&p, &json!({ "path": "chart.svg" })).unwrap();
    assert_eq!((two.artifact.id.as_str(), two.artifact.title.as_str(), two.artifact.kind), ("chart", "chart", ArtifactKind::Svg));
    // The same call again is not a new version.
    let again = show(&p, &json!({ "title": "Plan", "content": "# Plan\n\n- a" })).unwrap();
    assert_eq!((again.version, again.added), (1, false));
    // An explicit id updates one page whatever the title says.
    let next = show(&p, &json!({ "title": "Plan, revised", "id": "plan", "content": "# Plan 2" })).unwrap();
    assert_eq!((next.artifact.id.as_str(), next.version), ("plan", 2));
    assert_eq!(show(&p, &json!({ "title": "x" })).unwrap_err(), ArtifactError::Empty);
    assert_eq!(show(&p, &json!({ "title": "x", "content": "y", "kind": "pdf" })).unwrap_err(), ArtifactError::BadKind);
}

#[test]
fn show_never_reads_a_file_outside_the_project() {
    let p = project("outside");
    let other = project("outside-other");
    fs::write(other.join("secret.html"), "<p>secret</p>").unwrap();
    let outside = other.join("secret.html").to_string_lossy().to_string();
    assert_eq!(show(&p, &json!({ "path": outside })).unwrap_err(), ArtifactError::Outside);
    assert_eq!(show(&p, &json!({ "path": "../pm-artifacts-outside-other-0/secret.html" })).unwrap_err().code().starts_with("ARTIFACT_"), true);
    assert_eq!(show(&p, &json!({ "path": "missing.html" })).unwrap_err(), ArtifactError::NotFound);
    assert!(list(&p).is_empty());
}

#[test]
fn the_kind_is_guessed_from_the_name_then_from_the_text() {
    assert_eq!(sniff_kind(Some("a/b.mmd"), "x"), ArtifactKind::Mermaid);
    assert_eq!(sniff_kind(None, "<!DOCTYPE html><p>"), ArtifactKind::Html);
    assert_eq!(sniff_kind(None, "  <svg viewBox='0 0 1 1'/>"), ArtifactKind::Svg);
    assert_eq!(sniff_kind(None, "flowchart TD\n A-->B"), ArtifactKind::Mermaid);
    assert_eq!(sniff_kind(None, "Just words"), ArtifactKind::Markdown);
}

#[test]
fn the_card_in_the_chat_is_a_notice_that_names_the_page_and_the_version() {
    let a = Artifact {
        id: "plan".into(),
        title: "Plan".into(),
        kind: ArtifactKind::Markdown,
        source: None,
        created_at: "t".into(),
        updated_at: "t".into(),
        versions: vec![],
        share: None,
    };
    match announce_item(&a, 2, "2026-11-15T00:00:00Z") {
        crate::session_chat::ChatItem::Notice { id, notice_kind, text, url, .. } => {
            assert_eq!((id.as_str(), notice_kind.as_str(), text.as_str()), ("artifact:plan:v2", "artifact", "Plan"));
            let r = parse_ref(url.as_deref().unwrap()).unwrap();
            assert_eq!((r.id.as_str(), r.version, r.kind), ("plan", 2, ArtifactKind::Markdown));
        }
        other => panic!("{other:?}"),
    }
    for bad in ["", "https://x", "potato-artifact:", "potato-artifact:../x/1/html", "potato-artifact:a/0/html", "potato-artifact:a/1/pdf", "potato-artifact:a/1/html/x"] {
        assert!(parse_ref(bad).is_none(), "{bad}");
    }
}

#[test]
fn the_phone_is_told_no_path_and_a_share_slot_exists_but_is_empty() {
    let p = project("phone");
    let (a, _) = add_version(&p, "x", "X", ArtifactKind::Html, "<p>1</p>", None).unwrap();
    let view = phone_view(&a).to_string();
    assert!(!view.contains("potato") && !view.contains(":\\") && !view.contains("sha"), "{view}");
    let meta = fs::read_to_string(artifacts_dir(&p).join("x").join("meta.json")).unwrap();
    assert!(!meta.contains("\"share\""), "an empty share slot is not written: {meta}");
    assert!(a.share.is_none());
}
