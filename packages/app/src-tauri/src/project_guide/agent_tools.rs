//! The guide for agents (MCP tools `read_guide_structure`, `read_guide_page`, `ask_guide`). Read-only, no model.
//!
//! * Every project path is checked first: it must be a real folder, and the guide folder under it must be a real
//!   folder inside it (a link that leaves the project is refused). A page id is checked by `valid_id`, so
//!   `../../x` never touches the disk. Nothing outside `<project>/.potato/guide/` is ever read.
//! * `ask_guide` does NOT call a model. A model call would spend the person's plan, so it ranks the guide's own
//!   pages against the question and returns the best passages with their citations. The agent reads the answer.
//! * A stale page gets a first line that names the changed files; agents are told to trust the code over the guide.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::model::valid_id;
use super::read;
use super::store::{self, now_ms};

/// Longest page text handed back in one call.
const MAX_PAGE_CHARS: usize = 60_000;
/// Longest question looked at.
const MAX_QUESTION_CHARS: usize = 1_000;
/// Pages returned by `ask_guide`, and the size of each passage.
const MAX_MATCHES: usize = 3;
const MAX_EXCERPT_CHARS: usize = 900;

const TRUST_CODE: &str = "The guide was written by an agent and can be wrong or old. Trust the code over the guide.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuideToolError {
    pub code: &'static str,
    pub message: String,
}

impl GuideToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// The project folder, made real, with a guide folder that stays inside it.
pub fn checked_project(raw: &str) -> Result<PathBuf, GuideToolError> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err(GuideToolError::new("INVALID_ARGUMENT", "project_path is needed: the folder of the project."));
    }
    let project = std::fs::canonicalize(raw).map_err(|_| GuideToolError::new("NO_GUIDE", "That project folder does not exist."))?;
    if !project.is_dir() {
        return Err(GuideToolError::new("NO_GUIDE", "project_path must be a folder."));
    }
    let dir = store::guide_dir(&project);
    if let Ok(real) = std::fs::canonicalize(&dir) {
        if !real.starts_with(&project) {
            return Err(GuideToolError::new("PATH_NOT_ALLOWED", "The guide folder leaves the project. Refused."));
        }
    }
    Ok(project)
}

fn with_guide(raw: &str) -> Result<PathBuf, GuideToolError> {
    let project = checked_project(raw)?;
    if !store::has_guide(&project) {
        return Err(GuideToolError::new("NO_GUIDE", "This project has no guide. The person can make one from the project menu."));
    }
    Ok(project)
}

fn age_days(written_at_ms: u64) -> u64 {
    now_ms().saturating_sub(written_at_ms) / 86_400_000
}

pub fn structure(raw: &str) -> Result<Value, GuideToolError> {
    let project = with_guide(raw)?;
    let s = read::structure(&project).ok_or_else(|| GuideToolError::new("NO_GUIDE", "The guide could not be read."))?;
    let title = project.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stale_count = s.pages.iter().filter(|p| p.stale).count();
    Ok(json!({
        "title": title,
        "written_at_commit": s.commit,
        "age_days": age_days(s.written_at_ms),
        "written_by": s.agent,
        "complete": s.complete,
        "pages": s.pages.iter().map(|p| json!({ "id": p.id, "title": p.title, "purpose": p.purpose, "stale": p.stale, "needs_review": p.needs_review })).collect::<Vec<_>>(),
        "diagram": s.diagram,
        "diagram_stale": s.diagram_stale,
        "stale_pages": stale_count,
        "note": TRUST_CODE,
    }))
}

/// `page_id` is a page id, or the word `diagram`.
pub fn page(raw: &str, page_id: &str) -> Result<Value, GuideToolError> {
    let project = with_guide(raw)?;
    let page_id = page_id.trim();
    if page_id == "diagram" {
        let d = read::diagram(&project).ok_or_else(|| GuideToolError::new("UNKNOWN_PAGE", "This guide has no diagram."))?;
        let boxes: Vec<Value> = d.boxes.iter().map(|b| json!({ "label": b.label, "path": b.path, "page": b.page })).collect();
        let first_line = if d.stale { "Parts of this diagram may be out of date. Trust the code over this diagram.\n\n" } else { "" };
        return Ok(json!({ "id": "diagram", "mermaid": format!("{first_line}{}", d.mermaid), "boxes": boxes, "stale": d.stale, "note": TRUST_CODE }));
    }
    if !valid_id(page_id) {
        return Err(GuideToolError::new("INVALID_ARGUMENT", "page_id is a page id from read_guide_structure (a-z, 0-9 and dashes), or \"diagram\"."));
    }
    let view = read::page(&project, page_id).ok_or_else(|| GuideToolError::new("UNKNOWN_PAGE", format!("There is no page `{page_id}`. Call read_guide_structure for the list.")))?;
    let mut markdown = read::page_for_agent(&view);
    let cut = markdown.chars().count() > MAX_PAGE_CHARS;
    if cut {
        markdown = markdown.chars().take(MAX_PAGE_CHARS).collect();
    }
    Ok(json!({ "id": view.id, "title": view.title, "markdown": markdown, "stale": view.stale, "changed": view.changed, "needs_review": view.needs_review, "cut": cut, "note": TRUST_CODE }))
}

fn words(text: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "and", "for", "are", "was", "were", "this", "that", "with", "from", "how", "what", "where", "when", "why", "does", "did", "can", "you", "your", "its", "into", "about",
        "which", "who", "has", "have", "had", "not", "but", "any", "all", "out", "use", "used", "uses",
    ];
    let mut seen = HashSet::new();
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(w))
        .filter(|w| seen.insert((*w).to_string()))
        .map(str::to_string)
        .collect()
}

fn score(text: &str, terms: &[String]) -> usize {
    let lower = text.to_lowercase();
    terms.iter().map(|t| lower.matches(t.as_str()).count().min(5)).sum()
}

/// The citations (`[[path:lines]]`) found in a piece of text, without the brackets, once each.
fn citations_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in super::check::parse_citations(text) {
        let label = match (c.start, c.end) {
            (Some(s), Some(e)) if e != s => format!("{}:{s}-{e}", c.path),
            (Some(s), _) => format!("{}:{s}", c.path),
            _ => c.path.clone(),
        };
        if !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

/// The best paragraphs of a page for these terms, kept in page order and cut to a size.
fn excerpt(markdown: &str, terms: &[String]) -> String {
    let paras: Vec<&str> = markdown.split("\n\n").map(str::trim).filter(|p| !p.is_empty()).collect();
    let mut ranked: Vec<(usize, usize)> = paras.iter().enumerate().map(|(i, p)| (score(p, terms), i)).collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut chosen: Vec<usize> = Vec::new();
    let mut size = 0;
    for (s, i) in ranked {
        if s == 0 && !chosen.is_empty() {
            break;
        }
        let len = paras[i].chars().count();
        if size + len > MAX_EXCERPT_CHARS && !chosen.is_empty() {
            continue;
        }
        chosen.push(i);
        size += len;
        if size >= MAX_EXCERPT_CHARS {
            break;
        }
    }
    chosen.sort_unstable();
    let text = chosen.iter().map(|i| paras[*i]).collect::<Vec<_>>().join("\n\n");
    if text.chars().count() > MAX_EXCERPT_CHARS {
        let cut: String = text.chars().take(MAX_EXCERPT_CHARS).collect();
        format!("{cut}...")
    } else {
        text
    }
}

/// No model: the guide's best pages for the question, with the passages and the citations in them.
pub fn ask(raw: &str, question: &str) -> Result<Value, GuideToolError> {
    let project = with_guide(raw)?;
    let question: String = question.trim().chars().take(MAX_QUESTION_CHARS).collect();
    let terms = words(&question);
    if question.is_empty() || terms.is_empty() {
        return Err(GuideToolError::new("INVALID_ARGUMENT", "question is needed: a few words about the project, for example \"where is sync handled\"."));
    }
    let structure = read::structure(&project).ok_or_else(|| GuideToolError::new("NO_GUIDE", "The guide could not be read."))?;
    let mut scored: Vec<(usize, read::PageView)> = structure
        .pages
        .iter()
        .filter_map(|p| read::page(&project, &p.id))
        .map(|v| (score(&v.title, &terms) * 4 + score(&v.markdown, &terms), v))
        .filter(|(s, _)| *s > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let matches: Vec<Value> = scored
        .into_iter()
        .take(MAX_MATCHES)
        .map(|(_, v)| {
            let passage = excerpt(&v.markdown, &terms);
            let mut cites = citations_in(&passage);
            if cites.is_empty() {
                cites = citations_in(&v.markdown).into_iter().take(5).collect();
            }
            json!({ "page_id": v.id, "title": v.title, "stale": v.stale, "changed": v.changed, "passage": passage, "citations": cites })
        })
        .collect();
    let found = !matches.is_empty();
    Ok(json!({
        "question": question,
        "answered_by": "guide pages only (no model call, nothing was spent)",
        "found": found,
        "matches": matches,
        "next": if found { "Read the cited files to check, or open the page with read_guide_page." } else { "The guide does not mention this. Search the code, or call read_guide_structure for the page list." },
        "note": TRUST_CODE,
    }))
}

/// True when `candidate` (already made real) is one of `known` or inside one.
pub fn inside_known(candidate: &Path, known: &[PathBuf]) -> bool {
    known.iter().filter_map(|k| std::fs::canonicalize(k).ok()).any(|k| candidate.starts_with(&k))
}
