//! Who is using the page now, and what the person has said about it (N5-23).
//!
//! The agent drives; the person can take over at any moment. The rules, all pure and tested:
//! - An agent step is refused while the person has the page (`PAUSED_BY_PERSON` / `STOPPED_BY_PERSON`).
//! - A click or key press by the person while the agent is driving pauses the agent. The agent's own clicks are
//!   also "trusted" events in the page, so a step records when it ran, and input in that time (plus a short tail)
//!   is not the person's.
//! - The person gives the page back with one button. Until then the agent waits.
//! - The bar goes away by itself a little after the last step.
//! - Every step has a short line for the step list and the audit log. The line names the thing clicked, never a
//!   typed text.

use serde::Serialize;
use std::collections::VecDeque;

/// Steps kept for the list under the page.
pub const KEEP_STEPS: usize = 30;
/// After a step ends, page input in this many ms still counts as the agent's own (the page reacts late).
pub const TAIL_MS: u64 = 500;
/// The bar hides this long after the last step.
pub const IDLE_HIDE_MS: u64 = 12_000;
/// Longest step line.
const MAX_STEP_CHARS: usize = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Nobody is using the page.
    Idle,
    Driving,
    /// The person has the page. `stopped` is true when they pressed Stop (the agent should not come back).
    Paused { stopped: bool },
}

/// Why a step was not allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub message: &'static str,
}

pub const PAUSED: Refused = Refused {
    code: "PAUSED_BY_PERSON",
    message: "The person took over this page. Do not try again now: wait. They press Give back when you may go on.",
};
pub const STOPPED: Refused = Refused {
    code: "STOPPED_BY_PERSON",
    message: "The person pressed Stop on the browser. Do not use the browser again unless they ask you to.",
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    pub n: u32,
    pub text: String,
}

/// What the bar shows. Words that come from the page (step lines) are drawn as plain text by the bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BarView {
    pub visible: bool,
    /// `driving` or `paused`.
    pub state: String,
    /// `stopped` or `took_over` while paused.
    pub reason: String,
    pub agent: String,
    pub steps: Vec<Step>,
}

impl BarView {
    pub fn hidden() -> Self {
        BarView { visible: false, state: String::new(), reason: String::new(), agent: String::new(), steps: Vec::new() }
    }
}

#[derive(Debug)]
pub struct Driver {
    agent: String,
    phase: Phase,
    steps: VecDeque<Step>,
    next_n: u32,
    last_step_ms: u64,
    /// When steps ran: (start, end). `end` is 0 while the step is running.
    ran: VecDeque<(u64, u64)>,
}

impl Default for Driver {
    fn default() -> Self {
        Driver { agent: String::new(), phase: Phase::Idle, steps: VecDeque::new(), next_n: 1, last_step_ms: 0, ran: VecDeque::new() }
    }
}

fn short(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= MAX_STEP_CHARS {
        return one;
    }
    format!("{}\u{2026}", one.chars().take(MAX_STEP_CHARS - 1).collect::<String>())
}

impl Driver {
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// An agent wants to run a step. `Ok(step number)` when it may; the caller must call `finish` after.
    pub fn begin(&mut self, agent: &str, text: &str, now: u64) -> Result<u32, Refused> {
        match self.phase {
            Phase::Paused { stopped: true } => return Err(STOPPED),
            Phase::Paused { stopped: false } => return Err(PAUSED),
            Phase::Idle | Phase::Driving => {}
        }
        if self.phase == Phase::Idle {
            // A new turn of work: the list starts again.
            self.steps.clear();
        }
        self.phase = Phase::Driving;
        self.agent = agent.to_string();
        self.last_step_ms = now;
        let n = self.next_n;
        self.next_n += 1;
        self.steps.push_back(Step { n, text: short(text) });
        while self.steps.len() > KEEP_STEPS {
            self.steps.pop_front();
        }
        self.ran.push_back((now, 0));
        while self.ran.len() > 12 {
            self.ran.pop_front();
        }
        Ok(n)
    }

    /// The step ended. `result` replaces the line (for example "Clicked Save"); None keeps the line as it was.
    pub fn finish(&mut self, n: u32, result: Option<&str>, now: u64) {
        if let Some(step) = self.steps.iter_mut().find(|s| s.n == n) {
            if let Some(text) = result {
                step.text = short(text);
            }
        }
        if let Some(slot) = self.ran.iter_mut().rev().find(|(_, end)| *end == 0) {
            slot.1 = now;
        }
        self.last_step_ms = now;
    }

    fn agent_was_acting(&self, at: u64) -> bool {
        self.ran.iter().any(|&(start, end)| at >= start && (end == 0 || at <= end + TAIL_MS))
    }

    /// A click or key press the person made in the page at `at` (page clock). True when it paused the agent.
    pub fn person_input(&mut self, at: u64) -> bool {
        if self.phase != Phase::Driving || self.agent_was_acting(at) {
            return false;
        }
        self.phase = Phase::Paused { stopped: false };
        true
    }

    /// The person pressed "Take over".
    pub fn take_over(&mut self) {
        if self.phase != Phase::Idle {
            self.phase = Phase::Paused { stopped: false };
        }
    }

    /// The person pressed "Stop".
    pub fn stop(&mut self) {
        self.phase = Phase::Paused { stopped: true };
    }

    /// The person pressed "Give back".
    pub fn give_back(&mut self, now: u64) {
        if matches!(self.phase, Phase::Paused { .. }) {
            self.phase = Phase::Driving;
            self.last_step_ms = now;
        }
    }

    /// Whether the bar should still be there, and what it says.
    pub fn view(&mut self, now: u64) -> BarView {
        if self.phase == Phase::Driving && now.saturating_sub(self.last_step_ms) > IDLE_HIDE_MS {
            self.phase = Phase::Idle;
        }
        match self.phase {
            Phase::Idle => BarView::hidden(),
            Phase::Driving => BarView { visible: true, state: "driving".into(), reason: String::new(), agent: self.agent.clone(), steps: self.steps.iter().cloned().collect() },
            Phase::Paused { stopped } => BarView {
                visible: true,
                state: "paused".into(),
                reason: if stopped { "stopped" } else { "took_over" }.into(),
                agent: self.agent.clone(),
                steps: self.steps.iter().cloned().collect(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn driving(d: &mut Driver, now: u64) -> u32 {
        d.begin("Claude Code", "Opened the page", now).unwrap()
    }

    #[test]
    fn a_step_shows_the_bar_with_the_agent_and_the_list() {
        let mut d = Driver::default();
        assert!(!d.view(0).visible);
        let n = driving(&mut d, 1_000);
        d.finish(n, Some("Clicked Save"), 1_100);
        let view = d.view(1_200);
        assert!(view.visible && view.state == "driving" && view.agent == "Claude Code");
        assert_eq!(view.steps, vec![Step { n: 1, text: "Clicked Save".into() }]);
    }

    #[test]
    fn the_bar_goes_away_a_while_after_the_last_step_and_the_next_turn_starts_a_new_list() {
        let mut d = Driver::default();
        let n = driving(&mut d, 1_000);
        d.finish(n, None, 1_050);
        assert!(d.view(1_000 + IDLE_HIDE_MS).visible);
        assert!(!d.view(1_050 + IDLE_HIDE_MS + 1).visible);
        d.begin("Codex", "Read the page", 90_000).unwrap();
        let view = d.view(90_001);
        assert_eq!(view.steps.len(), 1);
        assert_eq!(view.agent, "Codex");
    }

    #[test]
    fn a_click_by_the_person_pauses_the_agent_and_the_next_step_is_refused() {
        let mut d = Driver::default();
        let n = driving(&mut d, 1_000);
        d.finish(n, None, 1_100);
        // 2 seconds later the person clicks in the page.
        assert!(d.person_input(3_100));
        assert_eq!(d.phase(), Phase::Paused { stopped: false });
        assert_eq!(d.begin("Claude Code", "Click", 3_200).unwrap_err(), PAUSED);
        let view = d.view(3_300);
        assert!(view.visible && view.state == "paused" && view.reason == "took_over");
        d.give_back(4_000);
        assert!(d.begin("Claude Code", "Click", 4_100).is_ok());
    }

    #[test]
    fn the_agents_own_clicks_do_not_pause_it() {
        let mut d = Driver::default();
        let n = driving(&mut d, 1_000);
        // Input while the step runs, and a little after it ended: the agent's own.
        assert!(!d.person_input(1_050));
        d.finish(n, None, 1_200);
        assert!(!d.person_input(1_200 + TAIL_MS));
        assert_eq!(d.phase(), Phase::Driving);
        // Later than the tail: the person's.
        assert!(d.person_input(1_200 + TAIL_MS + 100));
    }

    #[test]
    fn a_click_just_before_the_next_step_started_is_the_persons_not_the_agents() {
        let mut d = Driver::default();
        let n = driving(&mut d, 1_000);
        d.finish(n, None, 1_200);
        // The person clicks at 1900; the agent's next step only begins at 1905 (the bar loop looks a little later).
        d.begin("Claude Code", "Read the page", 1_905).unwrap();
        assert!(d.person_input(1_900));
        assert_eq!(d.phase(), Phase::Paused { stopped: false });
    }

    #[test]
    fn input_when_nobody_is_driving_changes_nothing() {
        let mut d = Driver::default();
        assert!(!d.person_input(5_000));
        assert_eq!(d.phase(), Phase::Idle);
    }

    #[test]
    fn stop_is_firmer_than_take_over_and_only_give_back_lifts_both() {
        let mut d = Driver::default();
        driving(&mut d, 1_000);
        d.stop();
        assert_eq!(d.begin("Claude Code", "x", 1_100).unwrap_err(), STOPPED);
        assert_eq!(d.view(1_200).reason, "stopped");
        d.give_back(2_000);
        assert!(d.begin("Claude Code", "x", 2_100).is_ok());
        d.take_over();
        assert_eq!(d.begin("Claude Code", "x", 2_200).unwrap_err(), PAUSED);
        // Taking over a page nobody drives does nothing.
        let mut idle = Driver::default();
        idle.take_over();
        assert_eq!(idle.phase(), Phase::Idle);
    }

    #[test]
    fn the_list_is_short_and_each_line_is_short() {
        let mut d = Driver::default();
        for i in 0..(KEEP_STEPS + 10) {
            let n = d.begin("A", &format!("Step {i} {}", "x".repeat(300)), 1_000 + i as u64).unwrap();
            d.finish(n, None, 1_000 + i as u64);
        }
        let view = d.view(1_100);
        assert_eq!(view.steps.len(), KEEP_STEPS);
        assert_eq!(view.steps.last().unwrap().n as usize, KEEP_STEPS + 10);
        assert!(view.steps.iter().all(|s| s.text.chars().count() <= MAX_STEP_CHARS));
    }
}
