//! The director: the guide in, 20 to 26 beats out (fewer when the guide is small). It is plain code, so the same guide
//! always gives the same beats: no clock, no randomness, no model. Every word on screen is a sentence of a guide page,
//! the label of a box on the diagram, or one of a few fixed phrases below.
//!
//! A beat that matters less is dropped first when the tour would run too long (`prio`: 0 is never dropped).

use std::path::Path;

use super::super::mermaid::safe_label;
use super::super::model::Graph;
use super::super::store;
use super::layout::{layouts, ranks};
use super::spec::{Beat, Shot, Spec, FPS, MAX_BEAT_SECONDS, MIN_BEAT_SECONDS, VERSION};

/// The most beats a tour has, and the longest it runs (seconds).
pub const TARGET_MAX_BEATS: usize = 26;
pub const TARGET_MAX_SECONDS: f32 = 100.0;
const MAX_EDGE_BEATS: usize = 10;
const MAX_PAGE_BEATS: usize = 8;
const GOOD_WORDS: std::ops::RangeInclusive<usize> = 4..=18;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    En,
    ZhTw,
}

impl Lang {
    /// From the guide's own language setting (`guide.json`) or the app language: anything naming Chinese is zh-TW.
    pub fn from_hint(hint: &str) -> Lang {
        let h = hint.to_lowercase();
        if h.starts_with("zh") || h.contains("chinese") || hint.contains('中') || hint.contains('繁') {
            Lang::ZhTw
        } else {
            Lang::En
        }
    }
}

struct Words {
    intro: &'static str,
    subtitle: &'static str,
    diagram: &'static str,
    leads_to: &'static str,
    lives_in: &'static str,
    files_title: &'static str,
    choice: &'static str,
    outro: &'static str,
}

fn words(lang: Lang) -> Words {
    match lang {
        Lang::En => Words {
            intro: "Here is a short tour of {name}.",
            subtitle: "Made from its project guide",
            diagram: "Here is how the main parts fit together.",
            leads_to: "leads to",
            lives_in: "{page} lives in {file}.",
            files_title: "Where to look",
            choice: "One choice worth knowing.",
            outro: "That is the tour. The full guide is in the Guide tab.",
        },
        Lang::ZhTw => Words {
            intro: "這是 {name} 的簡短導覽。",
            subtitle: "由專案指南製成",
            diagram: "主要的部分是這樣組合起來的。",
            leads_to: "連到",
            lives_in: "{page}的內容在 {file}。",
            files_title: "從這裡開始看",
            choice: "有一個值得知道的選擇。",
            outro: "導覽到此結束。完整的指南在「專案指南」分頁。",
        },
    }
}

#[derive(Debug, Clone, Default)]
pub struct PageIn {
    pub id: String,
    pub title: String,
    pub markdown: String,
    /// Files the page cites that exist in the project now.
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GuideInput {
    pub project: String,
    pub lang: Lang,
    pub pages: Vec<PageIn>,
    pub graph: Graph,
}

/// Reads the finished guide from disk. Needs at least one page.
pub fn load(project: &Path, name: &str, lang_hint: &str) -> Result<GuideInput, String> {
    let manifest = store::read_manifest(project).ok_or("VIDEO_NO_GUIDE: There is no guide for this project yet.")?;
    let mut pages = Vec::new();
    for rec in &manifest.pages {
        let Some(markdown) = store::read_page(project, &rec.id) else { continue };
        let mut files: Vec<String> = Vec::new();
        for c in &rec.cited {
            if !files.contains(&c.path) && store::resolve_file(project, &c.path).is_ok() {
                files.push(c.path.clone());
            }
        }
        pages.push(PageIn { id: rec.id.clone(), title: rec.title.clone(), markdown, files });
    }
    if pages.is_empty() {
        return Err("VIDEO_NO_PAGES: The guide has no pages to make a tour from.".into());
    }
    let graph = store::read_graph(project).unwrap_or_default();
    let hint = if lang_hint.trim().is_empty() { store::read_steering(project).language.unwrap_or_default() } else { lang_hint.to_string() };
    Ok(GuideInput { project: name.to_string(), lang: Lang::from_hint(&hint), pages, graph })
}

// ---------------------------------------------------------------------------------------------------- text

/// A page as plain running text: no code blocks, headings, links, citations or markup.
pub fn plain(markdown: &str) -> String {
    let mut out = String::new();
    let mut fenced = false;
    for line in markdown.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || t.is_empty() || t.starts_with('#') || t.starts_with('|') || t.starts_with('>') {
            continue;
        }
        let t = t.trim_start_matches(['-', '*', '+']).trim_start();
        out.push_str(t);
        out.push(' ');
    }
    let chars: Vec<char> = out.chars().collect();
    let mut s = String::with_capacity(out.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // [[citation]] -> nothing
        if c == '[' && chars.get(i + 1) == Some(&'[') {
            if let Some(end) = (i + 2..chars.len().saturating_sub(1)).find(|&j| chars[j] == ']' && chars[j + 1] == ']') {
                i = end + 2;
                continue;
            }
        }
        // [text](url) -> text
        if c == '[' {
            if let Some(close) = (i + 1..chars.len()).find(|&j| chars[j] == ']') {
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(paren) = (close + 2..chars.len()).find(|&j| chars[j] == ')') {
                        s.extend(&chars[i + 1..close]);
                        i = paren + 1;
                        continue;
                    }
                }
            }
        }
        // <tags>
        if c == '<' {
            if let Some(end) = (i + 1..chars.len().min(i + 80)).find(|&j| chars[j] == '>') {
                i = end + 1;
                continue;
            }
        }
        // numbered citation marks the Guide tab shows (U+3014 .. U+3015) are not words either
        if let '\u{3014}' = c {
            if let Some(end) = (i + 1..chars.len().min(i + 8)).find(|&j| chars[j] == '\u{3015}') {
                i = end + 1;
                continue;
            }
        }
        if !matches!(c, '`' | '*' | '_') {
            s.push(c);
        }
        i += 1;
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn word_count(s: &str) -> usize {
    let spaced = s.split_whitespace().count();
    let chars = s.chars().count();
    // Chinese has no spaces: about 2 characters a word.
    if spaced * 6 < chars {
        chars / 2
    } else {
        spaced
    }
}

/// Sentences that read well alone, in order. A long one is cut at its first comma when that part reads alone.
pub fn sentences(markdown: &str) -> Vec<String> {
    let text = plain(markdown);
    let chars: Vec<char> = text.chars().collect();
    let mut found: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let cjk_end = matches!(c, '。' | '！' | '？');
        let latin_end = matches!(c, '.' | '!' | '?') && chars.get(i + 1).is_none_or(|n| n.is_whitespace());
        if cjk_end || latin_end {
            found.push(std::mem::take(&mut cur).trim().to_string());
        }
    }
    if !cur.trim().is_empty() {
        found.push(cur.trim().to_string());
    }
    found.into_iter().filter_map(fit).collect()
}

fn fit(s: String) -> Option<String> {
    let words = word_count(&s);
    let chars = s.chars().count();
    // Chinese packs more into fewer characters.
    let min_chars = if s.split_whitespace().count() * 6 < chars { 8 } else { 15 };
    if words < 4 || chars < min_chars {
        return None;
    }
    if GOOD_WORDS.contains(&words) && s.chars().count() <= 130 {
        return Some(s);
    }
    let cut = s.split([',', ';', ':', '，', '；', '：']).next().unwrap_or("").trim();
    if GOOD_WORDS.contains(&word_count(cut)) && cut.chars().count() >= 15 {
        let end = if cut.ends_with(['.', '!', '?', '。']) { "" } else { "." };
        return Some(format!("{cut}{end}"));
    }
    None
}

fn short_path(p: &str) -> String {
    if p.chars().count() <= 48 {
        return p.to_string();
    }
    let parts: Vec<&str> = p.split('/').collect();
    format!(".../{}", parts[parts.len().saturating_sub(2)..].join("/"))
}

fn seconds_for(caption: &str) -> f32 {
    let w = word_count(caption) as f32;
    (1.4 + w / 3.2).clamp(MIN_BEAT_SECONDS.max(2.4), 6.0).min(MAX_BEAT_SECONDS)
}

// ---------------------------------------------------------------------------------------------------- director

struct Cand {
    prio: u8,
    beat: Beat,
}

fn cand(prio: u8, caption: String, shot: Shot) -> Cand {
    Cand { prio, beat: Beat { id: String::new(), seconds: seconds_for(&caption), caption, shot } }
}

fn fill(template: &str, pairs: &[(&str, &str)]) -> String {
    pairs.iter().fold(template.to_string(), |acc, (k, v)| acc.replace(&format!("{{{k}}}"), v))
}

fn design_page(pages: &[PageIn], overview: usize) -> Option<usize> {
    let key = |p: &PageIn| format!("{} {}", p.id, p.title).to_lowercase();
    let hit = pages
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != overview)
        .find(|(_, p)| ["design", "decision", "why", "choice", "設計", "決定", "選擇"].iter().any(|w| key(p).contains(w)))
        .map(|(i, _)| i);
    hit.or_else(|| (pages.len() >= 3 && pages.len() - 1 != overview).then(|| pages.len() - 1))
}

pub fn director(input: &GuideInput) -> Vec<Beat> {
    let w = words(input.lang);
    let mut all: Vec<Cand> = Vec::new();
    let name = input.project.as_str();
    all.push(cand(0, fill(w.intro, &[("name", name)]), Shot::Title { title: name.to_string(), subtitle: w.subtitle.to_string() }));

    // 1. What it is for: the first sentences of the overview.
    let overview = input.pages.iter().position(|p| p.id == "overview").unwrap_or(0);
    if let Some(over) = input.pages.get(overview) {
        for (k, s) in sentences(&over.markdown).into_iter().take(3).enumerate() {
            all.push(cand(if k == 0 { 1 } else { 2 + k as u8 }, s.clone(), Shot::Card { title: over.title.clone(), text: s }));
        }
    }

    // 2. How the parts fit: the diagram, then its arrows from the start of the flow.
    let g = &input.graph;
    if g.nodes.len() >= 2 {
        all.push(cand(1, w.diagram.to_string(), Shot::Diagram { lit: vec![], edges: vec![] }));
        let rank = ranks(g);
        let rank_of = |id: &str| g.nodes.iter().position(|n| n.id == id).map(|i| rank[i]).unwrap_or(0);
        let label_of = |id: &str| g.nodes.iter().find(|n| n.id == id).map(|n| safe_label(&n.label)).unwrap_or_default();
        let mut order: Vec<usize> = (0..g.edges.len()).filter(|&i| g.edges[i].from != g.edges[i].to).collect();
        order.sort_by_key(|&i| (rank_of(&g.edges[i].from), i));
        let zh = input.lang == Lang::ZhTw;
        for (k, &i) in order.iter().take(MAX_EDGE_BEATS).enumerate() {
            let e = &g.edges[i];
            let verb = e
                .label
                .as_deref()
                .map(|l| safe_label(l).to_lowercase())
                .filter(|l| l != "?" && l.chars().count() <= 24)
                .unwrap_or_else(|| w.leads_to.to_string());
            let (space, stop) = if zh { ("", "。") } else { (" ", ".") };
            let caption = format!("{}{space}{verb}{space}{}{stop}", label_of(&e.from), label_of(&e.to));
            all.push(cand(2 + (k / 3) as u8, caption, Shot::Diagram { lit: vec![e.from.clone(), e.to.clone()], edges: vec![[e.from.clone(), e.to.clone()]] }));
        }
    }

    // 3. The other pages: one card each, a second sentence if there is room, and where their files are.
    let design = design_page(&input.pages, overview);
    let mut shown = 0;
    for (i, p) in input.pages.iter().enumerate() {
        if i == overview || Some(i) == design || shown >= MAX_PAGE_BEATS {
            continue;
        }
        shown += 1;
        let sents = sentences(&p.markdown);
        if let Some(s) = sents.first() {
            all.push(cand(2, s.clone(), Shot::Card { title: p.title.clone(), text: s.clone() }));
        }
        if let Some(s) = sents.get(1) {
            all.push(cand(5, s.clone(), Shot::Card { title: p.title.clone(), text: s.clone() }));
        }
        if let Some(first) = p.files.first() {
            let caption = fill(w.lives_in, &[("page", &p.title), ("file", &short_path(first))]);
            all.push(cand(3, caption, Shot::Files { title: w.files_title.to_string(), paths: p.files.iter().take(3).cloned().collect() }));
        }
    }

    // 4. One choice worth knowing.
    if let Some(i) = design {
        let p = &input.pages[i];
        all.push(cand(1, w.choice.to_string(), Shot::Card { title: p.title.clone(), text: String::new() }));
        for (k, s) in sentences(&p.markdown).into_iter().take(2).enumerate() {
            all.push(cand(if k == 0 { 1 } else { 3 }, s.clone(), Shot::Card { title: p.title.clone(), text: s }));
        }
    }
    all.push(cand(0, w.outro.to_string(), Shot::Outro { text: name.to_string() }));

    // Drop the least important beats (latest first) until the tour fits.
    let total = |v: &[Cand]| v.iter().map(|c| c.beat.seconds).sum::<f32>();
    while all.len() > TARGET_MAX_BEATS || total(&all) > TARGET_MAX_SECONDS {
        let worst = all.iter().enumerate().filter(|(_, c)| c.prio > 0).max_by_key(|(i, c)| (c.prio, *i)).map(|(i, _)| i);
        match worst {
            Some(i) => {
                all.remove(i);
            }
            None => break,
        }
    }
    all.into_iter()
        .enumerate()
        .map(|(i, mut c)| {
            c.beat.id = format!("b{:02}", i + 1);
            c.beat
        })
        .collect()
}

/// The whole spec: beats plus the layout of the diagram for both shapes of picture.
pub fn spec_of(input: &GuideInput) -> Spec {
    Spec { version: VERSION, title: input.project.clone(), fps: FPS, beats: director(input), graph: input.graph.clone(), layouts: layouts(&input.graph) }
}
