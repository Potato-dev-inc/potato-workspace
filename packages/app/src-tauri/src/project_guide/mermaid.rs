//! Our own compiler from the checked graph to Mermaid. The agent never writes Mermaid, so it cannot write a broken
//! diagram or a link: box names in the output are `n0`, `n1`, ... (never the agent's ids), labels keep only letters,
//! digits, spaces and a few quiet marks, and the output has no `click`, no `href`, no HTML and no `%%` directives.
//!
//! Output grammar (the tests check every line against it):
//! ```text
//! flowchart LR
//!   subgraph g0["Label"]
//!     n0["Label"]
//!   end
//!   n1("Label")
//!   n0 -->|"label"| n1
//! ```

use std::collections::HashMap;

use super::model::Graph;

const LABEL_MAX: usize = 40;

/// A label made safe: letters, digits, space and `. , _ - / + ( )` only; long ones are cut; never empty.
pub fn safe_label(text: &str) -> String {
    let kept: String = text
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '.' | ',' | '_' | '-' | '/' | '+' | '(' | ')') { c } else { ' ' })
        .collect();
    let joined = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = joined.chars().take(LABEL_MAX).collect();
    let cut = cut.trim().to_string();
    if cut.is_empty() { "?".to_string() } else { cut }
}

fn shaped(shape: &str, label: &str) -> String {
    match shape {
        "round" => format!("(\"{label}\")"),
        "db" => format!("[(\"{label}\")]"),
        "circle" => format!("((\"{label}\"))"),
        "hex" => format!("{{{{\"{label}\"}}}}"),
        _ => format!("[\"{label}\"]"),
    }
}

/// The Mermaid text. The graph must have passed `check::check_graph` (an edge to an unknown box is dropped anyway).
pub fn compile(graph: &Graph) -> String {
    let index: HashMap<&str, usize> = graph.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let mut out = String::from("flowchart LR\n");
    for (gi, group) in graph.groups.iter().enumerate() {
        let members: Vec<usize> = graph.nodes.iter().enumerate().filter(|(_, n)| n.group.as_deref() == Some(group.id.as_str())).map(|(i, _)| i).collect();
        if members.is_empty() {
            continue;
        }
        out.push_str(&format!("  subgraph g{gi}[\"{}\"]\n", safe_label(&group.label)));
        for i in members {
            let n = &graph.nodes[i];
            out.push_str(&format!("    n{i}{}\n", shaped(&n.shape, &safe_label(&n.label))));
        }
        out.push_str("  end\n");
    }
    for (i, n) in graph.nodes.iter().enumerate() {
        let in_group = n.group.as_deref().is_some_and(|g| graph.groups.iter().any(|x| x.id == g));
        if !in_group {
            out.push_str(&format!("  n{i}{}\n", shaped(&n.shape, &safe_label(&n.label))));
        }
    }
    for e in &graph.edges {
        let (Some(a), Some(b)) = (index.get(e.from.as_str()), index.get(e.to.as_str())) else { continue };
        match e.label.as_deref().map(safe_label).filter(|_| e.label.as_deref().is_some_and(|l| !l.trim().is_empty())) {
            Some(label) => out.push_str(&format!("  n{a} -->|\"{label}\"| n{b}\n")),
            None => out.push_str(&format!("  n{a} --> n{b}\n")),
        }
    }
    out
}
