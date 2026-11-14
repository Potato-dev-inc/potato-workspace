//! Artifacts: a page an agent makes (HTML, Markdown, SVG or a Mermaid diagram) that shows as a card in the chat and
//! opens beside it. This module is the store: versions per artifact, a size cap, and the folder convention.
//!
//! * **Where.** `<project>/.potato/artifacts/<id>/meta.json` plus one file per version (`v1.html`, `v2.html` ...).
//!   The folder is kept out of git (`git_exclude`). An agent that can only write files drops `page.html` straight
//!   into `<project>/.potato/artifacts/`; the next sync turns it into an artifact and every change of that file into a
//!   new version (`store::sync_folder`).
//! * **Versions never change.** A new version is a new file; `meta.json` lists them. A later share link can name
//!   `<id>` and a version number without any change to this layout (`Artifact::share` is reserved for it).
//! * **Safe by construction.** Ids are `[a-z0-9-]` only, so an id can never leave the folder; a file an agent names by
//!   path must be inside the project; every version is at most [`MAX_BYTES`].
//! * **Never shown with power.** Whatever shows an artifact puts it in the locked frame (`SandboxFrame.tsx`): no app
//!   access, no storage, no network except a short CDN list.

mod model;
mod service;
mod store;

pub use model::{phone_view, Artifact, ArtifactKind, MAX_PHONE_BYTES};
pub use service::{announce, announce_folder, reply, show};
pub use store::{file_of, list, read, ArtifactError};

#[cfg(test)]
mod tests;
