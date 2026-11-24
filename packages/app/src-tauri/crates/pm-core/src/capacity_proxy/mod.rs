//! The lend ("share an agent") parts the engine needs: the spec (`spec`) and what a chat on a borrowed sign-in is started with.

pub mod env;
pub mod forward;
pub mod frame;
pub mod gate;
pub mod key_merge;
pub mod link;
pub mod meter;
pub mod shim;
pub mod signin;
pub mod spec;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where the lending PC can be reached on the PC link.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NodeHint {
    /// Node id, 64 hex chars.
    pub id: String,
    #[serde(default)]
    pub relay: String,
    #[serde(default)]
    pub lan: Vec<String>,
}

/// Prefix of a borrowed account id on a pane (`lend:<grant>`).
pub const ACCOUNT_PREFIX: &str = "lend:";

/// Why a chat cannot be borrowed through a PC for an agent.
pub const NO_CHAT: &str = "Chat can't be borrowed through a PC for this agent yet. Open it in a terminal.";

/// What a chat on a borrowed sign-in is started with.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BorrowedChat {
    pub env: crate::tui::LaunchEnv,
    /// Added to the adapter's arguments.
    pub args: Vec<String>,
    /// The adapter's `authenticate` method to call before a session opens.
    pub authenticate: Option<String>,
}
