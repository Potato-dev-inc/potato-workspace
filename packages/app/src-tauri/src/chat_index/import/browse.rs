//! Browse: the newest chats of ONE agent, ten at a time, each with a title, a folder name, a date and a message count.
//! Nothing is written and nothing is saved: this only lists and reads what the agent already keeps. It never names an
//! agent: the reader comes from the catalog. Titles go through the same strict redaction as the index rows.
//!
//! The listing of an agent can be slow (a database with thousands of chats), so the last one is kept for a short time
//! and "Show more" pages through it instead of listing again.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use super::{Importer, Source};
use crate::chat_index::entry::{scrub_text, PaneContext, Strength};
use crate::session_chat::history::{HistoryChat, HistoryEnv, ListLimits, Listing, ReadError, ReadLimits};
use crate::session_chat::{cut_to, ChatItem};

/// Chats on a page.
pub const PAGE: usize = 10;
/// How long a listing is reused by "Show more".
const KEEP: Duration = Duration::from_secs(45);
/// A chat is read for its title and message count with these caps, so one huge chat cannot stall the list.
const PREVIEW_ITEMS: usize = 50_000;
const PREVIEW_BYTES: u64 = 32 * 1024 * 1024;
/// A page looks at no more than this many chats per row asked for, so a store full of empty chats cannot stall it.
const SKIP_LOOKS: usize = 20;
/// The longest title shown, in characters.
const TITLE_CHARS: usize = 100;
/// The title of a chat with no message of the person.
const UNTITLED: &str = "Untitled chat";

/// Which chats of one agent: the newest first, within a time range (both ends are milliseconds; `None` = no limit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowseQuery {
    pub agent: String,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub offset: usize,
    pub limit: usize,
}

/// One chat in the list. `error` is a plain sentence when the chat could not be read (the row can't be picked).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRow {
    pub session: String,
    pub title: String,
    pub folder: String,
    pub updated_ms: i64,
    /// Messages of the person and of the agent. `messages_cut` means a cap stopped the count: "at least".
    pub messages: usize,
    pub messages_cut: bool,
    /// Already brought, and unchanged since.
    pub brought: bool,
    pub bytes: u64,
    pub error: Option<String>,
}

/// One page. `total` is every chat in the range; `more` says there are chats after this page. `next` is where "Show more"
/// continues (an empty chat is passed over, so it is not always `offset` plus the page size).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePage {
    pub rows: Vec<BrowseRow>,
    pub total: usize,
    pub offset: usize,
    pub next: usize,
    pub more: bool,
    pub too_big: usize,
    pub unreadable: usize,
}

/// The last listing, with what it was for.
#[derive(Default)]
pub(super) struct ListingCache {
    slot: Mutex<Option<Cached>>,
}

struct Cached {
    agent: String,
    from_ms: Option<i64>,
    at: Instant,
    listing: Listing,
}

impl ListingCache {
    /// The chats of `source` updated at or after `from_ms`, newest first. Reused for a short time.
    fn listing(&self, source: &Source, env: &HistoryEnv, from_ms: Option<i64>) -> Listing {
        if let Some(cached) = self.slot.lock().as_ref() {
            if cached.agent == source.id && cached.from_ms == from_ms && cached.at.elapsed() < KEEP {
                return cached.listing.clone();
            }
        }
        let limits = ListLimits { since_ms: from_ms, ..ListLimits::default() };
        let listing = source.history.list(env, &limits);
        *self.slot.lock() = Some(Cached { agent: source.id.clone(), from_ms, at: Instant::now(), listing: listing.clone() });
        listing
    }

    /// Forget the listing (after a run changed what is brought, or on a new "Find my chats").
    pub(super) fn forget(&self) {
        *self.slot.lock() = None;
    }
}

/// The chats of the range, newest first. A chat that holds no data at all (a session opened and closed) is left out.
pub(super) fn in_range(listing: &Listing, from_ms: Option<i64>, to_ms: Option<i64>) -> Vec<HistoryChat> {
    listing
        .chats
        .iter()
        .filter(|chat| chat.bytes > 0)
        .filter(|chat| from_ms.map_or(true, |from| chat.updated_ms >= from) && to_ms.map_or(true, |to| chat.updated_ms <= to))
        .cloned()
        .collect()
}

impl Importer {
    /// One page of one agent's chats. Errors: `UNKNOWN_AGENT`.
    pub fn browse(&self, env: &HistoryEnv, query: &BrowseQuery) -> Result<BrowsePage, String> {
        let sources = self.sources();
        let source = super::source_named(&sources, &query.agent)?;
        let listing = self.listings.listing(source, env, query.from_ms);
        let chats = in_range(&listing, query.from_ms, query.to_ms);
        let limit = query.limit.clamp(1, 50);
        let mut rows = Vec::with_capacity(limit);
        let mut at = query.offset.min(chats.len());
        // A chat with no message in it is passed over, so a page still holds `limit` real chats when there are that many.
        let mut looked = 0;
        while at < chats.len() && rows.len() < limit && looked < limit * SKIP_LOOKS {
            let row = self.row(source, env, &chats[at]);
            at += 1;
            looked += 1;
            if row.error.is_none() && row.messages == 0 {
                continue;
            }
            rows.push(row);
        }
        Ok(BrowsePage {
            rows,
            total: chats.len(),
            offset: query.offset,
            next: at,
            more: at < chats.len(),
            too_big: listing.too_big,
            unreadable: listing.unreadable,
        })
    }

    fn row(&self, source: &Source, env: &HistoryEnv, chat: &HistoryChat) -> BrowseRow {
        let brought = self.index.imported_stamp(&source.id, &chat.session).ok().flatten().is_some_and(|stamp| stamp == chat.stamp);
        let folder = PaneContext::of(&source.id, chat.cwd.as_deref().unwrap_or_default(), Some(&chat.session)).folder;
        let mut row = BrowseRow {
            session: chat.session.clone(),
            title: UNTITLED.to_string(),
            folder: scrub_text(&folder, Strength::Strict),
            updated_ms: chat.updated_ms,
            messages: 0,
            messages_cut: false,
            brought,
            bytes: chat.bytes,
            error: None,
        };
        let mut title: Option<String> = None;
        let limits = ReadLimits { max_items: PREVIEW_ITEMS, max_decompressed: PREVIEW_BYTES, chunk: 500 };
        let read = source.history.read(env, &chat.session, &limits, &mut |batch| {
            for item in &batch {
                match item {
                    ChatItem::User { text, .. } => {
                        row.messages += 1;
                        if title.is_none() {
                            title = Some(one_line(text));
                        }
                    }
                    ChatItem::Assistant { .. } => row.messages += 1,
                    _ => {}
                }
            }
            true
        });
        match read {
            Ok(outcome) => row.messages_cut = outcome.cut_short,
            Err(error) => row.error = Some(error_text(error).to_string()),
        }
        if let Some(title) = title.filter(|title| !title.is_empty()) {
            row.title = title;
        }
        row
    }
}

/// The first message on one line, redacted, cut short.
fn one_line(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cut_to(&scrub_text(&joined, Strength::Strict), TITLE_CHARS)
}

/// Why a chat could not be read, in words for the screen.
pub(super) fn error_text(error: ReadError) -> &'static str {
    match error {
        ReadError::Missing => "The file for this chat was moved or deleted.",
        ReadError::TooBig => "This chat is too big to bring.",
        ReadError::Unreadable => "This chat could not be opened.",
        ReadError::Format => "This chat is in a format this version does not know.",
    }
}
