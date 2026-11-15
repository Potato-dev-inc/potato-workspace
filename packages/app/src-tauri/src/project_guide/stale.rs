//! Which pages are out of date: exactly the pages that cite a file whose content changed (or is gone) since the
//! page was written. The hashes are in the manifest.

use std::path::Path;

use serde::Serialize;

use super::model::{Cited, Manifest};
use super::store::file_hash;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stale {
    pub id: String,
    /// The cited files that changed, in the order the page cites them.
    pub changed: Vec<String>,
}

/// The cited files whose current hash differs from the recorded one (a file that cannot be read counts as changed).
pub fn changed_files(project: &Path, cited: &[Cited]) -> Vec<String> {
    cited.iter().filter(|c| file_hash(project, &c.path).as_deref() != Some(c.hash.as_str())).map(|c| c.path.clone()).collect()
}

/// The stale pages, in manifest order.
pub fn stale_pages(project: &Path, manifest: &Manifest) -> Vec<Stale> {
    manifest
        .pages
        .iter()
        .filter_map(|page| {
            let changed = changed_files(project, &page.cited);
            (!changed.is_empty()).then(|| Stale { id: page.id.clone(), changed })
        })
        .collect()
}

/// Does the diagram cite a file that changed?
pub fn diagram_stale(project: &Path, manifest: &Manifest) -> bool {
    manifest.diagram.as_ref().is_some_and(|d| !changed_files(project, &d.cited).is_empty())
}
