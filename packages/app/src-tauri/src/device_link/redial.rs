//! When a dial to a paired PC keeps failing: how long to wait, when to look the PC up again, and what to say. Pure, so it is tested
//! without a network. The saved address (a LAN address or a relay hint, kept across restarts) can go stale for good (a changed
//! WSL or DHCP address, a new home relay); only a fresh look at the account fixes that, so a run of failures asks for one.

use std::net::SocketAddr;
use std::time::Duration;

/// The longest pause between two tries, however long the PC stays away.
pub const MAX_PAUSE: Duration = Duration::from_secs(30);

/// The pause after `fails` failures in a row (the first is short, then it doubles to `MAX_PAUSE`).
pub fn pause(fails: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << fails.saturating_sub(1).min(10));
    Duration::from_millis(ms).min(MAX_PAUSE)
}

/// Whether this failure should look the PC up again: the second one, then every fourth after it.
pub fn refresh_due(fails: u32) -> bool {
    fails == 2 || (fails > 2 && (fails - 2) % 4 == 0)
}

/// What the dial can use: LAN addresses and a relay hint.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Hints {
    pub direct: Vec<SocketAddr>,
    pub relay: Option<String>,
}

/// The hints after a refresh. When the account names a relay, that relay replaces the saved one and the saved LAN addresses are
/// dropped (they cannot be checked; a connection that works learns them again). When it names none, nothing changes: dropping
/// the only address a LAN-only PC has would make it unreachable for good.
pub fn refreshed(saved: &Hints, account_relay: Option<&str>) -> Hints {
    match account_relay.map(str::trim).filter(|r| !r.is_empty()) {
        Some(relay) => Hints { direct: Vec::new(), relay: Some(relay.to_string()) },
        None => saved.clone(),
    }
}

/// Why a dial failed, as a closed list (the device activity log has a plain sentence for each).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// Nothing answered in time.
    NoAnswer,
    /// Something answered and refused or reset, or there was no way to find it.
    CouldNot,
}

pub fn why(error: Option<&str>) -> Why {
    match error {
        None => Why::NoAnswer,
        Some(e) if e.to_ascii_lowercase().contains("timed out") => Why::NoAnswer,
        Some(_) => Why::CouldNot,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pause_grows_and_stops_at_thirty_seconds() {
        let secs: Vec<u64> = (1..=9).map(|n| pause(n).as_millis() as u64).collect();
        assert_eq!(secs, vec![500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
        assert_eq!(pause(0), Duration::from_millis(500));
        assert_eq!(pause(u32::MAX), MAX_PAUSE);
    }

    #[test]
    fn a_refresh_is_asked_for_again_and_again_never_just_once() {
        let due: Vec<u32> = (1..=14).filter(|n| refresh_due(*n)).collect();
        assert_eq!(due, vec![2, 6, 10, 14]);
    }

    #[test]
    fn a_refresh_takes_the_accounts_relay_and_drops_lan_addresses_only_then() {
        let saved = Hints { direct: vec!["10.0.0.5:1".parse().unwrap()], relay: Some("https://old.example/".into()) };
        assert_eq!(refreshed(&saved, Some(" https://new.example/ ")), Hints { direct: vec![], relay: Some("https://new.example/".into()) });
        assert_eq!(refreshed(&saved, None), saved, "no news from the account: keep what there is");
        assert_eq!(refreshed(&saved, Some("  ")), saved);
        assert_eq!(refreshed(&Hints::default(), None), Hints::default());
    }

    #[test]
    fn a_failure_is_told_as_no_answer_or_could_not_connect() {
        assert_eq!(why(None), Why::NoAnswer);
        assert_eq!(why(Some("net: timed out")), Why::NoAnswer);
        assert_eq!(why(Some("net: connection refused")), Why::CouldNot);
    }
}
