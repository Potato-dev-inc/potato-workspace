//! The agent's own question, read from the prompt text for a prompt nothing classified, and the command an
//! option says it runs (`Update now (runs <command>)`). Generic: no agent, no program is named here.

use regex::Regex;
use std::sync::OnceLock;

/// Longest question kept, in characters, and most lines.
const MAX_CHARS: usize = 160;
const MAX_LINES: usize = 2;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

/// Terminal junk: colour codes and box-drawing or block characters.
fn strip_junk(line: &str) -> String {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let line = re(&ANSI, r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").replace_all(line, "");
    line.chars().filter(|c| !('\u{2500}'..='\u{259F}').contains(c) && !c.is_control()).collect::<String>().trim().to_string()
}

/// A hint about keys ("enter continue · esc skip", "Press enter to confirm").
fn is_key_hint(line: &str) -> bool {
    static HINT: OnceLock<Regex> = OnceLock::new();
    re(&HINT, r"(?i)\b(?:enter|esc|escape|tab|return)\b.*\b(?:continue|skip|confirm|cancel|select|navigate|back|exit|to \w+)\b|\b(?:ctrl|shift|alt)\+|use (?:the )?arrow|\u{2191}|\u{2193}").is_match(line)
}

/// The first meaningful line or two of the question, or `None` when the text holds nothing readable.
pub(super) fn question_text(raw: &str) -> Option<String> {
    static URL: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let mut kept: Vec<String> = Vec::new();
    for line in raw.lines() {
        let line = strip_junk(line);
        if line.is_empty() || is_key_hint(&line) {
            continue;
        }
        let no_url = re(&URL, r"(?i)\b(?:https?|ftp)://\S+|\bwww\.\S+").replace_all(&line, "");
        let no_url = re(&SPACES, r"\s{2,}").replace_all(&no_url, " ");
        // A line that was only a label for a link ("Release notes: <url>") says nothing without it.
        let label_only = no_url.len() < line.len() && no_url.trim().ends_with(':');
        let cleaned = no_url.trim().trim_end_matches([':', '-', '\u{b7}', '|']).trim().to_string();
        if label_only || cleaned.chars().filter(|c| c.is_alphanumeric()).count() < 3 {
            continue;
        }
        kept.push(cleaned);
        if kept.len() == MAX_LINES {
            break;
        }
    }
    if kept.is_empty() {
        return None;
    }
    let joined = kept.join("\n");
    if joined.chars().count() <= MAX_CHARS {
        return Some(joined);
    }
    let cut: String = joined.chars().take(MAX_CHARS - 1).collect();
    Some(format!("{}\u{2026}", cut.trim_end()))
}

/// The command in a trailing `(runs <command>)` bracket of an option, without quotes around it.
pub(super) fn runs_command(label: &str) -> Option<String> {
    static RUNS: OnceLock<Regex> = OnceLock::new();
    let found = re(&RUNS, r"(?is)\(\s*runs?\s+(.+)\)\s*$").captures(label)?;
    let command = found[1].trim().trim_matches('`').trim();
    (!command.is_empty()).then(|| command.to_string())
}
