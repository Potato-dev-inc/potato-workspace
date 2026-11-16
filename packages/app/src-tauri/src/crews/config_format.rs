//! The crew sections of the CLI config file (PLAN-CLI.md): `version = 1`, then one `[crew.<id>]` table per
//! crew with `[[crew.<id>.role]]` roles. The role fields are the ones of `model::Role` (`agent` and `job`
//! are accepted for `agent_type` and `task`). Other sections of the file (settings, labs, ...) belong to
//! the config export and are ignored here; the export on the CLI branch calls `render` and `parse` so one
//! shape serves both files. Unknown keys inside a crew are an error, like everywhere else.

use super::model::{Crew, CrewError, MAX_FILE_BYTES};
use super::store::valid_slug;

/// The config file version this reads and writes.
pub const VERSION: i64 = 1;
/// A config file holds at most this many crews.
pub const MAX_CREWS: usize = 20;

/// Whether a text is a config file with crew sections (a top-level `crew` table).
pub fn is_config(text: &str) -> bool {
    toml::from_str::<toml::Table>(text).is_ok_and(|t| t.contains_key("crew"))
}

/// The crews of a config file as (id, crew), in id order. The name defaults to the id.
pub fn parse(text: &str) -> Result<Vec<(String, Crew)>, CrewError> {
    if text.len() > MAX_FILE_BYTES {
        return Err(CrewError::new("CREW_FILE_TOO_BIG", "This file is too big to read."));
    }
    let invalid = |why: String| CrewError::new("CREW_FILE_INVALID", format!("This config file cannot be read: {why}"));
    let table: toml::Table = toml::from_str(text).map_err(|e| invalid(e.message().to_string()))?;
    if let Some(version) = table.get("version") {
        if version.as_integer() != Some(VERSION) {
            return Err(CrewError::new("CONFIG_VERSION", format!("This config file has a version this app cannot read (it reads version {VERSION}).")));
        }
    }
    let Some(crews) = table.get("crew") else { return Ok(Vec::new()) };
    let Some(crews) = crews.as_table() else { return Err(invalid("crew must be a table of crews".to_string())) };
    if crews.len() > MAX_CREWS {
        return Err(CrewError::new("CREW_TOO_MANY", format!("A config file holds at most {MAX_CREWS} crews.")));
    }
    let mut out = Vec::new();
    for (id, value) in crews {
        if !valid_slug(id) {
            return Err(CrewError::new("CREW_ID", format!("The crew id \"{id}\" may only use lowercase letters, digits and -.")));
        }
        let mut crew: Crew = value.clone().try_into().map_err(|e: toml::de::Error| invalid(format!("crew {id}: {}", e.message())))?;
        if crew.name.trim().is_empty() {
            crew.name = id.clone();
        }
        out.push((id.clone(), crew));
    }
    Ok(out)
}

/// The crew sections as config file text (with `version = 1`), for the config export. Only the tests call it until the
/// canvas (1.1.7) saves crews through the export.
#[cfg_attr(not(test), allow(dead_code))]
pub fn render(crews: &[(String, Crew)]) -> Result<String, CrewError> {
    let mut section = toml::Table::new();
    for (id, crew) in crews {
        let mut value = toml::Value::try_from(crew).map_err(|e| CrewError::new("CREW_FILE_INVALID", format!("This crew cannot be written: {e}")))?;
        if let Some(table) = value.as_table_mut() {
            if let Some(roles) = table.remove("roles") {
                table.insert("role".to_string(), roles);
            }
        }
        section.insert(id.clone(), value);
    }
    let mut root = toml::Table::new();
    root.insert("version".to_string(), toml::Value::Integer(VERSION));
    root.insert("crew".to_string(), toml::Value::Table(section));
    toml::to_string(&root).map_err(|e| CrewError::new("CREW_FILE_INVALID", format!("This crew cannot be written: {e}")))
}
