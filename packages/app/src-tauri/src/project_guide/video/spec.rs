//! The shot language: what a beat is, and the checks every spec passes before anything is drawn. A spec has no
//! coordinates in its beats (the layout adds those) and only ids that exist in the guide's diagram.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::super::model::Graph;
use super::super::store;
use super::layout::Layouts;

pub const VERSION: u32 = 1;
pub const MAX_BEATS: usize = 30;
pub const MAX_CAPTION_CHARS: usize = 150;
pub const MIN_BEAT_SECONDS: f32 = 1.5;
pub const MAX_BEAT_SECONDS: f32 = 9.0;
pub const MAX_TOTAL_SECONDS: f32 = 120.0;
pub const MAX_FILES_PER_SHOT: usize = 6;
pub const FPS: u32 = 24;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Shot {
    /// Big title and a small line under it.
    Title { title: String, subtitle: String },
    /// A page of the guide as a card: its title and one line of it.
    Card { title: String, text: String },
    /// The diagram, with some boxes lit and some arrows drawn.
    Diagram { lit: Vec<String>, edges: Vec<[String; 2]> },
    /// A short list of files the guide cites.
    Files { title: String, paths: Vec<String> },
    /// The closing card.
    Outro { text: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Beat {
    pub id: String,
    /// Burned into the picture.
    pub caption: String,
    pub seconds: f32,
    pub shot: Shot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spec {
    pub version: u32,
    pub title: String,
    pub fps: u32,
    pub beats: Vec<Beat>,
    /// Boxes and arrows of the guide's diagram (ids and labels only; positions are in `layouts`).
    pub graph: Graph,
    pub layouts: Layouts,
}

impl Spec {
    pub fn total_seconds(&self) -> f32 {
        self.beats.iter().map(|b| b.seconds).sum()
    }
}

/// Every problem found, in plain words (empty = fine). With `project`, a file a shot names must exist there.
pub fn check(spec: &Spec, project: Option<&Path>) -> Vec<String> {
    let mut bad = Vec::new();
    if spec.version != VERSION {
        bad.push(format!("unknown version {}", spec.version));
    }
    if spec.beats.is_empty() || spec.beats.len() > MAX_BEATS {
        bad.push(format!("a tour needs 1 to {MAX_BEATS} beats, this has {}", spec.beats.len()));
    }
    if spec.total_seconds() > MAX_TOTAL_SECONDS {
        bad.push(format!("the tour is longer than {MAX_TOTAL_SECONDS} seconds"));
    }
    let known = |id: &str| spec.graph.nodes.iter().any(|n| n.id == id);
    let mut seen: Vec<&str> = Vec::new();
    for b in &spec.beats {
        let at = &b.id;
        if b.id.is_empty() || seen.contains(&b.id.as_str()) {
            bad.push(format!("{at}: the beat id is empty or used twice"));
        }
        seen.push(&b.id);
        let chars = b.caption.chars().count();
        if b.caption.trim().is_empty() || chars > MAX_CAPTION_CHARS {
            bad.push(format!("{at}: the caption must be 1 to {MAX_CAPTION_CHARS} characters"));
        }
        if !(MIN_BEAT_SECONDS..=MAX_BEAT_SECONDS).contains(&b.seconds) {
            bad.push(format!("{at}: a beat lasts {MIN_BEAT_SECONDS} to {MAX_BEAT_SECONDS} seconds"));
        }
        match &b.shot {
            Shot::Diagram { lit, edges } => {
                for id in lit.iter().chain(edges.iter().flatten()) {
                    if !known(id) {
                        bad.push(format!("{at}: `{id}` is not a box of the diagram"));
                    }
                }
                for [from, to] in edges {
                    if !spec.graph.edges.iter().any(|e| &e.from == from && &e.to == to) {
                        bad.push(format!("{at}: there is no arrow from `{from}` to `{to}`"));
                    }
                }
            }
            Shot::Files { paths, .. } => {
                if paths.is_empty() || paths.len() > MAX_FILES_PER_SHOT {
                    bad.push(format!("{at}: a files shot shows 1 to {MAX_FILES_PER_SHOT} files"));
                }
                for p in paths {
                    if store::clean_rel(p).is_err() {
                        bad.push(format!("{at}: `{p}` is not a path inside the project"));
                    } else if let Some(root) = project {
                        if store::resolve_file(root, p).is_err() {
                            bad.push(format!("{at}: `{p}` is not a file of the project"));
                        }
                    }
                }
            }
            Shot::Title { title, .. } | Shot::Card { title, .. } if title.trim().is_empty() => bad.push(format!("{at}: the shot has no title")),
            _ => {}
        }
    }
    bad
}
