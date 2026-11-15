//! The door for lend control items that arrive over the device link from one of the person's OWN paired PCs.
//!
//! The bridge route (`POST /lend/item`) knows only this seam: who sent it (decided by the link's own door, never by the
//! body) and the item as JSON. The lend service registers the inbox. Nothing here reaches a login: items are the ask /
//! yes / take-back words, and a grant carries the same shared proxy secret a team grant does.

use std::sync::{Arc, OnceLock};

use serde_json::Value;

/// What the lend service does with one item.
pub trait Inbox: Send + Sync {
    /// `from_node` is the sender's device-link node (64 hex), already proven by the link and holding the lend right.
    fn deliver(&self, from_node: &str, body: Value) -> Result<Value, String>;
}

static INBOX: OnceLock<Arc<dyn Inbox>> = OnceLock::new();

pub fn set_inbox(inbox: Arc<dyn Inbox>) {
    let _ = INBOX.set(inbox);
}

pub fn deliver(from_node: &str, body: Value) -> Result<Value, String> {
    match INBOX.get() {
        Some(inbox) => inbox.deliver(from_node, body),
        None => Err("Lending is off on this PC.".into()),
    }
}

/// A 64-character lowercase hex node id, nothing else.
pub fn is_node_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
