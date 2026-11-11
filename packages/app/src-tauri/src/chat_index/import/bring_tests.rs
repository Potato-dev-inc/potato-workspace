//! "Bring my chats" on the importer: the page of recent chats, the time range, bringing chosen chats, bringing again, and
//! the chats that cannot be read. Fake stores and an in-memory index; nothing touches a folder.

use std::sync::atomic::Ordering;

use super::fakes::{finished, importer, memory_index, source, FakeHistory};
use super::{BrowseQuery, ImportRequest, Importer, Phase, UNKNOWN_AGENT};
use crate::session_chat::history::{HistoryEnv, ReadError};
use crate::session_chat::ChatItem;

const NOW_MS: i64 = 1_790_000_000_000;
const DAY: i64 = 86_400_000;

fn env() -> HistoryEnv {
    HistoryEnv::isolated()
}

/// A store with `count` chats; chat n was updated n days before `NOW_MS` and talks about `topic n`.
fn store_of(count: usize) -> &'static FakeHistory {
    let fake = FakeHistory::new();
    for n in 1..=count {
        fake.add(&format!("sess-{n:04}"), &format!("{n}:100"), NOW_MS - n as i64 * DAY, &format!("topic{n}"));
    }
    fake.leak()
}

/// A session with no message in it: only the line that names the CLI version.
fn nothing_in_it() -> Vec<ChatItem> {
    vec![ChatItem::Session { id: "0:0".into(), at: None, model: None, cli_version: None }]
}

fn query(offset: usize) -> BrowseQuery {
    BrowseQuery { agent: "agent-a".into(), from_ms: None, to_ms: None, offset, limit: 10 }
}

fn bring(importer: &Importer, sessions: Option<Vec<&str>>, from_ms: Option<i64>, to_ms: Option<i64>) -> super::Progress {
    let request = ImportRequest {
        agents: vec!["agent-a".into()],
        from_ms,
        to_ms,
        sessions: sessions.map(|list| list.into_iter().map(str::to_string).collect()),
        ..ImportRequest::default()
    };
    importer.start(request, env()).unwrap();
    finished(importer)
}

#[test]
fn browse_gives_the_ten_newest_with_title_folder_date_and_message_count() {
    let (index, _) = memory_index();
    let fake = store_of(25);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let page = importer.browse(&env(), &query(0)).unwrap();
    assert_eq!((page.rows.len(), page.total, page.more, page.next), (10, 25, true, 10));
    let first = &page.rows[0];
    assert_eq!(first.session, "sess-0001");
    assert_eq!(first.title, "question about topic1");
    assert_eq!(first.folder, "shop", "the folder name, not the path");
    assert_eq!(first.updated_ms, NOW_MS - DAY);
    assert_eq!((first.messages, first.messages_cut, first.brought, first.error.as_deref()), (2, false, false, None));
    assert!(page.rows.windows(2).all(|pair| pair[0].updated_ms > pair[1].updated_ms), "newest first");
    assert_eq!(fake.read_count(), 10, "only the chats on the page are read");
}

#[test]
fn show_more_continues_where_the_page_ended_and_lists_the_store_once() {
    let (index, _) = memory_index();
    let fake = store_of(25);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let first = importer.browse(&env(), &query(0)).unwrap();
    let second = importer.browse(&env(), &query(first.next)).unwrap();
    let third = importer.browse(&env(), &query(second.next)).unwrap();
    assert_eq!((second.rows.len(), second.more, third.rows.len(), third.more), (10, true, 5, false));
    assert_eq!(second.rows[0].session, "sess-0011");
    assert_eq!(third.rows.last().unwrap().session, "sess-0025");
    assert_eq!(fake.lists.load(Ordering::SeqCst), 1, "the listing is reused by Show more");
}

#[test]
fn a_time_range_limits_the_page_and_the_total() {
    let (index, _) = memory_index();
    let fake = store_of(25);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    // The last 7 days: chats 1 to 7.
    let week = importer.browse(&env(), &BrowseQuery { from_ms: Some(NOW_MS - 7 * DAY), ..query(0) }).unwrap();
    assert_eq!((week.total, week.rows.len(), week.more), (7, 7, false));
    // Custom: from day 14 back to day 10 (both ends included).
    let custom = importer
        .browse(&env(), &BrowseQuery { from_ms: Some(NOW_MS - 14 * DAY), to_ms: Some(NOW_MS - 10 * DAY), ..query(0) })
        .unwrap();
    let ids: Vec<&str> = custom.rows.iter().map(|row| row.session.as_str()).collect();
    assert_eq!(ids, vec!["sess-0010", "sess-0011", "sess-0012", "sess-0013", "sess-0014"]);
    assert_eq!(custom.total, 5);
}

#[test]
fn chats_with_nothing_in_them_are_passed_over_and_the_page_is_still_full() {
    let (index, _) = memory_index();
    let fake = FakeHistory::new();
    for n in 1..=14 {
        fake.add(&format!("sess-{n:04}"), &format!("{n}:100"), NOW_MS - n as i64 * DAY, &format!("topic{n}"));
    }
    // Chats 1, 2 and 4 are sessions with no message; chat 3 holds no data at all.
    for n in [1, 2, 4] {
        fake.items.lock().insert(format!("sess-{n:04}"), nothing_in_it());
    }
    fake.chats.lock().iter_mut().filter(|c| c.session == "sess-0003").for_each(|c| c.bytes = 0);
    let fake = fake.leak();
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let page = importer.browse(&env(), &query(0)).unwrap();
    let ids: Vec<&str> = page.rows.iter().map(|row| row.session.as_str()).collect();
    assert_eq!(ids[0], "sess-0005", "the empty ones are not shown");
    assert_eq!(page.rows.len(), 10);
    assert!(!ids.contains(&"sess-0003"));
    assert_eq!(page.total, 13, "a chat with no data at all is not counted");
}

#[test]
fn a_chat_that_cannot_be_read_is_shown_with_a_plain_reason() {
    let (index, _) = memory_index();
    let fake = store_of(3);
    fake.errors.lock().insert("sess-0002".into(), ReadError::Format);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let page = importer.browse(&env(), &query(0)).unwrap();
    let broken = page.rows.iter().find(|row| row.session == "sess-0002").unwrap();
    assert_eq!(broken.error.as_deref(), Some("This chat is in a format this version does not know."));
    assert_eq!(page.rows.iter().filter(|row| row.error.is_none()).count(), 2);
}

#[test]
fn an_unknown_agent_is_refused() {
    let (index, _) = memory_index();
    let (importer, _) = importer(vec![source("agent-a", false, store_of(1))], &index);
    let wrong = BrowseQuery { agent: "nobody".into(), ..query(0) };
    assert_eq!(importer.browse(&env(), &wrong).unwrap_err(), UNKNOWN_AGENT);
}

#[test]
fn bringing_chosen_chats_reads_and_writes_only_those() {
    let (index, _) = memory_index();
    let fake = store_of(12);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let end = bring(&importer, Some(vec!["sess-0002", "sess-0005"]), None, None);
    assert_eq!(end.phase, Phase::Done);
    assert_eq!((end.chats_total, end.chats_done, end.brought, end.unchanged), (2, 2, 2, 0));
    assert_eq!(index.status().unwrap().imported_chats, 2);
    let mut read = fake.read_sessions.lock().clone();
    read.sort();
    assert_eq!(read, vec!["sess-0002", "sess-0005"], "no other chat was opened");
    assert!(index.imported_chat("agent-a", "sess-0002").unwrap().is_some());
    assert!(index.imported_chat("agent-a", "sess-0003").unwrap().is_none());
}

#[test]
fn bringing_a_whole_range_brings_the_chats_in_it() {
    let (index, _) = memory_index();
    let fake = store_of(25);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let end = bring(&importer, None, Some(NOW_MS - 14 * DAY), Some(NOW_MS - 10 * DAY));
    assert_eq!((end.chats_total, end.brought), (5, 5));
    for n in 10..=14 {
        assert!(index.imported_chat("agent-a", &format!("sess-{n:04}")).unwrap().is_some(), "chat {n}");
    }
    assert_eq!(index.status().unwrap().imported_chats, 5);
}

#[test]
fn bringing_the_same_chats_again_adds_nothing_and_reads_nothing() {
    let (index, _) = memory_index();
    let fake = store_of(6);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let first = bring(&importer, None, None, None);
    assert_eq!((first.brought, first.unchanged), (6, 0));
    let before = index.status().unwrap();
    let reads = fake.read_count();
    let second = bring(&importer, None, None, None);
    assert_eq!((second.brought, second.unchanged), (0, 6), "all six were already there");
    assert_eq!(fake.read_count(), reads, "an unchanged chat is not read again");
    let after = index.status().unwrap();
    assert_eq!((after.imported_chats, after.imported_items), (before.imported_chats, before.imported_items));
    // Picking some of them again changes nothing either, and the page says they are brought.
    let third = bring(&importer, Some(vec!["sess-0001", "sess-0002"]), None, None);
    assert_eq!((third.brought, third.unchanged), (0, 2));
    let page = importer.browse(&env(), &query(0)).unwrap();
    assert!(page.rows.iter().all(|row| row.brought));
    // A chat that changed since is brought again, once.
    fake.set_stamp("sess-0003", "changed");
    let fourth = bring(&importer, None, None, None);
    assert_eq!((fourth.brought, fourth.unchanged), (1, 5));
    assert_eq!(index.status().unwrap().imported_chats, 6, "the changed chat replaced its old copy");
}

#[test]
fn a_chat_with_nothing_in_it_is_left_out_and_counted() {
    let (index, _) = memory_index();
    let fake = store_of(3);
    fake.items.lock().insert("sess-0002".into(), nothing_in_it());
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let end = bring(&importer, None, None, None);
    assert_eq!((end.brought, end.empty, end.unreadable), (2, 1, 0));
    assert!(index.imported_chat("agent-a", "sess-0002").unwrap().is_none());
}

#[test]
fn chats_that_cannot_be_read_are_counted_by_reason() {
    let (index, _) = memory_index();
    let fake = store_of(5);
    fake.errors.lock().insert("sess-0001".into(), ReadError::Missing);
    fake.errors.lock().insert("sess-0002".into(), ReadError::Format);
    fake.errors.lock().insert("sess-0003".into(), ReadError::Unreadable);
    let (importer, _) = importer(vec![source("agent-a", false, fake)], &index);
    let end = bring(&importer, None, None, None);
    assert_eq!((end.brought, end.unreadable, end.missing, end.format), (2, 3, 1, 1));
}
