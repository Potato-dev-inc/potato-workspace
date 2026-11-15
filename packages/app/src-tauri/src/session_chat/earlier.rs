//! The answer of "Show earlier": a page of items from before what the view holds, and whether more is left.
//! The phone's page is as lean as its chat (`phone::lean`) and redacted again on the way out.

use serde_json::{json, Value};

use crate::acp::journal::Page;

/// Items per click of "Show earlier" when the view does not say.
pub const DEFAULT_PAGE: usize = 50;

/// `{ items, more }`, the page as the view takes it.
pub fn answer(page: Page, phone: bool) -> Value {
    let items: Vec<_> = if phone { page.items.into_iter().map(super::phone::lean).collect() } else { page.items };
    let value = json!({ "items": items, "more": page.more });
    if phone {
        crate::redact::json(value).into_inner()
    } else {
        value
    }
}

/// The page for a pane: from its chat session's journal. A pane that is not a chat session (a terminal read from its
/// session file or its screen) has no journal and nothing earlier to show.
pub fn for_pane(pane_id: &str, before: &str, limit: usize, phone: bool) -> Value {
    let page = crate::acp::chat::get(pane_id).map(|chat| chat.earlier(before, limit)).unwrap_or_default();
    answer(page, phone)
}

#[cfg(test)]
#[path = "earlier_tests.rs"]
mod tests;
