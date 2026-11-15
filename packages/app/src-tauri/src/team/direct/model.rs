//! What this PC remembers about passed tasks: the ones I passed and the ones passed to me, with their states.
//! Saved as one small file (`state.json`). A teammate's words are stored already cleaned (`wire::clean_*`), and are only
//! ever shown as plain quoted text.

use serde::{Deserialize, Serialize};

use super::wire::{Guard, LendOffer, RepoOffer};

/// How far a task I passed has got, as the receiver told me. Only moves forward, except `Declined` / `Withdrawn`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SentState {
    Sent,
    Seen,
    Accepted,
    Declined,
    Started,
    Done,
    Withdrawn,
}

impl SentState {
    /// Still open: counts toward the limit per person, and the lend promise still stands.
    pub fn open(self) -> bool {
        matches!(self, Self::Sent | Self::Seen | Self::Accepted | Self::Started)
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::Sent => 0,
            Self::Seen => 1,
            Self::Accepted => 2,
            Self::Started => 3,
            Self::Done => 4,
            Self::Declined | Self::Withdrawn => 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecvState {
    New,
    Seen,
    Accepted,
    Declined,
    Started,
    Done,
    Withdrawn,
}

impl RecvState {
    pub fn open(self) -> bool {
        matches!(self, Self::New | Self::Seen | Self::Accepted | Self::Started)
    }
}

/// The repo copy, on the sending side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SendRepo {
    #[default]
    None,
    /// Made and waiting for the receiver to ask for it.
    Waiting,
    Sending,
    Sent,
    Failed,
}

/// The repo copy, on the receiving side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RecvRepo {
    #[default]
    None,
    /// The task comes with a copy; I have not asked for it.
    Offered,
    /// I asked; pieces are arriving.
    Receiving,
    /// Whole and checked; waiting for me to pick a folder.
    Ready,
    Unpacked,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Usage {
    /// The receiver's own agent and sign-in.
    #[default]
    Theirs,
    /// Through the sender's lent usage (the sender's PC runs the model calls; nothing is copied).
    Lent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentTask {
    pub id: String,
    pub to_member: String,
    pub to_name: String,
    pub to_devices: Vec<String>,
    /// The device that answered first (accepted or declined).
    pub answered_device: Option<String>,
    pub title: String,
    pub text: String,
    pub summary: String,
    pub repo: Option<RepoOffer>,
    pub lend: Option<LendOffer>,
    /// The promise of lent usage was used by the receiver's request (once).
    pub lend_used: bool,
    pub state: SentState,
    pub at_ms: u64,
    pub updated_ms: u64,
    /// What they wrote when they said it is done.
    pub note: String,
    pub repo_state: SendRepo,
    pub repo_sent: u32,
    pub repo_error: String,
    /// The bundle on this PC (kept in the saved file; `view` blanks it before the screen sees it).
    #[serde(default)]
    pub bundle_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecvTask {
    pub id: String,
    pub from_member: String,
    pub from_name: String,
    pub from_device: String,
    pub title: String,
    pub text: String,
    pub summary: String,
    pub repo: Option<RepoOffer>,
    pub lend: Option<LendOffer>,
    pub state: RecvState,
    pub at_ms: u64,
    pub updated_ms: u64,
    /// Short plain words when the text looks like it asks for something risky; the card shows them above the text.
    pub risk: Option<String>,
    pub usage: Usage,
    pub lend_error: String,
    pub repo_state: RecvRepo,
    pub repo_got: u32,
    pub repo_error: String,
    /// The received bundle (kept in the saved file; `view` blanks it before the screen sees it).
    #[serde(default)]
    pub bundle_path: Option<String>,
    /// The folder the copy was unpacked into (shown so the person can find it).
    pub unpacked: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    #[serde(default)]
    pub sent: Vec<SentTask>,
    #[serde(default)]
    pub received: Vec<RecvTask>,
    #[serde(default)]
    pub guard: Guard,
    /// "Allow repo hand-over" on this PC: off until the person turns it on. Needed to send a repo and to take one.
    #[serde(default)]
    pub handover_on: bool,
}

/// What the Tasks tab reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksView {
    pub sent: Vec<SentTask>,
    pub received: Vec<RecvTask>,
    pub handover_on: bool,
    pub lend_on: bool,
    /// The most a repo copy can be (bytes), so the sheet can say it before sending.
    pub repo_cap_bytes: u64,
}
