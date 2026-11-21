//! User accounts per agent: the same agent CLI run under different logins, one chosen per pane.
//!
//! An account is `{ id, agent_id, label, home }`. `home` is a directory the user controls (by
//! default one folder per account under `<app data>/accounts/`). Potato Workspace only points the
//! agent CLI at it through the env var the agent's profile declares (`TuiProfile::account_scheme`);
//! it never reads, copies or pools the credentials inside. One exception (founder, 2026-11-11): the "Used" strip
//! (`crate::usage::oauth`) reads an access token from a sign-in's credential file, only in memory, only to ask
//! that agent's own usage address for the plan numbers; it is never stored, logged, refreshed or sent anywhere
//! else, and the Settings switch "Read Claude usage with my Claude login" turns it off. Generic code here never matches agent
//! names: whether an agent supports accounts is the profile's answer.

use crate::tui::{AccountScheme, LaunchEnv};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub mod helper;

const STORE_VERSION: u32 = 1;
const MAX_LABEL: usize = 40;

/// Serialises read-modify-write of the store file across commands and bridge routes.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub agent_id: String,
    pub label: String,
    /// Directory the agent is pointed at (its config and login live here).
    pub home: String,
    /// A lend sign-in (Share an agent): signed in once inside the app and used only for lending. Older files have
    /// no such field (it reads as false).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lend_only: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    accounts: Vec<Account>,
    /// Per agent id: which login a helper that agent starts uses. `main` or an account id; no entry means "Ask me".
    /// Older files have no such field (it reads as empty).
    #[serde(default)]
    helper_logins: BTreeMap<String, String>,
}

/// The value stored for "Main login" (no account).
pub const HELPER_MAIN: &str = "main";
/// The value shown for "Ask me" (nothing stored).
pub const HELPER_ASK: &str = "ask";

/// Which login a helper an agent starts gets, when the caller did not name one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperLogin {
    /// Show a card and wait for the person.
    Ask,
    /// The agent's own login (no account).
    Main,
    /// This account id.
    Account(String),
}

impl HelperLogin {
    /// `ask`, `main` or the account id.
    pub fn as_value(&self) -> String {
        match self {
            HelperLogin::Ask => HELPER_ASK.into(),
            HelperLogin::Main => HELPER_MAIN.into(),
            HelperLogin::Account(id) => id.clone(),
        }
    }
}

/// Where the accounts live; tests point it at a temp dir.
#[derive(Debug, Clone)]
pub struct Store {
    file: PathBuf,
    homes_root: PathBuf,
}

impl Store {
    pub fn at(root: &Path) -> Self {
        Self { file: root.join("accounts.json"), homes_root: root.join("accounts") }
    }

    /// `<app data>/accounts.json`, homes under `<app data>/accounts/<id>`.
    pub fn default_location() -> Self {
        Self::at(&crate::app_paths::app_data_dir())
    }

    fn read(&self) -> StoreFile {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write(&self, file: &StoreFile) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(&StoreFile {
            version: STORE_VERSION,
            accounts: file.accounts.clone(),
            helper_logins: file.helper_logins.clone(),
        })
            .map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.file).map_err(|e| format!("could not save {}: {e}", self.file.display()))
    }

    pub fn list(&self) -> Vec<Account> {
        self.read().accounts
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.list().into_iter().find(|a| a.id == id)
    }

    /// Add an account for an agent whose profile supports accounts. `home` defaults to a new
    /// folder under the app data directory; a custom `home` must be an absolute path.
    pub fn add(&self, agent_id: &str, label: &str, home: Option<&str>) -> Result<Account, String> {
        let agent_id = agent_id.trim().to_ascii_lowercase();
        scheme_for(&agent_id)?;
        let label = clean_label(label)?;
        let _guard = WRITE_LOCK.lock();
        let mut file = self.read();
        if file.accounts.iter().any(|a| a.agent_id == agent_id && a.label.eq_ignore_ascii_case(&label)) {
            return Err(format!("{agent_id} already has an account named \"{label}\""));
        }
        let id = format!("acc_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let home = match home.map(str::trim).filter(|h| !h.is_empty()) {
            Some(custom) => {
                let expanded = crate::project_path::expand_user_path(Path::new(custom));
                if !expanded.is_absolute() {
                    return Err("the account folder must be an absolute path".into());
                }
                if expanded.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                    return Err("the account folder must not contain \"..\"".into());
                }
                self.check_custom_home(&expanded, &file.accounts)?;
                if overlaps_default_home(&scheme_for(&agent_id)?, &expanded) {
                    return Err("that folder is, holds or sits inside the agent's own folder; pick a separate folder".into());
                }
                expanded.to_string_lossy().into_owned()
            }
            None => self.homes_root.join(&id).to_string_lossy().into_owned(),
        };
        std::fs::create_dir_all(&home).map_err(|e| format!("could not create {home}: {e}"))?;
        let account = Account { id, agent_id, label, home, lend_only: false };
        file.accounts.push(account.clone());
        self.write(&file)?;
        crate::standby::note_account_changed(&account.agent_id);
        Ok(account)
    }

    pub fn rename(&self, id: &str, label: &str) -> Result<Account, String> {
        let label = clean_label(label)?;
        let _guard = WRITE_LOCK.lock();
        let mut file = self.read();
        let agent_id = file
            .accounts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.agent_id.clone())
            .ok_or_else(|| unknown(id))?;
        if file
            .accounts
            .iter()
            .any(|a| a.id != id && a.agent_id == agent_id && a.label.eq_ignore_ascii_case(&label))
        {
            return Err(format!("{agent_id} already has an account named \"{label}\""));
        }
        let account = file.accounts.iter_mut().find(|a| a.id == id).ok_or_else(|| unknown(id))?;
        account.label = label;
        let renamed = account.clone();
        self.write(&file)?;
        Ok(renamed)
    }

    /// Forget an account. The home folder is left alone unless `delete_home` is set, and even then
    /// only a folder this store created (inside its own `accounts/` folder) is ever deleted.
    /// Returns whether a folder was deleted.
    pub fn remove(&self, id: &str, delete_home: bool) -> Result<bool, String> {
        let _guard = WRITE_LOCK.lock();
        let mut file = self.read();
        let index = file.accounts.iter().position(|a| a.id == id).ok_or_else(|| unknown(id))?;
        let account = file.accounts.remove(index);
        file.helper_logins.retain(|_, value| value != id);
        self.write(&file)?;
        crate::standby::note_account_changed(&account.agent_id);
        if !delete_home {
            return Ok(false);
        }
        // Only the folder this store made (`<homes_root>/<id>`) is ever deleted. A user-chosen folder, even
        // one that merely sits inside the app's folder, is not. Compare real paths, so `..` and links cannot
        // lead the delete elsewhere.
        let home = Path::new(&account.home);
        if home.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Ok(false);
        }
        let (Ok(real_home), Ok(real_root)) = (home.canonicalize(), self.homes_root.canonicalize()) else {
            return Ok(false);
        };
        if real_home.parent() == Some(real_root.as_path()) && real_home.file_name().is_some_and(|n| n == account.id.as_str()) {
            std::fs::remove_dir_all(&real_home).map_err(|e| format!("removed the account but not its folder: {e}"))?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Sign an account out: removes the credential files the agent's profile names from the account's home, so the
    /// agent asks for a login again. The account itself, its name and the rest of its folder stay. Nothing is read.
    /// Returns how many files were removed (0: it was already signed out, or the agent keeps its login somewhere
    /// else, such as a keychain, and this app cannot reach it).
    pub fn sign_out(&self, id: &str) -> Result<usize, String> {
        let account = self.get(id).ok_or_else(|| unknown(id))?;
        let scheme = scheme_for(&account.agent_id)?;
        let home = Path::new(&account.home);
        if overlaps_default_home(&scheme, home) {
            return Err("this account uses the agent's own folder, so signing out is not done here. Sign out in the agent itself.".into());
        }
        if is_link(home) {
            return Err("this account's folder is a link, so nothing was removed".into());
        }
        let real_home = home.canonicalize().map_err(|e| format!("could not open the account folder: {e}"))?;
        let mut removed = 0;
        for name in &scheme.credential_files {
            let rel = Path::new(name);
            // Names come from a profile, but a bad one must never reach outside the account's folder.
            if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
                continue;
            }
            // Every step from the account folder down must be a plain folder or file: a link or junction could lead
            // outside, so one anywhere on the way means nothing is removed.
            let mut walk = home.to_path_buf();
            let mut linked = false;
            for part in rel.components() {
                walk.push(part);
                if is_link(&walk) {
                    linked = true;
                    break;
                }
            }
            if linked {
                return Err("a sign-in file sits behind a link, so nothing was removed".into());
            }
            let file = home.join(rel);
            let inside = file.parent().and_then(|p| p.canonicalize().ok()).is_some_and(|p| p.starts_with(&real_home));
            if file.is_file() && !inside {
                return Err("a sign-in file is outside the account folder, so nothing was removed".into());
            }
            if file.is_file() {
                std::fs::remove_file(&file).map_err(|e| format!("could not remove the sign-in file: {e}"))?;
                removed += 1;
            }
        }
        crate::standby::note_account_changed(&account.agent_id);
        Ok(removed)
    }

    /// A custom home must not be, hold or sit inside another account's folder or the app's own data folder.
    fn check_custom_home(&self, home: &Path, accounts: &[Account]) -> Result<(), String> {
        let wanted = resolve_for_compare(home);
        let mut protected: Vec<PathBuf> = accounts.iter().map(|a| resolve_for_compare(Path::new(&a.home))).collect();
        if let Some(data_dir) = self.file.parent() {
            protected.push(resolve_for_compare(data_dir));
        }
        protected.push(resolve_for_compare(&self.homes_root));
        if protected.iter().any(|other| wanted.starts_with(other) || other.starts_with(&wanted)) {
            return Err("that folder overlaps another account or the app's own data folder; pick a separate folder".into());
        }
        Ok(())
    }

    /// The saved choice for helpers of `agent_id`, as written. A saved account that is gone still shows up here;
    /// [`Store::effective_helper_login`] is the one to act on.
    pub fn helper_login(&self, agent_id: &str) -> HelperLogin {
        match self.read().helper_logins.get(&agent_id.trim().to_ascii_lowercase()).map(String::as_str) {
            None => HelperLogin::Ask,
            Some(HELPER_MAIN) => HelperLogin::Main,
            Some(id) => HelperLogin::Account(id.to_string()),
        }
    }

    /// The choice to act on: a saved account that no longer exists for this agent falls back to "Ask me".
    pub fn effective_helper_login(&self, agent_id: &str) -> HelperLogin {
        match self.helper_login(agent_id) {
            HelperLogin::Account(id) if self.resolve(agent_id, &id).is_err() => HelperLogin::Ask,
            other => other,
        }
    }

    /// Save the choice for helpers of `agent_id`: `ask`, `main` or the id of one of its accounts.
    pub fn set_helper_login(&self, agent_id: &str, value: &str) -> Result<HelperLogin, String> {
        let agent_id = agent_id.trim().to_ascii_lowercase();
        scheme_for(&agent_id)?;
        let value = value.trim();
        let choice = match value {
            "" | HELPER_ASK => HelperLogin::Ask,
            HELPER_MAIN => HelperLogin::Main,
            id => HelperLogin::Account(self.resolve(&agent_id, id)?.id),
        };
        let _guard = WRITE_LOCK.lock();
        let mut file = self.read();
        let changed_agent = agent_id.clone();
        match &choice {
            HelperLogin::Ask => {
                file.helper_logins.remove(&agent_id);
            }
            other => {
                file.helper_logins.insert(agent_id, other.as_value());
            }
        }
        self.write(&file)?;
        crate::standby::note_account_changed(&changed_agent);
        Ok(choice)
    }

    /// The account `id`, which must belong to `agent_id`.
    pub fn resolve(&self, agent_id: &str, id: &str) -> Result<Account, String> {
        let account = self.get(id).ok_or_else(|| unknown(id))?;
        if !account.agent_id.eq_ignore_ascii_case(agent_id) {
            return Err(format!("account {id} belongs to {}, not {agent_id}", account.agent_id));
        }
        Ok(account)
    }

    /// A lend sign-in (Share an agent): a new account folder marked `lend_only`, signed into once inside the app.
    pub fn add_lend(&self, agent_id: &str, label: &str) -> Result<Account, String> {
        let account = self.add(agent_id, label, None)?;
        let _guard = WRITE_LOCK.lock();
        let mut file = self.read();
        let Some(slot) = file.accounts.iter_mut().find(|a| a.id == account.id) else { return Err(unknown(&account.id)) };
        slot.lend_only = true;
        let marked = slot.clone();
        self.write(&file)?;
        Ok(marked)
    }

    /// The environment that points `agent_id` at account `id`. A borrowed grant (`lend:<grant id>`, Share an
    /// agent) is one more sign-in: its env points the agent at the local lend shim instead of a home folder.
    pub fn launch_env(&self, agent_id: &str, id: &str) -> Result<LaunchEnv, String> {
        if let Some(grant) = id.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX) {
            return crate::capacity_proxy::borrowed_launch_env(agent_id, grant);
        }
        let scheme = scheme_for(agent_id)?;
        let account = self.resolve(agent_id, id)?;
        Ok(env_for(&scheme, &account))
    }
}

/// `home_env=<home>` plus the scheme's extra variables.
pub fn env_for(scheme: &AccountScheme, account: &Account) -> LaunchEnv {
    let mut set = vec![(scheme.home_env.clone(), account.home.clone())];
    set.extend(scheme.extra_env.iter().cloned());
    LaunchEnv { set, remove: Vec::new() }
}

/// A link, symlink or Windows junction (any reparse point). Missing paths are not links.
fn is_link(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Whether `home` is or holds the folder the agent uses with no account (`~/.claude`), or the folder the app's own
/// environment already points the agent at. Those are the person's own login.
fn overlaps_default_home(scheme: &AccountScheme, home: &Path) -> bool {
    let mut defaults: Vec<PathBuf> = Vec::new();
    if !scheme.default_home.trim().is_empty() {
        defaults.push(crate::project_path::expand_user_path(Path::new(scheme.default_home.trim())));
    }
    if let Some(own) = std::env::var_os(&scheme.home_env).filter(|v| !v.is_empty()) {
        defaults.push(PathBuf::from(own));
    }
    let wanted = resolve_for_compare(home);
    defaults.iter().any(|d| {
        let d = resolve_for_compare(d);
        // Is or contains it. Sitting inside it is allowed: the app's own data folder may live under a shared folder.
        d.starts_with(&wanted)
    })
}

fn scheme_for(agent_id: &str) -> Result<AccountScheme, String> {
    if !crate::tui::is_registered(agent_id) {
        return Err(format!("unknown agent type: {agent_id}"));
    }
    crate::tui::profile_for(agent_id)
        .account_scheme()
        .ok_or_else(|| format!("{agent_id} does not support accounts"))
}

/// `path` with its nearest existing ancestor resolved (links, case, `\\?\`), the rest appended, and folded
/// to lower case on Windows, so two spellings of one folder compare equal.
fn resolve_for_compare(path: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    let mut base = loop {
        if let Ok(real) = cur.canonicalize() {
            break real;
        }
        match (cur.file_name().map(|n| n.to_os_string()), cur.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent;
            }
            _ => break path.to_path_buf(),
        }
    };
    for part in tail.into_iter().rev() {
        base.push(part);
    }
    if cfg!(windows) {
        PathBuf::from(base.to_string_lossy().to_lowercase())
    } else {
        base
    }
}

fn unknown(id: &str) -> String {
    format!("unknown account: {id}")
}

fn clean_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("an account needs a name".into());
    }
    if label.chars().count() > MAX_LABEL {
        return Err(format!("an account name is limited to {MAX_LABEL} characters"));
    }
    Ok(label.to_string())
}

/// What the Settings screen needs about one agent that supports accounts.
#[derive(Debug, Clone, Serialize)]
pub struct AccountAgent {
    pub agent_id: String,
    pub login_hint: String,
    pub home_env: String,
}

/// Registered agents whose profile declares an account scheme.
pub fn supporting_agents() -> Vec<AccountAgent> {
    crate::tui::registry::snapshot()
        .iter()
        .filter_map(|profile| {
            profile.account_scheme().map(|scheme| AccountAgent {
                agent_id: profile.id().to_string(),
                login_hint: scheme.login_hint,
                home_env: scheme.home_env,
            })
        })
        .collect()
}

/// The env a pane or run of `agent_id` under account `id` gets (default store).
pub fn launch_env(agent_id: &str, id: &str) -> Result<LaunchEnv, String> {
    Store::default_location().launch_env(agent_id, id)
}

/// The env and the label for a pane or run of `agent_id` under account `id` (default store).
pub fn launch_for(agent_id: &str, id: &str) -> Result<(LaunchEnv, String), String> {
    let store = Store::default_location();
    let env = store.launch_env(agent_id, id)?;
    let label = store.get(id).map(|a| a.label).or_else(|| id.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX).and_then(crate::capacity_proxy::borrowed_label)).unwrap_or_default();
    Ok((env, label))
}

/// The account's label for display, when it still exists.
pub fn label_of(id: &str) -> Option<String> {
    Store::default_location().get(id).map(|a| a.label).or_else(|| id.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX).and_then(crate::capacity_proxy::borrowed_label))
}

/// Validate a run's `account` argument before anything spawns: the agent supports accounts and
/// the account exists for it. Returns the account id to store on the run.
pub fn validate_for_run(agent_id: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    Store::default_location().launch_env(agent_id, id).map(|_| id.to_string())
}

/// `validate_for_run` for a run an agent or helper starts (MCP `run_agent`, an automatic pick): a borrowed
/// sign-in (Lend through my PC) is refused, because only a person starting a pane may use one.
pub fn validate_for_agent_run(agent_id: &str, id: &str) -> Result<String, String> {
    if id.trim().starts_with(crate::capacity_proxy::ACCOUNT_PREFIX) {
        return Err("A borrowed sign-in can only be used in a pane you start yourself, not by an agent or helper run.".into());
    }
    validate_for_run(agent_id, id)
}

/// Whether the CLI is signed in under an account, as far as the folder shows: `signed_in` when one of the
/// profile's credential files is there, `signed_out` when the folder is empty or missing (never logged in),
/// `unknown` otherwise (the login may live in a keychain, or the profile declares no credential file).
pub fn login_state(scheme: &AccountScheme, account: &Account) -> &'static str {
    let home = Path::new(&account.home);
    if scheme.credential_files.iter().any(|name| home.join(name).is_file()) {
        return "signed_in";
    }
    if scheme.credential_files.is_empty() {
        return "unknown";
    }
    let empty = std::fs::read_dir(home).map(|mut entries| entries.next().is_none()).unwrap_or(true);
    if empty { "signed_out" } else { "unknown" }
}

/// A positive sign that a sign-in finished: this login's credential file was written at or after `since` (when the sign-in was started).
/// `Some(true)` with that sign, `Some(false)` when the folder can be looked at and shows none (no credential file, or one older than the
/// start: the old sign-in, not a new one), `None` when the agent keeps its login where no folder shows it (a keychain), so only the agent's
/// own reading can tell. A folder that merely is not empty is never a sign-in.
pub fn signed_in_since(scheme: &AccountScheme, home: &Path, since: Option<std::time::SystemTime>) -> Option<bool> {
    if scheme.credential_files.is_empty() {
        return None;
    }
    let Some(since) = since else { return Some(false) };
    let newest = scheme
        .credential_files
        .iter()
        // A name from a profile must be a plain relative path (the same rule sign-out uses), never one that leaves the folder.
        .filter(|name| {
            let rel = Path::new(name.as_str());
            !rel.is_absolute() && rel.components().all(|c| matches!(c, std::path::Component::Normal(_)))
        })
        .filter_map(|name| std::fs::metadata(home.join(name)).ok())
        .filter(|meta| meta.is_file())
        .filter_map(|meta| meta.modified().ok())
        .max();
    Some(newest.is_some_and(|written| written >= since))
}

/// The folder an agent's own login lives in: the scheme's env var when it is set (the person moved it), else its default.
/// The agent inherits the same variable, so this is where a new sign-in is written.
fn own_home(scheme: &AccountScheme, env_value: Option<String>) -> Option<PathBuf> {
    if let Some(moved) = env_value.filter(|v| !v.trim().is_empty()) {
        return Some(PathBuf::from(moved));
    }
    let default = scheme.default_home.trim();
    (!default.is_empty()).then(|| crate::project_path::expand_user_path(Path::new(default)))
}

/// `signed_in_since` for an agent's own login (`account_id` None: its default folder) or one of the person's extra sign-ins.
pub fn sign_in_proof(store: &Store, agent_id: &str, account_id: Option<&str>, since: Option<std::time::SystemTime>) -> Option<bool> {
    let scheme = scheme_for(agent_id).ok()?;
    let home = match account_id.filter(|a| !a.is_empty()) {
        Some(id) => std::path::PathBuf::from(store.get(id)?.home),
        None => own_home(&scheme, std::env::var(&scheme.home_env).ok())?,
    };
    signed_in_since(&scheme, &home, since)
}

/// `[{id, label, login_state}]` for `list_agents`: the saved accounts of `agent_id` (empty when it has none).
pub fn capability_rows(store: &Store, agent_id: &str) -> Vec<serde_json::Value> {
    let Ok(scheme) = scheme_for(agent_id) else { return Vec::new() };
    store
        .list()
        .into_iter()
        .filter(|a| a.agent_id.eq_ignore_ascii_case(agent_id))
        .map(|a| serde_json::json!({ "id": a.id, "label": a.label, "login_state": login_state(&scheme, &a) }))
        .collect()
}

/// Everything the Settings screen shows: agents that support accounts, and the accounts.
pub fn overview(store: &Store) -> serde_json::Value {
    let helper_logins: BTreeMap<String, String> = supporting_agents()
        .into_iter()
        .map(|agent| {
            let value = store.effective_helper_login(&agent.agent_id).as_value();
            (agent.agent_id, value)
        })
        .collect();
    // Each account carries `login_state` (`signed_in`, `signed_out` or `unknown`), read from the folder's file names only.
    let accounts: Vec<serde_json::Value> = store
        .list()
        .into_iter()
        .map(|a| {
            let state = scheme_for(&a.agent_id).map(|scheme| login_state(&scheme, &a)).unwrap_or("unknown");
            let mut row = serde_json::to_value(&a).unwrap_or(serde_json::Value::Null);
            row["login_state"] = serde_json::Value::String(state.into());
            row
        })
        .collect();
    serde_json::json!({ "agents": supporting_agents(), "accounts": accounts, "helper_logins": helper_logins })
}

/// Shared by the Tauri commands and the bridge routes.
pub fn overview_default() -> serde_json::Value {
    let mut out = overview(&Store::default_location());
    // `borrowed` (desktop window only, not the bridge listing): active grants lent to this PC (Share an agent), one
    // more sign-in each: `{id: "lend:<grant>", agent_id, label: "<Peer>'s PC (lent)", ends_ms, grant_id}`. Empty
    // while the Labs switch is off.
    out["borrowed"] = serde_json::Value::Array(crate::capacity_proxy::borrowed_rows());
    // A lend sign-in is shown by its lend profile's name ("Work account"), never by the internal label ("Lend Claude 3").
    if let Some(list) = out["accounts"].as_array_mut() {
        for a in list.iter_mut().filter(|a| a["lend_only"].as_bool() == Some(true)) {
            let name = a["id"].as_str().and_then(crate::capacity_proxy::lend_profile_name);
            a["lend_profile"] = name.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null);
        }
    }
    out
}

#[cfg(test)]
mod tests;
