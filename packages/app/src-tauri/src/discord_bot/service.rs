//! One bot: what happens to a message from Discord, from the door to the reply.
//!
//! ```text
//! message -> scope (allow list, bots, owners)            dropped here, before anything else
//!         -> journal "heard"                              only for what passed the scope
//!         -> hard trigger? (mention, reply, name, owner DM)
//!              yes: a turn (6 per 5 min per non-owner, queue of 8)
//!              no : only if the server allows it to join in:
//!                     budget full? stop (no gate call)
//!                     the gate chain says yes -> wait a moment -> a turn for the whole burst
//!         -> brain (no tools) -> cleaned text -> one REST post, no mentions
//! ```
//!
//! The reader of the gateway only does the cheap part (scope, journal, queue). The questions to a model (the
//! gate, the brain) and the REST post run on the worker, so a slow answer never delays a heartbeat. A turn
//! always goes before a gate question.
//!
//! Nothing here has a way to reach a pane, a tool or the companion's memory: `Deps` holds a brain, a poster,
//! a journal line writer, a persona reader, a call counter and a clock, and that is all.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Condvar, Mutex};

use super::config::{BotSettings, GateChoice};
use super::gateway::{Me, Sink};
use super::rest::{Rest, RestError};
use super::scope::{self, Deny, Incoming};
use super::State;
use crate::companion::brain::assemble::{Line, Persona, Request, Why};
use crate::companion::brain::budget::{CountedCompleter, DailyCalls};
use crate::companion::brain::turn::{self, TurnError};
use crate::companion::brain::{Brain, BrainError, ChatMsg, Role};
use crate::companion::social::addressing::aimed_elsewhere;
use crate::companion::social::budget::{gate_if_room, in_settle, queue_full, take_budget, take_token, Bucket, TURN_LIMIT};
use crate::companion::social::chain::{Chain, Choice};
use crate::companion::social::gate::{clean_line, Gate, GateInput, GateMessage};
use crate::companion::social::llm::{CompleteError, Completer, LlmGate};

/// The base chance for joining in (fishd `DISCORD_AMBIENT_P`).
pub const AMBIENT_BASE: f64 = 0.12;
/// A line aimed at somebody else needs this much more confidence.
pub const AIMED_BIAS: f64 = 2.5;
/// After the gate says yes it waits this long, so a burst is answered as one.
pub const ARM_MS: i64 = 3_000;
/// After it joins in unprompted it stays quiet this long in that channel.
pub const SETTLE_MS: i64 = 3 * 60_000;
const TAPE_MAX: usize = 30;
const TAPE_CHANNELS: usize = 64;
const TEXT_CAP: usize = 500;
const WINDOW: usize = 12;
const RETRIES_ON_429: usize = 2;

/// Writes what was heard and said to the companion's journal (when the vault is on).
pub trait Journal: Send + Sync {
    fn heard(&self, who: &str, text: &str, at_ms: i64);
    fn said(&self, who: &str, text: &str, at_ms: i64);
}

/// Reads the persona each turn, so an edit of `SOUL.md` is followed with no restart.
pub trait PersonaSource: Send + Sync {
    fn persona(&self) -> Persona;
}

/// The brain right now, or `None` when the person has no AI service and key saved.
pub type BrainSource = Arc<dyn Fn() -> Option<Arc<dyn Brain>> + Send + Sync>;

pub struct Deps {
    pub brain: BrainSource,
    pub rest: Arc<dyn Rest>,
    pub journal: Arc<dyn Journal>,
    pub persona: Arc<dyn PersonaSource>,
    pub calls: Arc<DailyCalls>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// How long to wait (a 429). Tests make it instant.
    pub sleep: Arc<dyn Fn(Duration) + Send + Sync>,
    pub arm_ms: i64,
}

/// What became of one message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handled {
    Dropped(Deny),
    /// Nothing to say (no text), or no identity yet.
    Ignored,
    /// A turn is waiting.
    Queued,
    /// A person started too many turns.
    Limited,
    QueueFull,
    /// Heard, and nothing else was done.
    Heard,
    /// The gate will be asked.
    Considering,
}

struct Turn {
    channel_id: String,
    reply_to: Option<String>,
    why: Why,
}

struct Consider {
    channel_id: String,
    message_id: String,
    aimed: bool,
}

#[derive(Default)]
struct Inner {
    me: Option<(String, String)>,
    tapes: HashMap<String, VecDeque<GateMessage>>,
    ambient_stamps: HashMap<String, Vec<i64>>,
    last_spoke: HashMap<String, i64>,
    settle_until: HashMap<String, i64>,
    armed: HashMap<String, i64>,
    buckets: HashMap<String, Bucket>,
    turns: VecDeque<Turn>,
    considers: VecDeque<Consider>,
    pending: usize,
    bot_name: Option<String>,
    posts: u32,
}

/// Lazily asks whatever brain exists right now, with a one-line prompt.
struct BrainCompleter {
    source: BrainSource,
}

impl Completer for BrainCompleter {
    fn complete(&self, prompt: &str, timeout: Duration) -> Result<String, CompleteError> {
        let brain = (self.source)().ok_or(BrainError::NoKey)?;
        brain.complete(&[ChatMsg { role: Role::User, content: prompt.to_string() }], 20, timeout)
    }
}

pub struct Bot {
    settings: Mutex<BotSettings>,
    chain: Mutex<Arc<Chain>>,
    inner: Mutex<Inner>,
    wake: Condvar,
    state: Mutex<State>,
    stop: Arc<AtomicBool>,
    deps: Deps,
    llm: Arc<LlmGate>,
}

impl Bot {
    pub fn new(settings: BotSettings, deps: Deps, stop: Arc<AtomicBool>) -> Arc<Self> {
        let source = deps.brain.clone();
        let counted = CountedCompleter { inner: Arc::new(BrainCompleter { source }), calls: deps.calls.clone(), clock: deps.clock.clone() };
        let llm = Arc::new(LlmGate::new("llm", Arc::new(counted)));
        let chain = Arc::new(Self::build_chain(&settings, &llm));
        Arc::new(Self {
            settings: Mutex::new(settings),
            chain: Mutex::new(chain),
            inner: Mutex::new(Inner::default()),
            wake: Condvar::new(),
            state: Mutex::new(State::Connecting),
            stop,
            deps,
            llm,
        })
    }

    /// The hosted judge is never added (held back), so `Chain` is the model, then the rules.
    fn build_chain(settings: &BotSettings, llm: &Arc<LlmGate>) -> Chain {
        let choice = match settings.gate {
            GateChoice::Heuristic => Choice::Heuristic,
            GateChoice::Llm => Choice::Llm,
            GateChoice::Chain => Choice::Chain,
        };
        let model: Arc<dyn Gate> = llm.clone();
        Chain::build(choice, None, Some(model))
    }

    pub fn set_settings(&self, settings: BotSettings) {
        *self.chain.lock() = Arc::new(Self::build_chain(&settings, &self.llm));
        *self.settings.lock() = settings;
    }

    /// Tests put a gate of their own in place of the chain.
    #[cfg(test)]
    pub fn set_chain(&self, chain: Chain) {
        *self.chain.lock() = Arc::new(chain);
    }

    pub fn settings(&self) -> BotSettings {
        self.settings.lock().clone()
    }

    pub fn state(&self) -> State {
        *self.state.lock()
    }

    pub fn bot_name(&self) -> Option<String> {
        self.inner.lock().bot_name.clone()
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }

    /// Replies posted since it started.
    #[cfg(test)]
    pub fn posts(&self) -> u32 {
        self.inner.lock().posts
    }

    fn now(&self) -> i64 {
        (self.deps.clock)()
    }

    /// The names that call it: the ones the person listed, its display name, and its bot name.
    fn names(&self, settings: &BotSettings, inner: &Inner) -> Vec<String> {
        let mut names = settings.names.clone();
        let own = self.deps.persona.persona().name;
        if !own.trim().is_empty() {
            names.push(own);
        }
        if let Some(bot) = &inner.bot_name {
            names.push(bot.clone());
        }
        names.retain(|n| n.trim().chars().count() >= 2);
        names
    }

    /// The text with Discord's mention markup turned into names a person would read.
    fn readable(content: &str, m: &Incoming, me: &(String, String)) -> String {
        let mut text = content.to_string();
        for (id, name) in &m.mentions {
            let shown = if *id == me.0 { me.1.clone() } else { name.clone() };
            for form in [format!("<@{id}>"), format!("<@!{id}>")] {
                text = text.replace(&form, &format!("@{shown}"));
            }
        }
        clean_line(&text, TEXT_CAP)
    }

    fn push_tape(inner: &mut Inner, channel: &str, line: GateMessage) {
        if !inner.tapes.contains_key(channel) && inner.tapes.len() >= TAPE_CHANNELS {
            if let Some(oldest) = inner.tapes.iter().min_by_key(|(_, t)| t.back().map_or(0, |m| m.at_ms)).map(|(k, _)| k.clone()) {
                inner.tapes.remove(&oldest);
            }
        }
        let tape = inner.tapes.entry(channel.to_string()).or_default();
        tape.push_back(line);
        while tape.len() > TAPE_MAX {
            tape.pop_front();
        }
    }

    /// One message from the gateway. Cheap: nothing here asks a model or posts.
    pub fn on_message(&self, m: Incoming) -> Handled {
        let settings = self.settings();
        let mut inner = self.inner.lock();
        let Some(me) = inner.me.clone() else { return Handled::Ignored };
        let allowed = match scope::check(&settings, &me.0, &m) {
            Ok(a) => a,
            Err(deny) => return Handled::Dropped(deny),
        };
        let now = self.now();
        let text = Self::readable(&m.content, &m, &me);
        if text.is_empty() {
            return Handled::Ignored;
        }
        self.deps.journal.heard(&m.author_name, &text, now);

        let names = self.names(&settings, &inner);
        let lower = text.to_lowercase();
        let mentioned_me = m.mentions.iter().any(|(id, _)| *id == me.0) || m.reply_to_author.as_deref() == Some(me.0.as_str());
        let by_name = names.iter().any(|n| lower.contains(&n.to_lowercase()));
        let mut others: Vec<String> = m.mentions.iter().map(|(id, _)| id.clone()).collect();
        others.extend(m.reply_to_author.clone());
        let aimed = !mentioned_me && aimed_elsewhere(&me.0, &others, &text, &names);

        Self::push_tape(&mut inner, &m.channel_id, GateMessage { author: m.author_name.clone(), text, at_ms: now, to: if aimed { vec!["someone else".into()] } else { Vec::new() }, is_self: false });

        let hard = allowed.dm || mentioned_me || (by_name && !aimed);
        if hard {
            if !allowed.owner {
                let (ok, bucket) = take_token(inner.buckets.get(&m.author_id).copied(), now, TURN_LIMIT);
                inner.buckets.insert(m.author_id.clone(), bucket);
                if !ok {
                    return Handled::Limited;
                }
            }
            if queue_full(inner.pending) {
                return Handled::QueueFull;
            }
            inner.turns.push_back(Turn { channel_id: m.channel_id, reply_to: Some(m.id), why: if allowed.dm { Why::OwnerDm } else { Why::Called } });
            inner.pending += 1;
            self.wake.notify_one();
            return Handled::Queued;
        }

        // Joining in uninvited: only where the person allowed it, and never with a budget of nothing.
        if !allowed.ambient || settings.budget.count == 0 {
            return Handled::Heard;
        }
        if in_settle(now, inner.settle_until.get(&m.channel_id).copied().unwrap_or(0)) || inner.armed.contains_key(&m.channel_id) || queue_full(inner.pending) {
            return Handled::Heard;
        }
        inner.considers.push_back(Consider { channel_id: m.channel_id, message_id: m.id, aimed });
        inner.pending += 1;
        self.wake.notify_one();
        Handled::Considering
    }

    /// Fires the replies whose moment has come. Called often.
    pub fn tick(&self) {
        let now = self.now();
        let settings = self.settings();
        let mut inner = self.inner.lock();
        let due: Vec<String> = inner.armed.iter().filter(|(_, at)| **at <= now).map(|(c, _)| c.clone()).collect();
        for channel in due {
            inner.armed.remove(&channel);
            let window = settings.budget.minutes as i64 * 60_000;
            let stamps = inner.ambient_stamps.get(&channel).cloned().unwrap_or_default();
            let taken = take_budget(&stamps, now, settings.budget.count as usize, window);
            if !taken.ok || queue_full(inner.pending) {
                inner.ambient_stamps.insert(channel, taken.stamps);
                continue;
            }
            inner.ambient_stamps.insert(channel.clone(), taken.stamps);
            inner.settle_until.insert(channel.clone(), now + SETTLE_MS);
            inner.turns.push_back(Turn { channel_id: channel, reply_to: None, why: Why::JoinedIn });
            inner.pending += 1;
            self.wake.notify_one();
        }
    }

    /// Does one piece of work: a turn first, else a gate question. False when there was none.
    pub fn process_next(&self) -> bool {
        enum Work {
            Turn(Turn),
            Consider(Consider),
        }
        let work = {
            let mut inner = self.inner.lock();
            if let Some(t) = inner.turns.pop_front() {
                Work::Turn(t)
            } else if let Some(c) = inner.considers.pop_front() {
                Work::Consider(c)
            } else {
                return false;
            }
        };
        match work {
            Work::Turn(t) => self.run_turn(&t),
            Work::Consider(c) => self.run_consider(&c),
        }
        let mut inner = self.inner.lock();
        inner.pending = inner.pending.saturating_sub(1);
        true
    }

    fn run_consider(&self, c: &Consider) {
        let settings = self.settings();
        let now = self.now();
        let persona = self.deps.persona.persona();
        let input = {
            let inner = self.inner.lock();
            let tape = inner.tapes.get(&c.channel_id).cloned().unwrap_or_default();
            GateInput {
                channel: c.channel_id.clone(),
                messages: tape.iter().rev().take(10).rev().cloned().collect(),
                names: self.names(&settings, &inner),
                self_name: persona.name.clone(),
                last_spoke_ms: inner.last_spoke.get(&c.channel_id).copied().unwrap_or(0),
                now_ms: now,
                base: AMBIENT_BASE,
                message_id: c.message_id.clone(),
                bias: if c.aimed { AIMED_BIAS } else { 1.0 },
            }
        };
        let stamps = self.inner.lock().ambient_stamps.get(&c.channel_id).cloned().unwrap_or_default();
        // The budget is read before the gate: a full budget costs no question.
        let chain = self.chain.lock().clone();
        let window_ms = settings.budget.minutes as i64 * 60_000;
        if gate_if_room(&chain, &input, &stamps, settings.budget.count as usize, window_ms).is_some_and(|d| d.speak) {
            self.inner.lock().armed.insert(c.channel_id.clone(), now + self.deps.arm_ms);
        }
    }

    fn run_turn(&self, turn: &Turn) {
        let now = self.now();
        let persona = self.deps.persona.persona();
        let Some(brain) = (self.deps.brain)() else { return };
        let window: Vec<Line> = {
            let inner = self.inner.lock();
            inner
                .tapes
                .get(&turn.channel_id)
                .map(|t| t.iter().rev().take(WINDOW).rev().map(|m| Line { author: m.author.clone(), text: m.text.clone(), is_self: m.is_self }).collect())
                .unwrap_or_default()
        };
        let request = Request { persona: &persona, window: &window, why: turn.why, memory: None };
        let text = match turn::run(&*brain, &self.deps.calls, &request, now) {
            Ok(text) => text,
            Err(TurnError::Capped | TurnError::Empty | TurnError::Brain(_)) => return,
        };
        if !self.post(&turn.channel_id, &text, turn.reply_to.as_deref()) {
            return;
        }
        let at = self.now();
        self.deps.journal.said(&persona.name, &text, at);
        let mut inner = self.inner.lock();
        inner.posts += 1;
        inner.last_spoke.insert(turn.channel_id.clone(), at);
        Self::push_tape(&mut inner, &turn.channel_id, GateMessage { author: persona.name.clone(), text: clean_line(&text, TEXT_CAP), at_ms: at, to: Vec::new(), is_self: true });
    }

    /// One post, waiting and trying again when Discord says slow down. True when it went out.
    fn post(&self, channel_id: &str, text: &str, reply_to: Option<&str>) -> bool {
        for attempt in 0..=RETRIES_ON_429 {
            match self.deps.rest.post(channel_id, text, reply_to) {
                Ok(()) => return true,
                Err(RestError::RateLimited { retry_after_ms }) if attempt < RETRIES_ON_429 => {
                    (self.deps.sleep)(Duration::from_millis(retry_after_ms));
                    if self.stop.load(Ordering::SeqCst) {
                        return false;
                    }
                }
                Err(RestError::Unauthorized) => {
                    *self.state.lock() = State::TokenRejected;
                    self.stop.store(true, Ordering::SeqCst);
                    return false;
                }
                Err(_) => return false,
            }
        }
        false
    }

    /// The worker: runs until the stop flag is set.
    pub fn run_worker(&self) {
        while !self.stop.load(Ordering::SeqCst) {
            if !self.process_next() {
                let mut inner = self.inner.lock();
                if inner.turns.is_empty() && inner.considers.is_empty() {
                    self.wake.wait_for(&mut inner, Duration::from_millis(400));
                }
            }
        }
    }

    /// Wakes the worker (used when stopping).
    pub fn wake(&self) {
        self.wake.notify_all();
    }
}

impl Sink for Bot {
    fn on_state(&self, state: State) {
        let mut current = self.state.lock();
        // A refused token stays refused until the person saves a new one (a new bot is made then).
        if *current != State::TokenRejected || state == State::TokenRejected {
            *current = state;
        }
    }

    fn on_ready(&self, me: Me) {
        let mut inner = self.inner.lock();
        inner.bot_name = Some(me.name.clone());
        inner.me = Some((me.id, me.name));
    }

    fn on_message(&self, message: Incoming) {
        let _ = Bot::on_message(self, message);
    }

    fn tick(&self) {
        Bot::tick(self);
    }
}
