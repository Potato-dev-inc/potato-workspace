//! The consent step. A guide uses the person's own agent plan, so a run only starts with a token that `estimate` gave
//! to a sheet the person was looking at: no token, no run. A token works once, for one project, for 30 minutes.
//!
//! The numbers are first guesses (plan section 6): they are labelled `measured: false` until Phase 0 measures them,
//! and the sheet shows a range, in "long chats", never money.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::model::MAX_PAGES;
use super::scan::{skip_summary, Scan, MIN_SOURCE_FILES};

const TOKEN_TTL_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Size {
    Short,
    #[default]
    Normal,
    Deep,
}

impl Size {
    fn factor(self) -> f32 {
        match self {
            Self::Short => 0.6,
            Self::Normal => 1.0,
            Self::Deep => 1.4,
        }
    }

    /// The most pages the outline may have at this size.
    pub fn page_cap(self) -> usize {
        match self {
            Self::Short => 10,
            Self::Normal => 20,
            Self::Deep => MAX_PAGES,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub token: String,
    pub size: Size,
    /// `small`, `medium` or `large`.
    pub project_size: String,
    pub files_read: usize,
    pub files_skipped: usize,
    pub skipped_by_reason: BTreeMap<String, usize>,
    pub pages_lo: usize,
    pub pages_hi: usize,
    pub minutes_lo: u32,
    pub minutes_hi: u32,
    /// "About N long chats" (low, high).
    pub chats_lo: u32,
    pub chats_hi: u32,
    /// Millions of tokens read and written (low, high). Shown under "details" only.
    pub tokens_m_lo: f32,
    pub tokens_m_hi: f32,
    /// False until Phase 0 measured these numbers.
    pub measured: bool,
    /// Too few source files to offer a guide.
    pub too_small: bool,
    pub truncated: bool,
}

pub fn estimate_for(scan: &Scan, size: Size, token: String) -> Estimate {
    let sources = scan.source_count();
    let (class, pages, minutes, tokens): (&str, (f32, f32), (f32, f32), (f32, f32)) = if sources < 200 {
        ("small", (6.0, 10.0), (3.0, 5.0), (0.2, 0.5))
    } else if sources <= 2000 {
        ("medium", (12.0, 18.0), (6.0, 12.0), (0.6, 1.5))
    } else {
        ("large", (20.0, 30.0), (15.0, 30.0), (2.0, 4.0))
    };
    let f = size.factor();
    let cap = size.page_cap();
    let pages_lo = ((pages.0 * f).round() as usize).clamp(3, cap);
    let pages_hi = ((pages.1 * f).round() as usize).clamp(pages_lo, cap);
    let tokens_m_lo = (tokens.0 * f * 10.0).round() / 10.0;
    let tokens_m_hi = (tokens.1 * f * 10.0).round() / 10.0;
    // A long chat is taken as roughly 0.12 M tokens (a guess, like the rest).
    let chats = |m: f32| ((m / 0.12).round() as u32).max(1);
    Estimate {
        token,
        size,
        project_size: class.into(),
        files_read: scan.files.len(),
        files_skipped: scan.skipped.len(),
        skipped_by_reason: skip_summary(scan),
        pages_lo,
        pages_hi,
        minutes_lo: ((minutes.0 * f).round() as u32).max(2),
        minutes_hi: ((minutes.1 * f).round() as u32).max(3),
        chats_lo: chats(tokens_m_lo),
        chats_hi: chats(tokens_m_hi).max(chats(tokens_m_lo)),
        tokens_m_lo,
        tokens_m_hi,
        measured: false,
        too_small: sources < MIN_SOURCE_FILES,
        truncated: scan.truncated,
    }
}

struct Issued {
    project: String,
    at_ms: u64,
}

static TOKENS: Mutex<Option<HashMap<String, Issued>>> = Mutex::new(None);
static COUNTER: AtomicU64 = AtomicU64::new(1);

fn key_of(project: &Path) -> String {
    std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf()).to_string_lossy().to_string()
}

/// A fresh token for this project (older tokens of it stay valid until used or expired).
pub fn issue_token(project: &Path) -> String {
    issue_token_at(project, super::store::now_ms())
}

pub fn issue_token_at(project: &Path, now_ms: u64) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let seed = format!("{}|{now_ms}|{n}|{:?}", key_of(project), std::thread::current().id());
    let token: String = Sha256::digest(seed.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
    let mut guard = TOKENS.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    map.retain(|_, v| now_ms.saturating_sub(v.at_ms) <= TOKEN_TTL_MS);
    map.insert(token.clone(), Issued { project: key_of(project), at_ms: now_ms });
    token
}

/// Uses a token up. False for an unknown, used, expired or other-project token.
pub fn consume_token(project: &Path, token: &str) -> bool {
    consume_token_at(project, token, super::store::now_ms())
}

pub fn consume_token_at(project: &Path, token: &str, now_ms: u64) -> bool {
    let mut guard = TOKENS.lock();
    let Some(map) = guard.as_mut() else { return false };
    match map.get(token) {
        Some(issued) if issued.project == key_of(project) && now_ms.saturating_sub(issued.at_ms) <= TOKEN_TTL_MS => {
            map.remove(token);
            true
        }
        _ => false,
    }
}
