//! Reading a finished guide: for the Guide tab and (later) for agents through MCP. Read-only. A page id from outside
//! is checked (`valid_id`) before it touches the disk, so `../../x` can never be read.

use std::path::Path;

use serde::Serialize;

use super::model::valid_id;
use super::stale::{changed_files, diagram_stale, stale_pages};
use super::store;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    pub purpose: String,
    pub stale: bool,
    pub needs_review: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    pub commit: Option<String>,
    pub written_at_ms: u64,
    pub agent: String,
    pub model: Option<String>,
    pub complete: bool,
    pub pages: Vec<PageSummary>,
    pub diagram: bool,
    pub diagram_stale: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    pub id: String,
    pub title: String,
    pub markdown: String,
    pub stale: bool,
    pub changed: Vec<String>,
    pub needs_review: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramBox {
    pub label: String,
    pub path: Option<String>,
    pub page: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramView {
    pub mermaid: String,
    pub boxes: Vec<DiagramBox>,
    pub stale: bool,
}

pub fn structure(project: &Path) -> Option<Structure> {
    let manifest = store::read_manifest(project)?;
    let stale = stale_pages(project, &manifest);
    let pages = manifest
        .pages
        .iter()
        .map(|p| PageSummary {
            id: p.id.clone(),
            title: p.title.clone(),
            purpose: p.purpose.clone(),
            stale: stale.iter().any(|s| s.id == p.id),
            needs_review: p.needs_review,
        })
        .collect();
    Some(Structure {
        commit: manifest.commit.clone(),
        written_at_ms: manifest.written_at_ms,
        agent: manifest.agent.clone(),
        model: manifest.model.clone(),
        complete: manifest.complete,
        pages,
        diagram: store::read_diagram(project).is_some(),
        diagram_stale: diagram_stale(project, &manifest),
    })
}

pub fn page(project: &Path, id: &str) -> Option<PageView> {
    if !valid_id(id) {
        return None;
    }
    let manifest = store::read_manifest(project)?;
    let record = manifest.pages.iter().find(|p| p.id == id)?;
    let markdown = store::read_page(project, id)?;
    let changed = changed_files(project, &record.cited);
    Some(PageView { id: record.id.clone(), title: record.title.clone(), markdown, stale: !changed.is_empty(), changed, needs_review: record.needs_review })
}

/// The page for an agent: when it is stale, the first line says so and names the files.
pub fn page_for_agent(view: &PageView) -> String {
    if view.stale {
        format!("Parts of this page may be out of date: {}. Trust the code over this page.\n\n{}", view.changed.join(", "), view.markdown)
    } else {
        view.markdown.clone()
    }
}

pub fn diagram(project: &Path) -> Option<DiagramView> {
    let mermaid = store::read_diagram(project)?;
    let graph = store::read_graph(project).unwrap_or_default();
    let manifest = store::read_manifest(project);
    let stale = manifest.as_ref().is_some_and(|m| diagram_stale(project, m));
    let boxes = graph.nodes.iter().map(|n| DiagramBox { label: super::mermaid::safe_label(&n.label), path: n.path.clone(), page: n.page.clone() }).collect();
    Some(DiagramView { mermaid, boxes, stale })
}
