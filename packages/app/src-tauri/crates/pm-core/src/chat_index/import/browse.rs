//! Browse: the newest chats of ONE agent, ten at a time, each with a title, a folder name, a date and a message count.
//! Nothing is written and nothing is saved: this only lists and reads what the agent already keeps. It never names an
//! agent: the reader comes from the catalog. Titles go through the same strict redaction as the index rows.
//!
//! The listing of an agent can be slow (a database with thousands of chats), so the last one is kept for a short time
//! and "Show more" pages through it instead of listing again.

use std::collections::HashMap;
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
/// Rows kept between calls (see `ListingCache`). At the cap the memory starts again.
const MAX_ROWS: usize = 500;
/// Threads that read the chats of one page at the same time.
const READ_THREADS: usize = 4;
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

/// The last listing, with what it was for, and the rows already read. A row is kept by (agent, chat, stamp): a chat that
/// changed has a new stamp, so it is read again. Only what comes from reading the chat is kept; `brought` is asked
/// each time.
#[derive(Default)]
pub(super) struct ListingCache {
    slot: Mutex<Option<Cached>>,
    rows: Mutex<HashMap<(String, String, String), Read>>,
}

/// What reading one chat for the list gave: the part of a row that only changes when the chat does.
#[derive(Clone)]
struct Read {
    title: String,
    messages: usize,
    messages_cut: bool,
    error: Option<String>,
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
        self.rows.lock().clear();
    }

    fn cached_row(&self, agent: &str, chat: &HistoryChat) -> Option<Read> {
        self.rows.lock().get(&(agent.to_string(), chat.session.clone(), chat.stamp.clone())).cloned()
    }

    /// Keeps a row that was read without an error (a chat that failed to open is tried again next time).
    fn keep_row(&self, agent: &str, chat: &HistoryChat, read: &Read) {
        if read.error.is_some() {
            return;
        }
        let mut rows = self.rows.lock();
        if rows.len() >= MAX_ROWS {
            rows.clear();
        }
        rows.insert((agent.to_string(), chat.session.clone(), chat.stamp.clone()), read.clone());
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
        // The chats of a page are read in batches on a few threads; a batch never holds more than the page (and no fewer than the threads, so a run of empty chats is not read one by one), and its rows
        // are used in the listing order, so the page is the same as reading them one by one.
        while at < chats.len() && rows.len() < limit && looked < limit * SKIP_LOOKS {
            let batch_len = (limit - rows.len()).max(READ_THREADS).min(limit).min(chats.len() - at).min(limit * SKIP_LOOKS - looked);
            let batch = &chats[at..at + batch_len];
            let reads = self.reads_of(source, env, batch);
            for (chat, read) in batch.iter().zip(reads) {
                if rows.len() >= limit {
                    break;
                }
                at += 1;
                looked += 1;
                if read.error.is_none() && read.messages == 0 {
                    continue;
                }
                rows.push(self.row(source, chat, read));
            }
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

    /// The read part of every chat in `batch`, in order: from the memory when the stamp is the same, otherwise by reading
    /// the chat (on up to `READ_THREADS` threads).
    fn reads_of(&self, source: &Source, env: &HistoryEnv, batch: &[HistoryChat]) -> Vec<Read> {
        let mut reads: Vec<Option<Read>> = batch.iter().map(|chat| self.listings.cached_row(&source.id, chat)).collect();
        let missing: Vec<usize> = (0..batch.len()).filter(|&at| reads[at].is_none()).collect();
        if !missing.is_empty() {
            let per_thread = missing.len().div_ceil(READ_THREADS.min(missing.len()));
            let done: Vec<Option<Vec<Read>>> = std::thread::scope(|scope| {
                let handles: Vec<_> = missing
                    .chunks(per_thread)
                    .map(|part| scope.spawn(move || part.iter().map(|&at| read_chat(source, env, &batch[at])).collect::<Vec<Read>>()))
                    .collect();
                handles.into_iter().map(|handle| handle.join().ok()).collect()
            });
            for (part, got) in missing.chunks(per_thread).zip(done) {
                for (at, read) in part.iter().zip(got.unwrap_or_default()) {
                    self.listings.keep_row(&source.id, &batch[*at], &read);
                    reads[*at] = Some(read);
                }
            }
        }
        // A thread that panicked gives no rows: those chats show as unreadable, the page still comes back.
        reads.into_iter().map(|read| read.unwrap_or_else(|| Read::failed(ReadError::Unreadable))).collect()
    }

    /// The row of one chat: what was read, and whether it is brought (asked every time, so an import shows at once).
    fn row(&self, source: &Source, chat: &HistoryChat, read: Read) -> BrowseRow {
        let brought = self.index.imported_stamp(&source.id, &chat.session).ok().flatten().is_some_and(|stamp| stamp == chat.stamp);
        let folder = PaneContext::of(&source.id, chat.cwd.as_deref().unwrap_or_default(), Some(&chat.session)).folder;
        BrowseRow {
            session: chat.session.clone(),
            title: read.title,
            folder: scrub_text(&folder, Strength::Strict),
            updated_ms: chat.updated_ms,
            messages: read.messages,
            messages_cut: read.messages_cut,
            brought,
            bytes: chat.bytes,
            error: read.error,
        }
    }
}

impl Read {
    fn failed(error: ReadError) -> Read {
        Read { title: UNTITLED.to_string(), messages: 0, messages_cut: false, error: Some(error_text(error).to_string()) }
    }
}

/// Reads one chat for its title and message count.
fn read_chat(source: &Source, env: &HistoryEnv, chat: &HistoryChat) -> Read {
    let mut read = Read { title: UNTITLED.to_string(), messages: 0, messages_cut: false, error: None };
    let mut title: Option<String> = None;
    let limits = ReadLimits { max_items: PREVIEW_ITEMS, max_decompressed: PREVIEW_BYTES, chunk: 500 };
    let outcome = source.history.read(env, &chat.session, &limits, &mut |batch| {
        for item in &batch {
            match item {
                ChatItem::User { text, .. } => {
                    read.messages += 1;
                    if title.is_none() {
                        title = Some(one_line(text));
                    }
                }
                ChatItem::Assistant { .. } => read.messages += 1,
                _ => {}
            }
        }
        true
    });
    match outcome {
        Ok(outcome) => read.messages_cut = outcome.cut_short,
        Err(error) => read.error = Some(error_text(error).to_string()),
    }
    if let Some(title) = title.filter(|title| !title.is_empty()) {
        read.title = title;
    }
    read
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
