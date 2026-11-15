//! App-only updates: which package an update takes, the full MSI or the small one that leaves the built-in tools alone.
//! Pure, so every "no" is tested without a network or an app (docs/features/app-only-updates.md).
//!
//! The answer is `Full` unless everything is in order. Any doubt, any parse error: `Full`, which is what every release before
//! this one did.

use serde_json::Value;

/// The Labs switch "Smaller updates". Off until chosen.
pub const SETTING_KEY: &str = "smaller_updates_enabled";
/// The version whose app-only try failed, remembered so that version is never tried twice (it takes the full package).
pub const FAILED_KEY: &str = "app_only_failed_for";
/// The second target in `latest.json`: the app-only MSI. The full MSI stays under `windows-x86_64`.
pub const APP_TARGET: &str = "windows-x86_64-app";
/// The one line shown when the small package fails and the full one is used instead.
#[cfg(test)]
pub const FALLBACK_SENTENCE: &str = "Getting the full update instead.";

/// What `latest.json` says about the small package (the `potato.appOnly` block; the updater itself ignores it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppOnlyInfo {
    pub tools_version: u32,
    pub size: u64,
    pub full_size: u64,
    pub min_from: String,
}

/// Reads `potato.appOnly` from the update's raw JSON. None when it is missing or not whole.
pub fn app_only_info(raw: &Value) -> Option<AppOnlyInfo> {
    let block = raw.get("potato")?.get("appOnly")?;
    Some(AppOnlyInfo {
        tools_version: u32::try_from(block.get("toolsVersion")?.as_u64()?).ok()?,
        size: block.get("size")?.as_u64()?,
        full_size: block.get("fullSize")?.as_u64()?,
        min_from: block.get("minFrom")?.as_str()?.to_string(),
    })
}

/// Whether `latest.json` has a usable `windows-x86_64-app` entry (a link and a signature).
pub fn has_app_target(raw: &Value) -> bool {
    let Some(entry) = raw.get("platforms").and_then(|p| p.get(APP_TARGET)) else { return false };
    let text = |key: &str| entry.get(key).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
    text("url") && text("signature")
}

/// Where the tools this version needs are on this PC right now (the resolver's answer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolsHere {
    /// In the staged folder: nothing to copy.
    Staged,
    /// In the install folder only: they must be copied before the installer removes them.
    InstallOnly,
    /// Not on this PC (or not whole).
    Nowhere,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Full,
    AppOnly { needs_staging: bool },
}

pub struct PlanInput<'a> {
    pub current_version: &'a str,
    pub new_version: &'a str,
    /// The update's raw `latest.json`.
    pub raw: &'a Value,
    /// The tools version the RUNNING app needs (the new app must need the same one for the tools on this PC to fit).
    pub tools_version: u32,
    pub tools_here: ToolsHere,
    /// The "Smaller updates" switch.
    pub switch_on: bool,
    /// `app_only_failed_for` from the settings.
    pub failed_for: Option<&'a str>,
}

fn parse(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim().trim_start_matches('v')).ok()
}

/// The decision. AppOnly only when ALL hold: the switch is on; this version did not already fail; `potato.appOnly` and the
/// `windows-x86_64-app` entry are there; the running version is at least `minFrom`; the tools the new version needs are the
/// ones on this PC; and those tools are here (staged, or in the install folder and copyable).
pub fn plan(input: &PlanInput) -> Plan {
    if !input.switch_on || input.failed_for == Some(input.new_version) {
        return Plan::Full;
    }
    let Some(info) = app_only_info(input.raw) else { return Plan::Full };
    if !has_app_target(input.raw) || info.tools_version != input.tools_version {
        return Plan::Full;
    }
    match (parse(input.current_version), parse(&info.min_from)) {
        (Some(current), Some(min)) if current >= min => {}
        _ => return Plan::Full,
    }
    match input.tools_here {
        ToolsHere::Staged => Plan::AppOnly { needs_staging: false },
        ToolsHere::InstallOnly => Plan::AppOnly { needs_staging: true },
        ToolsHere::Nowhere => Plan::Full,
    }
}

/// What the offer says about the download: its size in bytes and whether the full package brings new built-in tools.
/// For the small package the size is its own; for the full one it is the full size when `latest.json` says it.
pub fn offer_size(plan: Plan, raw: &Value, tools_version: u32) -> (Option<u64>, bool) {
    let Some(info) = app_only_info(raw) else { return (None, false) };
    match plan {
        Plan::AppOnly { .. } => (Some(info.size), false),
        Plan::Full => (Some(info.full_size), info.tools_version != tools_version),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good_raw() -> Value {
        json!({
            "version": "1.2.1",
            "platforms": {
                "windows-x86_64": { "signature": "FULL", "url": "https://example.test/full.msi" },
                "windows-x86_64-app": { "signature": "APP", "url": "https://example.test/app.msi" },
            },
            "potato": { "appOnly": { "toolsVersion": 1, "size": 39_000_000u64, "fullSize": 138_000_000u64, "minFrom": "1.2.0" } },
        })
    }

    fn input<'a>(raw: &'a Value) -> PlanInput<'a> {
        PlanInput { current_version: "1.2.0", new_version: "1.2.1", raw, tools_version: 1, tools_here: ToolsHere::InstallOnly, switch_on: true, failed_for: None }
    }

    #[test]
    fn the_one_good_case_takes_the_small_package() {
        let raw = good_raw();
        assert_eq!(plan(&input(&raw)), Plan::AppOnly { needs_staging: true });
        let mut staged = input(&raw);
        staged.tools_here = ToolsHere::Staged;
        assert_eq!(plan(&staged), Plan::AppOnly { needs_staging: false });
    }

    #[test]
    fn every_no_takes_the_full_package() {
        let raw = good_raw();
        // The switch is off.
        let mut i = input(&raw);
        i.switch_on = false;
        assert_eq!(plan(&i), Plan::Full);
        // This version already failed once.
        let mut i = input(&raw);
        i.failed_for = Some("1.2.1");
        assert_eq!(plan(&i), Plan::Full);
        // A different version that failed does not matter.
        let mut i = input(&raw);
        i.failed_for = Some("1.2.0");
        assert_eq!(plan(&i), Plan::AppOnly { needs_staging: true });
        // Older than minFrom.
        let mut i = input(&raw);
        i.current_version = "1.1.1";
        assert_eq!(plan(&i), Plan::Full);
        // The new version needs other tools than the ones here.
        let mut i = input(&raw);
        i.tools_version = 2;
        assert_eq!(plan(&i), Plan::Full);
        // No tools on this PC.
        let mut i = input(&raw);
        i.tools_here = ToolsHere::Nowhere;
        assert_eq!(plan(&i), Plan::Full);
    }

    #[test]
    fn a_missing_block_or_a_missing_platform_takes_the_full_package() {
        let mut no_block = good_raw();
        no_block.as_object_mut().unwrap().remove("potato");
        assert_eq!(plan(&input(&no_block)), Plan::Full);
        let mut no_platform = good_raw();
        no_platform["platforms"].as_object_mut().unwrap().remove(APP_TARGET);
        assert_eq!(plan(&input(&no_platform)), Plan::Full);
        let mut no_signature = good_raw();
        no_signature["platforms"][APP_TARGET]["signature"] = json!("  ");
        assert_eq!(plan(&input(&no_signature)), Plan::Full);
        let mut half_block = good_raw();
        half_block["potato"]["appOnly"].as_object_mut().unwrap().remove("minFrom");
        assert_eq!(plan(&input(&half_block)), Plan::Full);
    }

    #[test]
    fn garbage_takes_the_full_package() {
        for raw in [json!(null), json!("nope"), json!([]), json!({ "potato": 3 }), json!({ "potato": { "appOnly": "x" } })] {
            assert_eq!(plan(&input(&raw)), Plan::Full, "{raw}");
        }
        let mut bad_min = good_raw();
        bad_min["potato"]["appOnly"]["minFrom"] = json!("soon");
        assert_eq!(plan(&input(&bad_min)), Plan::Full);
        let raw = good_raw();
        let mut bad_current = input(&raw);
        bad_current.current_version = "not-a-version";
        assert_eq!(plan(&bad_current), Plan::Full);
        let mut huge = good_raw();
        huge["potato"]["appOnly"]["toolsVersion"] = json!(99_999_999_999u64);
        assert_eq!(plan(&input(&huge)), Plan::Full);
    }

    #[test]
    fn a_newer_running_version_than_minfrom_may_take_the_small_package() {
        let raw = good_raw();
        let mut i = input(&raw);
        i.current_version = "1.3.7";
        assert_eq!(plan(&i), Plan::AppOnly { needs_staging: true });
        i.current_version = "1.2.0-beta.1";
        assert_eq!(plan(&i), Plan::Full, "a beta of minFrom is older than minFrom");
    }

    #[test]
    fn the_offer_names_the_real_size() {
        let raw = good_raw();
        assert_eq!(offer_size(Plan::AppOnly { needs_staging: false }, &raw, 1), (Some(39_000_000), false));
        assert_eq!(offer_size(Plan::Full, &raw, 1), (Some(138_000_000), false));
        // The new version brings other tools: the full package says so.
        assert_eq!(offer_size(Plan::Full, &raw, 0), (Some(138_000_000), true));
        // An older release without the block says nothing about size.
        assert_eq!(offer_size(Plan::Full, &json!({ "version": "1.1.1" }), 1), (None, false));
    }

    /// What scripts/make-latest-json.mjs writes with the third argument (a real run of the script, saved).
    const WITH_APP_ONLY: &str = include_str!("../../../../../scripts/fixtures/latest-app-only-sample.json");
    /// What every release up to 1.1.1 wrote.
    const OLD_STYLE: &str = include_str!("../../../../../scripts/fixtures/latest-1.1.1.json");

    /// T1, the hard gate: the updater an installed 1.1.1 has (tauri-plugin-updater 2.14.1, the version in Cargo.lock) must
    /// read a `latest.json` with the extra `windows-x86_64-app` target and the extra `potato` block, and still pick the
    /// full installer. It picks `windows-x86_64-msi`, then `windows-x86_64`; the extra target is never looked at.
    #[test]
    fn t1_the_updater_of_1_1_1_reads_the_new_file_and_picks_the_full_installer() {
        use tauri_plugin_updater::RemoteRelease;
        let release: RemoteRelease = serde_json::from_str(WITH_APP_ONLY).expect("the old updater parses the new file");
        assert_eq!(release.version.to_string(), "1.2.1");
        // The lookup order of an MSI install on Windows x64 (updater.rs get_urls): `-msi` first, then the plain target.
        assert!(release.download_url("windows-x86_64-msi").is_err(), "no -msi entry, so the plain one is used");
        let url = release.download_url("windows-x86_64").unwrap().as_str().to_string();
        assert!(url.ends_with("/Potato-Workspace_1.2.1_x64_en-US.msi"), "{url}");
        assert_ne!(release.signature("windows-x86_64").unwrap(), release.signature("windows-x86_64-app").unwrap(), "each package has its own signature");
        // The file an old app parses is the same as before apart from the extras.
        let old: RemoteRelease = serde_json::from_str(OLD_STYLE).unwrap();
        assert_eq!(old.version.to_string(), "1.1.1");
        assert!(old.download_url("windows-x86_64").is_ok());
        // The new app reads the extras from the raw JSON.
        let raw: Value = serde_json::from_str(WITH_APP_ONLY).unwrap();
        assert!(has_app_target(&raw));
        assert_eq!(app_only_info(&raw).unwrap(), AppOnlyInfo { tools_version: 1, size: 1000, full_size: 5000, min_from: "1.2.0".into() });
        assert_eq!(app_only_info(&serde_json::from_str::<Value>(OLD_STYLE).unwrap()), None);
    }

    #[test]
    fn the_real_file_makes_a_small_update_for_1_2_0_and_a_full_one_for_1_1_1() {
        let raw: Value = serde_json::from_str(WITH_APP_ONLY).unwrap();
        let mut i = input(&raw);
        assert_eq!(plan(&i), Plan::AppOnly { needs_staging: true });
        i.current_version = "1.1.1";
        assert_eq!(plan(&i), Plan::Full);
    }

    #[test]
    fn the_fallback_sentence_is_pinned() {
        assert_eq!(FALLBACK_SENTENCE, "Getting the full update instead.");
        assert_eq!(APP_TARGET, "windows-x86_64-app");
        assert_eq!(FAILED_KEY, "app_only_failed_for");
    }
}
