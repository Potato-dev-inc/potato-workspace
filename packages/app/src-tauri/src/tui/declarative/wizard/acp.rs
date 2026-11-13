//! Chat (ACP) agents in the wizard (SPEC 12): two actions that never start a program.
//!
//! * `acp_detect` reads the probe output the session already holds and says how the program offers the
//!   Agent Client Protocol: a subcommand row (`acp`), a flag (`--acp`, `--experimental-acp`...), plus a hint
//!   when `--stdio` is mentioned. Patterns only, never an agent's name.
//! * `acp_finish` writes an UNAPPROVED chat-only definition (`[agent] kind = "generic"`, `[binary]`, `[acp]`) the
//!   way `finish` writes a terminal one: create-new, `<id>.wizard.json` first, the TOML last, nothing left
//!   behind on a failure. It never approves; the person does that in the normal dialog.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

use crate::tui::declarative::approvals::now_rfc3339;
use crate::tui::declarative::schema::parse_definition;
use crate::tui::declarative::validate::{validate, Source, ValidationContext, MAX_DEFINITION_BYTES};
use crate::tui::declarative::DeclarativeProfile;

use super::acp_check::{check_initialize, InitCheck, CHECK_TIMEOUT};
use super::exec::{cut_chars, mask_private};
use super::report::WizardError;
use super::session::{sha256_hex, Session, State, Wizard};

const MAX_CANDIDATES: usize = 6;
const MAX_EVIDENCE_CHARS: usize = 160;
/// The drafter name `<id>.wizard.json` records for these definitions.
pub const DRAFTER: &str = "wizard-acp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub args: Vec<String>,
    pub evidence: String,
    pub high: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Detection {
    pub candidates: Vec<Candidate>,
    /// `--stdio` appears somewhere in the help.
    pub stdio_hint: Option<String>,
    /// The words "Agent Client Protocol" appear somewhere in the help.
    pub mentions_protocol: bool,
}

static FLAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|[\s,\[|(])(--(?:[a-z0-9]+-)*acp(?:-[a-z0-9]+)*)(?:[=\s,\]|)<]|$)").expect("acp flag"));
static PROTOCOL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)agent[ -]client[ -]protocol").expect("acp protocol"));
static STDIO: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[\s,\[|(])--stdio(?:[=\s,\]|)<]|$)").expect("stdio flag"));

fn bare(name: &str) -> String {
    let lower = name.trim().to_ascii_lowercase();
    match lower.rsplit_once('.') {
        Some((stem, ext)) if ["exe", "cmd", "bat", "ps1", "com"].contains(&ext) => stem.to_string(),
        _ => lower,
    }
}

fn evidence(line: &str) -> String {
    cut_chars(&mask_private(&line.split_whitespace().collect::<Vec<_>>().join(" ")), MAX_EVIDENCE_CHARS)
}

/// Is this line a subcommand row for `acp`: `  acp   description`, `  prog acp [options]`, `Usage: prog acp`?
fn is_subcommand_row(line: &str, program: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let indented = line.starts_with(char::is_whitespace);
    if indented && tokens.first().is_some_and(|t| *t == "acp") {
        return true;
    }
    tokens.windows(2).any(|w| bare(w[0]) == program && w[1] == "acp")
}

/// How the help texts say the program speaks ACP. Pure text analysis.
pub fn detect_in_texts(command: &str, texts: &[&str]) -> Detection {
    let program = bare(command);
    let mut out = Detection::default();
    for text in texts {
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let stdio_here = STDIO.is_match(line);
            if stdio_here && out.stdio_hint.is_none() {
                out.stdio_hint = Some(evidence(line));
            }
            if PROTOCOL.is_match(line) {
                out.mentions_protocol = true;
            }
            let mut found: Vec<(Vec<String>, bool)> = Vec::new();
            if is_subcommand_row(line, &program) {
                found.push((vec!["acp".to_string()], true));
            }
            for cap in FLAG.captures_iter(line) {
                let flag = cap[1].to_string();
                if flag.starts_with("--no-") || flag.contains("-disable") {
                    continue;
                }
                let option_row = trimmed.starts_with('-');
                let exact = flag == "--acp" || flag == "--experimental-acp";
                found.push((vec![flag], option_row && exact));
            }
            for (mut args, high) in found {
                if stdio_here {
                    args.push("--stdio".to_string());
                }
                if out.candidates.iter().any(|c| c.args == args) {
                    continue;
                }
                out.candidates.push(Candidate { args, evidence: evidence(line), high });
            }
        }
    }
    out.candidates.sort_by_key(|c| !c.high);
    out.candidates.truncate(MAX_CANDIDATES);
    out
}

/// `initialize_check` is the real ACP check's answer (`acp_check`), or `null` when none ran: help text alone.
///
/// Help text alone never earns "high": when a handshake ran and failed, the candidates drop to "medium" (the screen
/// shows the check's reason beside them); when it did not run, the help-only confidence is kept and `initialize_check`
/// stays `null`.
fn detection_json(command: &str, d: &Detection, check: Option<&InitCheck>) -> Value {
    let failed = check.is_some_and(|c| !c.ok);
    let candidates: Vec<Value> = d
        .candidates
        .iter()
        .map(|c| json!({"command": command, "args": c.args, "evidence": c.evidence, "confidence": if c.high && !failed { "high" } else { "medium" }}))
        .collect();
    json!({
        "ok": true,
        "command": command,
        "candidates": candidates,
        "stdio_hint": d.stdio_hint,
        "mentions_protocol": d.mentions_protocol,
        "initialize_check": check.map(InitCheck::to_json),
    })
}

/// `POST /agents/wizard/acp_detect` `{session}`. Needs the probe to have run.
pub fn detect(wizard: &Wizard, body: &Value) -> Result<Value, WizardError> {
    use super::locate::{command_name, locate, search_dirs};
    let id = super::api::session_id(body)?;
    // The stored text is read under the session lock; the handshake runs after the lock is released.
    let (command, found) = wizard.read(&id, |s| {
        let probe = s
            .probe
            .as_ref()
            .ok_or_else(|| WizardError::new(409, "WIZARD_BAD_STATE", "acp_detect reads the probe output; run probe first"))?;
        let texts: Vec<&str> = probe.runs.iter().filter(|r| r.duplicate_of.is_none()).map(|r| r.text.as_str()).collect();
        Ok((s.command.clone(), detect_in_texts(&s.command, &texts)))
    })??;
    // The same ACP check as `detect_program` (one `initialize` handshake), so the answer is never a help-only guess.
    let name = command_name(&command).unwrap_or_else(|_| command.clone());
    let dirs = search_dirs(&wizard.env());
    let program = locate(&name, &dirs).ok().map(|l| l.path);
    let (reported, found, check) = check_found(&name, program.as_deref(), &dirs, found);
    Ok(detection_json(&reported, &found, check.as_ref()))
}

/// The ACP check for a help-text detection. With a candidate, the program gets one `initialize` handshake (with the
/// candidate's arguments). With none, a sibling `<name>-acp` on PATH is reported only when its handshake answers.
/// Returns the command to report, the detection to report and the check (`None` when no handshake ran).
fn check_found(name: &str, program: Option<&Path>, dirs: &[PathBuf], mut found: Detection) -> (String, Detection, Option<InitCheck>) {
    use super::locate::locate;
    let mut reported = name.to_string();
    let mut check: Option<InitCheck> = None;
    match (found.candidates.first(), program) {
        (Some(first), Some(path)) => check = Some(check_initialize(path, &first.args, CHECK_TIMEOUT)),
        (Some(_), None) => {}
        (None, _) => {
            // Help showed no ACP command: a sibling `<name>-acp` is reported only when its handshake answers.
            let sibling = format!("{name}-acp");
            if let Ok(found_sibling) = locate(&sibling, dirs) {
                let answer = check_initialize(&found_sibling.path, &[], CHECK_TIMEOUT);
                if answer.ok {
                    found = Detection {
                        candidates: vec![Candidate { args: Vec::new(), evidence: format!("{sibling} is on this computer and answered the ACP check"), high: true }],
                        ..Detection::default()
                    };
                    reported = sibling;
                    check = Some(answer);
                }
            }
        }
    }
    (reported, found, check)
}

/// "Add chat" for an agent that is already installed: locate the program, read ONLY its help (`--help`, then
/// `-h`, stopping at the first that prints something) and analyse it. No wizard session, no
/// subcommand probing (that took a dozen runs and ~12 s for a slow-starting CLI). Same answer shape as `acp_detect`.
///
/// Then the ACP check (`acp_check`): when help shows an ACP command, that command gets one `initialize` handshake.
/// When help shows none, a sibling `<command>-acp` on PATH gets the handshake, and is reported only if it answers.
/// The help-only answer is never called confirmed: `initialize_check` is `null` unless the handshake ran.
/// Never guesses `<command> acp` or `--acp` on help that does not list them (that could start a session).
pub fn detect_program(wizard: &Wizard, command: &str) -> Result<Value, WizardError> {
    use super::exec::{self, RunSpec};
    use super::locate::{command_name, locate, probe_env, search_dirs};
    use super::session::{make_work_dir, remove_work_dir};
    let name = command_name(command)?;
    let env = wizard.env();
    let dirs = search_dirs(&env);
    let located = locate(&name, &dirs)?;
    let id = Wizard::new_id();
    let work_dir = make_work_dir(&env.temp_root, &id)?;
    let vars = probe_env();
    let mut texts: Vec<String> = Vec::new();
    // Never the bare word `help`: for some programs that is a prompt, i.e. a model call.
    for args in [["--help"], ["-h"]] {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let mut spec = RunSpec::new(&located.path, &args, &work_dir);
        spec.env = &vars;
        spec.timeout = env.limits.probe_timeout;
        spec.max_bytes = env.limits.probe_max_bytes;
        let text = super::probe::combined(&exec::run(&spec));
        let has_text = !text.trim().is_empty();
        if has_text {
            texts.push(exec::cut_bytes(&text, env.limits.probe_max_bytes));
            break;
        }
    }
    remove_work_dir(&work_dir);
    let found = detect_in_texts(&name, &texts.iter().map(String::as_str).collect::<Vec<_>>());
    let (reported, found, check) = check_found(&name, Some(&located.path), &dirs, found);
    Ok(detection_json(&reported, &found, check.as_ref()))
}

// ---- finish ----------------------------------------------------------------------------------------------

struct AcpInput {
    command: String,
    args: Vec<String>,
    env_allow: Vec<String>,
    resume_command: Vec<String>,
}

fn text_list(table: &Value, key: &str) -> Result<Vec<String>, WizardError> {
    let Some(raw) = table.get(key).filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let bad = || WizardError::bad_request(format!("acp.{key} must be a list of text"));
    raw.as_array().ok_or_else(bad)?.iter().map(|v| v.as_str().map(str::to_string).ok_or_else(bad)).collect()
}

fn parse_acp(body: &Value) -> Result<AcpInput, WizardError> {
    let t = body.get("acp").filter(|a| a.is_object()).ok_or_else(|| WizardError::bad_request("acp is required"))?;
    let command = t
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| WizardError::bad_request("acp.command is required"))?
        .to_string();
    let input = AcpInput {
        command,
        args: text_list(t, "args")?,
        env_allow: text_list(t, "env_allow")?,
        resume_command: text_list(t, "resume_command")?,
    };
    if !input.resume_command.is_empty() && !input.resume_command.iter().any(|a| a.contains("{session}")) {
        return Err(WizardError::bad_request("acp.resume_command must contain {session}"));
    }
    // No secret in a definition: anything the redactor would change is refused instead of written.
    for text in std::iter::once(&input.command).chain(&input.args).chain(&input.resume_command) {
        if crate::redact::text(text).into_inner() != *text {
            return Err(WizardError::bad_request("acp holds text that looks like a secret; a definition never holds one"));
        }
    }
    Ok(input)
}

fn quoted(text: &str) -> String {
    toml::Value::String(text.to_string()).to_string()
}

fn list(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|i| quoted(i)).collect::<Vec<_>>().join(", "))
}

/// The definition text: identity, the session's own command as `[binary]` (a definition needs a program; the
/// terminal tables are left out on purpose) and the `[acp]` table.
fn definition_text(id: &str, label: &str, command: &str, acp: &AcpInput) -> String {
    let mut out = format!(
        "schema_version = 1\n\n[agent]\nid = {}\nlabel = {}\nkind = \"generic\"\nexperimental = true\n\n[binary]\nnames = [{}]\n\n[acp]\ncommand = {}\nargs = {}\nenv_allow = {}\n",
        quoted(id),
        quoted(label),
        quoted(command),
        quoted(&acp.command),
        list(&acp.args),
        list(&acp.env_allow),
    );
    if !acp.resume_command.is_empty() {
        out.push_str(&format!("resume_command = {}\n", list(&acp.resume_command)));
    }
    out
}

fn create_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    std::io::Write::write_all(&mut f, bytes)
}

/// Validate exactly as the loader will: parse, `validate` (user source, so VAL-4 and VAL-5 hold), build the profile.
fn check_text(text: &str, code_ids: &[&str]) -> Result<(), WizardError> {
    if text.len() > MAX_DEFINITION_BYTES {
        return Err(WizardError::new(409, "AGENT_DEF_TOO_LARGE", "the definition is too large"));
    }
    let def = parse_definition(text).map_err(|e| WizardError::new(409, e.code, e.to_string()))?;
    let found = validate(&def, &ValidationContext { source: Source::User, code_ids, raw_len: text.len() });
    if let Some(first) = found.first() {
        let all: Vec<String> = found.iter().map(ToString::to_string).collect();
        return Err(WizardError::new(409, first.code, all.join(" | ")));
    }
    let profile = DeclarativeProfile::new(def).map_err(|e| WizardError::new(409, e.code, e.to_string()))?;
    if crate::tui::TuiProfile::acp_table(&profile).is_none() {
        return Err(WizardError::new(409, "AGENT_DEF_INVALID", "the definition has no [acp] table"));
    }
    Ok(())
}

fn write_files(
    session: &Session,
    agents_dir: &Path,
    id: &str,
    label: &str,
    acp: &AcpInput,
    code_ids: &[&str],
    build: &str,
) -> Result<Value, WizardError> {
    let text = definition_text(id, label, &session.command, acp);
    check_text(&text, code_ids)?;
    let toml_path = agents_dir.join(format!("{id}.toml"));
    let fixtures_dir = agents_dir.join(id);
    let provenance_path = agents_dir.join(format!("{id}.wizard.json"));
    for taken in [&toml_path, &provenance_path, &fixtures_dir] {
        if taken.exists() {
            let what = taken.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(WizardError::new(
                409,
                "WIZARD_ID_TAKEN",
                format!("the id `{id}` is already used: `{what}` exists in the agents folder (the wizard never overwrites)"),
            ));
        }
    }
    std::fs::create_dir_all(agents_dir)
        .map_err(|e| WizardError::new(500, "WIZARD_IO", format!("cannot create the agents folder: {e}")))?;
    let record = json!({
        "wizard_schema": 1,
        "id": id,
        "command": session.command,
        "created_at": now_rfc3339(),
        "drafter": {"name": DRAFTER, "kind": "other", "model": null},
        "prompt_version": "acp-1",
        "rounds": 1,
        "tested_version": session.version.number,
        "definition_sha256": sha256_hex(text.as_bytes()),
        "results": {"stages": [], "fixtures": {"passed": 0, "total": 0}},
        "acp": {"command": acp.command, "args": acp.args, "env_allow": acp.env_allow, "chat_only": true},
        "app_build": build,
    });
    let record_text = mask_private(&serde_json::to_string_pretty(&record).unwrap_or_default());
    let exists = |what: &str, path: &Path| WizardError::new(409, "WIZARD_ID_TAKEN", format!("{what} {} already exists", path.display()));
    create_new(&provenance_path, record_text.as_bytes()).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => exists("the provenance file", &provenance_path),
        _ => WizardError::new(500, "WIZARD_IO", format!("cannot write the provenance file: {e}")),
    })?;
    if let Err(e) = create_new(&toml_path, text.as_bytes()) {
        let _ = std::fs::remove_file(&provenance_path);
        return Err(match e.kind() {
            std::io::ErrorKind::AlreadyExists => exists("the definition", &toml_path),
            _ => WizardError::new(500, "WIZARD_IO", format!("cannot write the definition: {e}")),
        });
    }
    Ok(json!({
        "ok": true,
        "id": id,
        "file": toml_path.display().to_string(),
        "provenance_file": provenance_path.display().to_string(),
        "state": "needs_approval",
        "chat_only": true,
    }))
}

/// `POST /agents/wizard/acp_finish` `{session, id?, label, acp: {command, args, env_allow, resume_command?}}`.
/// The caller (`handle_global`) reloads the registry afterwards.
pub fn finish(wizard: &Wizard, body: &Value) -> Result<Value, WizardError> {
    let sid = super::api::session_id(body)?;
    let acp = parse_acp(body)?;
    let label = body
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .ok_or_else(|| WizardError::bad_request("label is required"))?
        .to_string();
    let requested = body.get("id").and_then(Value::as_str).map(str::trim).filter(|i| !i.is_empty()).map(str::to_string);
    let snap = wizard.begin(&sid, "acp_finish", &[State::Resolved, State::Probed, State::Verified, State::Tested])?;
    let env = wizard.env();
    let id = requested.unwrap_or_else(|| snap.id_suggestion.clone());
    let code_ids = env.code_id_refs();
    let result = write_files(&snap, &env.agents_dir, &id, &label, &acp, &code_ids, &env.app_build);
    wizard.release(&sid);
    if result.is_ok() {
        wizard.drop_finished(&sid);
    }
    result
}
