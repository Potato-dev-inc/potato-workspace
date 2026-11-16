//! "Follow a task" on the crew canvas: the path of a task through the roles of a crew, read from records the app already
//! keeps (which pane started which helper, and the turns each pane was given). Nothing is recorded for this, and nothing
//! here sends or runs anything: it only reads.
//!
//! A task is a turn the lead was given after it started (the first turn of every role is its job from "Start crew"). The
//! hand-overs of a task are the turns the lead's helpers were given from that moment until the lead's next task, each with
//! the exact words and what came back. It cannot show what an agent only thought, only what the app handed over.

use super::model::Crew;
use serde::Serialize;

/// Most tasks listed, newest first, and most steps in one task.
pub const MAX_TASKS: usize = 20;
pub const MAX_STEPS: usize = 40;
/// The words of one step are cut here (the screen cuts them shorter and offers "Show all").
pub const MAX_WORDS: usize = 2000;

/// One turn a pane was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnFact {
    /// 0 is the job the role got when the crew started.
    pub index: u32,
    pub task: String,
    pub at_ms: u64,
    pub status: String,
    pub result: Option<String>,
}

/// A pane that carries a title (a started role is titled with its role name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneFact {
    pub pane_id: String,
    pub parent: Option<String>,
    pub title: String,
    pub turns: Vec<TurnFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    /// The role's name in the crew.
    pub role: String,
    /// The role that handed this over (`None` for the lead's own task).
    pub from: Option<String>,
    pub words: String,
    pub at_ms: u64,
    pub status: String,
    /// What the role reported back, when it did.
    pub came_back: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Task {
    pub id: String,
    /// The person's words to the lead; empty when the lead had no recorded task (work handed over without one).
    pub words: String,
    pub at_ms: u64,
    /// `running` while any step is, else `failed` when one failed, else `done`.
    pub status: String,
    pub steps: Vec<Step>,
}

fn cap(text: &str) -> String {
    if text.chars().count() <= MAX_WORDS {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX_WORDS).collect();
    format!("{cut}…")
}

fn role_name(crew: &Crew, title: &str) -> Option<String> {
    crew.roles.iter().find(|r| r.is_called(title)).map(|r| r.name.clone())
}

/// `pane` is under `root` when walking its parents reaches `root`.
fn under(panes: &[PaneFact], pane: &PaneFact, root: &str) -> bool {
    let mut at = pane.parent.clone();
    for _ in 0..panes.len() {
        match at {
            Some(id) if id == root => return true,
            Some(id) => at = panes.iter().find(|p| p.pane_id == id).and_then(|p| p.parent.clone()),
            None => return false,
        }
    }
    false
}

fn finished(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn summary(steps: &[Step]) -> String {
    if steps.iter().any(|s| !finished(&s.status)) {
        "running".into()
    } else if steps.iter().any(|s| s.status == "failed") {
        "failed".into()
    } else {
        "done".into()
    }
}

/// The tasks of every started copy of `crew`, newest first.
pub fn build(crew: &Crew, panes: &[PaneFact]) -> Vec<Task> {
    let Some(lead) = crew.roles.iter().find(|r| r.parent.is_none()) else { return Vec::new() };
    let mut tasks: Vec<Task> = Vec::new();
    for root in panes.iter().filter(|p| role_name(crew, &p.title).as_deref() == Some(lead.name.as_str())) {
        let helpers: Vec<&PaneFact> = panes.iter().filter(|p| under(panes, p, &root.pane_id) && role_name(crew, &p.title).is_some()).collect();
        let mut own: Vec<&TurnFact> = root.turns.iter().filter(|t| t.index >= 1).collect();
        own.sort_by_key(|t| (t.index, t.at_ms));
        let handed = |from: u64, until: u64, first_turn_counts: bool| -> Vec<Step> {
            let mut steps: Vec<Step> = Vec::new();
            for pane in &helpers {
                let parent = pane.parent.as_deref().and_then(|id| panes.iter().find(|p| p.pane_id == id)).and_then(|p| role_name(crew, &p.title));
                for turn in pane.turns.iter().filter(|t| t.at_ms >= from && t.at_ms < until && (first_turn_counts || t.index >= 1)) {
                    steps.push(Step {
                        role: role_name(crew, &pane.title).unwrap_or_default(),
                        from: parent.clone(),
                        words: cap(&turn.task),
                        at_ms: turn.at_ms,
                        status: turn.status.clone(),
                        came_back: turn.result.as_ref().filter(|r| !r.trim().is_empty()).map(|r| cap(r)),
                    });
                }
            }
            steps.sort_by_key(|s| s.at_ms);
            steps
        };
        if own.is_empty() {
            let steps = handed(0, u64::MAX, false);
            if !steps.is_empty() {
                let at_ms = steps[0].at_ms;
                tasks.push(Task { id: format!("{}:work", root.pane_id), words: String::new(), at_ms, status: summary(&steps), steps: steps.into_iter().take(MAX_STEPS).collect() });
            }
            continue;
        }
        for (n, turn) in own.iter().enumerate() {
            let until = own.get(n + 1).map_or(u64::MAX, |next| next.at_ms);
            let mut steps = vec![Step {
                role: lead.name.clone(),
                from: None,
                words: cap(&turn.task),
                at_ms: turn.at_ms,
                status: turn.status.clone(),
                came_back: turn.result.as_ref().filter(|r| !r.trim().is_empty()).map(|r| cap(r)),
            }];
            steps.extend(handed(turn.at_ms, until, true));
            tasks.push(Task { id: format!("{}:{}", root.pane_id, turn.index), words: cap(&turn.task), at_ms: turn.at_ms, status: summary(&steps), steps: steps.into_iter().take(MAX_STEPS).collect() });
        }
    }
    tasks.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    tasks.truncate(MAX_TASKS);
    tasks
}

/// The panes of the registry with the turns each was given. Words are redacted before they leave here.
pub fn live_facts(registry: &std::sync::Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>) -> Vec<PaneFact> {
    let infos = registry.lock().list();
    infos
        .into_iter()
        .filter_map(|info| {
            let title = info.title.clone().filter(|_| crate::ambient::store::is_user_set(&info.id))?;
            let turns = crate::agent_runs::pane_api::run_of_pane(registry, &info.id)
                .and_then(|(project, handle)| crate::operations::turns_for_handle(&project, &handle).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|t| TurnFact {
                    index: t.turn_index,
                    task: crate::redact::strict(&t.task).into_inner(),
                    at_ms: t.created_at_ms,
                    status: serde_json::to_value(t.status).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
                    result: t.result.as_deref().map(|r| crate::redact::strict(r).into_inner()),
                })
                .collect();
            Some(PaneFact { pane_id: info.id, parent: info.parent_pane_id, title, turns })
        })
        .collect()
}
