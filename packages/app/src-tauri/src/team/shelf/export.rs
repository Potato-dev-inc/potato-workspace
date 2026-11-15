//! My tool or skill -> a shelf item. This is the ONE place a definition leaves my PC, so it is where
//! every secret is taken out:
//!
//! - env values and header values: all of them, whatever the name, become [`PLACEHOLDER`] (names stay);
//! - arguments: the value after a secret-looking flag (`--token abc`, `--api-key=abc`, `KEY=abc`), and any
//!   text a secret scanner flags, become [`PLACEHOLDER`]; a folder of this PC becomes [`PLACEHOLDER_PATH`];
//! - an address: the user name and password part, secret-looking query values and the `#` part are removed;
//! - a command that is a path on this PC is refused (a teammate does not have that file);
//! - a skill: `SKILL.md` text only, secret-shaped text redacted, this PC's home folder written as `~`.
//!
//! A definition that cannot be made safe is refused with a sentence, never sent as it is.

use std::collections::BTreeMap;
use std::path::Path;

use super::model::{ItemKind, ShelfItem, ToolDef, ToolTransport, MAX_SKILL_BYTES, PLACEHOLDER, PLACEHOLDER_PATH, PLACEHOLDER_URL};
use crate::toolbelt::store::{is_secret_key, ToolServer, Transport};

/// `C:\x`, `C:/x`, `\\server\share`, `/usr/x` (two or more parts) or `~/x`: a place on one PC. `/c` and `-y` are not.
pub fn looks_like_path(text: &str) -> bool {
    let b = text.as_bytes();
    if text.starts_with("~/") || text.starts_with("~\\") || text.starts_with("\\\\") {
        return true;
    }
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return true;
    }
    text.starts_with('/') && text[1..].contains('/')
}

fn mentions_home(text: &str, home: &Path) -> bool {
    let home = home.to_string_lossy();
    if home.len() < 4 {
        return false;
    }
    let fwd = home.replace('\\', "/").to_ascii_lowercase();
    text.replace('\\', "/").to_ascii_lowercase().contains(&fwd)
}

fn flag_name(arg: &str) -> Option<&str> {
    let name = arg.trim_start_matches('-');
    (arg.starts_with('-') && !name.is_empty()).then_some(name)
}

fn secret_shaped(text: &str) -> bool {
    crate::redact::text(text).get() != text
}

/// Replace a whole value: a folder, a secret, or itself.
fn scrub_value(value: &str, home: &Path) -> String {
    if looks_like_path(value) || mentions_home(value, home) {
        PLACEHOLDER_PATH.to_string()
    } else if secret_shaped(value) {
        PLACEHOLDER.to_string()
    } else if value.starts_with("http://") || value.starts_with("https://") {
        scrub_url(value)
    } else {
        value.to_string()
    }
}

/// Arguments with every secret and every folder of this PC taken out.
pub fn scrub_args(args: &[String], home: &Path) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut hide_next = false;
    for arg in args {
        if hide_next {
            hide_next = false;
            if !arg.starts_with('-') {
                out.push(PLACEHOLDER.to_string());
                continue;
            }
        }
        if let Some((name, value)) = arg.split_once('=') {
            // `--token=abc`, `-e KEY=abc` (the pair), `--url=https://...`
            let bare = flag_name(name).unwrap_or(name);
            let value = if is_secret_key(bare) && !value.is_empty() { PLACEHOLDER.to_string() } else { scrub_value(value, home) };
            out.push(format!("{name}={value}"));
            continue;
        }
        if let Some(name) = flag_name(arg) {
            hide_next = is_secret_key(name);
            out.push(arg.clone());
            continue;
        }
        out.push(scrub_value(arg, home));
    }
    out
}

/// An address without a user name or password, without the `#` part and without secret-looking query values.
pub fn scrub_url(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("https", url));
    let rest = rest.split('#').next().unwrap_or("");
    let (before_query, query) = match rest.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    let (host, path) = match before_query.split_once('/') {
        Some((h, p)) => (h, Some(p)),
        None => (before_query, None),
    };
    let host = host.rsplit('@').next().unwrap_or(host);
    let mut out = format!("{scheme}://{host}");
    if let Some(path) = path {
        out.push('/');
        out.push_str(path);
    }
    if let Some(query) = query.filter(|q| !q.is_empty()) {
        let pairs: Vec<String> = query
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some((k, v)) if is_secret_key(k) || secret_shaped(v) || v.len() >= 24 => format!("{k}={PLACEHOLDER_URL}"),
                _ => pair.to_string(),
            })
            .collect();
        out.push('?');
        out.push_str(&pairs.join("&"));
    }
    out
}

/// A toolbelt or agent-config server as a shelf item, or why it cannot be shared.
pub fn tool_item(server: &ToolServer, home: &Path) -> Result<ShelfItem, String> {
    let name = server.name.trim().to_string();
    let names = |m: &BTreeMap<String, String>| -> BTreeMap<String, String> { m.keys().map(|k| (k.clone(), PLACEHOLDER.to_string())).collect() };
    let tool = match server.transport {
        Transport::Stdio => {
            let command = server.command.clone().unwrap_or_default();
            if command.trim().is_empty() {
                return Err("It has no command.".into());
            }
            if looks_like_path(&command) || command.contains(['/', '\\']) || mentions_home(&command, home) {
                return Err("It runs a program from a folder on your PC. A teammate does not have that file.".into());
            }
            ToolDef {
                transport: Some(ToolTransport::Stdio),
                command: Some(command),
                args: scrub_args(&server.args, home),
                url: None,
                env: names(&server.env),
                headers: BTreeMap::new(),
            }
        }
        Transport::Http => {
            let url = scrub_url(server.url.as_deref().unwrap_or(""));
            ToolDef { transport: Some(ToolTransport::Http), command: None, args: Vec::new(), url: Some(url), env: BTreeMap::new(), headers: names(&server.headers) }
        }
    };
    let item = ShelfItem { kind: ItemKind::Tool, name, about: String::new(), skill: None, skipped_files: 0, tool: Some(tool) };
    // The receiving side's rules, run here too: what I cannot send I say so now, not after the click.
    item.clean().ok_or_else(|| "It is too big or has a name or value Potato Workspace cannot send.".to_string())
}

/// A skill's `SKILL.md` as a shelf item. `other_files` counts what is in the folder besides it (not sent).
pub fn skill_item(name: &str, about: &str, text: &str, other_files: u32, home: &Path) -> Result<ShelfItem, String> {
    let mut body = crate::team::shelf::model::clean_block(text);
    body = crate::redact::text(&body).into_inner();
    let home_text = home.to_string_lossy().to_string();
    if home_text.len() >= 4 {
        for variant in [home_text.clone(), home_text.replace('\\', "/"), home_text.replace('\\', "\\\\")] {
            body = body.replace(&variant, "~");
        }
    }
    if body.trim().is_empty() {
        return Err("The skill file is empty.".into());
    }
    if body.len() > MAX_SKILL_BYTES {
        return Err(format!("It is {} KB. The limit is {} KB.", body.len().div_ceil(1024), MAX_SKILL_BYTES / 1024));
    }
    let item = ShelfItem { kind: ItemKind::Skill, name: name.to_string(), about: about.to_string(), skill: Some(body), skipped_files: other_files, tool: None };
    item.clean().ok_or_else(|| "It has no name Potato Workspace can send.".to_string())
}
