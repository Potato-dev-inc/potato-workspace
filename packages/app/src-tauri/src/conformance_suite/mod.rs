//! Conformance vectors and the chaos test homes (SPEC-CHAOS-1113). Tests only.
//!
//! * `rig`: `AcpRig` and `ChatRig`, the two rigs the vectors and the chaos tests drive.
//! * `vector`: the vector file format (`vectors/*.toml`) and its loader.
//! * `targets`: the fake targets (`native`, `native_bad`, `json`, `text`, `terminal_only`) and the negative controls.
//! * `runner`: runs a vector on a target; the matrix and the must-fail tests.
//! * `chaos`: empty test files the chaos writers fill (`test/chaos-a`, `test/chaos-b`).

pub(crate) mod rig;
mod runner;
mod targets;
mod vector;

mod matrix_doc;

mod chaos;
