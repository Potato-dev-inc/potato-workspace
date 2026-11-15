//! The chain: gates in order, the first one that can tell wins, the rules are always last. A gate that breaks
//! can never make the bot go silent for good: the worst case is the rules. (fishd `makeGate`.)

use std::sync::Arc;

use super::gate::{Gate, GateInput};
use super::heuristic::HeuristicGate;

/// Which links the person chose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Rules only; no model is ever asked.
    Heuristic,
    /// The person's own model, then the rules.
    Llm,
    /// The hosted judge (held back, so it adds nothing today), then the model, then the rules.
    Chain,
}

/// The answer and who gave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub speak: bool,
    pub by: String,
}

pub struct Chain {
    links: Vec<Arc<dyn Gate>>,
}

impl Chain {
    /// Rules only.
    #[cfg(test)]
    pub fn rules() -> Self {
        Self { links: vec![Arc::new(HeuristicGate)] }
    }

    /// Builds the chain for a choice. `jev` is always `None` in the app (held back); `llm` is `None` when the
    /// person has no model saved, and then that link is simply missing.
    pub fn build(choice: Choice, jev: Option<Arc<dyn Gate>>, llm: Option<Arc<dyn Gate>>) -> Self {
        let mut links: Vec<Arc<dyn Gate>> = Vec::new();
        if choice == Choice::Chain {
            links.extend(jev);
        }
        if matches!(choice, Choice::Llm | Choice::Chain) {
            links.extend(llm);
        }
        links.push(Arc::new(HeuristicGate));
        Self { links }
    }

    /// The names of the links, in the order they are asked.
    #[cfg(test)]
    pub fn names(&self) -> Vec<String> {
        self.links.iter().map(|g| g.name().to_string()).collect()
    }

    pub fn decide(&self, input: &GateInput) -> Decision {
        for link in &self.links {
            if let Some(speak) = link.judge(input) {
                return Decision { speak, by: link.name().to_string() };
            }
        }
        // Unreachable while the rules are last, but never speak on a chain that somehow gave no answer.
        Decision { speak: false, by: "none".into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::social::gate::GateMessage;
    use crate::companion::social::llm::{CompleteError, Completer, LlmGate};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct Fake {
        name: &'static str,
        answer: Option<bool>,
        calls: AtomicUsize,
    }

    impl Fake {
        fn new(name: &'static str, answer: Option<bool>) -> Arc<Self> {
            Arc::new(Self { name, answer, calls: AtomicUsize::new(0) })
        }
    }

    impl Gate for Fake {
        fn name(&self) -> &str {
            self.name
        }
        fn judge(&self, _input: &GateInput) -> Option<bool> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.answer
        }
    }

    fn input() -> GateInput {
        GateInput {
            messages: vec![GateMessage { author: "a".into(), text: "hey Mochi are you there".into(), ..Default::default() }],
            names: vec!["mochi".into()],
            now_ms: 600_000,
            base: 0.3,
            ..Default::default()
        }
    }

    #[test]
    fn the_first_link_that_can_tell_wins_and_later_ones_are_not_asked() {
        let jev = Fake::new("jev", Some(false));
        let llm = Fake::new("llm", Some(true));
        let chain = Chain::build(Choice::Chain, Some(jev.clone()), Some(llm.clone()));
        assert_eq!(chain.names(), vec!["jev", "llm", "heuristic"]);
        assert_eq!(chain.decide(&input()), Decision { speak: false, by: "jev".into() });
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_link_that_cannot_tell_hands_over_to_the_next() {
        let jev = Fake::new("jev", None);
        let llm = Fake::new("llm", None);
        let chain = Chain::build(Choice::Chain, Some(jev.clone()), Some(llm.clone()));
        // The name is in the text, so the rules say yes.
        assert_eq!(chain.decide(&input()), Decision { speak: true, by: "heuristic".into() });
        assert_eq!((jev.calls.load(Ordering::SeqCst), llm.calls.load(Ordering::SeqCst)), (1, 1));
    }

    #[test]
    fn the_choice_decides_which_links_exist_and_the_hosted_judge_is_never_added_without_a_client() {
        let llm = Fake::new("llm", Some(true));
        let jev = Fake::new("jev", Some(true));
        assert_eq!(Chain::build(Choice::Heuristic, Some(jev.clone()), Some(llm.clone())).names(), vec!["heuristic"]);
        assert_eq!(Chain::build(Choice::Llm, Some(jev.clone()), Some(llm.clone())).names(), vec!["llm", "heuristic"]);
        assert_eq!(Chain::build(Choice::Chain, None, Some(llm)).names(), vec!["llm", "heuristic"]);
        assert_eq!(Chain::build(Choice::Llm, None, None).names(), vec!["heuristic"]);
        assert_eq!(Chain::rules().names(), vec!["heuristic"]);
    }

    struct Failing(CompleteError);
    impl Completer for Failing {
        fn complete(&self, _prompt: &str, _timeout: Duration) -> Result<String, CompleteError> {
            Err(self.0)
        }
    }

    struct Says(&'static str);
    impl Completer for Says {
        fn complete(&self, _prompt: &str, _timeout: Duration) -> Result<String, CompleteError> {
            Ok(self.0.to_string())
        }
    }

    #[test]
    fn the_chain_falls_through_on_timeout_http_error_and_bad_answer() {
        for completer in [Arc::new(Failing(CompleteError::Timeout)) as Arc<dyn Completer>, Arc::new(Failing(CompleteError::Http(503))), Arc::new(Says("hmm, hard to say"))] {
            let llm: Arc<dyn Gate> = Arc::new(LlmGate::new("llm:fake", completer));
            let chain = Chain::build(Choice::Llm, None, Some(llm));
            let decision = chain.decide(&input());
            assert_eq!(decision.by, "heuristic");
            assert!(decision.speak);
        }
        // And a good answer is taken as it comes.
        let llm: Arc<dyn Gate> = Arc::new(LlmGate::new("llm:fake", Arc::new(Says("NO"))));
        assert_eq!(Chain::build(Choice::Llm, None, Some(llm)).decide(&input()), Decision { speak: false, by: "llm:fake".into() });
    }
}
