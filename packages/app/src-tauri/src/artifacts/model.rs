//! The shapes of an artifact, and how it is written into a chat as a card.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::session_chat::ChatItem;

/// The biggest version (16 MB).
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
/// The phone gets a version only up to this size (it is shown as text in a small frame).
pub const MAX_PHONE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Html,
    Markdown,
    Svg,
    Mermaid,
}

impl ArtifactKind {
    pub fn parse(word: &str) -> Option<Self> {
        match word.trim().to_ascii_lowercase().as_str() {
            "html" | "htm" => Some(Self::Html),
            "markdown" | "md" => Some(Self::Markdown),
            "svg" => Some(Self::Svg),
            "mermaid" | "mmd" => Some(Self::Mermaid),
            _ => None,
        }
    }

    /// From a file name's extension.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::parse(name.rsplit_once('.')?.1)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Markdown => "markdown",
            Self::Svg => "svg",
            Self::Mermaid => "mermaid",
        }
    }

    /// The extension of a stored version.
    pub fn ext(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Markdown => "md",
            Self::Svg => "svg",
            Self::Mermaid => "mmd",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub n: u32,
    pub at: String,
    pub bytes: u64,
    /// SHA-256 of the content, to tell "the same page again" from a new version.
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub title: String,
    pub kind: ArtifactKind,
    /// The loose file in `.potato/artifacts/` this artifact follows (its edits become versions), if it came from one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub versions: Vec<Version>,
    /// Share links (`share.rs`): `{"links": [{hash, version, createdAt, expiresAt}]}`. Only a hash of each link's secret
    /// is kept, so the link itself is shown once, when it is made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<Value>,
}

impl Artifact {
    pub fn latest(&self) -> u32 {
        self.versions.last().map_or(0, |v| v.n)
    }
}

/// What a chat card points at (read by the window, and here only to pin the address format in tests).
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactRef {
    pub id: String,
    pub version: u32,
    pub kind: ArtifactKind,
}

const SCHEME: &str = "potato-artifact:";

fn ref_text(a: &Artifact, version: u32) -> String {
    format!("{SCHEME}{}/{}/{}", a.id, version, a.kind.as_str())
}

/// The card's address: `potato-artifact:<id>/<version>/<kind>`. `None` for any other text.
#[cfg(test)]
pub fn parse_ref(url: &str) -> Option<ArtifactRef> {
    let rest = url.strip_prefix(SCHEME)?;
    let mut parts = rest.split('/');
    let id = parts.next().filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))?;
    let version = parts.next()?.parse::<u32>().ok().filter(|v| *v >= 1)?;
    let kind = ArtifactKind::parse(parts.next()?)?;
    parts.next().is_none().then(|| ArtifactRef { id: id.to_string(), version, kind })
}

/// The chat item that puts a card for `version` of `a` into the chat. It is an ordinary notice (kind `artifact`, the
/// title as text, the address as `url`), so a window or a phone that does not know cards shows the title as a line.
pub fn announce_item(a: &Artifact, version: u32, at: &str) -> ChatItem {
    ChatItem::Notice {
        id: format!("artifact:{}:v{version}", a.id),
        at: Some(at.to_string()),
        notice_kind: "artifact".into(),
        text: a.title.clone(),
        url: Some(ref_text(a, version)),
    }
}

/// What a phone is told about an artifact: no folder, no path.
pub fn phone_view(a: &Artifact) -> Value {
    json!({
        "id": a.id,
        "title": a.title,
        "kind": a.kind.as_str(),
        "latest": a.latest(),
        "versions": a.versions.iter().map(|v| json!({ "n": v.n, "at": v.at, "bytes": v.bytes })).collect::<Vec<_>>(),
        "updatedAt": a.updated_at,
    })
}
