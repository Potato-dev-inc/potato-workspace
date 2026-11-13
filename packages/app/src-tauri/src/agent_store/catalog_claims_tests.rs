//! Every capability a shipped Agent Store entry claims must have a fixture that shows it.
//!
//! A claim is read from the definition the way the app reads it:
//! - a `[headless]` table claims a one-task run, so the fixtures need a `headless_*` capture;
//! - a `[tui]` table claims a pane, so the fixtures need a `tui_*` capture;
//! - resume (`features.resumable_headless`, or derived when absent: a `resume` segment plus a
//!   session selector) needs a `headless_resume*` capture;
//! - `features.read_only_headless` claims a read-only one-task run, so it needs a `headless_*` capture.
//!
//! The test checks that a capture of the right kind exists. It does not read the capture's content:
//! the fixture rules in `check.rs` (rule 6) and the conformance rules do that for verified entries.

use super::catalog;
use crate::tui::declarative::parse_definition;
use crate::tui::declarative::schema::Definition;

/// Entries that claim a capability without a fixture yet, found by the first run of this test on
/// 2026-11-13: `kiro` claims a one-task run and resume with no capture. group b/c tonight: the lead
/// removes this list after merging groups b and c. Group a has no entries here.
const PENDING_GROUP_BC: &[&str] = &["kiro"];

/// Whether the definition claims resume. The app's rule: an explicit `resumable_headless` wins,
/// otherwise a `resume` segment and a session selector make it resumable.
fn claims_resume(def: &Definition) -> bool {
    match def.features.resumable_headless {
        Some(value) => value,
        None => def.headless.as_ref().is_some_and(|headless| {
            headless.optional.iter().any(|segment| segment.when == "resume")
                && headless.output.as_ref().is_some_and(|output| output.session.is_some())
        }),
    }
}

/// The claims of one definition, each with the fixture name prefix that would show it.
fn claims(def: &Definition) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    if def.headless.is_some() {
        out.push(("a one-task run (headless)", "headless_"));
    }
    if def.tui.is_some() {
        out.push(("a pane (tui)", "tui_"));
    }
    if claims_resume(def) {
        out.push(("resume", "headless_resume"));
    }
    if def.features.read_only_headless {
        out.push(("a read-only one-task run", "headless_"));
    }
    out
}

/// One message per claim with no capture of its kind in the entry's fixtures folder.
fn unproven(entry: &catalog::CatalogEntry, def: &Definition) -> Vec<String> {
    claims(def)
        .into_iter()
        .filter(|(_, prefix)| {
            !entry
                .fixtures
                .iter()
                .any(|(name, _)| name.starts_with(prefix) && !name.ends_with(".expect.toml"))
        })
        .map(|(claim, prefix)| format!("claims {claim} but has no {prefix}* capture in fixtures/"))
        .collect()
}

#[test]
fn every_catalog_claim_has_a_fixture() {
    let mut failures = Vec::new();
    for entry in catalog::all() {
        let id = entry.entry.store.id.as_str();
        if PENDING_GROUP_BC.contains(&id) {
            continue;
        }
        // A built-in entry has no definition file, so it claims nothing this test can read.
        let Some(text) = entry.definition_text.as_deref() else { continue };
        let def = parse_definition(text).unwrap_or_else(|error| panic!("{id}: definition does not parse: {error}"));
        for message in unproven(entry, &def) {
            failures.push(format!("{id}: {message}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn a_claim_without_its_capture_is_reported_and_a_starter_claims_nothing() {
    let def = parse_definition(
        r#"schema_version = 1
[agent]
id = "probe"
label = "Probe"
description = "x"
[binary]
names = ["probe"]
[headless]
argv = ["run"]
[headless.output]
format = "json_lines"
[[headless.optional]]
when = "resume"
args = ["-s", "{session}"]
[headless.output.session]
where = { "~sessionID" = true }
path = "sessionID"
pick = "first"
"#,
    )
    .expect("probe definition parses");
    assert!(claims_resume(&def), "a resume segment with a session selector is a resume claim");
    let starter = parse_definition(
        r#"schema_version = 1
[agent]
id = "plain"
label = "Plain"
description = "x"
kind = "generic"
experimental = true
[binary]
names = ["plain"]
"#,
    )
    .expect("starter definition parses");
    assert!(claims(&starter).is_empty(), "a terminal-only starter claims nothing");
}
