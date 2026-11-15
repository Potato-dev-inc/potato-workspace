//! The app-only address of an artifact, for a tab of the agent browser ("Open in > Agent browser").
//!
//! A page needs an address for a browser tab. This one has **no socket**: it is a custom address scheme of the app
//! (`potato-artifact`, shown by Windows as `http://potato-artifact.localhost/<token>/`) that the PC answers from memory.
//! Nothing else on this computer or the network can reach it, and it is never the bridge, the phone server or a share
//! link.
//!
//! * `<token>` is 24 random bytes (base64url), made when a tab opens and kept in memory only. It maps to one project
//!   and one artifact. It dies with the tab (`close`) or the app; it is never written to disk and never logged.
//! * One document, GET only. Every other method is 405, every other path and every unknown token is the same 404.
//! * The page is served with the same lock as the side pane's frame, by headers instead of `<iframe sandbox>`:
//!   `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; ...; frame-ancestors 'none'` (an opaque
//!   origin: no storage, no cookies, no app calls, no network except the short script-library list). The reply is
//!   built by the same code as a share link's page (`share_page::render`), so HTML, SVG and Mermaid look the same.
//! * It always shows the newest version, so a new version reloads in the tab.

use std::path::PathBuf;

use base64::Engine;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rand::RngCore;

use super::share_page::{plain_page, render, SharePage};
use super::store;

/// Windows shows a custom scheme as `http://<scheme>.localhost/`; other systems keep the scheme itself.
#[cfg(windows)]
pub const ADDRESS_HOST: &str = "potato-artifact.localhost";
#[cfg(not(windows))]
pub const ADDRESS_HOST: &str = "localhost";
#[cfg(windows)]
const ADDRESS_START: &str = "http://potato-artifact.localhost/";
#[cfg(not(windows))]
const ADDRESS_START: &str = "potato-artifact://localhost/";
/// Most tabs that may hold a token at once (older ones are dropped).
const MAX_TOKENS: usize = 32;

/// What a token stands for. The chat (`pane_id`) is the one that owns the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub project: PathBuf,
    pub id: String,
    pub pane_id: String,
}

static TABLE: Lazy<Mutex<Vec<(String, Entry)>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn new_token() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn token_shape_ok(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Makes a token for one page and returns its address. The same page asked twice gets a fresh token (a tab owns its own).
pub fn open(project: PathBuf, id: &str, pane_id: &str) -> Result<String, String> {
    // The page must exist now: an address for nothing is never made.
    store::read(&project, id, None).map_err(|_| "That page is not there any more.".to_string())?;
    let token = new_token();
    let mut table = TABLE.lock();
    table.push((token.clone(), Entry { project, id: id.to_string(), pane_id: pane_id.to_string() }));
    while table.len() > MAX_TOKENS {
        table.remove(0);
    }
    Ok(format!("{ADDRESS_START}{token}/"))
}

/// The origin the browser windows see for the app-only address (it stands for every artifact tab).
pub fn tab_address_origin() -> crate::point::origin::PreviewOrigin {
    #[cfg(windows)]
    let (scheme, port) = ("http", 80);
    #[cfg(not(windows))]
    let (scheme, port) = ("potato-artifact", 0);
    crate::point::origin::PreviewOrigin { scheme: scheme.to_string(), host: ADDRESS_HOST.to_string(), port }
}

/// The chat that owns the page a live address shows.
pub fn owner_of(url: &str) -> Option<(String, String)> {
    entry_of(&live_token(url)?).map(|e| (e.pane_id, e.id))
}

/// Ends the tab's access (its tab closed). Unknown tokens are ignored.
pub fn close(token: &str) {
    TABLE.lock().retain(|(t, _)| t != token);
}

/// The token inside an address, if the address is ours and the token is alive. Nothing else is ever allowed through.
pub fn live_token(url: &str) -> Option<String> {
    let rest = url.strip_prefix(ADDRESS_START)?;
    let (token, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if !tail.is_empty() || !token_shape_ok(token) {
        return None;
    }
    TABLE.lock().iter().any(|(t, _)| t == token).then(|| token.to_string())
}

/// Whether `url` is the address of a live tab of ours (the one narrow allowance of the browser's address guard).
pub fn is_live_address(url: &str) -> bool {
    live_token(url).is_some()
}

/// What a live token stands for (never the token itself).
pub fn entry_of(token: &str) -> Option<Entry> {
    TABLE.lock().iter().find(|(t, _)| t == token).map(|(_, e)| e.clone())
}

/// A short line for the address bar chip: `Artifact · Pricing page · v3 — on this computer · read-only`.
pub fn chip_of(url: &str) -> Option<String> {
    let entry = entry_of(&live_token(url)?)?;
    let read = store::read(&entry.project, &entry.id, None).ok()?;
    Some(format!("Artifact \u{b7} {} \u{b7} v{} \u{2014} on this computer \u{b7} read-only", read.artifact.title.replace(['\r', '\n'], " "), read.version))
}

fn refuse(status: u16, title: &str, message: &str) -> SharePage {
    let mut page = plain_page(status, title, message);
    if status == 405 {
        page.headers.push(("Allow", "GET".to_string()));
    }
    page
}

/// The reply for one request to the address. `path` is the request path (`/<token>/`), no query is read.
pub fn respond(method: &str, path: &str) -> SharePage {
    if method != "GET" {
        return refuse(405, "Read only", "This page can only be read.");
    }
    let token = path.trim_start_matches('/').trim_end_matches('/');
    if !token_shape_ok(token) || path.trim_start_matches('/').trim_end_matches('/').contains('/') {
        return refuse(404, "Not found", "This page does not exist.");
    }
    let Some(entry) = entry_of(token) else {
        return refuse(404, "Not found", "This page does not exist.");
    };
    match store::read(&entry.project, &entry.id, None) {
        Ok(read) => render(&read.artifact.title, read.artifact.kind, &read.content),
        Err(_) => refuse(404, "Not found", "This page does not exist."),
    }
}

#[cfg(test)]
#[path = "serve_tests.rs"]
mod serve_tests;
