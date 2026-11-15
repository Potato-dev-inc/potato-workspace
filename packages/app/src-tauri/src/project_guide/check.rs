//! The checks our code runs on what an agent wrote. The agent is never trusted: an outline, a page and a graph are
//! only used after they pass here, and what does not pass is sent back once with the exact errors, then cut.
//!
//! Citation form (one only): `[[src/sync/queue.ts:40-88]]`, `[[src/sync/queue.ts:40]]` or `[[src/sync/queue.ts]]`.
//! Passing proves the file exists inside the project and the lines exist. It does NOT prove the sentence is true.

use std::collections::HashSet;
use std::path::Path;

use regex::Regex;

use super::model::{valid_id, Graph, Outline, MAX_EDGES, MAX_NODES, MAX_PAGES, SHAPES};
use super::store::{resolve_file, resolve_in_project, PathProblem};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Citation {
    /// The whole `[[...]]` text, to cut it out of a page.
    pub raw: String,
    pub path: String,
    pub start: Option<u32>,
    pub end: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// The path is absolute (a drive, a leading slash, `~`).
    Absolute,
    /// The path climbs out of the project (`..`, or a link that leaves it).
    Escapes,
    /// There is no such file.
    Missing,
    /// The range is empty, backwards or past the end. Holds the file's line count.
    BadRange(u32),
}

impl Problem {
    pub fn describe(&self) -> String {
        match self {
            Self::Absolute => "uses an absolute path (use a path relative to the project)".into(),
            Self::Escapes => "leaves the project folder".into(),
            Self::Missing => "names a file that does not exist".into(),
            Self::BadRange(lines) => format!("uses lines outside the file (it has {lines} lines)"),
        }
    }
}

fn citation_re() -> Regex {
    Regex::new(r"\[\[([^\[\]\r\n]{1,300})\]\]").expect("citation pattern")
}

/// Every `[[...]]` in a page, in order.
pub fn parse_citations(markdown: &str) -> Vec<Citation> {
    let range = Regex::new(r"^(\d{1,7})(?:-(\d{1,7}))?$").expect("range pattern");
    citation_re()
        .captures_iter(markdown)
        .map(|cap| {
            let inner = cap[1].trim();
            let (path, start, end) = match inner.rsplit_once(':') {
                Some((p, r)) if range.is_match(r.trim()) => {
                    let m = range.captures(r.trim()).expect("matched");
                    let s: u32 = m[1].parse().unwrap_or(0);
                    let e = m.get(2).and_then(|x| x.as_str().parse().ok());
                    (p.trim(), Some(s), e.or(Some(s)))
                }
                _ => (inner, None, None),
            };
            Citation { raw: cap[0].to_string(), path: path.to_string(), start, end }
        })
        .collect()
}

fn line_count(text: &str) -> u32 {
    text.lines().count() as u32
}

/// `Ok` when the file exists inside the project and the lines (if given) are inside it.
pub fn check_citation(project: &Path, c: &Citation) -> Result<(), Problem> {
    let real = resolve_file(project, &c.path).map_err(|p| match p {
        PathProblem::Absolute => Problem::Absolute,
        PathProblem::Escapes => Problem::Escapes,
        PathProblem::Missing | PathProblem::NotAFile => Problem::Missing,
    })?;
    if let (Some(start), Some(end)) = (c.start, c.end) {
        let text = std::fs::read(&real).map(|b| String::from_utf8_lossy(&b).to_string()).map_err(|_| Problem::Missing)?;
        let lines = line_count(&text);
        if start < 1 || end < start || end > lines {
            return Err(Problem::BadRange(lines));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageCheck {
    pub good: Vec<Citation>,
    pub bad: Vec<(Citation, Problem)>,
    pub too_few: bool,
}

impl PageCheck {
    pub fn passes(&self) -> bool {
        self.bad.is_empty() && !self.too_few
    }

    /// The exact errors, for the one retry.
    pub fn feedback(&self, min: usize) -> String {
        let mut lines: Vec<String> = self.bad.iter().map(|(c, p)| format!("- `{}` {}", c.raw, p.describe())).collect();
        if self.too_few {
            lines.push(format!("- the page has {} valid citations; it needs at least {min}", self.good.len()));
        }
        lines.join("\n")
    }
}

pub fn check_page(project: &Path, markdown: &str, min_citations: usize) -> PageCheck {
    let mut out = PageCheck::default();
    for c in parse_citations(markdown) {
        match check_citation(project, &c) {
            Ok(()) => out.good.push(c),
            Err(p) => out.bad.push((c, p)),
        }
    }
    let distinct: HashSet<&str> = out.good.iter().map(|c| c.path.as_str()).collect();
    out.too_few = distinct.len() < min_citations;
    out
}

/// The page with every bad citation cut out (the sentence stays, the chip goes).
pub fn strip_bad(markdown: &str, check: &PageCheck) -> String {
    let mut text = markdown.to_string();
    for (c, _) in &check.bad {
        text = text.replace(&c.raw, "");
    }
    text
}

/// The distinct project paths a page cites, validly, in first-seen order.
pub fn cited_paths(check: &PageCheck) -> Vec<String> {
    let mut seen = HashSet::new();
    check
        .good
        .iter()
        .filter_map(|c| super::store::clean_rel(&c.path).ok())
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Secrets in a page are redacted before it is saved.
pub fn redact(markdown: &str) -> String {
    crate::redact::text(markdown).into_inner()
}

/// Errors in an outline, or none. `required` are the best-scored files that must appear on some page.
pub fn check_outline(project: &Path, outline: &Outline, required: &[String]) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if outline.pages.is_empty() {
        errors.push("the outline has no pages".to_string());
    }
    if outline.pages.len() > MAX_PAGES {
        errors.push(format!("the outline has {} pages; the most allowed is {MAX_PAGES}", outline.pages.len()));
    }
    let mut ids = HashSet::new();
    let mut listed = HashSet::new();
    for page in &outline.pages {
        if !valid_id(&page.id) {
            errors.push(format!("page id `{}` is not valid (a-z, 0-9 and dashes, at most 48)", page.id));
        } else if !ids.insert(page.id.clone()) {
            errors.push(format!("page id `{}` is used twice", page.id));
        }
        if page.title.trim().is_empty() {
            errors.push(format!("page `{}` has no title", page.id));
        }
        for file in &page.files {
            match resolve_in_project(project, file) {
                Ok(_) => {
                    if let Ok(clean) = super::store::clean_rel(file) {
                        listed.insert(clean);
                    }
                }
                Err(p) => errors.push(format!("page `{}` lists `{file}`, which {}", page.id, path_problem_text(p))),
            }
        }
    }
    for path in required {
        if !listed.contains(path) {
            errors.push(format!("the important file `{path}` is on no page"));
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}

fn path_problem_text(p: PathProblem) -> &'static str {
    match p {
        PathProblem::Absolute => "is an absolute path",
        PathProblem::Escapes => "leaves the project",
        PathProblem::Missing => "does not exist",
        PathProblem::NotAFile => "is not a file",
    }
}

fn valid_node_id(id: &str) -> bool {
    valid_id(id) && id.len() <= 32
}

/// Errors in a graph, or none. `pages` are the ids of the pages that exist (a box may link to one).
pub fn check_graph(project: &Path, graph: &Graph, pages: &[String]) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if graph.nodes.is_empty() {
        errors.push("the diagram has no boxes".to_string());
    }
    if graph.nodes.len() > MAX_NODES {
        errors.push(format!("the diagram has {} boxes; the most allowed is {MAX_NODES}", graph.nodes.len()));
    }
    if graph.edges.len() > MAX_EDGES {
        errors.push(format!("the diagram has {} arrows; the most allowed is {MAX_EDGES}", graph.edges.len()));
    }
    let mut groups = HashSet::new();
    for g in &graph.groups {
        if !valid_node_id(&g.id) || !groups.insert(g.id.clone()) {
            errors.push(format!("group id `{}` is not valid or is used twice", g.id));
        }
    }
    let mut ids = HashSet::new();
    for n in &graph.nodes {
        if !valid_node_id(&n.id) {
            errors.push(format!("box id `{}` is not valid (a-z, 0-9, dashes, at most 32)", n.id));
        } else if !ids.insert(n.id.clone()) {
            errors.push(format!("box id `{}` is used twice", n.id));
        }
        if n.label.trim().is_empty() || n.label.chars().count() > 60 {
            errors.push(format!("box `{}` needs a label of 1 to 60 characters", n.id));
        }
        if !n.shape.is_empty() && !SHAPES.contains(&n.shape.as_str()) {
            errors.push(format!("box `{}` has an unknown shape `{}` (use {})", n.id, n.shape, SHAPES.join(", ")));
        }
        if let Some(path) = &n.path {
            if let Err(p) = resolve_in_project(project, path) {
                errors.push(format!("box `{}` points at `{path}`, which {}", n.id, path_problem_text(p)));
            }
        }
        if let Some(page) = &n.page {
            if !pages.iter().any(|p| p == page) {
                errors.push(format!("box `{}` links to page `{page}`, which does not exist", n.id));
            }
        }
        if let Some(group) = &n.group {
            if !groups.contains(group) {
                errors.push(format!("box `{}` is in group `{group}`, which is not listed", n.id));
            }
        }
    }
    for e in &graph.edges {
        for end in [&e.from, &e.to] {
            if !ids.contains(end) {
                errors.push(format!("an arrow uses `{end}`, which is not a box"));
            }
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
