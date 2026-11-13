//! The save step of the add-agent ladder (contract 2.3 step 6): files written for one new agent, the wizard's own
//! approval for them, and taking all of it back. Nothing here overwrites a file (`create_new` everywhere).
//!
//! Two kinds of definition are written:
//! * a terminal one, the smallest valid `kind = "generic"` file (identity plus `[binary]`), for a program the ladder
//!   found but could not chat with, and for a chat add-on whose chat lives in the add-on overlay;
//! * a chat one, through the wizard's own `acp::finish` from a freshly resolved session.
//!
//! The approval is the wizard's (`approve_current_as_wizard`), recorded with the checks that really ran.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::tui::declarative::approvals::now_rfc3339;
use crate::tui::declarative::loader::LoadInputs;
use crate::tui::declarative::schema::parse_definition;
use crate::tui::declarative::validate::{validate, Source, ValidationContext, MAX_DEFINITION_BYTES};

use super::exec::mask_private;
use super::session::{sha256_hex, Wizard, WizardEnv};

/// What `provenance` says wrote a file the ladder made itself (so nothing counts such a file as shipped).
pub const DRAFTER: &str = "add-agent-ladder";

/// Everything one save put on disk or in the approvals file, so a cancel can take it back.
#[derive(Debug, Clone, Default)]
pub struct Written {
    pub files: Vec<PathBuf>,
    /// The definition file to approve (the `.toml`).
    pub definition: Option<PathBuf>,
    pub approval_id: Option<String>,
    /// A shipped catalog agent added through the Store path (removed through the Store path).
    pub catalog_id: Option<String>,
}

fn quoted(text: &str) -> String {
    toml::Value::String(text.to_string()).to_string()
}

/// The smallest valid terminal definition for `program`.
pub fn terminal_text(id: &str, label: &str, program: &str) -> String {
    format!(
        "schema_version = 1\n\n[agent]\nid = {}\nlabel = {}\nkind = \"generic\"\nexperimental = true\n\n[binary]\nnames = [{}]\ninstall_hint = {}\n",
        quoted(id),
        quoted(label),
        quoted(program),
        quoted(&format!("install {program} and make sure it is on PATH")),
    )
}

/// Validate exactly as the loader will (user source), so a file that cannot load is never written.
pub fn check_text(text: &str, code_ids: &[&str]) -> Result<(), String> {
    if text.len() > MAX_DEFINITION_BYTES {
        return Err("the definition is too large".into());
    }
    let def = parse_definition(text).map_err(|e| format!("{}: {}", e.code, e))?;
    let found = validate(&def, &ValidationContext { source: Source::User, code_ids, raw_len: text.len() });
    match found.first() {
        Some(first) => Err(format!("{}: {first}", first.code)),
        None => Ok(()),
    }
}

fn create_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    std::io::Write::write_all(&mut f, bytes)
}

fn taken(agents_dir: &Path, id: &str) -> bool {
    [format!("{id}.toml"), format!("{id}.wizard.json"), id.to_string(), format!("{id}.fixtures")].iter().any(|n| agents_dir.join(n).exists())
}

/// Write `<id>.toml` (terminal) and `<id>.wizard.json` (who wrote it). Takes its own files back on a failure.
pub fn write_terminal(env: &WizardEnv, id: &str, label: &str, program: &str) -> Result<Written, String> {
    let text = terminal_text(id, label, program);
    check_text(&text, &env.code_id_refs())?;
    if taken(&env.agents_dir, id) {
        return Err(format!("the id `{id}` is already used in the agents folder"));
    }
    std::fs::create_dir_all(&env.agents_dir).map_err(|e| format!("cannot create the agents folder: {e}"))?;
    let toml_path = env.agents_dir.join(format!("{id}.toml"));
    let record_path = env.agents_dir.join(format!("{id}.wizard.json"));
    let record = json!({
        "wizard_schema": 1,
        "id": id,
        "command": program,
        "created_at": now_rfc3339(),
        "drafter": {"name": DRAFTER, "kind": "other", "model": null},
        "definition_sha256": sha256_hex(text.as_bytes()),
        "app_build": env.app_build,
    });
    let record_text = mask_private(&serde_json::to_string_pretty(&record).unwrap_or_default());
    create_new(&record_path, record_text.as_bytes()).map_err(|e| format!("cannot write the record: {e}"))?;
    if let Err(e) = create_new(&toml_path, text.as_bytes()) {
        let _ = std::fs::remove_file(&record_path);
        return Err(format!("cannot write the definition: {e}"));
    }
    Ok(Written { files: vec![record_path, toml_path.clone()], definition: Some(toml_path), approval_id: None, catalog_id: None })
}

/// Write a chat definition through the wizard's `acp::finish`, from a session `locate::start` opens (state
/// `Resolved`: no probe is needed, `finish` accepts that state). `command` and `args` are the program and
/// arguments that speak the chat protocol.
pub fn write_chat(wizard: &Wizard, id: &str, label: &str, program: &str, command: &str, args: &[String]) -> Result<Written, String> {
    let started = super::locate::start(wizard, &json!({"command": program})).map_err(|e| format!("{}: {}", e.code, e.message))?;
    let session = started["session"].as_str().unwrap_or_default().to_string();
    let body = json!({"session": session, "id": id, "label": label, "acp": {"command": command, "args": args, "env_allow": []}});
    let out = match super::acp::finish(wizard, &body) {
        Ok(out) => out,
        Err(e) => {
            wizard.cancel(&session);
            return Err(format!("{}: {}", e.code, e.message));
        }
    };
    let file = PathBuf::from(out["file"].as_str().unwrap_or_default());
    let record = PathBuf::from(out["provenance_file"].as_str().unwrap_or_default());
    Ok(Written { files: vec![record, file.clone()], definition: Some(file), approval_id: None, catalog_id: None })
}

fn inputs<'a>(env: &'a WizardEnv, code_ids: &'a [&'a str]) -> LoadInputs<'a> {
    LoadInputs { bundled: &[], user_dir: Some(env.agents_dir.as_path()), code_ids, projects: &[], extra: &[] }
}

/// The wizard's approval of the file just written, with the checks that really ran.
pub fn approve(env: &WizardEnv, written: &mut Written, id: &str, checks: &[String]) -> Result<Value, String> {
    let Some(file) = written.definition.clone() else { return Err("nothing was written to approve".into()) };
    let code_ids = env.code_id_refs();
    let out = crate::tui::declarative::service::approve_current_as_wizard(
        &inputs(env, &code_ids),
        &env.approvals_path,
        &file.to_string_lossy(),
        checks,
        env.path_dirs.as_deref(),
    )
    .map_err(|e| format!("{}: {}", e.code, e.message))?;
    written.approval_id = Some(id.to_string());
    Ok(out)
}

/// Take back what `written` holds: the approval first, then the files. Missing files are not an error.
pub fn undo(env: &WizardEnv, written: &Written) {
    if let Some(id) = &written.approval_id {
        let _ = crate::tui::declarative::service::revoke(&env.approvals_path, id);
    }
    for file in &written.files {
        let _ = std::fs::remove_file(file);
    }
}
