//! The rules gate. Pure and deterministic per message id, so the same room always replays the same way. Biased
//! hard toward silence. Ported from fishd `ambientChime` and `hash.ts`.

use once_cell::sync::Lazy;
use regex::Regex;

use super::gate::{Gate, GateInput};

/// Shorter than this many characters is never worth joining in on.
pub const MIN_CHARS: usize = 4;
/// Right after it spoke it stays quiet this long, unless somebody called it by name.
pub const COOLDOWN_MS: i64 = 45_000;
const MAX_CHANCE: f64 = 0.85;

static QUESTION: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)[?？]|嗎|呢|什麼|怎麼|為什麼|要不要|是不是|\b(?:what|why|how|who|when|where|anyone|should)\b").expect("question")
});

/// FNV-1a over the UTF-16 units of the text (what fishd does), so a seed is the same everywhere.
pub fn seed_of(input: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for unit in input.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// A float in [0, 1) from a seed (xorshift32, as fishd does).
pub fn rand01(seed: u32) -> f64 {
    let mut x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    f64::from(x) / 4_294_967_296.0
}

/// What the rules say before any dice are rolled.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Plan {
    /// Never join in.
    Never,
    /// Always (it was called by name).
    Always,
    /// Join in with this chance.
    Chance(f64),
}

/// The rules, without the dice. The last line of the room is the one judged.
pub fn plan(input: &GateInput) -> Plan {
    let Some(last) = input.messages.last() else { return Plan::Never };
    let prev = input.messages.len().checked_sub(2).and_then(|i| input.messages.get(i));
    let base = input.base / input.bias.max(1.0);
    if base <= 0.0 {
        return Plan::Never;
    }
    let chars = last.text.chars().count();
    if chars < MIN_CHARS {
        return Plan::Never;
    }
    let lower = last.text.to_lowercase();
    if input.names.iter().any(|n| !n.is_empty() && lower.contains(&n.to_lowercase())) {
        return Plan::Always;
    }
    if input.now_ms - input.last_spoke_ms < COOLDOWN_MS {
        return Plan::Never;
    }
    let mut score = 1.0;
    if QUESTION.is_match(&last.text) {
        score += 0.55;
    }
    if chars > 12 {
        score += 0.1;
    }
    if prev.is_some_and(|p| p.author != last.author) {
        score -= 0.15;
    }
    Plan::Chance((base * score).min(MAX_CHANCE))
}

/// Should the companion join in? Same input, same answer.
pub fn chime(input: &GateInput) -> bool {
    match plan(input) {
        Plan::Never => false,
        Plan::Always => true,
        Plan::Chance(p) => rand01(seed_of(&input.message_id)) < p,
    }
}

/// The rules as the last link of a chain.
pub struct HeuristicGate;

impl Gate for HeuristicGate {
    fn name(&self) -> &str {
        "heuristic"
    }
    fn judge(&self, input: &GateInput) -> Option<bool> {
        Some(chime(input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::social::gate::GateMessage;

    fn msg(author: &str, text: &str) -> GateMessage {
        GateMessage { author: author.into(), text: text.into(), at_ms: 0, ..Default::default() }
    }

    fn input(messages: Vec<GateMessage>) -> GateInput {
        GateInput { messages, names: vec!["mochi".into()], now_ms: 10 * 60_000, base: 0.5, message_id: "m1".into(), ..Default::default() }
    }

    #[test]
    fn a_short_line_is_never_worth_it() {
        assert_eq!(plan(&input(vec![msg("a", "ok")])), Plan::Never);
        assert_eq!(plan(&input(vec![msg("a", "lol!")])), Plan::Chance(0.5));
        assert!(!chime(&input(vec![msg("a", "hi")])));
    }

    #[test]
    fn being_called_by_name_always_joins_in_even_in_the_cool_down() {
        let mut i = input(vec![msg("a", "hey Mochi what do you think")]);
        i.last_spoke_ms = i.now_ms - 1_000;
        assert_eq!(plan(&i), Plan::Always);
        assert!(chime(&i));
        // An empty name matches nothing.
        let mut j = input(vec![msg("a", "nothing to see here at all")]);
        j.names = vec![String::new()];
        assert_ne!(plan(&j), Plan::Always);
    }

    #[test]
    fn right_after_it_spoke_it_stays_quiet() {
        let mut i = input(vec![msg("a", "this is a perfectly fine line")]);
        i.last_spoke_ms = i.now_ms - (COOLDOWN_MS - 1);
        assert_eq!(plan(&i), Plan::Never);
        i.last_spoke_ms = i.now_ms - COOLDOWN_MS;
        assert!(matches!(plan(&i), Plan::Chance(_)));
    }

    #[test]
    fn a_question_raises_the_chance() {
        let plain = plan(&input(vec![msg("a", "it rained today ok")]));
        let asked = plan(&input(vec![msg("a", "did it rain today?")]));
        let (Plan::Chance(p), Plan::Chance(q)) = (plain, asked) else { panic!("{plain:?} {asked:?}") };
        assert!(q > p, "{q} should be above {p}");
        assert!((q - 0.5 * 1.65).abs() < 1e-9, "{q}");
    }

    #[test]
    fn two_other_people_talking_lowers_the_chance_and_the_chance_is_capped() {
        let alone = plan(&input(vec![msg("a", "a line long enough to count"), msg("a", "another line long enough")]));
        let two = plan(&input(vec![msg("b", "a line long enough to count"), msg("a", "another line long enough")]));
        let (Plan::Chance(p), Plan::Chance(q)) = (alone, two) else { panic!() };
        assert!(q < p);
        let mut high = input(vec![msg("a", "should we go somewhere nice today?")]);
        high.base = 5.0;
        assert_eq!(plan(&high), Plan::Chance(0.85));
    }

    #[test]
    fn a_bias_above_one_makes_it_shyer_and_zero_base_means_never() {
        let mut i = input(vec![msg("a", "a line long enough to count")]);
        i.bias = 2.0;
        let Plan::Chance(p) = plan(&i) else { panic!() };
        assert!((p - 0.25 * 1.1).abs() < 1e-9, "{p}");
        i.base = 0.0;
        assert_eq!(plan(&i), Plan::Never);
        assert_eq!(plan(&input(vec![])), Plan::Never);
    }

    #[test]
    fn the_same_message_id_gives_the_same_verdict_every_time() {
        let mut i = input(vec![msg("a", "a line long enough to count")]);
        for id in ["a", "b", "c", "message-17", "9988776655"] {
            i.message_id = id.into();
            let first = chime(&i);
            for _ in 0..5 {
                assert_eq!(chime(&i), first, "{id}");
            }
        }
    }

    #[test]
    fn different_ids_give_both_answers_and_the_seed_matches_the_fishd_hash() {
        // FNV-1a of "" is its offset basis; of "a" is a known value.
        assert_eq!(seed_of(""), 0x811c_9dc5);
        assert_eq!(seed_of("a"), 0xe40c_292c);
        let mut i = input(vec![msg("a", "a line long enough to count")]);
        i.base = 0.5;
        let verdicts: Vec<bool> = (0..200)
            .map(|n| {
                i.message_id = format!("id-{n}");
                chime(&i)
            })
            .collect();
        let yes = verdicts.iter().filter(|v| **v).count();
        assert!(yes > 40 && yes < 160, "{yes} of 200");
        assert!((0..1000).all(|n| (0.0..1.0).contains(&rand01(seed_of(&n.to_string())))));
    }
}
