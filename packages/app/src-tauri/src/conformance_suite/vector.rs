//! The conformance vector format (SPEC-CHAOS-1113 section 3.2): one TOML file per vector under `vectors/`, read at test
//! time from `CARGO_MANIFEST_DIR` (no new crate).
//!
//! ```toml
//! id = "B09"                      # lab id, stable
//! title = "Stop ends the turn and the next message works"
//! levels = ["native", "native_bad", "json", "text"]   # targets it applies to
//! opts = ""                       # extra PM_FAKE_ACP for native targets
//! cost = "fast"                   # fast | slow (only with PM_CONFORMANCE_SLOW=1) | soak
//! claims = ["stop"]               # AgentCaps fields this vector proves; unclaimed = "not claimed", not FAIL
//! [[step]]  do = "prompt"  text = "slow"
//! [[step]]  do = "cancel"  after_ms = 300
//! [[expect]] turn = 1  stop = "cancelled"  within_ms = 5000
//! [[expect]] no_orphans = true
//! ```
//!
//! Each `[[expect]]` table is one check; the keys it uses say which (see [`Expect`]).

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Native,
    NativeBad,
    Json,
    Text,
    TerminalOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cost {
    #[default]
    Fast,
    /// Only with `PM_CONFORMANCE_SLOW=1`.
    Slow,
    /// Only with `PM_CONFORMANCE_SOAK=1`.
    Soak,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Starts a turn. The turn is waited for before the next `prompt` (or the end), but not before a `cancel`, `answer`, `wait`
    /// or `kill_agent` that follows it.
    Prompt {
        text: String,
        /// Which session (a vector with `sessions = 2` has two).
        #[serde(default)]
        session: usize,
    },
    /// Like `prompt`, with a text of `prefix` followed by `count` times `fill` (a megabyte, without a megabyte of TOML).
    PromptBig {
        prefix: String,
        fill: String,
        count: usize,
        #[serde(default)]
        session: usize,
    },
    /// Writes one raw line to the agent's standard input (broken JSON, an unknown method).
    SendRaw { line: String },
    /// Starts a separate host process that runs an agent and its grandchild, then kills the host (an app crash). The agent
    /// and the grandchild are then checked by `no_orphans`.
    CrashHost,
    /// Asks the running turn to stop, `after_ms` after the previous step.
    Cancel {
        #[serde(default)]
        after_ms: u64,
        #[serde(default)]
        session: usize,
    },
    /// Waits for the open permission question and answers it with the option of this kind (`allow_once`, `reject_once`...).
    Answer { option: String },
    /// Changes a setting the agent offers (`model`, `effort`, `mode`).
    SetOption { id: String, value: String },
    /// Kills the agent process (by its own pid).
    KillAgent,
    /// Closes the agent's standard input and nothing else.
    CloseStdin,
    /// Closes the session and starts it again (a fresh agent process).
    Restart,
    Wait { ms: u64 },
    Repeat { times: u32, steps: Vec<Step> },
}

/// One check. Built from the keys of an `[[expect]]` table.
#[derive(Debug, Clone, PartialEq)]
pub enum Expect {
    /// The turn ended with this stop (`end_turn`, `cancelled`, `error`), within `within_ms` of the step that ended it.
    Stop { turn: usize, stop: String, within_ms: Option<u64> },
    // (`stop = "any"` only asks that the turn ended.)
    /// The turn ended with an error whose JSON-RPC code is (or is not) set.
    Error { turn: usize, code_is_set: bool },
    TextHas { turn: usize, text: String },
    TextLacks { turn: usize, text: String },
    ChunksAtLeast { turn: usize, n: usize },
    /// The agent asked the client for permission `times` times in this turn (`kind` empty = any kind).
    Asked { turn: usize, kind: String, times: usize },
    /// A file in the session folder (`exists`, and optionally its `content`).
    File { path: String, exists: bool, content: Option<String> },
    Tool { turn: usize, kind: String, status: Option<String>, has_diff: Option<bool> },
    Thought { turn: usize },
    Usage { turn: usize },
    /// The last step that was refused by the client or the agent said an error that contains `code` (empty = any).
    Refused { code: String },
    /// Every line the agent wrote to stdout was JSON-RPC (the fake counts the lines it could not parse).
    StdoutClean,
    NoOrphans,
    /// The agent process exits by itself (nothing killed it) within this time.
    AgentExits { within_ms: u64 },
    MemoryFlat { max_mb: u64 },
    /// The agent's pid did not change between the first and the last turn.
    SamePid,
    /// Two settings the agent reported, e.g. `model=b`, show in the next `settings` turn's text.
    SettingsReach { turn: usize, text: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawExpect {
    turn: Option<usize>,
    stop: Option<String>,
    within_ms: Option<u64>,
    code_is_set: Option<bool>,
    text_has: Option<String>,
    text_lacks: Option<String>,
    chunks_at_least: Option<usize>,
    asked: Option<String>,
    times: Option<usize>,
    file: Option<String>,
    exists: Option<bool>,
    content: Option<String>,
    tool: Option<String>,
    status: Option<String>,
    has_diff: Option<bool>,
    thought: Option<bool>,
    usage: Option<bool>,
    refused: Option<String>,
    stdout_clean: Option<bool>,
    no_orphans: Option<bool>,
    agent_exits_ms: Option<u64>,
    memory_flat_mb: Option<u64>,
    same_pid: Option<bool>,
    settings_reach: Option<String>,
}

impl RawExpect {
    /// One table can hold several checks (`stop` and `chunks_at_least` for the same turn).
    fn into_expects(self) -> Result<Vec<Expect>, String> {
        let turn = self.turn.unwrap_or(1);
        let mut out = Vec::new();
        if let Some(stop) = self.stop {
            out.push(Expect::Stop { turn, stop, within_ms: self.within_ms });
        }
        if let Some(code_is_set) = self.code_is_set {
            out.push(Expect::Error { turn, code_is_set });
        }
        if let Some(text) = self.text_has {
            out.push(Expect::TextHas { turn, text });
        }
        if let Some(text) = self.text_lacks {
            out.push(Expect::TextLacks { turn, text });
        }
        if let Some(n) = self.chunks_at_least {
            out.push(Expect::ChunksAtLeast { turn, n });
        }
        if let Some(kind) = self.asked {
            out.push(Expect::Asked { turn, kind, times: self.times.unwrap_or(1) });
        }
        if let Some(path) = self.file {
            out.push(Expect::File { path, exists: self.exists.unwrap_or(true), content: self.content });
        }
        if let Some(kind) = self.tool {
            out.push(Expect::Tool { turn, kind, status: self.status, has_diff: self.has_diff });
        }
        if self.thought == Some(true) {
            out.push(Expect::Thought { turn });
        }
        if self.usage == Some(true) {
            out.push(Expect::Usage { turn });
        }
        if let Some(code) = self.refused {
            out.push(Expect::Refused { code });
        }
        if self.stdout_clean == Some(true) {
            out.push(Expect::StdoutClean);
        }
        if self.no_orphans == Some(true) {
            out.push(Expect::NoOrphans);
        }
        if let Some(within_ms) = self.agent_exits_ms {
            out.push(Expect::AgentExits { within_ms });
        }
        if let Some(max_mb) = self.memory_flat_mb {
            out.push(Expect::MemoryFlat { max_mb });
        }
        if self.same_pid == Some(true) {
            out.push(Expect::SamePid);
        }
        if let Some(text) = self.settings_reach {
            out.push(Expect::SettingsReach { turn, text });
        }
        if out.is_empty() {
            return Err("an [[expect]] table names no check".into());
        }
        Ok(out)
    }
}

fn one() -> usize {
    1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawVector {
    id: String,
    title: String,
    levels: Vec<Level>,
    #[serde(default)]
    opts: String,
    #[serde(default)]
    cost: Cost,
    #[serde(default)]
    claims: Vec<String>,
    #[serde(default = "one")]
    sessions: usize,
    inactivity_secs: Option<u64>,
    progress_secs: Option<u64>,
    hung_grace_secs: Option<u64>,
    #[serde(default, rename = "step")]
    steps: Vec<Step>,
    #[serde(default, rename = "expect")]
    expect: Vec<RawExpect>,
}

#[derive(Debug, Clone)]
pub struct Vector {
    pub id: String,
    pub title: String,
    pub levels: Vec<Level>,
    pub opts: String,
    pub cost: Cost,
    pub claims: Vec<String>,
    /// How many sessions the vector drives (1, or 2 for the isolation vector).
    pub sessions: usize,
    /// Shrunk timeouts for the session under test (seconds); `None` keeps the fake's defaults.
    pub inactivity_secs: Option<u64>,
    pub progress_secs: Option<u64>,
    pub hung_grace_secs: Option<u64>,
    pub steps: Vec<Step>,
    pub expect: Vec<Expect>,
}

/// The result of one vector on one target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail(String),
    NotClaimed,
}

impl Outcome {
    pub fn is_fail(&self) -> bool {
        matches!(self, Outcome::Fail(_))
    }
}

impl Vector {
    pub fn parse(text: &str) -> Result<Vector, String> {
        let raw: RawVector = toml::from_str(text).map_err(|e| e.to_string())?;
        let expect = raw.expect.into_iter().map(RawExpect::into_expects).collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect();
        Ok(Vector { id: raw.id, title: raw.title, levels: raw.levels, opts: raw.opts, cost: raw.cost, claims: raw.claims, sessions: raw.sessions, inactivity_secs: raw.inactivity_secs, progress_secs: raw.progress_secs, hung_grace_secs: raw.hung_grace_secs, steps: raw.steps, expect })
    }
}

/// The folder the vector files live in.
pub fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("conformance_suite").join("vectors")
}

/// Every vector file, parsed, sorted by id. `Err` names the first file that does not parse.
pub fn load_all() -> Result<Vec<Vector>, String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(vectors_dir())
        .map_err(|e| format!("cannot read the vectors folder: {e}"))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "toml"))
        .collect();
    files.sort();
    let mut vectors = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let vector = Vector::parse(&text).map_err(|e| format!("{}: {e}", file.display()))?;
        let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        if !stem.starts_with(&vector.id) {
            return Err(format!("{}: the file name must start with the vector id {}", file.display(), vector.id));
        }
        vectors.push(vector);
    }
    vectors.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(vectors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spec_example_parses() {
        let v = Vector::parse(
            r#"
id = "B09"
title = "Stop ends the turn and the next message works"
levels = ["native", "native_bad", "json", "text"]
opts = ""
cost = "fast"
claims = ["stop"]
[[step]]
do = "prompt"
text = "slow"
[[step]]
do = "cancel"
after_ms = 300
[[step]]
do = "prompt"
text = "stream 2"
[[expect]]
turn = 1
stop = "cancelled"
within_ms = 5000
[[expect]]
turn = 2
stop = "end_turn"
chunks_at_least = 2
[[expect]]
no_orphans = true
"#,
        )
        .unwrap();
        assert_eq!(v.id, "B09");
        assert_eq!(v.levels.len(), 4);
        assert_eq!(v.steps.len(), 3);
        // One table can hold several checks.
        assert_eq!(v.expect[0], Expect::Stop { turn: 1, stop: "cancelled".into(), within_ms: Some(5000) });
        assert_eq!(v.expect[2], Expect::ChunksAtLeast { turn: 2, n: 2 });
        assert_eq!(v.expect[3], Expect::NoOrphans);
    }

    #[test]
    fn a_table_with_no_check_or_a_misspelt_key_is_refused() {
        let base = "id = \"X\"\ntitle = \"t\"\nlevels = [\"native\"]\n";
        assert!(Vector::parse(&format!("{base}[[expect]]\nturn = 1\n")).is_err());
        assert!(Vector::parse(&format!("{base}[[expect]]\nstopp = \"x\"\n")).is_err());
        assert!(Vector::parse(&format!("{base}[[step]]\ndo = \"dance\"\n")).is_err());
    }

    #[test]
    fn a_repeat_step_holds_steps() {
        let v = Vector::parse("id = \"S\"\ntitle = \"t\"\nlevels = [\"native\"]\n[[step]]\ndo = \"repeat\"\ntimes = 3\nsteps = [{do = \"prompt\", text = \"stream 1\"}]\n").unwrap();
        assert!(matches!(&v.steps[0], Step::Repeat { times: 3, steps } if steps.len() == 1));
    }
}
