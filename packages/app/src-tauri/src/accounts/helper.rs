//! Which login a helper gets when an agent starts it without naming an account.
//!
//! The person sets it per agent (Settings > Agents > Accounts, "Helpers use"): "Ask me" (the default),
//! "Main login", or one account. For "Ask me" this module raises one card through the ordinary question
//! store (`questions`, kind `helper_login`), so it shows in the Inbox and on a paired phone like any other
//! card, and waits for the answer. Nothing here names an agent: the label comes from the profile, and whether
//! an agent has accounts at all is the profile's answer.
//!
//! A call that waits only as long as the caller can: when the person has not answered yet it fails with the
//! recoverable `HELPER_LOGIN_PENDING`, and the agent calls again with the same `idempotency_key`. The retry
//! finds the SAME card (one card per session, agent, project and key), so a retry never makes a second card, and
//! the run that follows is still deduplicated by the key. A dismissed or expired card is an error that starts
//! nothing; a login is never picked for the person.

use super::{Account, HelperLogin, Store};
use crate::operations::OperationError;
use crate::questions::{self, Choice, NewQuestion, QuestionState, HELPER_LOGIN_KIND};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long the card waits for the person (the same default as `ask_user`).
pub const CARD_TIMEOUT_S: u64 = questions::DEFAULT_TIMEOUT_S;
/// More logins than this for one agent are not listed on the card (two buttons each; the rest are in Settings).
const MAX_LOGINS_SHOWN: usize = 11;
/// A waiting call re-reads the account list this often, so a login added meanwhile shows on the card.
const SLICE: Duration = Duration::from_millis(1000);

const ONCE: &str = "once:";
const ALWAYS: &str = "always:";
const MAIN_ID: &str = "main";

/// What a call knows about the helper it is about to start.
pub struct Starting<'a> {
    pub agent_id: &'a str,
    pub project: &'a str,
    /// The call's `idempotency_key` (or a key made from the call). One card per key.
    pub key: &'a str,
    /// The MCP connection that is starting the helper.
    pub session: Option<&'a str>,
    /// The pane of the agent that is starting it, when known.
    pub pane_id: Option<&'a str>,
    /// The longest this call may block before it answers `HELPER_LOGIN_PENDING`.
    pub wait: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub message: String,
    pub recoverable: bool,
}

impl From<Refused> for OperationError {
    fn from(refused: Refused) -> Self {
        OperationError::new(refused.code, refused.message, refused.recoverable)
    }
}

#[derive(Clone)]
struct Slot {
    question_id: String,
    /// The accounts the card listed; a change means the card is out of date.
    accounts: String,
}

static SLOTS: Lazy<Mutex<HashMap<String, Slot>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Where the login a helper starts under came from (the receipt's `account_source`).
pub const SOURCE_HELPER_DEFAULT: &str = "helper_default";
pub const SOURCE_ASKED: &str = "asked";
pub const SOURCE_CLI_LOGIN: &str = "cli_login";
pub const SOURCE_EXPLICIT: &str = "explicit";

/// The account id to start the helper under (`None` = the agent's main login). Blocks up to `starting.wait`
/// when the person has to be asked.
#[cfg(test)]
pub fn choose(store: &Store, starting: &Starting, notify: &dyn Fn()) -> Result<Option<String>, Refused> {
    choose_with_source(store, starting, notify).map(|(account, _)| account)
}

/// Like [`choose`], and says where the answer came from: `helper_default` (the person's saved "Helpers use"),
/// `asked` (a card the person answered) or `cli_login` (the agent has no accounts, so only its own login exists).
pub fn choose_with_source(
    store: &Store,
    starting: &Starting,
    notify: &dyn Fn(),
) -> Result<(Option<String>, &'static str), Refused> {
    // An agent without accounts has only its own login: nothing to choose.
    if super::scheme_for(starting.agent_id).is_err() {
        return Ok((None, SOURCE_CLI_LOGIN));
    }
    match store.effective_helper_login(starting.agent_id) {
        // A saved setting answers the question, so a card still open for this call is closed, not left in the Inbox.
        HelperLogin::Main => {
            retire(&slot_key(starting), notify);
            Ok((None, SOURCE_HELPER_DEFAULT))
        }
        HelperLogin::Account(id) => {
            retire(&slot_key(starting), notify);
            Ok((Some(id), SOURCE_HELPER_DEFAULT))
        }
        HelperLogin::Ask => ask_the_person(store, starting, notify).map(|account| (account, SOURCE_ASKED)),
    }
}

/// The key of the card for one call: one card per session, agent, project and key.
fn slot_key(starting: &Starting) -> String {
    format!(
        "{}|{}|{}|{}",
        starting.session.unwrap_or(""),
        starting.agent_id.trim().to_ascii_lowercase(),
        starting.project,
        starting.key
    )
}

fn accounts_of(store: &Store, agent_id: &str) -> Vec<Account> {
    store.list().into_iter().filter(|a| a.agent_id.eq_ignore_ascii_case(agent_id)).collect()
}

fn signature(accounts: &[Account]) -> String {
    accounts.iter().map(|a| format!("{}={}", a.id, a.label)).collect::<Vec<_>>().join("|")
}

fn agent_label(agent_id: &str) -> String {
    crate::tui::descriptor_for(agent_id).map(|d| d.label).unwrap_or_else(|| agent_id.to_string())
}

fn ask_the_person(store: &Store, starting: &Starting, notify: &dyn Fn()) -> Result<Option<String>, Refused> {
    let agent_id = starting.agent_id.trim().to_ascii_lowercase();
    let slot_key = slot_key(starting);
    let qstore = questions::store();
    let mut accounts = accounts_of(store, &agent_id);
    let mut card = {
        let known = SLOTS.lock().get(&slot_key).cloned();
        known
            .and_then(|slot| qstore.get(&slot.question_id, questions::now_ms()).map(|q| (slot, q)))
            .filter(|(slot, q)| q.state != QuestionState::Pending || slot.accounts == signature(&accounts))
            .map(|(_, q)| q.id)
    };
    // A pending card that no longer matches the account list is replaced below.
    if card.is_none() {
        retire(&slot_key, notify);
    }
    let deadline = Instant::now() + starting.wait;
    loop {
        let id = match card.clone() {
            Some(id) => id,
            None => {
                let id = raise(&slot_key, &agent_id, &accounts, starting, notify)?;
                card = Some(id.clone());
                id
            }
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        let question = qstore.wait_resolved(&id, remaining.min(SLICE)).ok_or_else(|| Refused {
            code: "HELPER_LOGIN_LOST",
            message: "The login question was lost. No helper was started; try again.".into(),
            recoverable: true,
        })?;
        match question.state {
            QuestionState::Answered => return picked(store, &agent_id, &question),
            QuestionState::Cancelled => {
                return Err(Refused {
                    code: "HELPER_LOGIN_DISMISSED",
                    message: "The person dismissed the question about which login this helper should use. No helper was started."
                        .into(),
                    recoverable: false,
                })
            }
            QuestionState::TimedOut => {
                return Err(Refused {
                    code: "HELPER_LOGIN_TIMED_OUT",
                    message: format!(
                        "Nobody picked a login for this helper in {} minutes. No helper was started. Ask the person, then try again with a new idempotency_key.",
                        CARD_TIMEOUT_S / 60
                    ),
                    recoverable: false,
                })
            }
            QuestionState::Pending => {}
        }
        if remaining.is_zero() || Instant::now() >= deadline {
            return Err(Refused {
                code: "HELPER_LOGIN_PENDING",
                message: "Waiting for the person to pick which login this helper uses. No helper was started yet. Call again with the same idempotency_key; do not use a new one.".into(),
                recoverable: true,
            });
        }
        // A login added or renamed while the card is open: show the new list.
        let now_accounts = accounts_of(store, &agent_id);
        if signature(&now_accounts) != signature(&accounts) {
            accounts = now_accounts;
            retire(&slot_key, notify);
            card = None;
        }
    }
}

/// Close the card remembered for `slot_key` if it is still open (the person never sees a stale one).
fn retire(slot_key: &str, notify: &dyn Fn()) {
    let slot = SLOTS.lock().remove(slot_key);
    if let Some(slot) = slot {
        if let Ok(resolution) = questions::store().dismiss(&slot.question_id, questions::now_ms()) {
            if resolution.accepted {
                notify();
            }
        }
    }
}

fn raise(
    slot_key: &str,
    agent_id: &str,
    accounts: &[Account],
    starting: &Starting,
    notify: &dyn Fn(),
) -> Result<String, Refused> {
    let label = agent_label(agent_id);
    let mut choices = vec![
        Choice { id: format!("{ONCE}{MAIN_ID}"), label: "Main login".into() },
        Choice { id: format!("{ALWAYS}{MAIN_ID}"), label: "Always use Main login".into() },
    ];
    for account in accounts.iter().take(MAX_LOGINS_SHOWN) {
        choices.push(Choice { id: format!("{ONCE}{}", account.id), label: account.label.clone() });
        choices.push(Choice { id: format!("{ALWAYS}{}", account.id), label: format!("Always use {}", account.label) });
    }
    let context = if accounts.is_empty() {
        format!("{label} has no other login yet. Pick Main login, or add another in Settings > Agents > Accounts.")
    } else {
        format!("Always use remembers the pick for every {label} helper. You can change it in Settings > Agents > Accounts.")
    };
    let created = questions::store()
        .create(
            NewQuestion {
                asker: starting.session.map(str::to_string),
                agent: None,
                pane_id: starting.pane_id.map(str::to_string),
                question: format!("Which login should this {label} helper use?"),
                choices,
                allow_free_text: Some(false),
                context: Some(context),
                timeout_s: Some(CARD_TIMEOUT_S),
                urgency: None,
                consent: None,
                kind: Some(HELPER_LOGIN_KIND.to_string()),
                limit: None,
            },
            questions::now_ms(),
        )
        .map_err(|e| Refused { code: "HELPER_LOGIN_CARD_FAILED", message: e.message, recoverable: e.code == "TOO_MANY_QUESTIONS" })?;
    {
        let mut slots = SLOTS.lock();
        if slots.len() > 200 {
            let now = questions::now_ms();
            slots.retain(|_, slot| questions::store().get(&slot.question_id, now).is_some());
        }
        slots.insert(slot_key.to_string(), Slot { question_id: created.id.clone(), accounts: signature(accounts) });
    }
    crate::push::notify_question(&created);
    notify();
    Ok(created.id)
}

/// The account (or main login) an answered card chose; saves it when the person chose "Always".
fn picked(store: &Store, agent_id: &str, question: &questions::Question) -> Result<Option<String>, Refused> {
    let choice = question.answer.as_ref().and_then(|a| a.choice_id.as_deref()).unwrap_or_default();
    let (always, target) = match (choice.strip_prefix(ALWAYS), choice.strip_prefix(ONCE)) {
        (Some(target), _) => (true, target),
        (None, Some(target)) => (false, target),
        _ => {
            return Err(Refused {
                code: "HELPER_LOGIN_DISMISSED",
                message: "The answer to the login question was not one of its choices. No helper was started.".into(),
                recoverable: false,
            })
        }
    };
    if target == MAIN_ID {
        if always {
            let _ = store.set_helper_login(agent_id, super::HELPER_MAIN);
        }
        return Ok(None);
    }
    if store.resolve(agent_id, target).is_err() {
        return Err(Refused {
            code: "HELPER_LOGIN_GONE",
            message: "The login the person picked was removed before the helper started. No helper was started; try again.".into(),
            recoverable: true,
        });
    }
    if always {
        let _ = store.set_helper_login(agent_id, target);
    }
    Ok(Some(target.to_string()))
}

#[cfg(test)]
mod tests;
