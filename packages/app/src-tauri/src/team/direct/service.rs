//! Pass a task: passing, answering and the repo hand-over, in one place. See `mod.rs` for the rules.
//!
//! Everything from another PC is untrusted: it is opened and checked in `wire`, matched against what this PC itself sent
//! or was sent, cleaned, and only then stored. Nothing here starts an agent, a pane or a script: `accept` records the
//! person's answer; the New agent page (`Start...`) is the person's click.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::Deserialize;

use super::bundle::{self, Assembly};
use super::model::*;
use super::wire::{self, Body, History, LendOffer, ReplyState, WireReject};
use crate::secure_core::crypto::{b64, unb64};
use crate::team::secure::{CapacityIn, Payload, Session};

/// Open tasks I may have passed to one person, and open tasks one person may have passed to me.
pub const MAX_OPEN_PER_PERSON: usize = 10;
const MAX_OPEN_FROM_PERSON: usize = 20;
/// Closed tasks kept in the list.
const KEEP_CLOSED: usize = 100;

/// The team relay, as this service sees it: the live session (roster and my keys) and a way to send one sealed payload.
pub trait Port: Send + Sync {
    fn session(&self) -> Result<Session, String>;
    fn send(&self, payload: &Payload) -> Result<(), String>;
}

/// "Run it through my lent usage", as this service sees the lend feature. Only ever words and numbers cross here.
pub trait LendPort: Send + Sync {
    fn enabled(&self) -> bool;
    /// My profile may be promised to `member_id` for `secs`: its name and its agents.
    fn profile_for_task(&self, member_id: &str, profile_id: &str, secs: u64) -> Result<(String, Vec<String>), String>;
    /// The normal lend request to the sender's PC, naming the task.
    fn request(&self, member_id: &str, device_id: &str, offer: &LendOffer, reason: &str, task_id: &str) -> Result<(), String>;
}

pub type Spawn = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

pub struct Deps {
    pub dir: PathBuf,
    pub port: Arc<dyn Port>,
    pub lend: Arc<dyn LendPort>,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub changed: Arc<dyn Fn() + Send + Sync>,
    pub spawn: Spawn,
    /// Pause between two pieces of a repo copy (the relay asks senders to slow down).
    pub pace_ms: u64,
}

struct Inner {
    saved: Saved,
    assemblies: HashMap<String, Assembly>,
}

pub struct Direct {
    deps: Deps,
    inner: Mutex<Inner>,
    me: Weak<Direct>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassInput {
    pub to_member: String,
    #[serde(default)]
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub repo: Option<RepoInput>,
    #[serde(default)]
    pub lend: Option<LendInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInput {
    pub path: String,
    #[serde(default)]
    pub history: History,
    /// The person ticked "I understand" in the own-risk box.
    #[serde(default)]
    pub understood: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LendInput {
    pub profile_id: String,
    pub secs: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInput {
    #[serde(default)]
    pub usage: Usage,
    #[serde(default)]
    pub want_repo: bool,
    #[serde(default)]
    pub understood: bool,
}

/// The text of a task looks like it asks for something risky: plain words for the card, or None.
pub fn risk_words(text: &str) -> Option<String> {
    use crate::prompt_risk::{assess, RiskInput, RiskLevel};
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()).take(80) {
        let line = line.trim_start_matches(['$', '>', ' ', '`']).trim_end_matches('`');
        let risk = assess(&RiskInput { kind: "command_approval", command: Some(line), ..Default::default() }, &[]);
        if risk.level == RiskLevel::High {
            return Some(risk.headline);
        }
    }
    None
}

impl Direct {
    pub fn new(deps: Deps) -> Arc<Self> {
        let saved = std::fs::read_to_string(deps.dir.join("state.json")).ok().and_then(|t| serde_json::from_str::<Saved>(&t).ok()).unwrap_or_default();
        Arc::new_cyclic(|me| Self { deps, inner: Mutex::new(Inner { saved, assemblies: HashMap::new() }), me: me.clone() })
    }

    fn now(&self) -> u64 {
        (self.deps.now)()
    }

    fn save(&self, inner: &Inner) {
        let _ = std::fs::create_dir_all(&self.deps.dir);
        if let Ok(text) = serde_json::to_string_pretty(&inner.saved) {
            let path = self.deps.dir.join("state.json");
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn changed(&self) {
        (self.deps.changed)();
    }

    fn out_dir(&self) -> PathBuf {
        self.deps.dir.join("out")
    }

    fn in_dir(&self) -> PathBuf {
        self.deps.dir.join("in")
    }

    /// Drops closed tasks past the keep limit (oldest first) and the files that belonged to them.
    fn prune(&self, inner: &mut Inner) {
        fn trim<T>(list: &mut Vec<T>, closed: impl Fn(&T) -> bool, at: impl Fn(&T) -> u64, files: impl Fn(&T) -> Vec<String>) {
            let closed_count = list.iter().filter(|t| closed(t)).count();
            if closed_count <= KEEP_CLOSED {
                return;
            }
            let mut ats: Vec<u64> = list.iter().filter(|t| closed(t)).map(&at).collect();
            ats.sort_unstable();
            let cut = ats[closed_count - KEEP_CLOSED - 1];
            list.retain(|t| {
                let drop = closed(t) && at(t) <= cut;
                if drop {
                    for f in files(t) {
                        let _ = std::fs::remove_file(f);
                    }
                }
                !drop
            });
        }
        trim(&mut inner.saved.sent, |t| !t.state.open(), |t| t.updated_ms, |t| t.bundle_path.clone().into_iter().collect());
        trim(&mut inner.saved.received, |t| !t.state.open(), |t| t.updated_ms, |t| t.bundle_path.clone().into_iter().collect());
    }

    pub fn view(&self) -> TasksView {
        let inner = lock(&self.inner);
        let mut sent = inner.saved.sent.clone();
        let mut received = inner.saved.received.clone();
        // The bundle's place on disk is never sent to the screen.
        sent.iter_mut().for_each(|t| t.bundle_path = None);
        received.iter_mut().for_each(|t| t.bundle_path = None);
        sent.sort_by_key(|t| std::cmp::Reverse(t.at_ms));
        received.sort_by_key(|t| std::cmp::Reverse(t.at_ms));
        TasksView { sent, received, handover_on: inner.saved.handover_on, lend_on: self.deps.lend.enabled(), repo_cap_bytes: wire::BUNDLE_CAP_BYTES }
    }

    pub fn set_handover(&self, on: bool) {
        let mut inner = lock(&self.inner);
        inner.saved.handover_on = on;
        self.save(&inner);
        drop(inner);
        self.changed();
    }

    fn send_to(&self, session: &Session, device: &str, body: Body) -> Result<(), String> {
        let (payload, _) = wire::seal(session, device, body, self.now())?;
        self.deps.port.send(&payload)
    }

    // --------------------------------------------------------------------------------------------- passing a task

    /// Passes a task to a teammate: every PC of theirs gets it. A repo copy is made now (and waits for their yes).
    pub fn pass(&self, input: PassInput) -> Result<SentTask, String> {
        let session = self.deps.port.session()?;
        let me_member = session.my_member()?;
        let me_device = session.my_device()?;
        let member = session.roster.member(&input.to_member).ok_or("That person is not on the team.")?.clone();
        if member.id == me_member {
            return Err("That is you. Pick a teammate.".into());
        }
        let text = wire::clean_text(&input.text, usize::MAX);
        if text.is_empty() {
            return Err("Write what should get done.".into());
        }
        if text.len() > wire::MAX_TEXT_BYTES {
            return Err(format!("That is too long to send. Keep it under {} letters.", wire::MAX_TEXT_BYTES / 3));
        }
        let summary = wire::clean_text(&input.summary, usize::MAX);
        if summary.len() > wire::MAX_SUMMARY_BYTES {
            return Err("The chat summary is too long. Make it shorter.".into());
        }
        let mut title = wire::clean_line(&input.title, wire::MAX_TITLE_CHARS);
        if title.is_empty() {
            title = wire::clean_line(text.lines().next().unwrap_or(""), 80);
        }
        let devices: Vec<String> = member.devices.iter().map(|d| d.id.clone()).filter(|d| *d != me_device).collect();
        if devices.is_empty() {
            return Err("They have no PC on the team yet.".into());
        }
        {
            let inner = lock(&self.inner);
            let open = inner.saved.sent.iter().filter(|t| t.to_member == member.id && t.state.open()).count();
            if open >= MAX_OPEN_PER_PERSON {
                return Err(format!("You already have {MAX_OPEN_PER_PERSON} open tasks with {}. Wait for them to answer.", member.display));
            }
        }
        let id = new_id("tk");
        let lend = match &input.lend {
            None => None,
            Some(l) => {
                if !self.deps.lend.enabled() {
                    return Err("Lent usage is off. Turn on Share an agent in Settings first.".into());
                }
                let (name, agents) = self.deps.lend.profile_for_task(&member.id, &l.profile_id, l.secs)?;
                let agent = agents.first().cloned().ok_or("That lend profile has no agent.")?;
                Some(LendOffer { profile_id: l.profile_id.clone(), profile_name: name, agent_id: agent, secs: l.secs })
            }
        };
        let (repo, bundle_path) = match &input.repo {
            None => (None, None),
            Some(r) => {
                if !lock(&self.inner).saved.handover_on {
                    return Err("Sending a repo is off on this PC. Turn on “Allow repo hand-over” first.".into());
                }
                if !r.understood {
                    return Err("Tick “I understand” first. A copy of your code goes to another person's PC.".into());
                }
                let made = bundle::make(Path::new(&r.path), r.history, &id, &self.out_dir())?;
                (Some(made.offer), Some(made.path.to_string_lossy().to_string()))
            }
        };
        let body = Body::Task { id: id.clone(), title: title.clone(), text: text.clone(), summary: summary.clone(), repo: repo.clone(), lend: lend.clone() };
        let mut sent_to = 0;
        let mut last_error = String::new();
        for d in &devices {
            match self.send_to(&session, d, body.clone()) {
                Ok(()) => sent_to += 1,
                Err(e) => last_error = e,
            }
        }
        if sent_to == 0 {
            if let Some(p) = &bundle_path {
                let _ = std::fs::remove_file(p);
            }
            return Err(if last_error.is_empty() { "The task could not be sent.".into() } else { last_error });
        }
        let now = self.now();
        let task = SentTask {
            id,
            to_member: member.id.clone(),
            to_name: member.display.clone(),
            to_devices: devices,
            answered_device: None,
            title,
            text,
            summary,
            repo_state: if repo.is_some() { SendRepo::Waiting } else { SendRepo::None },
            repo,
            lend,
            lend_used: false,
            state: SentState::Sent,
            at_ms: now,
            updated_ms: now,
            note: String::new(),
            repo_sent: 0,
            repo_error: String::new(),
            bundle_path,
        };
        {
            let mut inner = lock(&self.inner);
            inner.saved.sent.push(task.clone());
            self.prune(&mut inner);
            self.save(&inner);
        }
        self.changed();
        Ok(task)
    }

    /// I take it back. Only before they started; the lent-usage promise ends with it.
    pub fn withdraw(&self, id: &str) -> Result<SentTask, String> {
        let session = self.deps.port.session()?;
        let task = {
            let mut inner = lock(&self.inner);
            let t = inner.saved.sent.iter_mut().find(|t| t.id == id).ok_or("That task is gone.")?;
            if !matches!(t.state, SentState::Sent | SentState::Seen | SentState::Accepted) {
                return Err("They already started it. It is too late to take back.".into());
            }
            t.state = SentState::Withdrawn;
            t.updated_ms = self.now();
            if t.repo_state == SendRepo::Waiting || t.repo_state == SendRepo::Sending {
                t.repo_state = SendRepo::Failed;
                t.repo_error = "Taken back.".into();
            }
            let t = t.clone();
            if let Some(p) = &t.bundle_path {
                let _ = std::fs::remove_file(p);
            }
            self.save(&inner);
            t
        };
        for d in &task.to_devices {
            let _ = self.send_to(&session, d, Body::Withdrawn { id: id.to_string() });
        }
        self.changed();
        Ok(task)
    }

    // --------------------------------------------------------------------------------------------- answering

    fn with_recv<R>(&self, id: &str, f: impl FnOnce(&mut RecvTask, u64) -> Result<R, String>) -> Result<(R, RecvTask), String> {
        let mut inner = lock(&self.inner);
        let now = self.now();
        let t = inner.saved.received.iter_mut().find(|t| t.id == id).ok_or("That task is gone.")?;
        let r = f(t, now)?;
        t.updated_ms = now;
        let t = t.clone();
        self.save(&inner);
        Ok((r, t))
    }

    fn reply(&self, task: &RecvTask, state: ReplyState, want_repo: bool, note: &str) {
        let Ok(session) = self.deps.port.session() else { return };
        let body = Body::Reply { id: task.id.clone(), state, want_repo, note: note.to_string() };
        if let Err(e) = self.send_to(&session, &task.from_device, body) {
            tracing::info!(why = %e, "team tasks: a reply could not be sent");
        }
    }

    /// The person looked at the task: the sender sees "Seen". Sent once.
    pub fn seen(&self, id: &str) -> Result<(), String> {
        let (changed, task) = self.with_recv(id, |t, _| {
            if t.state == RecvState::New {
                t.state = RecvState::Seen;
                Ok(true)
            } else {
                Ok(false)
            }
        })?;
        if changed {
            self.reply(&task, ReplyState::Seen, false, "");
            self.changed();
        }
        Ok(())
    }

    pub fn decline(&self, id: &str) -> Result<RecvTask, String> {
        let (_, task) = self.with_recv(id, |t, _| {
            if !matches!(t.state, RecvState::New | RecvState::Seen) {
                return Err("You already answered this one.".into());
            }
            t.state = RecvState::Declined;
            Ok(())
        })?;
        self.reply(&task, ReplyState::Declined, false, "");
        self.changed();
        Ok(task)
    }

    /// Yes. Records the answer and tells the sender; with "their usage" it sends the normal lend request that names the
    /// task; with the repo it asks for the copy. It starts nothing: `Start...` opens the New agent page, and the person
    /// presses the button there.
    pub fn accept(&self, id: &str, input: AcceptInput) -> Result<RecvTask, String> {
        let handover_on = lock(&self.inner).saved.handover_on;
        // "Use my own agent instead" after the lend request failed: the same task, no new answer to the sender.
        if input.usage == Usage::Theirs && !input.want_repo {
            let switched = lock(&self.inner).saved.received.iter().any(|t| t.id == id && t.state == RecvState::Accepted && !t.lend_error.is_empty());
            if switched {
                let (_, task) = self.with_recv(id, |t, _| {
                    t.usage = Usage::Theirs;
                    t.lend_error.clear();
                    Ok(())
                })?;
                self.changed();
                return Ok(task);
            }
        }
        let (_, task) = self.with_recv(id, |t, _| {
            if !matches!(t.state, RecvState::New | RecvState::Seen) {
                return Err("You already answered this one.".into());
            }
            if input.usage == Usage::Lent {
                if t.lend.is_none() {
                    return Err("This task does not come with lent usage.".into());
                }
                if !self.deps.lend.enabled() {
                    return Err("Lent usage is off. Turn on Share an agent in Settings first.".into());
                }
            }
            if input.want_repo {
                if t.repo.is_none() {
                    return Err("This task does not come with a repo.".into());
                }
                if !handover_on {
                    return Err("Getting a repo is off on this PC. Turn on “Allow repo hand-over” first.".into());
                }
                if !input.understood {
                    return Err("Tick “I understand” first. You get code from another person, and nothing checks it.".into());
                }
            }
            t.state = RecvState::Accepted;
            t.usage = input.usage;
            if input.want_repo {
                t.repo_state = RecvRepo::Receiving;
                t.repo_got = 0;
            }
            Ok(())
        })?;
        if input.want_repo {
            let offer = task.repo.clone().ok_or("This task does not come with a repo.")?;
            let part = self.in_dir().join(format!("{id}.part"));
            let assembly = Assembly::start(part, &offer)?;
            lock(&self.inner).assemblies.insert(id.to_string(), assembly);
        }
        self.reply(&task, ReplyState::Accepted, input.want_repo, "");
        let mut task = task;
        if input.usage == Usage::Lent {
            if let Some(offer) = task.lend.clone() {
                let reason: String = format!("For a task: {}", task.title).chars().take(200).collect();
                if let Err(e) = self.deps.lend.request(&task.from_member, &task.from_device, &offer, &reason, &task.id) {
                    let (_, t) = self.with_recv(id, |t, _| {
                        t.lend_error = e.clone();
                        Ok(())
                    })?;
                    task = t;
                }
            }
        }
        self.changed();
        Ok(task)
    }

    /// The person pressed Start on the New agent page for this task.
    pub fn started(&self, id: &str) -> Result<RecvTask, String> {
        let (changed, task) = self.with_recv(id, |t, _| {
            if t.state == RecvState::Accepted {
                t.state = RecvState::Started;
                Ok(true)
            } else {
                Ok(false)
            }
        })?;
        if changed {
            self.reply(&task, ReplyState::Started, false, "");
            self.changed();
        }
        Ok(task)
    }

    /// "Tell {name} it is done": the note is the person's own words, nothing from the chat goes by itself.
    pub fn done(&self, id: &str, note: &str) -> Result<RecvTask, String> {
        let note = wire::clean_text(note, wire::MAX_NOTE_CHARS);
        let (_, task) = self.with_recv(id, |t, _| {
            if !matches!(t.state, RecvState::Accepted | RecvState::Started) {
                return Err("Say yes to the task first.".into());
            }
            t.state = RecvState::Done;
            Ok(())
        })?;
        self.reply(&task, ReplyState::Done, false, &note);
        self.changed();
        Ok(task)
    }

    /// Puts a received repo copy into a NEW folder under `parent` (never an existing one). Nothing in it is run.
    pub fn unpack(&self, id: &str, parent: &Path) -> Result<String, String> {
        let (path, offer) = {
            let inner = lock(&self.inner);
            let t = inner.saved.received.iter().find(|t| t.id == id).ok_or("That task is gone.")?;
            if t.repo_state != RecvRepo::Ready {
                return Err("The repo has not arrived yet.".into());
            }
            (t.bundle_path.clone().ok_or("The repo copy is gone.")?, t.repo.clone().ok_or("The repo copy is gone.")?)
        };
        let folder = bundle::unpack(Path::new(&path), &offer, parent, &self.deps.dir.join("nohooks"), id)?;
        let shown = folder.to_string_lossy().to_string();
        self.with_recv(id, |t, _| {
            t.repo_state = RecvRepo::Unpacked;
            t.unpacked = Some(shown.clone());
            t.bundle_path = None;
            Ok(())
        })?;
        let _ = std::fs::remove_file(&path);
        self.changed();
        Ok(shown)
    }

    // --------------------------------------------------------------------------------------------- arriving items

    /// One item from the team relay. Anything that fails a check is dropped (and logged without its content).
    pub fn on_item(&self, cin: &CapacityIn) -> Result<(), WireReject> {
        let session = self.deps.port.session().map_err(|_| WireReject::Undecryptable)?;
        let kem = session.keys.device_kem().map_err(|_| WireReject::Undecryptable)?;
        let now = self.now();
        let item = wire::open(&session, &kem, cin, now)?;
        {
            let mut inner = lock(&self.inner);
            inner.saved.guard.fresh(&item.msg_id, now)?;
            self.save(&inner);
        }
        self.apply(&session, item, now)
    }

    fn apply(&self, session: &Session, item: wire::Item, now: u64) -> Result<(), WireReject> {
        let from_name = session.roster.member(&item.from_member).map(|m| wire::clean_line(&m.display, wire::MAX_NAME_CHARS)).unwrap_or_default();
        match item.body {
            Body::Task { id, title, text, summary, repo, lend } => {
                let mut inner = lock(&self.inner);
                if inner.saved.received.iter().any(|t| t.id == id) {
                    return Err(WireReject::Replay);
                }
                let open = inner.saved.received.iter().filter(|t| t.from_member == item.from_member && t.state.open()).count();
                if open >= MAX_OPEN_FROM_PERSON {
                    return Err(WireReject::BadItem);
                }
                let text = wire::clean_text(&text, usize::MAX);
                let risk = risk_words(&text);
                inner.saved.received.push(RecvTask {
                    id,
                    from_member: item.from_member.clone(),
                    from_name,
                    from_device: item.from_device.clone(),
                    title: wire::clean_line(&title, wire::MAX_TITLE_CHARS),
                    text,
                    summary: wire::clean_text(&summary, usize::MAX),
                    repo_state: if repo.is_some() { RecvRepo::Offered } else { RecvRepo::None },
                    repo: repo.map(|mut r| {
                        r.name = wire::clean_line(&r.name, wire::MAX_NAME_CHARS);
                        r
                    }),
                    lend: lend.map(|mut l| {
                        l.profile_name = wire::clean_line(&l.profile_name, wire::MAX_NAME_CHARS);
                        l
                    }),
                    state: RecvState::New,
                    at_ms: now,
                    updated_ms: now,
                    risk,
                    usage: Usage::Theirs,
                    lend_error: String::new(),
                    repo_got: 0,
                    repo_error: String::new(),
                    bundle_path: None,
                    unpacked: None,
                });
                self.prune(&mut inner);
                self.save(&inner);
            }
            Body::Reply { id, state, want_repo, note } => {
                let mut stream = false;
                let mut siblings: Vec<String> = Vec::new();
                {
                    let mut inner = lock(&self.inner);
                    let t = inner
                        .saved
                        .sent
                        .iter_mut()
                        .find(|t| t.id == id && t.to_member == item.from_member && t.to_devices.contains(&item.from_device))
                        .ok_or(WireReject::BadItem)?;
                    if t.state == SentState::Withdrawn {
                        return Ok(());
                    }
                    if t.answered_device.as_ref().is_some_and(|d| *d != item.from_device) {
                        // Another PC of theirs answered first.
                        return Ok(());
                    }
                    let before = t.state;
                    let first_answer = t.answered_device.is_none();
                    match state {
                        ReplyState::Seen => {
                            if before == SentState::Sent {
                                t.state = SentState::Seen;
                            }
                        }
                        ReplyState::Declined => {
                            if matches!(before, SentState::Sent | SentState::Seen) {
                                t.state = SentState::Declined;
                                t.answered_device = Some(item.from_device.clone());
                            }
                        }
                        ReplyState::Accepted | ReplyState::Started | ReplyState::Done => {
                            let target = match state {
                                ReplyState::Accepted => SentState::Accepted,
                                ReplyState::Started => SentState::Started,
                                _ => SentState::Done,
                            };
                            let from_ok = match target {
                                SentState::Done => matches!(before, SentState::Sent | SentState::Seen | SentState::Accepted | SentState::Started),
                                _ => matches!(before, SentState::Sent | SentState::Seen | SentState::Accepted),
                            };
                            if from_ok && target.rank() >= before.rank() {
                                t.state = target;
                                t.answered_device = Some(item.from_device.clone());
                                if target == SentState::Done {
                                    t.note = wire::clean_text(&note, wire::MAX_NOTE_CHARS);
                                }
                            }
                            if state == ReplyState::Accepted && want_repo && t.repo_state == SendRepo::Waiting && t.state == SentState::Accepted {
                                t.repo_state = SendRepo::Sending;
                                stream = true;
                            }
                        }
                    }
                    if first_answer && t.answered_device.is_some() {
                        siblings = t.to_devices.iter().filter(|d| **d != item.from_device).cloned().collect();
                    }
                    if t.state != before || stream {
                        t.updated_ms = now;
                    }
                    self.save(&inner);
                }
                for d in &siblings {
                    let _ = self.send_to(session, d, Body::Withdrawn { id: id.clone() });
                }
                if stream {
                    if let Some(me) = self.me.upgrade() {
                        let id = id.clone();
                        (self.deps.spawn)(Box::new(move || me.stream_repo(&id)));
                    }
                }
            }
            Body::Withdrawn { id } => {
                let mut inner = lock(&self.inner);
                let part = {
                    let t = inner.saved.received.iter_mut().find(|t| t.id == id && t.from_member == item.from_member && t.from_device == item.from_device).ok_or(WireReject::BadItem)?;
                    if matches!(t.state, RecvState::Started | RecvState::Done | RecvState::Declined) {
                        return Ok(());
                    }
                    t.state = RecvState::Withdrawn;
                    t.updated_ms = now;
                    if matches!(t.repo_state, RecvRepo::Receiving | RecvRepo::Offered) {
                        t.repo_state = RecvRepo::None;
                    }
                    t.bundle_path.take()
                };
                inner.assemblies.remove(&id);
                let _ = std::fs::remove_file(self.in_dir().join(format!("{id}.part")));
                if let Some(p) = part {
                    let _ = std::fs::remove_file(p);
                }
                self.save(&inner);
            }
            Body::Chunk { id, idx, data } => self.take_chunk(&item.from_member, &item.from_device, &id, idx, &data)?,
        }
        self.changed();
        Ok(())
    }

    /// One piece of a repo copy I asked for: from the sender of that task only, in order, inside the offer's limits.
    fn take_chunk(&self, member: &str, device: &str, id: &str, idx: u32, data: &str) -> Result<(), WireReject> {
        let bytes = unb64(data).ok_or(WireReject::BadItem)?;
        let mut inner = lock(&self.inner);
        let Some(pos) = inner.saved.received.iter().position(|t| t.id == id && t.from_member == member && t.from_device == device) else {
            return Err(WireReject::BadItem);
        };
        {
            let t = &inner.saved.received[pos];
            if t.repo_state != RecvRepo::Receiving || !matches!(t.state, RecvState::Accepted | RecvState::Started) {
                // Not asked for (or already done): a piece nobody wanted is dropped.
                return Err(WireReject::BadItem);
            }
        }
        let offer = inner.saved.received[pos].repo.clone().ok_or(WireReject::BadItem)?;
        if !inner.assemblies.contains_key(id) {
            // The app was closed part way: the pieces already taken are not kept, and the sender has not kept the copy.
            let t = &mut inner.saved.received[pos];
            t.repo_state = RecvRepo::Failed;
            t.repo_error = "The copy stopped when the app was closed. Ask them to pass the task again.".into();
            let _ = std::fs::remove_file(self.in_dir().join(format!("{id}.part")));
            self.save(&inner);
            return Err(WireReject::BadItem);
        }
        let outcome = inner.assemblies.get_mut(id).map(|a| a.push(idx, &bytes).map(|_| (a.got, a.complete(), a.path.clone())));
        match outcome {
            Some(Ok((next, complete, path))) => {
                inner.saved.received[pos].repo_got = next;
                if complete {
                    inner.assemblies.remove(id);
                    let t = &mut inner.saved.received[pos];
                    match bundle::verify(&path, &offer) {
                        Ok(()) => {
                            t.repo_state = RecvRepo::Ready;
                            t.bundle_path = Some(path.to_string_lossy().to_string());
                        }
                        Err(e) => {
                            t.repo_state = RecvRepo::Failed;
                            t.repo_error = e;
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
                self.save(&inner);
                Ok(())
            }
            Some(Err(e)) => {
                let t = &mut inner.saved.received[pos];
                t.repo_state = RecvRepo::Failed;
                t.repo_error = e;
                inner.assemblies.remove(id);
                let _ = std::fs::remove_file(self.in_dir().join(format!("{id}.part")));
                self.save(&inner);
                Err(WireReject::BadItem)
            }
            None => Err(WireReject::BadItem),
        }
    }

    /// Sender: the pieces of the copy, one after another, each sealed to the PC that said yes. Stops when the task is taken back.
    pub fn stream_repo(&self, id: &str) {
        let Ok(session) = self.deps.port.session() else { return self.fail_stream(id, "Team is off.") };
        let (path, device, chunks) = {
            let inner = lock(&self.inner);
            let Some(t) = inner.saved.sent.iter().find(|t| t.id == id) else { return };
            let (Some(path), Some(device), Some(repo)) = (t.bundle_path.clone(), t.answered_device.clone(), t.repo.clone()) else { return };
            (path, device, repo.chunks)
        };
        let Ok(all) = std::fs::read(&path) else { return self.fail_stream(id, "The copy is gone from this PC.") };
        for idx in 0..chunks {
            {
                let inner = lock(&self.inner);
                let alive = inner.saved.sent.iter().find(|t| t.id == id).is_some_and(|t| t.repo_state == SendRepo::Sending && t.state.open());
                if !alive {
                    return;
                }
            }
            let start = idx as usize * wire::CHUNK_BYTES;
            let end = (start + wire::CHUNK_BYTES).min(all.len());
            let body = Body::Chunk { id: id.to_string(), idx, data: b64(&all[start..end]) };
            let mut sent = Err(String::new());
            for attempt in 0..4u64 {
                sent = self.send_to(&session, &device, body.clone());
                if sent.is_ok() {
                    break;
                }
                if self.deps.pace_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(500 * (attempt + 1)));
                }
            }
            if let Err(e) = sent {
                return self.fail_stream(id, &format!("The relay did not take it: {e}"));
            }
            {
                let mut inner = lock(&self.inner);
                if let Some(t) = inner.saved.sent.iter_mut().find(|t| t.id == id) {
                    t.repo_sent = idx + 1;
                }
            }
            self.changed();
            if self.deps.pace_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.deps.pace_ms));
            }
        }
        let mut inner = lock(&self.inner);
        if let Some(t) = inner.saved.sent.iter_mut().find(|t| t.id == id) {
            t.repo_state = SendRepo::Sent;
            t.bundle_path = None;
            t.updated_ms = self.now();
        }
        let _ = std::fs::remove_file(&path);
        self.save(&inner);
        drop(inner);
        self.changed();
    }

    fn fail_stream(&self, id: &str, why: &str) {
        let mut inner = lock(&self.inner);
        if let Some(t) = inner.saved.sent.iter_mut().find(|t| t.id == id) {
            t.repo_state = SendRepo::Failed;
            t.repo_error = why.to_string();
            t.updated_ms = self.now();
        }
        self.save(&inner);
        drop(inner);
        self.changed();
    }
}

impl crate::capacity_proxy::service::OfferGate for Direct {
    /// The lent usage I promised with a task: yes once, for the person, the profile and the time I named.
    fn claim(&self, offer_ref: &str, member_id: &str, device_id: &str, profile_id: Option<&str>, secs: u64) -> bool {
        let mut inner = lock(&self.inner);
        let Some(t) = inner.saved.sent.iter_mut().find(|t| t.id == offer_ref) else { return false };
        let Some(offer) = t.lend.clone() else { return false };
        let ok = t.state.open()
            && !t.lend_used
            && t.to_member == member_id
            && t.to_devices.iter().any(|d| d == device_id)
            && profile_id == Some(offer.profile_id.as_str())
            && secs <= offer.secs;
        if ok {
            t.lend_used = true;
            t.updated_ms = (self.deps.now)();
            self.save(&inner);
        }
        drop(inner);
        if ok {
            self.changed();
        }
        ok
    }
}
