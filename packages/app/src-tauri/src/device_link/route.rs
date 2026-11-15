//! "How far-away devices connect" (founder decision 2026-11-15: both routes, picked per PC). Per device it can be
//! overridden later; today the choice is for this PC.
//!
//! - **Automatic** (default): direct first; then the public relay (encrypted end to end: it sees which devices talk, not
//!   what); then the person's own route (a stable-link Worker or tunnel) when one is set up.
//! - **Public relay only**: the same, without the own route.
//! - **My own route only**: no outside relay is ever used. The endpoint binds without one and dials are given no relay.
//!
//! In this build the own route is not built yet (the link is direct or through the public relay): `Own` therefore means
//! "direct only", and says so (`own_ready` is false). The chip a device shows is what its link really is.

/// The three choices, as the page words them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RoutePref {
    #[default]
    Auto,
    Public,
    Own,
}

impl RoutePref {
    pub fn as_str(self) -> &'static str {
        match self {
            RoutePref::Auto => "auto",
            RoutePref::Public => "public",
            RoutePref::Own => "own",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "auto" => Some(RoutePref::Auto),
            "public" => Some(RoutePref::Public),
            "own" => Some(RoutePref::Own),
            _ => None,
        }
    }

    /// Whether an outside (public) relay may carry this PC's links.
    pub fn relay_allowed(self) -> bool {
        !matches!(self, RoutePref::Own)
    }
}

/// Where the choice is kept (a small file in the app data folder; memory in tests).
pub trait PrefsStore: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, text: &str) -> Result<(), String>;
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryPrefs(std::sync::Mutex<Option<String>>);

#[cfg(test)]
impl MemoryPrefs {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }
}

#[cfg(test)]
impl PrefsStore for MemoryPrefs {
    fn load(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    fn save(&self, text: &str) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(text.to_string());
        Ok(())
    }
}

pub fn load(store: &dyn PrefsStore) -> RoutePref {
    store.load().and_then(|t| RoutePref::parse(&t)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_my_own_route_forbids_the_public_relay() {
        assert!(RoutePref::Auto.relay_allowed());
        assert!(RoutePref::Public.relay_allowed());
        assert!(!RoutePref::Own.relay_allowed());
    }

    #[test]
    fn the_words_round_trip_and_anything_else_is_the_default() {
        for pref in [RoutePref::Auto, RoutePref::Public, RoutePref::Own] {
            assert_eq!(RoutePref::parse(pref.as_str()), Some(pref));
        }
        assert_eq!(RoutePref::parse("relay"), None);
        let store = MemoryPrefs::new();
        assert_eq!(load(store.as_ref()), RoutePref::Auto);
        store.save("own").unwrap();
        assert_eq!(load(store.as_ref()), RoutePref::Own);
        store.save("garbage").unwrap();
        assert_eq!(load(store.as_ref()), RoutePref::Auto);
    }
}
