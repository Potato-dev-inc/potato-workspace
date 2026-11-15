//! What travels on the shelf: one skill or one tool (an MCP server or connector), as plain data.
//!
//! A shelf item holds a DEFINITION and never a secret: every env value and header value is the
//! placeholder, an argument that looked like a key is the placeholder, and a skill is its
//! `SKILL.md` text only. The receiving side runs [`ShelfItem::clean`] on everything again, so a
//! hostile teammate cannot smuggle a value, a control character or a path through it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::team::event::clean_text;

/// Stands where a secret was. Shown to the person; written into a config as an empty value (env and
/// headers, so no fake key is stored) or as it is (an argument, which cannot be empty).
pub const PLACEHOLDER: &str = "<you add your own key>";
/// The same, inside an address (no spaces there).
pub const PLACEHOLDER_URL: &str = "you-add-your-own-key";
/// Stands where a folder of the sender's PC was.
pub const PLACEHOLDER_PATH: &str = "<your own folder>";
/// A skill's text may not be longer than this (the relay takes 24 KB per update).
pub const MAX_SKILL_BYTES: usize = 12 * 1024;
/// All of a tool's arguments together.
pub const MAX_ARGS_BYTES: usize = 2 * 1024;
pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_ABOUT_CHARS: usize = 200;
pub const MAX_WHY_CHARS: usize = 200;
const MAX_VARS: usize = 16;
const MAX_ARGS: usize = 40;
/// Ids a teammate may say they have.
pub const MAX_HAVE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Skill,
    Tool,
    /// A kind from a newer build: listed, never added.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolTransport {
    /// Starts a program on this PC.
    Stdio,
    /// Talks to a web address.
    Http,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    #[serde(default)]
    pub transport: Option<ToolTransport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Names only: every value is [`PLACEHOLDER`].
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub kind: ItemKind,
    pub name: String,
    #[serde(default)]
    pub about: String,
    /// The `SKILL.md` text (kind `skill`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    /// Files of the skill folder that were NOT sent (scripts and the like).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub skipped_files: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolDef>,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// What a shelf event carries: a suggested item, or the ids the sender has.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<ShelfItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub have: Vec<String>,
}

/// The id of an item: a hash of its content, never its name or who sent it, so the same thing is the
/// same id on every PC. The receiver computes it again; an id a sender claims is never used.
pub fn item_id(item: &ShelfItem) -> String {
    let mut h = Sha256::new();
    let mut put = |s: &str| {
        h.update((s.len() as u64).to_le_bytes());
        h.update(s.as_bytes());
    };
    put(match item.kind {
        ItemKind::Skill => "skill",
        ItemKind::Tool => "tool",
        ItemKind::Unknown => "unknown",
    });
    put(item.skill.as_deref().unwrap_or(""));
    if let Some(tool) = &item.tool {
        put(match tool.transport {
            Some(ToolTransport::Stdio) => "stdio",
            Some(ToolTransport::Http) => "http",
            _ => "?",
        });
        put(tool.command.as_deref().unwrap_or(""));
        for a in &tool.args {
            put(a);
        }
        put(tool.url.as_deref().unwrap_or(""));
        for k in tool.env.keys() {
            put(k);
        }
        put("|");
        for k in tool.headers.keys() {
            put(k);
        }
    }
    h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
}

pub fn is_item_id(id: &str) -> bool {
    id.len() == 24 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Plain text from a teammate: control characters (except line breaks and tabs) and bidi overrides gone.
pub fn clean_block(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .filter(|c| {
            let bidi = matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}');
            !bidi && (!c.is_control() || *c == '\n' || *c == '\t')
        })
        .collect()
}

/// A variable or header name: letters, digits, `_` and `-`.
fn valid_var(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// One line of at most `max` characters, or `None` (a line break or control character is refused, not repaired).
fn one_line(text: &str, max: usize) -> Option<String> {
    if text.chars().any(char::is_control) || text.chars().count() > max {
        return None;
    }
    let cleaned = clean_text(text, max);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn placeholders(map: &BTreeMap<String, String>) -> Option<BTreeMap<String, String>> {
    if map.len() > MAX_VARS {
        return None;
    }
    map.keys().map(|k| valid_var(k).then(|| (k.clone(), PLACEHOLDER.to_string()))).collect()
}

impl ShelfItem {
    /// An item from a teammate, made safe: every display string cleaned and cut, every env and header
    /// VALUE replaced by the placeholder (whatever the sender wrote), sizes checked. `None` when the item
    /// is not worth showing (no name, nothing in it, over a limit). An unknown kind is kept so it can be
    /// listed as "needs a newer version".
    pub fn clean(self) -> Option<ShelfItem> {
        let name = clean_text(&self.name, MAX_NAME_CHARS);
        if name.is_empty() {
            return None;
        }
        let about = clean_text(&self.about, MAX_ABOUT_CHARS);
        let unknown = |name: String, about: String| ShelfItem { kind: ItemKind::Unknown, name, about, skill: None, skipped_files: 0, tool: None };
        match self.kind {
            ItemKind::Unknown => Some(unknown(name, about)),
            ItemKind::Skill => {
                let text = clean_block(self.skill.as_deref()?);
                if text.trim().is_empty() || text.len() > MAX_SKILL_BYTES {
                    return None;
                }
                Some(ShelfItem { kind: ItemKind::Skill, name, about, skill: Some(text), skipped_files: self.skipped_files.min(999), tool: None })
            }
            ItemKind::Tool => {
                let tool = self.tool?;
                let clean = match tool.transport? {
                    ToolTransport::Stdio => {
                        let command = one_line(tool.command.as_deref()?, 200)?;
                        if tool.args.len() > MAX_ARGS || tool.args.iter().map(String::len).sum::<usize>() > MAX_ARGS_BYTES {
                            return None;
                        }
                        let args = tool.args.iter().map(|a| one_line(a, 500)).collect::<Option<Vec<_>>>()?;
                        ToolDef { transport: Some(ToolTransport::Stdio), command: Some(command), args, url: None, env: placeholders(&tool.env)?, headers: BTreeMap::new() }
                    }
                    ToolTransport::Http => {
                        let url = one_line(tool.url.as_deref()?, 500)?;
                        if !(url.starts_with("https://") || url.starts_with("http://")) || url.contains(char::is_whitespace) {
                            return None;
                        }
                        ToolDef { transport: Some(ToolTransport::Http), command: None, args: Vec::new(), url: Some(url), env: BTreeMap::new(), headers: placeholders(&tool.headers)? }
                    }
                    ToolTransport::Unknown => return Some(unknown(name, about)),
                };
                Some(ShelfItem { kind: ItemKind::Tool, name, about, skill: None, skipped_files: 0, tool: Some(clean) })
            }
        }
    }

    /// The names of the keys the person must add themselves.
    pub fn needs(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(tool) = &self.tool {
            out.extend(tool.env.keys().cloned());
            out.extend(tool.headers.keys().cloned());
            if tool.args.iter().any(|a| a.contains(PLACEHOLDER)) {
                out.push("an argument".to_string());
            }
            if tool.url.as_deref().is_some_and(|u| u.contains(PLACEHOLDER_URL)) {
                out.push("part of the address".to_string());
            }
        }
        out
    }
}

/// A plain slug for a folder or key: `a-z`, `0-9`, `-`.
pub fn slug(name: &str) -> String {
    crate::toolbelt::store::slug(name)
}
