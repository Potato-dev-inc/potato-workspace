//! Artifacts: a page an agent makes (HTML, Markdown, SVG or a Mermaid diagram) that shows as a card in the chat and
//! opens beside it. This module is the store: versions per artifact, a size cap, and the folder convention.
//!
//! * **Where.** `<project>/.potato/artifacts/<id>/meta.json` plus one file per version (`v1.html`, `v2.html` ...).
//!   The folder is kept out of git (`git_exclude`). An agent that can only write files drops `page.html` straight
//!   into `<project>/.potato/artifacts/`; the next sync turns it into an artifact and every change of that file into a
//!   new version (`store::sync_folder`).
//! * **Versions never change.** A new version is a new file; `meta.json` lists them. A share link names one `<id>`
//!   and one version number (`share.rs`) and is kept in `Artifact::share`.
//! * **Safe by construction.** Ids are `[a-z0-9-]` only, so an id can never leave the folder; a file an agent names by
//!   path must be inside the project; every version is at most [`MAX_BYTES`].
//! * **Never shown with power.** Whatever shows an artifact puts it in the locked frame (`SandboxFrame.tsx`): no app
//!   access, no storage, no network except a short CDN list.

mod model;
mod service;
mod share;
mod serve;
mod share_page;
mod store;

pub use model::{phone_view, Artifact, ArtifactKind, MAX_PHONE_BYTES};
pub use service::{announce, announce_folder, now_ms, reply, share_address, share_index_file, show};
pub use share::{active_links, create_link, created_json, revoke_links, ShareError, ShareView};
pub use serve::{chip_of, owner_of, tab_address_origin, close as close_tab_address, is_live_address, live_token, open as open_tab_address, respond as respond_to_tab};
pub use share_page::{respond as respond_to_share, SharePage};
pub use store::{file_of, list, read, ArtifactError};

/// Tests of other modules make a page without going through a tool call.
#[cfg(test)]
pub fn add_version_for_tests(project: &std::path::Path, id: &str, title: &str, kind: ArtifactKind, content: &str) {
    store::add_version(project, id, title, kind, content, None).unwrap();
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod share_tests;

/// The title and newest version number of a page (for the words of a mark-up message).
pub fn read_for_mark(project: &std::path::Path, id: &str) -> Option<(String, u32)> {
    store::read(project, id, None).ok().map(|r| (r.artifact.title, r.version))
}
