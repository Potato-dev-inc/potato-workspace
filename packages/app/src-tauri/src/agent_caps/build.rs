//! The pure part: one capability table from what is known. No file, no process, no clock except `build`.

use super::types::*;
use super::{DefFacts, HandshakeFacts, SeenFact};
use crate::tui::declarative::wizard::exec::mask_private;

const PROOF_MAX: usize = 160;

/// A value with its proof. The proof is masked and cut to `PROOF_MAX` characters.
pub fn cap(value: Tri, source: Source, proof: &str, at: &str) -> Cap {
    if source == Source::Unknown || value == Tri::Unknown {
        return Cap::default();
    }
    let masked = mask_private(proof);
    let proof: String = masked.chars().take(PROOF_MAX).collect();
    let proof = if proof.trim().is_empty() { "recorded".to_string() } else { proof };
    Cap { value, source, proof, at: Some(at.to_string()) }
}

fn rank(source: Source) -> u8 {
    match source {
        Source::Seen => 4,
        Source::Handshake => 3,
        Source::Check => 2,
        Source::Definition => 1,
        Source::Unknown => 0,
    }
}

/// The strongest known proof wins: seen > handshake > check > definition. A later one wins a tie.
fn best(candidates: Vec<Cap>) -> Cap {
    let mut out = Cap::default();
    for c in candidates {
        if c.value == Tri::Unknown {
            continue;
        }
        if rank(c.source) >= rank(out.source) {
            out = c;
        }
    }
    out
}

/// An agent seen to change files or run commands without asking, even once, does not "ask before": the newest No wins.
fn best_no_wins(candidates: Vec<Cap>) -> Cap {
    match candidates.iter().rposition(|c| c.value == Tri::No) {
        Some(i) => candidates[i].clone(),
        None => best(candidates),
    }
}

fn tri(yes: bool) -> Tri {
    if yes {
        Tri::Yes
    } else {
        Tri::No
    }
}

/// The time stamped on proofs that come from a definition (they have no time of their own): one fixed value for the
/// whole run of the app, so two reads of the same table agree.
fn definition_stamp() -> &'static str {
    static STAMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STAMP.get_or_init(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// `build_at` with the app's start time for definition proofs.
pub fn build(def: &DefFacts, hs: Option<&HandshakeFacts>, seen: &[SeenFact]) -> AgentCaps {
    build_at(def, hs, seen, definition_stamp())
}

/// Pure: `now` stamps the proofs that come from the definition (they have no time of their own).
pub fn build_at(def: &DefFacts, hs: Option<&HandshakeFacts>, seen: &[SeenFact], now: &str) -> AgentCaps {
    let mut out = AgentCaps {
        schema: CAPS_SCHEMA,
        agent_id: def.agent_id.clone(),
        label: def.label.clone(),
        ..Default::default()
    };
    let hs_at = |h: &HandshakeFacts| if h.at.is_empty() { now.to_string() } else { h.at.clone() };

    // ---- chat
    let mut chat = Vec::new();
    // A shipped chat table alone is not a proof the chat works (spec 1.3): only a handshake says yes to it.
    if def.shipped && def.has_headless {
        chat.push(cap(Tri::Yes, Source::Definition, "shipped one-task setup", now));
    }
    if let Some(h) = hs {
        let at = hs_at(h);
        if h.init_ok {
            let proof = match h.protocol_version {
                Some(p) => format!("answered initialize, protocol {p}"),
                None => "answered initialize".to_string(),
            };
            chat.push(cap(Tri::Yes, Source::Handshake, &proof, &at));
        } else if let Some(reason) = &h.no_chat_reason {
            let text = if reason.trim().is_empty() { "no chat way found" } else { reason.as_str() };
            chat.push(cap(Tri::No, Source::Check, text, &at));
        }
    }
    out.chat = best(chat);
    let chat_note = def.shipped && def.has_acp && out.chat.value == Tri::Unknown;
    if chat_note {
        // Unknown, but the person can see why: the setup is shipped and the chat was never checked here.
        out.chat = Cap { value: Tri::Unknown, source: Source::Definition, proof: if hs.is_some_and(|h| h.terminal_only) { "added for terminal use, chat not checked" } else { "shipped chat setup, not checked yet" }.into(), at: Some(now.to_string()) };
    }
    out.program_version = hs.and_then(|h| h.program_version.clone()).filter(|v| !v.trim().is_empty());

    // ---- level
    match (out.chat.value, out.chat.source) {
        (Tri::Yes, Source::Handshake) => {
            out.level = if def.reviewed_adapter { Level::L1 } else { Level::L0 };
            out.level_proof = Cap { value: Tri::Yes, ..out.chat.clone() };
        }
        (Tri::Yes, _) => {
            out.level = if !def.has_acp {
                Level::L2
            } else if def.reviewed_adapter {
                Level::L1
            } else {
                Level::L0
            };
            out.level_proof = Cap { value: Tri::Yes, ..out.chat.clone() };
        }
        (Tri::No, _) => {
            out.level = Level::L5;
            out.level_proof = Cap { value: Tri::Yes, ..out.chat.clone() };
        }
        _ => {
            out.level = Level::L5;
            let terminal_only = hs.is_some_and(|h| h.terminal_only);
            let why = if terminal_only {
                "added for terminal use, chat not checked"
            } else if chat_note {
                "chat not checked yet"
            } else {
                "no chat way recorded"
            };
            out.level_proof = cap(Tri::Yes, Source::Check, why, now);
        }
    }

    // ---- resume, pictures, models
    let mut resume = Vec::new();
    let mut images = Vec::new();
    let mut model_pick = Vec::new();
    let mut hs_models: Option<(Vec<String>, u32)> = None;
    let mut def_models: Option<(Vec<String>, u32)> = None;
    if def.shipped && def.resumable_headless {
        resume.push(cap(Tri::Yes, Source::Definition, "shipped setup resumes a chat", now));
    }
    if def.shipped && !def.definition_models.is_empty() {
        let n = def.definition_models.len() as u32;
        model_pick.push(cap(Tri::Yes, Source::Definition, &format!("shipped setup lists {n} models"), now));
        def_models = Some((def.definition_models.clone(), n));
    }
    if let Some(h) = hs {
        let at = hs_at(h);
        if h.init_ok {
            if h.load_session || h.resume {
                resume.push(cap(Tri::Yes, Source::Handshake, "said it can load or resume a chat", &at));
            } else {
                resume.push(cap(Tri::No, Source::Handshake, "said it cannot load or resume a chat", &at));
            }
            let text = if h.image_prompts { "said it takes pictures" } else { "said it does not take pictures" };
            images.push(cap(tri(h.image_prompts), Source::Handshake, text, &at));
        }
        if h.init_ok && h.session_new_ok {
            if h.models.is_empty() {
                model_pick.push(cap(Tri::No, Source::Handshake, "new-chat reply had no model option", &at));
            } else {
                let total = h.models_total.max(h.models.len() as u32);
                model_pick.push(cap(Tri::Yes, Source::Handshake, &format!("new-chat reply listed {total} models"), &at));
                hs_models = Some((h.models.clone(), total));
            }
        }
    }
    out.resume = best(resume);
    out.images = best(images);
    out.model_pick = best(model_pick);
    // The model list comes from the same source as the winning proof.
    let from = match (out.model_pick.value, out.model_pick.source) {
        (Tri::Yes, Source::Handshake) => hs_models,
        (Tri::Yes, Source::Definition) => def_models,
        _ => None,
    };
    if let Some((list, total)) = from {
        out.models = list.into_iter().take(MAX_MODELS).collect();
        out.models_total = total.max(out.models.len() as u32);
    }

    // ---- read only: the run table's answer, shipped facts only
    if def.shipped {
        out.read_only = if def.read_only_mapped {
            cap(Tri::Yes, Source::Definition, "shipped setup can run read-only", now)
        } else {
            cap(Tri::No, Source::Definition, "no read-only mapping", now)
        };
    }

    // ---- seen in real turns (newest wins per field)
    let (mut tool, mut edit, mut ask_edit, mut ask_shell, mut stop, mut usage) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for fact in seen {
        match fact {
            SeenFact::ToolCall { at } => tool.push(cap(Tri::Yes, Source::Seen, "a tool card appeared in a chat", at)),
            SeenFact::EditDone { at, asked } => {
                edit.push(cap(Tri::Yes, Source::Seen, "a file change finished in a chat", at));
                let (v, p) = if *asked { (Tri::Yes, "asked before a file change") } else { (Tri::No, "changed a file without asking") };
                ask_edit.push(cap(v, Source::Seen, p, at));
            }
            SeenFact::ShellDone { at, asked } => {
                let (v, p) = if *asked { (Tri::Yes, "asked before running a command") } else { (Tri::No, "ran a command without asking") };
                ask_shell.push(cap(v, Source::Seen, p, at));
            }
            SeenFact::StopWorked { at, ms } => stop.push(cap(Tri::Yes, Source::Seen, &format!("Stop ended the turn in {ms} ms"), at)),
            SeenFact::StopIgnored { at } => stop.push(cap(Tri::No, Source::Seen, "Stop was sent and the turn kept running", at)),
            SeenFact::Usage { at } => usage.push(cap(Tri::Yes, Source::Seen, "a usage update arrived", at)),
        }
    }
    out.shows_steps = best(tool);
    out.edits_files = best(edit);
    out.asks_before_edit = best_no_wins(ask_edit);
    out.asks_before_shell = best_no_wins(ask_shell);
    out.stop = best(stop);
    out.usage = best(usage);
    out
}

impl AgentCaps {
    /// The invariants of the spec (1.2, rules 1 to 3). Empty = fine.
    pub fn check(&self) -> Vec<String> {
        let mut bad = Vec::new();
        let caps: [(&str, &Cap); 12] = [
            ("level_proof", &self.level_proof),
            ("chat", &self.chat),
            ("resume", &self.resume),
            ("shows_steps", &self.shows_steps),
            ("edits_files", &self.edits_files),
            ("asks_before_edit", &self.asks_before_edit),
            ("asks_before_shell", &self.asks_before_shell),
            ("model_pick", &self.model_pick),
            ("stop", &self.stop),
            ("images", &self.images),
            ("usage", &self.usage),
            ("read_only", &self.read_only),
        ];
        for (name, c) in caps {
            if c.value != Tri::Unknown && (c.source == Source::Unknown || c.proof.trim().is_empty() || c.at.is_none()) {
                bad.push(format!("{name}: a value without source, proof and time"));
            }
            if c.source == Source::Unknown && c.value != Tri::Unknown {
                bad.push(format!("{name}: unknown source with a value"));
            }
            if c.proof.chars().count() > PROOF_MAX {
                bad.push(format!("{name}: proof is longer than {PROOF_MAX}"));
            }
        }
        if self.model_pick.value == Tri::Yes && self.models.is_empty() {
            bad.push("model_pick is yes but models is empty".into());
        }
        if self.chat.value == Tri::No && self.level != Level::L5 {
            bad.push("chat is no but level is not l5".into());
        }
        if self.models.len() > MAX_MODELS {
            bad.push("models is longer than the cap".into());
        }
        bad
    }
}
