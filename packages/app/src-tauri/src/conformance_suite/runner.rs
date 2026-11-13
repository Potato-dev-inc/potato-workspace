//! Runs a conformance vector against a fake target and says Pass, Fail(why) or NotClaimed (SPEC-CHAOS-1113 section 3).
//!
//! The runner drives a real `AcpSession` (real process, real pipes) over the fake agent, collects what each turn did from the
//! session's event log, and checks the vector's `[[expect]]` tables against it.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::rig::{chunks_since, AcpRig};
use super::targets::Target;
use super::vector::{self, Cost, Expect, Level, Outcome, Step, Vector};
use crate::acp::session::SessionEvent;
use crate::acp::state::{StopKind, TurnSummary};
use crate::acp::write_queue::Lane;
use crate::proc_util::pid_alive;

const TURN_LIMIT: Duration = Duration::from_secs(30);

/// One turn as the runner saw it.
struct TurnData {
    session: usize,
    /// Index into the session's event log where the turn started.
    from: usize,
    started: Instant,
    cancelled_at: Option<Instant>,
    /// Index of the `TurnEnded` event, the summary, and when the runner saw it.
    end: Option<(usize, TurnSummary, Instant)>,
}

struct Run {
    rigs: Vec<AcpRig>,
    turns: Vec<TurnData>,
    in_flight: Vec<Option<usize>>,
    refusals: Vec<String>,
    pids: Vec<u32>,
    /// `bad_lines` of each session's connection once it was up (the test harness prints a header line of its own).
    baseline_bad: Vec<Option<u64>>,
    host: Option<crate::acp::fake_agent::Host>,
    failure: Option<String>,
}

impl Run {
    fn note_pid(&mut self, session: usize) {
        if let Some(conn) = self.rigs[session].session.connection() {
            if !self.pids.contains(&conn.pid()) {
                self.pids.push(conn.pid());
            }
            if self.baseline_bad[session].is_none() {
                self.baseline_bad[session] = Some(conn.stats().bad_lines);
            }
        }
    }

    fn start_turn(&mut self, session: usize, text: &str) {
        self.finish_turn(session);
        let rig = &self.rigs[session];
        let from = rig.mark();
        match rig.session.prompt_text(text) {
            Ok(_) => {
                self.turns.push(TurnData { session, from, started: Instant::now(), cancelled_at: None, end: None });
                self.in_flight[session] = Some(self.turns.len() - 1);
                self.note_pid(session);
            }
            Err(error) => {
                self.refusals.push(error.to_string());
                // A turn that never started: it ended at once with no summary.
                self.turns.push(TurnData { session, from, started: Instant::now(), cancelled_at: None, end: None });
            }
        }
    }

    /// Waits for the turn in flight of `session` to end (ticking the session like the supervisor does).
    fn finish_turn(&mut self, session: usize) {
        let Some(index) = self.in_flight[session].take() else { return };
        let deadline = Instant::now() + TURN_LIMIT;
        loop {
            let from = self.turns[index].from;
            let found = self.rigs[session].wait_event(from, |e| matches!(e, SessionEvent::TurnEnded(_)), 0);
            if let Some((at, SessionEvent::TurnEnded(summary))) = found {
                self.turns[index].end = Some((at, summary, Instant::now()));
                return;
            }
            if Instant::now() > deadline {
                self.failure.get_or_insert(format!("turn {} did not end in {} s", index + 1, TURN_LIMIT.as_secs()));
                return;
            }
            tick_like_the_person(&self.rigs[session]);
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn finish_all(&mut self) {
        for session in 0..self.rigs.len() {
            self.finish_turn(session);
        }
    }

    /// Sleeps `ms`, ticking every session on the way.
    fn wait(&mut self, ms: u64) {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until {
            for rig in &self.rigs {
                tick_like_the_person(rig);
            }
            std::thread::sleep(Duration::from_millis(20).min(until.saturating_duration_since(Instant::now())));
        }
    }

    fn exec(&mut self, steps: &[Step]) {
        for step in steps {
            if self.failure.is_some() {
                return;
            }
            match step {
                Step::Prompt { text, session } => self.start_turn(*session, text),
                Step::PromptBig { prefix, fill, count, session } => {
                    let text = format!("{prefix}{}", fill.repeat(*count));
                    self.start_turn(*session, &text);
                }
                Step::SendRaw { line } => {
                    match self.rigs[0].session.connection() {
                        Some(conn) => {
                            if let Err(error) = conn.write_queue().push(Lane::Normal, line.clone()) {
                                self.refusals.push(error.to_string());
                            }
                        }
                        None => self.refusals.push("no live connection to write to".into()),
                    }
                    self.wait(150);
                }
                Step::CrashHost => {
                    match crate::acp::fake_agent::spawn_host(&self.rigs[0].dir) {
                        Ok(mut host) => {
                            self.pids.push(host.agent_pid);
                            self.pids.push(host.grandchild_pid);
                            host.crash();
                            self.host = Some(host);
                        }
                        Err(error) => self.failure = Some(format!("the host process did not start: {error}")),
                    }
                }
                Step::Cancel { after_ms, session } => {
                    self.wait(*after_ms);
                    let session = *session;
                    if let Some(index) = self.in_flight[session] {
                        self.turns[index].cancelled_at = Some(Instant::now());
                    }
                    if let Err(error) = self.rigs[session].session.cancel() {
                        self.refusals.push(error.to_string());
                    }
                }
                Step::Answer { option } => self.answer(option),
                Step::SetOption { id, value } => {
                    if let Err(error) = self.rigs[0].session.set_config_option(id, json!(value)) {
                        self.refusals.push(error.to_string());
                    }
                }
                Step::KillAgent => {
                    if let Some(conn) = self.rigs[0].session.connection() {
                        conn.kill();
                    }
                }
                Step::CloseStdin => {
                    if let Some(conn) = self.rigs[0].session.connection() {
                        conn.write_queue().close();
                    }
                }
                Step::Restart => {
                    self.finish_all();
                    if let Some(conn) = self.rigs[0].session.connection() {
                        let pid = conn.pid();
                        conn.kill();
                        let gone = super::rig::wait_until(10, || !pid_alive(pid));
                        if !gone {
                            self.failure = Some(format!("the agent (pid {pid}) did not stop for a restart"));
                        }
                    }
                }
                Step::Wait { ms } => self.wait(*ms),
                Step::Repeat { times, steps } => {
                    for _ in 0..*times {
                        self.exec(steps);
                    }
                }
            }
        }
    }

    /// Waits for the open permission question and answers it with the option of that kind.
    fn answer(&mut self, kind: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let session = self.in_flight.iter().position(|t| t.is_some()).unwrap_or(0);
        loop {
            let snapshot = self.rigs[session].session.snapshot();
            if let Some(wait) = snapshot.permission_waits.first() {
                match wait.options.iter().find(|o| o.kind == kind || o.id == kind) {
                    Some(option) => {
                        if let Err(error) = self.rigs[session].session.answer_permission(wait.ask_id, &option.id, crate::acp::session::AnswerSource::Person) {
                            self.refusals.push(error.to_string());
                        }
                    }
                    None => self.refusals.push(format!("no option of kind {kind} was offered")),
                }
                return;
            }
            // The turn ended without ever asking: nothing to answer.
            let ended = self.in_flight[session].is_some_and(|i| self.rigs[session].wait_event(self.turns[i].from, |e| matches!(e, SessionEvent::TurnEnded(_)), 0).is_some());
            if ended || Instant::now() > deadline {
                self.refusals.push("no question was asked".into());
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    // ---- reading the turns -------------------------------------------------------------------------------------

    fn turn(&self, number: usize) -> Result<&TurnData, String> {
        number.checked_sub(1).and_then(|i| self.turns.get(i)).ok_or_else(|| format!("the vector looks at turn {number} but only {} turn(s) ran", self.turns.len()))
    }

    fn events_of(&self, turn: &TurnData) -> Vec<SessionEvent> {
        let events = self.rigs[turn.session].events();
        let to = turn.end.as_ref().map(|(at, _, _)| at + 1).unwrap_or(events.len()).min(events.len());
        events[turn.from.min(to)..to].to_vec()
    }

    fn updates_of(&self, turn: &TurnData) -> Vec<Value> {
        self.events_of(turn)
            .iter()
            .filter_map(|e| match e {
                SessionEvent::Update { update, replay: false } => serde_json::to_value(update.as_ref()).ok(),
                _ => None,
            })
            .collect()
    }

    fn text_of(&self, turn: &TurnData) -> String {
        chunks_since(&self.events_of(turn), 0).concat()
    }

    /// (kind, final status, has a diff) of every tool call of the turn.
    fn tools_of(&self, turn: &TurnData) -> Vec<(String, String, bool)> {
        let mut tools: Vec<(String, String, String, bool)> = Vec::new();
        for update in self.updates_of(turn) {
            let id = update["toolCallId"].as_str().unwrap_or_default().to_string();
            let has_diff = update["content"].as_array().is_some_and(|c| c.iter().any(|item| item["type"] == "diff"));
            match update["sessionUpdate"].as_str() {
                Some("tool_call") => tools.push((id, update["kind"].as_str().unwrap_or_default().into(), update["status"].as_str().unwrap_or("pending").into(), has_diff)),
                Some("tool_call_update") => {
                    if let Some(tool) = tools.iter_mut().find(|t| t.0 == id) {
                        if let Some(status) = update["status"].as_str() {
                            tool.2 = status.to_string();
                        }
                        tool.3 |= has_diff;
                    }
                }
                _ => {}
            }
        }
        tools.into_iter().map(|(_, kind, status, diff)| (kind, status, diff)).collect()
    }

    fn all_pids(&self) -> Vec<u32> {
        let mut pids = self.pids.clone();
        for rig in &self.rigs {
            if let Some(pid) = rig.grandchild_pid() {
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
        pids
    }

    // ---- checking ----------------------------------------------------------------------------------------------

    fn check(&self, expect: &Expect) -> Result<(), String> {
        match expect {
            Expect::Stop { turn, stop, within_ms } => {
                let t = self.turn(*turn)?;
                let Some((_, summary, ended)) = &t.end else {
                    return Err(format!("turn {turn} never ended (refusals: {:?})", self.refusals));
                };
                let ok = match stop.as_str() {
                    "any" => true,
                    "end_turn" => summary.error.is_none() && (summary.stop == StopKind::EndTurn || summary.stop_reason.as_deref() == Some("end_turn")),
                    "cancelled" => summary.error.is_none() && (summary.stop == StopKind::Cancelled || summary.stop_reason.as_deref() == Some("cancelled")),
                    "error" => summary.error.is_some() || summary.stop == StopKind::Failed,
                    other => return Err(format!("unknown stop word {other:?} in the vector")),
                };
                if !ok {
                    return Err(format!("turn {turn} ended {:?} / {:?} (error {:?}), wanted {stop}", summary.stop, summary.stop_reason, summary.error));
                }
                if let Some(limit) = within_ms {
                    let since = t.cancelled_at.unwrap_or(t.started);
                    let took = ended.saturating_duration_since(since).as_millis() as u64;
                    if took > *limit {
                        return Err(format!("turn {turn} took {took} ms to end, the limit is {limit} ms"));
                    }
                }
                Ok(())
            }
            Expect::Error { turn, code_is_set } => {
                let t = self.turn(*turn)?;
                let summary = t.end.as_ref().map(|(_, s, _)| s).ok_or_else(|| format!("turn {turn} never ended"))?;
                if summary.error.is_none() {
                    return Err(format!("turn {turn} has no error ({:?})", summary.stop));
                }
                if summary.error_code.is_some() != *code_is_set {
                    return Err(format!("turn {turn}: error code is {:?}, wanted it {}", summary.error_code, if *code_is_set { "set" } else { "unset" }));
                }
                Ok(())
            }
            Expect::TextHas { turn, text } => {
                let got = self.text_of(self.turn(*turn)?);
                if got.contains(text.as_str()) { Ok(()) } else { Err(format!("turn {turn} text {:?} lacks {text:?}", clip(&got))) }
            }
            Expect::TextLacks { turn, text } => {
                let got = self.text_of(self.turn(*turn)?);
                if got.contains(text.as_str()) { Err(format!("turn {turn} text {:?} has {text:?}", clip(&got))) } else { Ok(()) }
            }
            Expect::ChunksAtLeast { turn, n } => {
                let t = self.turn(*turn)?;
                let count = chunks_since(&self.events_of(t), 0).len();
                if count >= *n { Ok(()) } else { Err(format!("turn {turn} had {count} chunk(s), wanted at least {n}")) }
            }
            Expect::Asked { turn, kind, times } => {
                let t = self.turn(*turn)?;
                let asked: Vec<String> = self
                    .events_of(t)
                    .iter()
                    .filter_map(|e| match e {
                        SessionEvent::PermissionRequested(wait) => Some(wait.tool_kind.clone().unwrap_or_default()),
                        _ => None,
                    })
                    .filter(|k| kind.is_empty() || k == kind)
                    .collect();
                if asked.len() == *times { Ok(()) } else { Err(format!("turn {turn}: the agent asked {} time(s) for kind {kind:?}, wanted {times}", asked.len())) }
            }
            Expect::File { path, exists, content } => {
                let file = self.rigs[0].dir.join(path);
                let there = file.is_file();
                if there != *exists {
                    return Err(format!("file {path:?} {} but should {}", if there { "exists" } else { "does not exist" }, if *exists { "exist" } else { "not exist" }));
                }
                if let (true, Some(want)) = (there, content) {
                    let got = std::fs::read_to_string(&file).unwrap_or_default();
                    if &got != want {
                        return Err(format!("file {path:?} holds {got:?}, wanted {want:?}"));
                    }
                }
                Ok(())
            }
            Expect::Tool { turn, kind, status, has_diff } => {
                let t = self.turn(*turn)?;
                let tools = self.tools_of(t);
                let found = tools.iter().any(|(k, s, d)| k == kind && status.as_ref().is_none_or(|w| w == s) && has_diff.is_none_or(|w| w == *d));
                if found { Ok(()) } else { Err(format!("turn {turn}: no {kind} tool call with status {status:?} diff {has_diff:?}; saw {tools:?}")) }
            }
            Expect::Thought { turn } => {
                let t = self.turn(*turn)?;
                if self.updates_of(t).iter().any(|u| u["sessionUpdate"] == "agent_thought_chunk") { Ok(()) } else { Err(format!("turn {turn} had no thought")) }
            }
            Expect::Usage { turn } => {
                let t = self.turn(*turn)?;
                let usage = self.updates_of(t).into_iter().find(|u| u["sessionUpdate"] == "usage_update");
                match usage {
                    Some(u) if u["used"].as_u64().is_some_and(|used| used <= u["size"].as_u64().unwrap_or(0)) => Ok(()),
                    Some(u) => Err(format!("turn {turn}: a usage update with used > size: {u}")),
                    None => Err(format!("turn {turn} had no usage update")),
                }
            }
            Expect::Refused { code } => {
                if self.refusals.iter().any(|r| r.to_lowercase().contains(&code.to_lowercase())) {
                    Ok(())
                } else {
                    Err(format!("nothing was refused (wanted {code:?}); refusals: {:?}", self.refusals))
                }
            }
            Expect::StdoutClean => {
                for (i, rig) in self.rigs.iter().enumerate() {
                    let (Some(base), Some(conn)) = (self.baseline_bad[i], rig.session.connection()) else { continue };
                    let now = conn.stats().bad_lines;
                    if now != base {
                        return Err(format!("the agent wrote {} line(s) to stdout that are not JSON-RPC", now - base));
                    }
                }
                Ok(())
            }
            Expect::NoOrphans => {
                for rig in &self.rigs {
                    rig.session.close();
                }
                let pids = self.all_pids();
                if super::rig::wait_until(5, || pids.iter().all(|p| !pid_alive(*p))) {
                    Ok(())
                } else {
                    Err(format!("still running after the session was closed: {:?}", pids.iter().filter(|p| pid_alive(**p)).collect::<Vec<_>>()))
                }
            }
            Expect::AgentExits { within_ms } => {
                let pid = *self.pids.first().ok_or("no agent ever ran")?;
                if super::rig::wait_until((*within_ms / 1000).max(1), || !pid_alive(pid)) { Ok(()) } else { Err(format!("the agent (pid {pid}) is still running {within_ms} ms after its input closed")) }
            }
            Expect::MemoryFlat { .. } => Err("memory is not measured by this runner".into()),
            Expect::SamePid => {
                let first = self.pids.first().ok_or("no agent ever ran")?;
                if self.pids.iter().all(|p| p == first) { Ok(()) } else { Err(format!("the agent process changed: {:?}", self.pids)) }
            }
            Expect::SettingsReach { turn, text } => self.check(&Expect::TextHas { turn: *turn, text: text.clone() }),
        }
    }
}

/// One supervisor tick. A quiet agent makes the session ask the person (Stop or Keep waiting); the runner is the person
/// and presses Stop.
fn tick_like_the_person(rig: &AcpRig) {
    if rig.tick(Instant::now()) == crate::acp::session::TickAction::QuietAsked {
        let _ = rig.session.cancel();
    }
}

fn clip(text: &str) -> String {
    text.chars().take(120).collect()
}

/// Runs `vector` on `target`.
pub fn run(vector: &Vector, target: &Target) -> Outcome {
    if !vector.levels.contains(&target.level) || target.unavailable().is_some() {
        return Outcome::NotClaimed;
    }
    match vector.cost {
        Cost::Fast => {}
        Cost::Slow if std::env::var_os("PM_CONFORMANCE_SLOW").is_some() => {}
        Cost::Soak if std::env::var_os("PM_CONFORMANCE_SOAK").is_some() => {}
        _ => return Outcome::NotClaimed,
    }
    if target.level == Level::TerminalOnly {
        return run_terminal_only(vector);
    }
    run_native(vector, target)
}

fn run_native(vector: &Vector, target: &Target) -> Outcome {
    let opts = target.opts_for(vector);
    let (inactivity, progress, grace) = (vector.inactivity_secs, vector.progress_secs, vector.hung_grace_secs);
    let mut rigs = Vec::new();
    for _ in 0..vector.sessions.max(1) {
        rigs.push(AcpRig::with(&opts, |cfg| {
            if let Some(secs) = inactivity {
                cfg.timeouts.inactivity_secs = secs;
            }
            if let Some(secs) = progress {
                cfg.timeouts.progress_secs = secs;
            }
            if let Some(secs) = grace {
                cfg.timeouts.hung_grace_secs = secs;
            }
        }));
    }
    let count = rigs.len();
    let mut run = Run { rigs, turns: Vec::new(), in_flight: vec![None; count], refusals: Vec::new(), pids: Vec::new(), baseline_bad: vec![None; count], host: None, failure: None };
    run.exec(&vector.steps);
    run.finish_all();
    if let Some(why) = run.failure.take() {
        return Outcome::Fail(why);
    }
    for expect in &vector.expect {
        if let Err(why) = run.check(expect) {
            return Outcome::Fail(why);
        }
    }
    Outcome::Pass
}

/// A terminal-only agent has no chat: asking for one must be refused with a plain sentence and the terminal as the way out.
fn run_terminal_only(vector: &Vector) -> Outcome {
    let deps = super::rig::start_deps();
    let request = crate::acp::chat::StartRequest { agent_id: "terminal-only-agent-that-does-not-exist".into(), folder: std::env::temp_dir(), explicit: true, ..Default::default() };
    match crate::acp::chat::start_gated(&deps, request) {
        Ok(chat) => {
            chat.close();
            Outcome::Fail("a chat started for an agent that has no chat".into())
        }
        Err(error) => {
            if error.message.trim().is_empty() || error.message.contains("ACP_") {
                return Outcome::Fail(format!("the refusal is not a plain sentence: {:?}", error.message));
            }
            if !error.fallback {
                return Outcome::Fail("the refusal does not offer the terminal".into());
            }
            for expect in &vector.expect {
                if let Expect::Refused { code } = expect {
                    if !error.code.to_lowercase().contains(&code.to_lowercase()) {
                        return Outcome::Fail(format!("refused with {}, wanted {code}", error.code));
                    }
                }
            }
            Outcome::Pass
        }
    }
}

// ---- the matrix -----------------------------------------------------------------------------------------------------

/// Every vector's outcome on one target, computed once per test process.
pub fn results_for(target: &Target) -> &'static Vec<(String, String, Outcome)> {
    static CELLS: [OnceLock<Vec<(String, String, Outcome)>>; 8] = [const { OnceLock::new() }; 8];
    let index = match target.name {
        "native" => 0,
        "native_bad" => 1,
        "json" => 2,
        "text" => 3,
        "terminal_only" => 4,
        "cheat_auto_approve" => 5,
        "cheat_deny_ignored" => 6,
        _ => 7,
    };
    CELLS[index].get_or_init(|| {
        let vectors = vector::load_all().expect("every vector parses");
        vectors.iter().map(|v| (v.id.clone(), v.title.clone(), run(v, target))).collect()
    })
}

/// The ids that FAIL on `target`.
pub fn failing_ids(target: &Target) -> Vec<String> {
    results_for(target).iter().filter(|(_, _, o)| o.is_fail()).map(|(id, _, _)| id.clone()).collect()
}

fn mark(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Pass => json!({"result": "pass", "mark": "fake"}),
        Outcome::Fail(why) => json!({"result": "fail", "mark": "fake", "why": why}),
        Outcome::NotClaimed => json!({"result": "not_claimed", "mark": "fake"}),
    }
}

/// The whole matrix as JSON: one row per vector, one cell per target.
pub fn matrix_json() -> Value {
    let vectors = vector::load_all().expect("every vector parses");
    let rows: Vec<Value> = vectors
        .iter()
        .map(|v| {
            let mut cells = serde_json::Map::new();
            for target in Target::MATRIX {
                let outcome = results_for(&target).iter().find(|(id, _, _)| *id == v.id).map(|(_, _, o)| o.clone()).unwrap_or(Outcome::NotClaimed);
                cells.insert(target.name.to_string(), mark(&outcome));
            }
            json!({"id": v.id, "title": v.title, "claims": v.claims, "cells": cells})
        })
        .collect();
    let notes: Vec<Value> = [Target::JSON, Target::TEXT].iter().filter_map(|t| t.unavailable().map(|why| json!({"target": t.name, "note": why}))).collect();
    json!({"schema": 1, "vectors": rows, "notes": notes})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ids `profile=bad` is built to fail (SPEC-CHAOS-1113 section 3.3, the "bad" column).
    const BAD_FAILS: [&str; 8] = ["B02", "B05", "B06", "B07", "B09", "B11", "B12", "B17"];

    fn show(target: &Target) -> String {
        results_for(target).iter().filter(|(_, _, o)| o.is_fail()).map(|(id, _, o)| format!("{id}: {o:?}")).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn conformance_every_vector_file_parses_and_has_a_lab_id() {
        let vectors = vector::load_all().expect("every vector file parses");
        let ids: Vec<&str> = vectors.iter().map(|v| v.id.as_str()).collect();
        for n in 1..=18 {
            assert!(ids.contains(&format!("B{n:02}").as_str()), "behaviour vector B{n:02} is missing");
        }
        for n in 1..=17 {
            assert!(ids.contains(&format!("S{n:02}").as_str()), "stability vector S{n:02} is missing");
        }
        for v in &vectors {
            assert!(v.id.len() == 3 && v.id[1..].chars().all(|c| c.is_ascii_digit()) && matches!(&v.id[..1], "B" | "S" | "T"), "{} is not a lab id", v.id);
            assert!(!v.levels.is_empty() && !v.title.is_empty());
        }
        let mut sorted = ids.clone();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "a vector id is used twice");
    }

    #[test]
    fn conformance_native_good_passes_every_fast_vector() {
        let failing = show(&Target::NATIVE);
        assert!(failing.is_empty(), "the good fake fails:\n{failing}");
        let ran = results_for(&Target::NATIVE).iter().filter(|(_, _, o)| *o == Outcome::Pass).count();
        assert!(ran >= 30, "only {ran} vectors ran on the good fake");
    }

    #[test]
    fn conformance_native_bad_fails_exactly_the_listed_vectors() {
        let failing = failing_ids(&Target::NATIVE_BAD);
        let mut want: Vec<String> = BAD_FAILS.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(failing, want, "bad fake failures:\n{}", show(&Target::NATIVE_BAD));
    }

    #[test]
    fn conformance_auto_approve_fake_must_fail() {
        let failing = failing_ids(&Target::CHEAT_AUTO_APPROVE);
        for id in ["B05", "B06", "B07", "B17"] {
            assert!(failing.iter().any(|f| f == id), "{id} did not catch the auto-approving fake; failing: {failing:?}");
        }
    }

    #[test]
    fn conformance_deny_ignored_fake_must_fail() {
        let failing = failing_ids(&Target::CHEAT_DENY_IGNORED);
        for id in ["B05", "B06"] {
            assert!(failing.iter().any(|f| f == id), "{id} did not catch the fake that ignores a rejection; failing: {failing:?}");
        }
    }

    #[test]
    fn conformance_stub_fake_must_fail() {
        let failing = failing_ids(&Target::CHEAT_STUB);
        assert!(failing.iter().any(|f| f == "B02"), "B02 did not catch the stub fake; failing: {failing:?}");
    }

    #[test]
    fn conformance_terminal_only_refuses_a_chat_with_a_plain_reason() {
        let results = results_for(&Target::TERMINAL_ONLY);
        let t01 = results.iter().find(|(id, _, _)| id == "T01").expect("vector T01");
        assert_eq!(t01.2, Outcome::Pass, "{:?}", t01.2);
        assert!(results.iter().filter(|(id, _, _)| id != "T01").all(|(_, _, o)| *o == Outcome::NotClaimed), "a chat vector ran on a terminal-only agent");
    }

    #[test]
    fn conformance_matrix_json_is_written() {
        let matrix = matrix_json();
        let rows = matrix["vectors"].as_array().expect("rows");
        assert!(rows.len() >= 36);
        let b02 = rows.iter().find(|r| r["id"] == "B02").unwrap();
        assert_eq!(b02["cells"]["native"]["result"], "pass");
        assert_eq!(b02["cells"]["native"]["mark"], "fake");
        assert_eq!(b02["cells"]["native_bad"]["result"], "fail");
        assert_eq!(b02["cells"]["json"]["result"], "not_claimed");
        let target = std::env::var_os("CARGO_TARGET_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target"));
        std::fs::create_dir_all(&target).unwrap();
        let file = target.join("agent-matrix.json");
        std::fs::write(&file, serde_json::to_string_pretty(&matrix).unwrap()).unwrap();
        assert!(file.is_file());
    }
}
