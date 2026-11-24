//! Wizard tests. No tokens, no network: the "agent" is a tiny fake CLI compiled from
//! `tests/fake-cli/fake_cli.rs` (see `support`).

pub mod fake_host;
pub mod support;

#[cfg(test)]
mod acp_check_tests;
#[cfg(test)]
mod acp_tests;
#[cfg(test)]
mod agent_error_tests;
#[cfg(test)]
mod email_redaction_tests;
#[cfg(test)]
mod auto_tests;
#[cfg(test)]
mod auto_verdict_tests;
#[cfg(test)]
mod ask_tests;
#[cfg(test)]
mod benchmark;
#[cfg(test)]
mod e2e;
#[cfg(test)]
mod exec_tests;
#[cfg(test)]
mod finish_tests;
#[cfg(test)]
mod livetest_tests;
#[cfg(test)]
mod probe_tests;
#[cfg(test)]
mod report_tests;
#[cfg(test)]
mod state_tests;
#[cfg(test)]
mod verify_tests;
#[cfg(test)]
mod visible_answer_tests;
#[cfg(test)]
mod visible_autoanswer_tests;
#[cfg(test)]
mod visible_api_tests;
#[cfg(test)]
mod visible_capture_tests;
#[cfg(test)]
mod visible_finish_tests;
#[cfg(test)]
mod visible_isolation_tests;
#[cfg(test)]
mod visible_livetest_tests;
#[cfg(test)]
mod visible_menu_shape_tests;
#[cfg(test)]
mod visible_read_menu_look_tests;
#[cfg(test)]
mod visible_transcript_bullets_tests;
#[cfg(test)]
mod visible_transcript_find_tests;
#[cfg(test)]
mod visible_screen_agent_tests;
#[cfg(test)]
mod visible_screen_tests;
#[cfg(test)]
mod visible_verify_tests;
#[cfg(test)]
mod visible_work_capture_tests;
#[cfg(test)]
mod visible_work_tests;
