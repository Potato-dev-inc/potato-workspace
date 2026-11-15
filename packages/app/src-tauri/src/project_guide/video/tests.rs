use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::beats::*;
use super::layout::*;
use super::render::*;
use super::spec::*;
use super::stage;
use crate::project_guide::dry::DryRunAgent;
use crate::project_guide::model::{Edge, Graph, Node};
use crate::project_guide::run::{generate, Progress, RunOptions};

fn node(id: &str, label: &str) -> Node {
    Node { id: id.into(), label: label.into(), shape: "box".into(), ..Default::default() }
}

fn edge(a: &str, b: &str, label: Option<&str>) -> Edge {
    Edge { from: a.into(), to: b.into(), label: label.map(str::to_string) }
}

fn page(id: &str, title: &str, markdown: &str, files: &[&str]) -> PageIn {
    PageIn { id: id.into(), title: title.into(), markdown: markdown.into(), files: files.iter().map(|f| f.to_string()).collect() }
}

/// A guide with plenty to say: 7 pages, 9 boxes and 11 arrows (one of them closes a circle).
fn big_guide() -> GuideInput {
    let pages = vec![
        page("overview", "Overview", "# Overview\n\nTide Notes is a small notes app for the desk. It keeps every note on your own PC, see [[README.md:1-3]]. Sync is optional and off by default. Start with the main file.", &["README.md"]),
        page("sync", "Sync", "# Sync\n\nThe sync queue holds changes until the network is back. It retries with a growing delay [[src/sync/queue.ts:1-40]]. Nothing is sent without a login.", &["src/sync/queue.ts", "src/sync/net.ts"]),
        page("ui", "Screens", "# Screens\n\nEvery screen is a small component with its own state. Buttons share one style [[src/ui/button.ts]]. The app shell wires them together.", &["src/ui/app.ts", "src/ui/button.ts"]),
        page("storage", "Storage", "# Storage\n\nNotes are plain files in one folder. A small index file speeds up search [[src/store/index.ts:1-20]]. Deleting a note moves it to a trash folder.", &["src/store/index.ts"]),
        page("search", "Search", "# Search\n\nSearch reads the index first and only opens files it needs. Results come back in under a second for most folders. It never sends your words anywhere.", &["src/search/find.ts"]),
        page("export", "Export", "# Export\n\nYou can export one note or the whole folder as plain text. Exports never include the trash folder. The format is the same as the stored files.", &["src/export/zip.ts"]),
        page("design", "Design choices", "# Design choices\n\nWe chose plain files over a database. That keeps every note readable without the app. Backups are just a folder copy.", &["docs/design.md"]),
    ];
    let ids = ["app", "ui", "sync", "net", "queue", "store", "index", "search", "export"];
    let nodes = ids.iter().map(|i| node(i, &format!("{} part", i.to_uppercase()))).collect();
    let edges = vec![
        edge("app", "ui", None),
        edge("app", "store", Some("saves to")),
        edge("ui", "search", Some("asks")),
        edge("ui", "sync", None),
        edge("sync", "queue", Some("fills")),
        edge("queue", "net", Some("sends through")),
        edge("store", "index", None),
        edge("search", "index", Some("reads")),
        edge("ui", "export", None),
        edge("export", "store", Some("reads")),
        edge("net", "sync", Some("tells")), // closes a circle
    ];
    GuideInput { project: "tide-notes".into(), lang: Lang::En, pages, graph: Graph { groups: vec![], nodes, edges } }
}

#[test]
fn the_director_gives_the_same_20_to_26_beats_every_time_and_they_pass_the_checks() {
    let input = big_guide();
    let a = spec_of(&input);
    let b = spec_of(&input);
    assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap(), "same guide, same tour");
    let n = a.beats.len();
    assert!((20..=26).contains(&n), "{n} beats: {:#?}", a.beats.iter().map(|b| &b.caption).collect::<Vec<_>>());
    assert!(a.total_seconds() <= TARGET_MAX_SECONDS, "{} s", a.total_seconds());
    assert!(a.total_seconds() >= 45.0, "a tour is not a blink: {} s", a.total_seconds());
    assert_eq!(check(&a, None), Vec::<String>::new());
    // The first and the last beat are always there, in order; ids run b01, b02, ...
    assert!(matches!(a.beats.first().unwrap().shot, Shot::Title { .. }));
    assert!(matches!(a.beats.last().unwrap().shot, Shot::Outro { .. }));
    assert_eq!(a.beats[0].id, "b01");
    // The three parts: what it is, how the parts fit, one choice.
    assert!(a.beats.iter().any(|b| matches!(&b.shot, Shot::Card { title, .. } if title == "Overview")));
    assert!(a.beats.iter().any(|b| matches!(&b.shot, Shot::Diagram { edges, .. } if !edges.is_empty())));
    assert!(a.beats.iter().any(|b| matches!(&b.shot, Shot::Card { title, .. } if title == "Design choices")));
    let words: usize = a.beats.iter().map(|b| b.caption.split_whitespace().count()).sum();
    assert!((120..=300).contains(&words), "{words} words");
}

#[test]
fn every_caption_is_a_sentence_of_the_guide_a_box_label_or_a_fixed_phrase() {
    let input = big_guide();
    let spec = spec_of(&input);
    let guide_text: String = input.pages.iter().map(|p| plain(&p.markdown)).collect::<Vec<_>>().join(" ");
    for b in &spec.beats {
        let ok = guide_text.contains(b.caption.trim_end_matches('.'))
            || matches!(b.shot, Shot::Title { .. } | Shot::Outro { .. } | Shot::Diagram { .. } | Shot::Files { .. })
            || b.caption == "One choice worth knowing.";
        assert!(ok, "not from the guide: {}", b.caption);
    }
    // Citations, code and links never reach the screen.
    for b in &spec.beats {
        assert!(!b.caption.contains("[[") && !b.caption.contains('`') && !b.caption.contains("]("), "{}", b.caption);
    }
}

#[test]
fn a_small_guide_gives_a_shorter_tour_and_a_guide_with_no_diagram_still_works() {
    let input = GuideInput { project: "tiny".into(), lang: Lang::En, pages: vec![page("overview", "Overview", "A tiny project that does one thing well. It has one file.", &["a.txt"])], graph: Graph::default() };
    let spec = spec_of(&input);
    assert!(spec.beats.len() >= 3 && spec.beats.len() < 10, "{}", spec.beats.len());
    assert_eq!(check(&spec, None), Vec::<String>::new());
    assert!(spec.beats.iter().all(|b| !matches!(b.shot, Shot::Diagram { .. })));
}

#[test]
fn the_phrases_follow_the_language_and_chinese_pages_make_beats() {
    assert_eq!(Lang::from_hint("zh-TW"), Lang::ZhTw);
    assert_eq!(Lang::from_hint("繁體中文"), Lang::ZhTw);
    assert_eq!(Lang::from_hint("en"), Lang::En);
    let input = GuideInput {
        project: "筆記".into(),
        lang: Lang::ZhTw,
        pages: vec![page("overview", "總覽", "# 總覽\n\n這是一個很小的筆記程式，所有內容都放在你的電腦上。同步功能預設是關閉的。", &[])],
        graph: Graph::default(),
    };
    let spec = spec_of(&input);
    assert!(spec.beats[0].caption.contains("導覽"));
    assert!(spec.beats.iter().any(|b| b.caption.contains("同步功能")), "{:?}", spec.beats.iter().map(|b| &b.caption).collect::<Vec<_>>());
}

#[test]
fn plain_text_drops_code_links_citations_and_marks() {
    let md = "# Title\n\nUse **the queue** [[src/a.ts:1-5]] and [the docs](https://x.y/z) now.\n\n```\nlet secret = 1;\n```\n\n- `code` thing <b>bold</b> done.\n";
    let p = plain(md);
    assert_eq!(p, "Use the queue and the docs now. code thing bold done.");
    assert!(sentences("Short. Also short one. This sentence has enough words to be read aloud fine.").len() == 1);
}

#[test]
fn the_shot_schema_round_trips_and_refuses_what_it_does_not_know() {
    let spec = spec_of(&big_guide());
    let json = serde_json::to_string(&spec).unwrap();
    let back: Spec = serde_json::from_str(&json).unwrap();
    assert_eq!(back, spec);
    // Shots are tagged by `kind`, with no coordinates anywhere in a beat.
    let beat = serde_json::to_value(&spec.beats[3]).unwrap();
    assert!(beat["shot"]["kind"].is_string());
    assert!(!beat.to_string().contains("\"x\""));
    // An unknown kind does not parse.
    assert!(serde_json::from_str::<Shot>(r#"{"kind":"explode","power":9}"#).is_err());
    assert!(serde_json::from_str::<Shot>(r#"{"kind":"title","title":"a","subtitle":"b"}"#).is_ok());
}

#[test]
fn the_checks_catch_bad_beats() {
    let good = spec_of(&big_guide());
    let mut s = good.clone();
    s.beats[2].shot = Shot::Diagram { lit: vec!["nope".into()], edges: vec![["app".into(), "export".into()]] };
    let bad = check(&s, None);
    assert!(bad.iter().any(|m| m.contains("`nope` is not a box")), "{bad:?}");
    assert!(bad.iter().any(|m| m.contains("no arrow from `app` to `export`")), "{bad:?}");
    let mut s = good.clone();
    s.beats[1].caption = "x".repeat(MAX_CAPTION_CHARS + 1);
    s.beats[2].caption = "  ".into();
    s.beats[3].seconds = 0.2;
    s.beats[4].id = s.beats[5].id.clone();
    assert!(check(&s, None).len() >= 4);
    let mut s = good.clone();
    s.beats[1].shot = Shot::Files { title: "t".into(), paths: vec!["../outside.txt".into(), "/etc/passwd".into(), "C:\\x".into()] };
    assert_eq!(check(&s, None).iter().filter(|m| m.contains("not a path inside the project")).count(), 3);
    let mut s = good.clone();
    s.beats.clear();
    assert!(!check(&s, None).is_empty());
    let mut s = good;
    s.beats.truncate(2);
    s.beats[0].seconds = 9.0;
    for _ in 0..14 {
        let b = s.beats[0].clone();
        s.beats.push(Beat { id: format!("z{}", s.beats.len()), ..b });
    }
    assert!(check(&s, None).iter().any(|m| m.contains("longer than")));
}

fn inside(outer: &Rect, r: &Rect) -> bool {
    r.x >= outer.x - 0.5 && r.y >= outer.y - 0.5 && r.right() <= outer.right() + 0.5 && r.bottom() <= outer.bottom() + 0.5
}

fn assert_clean(l: &Layout, what: &str) {
    for (i, a) in l.nodes.iter().enumerate() {
        assert!(inside(&l.diagram, &a.rect), "{what}: {} leaves the diagram area: {:?}", a.id, a.rect);
        assert!(!a.rect.overlaps(&l.caption), "{what}: {} touches the caption", a.id);
        assert!(a.rect.w >= 60.0 && a.rect.h >= 30.0, "{what}: {} is tiny: {:?}", a.id, a.rect);
        for b in &l.nodes[i + 1..] {
            assert!(!a.rect.overlaps(&b.rect), "{what}: {} overlaps {}", a.id, b.id);
        }
    }
    assert!(!l.card.overlaps(&l.caption) && !l.diagram.overlaps(&l.caption), "{what}: the caption has its own band");
    assert!(inside(&Rect { x: 0.0, y: 0.0, w: l.width as f32, h: l.height as f32 }, &l.caption));
}

#[test]
fn the_layout_never_overlaps_for_a_normal_graph_a_long_chain_and_a_crowd() {
    let g = big_guide().graph;
    let l = layouts(&g);
    assert_clean(&l.landscape, "landscape");
    assert_clean(&l.vertical, "vertical");
    assert_eq!(l.landscape.edges.len(), g.edges.len());
    // Boxes of later ranks sit further along the flow (left to right in a wide picture, top to bottom in a tall one).
    let x = |l: &Layout, id: &str| l.nodes.iter().find(|n| n.id == id).unwrap().rect.x;
    let y = |l: &Layout, id: &str| l.nodes.iter().find(|n| n.id == id).unwrap().rect.y;
    assert!(x(&l.landscape, "app") < x(&l.landscape, "ui") && x(&l.landscape, "ui") < x(&l.landscape, "sync"));
    assert!(y(&l.vertical, "app") < y(&l.vertical, "ui") && y(&l.vertical, "ui") < y(&l.vertical, "sync"));

    // 40 boxes in one chain, and 40 boxes with no arrows at all.
    let nodes: Vec<Node> = (0..40).map(|i| node(&format!("n{i}"), &format!("Part number {i}"))).collect();
    let chain = Graph { groups: vec![], nodes: nodes.clone(), edges: (0..39).map(|i| edge(&format!("n{i}"), &format!("n{}", i + 1), None)).collect() };
    let l = layouts(&chain);
    assert_clean(&l.landscape, "chain landscape");
    assert_clean(&l.vertical, "chain vertical");
    let crowd = Graph { groups: vec![], nodes, edges: vec![] };
    let l = layouts(&crowd);
    assert_clean(&l.landscape, "crowd landscape");
    assert_clean(&l.vertical, "crowd vertical");
    // A graph with a circle and an arrow to nowhere does not hang or panic.
    let odd = Graph { groups: vec![], nodes: vec![node("a", "A"), node("b", "B")], edges: vec![edge("a", "b", None), edge("b", "a", None), edge("a", "ghost", None), edge("a", "a", None)] };
    let l = layouts(&odd);
    assert_clean(&l.landscape, "odd");
    assert_eq!(l.landscape.edges.len(), 2);
    assert_clean(&layouts(&Graph::default()).landscape, "empty");
}

#[test]
fn the_stage_page_cannot_be_broken_out_of_by_a_hostile_caption() {
    let mut spec = spec_of(&big_guide());
    spec.beats[1].caption = "</script><script>alert(1)</script> \u{2028}".into();
    spec.title = "<b>x</b> & \"y\"".into();
    let page = stage::html(&spec, false);
    assert_eq!(page.matches("</script>").count(), 2, "only our two script tags close");
    assert!(page.contains("\\u003c/script>"));
    assert!(page.contains("&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;"));
    assert!(!page.contains("<body data-autoplay>"));
    assert!(stage::html(&spec, true).contains("<body data-autoplay>"));
    for loader in ["src=", "href=", "@import", "url(", "fetch(", "XMLHttpRequest", "https://"] {
        assert!(!page.contains(loader), "the page loads nothing: {loader}");
    }
    assert!(!page.contains("innerHTML"), "text is set as text");
}

// ------------------------------------------------------------------ on a real folder

fn project_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-guide-video-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn put(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

/// A project with a guide written by the dry-run stand-in (no model).
fn project_with_guide(name: &str) -> PathBuf {
    let d = project_dir(name);
    put(&d, "README.md", "# Tide notes\nA small notes app.\n");
    put(&d, "package.json", "{\"name\":\"tide-notes\"}\n");
    for (rel, n) in [("src/main.ts", 30), ("src/sync/queue.ts", 100), ("src/sync/net.ts", 20), ("src/ui/app.ts", 40), ("src/ui/button.ts", 12), ("docs/design.md", 8), ("lib/util.ts", 9)] {
        put(&d, rel, &(1..=n).map(|i| format!("line {i}\n")).collect::<String>());
    }
    let progress = Progress::new();
    let stop = AtomicBool::new(false);
    let manifest = generate(&d, &DryRunAgent, &RunOptions::default(), &progress, &stop).expect("the dry-run guide");
    assert!(manifest.complete);
    d
}

#[test]
fn a_real_guide_on_disk_makes_a_checked_deterministic_spec() {
    let d = project_with_guide("plan");
    let (_, a) = plan(&d, "shop", "").unwrap();
    let (_, b) = plan(&d, "shop", "").unwrap();
    assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    assert!(a.beats.len() >= 6, "{}", a.beats.len());
    assert!(a.beats.iter().any(|b| matches!(&b.shot, Shot::Files { paths, .. } if paths.iter().all(|p| d.join(p).is_file()))));
    assert_eq!(check(&a, Some(&d)), Vec::<String>::new());
    // A file that is gone since the guide was written is dropped from the tour, not shown.
    fs::remove_file(d.join("README.md")).unwrap();
    let (_, c) = plan(&d, "shop", "").unwrap();
    assert!(!c.beats.iter().any(|b| matches!(&b.shot, Shot::Files { paths, .. } if paths.iter().any(|p| p == "README.md"))));
    // No guide, no tour.
    let empty = project_dir("noguide");
    assert!(plan(&empty, "x", "").unwrap_err().starts_with("VIDEO_NO_GUIDE"));
    let _ = fs::remove_dir_all(&d);
    let _ = fs::remove_dir_all(&empty);
}

#[test]
fn without_the_tools_the_person_gets_the_captioned_slideshow_and_a_plain_note() {
    let d = project_with_guide("slides");
    let progress = VideoProgress::new();
    let end = make(&d, "shop", &RenderOptions { force_slideshow: true, ..Default::default() }, &progress, &AtomicBool::new(false));
    assert_eq!(end.phase, "done", "{end:?}");
    assert_eq!(end.outcome.as_deref(), Some("slideshow"));
    assert!(end.notes.iter().any(|n| n.contains("slideshow")), "{:?}", end.notes);
    let dir = d.join(".potato/guide/video");
    let html = fs::read_to_string(dir.join("tour.html")).unwrap();
    assert!(html.contains("data-autoplay") && html.contains("__seek"));
    let spec: Spec = serde_json::from_str(&fs::read_to_string(dir.join("spec.json")).unwrap()).unwrap();
    assert!(!spec.beats.is_empty());
    assert!(!dir.join("tour.mp4").exists());
    assert_eq!(end.files, vec![".potato/guide/video/tour.html".to_string()]);
    // The folder stays out of git, like the rest of the guide.
    assert!(crate::project_guide::store::guide_dir(&d).ends_with(".potato/guide"));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_stop_before_the_render_leaves_no_video() {
    let d = project_with_guide("stop");
    let progress = VideoProgress::new();
    let end = make(&d, "shop", &RenderOptions { force_slideshow: false, ..Default::default() }, &progress, &AtomicBool::new(true));
    assert_eq!(end.phase, "stopped");
    assert!(!d.join(".potato/guide/video/tour.mp4").exists());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_render_that_cannot_run_falls_back_to_the_slideshow_with_the_reason() {
    let d = project_with_guide("badtools");
    let progress = VideoProgress::new();
    let broken = Tools { node: d.join("no-such-node"), browser: d.join("no-browser"), ffmpeg: d.join("no-ffmpeg") };
    let end = make(&d, "shop", &RenderOptions { tools: Some(broken), ..Default::default() }, &progress, &AtomicBool::new(false));
    assert_eq!(end.phase, "done", "{end:?}");
    assert_eq!(end.outcome.as_deref(), Some("slideshow"));
    assert!(end.notes.iter().any(|n| n.contains("VIDEO_SPAWN") && n.contains("slideshow is ready instead")), "{:?}", end.notes);
    assert!(d.join(".potato/guide/video/tour.html").is_file(), "the slideshow is written first, so it is there anyway");
    assert!(!d.join(".potato/guide/video/render.mjs").exists() && !d.join(".potato/guide/video/stage.html").exists(), "no helper files are left");
    let _ = fs::remove_dir_all(&d);
}

/// CI-light: three beats, a tiny picture, a low frame rate. Skipped (and says so) when Node, a browser or ffmpeg is missing.
#[test]
fn a_tiny_three_beat_render_makes_a_real_mp4() {
    let tools = match find_tools(None, None) {
        Ok(t) => t,
        Err(missing) => {
            eprintln!("SKIPPED: no {} on this machine", missing.join(", "));
            return;
        }
    };
    let profiles = || fs::read_dir(std::env::temp_dir()).map(|rd| rd.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("pm-guide-video-") && !e.file_name().to_string_lossy()["pm-guide-video-".len()..].contains('-')).count()).unwrap_or(0);
    let before = profiles();
    let d = project_with_guide("render");
    let progress = VideoProgress::new();
    let opts = RenderOptions { tools: Some(tools), max_beats: 3, scale: 0.25, fps: 6, ..Default::default() };
    let end = make(&d, "shop", &opts, &progress, &AtomicBool::new(false));
    assert_eq!(end.phase, "done", "{end:?}");
    assert_eq!(end.outcome.as_deref(), Some("video"), "{end:?}");
    assert_eq!(end.beats, 3);
    assert!(end.frames_done >= end.frames_total.saturating_sub(6) && end.frames_total > 10, "{end:?}");
    let mp4 = d.join(".potato/guide/video/tour.mp4");
    let bytes = fs::read(&mp4).expect("tour.mp4");
    assert!(bytes.len() > 2000, "{} bytes", bytes.len());
    assert_eq!(&bytes[4..8], b"ftyp", "an mp4 starts with ftyp");
    assert!(!d.join(".potato/guide/video/tour.mp4.part").exists());
    assert_eq!(profiles(), before, "the browser's temporary profile folder is removed");
    assert_eq!(end.files.first().map(String::as_str), Some(".potato/guide/video/tour.mp4"));
    let _ = fs::remove_dir_all(&d);
}

/// Evidence only (`PM_GUIDE_VIDEO_EVIDENCE=<folder> cargo test ... -- --ignored`): the full 20+ beat tour of the big
/// fixture guide, landscape and vertical, copied to the folder. Not part of the normal run.
#[test]
#[ignore]
fn evidence_full_render() {
    use crate::project_guide::model::{Cited, Manifest, PageRecord};
    use crate::project_guide::store;
    let Some(out) = std::env::var_os("PM_GUIDE_VIDEO_EVIDENCE").map(PathBuf::from) else { return };
    let d = project_dir("evidence");
    let input = big_guide();
    let mut manifest = Manifest { version: 1, complete: true, agent: "claude".into(), written_at_ms: 1, ..Default::default() };
    for p in &input.pages {
        let mut cited = Vec::new();
        for f in &p.files {
            put(&d, f, "line 1\nline 2\n");
            cited.push(Cited { path: f.clone(), hash: store::file_hash(&d, f).unwrap_or_default() });
        }
        store::write_page(&d, &p.id, &p.markdown).unwrap();
        manifest.pages.push(PageRecord { id: p.id.clone(), title: p.title.clone(), purpose: String::new(), cited, needs_review: false });
    }
    store::write_manifest(&d, &manifest).unwrap();
    store::write_graph(&d, &input.graph, "flowchart LR\n").unwrap();
    let progress = VideoProgress::new();
    let end = make(&d, "tide-notes", &RenderOptions { vertical: true, ..Default::default() }, &progress, &AtomicBool::new(false));
    assert_eq!(end.outcome.as_deref(), Some("video"), "{end:?}");
    fs::create_dir_all(&out).unwrap();
    for f in ["tour.mp4", "tour-vertical.mp4", "tour.html", "spec.json"] {
        fs::copy(d.join(".potato/guide/video").join(f), out.join(f)).unwrap();
    }
    let _ = fs::remove_dir_all(&d);
}
