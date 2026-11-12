//! Which update address the app reads: the stable one (the newest GitHub release, which skips pre-releases) or, when the
//! person turned on "Get early versions (beta)", the stable one AND a fixed `beta` release, then the newer of the two.
//! Pure, so the choice is tested without a network or an app.

use std::cmp::Ordering;

/// Where stable updates come from. Same address as `plugins.updater.endpoints` in tauri.conf.json.
pub const STABLE_ENDPOINT: &str = "https://github.com/Potato-dev-inc/potato-workspace/releases/latest/download/latest.json";
/// A release with the fixed tag `beta`, whose `latest.json` the release script keeps pointing at the newest beta.
pub const BETA_ENDPOINT: &str = "https://github.com/Potato-dev-inc/potato-workspace/releases/download/beta/latest.json";

/// The saved setting (Settings > General > About > Get early versions). Off when absent.
pub const SETTING_KEY: &str = "early_versions_enabled";

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Channel {
    Stable,
    Beta,
}

pub fn endpoint(channel: Channel) -> &'static str {
    match channel {
        Channel::Stable => STABLE_ENDPOINT,
        Channel::Beta => BETA_ENDPOINT,
    }
}

/// The channels to read, stable first. Off: stable only, as before.
pub fn channels_to_check(early_versions: bool) -> Vec<Channel> {
    if early_versions {
        vec![Channel::Stable, Channel::Beta]
    } else {
        vec![Channel::Stable]
    }
}

/// Whether the public settings have early versions on.
pub fn early_versions_on(settings: &serde_json::Value) -> bool {
    settings.get(SETTING_KEY).and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// Order two version strings the way semver does (`1.0.19-beta.1` is older than `1.0.19`). A string that does not parse
/// is older than one that does; two that do not parse are equal.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| semver::Version::parse(v.trim().trim_start_matches('v')).ok();
    match (parse(a), parse(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

/// Given what each address offered (`(version, thing)`, only when newer than the running app), the one to use: the higher
/// version; on a tie, stable.
pub fn pick_newer<T>(stable: Option<(String, T)>, beta: Option<(String, T)>) -> Option<(Channel, T)> {
    match (stable, beta) {
        (Some((sv, s)), Some((bv, b))) => {
            if compare_versions(&bv, &sv) == Ordering::Greater {
                Some((Channel::Beta, b))
            } else {
                Some((Channel::Stable, s))
            }
        }
        (Some((_, s)), None) => Some((Channel::Stable, s)),
        (None, Some((_, b))) => Some((Channel::Beta, b)),
        (None, None) => None,
    }
}

/// Combine the two reads. A beta address that fails (no beta release yet, offline) never hides a stable answer, and a
/// failed stable read does not hide a beta one; only when both fail is the stable error returned.
pub fn combine<T, E>(stable: Result<Option<(String, T)>, E>, beta: Option<Result<Option<(String, T)>, E>>) -> Result<Option<T>, E> {
    let Some(beta) = beta else { return stable.map(|s| s.map(|(_, t)| t)) };
    match (stable, beta) {
        (Ok(s), Ok(b)) => Ok(pick_newer(s, b).map(|(_, t)| t)),
        (Ok(s), Err(_)) => Ok(s.map(|(_, t)| t)),
        (Err(_), Ok(b)) => Ok(b.map(|(_, t)| t)),
        (Err(e), Err(_)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_reads_only_the_stable_address() {
        assert_eq!(channels_to_check(false), vec![Channel::Stable]);
        assert_eq!(channels_to_check(true), vec![Channel::Stable, Channel::Beta]);
    }

    #[test]
    fn the_two_addresses_are_the_fixed_github_ones() {
        assert!(endpoint(Channel::Stable).ends_with("/releases/latest/download/latest.json"));
        assert!(endpoint(Channel::Beta).ends_with("/releases/download/beta/latest.json"));
        assert_ne!(endpoint(Channel::Stable), endpoint(Channel::Beta));
        for c in [Channel::Stable, Channel::Beta] {
            assert!(endpoint(c).starts_with("https://github.com/Potato-dev-inc/"));
        }
    }

    #[test]
    fn the_setting_is_off_unless_saved_on() {
        assert!(!early_versions_on(&serde_json::json!({})));
        assert!(!early_versions_on(&serde_json::json!({"early_versions_enabled": false})));
        assert!(!early_versions_on(&serde_json::json!({"early_versions_enabled": "yes"})));
        assert!(early_versions_on(&serde_json::json!({"early_versions_enabled": true})));
    }

    #[test]
    fn versions_order_like_semver_and_a_pre_release_is_older_than_its_release() {
        assert_eq!(compare_versions("1.0.19", "1.0.18"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.19-beta.1", "1.0.19"), Ordering::Less);
        assert_eq!(compare_versions("1.0.19-beta.2", "1.0.19-beta.1"), Ordering::Greater);
        assert_eq!(compare_versions("v1.0.10", "1.0.9"), Ordering::Greater);
        assert_eq!(compare_versions("nonsense", "1.0.0"), Ordering::Less);
    }

    #[test]
    fn the_newer_of_stable_and_beta_wins_and_a_tie_goes_to_stable() {
        let s = |v: &str| Some((v.to_string(), v.to_string()));
        assert_eq!(pick_newer(s("1.0.18"), s("1.0.19-beta.1")), Some((Channel::Beta, "1.0.19-beta.1".to_string())));
        assert_eq!(pick_newer(s("1.0.19"), s("1.0.19-beta.3")), Some((Channel::Stable, "1.0.19".to_string())));
        assert_eq!(pick_newer(s("1.0.19"), s("1.0.19")), Some((Channel::Stable, "1.0.19".to_string())));
        assert_eq!(pick_newer(None, s("1.0.19-beta.1")), Some((Channel::Beta, "1.0.19-beta.1".to_string())));
        assert_eq!(pick_newer(s("1.0.19"), None), Some((Channel::Stable, "1.0.19".to_string())));
        assert_eq!(pick_newer::<String>(None, None), None);
    }

    #[test]
    fn with_early_versions_off_the_beta_answer_is_never_looked_at() {
        let stable: Result<Option<(String, &str)>, &str> = Ok(Some(("1.0.19".into(), "stable")));
        assert_eq!(combine(stable, None), Ok(Some("stable")));
    }

    #[test]
    fn a_missing_beta_release_does_not_hide_the_stable_update() {
        let stable: Result<Option<(String, &str)>, &str> = Ok(Some(("1.0.19".into(), "stable")));
        let beta: Result<Option<(String, &str)>, &str> = Err("404");
        assert_eq!(combine(stable, Some(beta)), Ok(Some("stable")));
    }

    #[test]
    fn a_failed_stable_read_still_gives_the_beta_and_two_failures_give_the_stable_error() {
        let beta_ok: Result<Option<(String, &str)>, &str> = Ok(Some(("1.0.20-beta.1".into(), "beta")));
        assert_eq!(combine(Err("offline"), Some(beta_ok)), Ok(Some("beta")));
        let none: Result<Option<(String, &str)>, &str> = Err("beta 404");
        assert_eq!(combine(Err("stable offline"), Some(none)), Err("stable offline"));
    }

    #[test]
    fn when_both_have_nothing_newer_there_is_no_update() {
        let a: Result<Option<(String, &str)>, &str> = Ok(None);
        let b: Result<Option<(String, &str)>, &str> = Ok(None);
        assert_eq!(combine(a, Some(b)), Ok(None));
    }
}
