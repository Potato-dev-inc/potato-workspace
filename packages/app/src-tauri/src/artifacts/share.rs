//! Share links: a read-only, unguessable, expiring address for ONE version of ONE artifact.
//!
//! * **Unguessable.** The secret is 24 random bytes (192 bits), URL-safe base64. Only its SHA-256 is kept, in the
//!   artifact's `share` slot (authoritative: version and expiry) and in a small index file (`artifact-shares.json` in the
//!   app's data folder) that says which project and artifact a hash belongs to. The link is shown once, when made.
//! * **One version.** A link names the version that was open when it was made. A later version is never reachable
//!   through it (the person makes a new link).
//! * **Expiring.** Every link ends: one hour to seven days (a day by default). An ended link is pruned the next time a
//!   link is made for that artifact.
//! * **Read-only.** Nothing here writes a page. The bridge route that serves a link (`share_page.rs`) is a single GET.

use std::fs;
use std::path::Path;

use base64::Engine;
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::model::{Artifact, ArtifactKind};
use super::store::{meta_of, read, update_meta, version_text, ArtifactError};

/// The longest a link may live: seven days.
pub const MAX_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// The shortest: one minute (tests; the window offers one hour and up).
pub const MIN_TTL_SECS: u64 = 60;
/// What a link lives when the caller says nothing: one day.
pub const DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;
/// Links an artifact may have alive at once.
const MAX_ACTIVE: usize = 20;
/// The secret's length once encoded (24 bytes, URL-safe base64, no padding).
pub(super) const TOKEN_LEN: usize = 32;

/// One writer at a time for the index file.
static INDEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareError {
    Artifact(ArtifactError),
    /// No such link, or it was stopped.
    Unknown,
    /// The link's time is up.
    Expired,
    TooMany,
    Io(String),
}

impl ShareError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Artifact(e) => e.code(),
            Self::Unknown => "SHARE_UNKNOWN",
            Self::Expired => "SHARE_EXPIRED",
            Self::TooMany => "SHARE_TOO_MANY",
            Self::Io(_) => "SHARE_IO",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Artifact(e) => e.message(),
            Self::Unknown => "This link does not exist, or it was stopped.".into(),
            Self::Expired => "This link has ended.".into(),
            Self::TooMany => "This page already has many links. Stop sharing, then make a new one.".into(),
            Self::Io(why) => format!("Could not save the link: {why}"),
        }
    }
}

impl From<ArtifactError> for ShareError {
    fn from(e: ArtifactError) -> Self {
        Self::Artifact(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    /// SHA-256 (hex) of the secret.
    hash: String,
    version: u32,
    created_at: u64,
    expires_at: u64,
}

fn links_of(artifact: &Artifact) -> Vec<Link> {
    artifact.share.as_ref().and_then(|v| v.get("links")).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

fn put_links(artifact: &mut Artifact, links: Vec<Link>) {
    artifact.share = if links.is_empty() { None } else { Some(json!({ "links": links })) };
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    /// hash -> where it belongs.
    #[serde(default)]
    links: std::collections::BTreeMap<String, Home>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Home {
    project: String,
    id: String,
}

fn load_index(file: &Path) -> Index {
    fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_index(file: &Path, index: &Index) -> Result<(), ShareError> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| ShareError::Io(e.to_string()))?;
    }
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(index).map_err(|e| ShareError::Io(e.to_string()))?).map_err(|e| ShareError::Io(e.to_string()))?;
    fs::rename(&tmp, file).map_err(|e| ShareError::Io(e.to_string()))
}

pub(super) fn hash_of(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `text` has the shape of a secret this module makes (so anything else is refused before any lookup).
pub(super) fn token_shape_ok(text: &str) -> bool {
    text.len() == TOKEN_LEN && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn new_token() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A link just made. `token` is shown once and never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub token: String,
    pub version: u32,
    pub expires_at: u64,
}

/// Makes a link to `version` of artifact `id` in `project` (`None`: the newest version), alive for `ttl_secs` (clamped).
pub fn create_link(index_file: &Path, project: &Path, id: &str, version: Option<u32>, ttl_secs: Option<u64>, now_ms: u64) -> Result<Created, ShareError> {
    let page = read(project, id, version)?;
    let ttl = ttl_secs.unwrap_or(DEFAULT_TTL_SECS).clamp(MIN_TTL_SECS, MAX_TTL_SECS);
    let token = new_token();
    let hash = hash_of(&token);
    let link = Link { hash: hash.clone(), version: page.version, created_at: now_ms, expires_at: now_ms + ttl * 1000 };
    let (dropped, accepted) = update_meta(project, id, |a| {
        let (alive, ended): (Vec<Link>, Vec<Link>) = links_of(a).into_iter().partition(|l| l.expires_at > now_ms);
        if alive.len() >= MAX_ACTIVE {
            return (Vec::new(), false);
        }
        let mut next = alive;
        next.push(link.clone());
        put_links(a, next);
        (ended.into_iter().map(|l| l.hash).collect::<Vec<_>>(), true)
    })?;
    if !accepted {
        return Err(ShareError::TooMany);
    }
    let _one = INDEX.lock();
    let mut index = load_index(index_file);
    for hash in dropped {
        index.links.remove(&hash);
    }
    index.links.insert(hash, Home { project: project.to_string_lossy().into_owned(), id: id.to_string() });
    save_index(index_file, &index)?;
    Ok(Created { token, version: page.version, expires_at: link.expires_at })
}

/// A link that is alive (never its secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    pub version: u32,
    pub created_at: u64,
    pub expires_at: u64,
}

/// The links of this artifact that have not ended.
pub fn active_links(project: &Path, id: &str, now_ms: u64) -> Vec<ShareView> {
    let Some(a) = meta_of(project, id) else { return Vec::new() };
    links_of(&a).into_iter().filter(|l| l.expires_at > now_ms).map(|l| ShareView { version: l.version, created_at: l.created_at, expires_at: l.expires_at }).collect()
}

/// Stops every link of this artifact. Returns how many were stopped.
pub fn revoke_links(index_file: &Path, project: &Path, id: &str) -> Result<usize, ShareError> {
    let hashes = update_meta(project, id, |a| {
        let all = links_of(a);
        put_links(a, Vec::new());
        all.into_iter().map(|l| l.hash).collect::<Vec<_>>()
    })?;
    let _one = INDEX.lock();
    let mut index = load_index(index_file);
    for hash in &hashes {
        index.links.remove(hash);
    }
    save_index(index_file, &index)?;
    Ok(hashes.len())
}

/// What a link shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Shared {
    pub title: String,
    pub kind: ArtifactKind,
    pub version: u32,
    pub content: String,
    pub expires_at: u64,
}

/// Finds what `token` points at: that one version of that one artifact, and nothing else. A secret of the wrong shape,
/// an unknown or stopped one, and one whose project or page is gone all say `Unknown`; one whose time is up says `Expired`.
pub fn resolve(index_file: &Path, token: &str, now_ms: u64) -> Result<Shared, ShareError> {
    if !token_shape_ok(token) {
        return Err(ShareError::Unknown);
    }
    let hash = hash_of(token);
    let home = load_index(index_file).links.get(&hash).cloned().ok_or(ShareError::Unknown)?;
    let project = Path::new(&home.project);
    let artifact = meta_of(project, &home.id).ok_or(ShareError::Unknown)?;
    let link = links_of(&artifact).into_iter().find(|l| l.hash == hash).ok_or(ShareError::Unknown)?;
    if link.expires_at <= now_ms {
        return Err(ShareError::Expired);
    }
    if !artifact.versions.iter().any(|v| v.n == link.version) {
        return Err(ShareError::Unknown);
    }
    let content = version_text(project, &artifact, link.version)?;
    Ok(Shared { title: artifact.title.clone(), kind: artifact.kind, version: link.version, content, expires_at: link.expires_at })
}

/// For callers that need the new link as JSON.
pub fn created_json(c: &Created, link: Option<&str>) -> Value {
    json!({ "link": link, "version": c.version, "expiresAt": c.expires_at })
}
