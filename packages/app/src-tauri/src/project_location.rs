//! Where a project (and the chats in it) lives: on this PC, on another Potato PC, or on an SSH machine.
//! Old saved data has no location: it reads as `Local` (serde default). The front end draws a small badge from it
//! (`Device` shows the PC's name, `Ssh` shows `ssh (name)`); the chat flow is the same for all three.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectLocation {
    /// This PC.
    #[default]
    Local,
    /// Another Potato PC: its node id and the name this PC shows for it.
    Device { node: String, name: String },
    /// An SSH machine: its saved host id and the name the person gave it.
    Ssh { host_id: String, name: String },
}

impl ProjectLocation {
    pub fn is_local(&self) -> bool {
        matches!(self, ProjectLocation::Local)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_kind() {
        for loc in [
            ProjectLocation::Local,
            ProjectLocation::Device { node: "ab12".into(), name: "Studio PC".into() },
            ProjectLocation::Ssh { host_id: "h1".into(), name: "Build box".into() },
        ] {
            let text = serde_json::to_string(&loc).unwrap();
            assert_eq!(serde_json::from_str::<ProjectLocation>(&text).unwrap(), loc);
        }
    }

    #[test]
    fn wire_shape_is_tagged() {
        let v = serde_json::to_value(ProjectLocation::Device { node: "n".into(), name: "P".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "device", "node": "n", "name": "P" }));
        let v = serde_json::to_value(ProjectLocation::Ssh { host_id: "h".into(), name: "B".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "ssh", "host_id": "h", "name": "B" }));
    }

    #[test]
    fn default_is_local() {
        assert!(ProjectLocation::default().is_local());
    }
}
