//! What the `show_artifact` tool does: make (or update) an artifact from the agent's arguments, and tell the chat.

use std::path::Path;

use serde_json::{json, Value};

use super::model::{announce_item, Artifact, ArtifactKind};
use super::store::{add_version, read_project_file, slug, sync_folder, ArtifactError};

/// The kind a page is, when the agent did not say: from the file name, else from how the text starts.
pub fn sniff_kind(path: Option<&str>, content: &str) -> ArtifactKind {
    if let Some(kind) = path.and_then(ArtifactKind::from_name) {
        return kind;
    }
    let head = content.trim_start();
    let lower: String = head.chars().take(64).collect::<String>().to_ascii_lowercase();
    if lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg")) {
        return ArtifactKind::Svg;
    }
    if lower.starts_with("<!doctype") || lower.starts_with("<html") || lower.starts_with("<body") || lower.starts_with("<div") || lower.starts_with("<style") {
        return ArtifactKind::Html;
    }
    const MERMAID: &[&str] = &["graph ", "flowchart ", "sequencediagram", "classdiagram", "statediagram", "erdiagram", "gantt", "pie", "journey", "mindmap", "timeline", "gitgraph"];
    if MERMAID.iter().any(|word| lower.starts_with(word)) {
        return ArtifactKind::Mermaid;
    }
    ArtifactKind::Markdown
}

/// The result of one `show_artifact` call.
#[derive(Debug, Clone)]
pub struct Shown {
    pub artifact: Artifact,
    pub version: u32,
    /// A version was added (false: the same page as the latest one).
    pub added: bool,
}

/// Makes or updates the artifact the arguments describe: `{title?, id?, kind?, content? | path?}`.
pub fn show(project: &Path, args: &Value) -> Result<Shown, ArtifactError> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let path = text("path");
    let inline = args.get("content").and_then(Value::as_str).filter(|s| !s.trim().is_empty());
    let content = match (inline, path) {
        (Some(inline), _) => inline.to_string(),
        (None, Some(path)) => read_project_file(project, path)?,
        (None, None) => return Err(ArtifactError::Empty),
    };
    let kind = match text("kind") {
        Some(word) => ArtifactKind::parse(word).ok_or(ArtifactError::BadKind)?,
        None => sniff_kind(path, &content),
    };
    let stem = path.map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p)).map(|name| name.rsplit_once('.').map_or(name, |(s, _)| s));
    let title = text("title").or(stem).unwrap_or("Page").to_string();
    let id = match text("id") {
        Some(id) => slug(id),
        None => slug(&title),
    };
    let (artifact, added) = add_version(project, &id, &title, kind, &content, None)?;
    let version = added.unwrap_or_else(|| artifact.latest());
    Ok(Shown { artifact, version, added: added.is_some() })
}

/// The reply of the tool.
pub fn reply(shown: &Shown, in_chat: bool) -> Value {
    let a = &shown.artifact;
    json!({
        "ok": true,
        "id": a.id,
        "title": a.title,
        "kind": a.kind.as_str(),
        "version": shown.version,
        "new_version": shown.added,
        "file": format!(".potato/artifacts/{}/v{}.{}", a.id, shown.version, a.kind.ext()),
        "shown_in_chat": in_chat,
        "note": if in_chat { "A card is in the chat. To change the page, call show_artifact again with the same id: it becomes the next version." } else { "Saved, but this agent has no chat window to show it in. The person can open it from the Artifacts list." },
    })
}

/// Looks for pages dropped into `.potato/artifacts/` and tells the chat of `pane_id` about each new version.
/// Returns how many cards were added.
pub fn announce_folder(project: &Path, pane_id: &str) -> usize {
    let found = sync_folder(project);
    let mut cards = 0;
    for (artifact, version) in &found {
        if announce(pane_id, artifact, *version) {
            cards += 1;
        }
    }
    cards
}

/// Puts a card for `version` of `artifact` into the chat of `pane_id`. False when that pane has no chat.
pub fn announce(pane_id: &str, artifact: &Artifact, version: u32) -> bool {
    match crate::acp::chat::get(pane_id) {
        Some(chat) => {
            chat.note_artifact(announce_item(artifact, version, &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
            true
        }
        None => false,
    }
}
