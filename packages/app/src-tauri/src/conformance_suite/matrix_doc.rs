//! `docs/AGENT-MATRIX.md` must be what `scripts/gen-agent-matrix.mjs` makes of the runner's matrix JSON.
//! Fix a failure with: `cargo test --lib -- conformance_matrix_json_is_written` then `node scripts/gen-agent-matrix.mjs`.

use std::io::Write;
use std::process::{Command, Stdio};

#[test]
#[ignore = "slow: run with --ignored or via scripts/gen-agent-matrix.mjs --check"]
fn matrix_doc_is_fresh() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
    let json = serde_json::to_string(&super::runner::matrix_json()).unwrap();
    let spawned = Command::new("node")
        .current_dir(&root)
        .args(["scripts/gen-agent-matrix.mjs", "--json", "-", "--check"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = spawned else {
        eprintln!("matrix_doc_is_fresh: node is not on PATH, skipped");
        return;
    };
    child.stdin.take().unwrap().write_all(json.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "docs/AGENT-MATRIX.md is out of date:\n{}", String::from_utf8_lossy(&out.stderr));
}
