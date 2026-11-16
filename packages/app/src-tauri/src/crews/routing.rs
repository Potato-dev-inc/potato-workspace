//! "Try a task": which role would a task go to? A dry run over the routing file of a crew (plain words, like
//! `difficulty.md`). Nothing runs and nothing is sent: it only names the role and says why, so the person can
//! agree or choose another. Slot for 1.1.8 (Follow a task): this is where a replay of the real route would start.
//!
//! The routing file is read as: a line `Name -> role` starts a route; the `- ` lines under it are its rules. A
//! line `Ask me first` starts the things that need the person. Other lines are ignored.

use super::model::{Crew, Role};
use serde::Serialize;

/// Words too common to say anything about a task.
const SKIP: [&str; 24] = [
    "that", "this", "with", "from", "have", "into", "when", "then", "than", "them", "they", "your", "does", "each", "every", "only", "more",
    "less", "anything", "known", "task", "tasks", "files", "file",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    role: String,
    words: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Route {
    /// The role's id (or name).
    pub role: String,
    /// One plain sentence.
    pub why: String,
    /// True when no rule matched and the first route was taken.
    pub fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub route: Route,
    /// Roles the task passes through, in order: the lead, the chosen role, then each checker.
    pub path: Vec<String>,
    /// Words of the task that the routing file says need the person first.
    pub needs_you: Vec<String>,
    /// Every other role a rule points at, so the person can pick one instead.
    pub others: Vec<String>,
}

fn words_of(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in text.split(|c: char| !c.is_alphanumeric()).map(str::to_lowercase) {
        let w = w.trim_end_matches('s').to_string();
        if w.chars().count() >= 4 && !SKIP.contains(&w.as_str()) && !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// The routes and the ask-first words of a routing file.
fn read(text: &str) -> (Vec<Rule>, Vec<String>) {
    let mut rules: Vec<Rule> = Vec::new();
    let mut ask: Vec<String> = Vec::new();
    // 0: none, 1: a route, 2: ask first
    let mut mode = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(bullet) = line.strip_prefix("- ") {
            match mode {
                1 => {
                    if let Some(rule) = rules.last_mut() {
                        for w in words_of(bullet) {
                            if !rule.words.contains(&w) {
                                rule.words.push(w);
                            }
                        }
                    }
                }
                2 => ask.extend(words_of(bullet)),
                _ => {}
            }
        } else if let Some((_, role)) = line.split_once("->") {
            rules.push(Rule { role: role.trim().to_string(), words: Vec::new() });
            mode = 1;
        } else if line.to_lowercase().starts_with("ask me first") {
            mode = 2;
        } else {
            mode = 0;
        }
    }
    (rules, ask)
}

fn find<'a>(crew: &'a Crew, name: &str) -> Option<&'a Role> {
    crew.roles.iter().find(|r| r.is_called(name))
}

/// Where `task` would go in `crew`, by `routing_text`. `None` when the file names no role of the crew.
pub fn preview(crew: &Crew, routing_text: &str, task: &str) -> Option<Preview> {
    let (rules, ask) = read(routing_text);
    let rules: Vec<Rule> = rules.into_iter().filter(|r| find(crew, &r.role).is_some()).collect();
    let first = rules.first()?;
    let task_words = words_of(task);
    let hits = |rule: &Rule| -> Vec<String> { rule.words.iter().filter(|w| task_words.contains(w)).cloned().collect() };
    let mut best: Option<(&Rule, Vec<String>)> = None;
    for rule in &rules {
        let found = hits(rule);
        // Cheapest first: a later route needs strictly more matches to win.
        if !found.is_empty() && best.as_ref().is_none_or(|(_, b)| found.len() > b.len()) {
            best = Some((rule, found));
        }
    }
    let (rule, found, fallback) = match best {
        Some((rule, found)) => (rule, found, false),
        None => (first, Vec::new(), true),
    };
    let role = find(crew, &rule.role)?;
    let why = if fallback {
        format!("Nothing in the rules fits this task, so it starts with the cheapest way: {}.", role.name)
    } else {
        format!("It fits the rules for {} ({}).", role.name, found.iter().take(3).cloned().collect::<Vec<_>>().join(", "))
    };
    let lead = crew.roles.iter().find(|r| r.parent.is_none());
    let mut path: Vec<String> = Vec::new();
    if let Some(lead) = lead {
        path.push(lead.key().to_string());
    }
    if !path.iter().any(|p| p == role.key()) {
        path.push(role.key().to_string());
    }
    for checker in crew.roles.iter().filter(|r| r.check && r.key() != role.key()) {
        path.push(checker.key().to_string());
    }
    let needs_you: Vec<String> = ask.into_iter().filter(|w| task_words.contains(w)).collect();
    let others = rules.iter().filter_map(|r| find(crew, &r.role)).map(|r| r.key().to_string()).filter(|k| k != role.key()).collect();
    Some(Preview { route: Route { role: role.key().to_string(), why, fallback }, path, needs_you, others })
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
