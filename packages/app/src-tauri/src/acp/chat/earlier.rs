//! "Show earlier": the part of this chat's journal that stands before what a view holds (`journal::page_before`).

use super::AcpChat;
use crate::acp::journal::{page_before, Page};

/// Most items one page carries.
pub const MAX_PAGE: usize = 200;

impl AcpChat {
    /// Up to `limit` (at most [`MAX_PAGE`]) items that stand right before the item `before`, oldest first. A chat with
    /// no journal has none. `limit` 0 only asks whether there is anything earlier.
    pub fn earlier(&self, before: &str, limit: usize) -> Page {
        let Some(journal) = &self.journal else { return Page::default() };
        journal.flush();
        page_before(journal.path(), before, limit.min(MAX_PAGE))
    }
}
