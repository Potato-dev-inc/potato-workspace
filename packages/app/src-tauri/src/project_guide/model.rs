//! The shapes that are written to disk (`outline.json`, `graph.json`, `manifest.json`).

use serde::{Deserialize, Serialize};

/// Most pages a guide may have, whatever the project size.
pub const MAX_PAGES: usize = 30;
/// Most boxes in the diagram.
pub const MAX_NODES: usize = 40;
/// Most arrows in the diagram.
pub const MAX_EDGES: usize = 120;

/// `[a-z0-9-]`, 1 to 48 characters, not starting with a dash. An id can never leave the guide folder.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && !id.starts_with('-') && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct OutlinePage {
    pub id: String,
    pub title: String,
    pub purpose: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Outline {
    pub pages: Vec<OutlinePage>,
}

/// A file a page cites, with its content hash when the page was written.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Cited {
    pub path: String,
    pub hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageRecord {
    pub id: String,
    pub title: String,
    pub purpose: String,
    pub cited: Vec<Cited>,
    /// A citation was removed because it could not be checked, or the page never passed the check.
    pub needs_review: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DiagramRecord {
    pub cited: Vec<Cited>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub commit: Option<String>,
    pub written_at_ms: u64,
    pub agent: String,
    pub model: Option<String>,
    /// Tokens the run used, when the agent said so.
    pub tokens: Option<u64>,
    /// False while a run is going or after a stop: the pages listed are the finished ones.
    pub complete: bool,
    pub pages: Vec<PageRecord>,
    pub diagram: Option<DiagramRecord>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Group {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Node {
    pub id: String,
    pub label: String,
    /// `box` (default), `round`, `db`, `circle` or `hex`.
    pub shape: String,
    /// A file or folder of the project this box stands for.
    pub path: Option<String>,
    /// The guide page this box links to.
    pub page: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Graph {
    pub groups: Vec<Group>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

pub const SHAPES: &[&str] = &["box", "round", "db", "circle", "hex"];
