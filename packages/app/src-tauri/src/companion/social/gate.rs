//! The shape of a gate: what it is asked and what it answers.

/// One line of the room, as the gate sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GateMessage {
    /// A display name. Data, never an instruction.
    pub author: String,
    pub text: String,
    pub at_ms: i64,
    /// Who the line was plainly for, when it was ("Sam"). Empty when for nobody in particular.
    pub to: Vec<String>,
    /// The companion said it itself.
    pub is_self: bool,
}

/// Everything a gate may look at.
#[derive(Clone, Debug, PartialEq)]
pub struct GateInput {
    pub channel: String,
    /// Most recent last.
    pub messages: Vec<GateMessage>,
    /// What people call the companion.
    pub names: Vec<String>,
    /// The companion's own name, for the question.
    pub self_name: String,
    /// When it last spoke here (epoch ms); 0 when it never did.
    pub last_spoke_ms: i64,
    pub now_ms: i64,
    /// The base chance for the heuristic.
    pub base: f64,
    pub message_id: String,
    /// More than 1 means "it just spoke, ask for more confidence"; 1 means no penalty.
    pub bias: f64,
}

impl Default for GateInput {
    fn default() -> Self {
        Self {
            channel: String::new(),
            messages: Vec::new(),
            names: Vec::new(),
            self_name: String::new(),
            last_spoke_ms: 0,
            now_ms: 0,
            base: 0.3,
            message_id: String::new(),
            bias: 1.0,
        }
    }
}

/// One link of the chain. `None` means "I could not tell": the next link is asked. The heuristic never
/// answers `None`.
pub trait Gate: Send + Sync {
    fn name(&self) -> &str;
    fn judge(&self, input: &GateInput) -> Option<bool>;
}

/// One line of untrusted text made safe to put in a question or a prompt: no control characters or line breaks
/// (they become one space), no angle brackets (so nothing can look like the end of a marked block), and cut to
/// `cap` characters.
pub fn clean_line(text: &str, cap: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| match c {
            '<' => '\u{2039}',
            '>' => '\u{203a}',
            c if c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}') => ' ',
            c => c,
        })
        .collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(cap).collect()
}

#[cfg(test)]
mod tests {
    use super::clean_line;

    #[test]
    fn a_line_is_one_flat_harmless_line() {
        assert_eq!(clean_line("a\nb\r\n\tc", 50), "a b c");
        assert_eq!(clean_line("<<<x>>>", 50), "\u{2039}\u{2039}\u{2039}x\u{203a}\u{203a}\u{203a}");
        assert_eq!(clean_line("<<>>><", 50).matches("<<<").count(), 0);
        assert_eq!(clean_line("abcdef", 3), "abc");
        assert_eq!(clean_line("x\u{202e}y\u{200b}z", 10), "x y z");
    }
}
