//! HTTP shape of the Today routes, independent of the bridge types so it can be tested against a
//! fake runtime:
//!
//! - `GET  /timeline/{date}`
//! - `GET  /timeline/point/diff?project&key&id`
//! - `GET  /timeline/point/now-diff?project&key&id`
//! - `GET  /timeline/point/patch?project&key&id&path[&side=now]`
//! - `POST /timeline/point/restore` with `{project, key, id}`
//!
//! Auth is the bridge's own (a paired phone needs `watch` for the reads and `control` for the
//! restore: `mobile_pairing::caps::route_need` fails closed that way).

use serde_json::{json, Value};

use super::TimelineError;
use crate::checkpoints::http::fail;
use crate::checkpoints::Runtime;

fn refuse(error: TimelineError) -> (u16, Value) {
    match error {
        TimelineError::NotOnLine => (403, json!({"code": "FOLDER_NOT_ON_LINE", "error": error.to_string()})),
        TimelineError::BadDate => (400, json!({"code": "INVALID_ARGUMENT", "error": error.to_string()})),
        TimelineError::Checkpoint(e) => fail(e),
    }
}

fn missing(name: &str) -> (u16, Value) {
    (400, json!({"code": "INVALID_ARGUMENT", "error": format!("{name} is required")}))
}

/// `None` when the request is not a Today route. `param` reads one named value (the query for a GET,
/// the JSON body for a POST).
pub fn respond(rt: &Runtime, method: &str, segments: &[&str], param: &dyn Fn(&str) -> Option<String>) -> Option<Result<(u16, Value), (u16, Value)>> {
    let need = |name: &str| param(name).filter(|v| !v.is_empty()).ok_or_else(|| missing(name));
    let point = || -> Result<(String, String, String), (u16, Value)> { Ok((need("project")?, need("key")?, need("id")?)) };
    match (method, segments) {
        ("GET", ["timeline", "point", "diff"]) => Some((|| {
            let (project, key, id) = point()?;
            super::point_diff(rt, &project, &key, &id).map(|files| (200, json!({"changes": files}))).map_err(refuse)
        })()),
        ("GET", ["timeline", "point", "now-diff"]) => Some((|| {
            let (project, key, id) = point()?;
            super::now_diff(rt, &project, &key, &id).map(|d| (200, serde_json::to_value(d).unwrap_or_default())).map_err(refuse)
        })()),
        ("GET", ["timeline", "point", "patch"]) => Some((|| {
            let (project, key, id) = point()?;
            let path = need("path")?;
            let side = param("side").unwrap_or_default();
            super::file_patch(rt, &project, &key, &id, &path, &side)
                .map(|(patch, truncated)| (200, json!({"patch": patch, "truncated": truncated})))
                .map_err(refuse)
        })()),
        ("POST", ["timeline", "point", "restore"]) => Some((|| {
            let (project, key, id) = point()?;
            super::go_back(rt, &project, &key, &id).map(|r| (200, serde_json::to_value(r).unwrap_or_default())).map_err(refuse)
        })()),
        // A literal word after `point` is never a date.
        ("GET", ["timeline", date]) if *date != "point" => Some(super::day_view(rt, date).map(|v| (200, serde_json::to_value(v).unwrap_or_default())).map_err(refuse)),
        _ => None,
    }
}
