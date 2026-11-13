//! Where one agent's plan usage can be read: the `[usage]` table of its profile (`tui/<agent>/usage.toml`).
//!
//! The table is DATA. The readers in `readers.rs` are named by the shape of the data they read
//! (`jsonl_rate_limits`, `status_json`), never by an agent.

use serde::Deserialize;

pub const SCHEMA: u32 = 1;

#[derive(Debug, Deserialize)]
struct UsageFile {
    usage: UsageSource,
}

/// One agent's usage source.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageSource {
    pub schema: u32,
    /// The agent's own usage page, opened on click. Never fetched by the app.
    #[serde(default)]
    pub page: Option<String>,
    /// The folder of the main login (no account). `~` expands. When the profile's account env var
    /// (`AccountScheme::home_env`) is set in the app's own environment, that wins.
    #[serde(default)]
    pub main_home: Option<String>,
    pub reader: Reader,
    /// The command a `status_json` reader runs. Filled in code by the profile (the program path is
    /// found at run time), never read from the TOML.
    #[serde(skip)]
    pub command: Option<(String, Vec<String>)>,
}

/// How the numbers are read.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reader {
    /// The newest JSON line carrying a rate-limit object in the newest `.jsonl` files under
    /// `<home>/<dir>`. Pointers are RFC 6901 JSON pointers; window fields are relative to `object`.
    JsonlRateLimits {
        dir: String,
        #[serde(default)]
        file_prefix: Option<String>,
        #[serde(default = "default_max_age_days")]
        max_age_days: u64,
        /// Pointer to the rate-limit object inside one line (`/payload/rate_limits`).
        object: String,
        /// Pointer to the line's RFC 3339 time (`/timestamp`).
        #[serde(default)]
        observed_at: Option<String>,
        /// Field of `object` holding the plan name.
        #[serde(default)]
        plan: Option<String>,
        /// Field of `object` that is non-null while the agent is stopped at a limit.
        #[serde(default)]
        reached: Option<String>,
        windows: Vec<WindowSpec>,
    },
    /// The agent's own status command prints JSON; `signed_in` points at a boolean. No usage numbers.
    StatusJson {
        signed_in: String,
        /// Boolean that is true when a login existed but no longer works ("Sign-in expired").
        #[serde(default)]
        had_login: Option<String>,
        /// Why there are no numbers (shown in the tooltip).
        reason: String,
    },
    /// The agent's own usage address, asked with the access token from the sign-in's credential file
    /// (`oauth.rs`). HTTPS only, no redirects, the token only in memory for the one request.
    OauthUsage {
        /// File in the sign-in's home holding the token (`.credentials.json`).
        credentials_file: String,
        /// Pointer to the access token in that file.
        token: String,
        /// Pointer to the token's expiry (Unix ms); an expired token is never sent and never refreshed.
        #[serde(default)]
        expires_at: Option<String>,
        url: String,
        /// Extra request headers, exactly as the agent's own client sends them.
        #[serde(default)]
        headers: Vec<(String, String)>,
        /// Field of each window: percent used (0-100).
        used: String,
        /// Field of each window: reset time (RFC 3339 or Unix seconds/ms).
        resets_at: String,
        windows: Vec<OauthWindow>,
        /// Shown when there are no numbers yet.
        reason: String,
        /// Who answers, for the reasons a row shows ("Anthropic said slow down (429)").
        #[serde(default)]
        provider: Option<String>,
    },
    /// Pay-per-use agents have no plan limit. Each message the agent keeps in its own SQLite file carries a JSON
    /// blob with cost and token counts; they are summed for today and the last 7 days, per model (`sqlite.rs`).
    /// The file is opened read-only and only those numbers and the model name are read.
    SqliteTotals {
        /// The database, relative to the sign-in's home (`opencode/opencode.db`).
        file: String,
        table: String,
        /// Column with the Unix time in milliseconds.
        time_column: String,
        /// Column with the JSON text.
        data_column: String,
        /// Only rows where this pointer holds this text (`/role` = `assistant`).
        #[serde(default)]
        only: Option<(String, String)>,
        model: String,
        cost: String,
        /// Pointers summed into the token count (input, output, reasoning; cache reads are left out).
        tokens: Vec<String>,
        /// Shown when there are no numbers yet.
        reason: String,
    },
    /// No local or CLI source of numbers. The row still shows sign-in and limits the app saw on screen.
    None { reason: String },
}

/// One limit window inside the rate-limit object.
#[derive(Debug, Clone, Deserialize)]
pub struct WindowSpec {
    /// Field of the object holding this window (`primary`).
    pub key: String,
    /// Field of the window: percent used, 0-100.
    pub used: String,
    /// Field of the window: its length in minutes (names the window: 5-hour, weekly...).
    #[serde(default)]
    pub minutes: Option<String>,
    /// Field of the window: reset time in Unix seconds.
    #[serde(default)]
    pub resets_at: Option<String>,
}

/// One window of an `oauth_usage` answer: its field and how it is named.
#[derive(Debug, Clone, Deserialize)]
pub struct OauthWindow {
    pub key: String,
    pub minutes: u64,
    /// Name when the length alone would repeat one ("Weekly Opus").
    #[serde(default)]
    pub name: Option<String>,
}

fn default_max_age_days() -> u64 {
    30
}

/// Parse a profile's `usage.toml`. `None` when it is invalid (a profile test fails on that).
pub fn from_toml(text: &str) -> Option<UsageSource> {
    let file: UsageFile = toml::from_str(text).ok()?;
    (file.usage.schema == SCHEMA).then_some(file.usage)
}
