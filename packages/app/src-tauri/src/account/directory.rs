//! My PCs in the account's address book. The account lists the PCs that signed in with it; a PC that has the tick
//! "Let my other PCs open this PC" on also tells it the id it answers on (its PC-link id) and the relay it can be
//! reached through. **The account is only an address book.** Nothing in a row is trusted because the account says so:
//! a row counts only when the PC's own statement checks out (the statement names the account, the device and the link
//! id, and is signed by the device key the account holds for that device), and even then it only says where to knock.
//! The PCs trust each other after the two people compare a number (`device_link/account_dir.rs`, `p2p/pairing.rs`).

use super::statement::verify_device_statement;
use serde::Serialize;
use serde_json::Value;

/// What a PC publishes when it is not (or no longer) open: the id field is required by the server to be non-empty, so
/// "not published" is written as this word. It is never a valid link id (those are 64 hex characters).
pub const NOT_PUBLISHED: &str = "off";

/// A PC that has not been seen for this long is not listed (it is gone, or was sold).
pub const STALE_SECS: u64 = 30 * 24 * 3600;

/// A published statement older than this is not used to open the PC (it says again every minute while it is open).
pub const PUBLISH_MAX_AGE_SECS: u64 = 10 * 60;

/// The PCs of the account, and the ids of the devices that were signed out of it.
pub struct Book {
    pub rows: Vec<PcRow>,
    pub revoked: Vec<String>,
}

/// One PC of this account whose own signed statement checked out. Whether it can be opened is the caller's to decide.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PcRow {
    /// The account's id for this device.
    pub id: String,
    /// From the signed statement (never the server's own `name` column). Untrusted text.
    pub name: String,
    /// The account's key for this device (base64url): what its own statements are signed with. A knocking PC proves it is this device by
    /// signing a statement with it.
    pub account_pub: String,
    /// The PC-link id (64 hex), when the PC published itself.
    pub node: Option<String>,
    /// The PC's signed node-to-device record as text, to be checked by the link layer.
    pub binding: Option<String>,
    /// A relay hint (https address). Only a hint to dial through; it proves nothing.
    pub relay: Option<String>,
    pub created_at: u64,
    pub last_seen_at: u64,
    pub online: bool,
    pub is_this: bool,
}

fn hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An https address with a host and nothing else of note: no user, no spaces, no control characters, not long.
pub fn valid_relay_hint(url: &str) -> Option<String> {
    let url = url.trim();
    if url.len() > 256 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains('@') || host.contains('\\') || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return None;
    }
    Some(url.to_string())
}

/// Characters that draw nothing or change how the text around them reads (zero-width, direction marks and overrides, soft hyphen,
/// variation selectors, tags). Same list as `p2p::trust::is_invisible`.
fn invisible(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F
        | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF9..=0xFFFB | 0xE0000..=0xE0FFF)
}

/// The name as shown: invisible and control characters taken out, trimmed, at most 40 characters. None when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let s: String = raw.chars().filter(|c| !c.is_control() && !invisible(*c)).collect();
    let s = s.trim();
    ((1..=40).contains(&s.chars().count())).then(|| s.to_string())
}

/// What a name looks like to the eye: lower case, no spaces or marks, and the usual look-alike letters (Cyrillic and Greek lookalikes,
/// zero for o, one and bar for l) folded together. Two PCs with the same skeleton cannot be told apart by name.
pub fn skeleton(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control() && !invisible(*c) && c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            '\u{0430}' | '\u{03b1}' => 'a',
            '\u{0435}' | '\u{03b5}' => 'e',
            '\u{043e}' | '\u{03bf}' | '0' => 'o',
            '\u{0440}' | '\u{03c1}' => 'p',
            '\u{0441}' | '\u{03f2}' => 'c',
            '\u{0445}' | '\u{03c7}' => 'x',
            '\u{0443}' | '\u{03c5}' => 'y',
            '\u{0456}' | '\u{0131}' | '1' | 'i' | '\u{04cf}' | '\u{2113}' => 'l',
            '\u{043a}' | '\u{03ba}' => 'k',
            '\u{0455}' => 's',
            '\u{0432}' | '\u{03bd}' => 'v',
            '\u{0442}' | '\u{03c4}' => 't',
            other => other,
        })
        .collect()
}

/// The PCs of `account_id` out of the server's `GET /v1/devices` answer. A row is dropped (never listed, never
/// "fixed up") when it is signed out, is not a PC, is stale, or its statement does not verify against its own key,
/// account, device id and kind. `now` is unix seconds.
pub fn book(answer: &Value, account_id: &str, now: u64) -> Book {
    let revoked = answer
        .get("devices")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|d| d.get("revoked_at").is_some_and(|x| !x.is_null()))
                .filter_map(|d| d.get("id").and_then(Value::as_str).filter(|i| uuid::Uuid::parse_str(i).is_ok()).map(str::to_lowercase))
                .collect()
        })
        .unwrap_or_default();
    Book { rows: pc_rows(answer, account_id, now), revoked }
}

pub fn pc_rows(answer: &Value, account_id: &str, now: u64) -> Vec<PcRow> {
    let text = |d: &Value, k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let num = |d: &Value, k: &str| d.get(k).and_then(Value::as_u64).unwrap_or(0);
    let Some(list) = answer.get("devices").and_then(Value::as_array) else { return Vec::new() };
    let mut out = Vec::new();
    for d in list {
        let id = text(d, "id");
        let is_this = d.get("self").and_then(Value::as_bool).unwrap_or(false);
        if uuid::Uuid::parse_str(&id).is_err() || text(d, "kind") != "pc" || d.get("revoked_at").is_some_and(|x| !x.is_null()) {
            continue;
        }
        let last_seen_at = num(d, "last_seen_at");
        if !is_this && now.saturating_sub(last_seen_at) > STALE_SECS {
            continue;
        }
        // The statement is the only part of the row the PC signed. Everything the list shows comes from it.
        let (statement, signature, device_pub) = (text(d, "statement"), text(d, "statement_sig"), text(d, "device_pub"));
        if !verify_device_statement(&device_pub, &statement, &signature) {
            continue;
        }
        let Ok(st) = serde_json::from_str::<Value>(&statement) else { continue };
        let same = |k: &str, want: &str| st.get(k).and_then(Value::as_str).is_some_and(|v| v.eq_ignore_ascii_case(want));
        if st.get("v").and_then(Value::as_u64) != Some(1) || !same("account_id", account_id) || !same("device_id", &id) || !same("device_pub", &device_pub) || !same("kind", "pc") {
            continue;
        }
        let Some(name) = st.get("name").and_then(Value::as_str).and_then(clean_name) else { continue };
        // A published link id counts only while its statement is recent: the PC says again every minute while it is open, so an
        // older one is an address that may no longer work (or one the account kept and replays).
        let fresh = st.get("issued_at").and_then(Value::as_u64).is_some_and(|t| t <= now + 120 && now.saturating_sub(t) <= PUBLISH_MAX_AGE_SECS);
        let node = st.get("node_id").and_then(Value::as_str).filter(|n| hex64(n) && fresh).map(str::to_string);
        let binding = node.as_ref().and_then(|_| d.get("node_binding").and_then(Value::as_str)).filter(|b| b.len() <= 4096 && *b != NOT_PUBLISHED).map(str::to_string);
        // The relay comes from the signed statement, never from the account's own column.
        let relay = node.as_ref().and_then(|_| st.get("home_relay").and_then(Value::as_str)).and_then(valid_relay_hint);
        out.push(PcRow {
            id: id.to_lowercase(),
            name,
            account_pub: device_pub.clone(),
            // A row that names a link id but gave no record to check it against is listed as not published.
            node: node.filter(|_| binding.is_some()),
            binding,
            relay,
            created_at: num(d, "created_at"),
            last_seen_at,
            online: d.get("online").and_then(Value::as_bool).unwrap_or(false),
            is_this,
        });
    }
    out
}
