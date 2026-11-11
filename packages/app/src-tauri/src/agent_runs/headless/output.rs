//! Reading a headless child's stdout/stderr into the run transcript (UTF-8 safe across read
//! boundaries) and reading a stream back.

use crate::agent_runs::transcript;
use crate::operations;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;
use std::thread;

/// The transcript keeps only the last 200 chunks / 256 KB, so a long run would lose its first
/// events (the provider session id, the model) and a big single-line result. The reader therefore
/// also keeps the child's redacted output here for the length of the run: the first
/// `RAW_HEAD_BYTES` plus the last `RAW_TAIL_BYTES` of each stream.
const RAW_HEAD_BYTES: usize = 256 * 1024;
const RAW_TAIL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct RawStream {
    head: String,
    tail: String,
}

impl RawStream {
    fn push(&mut self, text: &str) {
        self.push_capped(text, RAW_HEAD_BYTES, RAW_TAIL_BYTES);
    }

    fn push_capped(&mut self, text: &str, head_max: usize, tail_max: usize) {
        let mut rest = text;
        if self.tail.is_empty() && self.head.len() < head_max {
            let mut cut = (head_max - self.head.len()).min(rest.len());
            while !rest.is_char_boundary(cut) {
                cut += 1;
            }
            self.head.push_str(&rest[..cut]);
            rest = &rest[cut..];
        }
        self.tail.push_str(rest);
        if self.tail.len() > tail_max {
            let mut cut = self.tail.len() - tail_max;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }
    }

    fn text(&self) -> String {
        format!("{}{}", self.head, self.tail)
    }
}

static RAW: OnceLock<Mutex<HashMap<String, RawStream>>> = OnceLock::new();

fn raw_key(project: &str, operation_id: &str, stream: &str) -> String {
    format!("{project}\n{operation_id}\n{stream}")
}

fn record_raw(project: &str, operation_id: &str, stream: &str, text: &str) {
    RAW.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .entry(raw_key(project, operation_id, stream))
        .or_default()
        .push(text);
}

/// Drops the run's kept output once the turn is settled.
pub(super) fn forget_raw(project: &str, operation_id: &str) {
    if let Some(all) = RAW.get() {
        let mut all = all.lock();
        for stream in ["stdout", "stderr"] {
            all.remove(&raw_key(project, operation_id, stream));
        }
    }
}

/// Everything the child wrote to one stream so far.
pub(super) fn stream_text(project: &str, operation_id: &str, stream: &str) -> String {
    if let Some(all) = RAW.get() {
        if let Some(raw) = all.lock().get(&raw_key(project, operation_id, stream)) {
            return raw.text();
        }
    }
    transcript::read(project, operation_id, 0)
        .map(|page| page.chunks)
        .unwrap_or_default()
        .iter()
        .filter(|chunk| chunk.stream == stream)
        .map(|chunk| chunk.text.as_str())
        .collect()
}

pub(super) fn spawn_reader<R: Read + Send + 'static>(
    project: String,
    operation_id: String,
    stream: &'static str,
    mut reader: R,
) -> Option<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("puppet-agent-{stream}"))
        .spawn(move || {
            let mut bytes = [0u8; 8192];
            let mut pending = Vec::new();
            let mut first_output = stream == "stdout";
            while let Ok(read) = reader.read(&mut bytes) {
                if read == 0 {
                    break;
                }
                if first_output {
                    first_output = false;
                    operations::mark_operation_stage(&project, &operation_id, "first_output");
                }
                pending.extend_from_slice(&bytes[..read]);
                append_utf8(&project, &operation_id, stream, &mut pending, false, true);
            }
            append_utf8(&project, &operation_id, stream, &mut pending, true, true);
        })
        .ok()
}

#[cfg_attr(not(test), allow(dead_code))]
pub(in crate::agent_runs) fn append_valid_utf8(
    project: &str,
    operation_id: &str,
    stream: &str,
    pending: &mut Vec<u8>,
    flush_incomplete: bool,
) {
    append_utf8(project, operation_id, stream, pending, flush_incomplete, false);
}

fn append_utf8(
    project: &str,
    operation_id: &str,
    stream: &str,
    pending: &mut Vec<u8>,
    flush_incomplete: bool,
    keep_raw: bool,
) {
    let emit = |text: &str| {
        let redacted = crate::redact::text(text);
        if keep_raw {
            record_raw(project, operation_id, stream, redacted.as_str());
        }
        transcript::append(project, operation_id, stream, &redacted);
    };
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                if !text.is_empty() {
                    emit(text);
                }
                pending.clear();
                return;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    let text = std::str::from_utf8(&pending[..valid]).unwrap_or_default();
                    emit(text);
                    pending.drain(..valid);
                }
                match error.error_len() {
                    Some(length) => {
                        emit("\u{fffd}");
                        pending.drain(..length.min(pending.len()));
                    }
                    None if flush_incomplete => {
                        if !pending.is_empty() {
                            emit("\u{fffd}");
                            pending.clear();
                        }
                        return;
                    }
                    None => return,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_stream_keeps_the_start_and_the_end_of_a_long_output() {
        let mut raw = RawStream::default();
        raw.push_capped("first-line\n", 16, 32);
        for index in 0..100 {
            raw.push_capped(&format!("chunk-{index:03}\n"), 16, 32);
        }
        let text = raw.text();
        assert!(text.starts_with("first-line\n"), "{text}");
        assert!(text.ends_with("chunk-099\n"), "{text}");
        assert!(text.len() <= 16 + 32 + 16, "{} bytes", text.len());
    }

    #[test]
    fn the_first_event_survives_more_than_the_transcript_window() {
        let project = std::env::temp_dir().join(format!("pm-raw-out-{}", uuid::Uuid::new_v4()));
        let path = project.to_string_lossy().into_owned();
        let id = "op-raw-long";
        let mut pending = br#"{"type":"system","session_id":"sess-first"}"#.to_vec();
        pending.push(b'\n');
        append_utf8(&path, id, "stdout", &mut pending, false, true);
        for index in 0..500 {
            let mut line = format!("{{\"type\":\"assistant\",\"n\":{index}}}\n").into_bytes();
            append_utf8(&path, id, "stdout", &mut line, false, true);
        }
        let all = stream_text(&path, id, "stdout");
        assert!(all.contains("sess-first"), "the first event must still be readable");
        let windowed = transcript::read(&path, id, 0).unwrap();
        assert!(
            !windowed.chunks.iter().any(|chunk| chunk.text.contains("sess-first")),
            "control: the transcript window dropped it"
        );
        forget_raw(&path, id);
        let _ = std::fs::remove_dir_all(project);
    }
}
