//! Layout, computed by code. Nobody who writes a shot (a model included) gives a coordinate; this file decides where
//! the boxes, the arrows, the card and the caption go, for a wide picture (1920x1080) and a tall one (1080x1920).
//! Boxes are placed in ranks (a box comes after the boxes that point at it); a deep chain falls back to a grid.

use serde::{Deserialize, Serialize};

use super::super::model::Graph;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    #[cfg(test)]
    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    #[cfg(test)]
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
    pub fn center(&self) -> (f32, f32) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
    #[cfg(test)]
    pub fn overlaps(&self, o: &Rect) -> bool {
        self.x < o.right() && o.x < self.right() && self.y < o.bottom() && o.y < self.bottom()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeBox {
    pub id: String,
    pub label: String,
    pub rect: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EdgeLine {
    pub from: String,
    pub to: String,
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub width: u32,
    pub height: u32,
    /// Where the diagram lives.
    pub diagram: Rect,
    /// Where the card of a `card`, `files`, `title` or `outro` shot lives.
    pub card: Rect,
    /// The caption band at the bottom.
    pub caption: Rect,
    pub nodes: Vec<NodeBox>,
    pub edges: Vec<EdgeLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layouts {
    pub landscape: Layout,
    pub vertical: Layout,
}

pub fn layouts(graph: &Graph) -> Layouts {
    Layouts {
        landscape: layout(graph, 1920, 1080, true),
        vertical: layout(graph, 1080, 1920, false),
    }
}

/// Ranks: 0 for boxes nothing points at, then one more than the deepest box pointing at it. Arrows that would close a
/// circle are ignored for the ranking (they are still drawn).
pub fn ranks(graph: &Graph) -> Vec<usize> {
    let n = graph.nodes.len();
    let index = |id: &str| graph.nodes.iter().position(|x| x.id == id);
    let edges: Vec<(usize, usize)> = graph.edges.iter().filter_map(|e| Some((index(&e.from)?, index(&e.to)?))).filter(|(a, b)| a != b).collect();
    // Depth-first search for the arrows that close a circle.
    let mut state = vec![0u8; n]; // 0 new, 1 on the path, 2 done
    let mut back: Vec<(usize, usize)> = Vec::new();
    fn visit(u: usize, edges: &[(usize, usize)], state: &mut [u8], back: &mut Vec<(usize, usize)>) {
        state[u] = 1;
        for &(a, b) in edges.iter().filter(|(a, _)| *a == u) {
            match state[b] {
                0 => visit(b, edges, state, back),
                1 => back.push((a, b)),
                _ => {}
            }
        }
        state[u] = 2;
    }
    let mut has_in = vec![false; n];
    for &(_, b) in &edges {
        has_in[b] = true;
    }
    for u in (0..n).filter(|u| !has_in[*u]).chain(0..n) {
        if state[u] == 0 {
            visit(u, &edges, &mut state, &mut back);
        }
    }
    let forward: Vec<(usize, usize)> = edges.into_iter().filter(|e| !back.contains(e)).collect();
    let mut rank = vec![0usize; n];
    for _ in 0..n {
        let mut changed = false;
        for &(a, b) in &forward {
            if rank[b] < rank[a] + 1 {
                rank[b] = rank[a] + 1;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    rank
}

fn natural_width(label: &str) -> f32 {
    (80.0 + label.chars().count() as f32 * 15.0).clamp(220.0, 360.0)
}

fn clip(from: &Rect, to: &Rect) -> (f32, f32, f32, f32) {
    let (cx1, cy1) = from.center();
    let (cx2, cy2) = to.center();
    let edge = |r: &Rect, (px, py): (f32, f32), (qx, qy): (f32, f32)| -> (f32, f32) {
        // From the centre p towards q, where the line leaves the rectangle.
        let (dx, dy) = (qx - px, qy - py);
        let tx = if dx.abs() < 1e-3 { f32::INFINITY } else { (r.w / 2.0) / dx.abs() };
        let ty = if dy.abs() < 1e-3 { f32::INFINITY } else { (r.h / 2.0) / dy.abs() };
        let t = tx.min(ty).min(1.0);
        (px + dx * t, py + dy * t)
    };
    let a = edge(from, (cx1, cy1), (cx2, cy2));
    let b = edge(to, (cx2, cy2), (cx1, cy1));
    (a.0, a.1, b.0, b.1)
}

pub fn layout(graph: &Graph, width: u32, height: u32, wide: bool) -> Layout {
    let w = width as f32;
    let (diagram, card, caption) = if wide {
        (Rect { x: 80.0, y: 90.0, w: w - 160.0, h: 700.0 }, Rect { x: 240.0, y: 150.0, w: w - 480.0, h: 600.0 }, Rect { x: 120.0, y: 840.0, w: w - 240.0, h: 180.0 })
    } else {
        (Rect { x: 60.0, y: 140.0, w: w - 120.0, h: 1120.0 }, Rect { x: 80.0, y: 260.0, w: w - 160.0, h: 900.0 }, Rect { x: 70.0, y: 1380.0, w: w - 140.0, h: 360.0 })
    };
    let n = graph.nodes.len();
    let rank = ranks(graph);
    let max_rank = rank.iter().copied().max().unwrap_or(0);
    // The ranks run left to right in a wide picture and top to bottom in a tall one.
    let along = if wide { diagram.w } else { diagram.h };
    let across = if wide { diagram.h } else { diagram.w };
    let mut per_rank = vec![0usize; max_rank + 1];
    for r in &rank {
        per_rank[*r] += 1;
    }
    let widest = per_rank.iter().copied().max().unwrap_or(1).max(1);
    // Too many ranks (a long chain) or too many boxes in one rank (a crowd) would make tiny boxes: use a grid.
    let too_deep = (max_rank + 1) as f32 * 150.0 > along || widest as f32 * 70.0 > across;
    // slot = (place along the flow, place across it); counts of each
    let mut slots: Vec<(usize, usize)> = Vec::with_capacity(n);
    let (cols, rows);
    if too_deep && n > 0 {
        let c = ((n as f32).sqrt() * 1.6).ceil().max(1.0) as usize;
        let c = c.min(n);
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| (rank[i], i));
        slots = vec![(0, 0); n];
        for (k, &i) in order.iter().enumerate() {
            slots[i] = (k % c, k / c);
        }
        cols = c;
        rows = n.div_ceil(c);
    } else {
        let mut next = vec![0usize; max_rank + 1];
        for i in 0..n {
            slots.push((rank[i], next[rank[i]]));
            next[rank[i]] += 1;
        }
        cols = max_rank + 1;
        rows = widest;
    }
    // The grid is cols x rows in "flow x across" terms; map to x/y.
    let (gx, gy) = if wide { (cols, rows) } else { (rows, cols) };
    let cell_w = diagram.w / gx.max(1) as f32;
    let cell_h = diagram.h / gy.max(1) as f32;
    let mut nodes = Vec::with_capacity(n);
    for (i, node) in graph.nodes.iter().enumerate() {
        let (flow, side) = slots[i];
        let (cx, cy) = if wide { (flow, side) } else { (side, flow) };
        let bw = natural_width(&node.label).min(cell_w * 0.82);
        let bh = 96.0f32.min(cell_h * 0.62);
        let x = diagram.x + cell_w * (cx as f32 + 0.5) - bw / 2.0;
        let y = diagram.y + cell_h * (cy as f32 + 0.5) - bh / 2.0;
        nodes.push(NodeBox { id: node.id.clone(), label: node.label.clone(), rect: Rect { x, y, w: bw, h: bh } });
    }
    let mut edges = Vec::new();
    for e in &graph.edges {
        let (Some(a), Some(b)) = (nodes.iter().find(|x| x.id == e.from), nodes.iter().find(|x| x.id == e.to)) else { continue };
        if a.id == b.id {
            continue;
        }
        let (x1, y1, x2, y2) = clip(&a.rect, &b.rect);
        edges.push(EdgeLine { from: e.from.clone(), to: e.to.clone(), x1, y1, x2, y2 });
    }
    Layout { width, height, diagram, card, caption, nodes, edges }
}
