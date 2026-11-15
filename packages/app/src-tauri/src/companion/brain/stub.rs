//! A brain for tests: it answers from a list (or a fixed text) and remembers every conversation it was given.

use std::time::Duration;

use parking_lot::Mutex;

use super::{Brain, BrainError, ChatMsg};

pub struct StubBrain {
    answers: Mutex<Vec<Result<String, BrainError>>>,
    fallback: Result<String, BrainError>,
    pub seen: Mutex<Vec<Vec<ChatMsg>>>,
}

impl StubBrain {
    /// Always says `text`.
    pub fn says(text: &str) -> Self {
        Self { answers: Mutex::new(Vec::new()), fallback: Ok(text.to_string()), seen: Mutex::new(Vec::new()) }
    }

    /// Always fails with `error`.
    pub fn fails(error: BrainError) -> Self {
        Self { answers: Mutex::new(Vec::new()), fallback: Err(error), seen: Mutex::new(Vec::new()) }
    }

    /// Answers from the list first, then with the fallback.
    pub fn then(self, answers: Vec<Result<String, BrainError>>) -> Self {
        *self.answers.lock() = answers;
        self
    }

    pub fn calls(&self) -> usize {
        self.seen.lock().len()
    }
}

impl Brain for StubBrain {
    fn complete(&self, messages: &[ChatMsg], _max_tokens: u32, _timeout: Duration) -> Result<String, BrainError> {
        self.seen.lock().push(messages.to_vec());
        let mut answers = self.answers.lock();
        if answers.is_empty() {
            self.fallback.clone()
        } else {
            answers.remove(0)
        }
    }
}
