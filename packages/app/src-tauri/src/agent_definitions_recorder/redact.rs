//! The recorder's redaction is now the app-wide one in `crate::redact` (REC-3 still holds: raw text
//! never reaches a snapshot). This file keeps the old path working for the recorder and its tests.

pub use crate::redact::rules::{redact, RedactContext};
#[cfg(test)]
pub use crate::redact::rules::{secret_env_values, MASK};

#[cfg(test)]
pub(super) use crate::redact::rules::test_ctx;
