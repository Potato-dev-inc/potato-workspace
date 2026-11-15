//! The dry-run agent: a deterministic stand-in that "writes" a guide without any model, so the whole flow (consent,
//! steps, checks, files, tab) can be exercised for free. It reads the project itself and answers each step with
//! valid text whose citations are real. Tests wrap it to make it misbehave; a debug build offers it as the agent
//! `dry-run` (never in a release build unless `PM_GUIDE_DRY_RUN=1`).

use std::path::Path;
use std::sync::atomic::AtomicBool;

use super::model::{Edge, Graph, Group, Node, Outline, OutlinePage};
use super::prompts::{TASK_GRAPH, TASK_OUTLINE, TASK_PAGE};
use super::run::{GuideAgent, Reply};
use super::scan::{scan_with, Scan};
use super::store;

pub const DRY_RUN_AGENT: &str = "dry-run";

/// Is the dry-run agent allowed in this build?
pub fn dry_run_allowed() -> bool {
    cfg!(debug_assertions) || std::env::var("PM_GUIDE_DRY_RUN").is_ok_and(|v| v == "1")
}

#[derive(Debug, Default, Clone, Copy)]
pub struct DryRunAgent;

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(24).collect::<String>().trim_matches('-').to_string()
}

fn outline_of(scan: &Scan) -> Outline {
    let mut pages = vec![OutlinePage {
        id: "overview".into(),
        title: "Overview".into(),
        purpose: "What this project is and where to start.".into(),
        files: scan.top_paths(5),
    }];
    let mut seen: Vec<String> = Vec::new();
    for f in &scan.files {
        let Some((dir, _)) = f.path.split_once('/') else { continue };
        let id = slug(dir);
        if id.is_empty() || id == "overview" || seen.contains(&id) || seen.len() >= 4 {
            continue;
        }
        seen.push(id.clone());
        let files: Vec<String> = scan.files.iter().filter(|g| g.path.starts_with(&format!("{dir}/"))).take(3).map(|g| g.path.clone()).collect();
        pages.push(OutlinePage { id, title: format!("The {dir} folder"), purpose: format!("What lives in {dir}."), files });
    }
    Outline { pages }
}

fn lines_of(project: &Path, rel: &str) -> usize {
    store::resolve_file(project, rel).ok().and_then(|p| std::fs::read(p).ok()).map(|b| String::from_utf8_lossy(&b).lines().count()).unwrap_or(0)
}

impl GuideAgent for DryRunAgent {
    fn label(&self) -> String {
        DRY_RUN_AGENT.into()
    }

    fn ask(&self, task: &str, project: &Path, _stop: &AtomicBool) -> Result<Reply, String> {
        let text = if task.starts_with(TASK_OUTLINE) {
            let scan = scan_with(project, &store::read_steering(project), None);
            serde_json::to_string(&outline_of(&scan)).map_err(|e| e.to_string())?
        } else if let Some(rest) = task.strip_prefix(TASK_PAGE) {
            let id = rest.lines().next().unwrap_or("").trim().to_string();
            let outline = store::read_outline(project).ok_or("no outline")?;
            let page = outline.pages.iter().find(|p| p.id == id).ok_or("no such page")?;
            let mut md = format!("# {}\n\n{}\n\n", page.title, page.purpose);
            for file in &page.files {
                let n = lines_of(project, file).min(5);
                if n > 0 {
                    md.push_str(&format!("- `{file}` is one of the main files here. [[{file}:1-{n}]]\n"));
                } else {
                    md.push_str(&format!("- `{file}` is one of the main files here. [[{file}]]\n"));
                }
            }
            md
        } else if task.starts_with(TASK_GRAPH) {
            let outline = store::read_outline(project).ok_or("no outline")?;
            let nodes: Vec<Node> = outline
                .pages
                .iter()
                .map(|p| Node { id: p.id.clone(), label: p.title.clone(), shape: "box".into(), path: p.files.first().cloned(), page: Some(p.id.clone()), group: Some("parts".into()) })
                .collect();
            let edges = outline.pages.iter().skip(1).map(|p| Edge { from: "overview".into(), to: p.id.clone(), label: Some("uses".into()) }).collect();
            let graph = Graph { groups: vec![Group { id: "parts".into(), label: "Parts".into() }], nodes, edges };
            serde_json::to_string(&graph).map_err(|e| e.to_string())?
        } else {
            return Err("the dry-run agent does not know this task".into());
        };
        Ok(Reply { text, tokens: Some(100) })
    }
}
