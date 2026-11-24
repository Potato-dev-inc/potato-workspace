//! Counts usage from a reply. The meter is chosen by protocol shape, never by agent name.

/// Watches reply bytes and reports (input, output) tokens at the end.
pub trait Meter: Send {
    fn feed(&mut self, bytes: &[u8]);
    fn finish(&mut self) -> (u64, u64);
}

/// Where a protocol shape keeps its token counts: the JSON objects (pointers, tried in order) and the field names
/// inside them. Output fields are added together (Gemini counts thinking tokens apart).
#[derive(Clone, Copy)]
struct Usage {
    pointers: &'static [&'static str],
    input: &'static str,
    outputs: &'static [&'static str],
}

const ANTHROPIC: Usage = Usage { pointers: &["/message/usage", "/usage"], input: "input_tokens", outputs: &["output_tokens"] };
const OPENAI_RESPONSES: Usage = Usage { pointers: &["/response/usage", "/usage"], input: "input_tokens", outputs: &["output_tokens"] };
const GEMINI: Usage = Usage { pointers: &["/usageMetadata"], input: "promptTokenCount", outputs: &["candidatesTokenCount", "thoughtsTokenCount"] };

/// The meter for a protocol shape and reply content type, or none when the shape is unknown.
pub fn for_shape(shape: &str, content_type: &str) -> Option<Box<dyn Meter>> {
    let usage = match shape {
        "anthropic_messages_sse" => ANTHROPIC,
        "openai_responses_sse" => OPENAI_RESPONSES,
        "gemini_generate_content" => GEMINI,
        _ => return None,
    };
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("text/event-stream") {
        Some(Box::new(SseMeter { usage, ..SseMeter::default() }))
    } else if ct.contains("json") {
        Some(Box::new(JsonMeter { usage, ..JsonMeter::default() }))
    } else {
        None
    }
}

impl Default for Usage {
    fn default() -> Self {
        ANTHROPIC
    }
}

/// Reads one reply object: the largest count seen so far is kept (a stream repeats a growing total).
fn read_object(value: &serde_json::Value, usage: &Usage, input: &mut u64, output: &mut u64) {
    for pointer in usage.pointers {
        let Some(u) = value.pointer(pointer) else { continue };
        if let Some(n) = u.get(usage.input).and_then(|v| v.as_u64()) {
            *input = (*input).max(n);
        }
        let out: u64 = usage.outputs.iter().filter_map(|k| u.get(*k).and_then(|v| v.as_u64())).sum();
        if usage.outputs.iter().any(|k| u.get(*k).is_some()) {
            *output = (*output).max(out);
        }
    }
}

/// The most one line (or one buffered JSON reply) may take.
const MAX_LINE: usize = 1024 * 1024;

/// Server-sent events: `data:` lines carry JSON with the usage object where the shape keeps it.
#[derive(Default)]
struct SseMeter {
    usage: Usage,
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
        read_object(&value, &self.usage, &mut self.input, &mut self.output);
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
    usage: Usage,
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
            // A streamed JSON array (one object per chunk) is read element by element.
            match value.as_array() {
                Some(items) => items.iter().for_each(|v| read_object(v, &self.usage, &mut input, &mut output)),
                None => read_object(&value, &self.usage, &mut input, &mut output),
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
    fn openai_responses_usage_comes_from_the_completed_event() {
        let text = "event: response.created
data: {\"type\":\"response.created\",\"response\":{\"usage\":null}}

event: response.completed
data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":31,\"output_tokens\":7}}}

";
        let mut m = for_shape("openai_responses_sse", "text/event-stream").unwrap();
        for part in text.as_bytes().chunks(5) {
            m.feed(part);
        }
        assert_eq!(m.finish(), (31, 7));
        let mut m = for_shape("openai_responses_sse", "application/json").unwrap();
        m.feed(b"{\"object\":\"response\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}");
        assert_eq!(m.finish(), (4, 2));
    }

    #[test]
    fn gemini_usage_keeps_the_largest_and_adds_thinking_tokens() {
        let mut m = for_shape("gemini_generate_content", "text/event-stream").unwrap();
        m.feed(b"data: {\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":3}}

");
        m.feed(b"data: {\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":9,\"thoughtsTokenCount\":4}}

");
        assert_eq!(m.finish(), (12, 13));
        // A streamed JSON array (no alt=sse) and a single object.
        let mut m = for_shape("gemini_generate_content", "application/json; charset=UTF-8").unwrap();
        m.feed(b"[{\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":1}},{\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":6}}]");
        assert_eq!(m.finish(), (5, 6));
        let mut m = for_shape("gemini_generate_content", "application/json").unwrap();
        m.feed(b"{\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":8}}");
        assert_eq!(m.finish(), (2, 8));
    }

    #[test]
    fn unknown_shape_or_type_has_no_meter() {
        assert!(for_shape("something_else", "text/event-stream").is_none());
        assert!(for_shape("anthropic_messages_sse", "text/plain").is_none());
    }
}
