//! The step machine (plan section 7). Our code owns every step; the agent is asked questions through [`GuideAgent`]
//! and only returns text, which `check.rs` checks before anything is written.
//!
//! 0. Look (no model)  2. Outline (1 ask, 1 retry)  3. Pages (1 ask per page, 3 at a time, 1 retry each)
//! 4. Diagram (1 ask, 1 retry, drawn by `mermaid.rs`)  5. Manifest (written after the outline and after every page).
//! Refresh rewrites only the stale pages, and the diagram only when a file on it changed.
//!
//! Stop: the flag is looked at before every ask; the pages already finished stay (the manifest says `complete: false`).
//! Starting needs the consent token (`consent.rs`); that check is in [`start_checked`].

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use super::check::{self, check_graph, check_outline, check_page, cited_paths};
use super::consent::{consume_token, Size};
use super::mermaid;
use super::model::{Cited, DiagramRecord, Graph, Manifest, Outline, OutlinePage, PageRecord};
use super::prompts;
use super::scan;
use super::stale::{diagram_stale, stale_pages};
use super::store;

/// How many helper runs go at once (the usage rule).
pub const PARALLEL: usize = 3;
/// A page needs this many distinct cited files to pass.
pub const MIN_CITATIONS: usize = 1;
const STOPPED: &str = "stopped";

#[derive(Debug, Clone, Default)]
pub struct Reply {
    pub text: String,
    /// Tokens the agent said it used, when it said.
    pub tokens: Option<u64>,
}

/// The one door to a model. Generic code never names an agent; the person's chosen agent sits behind this.
pub trait GuideAgent: Send + Sync {
    fn label(&self) -> String;
    fn model(&self) -> Option<String> {
        None
    }
    fn ask(&self, task: &str, project: &Path, stop: &AtomicBool) -> Result<Reply, String>;
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub size: Size,
    pub parallel: usize,
    pub min_citations: usize,
    /// Continue an unfinished run: keep the outline and the pages that are done.
    pub resume: bool,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self { size: Size::Normal, parallel: PARALLEL, min_citations: MIN_CITATIONS, resume: false }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressState {
    /// `look` | `outline` | `pages` | `diagram` | `done` | `stopped` | `failed`
    pub phase: String,
    pub pages_total: usize,
    pub pages_done: usize,
    pub current: Vec<String>,
    pub calls: u32,
    pub tokens: u64,
    pub error: Option<String>,
    pub notes: Vec<String>,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
}

#[derive(Clone, Default)]
pub struct Progress(Arc<Mutex<ProgressState>>);

impl Progress {
    pub fn new() -> Self {
        let p = Self::default();
        p.0.lock().started_ms = store::now_ms();
        p
    }
    pub fn snapshot(&self) -> ProgressState {
        self.0.lock().clone()
    }
    fn set(&self, f: impl FnOnce(&mut ProgressState)) {
        f(&mut self.0.lock());
    }
    fn phase(&self, phase: &str) {
        self.set(|s| s.phase = phase.to_string());
    }
    fn note(&self, text: String) {
        self.set(|s| s.notes.push(text));
    }
    fn finish(&self, phase: &str, error: Option<String>) {
        self.set(|s| {
            s.phase = phase.to_string();
            s.error = error;
            s.current.clear();
            s.finished_ms = Some(store::now_ms());
        });
    }
}

fn ask(agent: &dyn GuideAgent, task: &str, project: &Path, stop: &AtomicBool, progress: &Progress) -> Result<Reply, String> {
    if stop.load(Ordering::SeqCst) {
        return Err(STOPPED.into());
    }
    progress.set(|s| s.calls += 1);
    let reply = agent.ask(task, project, stop);
    if let Ok(r) = &reply {
        if let Some(t) = r.tokens {
            progress.set(|s| s.tokens += t);
        }
    }
    if stop.load(Ordering::SeqCst) {
        return Err(STOPPED.into());
    }
    reply
}

fn project_name(project: &Path) -> String {
    project.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".into())
}

fn hashed(project: &Path, paths: &[String]) -> Vec<Cited> {
    paths.iter().filter_map(|p| store::file_hash(project, p).map(|hash| Cited { path: p.clone(), hash })).collect()
}

/// Step 2. Two tries; the second carries the exact errors.
fn outline_step(project: &Path, agent: &dyn GuideAgent, opts: &RunOptions, scan: &scan::Scan, stop: &AtomicBool, progress: &Progress) -> Result<Outline, String> {
    let steering = store::read_steering(project);
    let index = prompts::source_index(project, scan);
    let required = scan.top_paths(5);
    let cap = opts.size.page_cap();
    let mut errors: Option<String> = None;
    for _ in 0..2 {
        let prompt = prompts::outline_prompt(&project_name(project), &index, &steering, cap, &required, errors.as_deref());
        let reply = ask(agent, &prompt, project, stop, progress)?;
        let mut problems = match prompts::parse_outline(&reply.text) {
            Ok(outline) => match check_outline(project, &outline, &required) {
                Ok(()) if outline.pages.len() <= cap => return Ok(outline),
                Ok(()) => vec![format!("the outline has {} pages; at this size the most is {cap}", outline.pages.len())],
                Err(list) => list,
            },
            Err(e) => vec![e],
        };
        problems.truncate(12);
        errors = Some(problems.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n"));
    }
    Err(format!("The agent's outline did not pass the check:\n{}", errors.unwrap_or_default()))
}

/// Step 3 for one page. `Err("stopped")` only when stopped; a bad page still gives a record (marked needs_review).
fn page_step(project: &Path, agent: &dyn GuideAgent, outline: &Outline, page: &OutlinePage, opts: &RunOptions, stop: &AtomicBool, progress: &Progress) -> Result<PageRecord, String> {
    let steering = store::read_steering(project);
    let name = project_name(project);
    let mut errors: Option<String> = None;
    let mut last: Option<(String, check::PageCheck)> = None;
    let mut passed: Option<(String, check::PageCheck)> = None;
    for _ in 0..2 {
        let prompt = prompts::page_prompt(&name, outline, page, &steering, errors.as_deref());
        let reply = match ask(agent, &prompt, project, stop, progress) {
            Ok(r) => r,
            Err(e) if e == STOPPED => return Err(e),
            Err(e) => {
                errors = Some(format!("- the run failed ({e}); write the page again"));
                continue;
            }
        };
        let text = prompts::page_text(&reply.text);
        let c = check_page(project, &text, opts.min_citations);
        if c.passes() {
            passed = Some((text, c));
            break;
        }
        errors = Some(c.feedback(opts.min_citations));
        last = Some((text, c));
    }
    let (text, c, needs_review) = match (passed, last) {
        (Some((t, c)), _) => (t, c, false),
        (None, Some((t, c))) => (check::strip_bad(&t, &c), c, true),
        (None, None) => ("This page could not be written. Use Refresh to try again.".to_string(), Default::default(), true),
    };
    let text = check::redact(&text);
    store::write_page(project, &page.id, &text)?;
    Ok(PageRecord { id: page.id.clone(), title: page.title.clone(), purpose: page.purpose.clone(), cited: hashed(project, &cited_paths(&c)), needs_review })
}

/// Runs `todo` pages, `parallel` at a time. `done` gets each finished record (called from a worker thread).
fn run_pages(project: &Path, agent: &dyn GuideAgent, outline: &Outline, todo: &[OutlinePage], opts: &RunOptions, stop: &AtomicBool, progress: &Progress, done: &(dyn Fn(PageRecord) + Sync)) {
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..opts.parallel.max(1).min(todo.len().max(1)) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= todo.len() || stop.load(Ordering::SeqCst) {
                    break;
                }
                let page = &todo[i];
                progress.set(|s| s.current.push(page.id.clone()));
                let result = page_step(project, agent, outline, page, opts, stop, progress);
                progress.set(|s| s.current.retain(|c| c != &page.id));
                match result {
                    Ok(record) => {
                        done(record);
                        progress.set(|s| s.pages_done += 1);
                    }
                    Err(_) => break,
                }
            });
        }
    });
}

/// Step 4. Returns the checked graph, or `None` (with a note) when two tries did not pass: a guide without a diagram is fine.
fn graph_step(project: &Path, agent: &dyn GuideAgent, outline: &Outline, page_ids: &[String], stop: &AtomicBool, progress: &Progress) -> Result<Option<Graph>, String> {
    let name = project_name(project);
    let mut errors: Option<String> = None;
    for _ in 0..2 {
        let prompt = prompts::graph_prompt(&name, outline, errors.as_deref());
        let reply = match ask(agent, &prompt, project, stop, progress) {
            Ok(r) => r,
            Err(e) if e == STOPPED => return Err(e),
            Err(e) => {
                errors = Some(format!("- the run failed ({e})"));
                continue;
            }
        };
        let problems = match prompts::parse_graph(&reply.text) {
            Ok(graph) => match check_graph(project, &graph, page_ids) {
                Ok(()) => return Ok(Some(graph)),
                Err(list) => list,
            },
            Err(e) => vec![e],
        };
        errors = Some(problems.into_iter().take(12).map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n"));
    }
    progress.note("The diagram did not pass the check, so it was left out.".into());
    Ok(None)
}

fn save_graph(project: &Path, graph: &Graph) -> Result<DiagramRecord, String> {
    store::write_graph(project, graph, &mermaid::compile(graph))?;
    let mut paths: Vec<String> = graph.nodes.iter().filter_map(|n| n.path.clone()).filter_map(|p| store::clean_rel(&p).ok()).collect();
    paths.sort();
    paths.dedup();
    let files: Vec<String> = paths.into_iter().filter(|p| store::resolve_file(project, p).is_ok()).collect();
    Ok(DiagramRecord { cited: hashed(project, &files) })
}

fn sort_like_outline(manifest: &mut Manifest, outline: &Outline) {
    let pos = |id: &str| outline.pages.iter().position(|p| p.id == id).unwrap_or(usize::MAX);
    manifest.pages.sort_by_key(|p| pos(&p.id));
}

fn put_record(manifest: &mut Manifest, record: PageRecord) {
    match manifest.pages.iter_mut().find(|p| p.id == record.id) {
        Some(slot) => *slot = record,
        None => manifest.pages.push(record),
    }
}

/// A whole first run (or a resume). Returns the manifest as written.
pub fn generate(project: &Path, agent: &dyn GuideAgent, opts: &RunOptions, progress: &Progress, stop: &AtomicBool) -> Result<Manifest, String> {
    let result = generate_inner(project, agent, opts, progress, stop);
    match &result {
        Ok(m) if m.complete => progress.finish("done", None),
        Ok(_) => progress.finish("stopped", None),
        Err(e) if e == STOPPED => progress.finish("stopped", None),
        Err(e) => progress.finish("failed", Some(e.clone())),
    }
    result
}

fn generate_inner(project: &Path, agent: &dyn GuideAgent, opts: &RunOptions, progress: &Progress, stop: &AtomicBool) -> Result<Manifest, String> {
    progress.phase("look");
    let scanned = scan::scan(project);
    let resumed = if opts.resume { store::read_outline(project).zip(store::read_manifest(project)).filter(|(_, m)| !m.complete) } else { None };
    let (outline, mut manifest) = match resumed {
        Some((o, m)) => (o, m),
        None => {
            progress.phase("outline");
            let outline = outline_step_or_stopped(project, agent, opts, &scanned, stop, progress)?;
            store::write_outline(project, &outline)?;
            let manifest = Manifest {
                version: 1,
                commit: store::current_commit(project),
                written_at_ms: store::now_ms(),
                agent: agent.label(),
                model: agent.model(),
                tokens: None,
                complete: false,
                pages: vec![],
                diagram: None,
            };
            store::write_manifest(project, &manifest)?;
            (outline, manifest)
        }
    };
    progress.set(|s| {
        s.pages_total = outline.pages.len();
        s.pages_done = manifest.pages.len();
    });

    progress.phase("pages");
    let todo: Vec<OutlinePage> = outline.pages.iter().filter(|p| !manifest.pages.iter().any(|m| m.id == p.id)).cloned().collect();
    let shared = Mutex::new(manifest.clone());
    run_pages(project, agent, &outline, &todo, opts, stop, progress, &|record| {
        let mut m = shared.lock();
        put_record(&mut m, record);
        sort_like_outline(&mut m, &outline);
        let _ = store::write_manifest(project, &m);
    });
    manifest = shared.into_inner();

    let stopped = stop.load(Ordering::SeqCst);
    if !stopped {
        progress.phase("diagram");
        let ids: Vec<String> = manifest.pages.iter().map(|p| p.id.clone()).collect();
        match graph_step(project, agent, &outline, &ids, stop, progress) {
            Ok(Some(graph)) => manifest.diagram = Some(save_graph(project, &graph)?),
            Ok(None) => {}
            Err(_) => {}
        }
    }
    manifest.complete = !stop.load(Ordering::SeqCst) && manifest.pages.len() == outline.pages.len();
    manifest.tokens = Some(progress.snapshot().tokens).filter(|t| *t > 0);
    manifest.written_at_ms = store::now_ms();
    store::write_manifest(project, &manifest)?;
    Ok(manifest)
}

fn outline_step_or_stopped(project: &Path, agent: &dyn GuideAgent, opts: &RunOptions, scanned: &scan::Scan, stop: &AtomicBool, progress: &Progress) -> Result<Outline, String> {
    outline_step(project, agent, opts, scanned, stop, progress)
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReport {
    pub rewritten: Vec<String>,
    pub diagram: bool,
}

/// Rewrites only the stale pages (and the diagram only if a file on it changed).
pub fn refresh(project: &Path, agent: &dyn GuideAgent, opts: &RunOptions, progress: &Progress, stop: &AtomicBool) -> Result<RefreshReport, String> {
    let result = refresh_inner(project, agent, opts, progress, stop);
    match &result {
        Ok(_) => progress.finish(if stop.load(Ordering::SeqCst) { "stopped" } else { "done" }, None),
        Err(e) if e == STOPPED => progress.finish("stopped", None),
        Err(e) => progress.finish("failed", Some(e.clone())),
    }
    result
}

fn refresh_inner(project: &Path, agent: &dyn GuideAgent, opts: &RunOptions, progress: &Progress, stop: &AtomicBool) -> Result<RefreshReport, String> {
    let mut manifest = store::read_manifest(project).ok_or("There is no guide to refresh.")?;
    let stale = stale_pages(project, &manifest);
    let want_diagram = diagram_stale(project, &manifest);
    let outline = store::read_outline(project).unwrap_or_else(|| Outline {
        pages: manifest.pages.iter().map(|p| OutlinePage { id: p.id.clone(), title: p.title.clone(), purpose: p.purpose.clone(), files: p.cited.iter().map(|c| c.path.clone()).collect() }).collect(),
    });
    // A stale page is started from the files it cited that still exist, plus its outline files.
    let todo: Vec<OutlinePage> = stale
        .iter()
        .filter_map(|s| outline.pages.iter().find(|p| p.id == s.id).cloned())
        .map(|mut p| {
            p.files.retain(|f| store::resolve_file(project, f).is_ok());
            p
        })
        .collect();
    progress.set(|s| {
        s.pages_total = todo.len();
        s.pages_done = 0;
    });
    progress.phase("pages");
    let shared = Mutex::new(manifest.clone());
    run_pages(project, agent, &outline, &todo, opts, stop, progress, &|record| {
        let mut m = shared.lock();
        put_record(&mut m, record);
        sort_like_outline(&mut m, &outline);
        let _ = store::write_manifest(project, &m);
    });
    manifest = shared.into_inner();
    let rewritten: Vec<String> = todo.iter().filter(|t| manifest.pages.iter().any(|m| m.id == t.id)).map(|t| t.id.clone()).collect();
    let mut diagram = false;
    if want_diagram && !stop.load(Ordering::SeqCst) {
        progress.phase("diagram");
        let ids: Vec<String> = manifest.pages.iter().map(|p| p.id.clone()).collect();
        if let Ok(Some(graph)) = graph_step(project, agent, &outline, &ids, stop, progress) {
            manifest.diagram = Some(save_graph(project, &graph)?);
            diagram = true;
        }
    }
    manifest.written_at_ms = store::now_ms();
    manifest.commit = store::current_commit(project).or(manifest.commit);
    store::write_manifest(project, &manifest)?;
    Ok(RefreshReport { rewritten, diagram })
}

/// The only way the app starts a run: the consent token must be valid. Without one nothing runs.
pub fn start_checked(project: &Path, token: &str) -> Result<(), String> {
    if consume_token(project, token) {
        Ok(())
    } else {
        Err("GUIDE_NO_CONSENT: Look at the estimate first, then choose Make the guide.".into())
    }
}
