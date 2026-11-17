//! The output of one background terminal: a bounded ring of clean text lines.
//!
//! Bytes come in as the pseudo console wrote them (escape sequences, carriage returns, half a UTF-8
//! character at the end of a chunk). A line is cleaned and redacted ONCE, when its newline arrives, so a
//! secret that the console split over two chunks is still one piece when it is masked. The unfinished
//! last line (a prompt, "ready on port 5173" before the newline) is kept raw and cleaned when read.
//!
//! Bounds: 2,000 lines and 1 MB; the oldest lines go first and `dropped` says how many a reader missed.
//! Every committed line has a cursor (its number since the start), so a reader asks for "after 117".

use std::collections::VecDeque;

pub const MAX_LINES: usize = 2_000;
pub const MAX_BYTES: usize = 1_000_000;
/// A longer line is cut (a minified bundle, a progress bar that never ends a line).
pub const MAX_LINE_CHARS: usize = 4_000;
/// The unfinished line is cut raw at this size so a program that never prints a newline cannot grow it.
const MAX_RAW_PARTIAL: usize = 16_000;

#[derive(Debug)]
pub struct Ring {
    lines: VecDeque<String>,
    bytes: usize,
    /// Cursor of `lines[0]`.
    first: u64,
    raw: String,
    carry: Vec<u8>,
    max_lines: usize,
    max_bytes: usize,
}

/// What a read returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    pub lines: Vec<String>,
    /// Pass this as `after_cursor` next time.
    pub next_cursor: u64,
    /// Lines the caller asked for that were already pushed out of the ring.
    pub dropped: u64,
    /// The unfinished last line, cleaned, when there is text on it.
    pub partial: Option<String>,
}

impl Default for Ring {
    fn default() -> Self {
        Self::with_limits(MAX_LINES, MAX_BYTES)
    }
}

impl Ring {
    pub fn with_limits(max_lines: usize, max_bytes: usize) -> Self {
        Ring { lines: VecDeque::new(), bytes: 0, first: 0, raw: String::new(), carry: Vec::new(), max_lines: max_lines.max(1), max_bytes: max_bytes.max(64) }
    }

    /// Takes what the console wrote. Never fails.
    pub fn push_bytes(&mut self, chunk: &[u8]) {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let text = match std::str::from_utf8(&data) {
            Ok(text) => text.to_string(),
            Err(error) => {
                let valid = error.valid_up_to();
                if error.error_len().is_none() {
                    // A character cut by the chunk boundary: keep its start for the next chunk.
                    self.carry = data[valid..].to_vec();
                    String::from_utf8_lossy(&data[..valid]).into_owned()
                } else {
                    String::from_utf8_lossy(&data).into_owned()
                }
            }
        };
        self.push_text(&text);
    }

    pub fn push_text(&mut self, text: &str) {
        for ch in text.chars() {
            if ch == '\n' {
                let raw = std::mem::take(&mut self.raw);
                self.commit(&raw);
            } else {
                self.raw.push(ch);
                if self.raw.len() > MAX_RAW_PARTIAL {
                    let raw = std::mem::take(&mut self.raw);
                    self.commit(&raw);
                }
            }
        }
    }

    /// A program that ended without a final newline: its last line is a line now.
    pub fn finish(&mut self) {
        if !self.raw.trim().is_empty() {
            let raw = std::mem::take(&mut self.raw);
            self.commit(&raw);
        }
        self.raw.clear();
    }

    fn commit(&mut self, raw: &str) {
        let line = clean_line(raw);
        // The console redraws and pads; a line that has nothing on it is not output.
        if line.is_empty() {
            return;
        }
        self.bytes += line.len() + 1;
        self.lines.push_back(line);
        while self.lines.len() > self.max_lines || (self.bytes > self.max_bytes && self.lines.len() > 1) {
            if let Some(gone) = self.lines.pop_front() {
                self.bytes = self.bytes.saturating_sub(gone.len() + 1);
                self.first += 1;
            }
        }
    }

    /// Cursor after the last committed line.
    pub fn next_cursor(&self) -> u64 {
        self.first + self.lines.len() as u64
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    #[cfg(test)]
    pub fn byte_size(&self) -> usize {
        self.bytes
    }

    /// The unfinished last line, cleaned (empty text gives `None`).
    pub fn partial(&self) -> Option<String> {
        let line = clean_line(&self.raw);
        (!line.is_empty()).then_some(line)
    }

    /// Up to `max` lines after `after` (the first `max` of them, so a reader pages forward without gaps).
    pub fn read(&self, after: u64, max: usize) -> Read {
        let start = after.max(self.first);
        let dropped = self.first.saturating_sub(after);
        let skip = (start - self.first) as usize;
        let lines: Vec<String> = self.lines.iter().skip(skip).take(max.max(1)).cloned().collect();
        let next_cursor = start + lines.len() as u64;
        let partial = if next_cursor >= self.next_cursor() { self.partial() } else { None };
        Read { lines, next_cursor, dropped, partial }
    }

    /// The last `max` lines (for the output view) and the cursor after them.
    pub fn tail(&self, max: usize) -> Read {
        let total = self.next_cursor();
        self.read(total.saturating_sub(max as u64), max)
    }

    /// The first line after `after` that `matches`, with its cursor, looking at the unfinished line last.
    pub fn find(&self, after: u64, matches: impl Fn(&str) -> bool) -> Option<(u64, String)> {
        let start = after.max(self.first);
        for (i, line) in self.lines.iter().enumerate().skip((start - self.first) as usize) {
            if matches(line) {
                return Some((self.first + i as u64, line.clone()));
            }
        }
        self.partial().filter(|p| matches(p)).map(|p| (self.next_cursor(), p))
    }
}

/// One finished line of console text as a person would read it: no escape sequences, the last
/// carriage-return rewrite wins, no trailing blanks, secrets masked, cut at [`MAX_LINE_CHARS`].
pub fn clean_line(raw: &str) -> String {
    let stripped = strip_escapes(raw);
    // "10%\r20%\r30%": what the screen would show is the last piece.
    let shown = stripped.split('\r').rev().find(|piece| !piece.trim().is_empty()).unwrap_or("");
    let shown: String = shown.chars().filter(|c| !c.is_control() || *c == '\t').collect();
    let trimmed = shown.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    let masked = crate::redact::text(trimmed).into_inner();
    if masked.chars().count() > MAX_LINE_CHARS {
        let mut cut: String = masked.chars().take(MAX_LINE_CHARS - 1).collect();
        cut.push('\u{2026}');
        cut
    } else {
        masked
    }
}

/// Removes CSI (`ESC [ ...`), OSC (`ESC ] ... BEL` or `ESC \`) and two-character escapes.
pub fn strip_escapes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameters, intermediates, then one final byte in @..~
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') | Some('P') | Some('^') | Some('_') => {
                // Up to BEL or ST (ESC \).
                while let Some(n) = chars.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some('(') | Some(')') | Some('*') | Some('+') | Some('#') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_get_cursors_and_a_reader_pages_forward() {
        let mut ring = Ring::default();
        ring.push_text("one\ntwo\nthree\n");
        let first = ring.read(0, 2);
        assert_eq!(first.lines, ["one", "two"]);
        assert_eq!(first.next_cursor, 2);
        let rest = ring.read(first.next_cursor, 10);
        assert_eq!(rest.lines, ["three"]);
        assert_eq!(rest.next_cursor, 3);
        assert!(ring.read(3, 10).lines.is_empty());
    }

    #[test]
    fn the_ring_is_bounded_by_lines_and_says_what_was_dropped() {
        let mut ring = Ring::with_limits(5, 1_000_000);
        for i in 0..12 {
            ring.push_text(&format!("line {i}\n"));
        }
        assert_eq!(ring.len(), 5);
        let read = ring.read(0, 100);
        assert_eq!(read.dropped, 7);
        assert_eq!(read.lines.first().map(String::as_str), Some("line 7"));
        assert_eq!(read.next_cursor, 12);
    }

    #[test]
    fn the_ring_is_bounded_by_bytes() {
        let mut ring = Ring::with_limits(10_000, 2_000);
        for i in 0..500 {
            ring.push_text(&format!("a line of some length {i}\n"));
        }
        assert!(ring.byte_size() <= 2_000, "{}", ring.byte_size());
        assert!(ring.len() < 500 && ring.len() > 10);
    }

    #[test]
    fn one_huge_line_is_cut_and_never_grows_the_buffer() {
        let mut ring = Ring::default();
        ring.push_text(&"x".repeat(100_000));
        ring.push_text("\nnext\n");
        let read = ring.read(0, 10);
        assert!(read.lines.iter().all(|l| l.chars().count() <= MAX_LINE_CHARS), "{read:?}");
        assert!(ring.byte_size() < 40_000);
    }

    #[test]
    fn escapes_and_carriage_returns_are_cleaned() {
        let mut ring = Ring::default();
        ring.push_text("\u{1b}[?25l\u{1b}]0;title\u{7}\u{1b}[32mready\u{1b}[0m on 5173\r\n10%\r50%\r100% done\r\n");
        assert_eq!(ring.read(0, 10).lines, ["ready on 5173", "100% done"]);
    }

    #[test]
    fn a_character_cut_by_a_chunk_is_not_lost() {
        let mut ring = Ring::default();
        let bytes = "caf\u{e9} ok\n".as_bytes();
        ring.push_bytes(&bytes[..4]);
        ring.push_bytes(&bytes[4..]);
        assert_eq!(ring.read(0, 5).lines, ["caf\u{e9} ok"]);
    }

    #[test]
    fn the_unfinished_line_can_be_read_and_found() {
        let mut ring = Ring::default();
        ring.push_text("starting\nlistening on :5173");
        let read = ring.read(0, 10);
        assert_eq!(read.lines, ["starting"]);
        assert_eq!(read.partial.as_deref(), Some("listening on :5173"));
        assert!(ring.find(0, |l| l.contains("5173")).is_some());
        ring.finish();
        assert_eq!(ring.read(0, 10).lines.len(), 2);
    }

    #[test]
    fn secrets_are_masked_even_when_the_console_split_them() {
        let secret = ["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].concat();
        let mut ring = Ring::default();
        ring.push_text(&format!("key is {}", &secret[..14]));
        ring.push_text(&format!("{}\n", &secret[14..]));
        let line = ring.read(0, 5).lines.remove(0);
        assert!(!line.contains("abcdefghijklmnopqrstuvwxyz"), "{line}");
        assert!(line.starts_with("key is"), "{line}");
    }
}
