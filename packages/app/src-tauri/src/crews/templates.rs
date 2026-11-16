//! Template crews: files compiled into the app, shown read-only. A template is not a starter (the Start
//! sheet never lists it: its roles are meant for the canvas, which applies a crew in 1.1.7) and is never
//! written to the profile's app data. A template is named `template:<id>`; a file slug has no colon.
//! Each template comes with the routing file its `routing_file` names (plain words, `difficulty.md`).

use super::model::{parse, Crew};
use super::store::{self, Summary};
use super::validate::AgentState;

pub const PREFIX: &str = "template:";

/// The draft routing file of "Our way": how work is routed, in plain words.
pub const DIFFICULTY_MD: &str = include_str!("templates/difficulty.md");
/// The routing file of "How we work".
pub const HOW_WE_WORK_MD: &str = include_str!("templates/how-we-work.md");

/// (id, crew file text, routing file text).
const SOURCES: [(&str, &str, &str); 2] = [
    ("our-way", include_str!("templates/our-way.toml"), DIFFICULTY_MD),
    ("how-we-work", include_str!("templates/how-we-work.toml"), HOW_WE_WORK_MD),
];

/// Every template as (slug, crew).
pub fn all() -> Vec<(String, Crew)> {
    SOURCES.iter().filter_map(|(id, text, _)| parse(text).ok().map(|crew| (format!("{PREFIX}{id}"), crew))).collect()
}

/// The template a slug names (`None` for any other slug).
pub fn lookup(slug: &str) -> Option<Crew> {
    let id = slug.strip_prefix(PREFIX)?;
    SOURCES.iter().find(|(known, _, _)| *known == id).and_then(|(_, text, _)| parse(text).ok())
}

/// The routing file text of a template.
pub fn routing_text(slug: &str) -> Option<&'static str> {
    let id = slug.strip_prefix(PREFIX)?;
    SOURCES.iter().find(|(known, _, _)| *known == id).map(|(_, _, text)| *text)
}

/// The templates as the list shows them.
pub fn summaries(agent_state: &dyn Fn(&str) -> AgentState) -> Vec<Summary> {
    all().iter().map(|(slug, crew)| store::summary(slug, crew, agent_state)).collect()
}
