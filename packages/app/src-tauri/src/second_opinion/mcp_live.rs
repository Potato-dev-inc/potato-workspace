//! The running app behind [`super::mcp::ReviewIo`]: find the finished run (a chat or a terminal run), start the
//! read-only reviewer through the normal `run_agent` path as the caller's own run, and poll it.

use super::mcp::{ReviewAsk, ReviewIo, RunFacts, Started};
use super::service::{self, Poll, ReviewerEntry};
use crate::operations::OperationError;
use crate::pty::PaneRegistry;
use parking_lot::Mutex;
use std::sync::Arc;

type Registry = Arc<Mutex<PaneRegistry>>;

pub struct LiveReview {
    pub registry: Registry,
    pub app: tauri::AppHandle,
    pub session: Option<String>,
}

impl LiveReview {
    fn locate(&self, project: Option<&str>, handle: &str) -> Result<RunFacts, OperationError> {
        // A chat session: its handle is its pane id.
        if let Some(chat) = crate::acp::chat::get(handle.trim()) {
            let cwd = self
                .registry
                .lock()
                .panes
                .get(chat.pane_id())
                .map(|p| p.info.cwd.clone())
                .ok_or_else(|| OperationError::new("AGENT_GONE", "That chat's pane is closed, so there is nothing to look at.", false))?;
            return Ok(RunFacts { author_agent: chat.agent_id().to_string(), project: cwd, pane_id: chat.pane_id().to_string() });
        }
        let default_project = self.registry.lock().project_path.clone();
        let project = project.map(str::to_string).filter(|p| !p.trim().is_empty()).unwrap_or(default_project);
        let snapshot = crate::operations::resolve_agent_run(&project, handle)?;
        Ok(RunFacts {
            author_agent: snapshot.agent_type.clone(),
            project: snapshot.project_path.clone(),
            pane_id: snapshot.pane_id.clone().unwrap_or_default(),
        })
    }
}

impl ReviewIo for LiveReview {
    fn facts(&self, project: Option<&str>, handle: &str) -> Result<RunFacts, OperationError> {
        self.locate(project, handle)
    }

    fn reviewers(&self, author: &str) -> Vec<ReviewerEntry> {
        service::reviewers(Some(author))
    }

    fn start(&self, facts: &RunFacts, reviewer: &str, model: Option<&str>) -> Result<Started, OperationError> {
        let info = service::start_target(
            &facts.pane_id,
            &facts.project,
            &facts.author_agent,
            reviewer,
            model,
            self.registry.clone(),
            self.app.clone(),
            self.session.clone(),
        )?;
        Ok(Started { handle: info.handle, project: info.project, source_label: info.source_label.to_string(), files: info.files })
    }

    fn poll(&self, project: &str, handle: &str) -> Result<Poll, OperationError> {
        service::poll(project, handle)
    }

    fn sleep(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// `review_agent` / `run_agent(review_by)`: the `review` object for the finished run `handle`.
pub fn review_handle(
    registry: Registry,
    app: tauri::AppHandle,
    session: Option<String>,
    project: Option<&str>,
    handle: &str,
    ask: &ReviewAsk,
    wait_ms: u64,
) -> Result<serde_json::Value, OperationError> {
    let io = LiveReview { registry, app, session };
    super::mcp::review_run(&io, project, handle, ask, wait_ms)
}
