//! The one integration-test binary of this crate (`cargo test --test fake_tui_e2e`).
//!
//! Every integration test links the whole app crate, so each file used to be its own multi-hundred-MB link. They
//! are modules of this one binary now. Test names carry the module as a prefix, so the old filters still match as
//! substrings: `package_check`, `collision::`, `ci_fix`, `what_broke_it`, `hook_emitter` and so on.
//!
//! ```text
//! cargo test --features dev-fake-tui --test fake_tui_e2e -- --test-threads=1                  # everything
//! cargo test --features dev-fake-tui --test fake_tui_e2e what_broke_it -- --test-threads=1     # one group
//! cargo test --test fake_tui_e2e hook_emitter                                                  # needs no feature
//! ```
//!
//! - `fake_tui` (`fake_tui_e2e.rs` and the `fake_tui_*.rs` files it includes): the fake-agent scenarios. One World,
//!   one app-data root per process.
//! - `what_broke_it` (`what_broke_it_e2e.rs`): the What broke it scenarios. They take their own lock; the app-data
//!   root is whichever of the two sets it first (a temp folder either way).
//! - `hook_emitter` (`hook_emitter.rs`): fail-open tests of the real `puppet-master-mcp hook` exe. No feature needed.
//!
//! Cargo's automatic discovery of `tests/*.rs` is off (`autotests = false`), or every `fake_tui_*.rs` file would
//! also be built and linked again as a test binary of its own.

mod hook_emitter;

#[cfg(feature = "dev-fake-tui")]
#[path = "fake_tui_e2e.rs"]
mod fake_tui;

#[cfg(feature = "dev-fake-tui")]
#[path = "what_broke_it_e2e.rs"]
mod what_broke_it;
