//! The redactor lives in `pm-core` (`pm_core::redact`); this keeps the old path. The two doc tests stay here because they
//! need the app's `agent_runs`, which `pm-core` cannot name.
//!
//! ```compile_fail
//! // A raw string does not compile where a redacted one is required.
//! puppet_master_app_lib::agent_runs::transcript::append("p", "op", "stdout", "sk-ant-api03-secret");
//! ```
//!
//! ```no_run
//! // The same call compiles once the text went through `redact`.
//! use puppet_master_app_lib::{agent_runs::transcript, redact};
//! transcript::append("p", "op", "stdout", &redact::text("hello"));
//! ```

pub use pm_core::redact::*;
