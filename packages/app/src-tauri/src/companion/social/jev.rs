//! JEV: the decision formula of a hosted judge that answers with probabilities (fishd `JevGate`).
//!
//! HELD BACK (decision D2 of the plan). A hosted judge would be sent the last ten lines of a Discord room, which
//! is a third party. So this file holds the pure formula and a trait for "something that gives two numbers", and
//! nothing else: there is no client, no address, no key lookup and no way to build one. `real_client` says none.
//! The Discord card does not list it. It can only be turned on in code, after the service terms are checked and
//! the founder agrees.

use super::gate::{Gate, GateInput};

/// What the judge answers: how likely it is that it should speak, and that the last line was for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Answer {
    pub speak: f64,
    pub to_me: f64,
}

/// Something that gives an `Answer` for a room. Nothing in the app implements this for a real service.
pub trait Judge: Send + Sync {
    fn ask(&self, input: &GateInput) -> Option<Answer>;
}

/// The only judge the app can build today: none.
pub fn real_client() -> Option<Box<dyn Judge>> {
    None
}

/// The knobs, with the README numbers as defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Knobs {
    pub threshold: f64,
    /// Willingness to talk; 2.0 means "at half the confidence".
    pub talk: f64,
    /// How much being addressed lowers the bar.
    pub to_me_bonus: f64,
    /// How much talking to somebody else raises it.
    pub not_me_penalty: f64,
}

impl Default for Knobs {
    fn default() -> Self {
        Self { threshold: 0.32, talk: 1.0, to_me_bonus: 0.5, not_me_penalty: 0.35 }
    }
}

/// `clamp(base / talk, 0.02, 0.95)`: it can never reach 0 (always talks) or 1 (never talks).
pub fn scaled_threshold(base: f64, talk: f64) -> f64 {
    let factor = if talk.is_finite() && talk > 0.0 { talk } else { 1.0 };
    (base / factor).clamp(0.02, 0.95)
}

/// The bar the probability is held against.
///
/// `factor = max(0.25, 1 + bonus * to_me - penalty * (1 - to_me))`, `bar = scaled * max(1, bias) / factor`.
pub fn bar(knobs: &Knobs, to_me: f64, bias: f64) -> f64 {
    let factor = (1.0 + knobs.to_me_bonus * to_me - knobs.not_me_penalty * (1.0 - to_me)).max(0.25);
    scaled_threshold(knobs.threshold, knobs.talk) * bias.max(1.0) / factor
}

/// Speak when the probability reaches the bar.
pub fn decide(knobs: &Knobs, answer: Answer, bias: f64) -> bool {
    answer.speak >= bar(knobs, answer.to_me.clamp(0.0, 1.0), bias)
}

pub struct JevGate {
    judge: Box<dyn Judge>,
    knobs: Knobs,
}

impl JevGate {
    pub fn new(judge: Box<dyn Judge>, knobs: Knobs) -> Self {
        Self { judge, knobs }
    }
}

impl Gate for JevGate {
    fn name(&self) -> &str {
        "jev"
    }

    fn judge(&self, input: &GateInput) -> Option<bool> {
        let answer = self.judge.ask(input)?;
        if answer.speak.is_nan() {
            return None;
        }
        Some(decide(&self.knobs, Answer { speak: answer.speak, to_me: if answer.to_me.is_nan() { 0.0 } else { answer.to_me } }, input.bias))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_readme_numbers_come_out() {
        let k = Knobs::default();
        // Base 0.32 with nobody addressed: factor = 1 - 0.35 = 0.65.
        assert!((scaled_threshold(0.32, 1.0) - 0.32).abs() < 1e-12);
        // To me 0.8: factor 1.33, bar about 0.24.
        let addressed = bar(&k, 0.8, 1.0);
        assert!((addressed - 0.2406).abs() < 0.001, "{addressed}");
        // Aimed at somebody else (bias 2.5) with the same factor: about 0.6.
        let aimed = bar(&k, 0.8, 2.5);
        assert!((aimed - 0.6015).abs() < 0.001, "{aimed}");
    }

    #[test]
    fn talk_scales_the_bar_and_is_clamped() {
        assert!((scaled_threshold(0.32, 2.0) - 0.16).abs() < 1e-12);
        assert_eq!(scaled_threshold(0.32, 1000.0), 0.02);
        assert_eq!(scaled_threshold(0.9, 0.5), 0.95);
        assert_eq!(scaled_threshold(0.32, 0.0), 0.32);
        assert_eq!(scaled_threshold(0.32, f64::NAN), 0.32);
    }

    #[test]
    fn the_factor_never_goes_below_a_quarter_and_a_bias_below_one_is_ignored() {
        let k = Knobs { not_me_penalty: 5.0, ..Knobs::default() };
        assert!((bar(&k, 0.0, 1.0) - 0.32 / 0.25).abs() < 1e-12);
        assert_eq!(bar(&Knobs::default(), 0.5, 0.1), bar(&Knobs::default(), 0.5, 1.0));
    }

    #[test]
    fn the_answer_is_held_against_the_bar() {
        let k = Knobs::default();
        assert!(decide(&k, Answer { speak: 0.25, to_me: 0.8 }, 1.0));
        assert!(!decide(&k, Answer { speak: 0.25, to_me: 0.8 }, 2.5));
        assert!(decide(&k, Answer { speak: 0.7, to_me: 0.8 }, 2.5));
    }

    struct Fixed(Option<Answer>);
    impl Judge for Fixed {
        fn ask(&self, _input: &GateInput) -> Option<Answer> {
            self.0
        }
    }

    #[test]
    fn a_missing_or_nan_answer_means_could_not_tell() {
        let none = JevGate::new(Box::new(Fixed(None)), Knobs::default());
        assert_eq!(none.judge(&GateInput::default()), None);
        let nan = JevGate::new(Box::new(Fixed(Some(Answer { speak: f64::NAN, to_me: 0.5 }))), Knobs::default());
        assert_eq!(nan.judge(&GateInput::default()), None);
        let ok = JevGate::new(Box::new(Fixed(Some(Answer { speak: 0.9, to_me: f64::NAN }))), Knobs::default());
        assert_eq!(ok.judge(&GateInput::default()), Some(true));
    }

    #[test]
    fn nothing_can_build_a_real_judge_and_no_source_names_a_hosted_service() {
        assert!(real_client().is_none());
        // Built from pieces so this file does not hold the address itself.
        let host = ["opencode", ".ai"].concat();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("companion");
        let mut todo = vec![dir.join("social"), dir.join("brain"), std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("discord_bot")];
        while let Some(next) = todo.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    todo.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    assert!(!text.contains(&host), "{} names the hosted judge", path.display());
                }
            }
        }
    }
}
