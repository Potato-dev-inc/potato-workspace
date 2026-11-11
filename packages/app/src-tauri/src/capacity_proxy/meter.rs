//! Counts usage from a reply. The meter is chosen by protocol shape, never by agent name.

/// Watches reply bytes and reports (input, output) tokens at the end.
pub trait Meter: Send {
    fn feed(&mut self, bytes: &[u8]);
    fn finish(&mut self) -> (u64, u64);
}

/// The meter for a protocol shape and reply content type, or none when the shape is unknown.
pub fn for_shape(shape: &str, content_type: &str) -> Option<Box<dyn Meter>> {
    match shape {
        "anthropic_messages_sse" => {
            let ct = content_type.to_ascii_lowercase();
            if ct.contains("text/event-stream") {
                Some(Box::new(SseMeter::default()))
            } else if ct.contains("json") {
                Some(Box::new(JsonMeter::default()))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn read_usage(usage: &serde_json::Value, input: &mut u64, output: &mut u64) {
    if let Some(n) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
        *input = (*input).max(n);
    }
    if let Some(n) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
        *output = (*output).max(n);
    }
}

/// The most one line (or one buffered JSON reply) may take.
const MAX_LINE: usize = 1024 * 1024;

/// Server-sent events: `data:` lines carry JSON with `usage` at `.message.usage` or `.usage`.
#[derive(Default)]
struct SseMeter {
    line: Vec<u8>,
    input: u64,
    output: u64,
}

impl SseMeter {
    fn line_done(&mut self) {
        let line = std::mem::take(&mut self.line);
        let line = line.strip_suffix(b"\r").unwrap_or(&line);
        let Some(rest) = line.strip_prefix(b"data:") else { return };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(rest.trim_ascii()) else { return };
        if let Some(u) = value.pointer("/message/usage") {
            read_usage(u, &mut self.input, &mut self.output);
        }
        if let Some(u) = value.get("usage") {
            read_usage(u, &mut self.input, &mut self.output);
        }
    }
}

impl Meter for SseMeter {
    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if b == b'\n' {
                self.line_done();
            } else if self.line.len() < MAX_LINE {
                self.line.push(b);
            }
        }
    }

    fn finish(&mut self) -> (u64, u64) {
        if !self.line.is_empty() {
            self.line_done();
        }
        (self.input, self.output)
    }
}

/// A non-streaming reply: buffer it (up to 1 MiB) and read `.usage` at the end.
#[derive(Default)]
struct JsonMeter {
    buf: Vec<u8>,
}

impl Meter for JsonMeter {
    fn feed(&mut self, bytes: &[u8]) {
        let room = MAX_LINE.saturating_sub(self.buf.len());
        self.buf.extend_from_slice(&bytes[..bytes.len().min(room)]);
    }

    fn finish(&mut self) -> (u64, u64) {
        let (mut input, mut output) = (0, 0);
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&self.buf) {
            if let Some(u) = value.get("usage") {
                read_usage(u, &mut input, &mut output);
            }
        }
        (input, output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SSE: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"output_tokens\":1}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":42}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    fn sse() -> Box<dyn Meter> {
        for_shape("anthropic_messages_sse", "text/event-stream; charset=utf-8").unwrap()
    }

    #[test]
    fn sse_usage_in_one_piece() {
        let mut m = sse();
        m.feed(SSE.as_bytes());
        assert_eq!(m.finish(), (25, 42));
    }

    #[test]
    fn sse_lines_split_across_chunks_one_byte_at_a_time() {
        let mut m = sse();
        for b in SSE.as_bytes() {
            m.feed(&[*b]);
        }
        assert_eq!(m.finish(), (25, 42));
    }

    #[test]
    fn sse_with_crlf_and_no_final_newline() {
        let text = SSE.replace('\n', "\r\n");
        let text = text.trim_end();
        let mut m = sse();
        for part in text.as_bytes().chunks(7) {
            m.feed(part);
        }
        assert_eq!(m.finish(), (25, 42));
    }

    #[test]
    fn sse_ignores_junk_and_keeps_the_largest() {
        let mut m = sse();
        m.feed(b"data: not json\n: comment\ndata: {\"usage\":{\"output_tokens\":9}}\ndata: {\"usage\":{\"output_tokens\":3}}\n");
        assert_eq!(m.finish(), (0, 9));
    }

    #[test]
    fn json_reply_usage() {
        let mut m = for_shape("anthropic_messages_sse", "application/json").unwrap();
        m.feed(b"{\"id\":\"x\",\"usage\":{\"input_");
        m.feed(b"tokens\":11,\"output_tokens\":7}}");
        assert_eq!(m.finish(), (11, 7));
    }

    #[test]
    fn json_reply_without_usage_or_bad_json() {
        let mut m = for_shape("anthropic_messages_sse", "application/json").unwrap();
        m.feed(b"{\"error\":{}}");
        assert_eq!(m.finish(), (0, 0));
        let mut m = for_shape("anthropic_messages_sse", "application/json").unwrap();
        m.feed(b"<html>");
        assert_eq!(m.finish(), (0, 0));
    }

    #[test]
    fn unknown_shape_or_type_has_no_meter() {
        assert!(for_shape("something_else", "text/event-stream").is_none());
        assert!(for_shape("anthropic_messages_sse", "text/plain").is_none());
    }
}
