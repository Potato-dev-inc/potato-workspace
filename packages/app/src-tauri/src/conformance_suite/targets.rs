//! The fake targets a vector runs against (SPEC-CHAOS-1113 section 3.2).
//!
//! * `native`: the fake ACP agent as it is.
//! * `native_bad`: `profile=bad`, an agent that breaks the rules a good one keeps.
//! * `json`, `text`: the fake CLI under `tests/fake_cli.rs` through the app's headless bridge. That bridge is not on this branch,
//!   so every vector is `NotClaimed` on them and the matrix says so.
//! * `terminal_only`: an agent with no chat at all. Every chat vector is `NotClaimed`; one vector checks that a chat is refused
//!   with a plain reason.
//!
//! The negative controls are `native` with a cheat switched on (`cheat=auto_approve`, `cheat=deny_ignored`, `cheat=stub`): the
//! runner must FAIL them on the vectors that catch the cheat.

use super::vector::{Level, Vector};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    pub name: &'static str,
    pub level: Level,
    /// Added to the vector's own `opts` (`PM_FAKE_ACP` syntax).
    pub extra_opts: &'static str,
}

impl Target {
    pub const NATIVE: Target = Target { name: "native", level: Level::Native, extra_opts: "" };
    pub const NATIVE_BAD: Target = Target { name: "native_bad", level: Level::NativeBad, extra_opts: "profile=bad" };
    pub const JSON: Target = Target { name: "json", level: Level::Json, extra_opts: "" };
    pub const TEXT: Target = Target { name: "text", level: Level::Text, extra_opts: "" };
    pub const TERMINAL_ONLY: Target = Target { name: "terminal_only", level: Level::TerminalOnly, extra_opts: "" };
    pub const CHEAT_AUTO_APPROVE: Target = Target { name: "cheat_auto_approve", level: Level::Native, extra_opts: "cheat=auto_approve" };
    pub const CHEAT_DENY_IGNORED: Target = Target { name: "cheat_deny_ignored", level: Level::Native, extra_opts: "cheat=deny_ignored" };
    pub const CHEAT_STUB: Target = Target { name: "cheat_stub", level: Level::Native, extra_opts: "cheat=stub" };

    /// The five real targets, in matrix order.
    pub const MATRIX: [Target; 5] = [Target::NATIVE, Target::NATIVE_BAD, Target::JSON, Target::TEXT, Target::TERMINAL_ONLY];

    /// The `PM_FAKE_ACP` string for `vector` on this target.
    pub fn opts_for(&self, vector: &Vector) -> String {
        [vector.opts.as_str(), self.extra_opts].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(";")
    }

    /// Why a target runs nothing, when it does not.
    pub fn unavailable(&self) -> Option<&'static str> {
        match self.level {
            Level::Json | Level::Text => Some("the headless bridge for fake CLIs is not on this branch"),
            _ => None,
        }
    }
}
