//! The words an agent is told once, at the start of a chat: the fences and the pinned notes. Plain text, no agent names.

/// The note put in front of a chat's first message, or `None` when there is nothing to say.
pub fn preamble(fences: &[String], notes: Option<&str>) -> Option<String> {
    let notes = notes.map(str::trim).filter(|n| !n.is_empty());
    if fences.is_empty() && notes.is_none() {
        return None;
    }
    let mut out = String::from("[Rules from the person you work for. Follow them without being reminded.]\n");
    if !fences.is_empty() {
        out.push_str("Do not read into, change, delete, move or run anything that touches these paths of the project (they are fenced). If the task needs one, stop and ask:\n");
        for fence in fences.iter().take(50) {
            out.push_str(&format!("- {fence}\n"));
        }
    }
    if let Some(notes) = notes {
        out.push_str("Notes:\n");
        out.push_str(notes);
        out.push('\n');
    }
    out.push_str("[End of rules]\n\n");
    Some(out)
}
