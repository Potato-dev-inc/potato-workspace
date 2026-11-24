//! "Make helper of...": the person drags one top-level agent onto another in the sidebar, and it becomes that
//! agent's helper (or, the other way, a main agent again). It changes the helper-of link the sidebar and the helpers
//! bar draw (`PaneInfo::parent_pane_id`). Unlike `pane_parent::set_parent` (set once, by an agent that started a
//! helper), this is the person's own choice, so it may replace the link.
//!
//! The rules are one pure function (`check`) so they are easy to test: no pane is its own helper, no loops, only a
//! main agent can be adopted and only a main agent can adopt (helpers of the dragged agent stay under it and move
//! along). Which project a pane is in is the sidebar's grouping, so it checks that; this checks the shape.

use super::registry::PaneRegistry;
use parking_lot::Mutex;
use std::sync::Arc;

/// Why the link was refused. The text is shown to the person as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub &'static str);

pub const SAME: &str = "An agent cannot be its own helper.";
pub const GONE: &str = "That agent is not open any more.";
pub const LOOP: &str = "That would make a loop: the agent is already a helper of the other one.";
pub const NOT_MAIN: &str = "Only a main agent can be given helpers.";
pub const ALREADY: &str = "That agent is already a helper. Make it a main agent first.";

/// `parent_of(id)`: `None` when the pane is unknown, else its parent (`Some(None)` for a main agent).
pub fn check(child: &str, new_parent: Option<&str>, parent_of: impl Fn(&str) -> Option<Option<String>>) -> Result<(), Refused> {
    let Some(current) = parent_of(child) else { return Err(Refused(GONE)) };
    let Some(parent) = new_parent else { return Ok(()) };
    if parent == child {
        return Err(Refused(SAME));
    }
    let Some(parent_parent) = parent_of(parent) else { return Err(Refused(GONE)) };
    // Walk up from the new parent: meeting the child means the new parent is one of the child's own helpers.
    let mut at = Some(parent.to_string());
    for _ in 0..16 {
        match at {
            Some(id) if id == child => return Err(Refused(LOOP)),
            Some(id) => at = parent_of(&id).flatten(),
            None => break,
        }
    }
    if parent_parent.is_some() {
        return Err(Refused(NOT_MAIN));
    }
    if current.is_some() && current.as_deref() != Some(parent) {
        return Err(Refused(ALREADY));
    }
    Ok(())
}

/// Sets (or, with `None`, clears) the helper-of link of `child`. True when the link changed.
pub fn reparent(registry: &Arc<Mutex<PaneRegistry>>, child: &str, new_parent: Option<&str>) -> Result<bool, Refused> {
    let mut reg = registry.lock();
    check(child, new_parent, |id| reg.panes.get(id).map(|p| p.info.parent_pane_id.clone()))?;
    let pane = reg.panes.get_mut(child).ok_or(Refused(GONE))?;
    let changed = pane.info.parent_pane_id.as_deref() != new_parent;
    pane.info.parent_pane_id = new_parent.map(str::to_string);
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(panes: &[(&str, Option<&str>)]) -> Arc<Mutex<PaneRegistry>> {
        let registry = Arc::new(Mutex::new(PaneRegistry::new()));
        for (id, parent) in panes {
            let mut pane = PaneRegistry::test_pane_stub(id);
            pane.info.parent_pane_id = parent.map(str::to_string);
            registry.lock().panes.insert(id.to_string(), pane);
        }
        registry
    }
    fn parent(registry: &Arc<Mutex<PaneRegistry>>, id: &str) -> Option<String> {
        registry.lock().panes.get(id).and_then(|p| p.info.parent_pane_id.clone())
    }

    #[test]
    fn a_main_agent_becomes_the_helper_of_another() {
        let r = registry(&[("a", None), ("b", None)]);
        assert_eq!(reparent(&r, "b", Some("a")), Ok(true));
        assert_eq!(parent(&r, "b").as_deref(), Some("a"));
        // The same again changes nothing.
        assert_eq!(reparent(&r, "b", Some("a")), Ok(false));
    }

    #[test]
    fn its_own_helpers_stay_under_it() {
        let r = registry(&[("a", None), ("b", None), ("b-help", Some("b"))]);
        reparent(&r, "b", Some("a")).unwrap();
        assert_eq!(parent(&r, "b-help").as_deref(), Some("b"));
    }

    #[test]
    fn a_main_agent_again_clears_the_link() {
        let r = registry(&[("a", None), ("b", Some("a"))]);
        assert_eq!(reparent(&r, "b", None), Ok(true));
        assert_eq!(parent(&r, "b"), None);
    }

    #[test]
    fn it_refuses_itself_a_loop_a_helper_and_a_missing_pane() {
        let r = registry(&[("a", None), ("b", Some("a")), ("c", None), ("d", Some("c"))]);
        assert_eq!(reparent(&r, "a", Some("a")), Err(Refused(SAME)));
        // "a" onto its own helper "b": a loop.
        assert_eq!(reparent(&r, "a", Some("b")), Err(Refused(LOOP)));
        // onto a pane that is a helper of someone else
        assert_eq!(reparent(&r, "c", Some("b")), Err(Refused(NOT_MAIN)));
        // a helper cannot be moved under another main agent in one step
        assert_eq!(reparent(&r, "d", Some("a")), Err(Refused(ALREADY)));
        assert_eq!(reparent(&r, "a", Some("nope")), Err(Refused(GONE)));
        assert_eq!(reparent(&r, "nope", Some("a")), Err(Refused(GONE)));
        // nothing changed on the way
        assert_eq!(parent(&r, "a"), None);
        assert_eq!(parent(&r, "d").as_deref(), Some("c"));
    }

    #[test]
    fn a_broken_table_with_a_cycle_does_not_hang() {
        let r = registry(&[("x", Some("y")), ("y", Some("x")), ("z", None)]);
        assert!(reparent(&r, "z", Some("x")).is_err());
    }
}
