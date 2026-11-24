//! The secrets only the app can list, for `pm_core::redact::known`: the adapter key slots, the toolbelt credentials and the
//! OpenCode key profiles. `pm-core` cannot name them, so the app registers this function before anything is masked.

pub fn install() {
    pm_core::redact::known::set_app_sources(app_secret_values);
}

fn app_secret_values() -> Vec<String> {
    #[allow(unused_mut)] // tests add nothing below
    let mut values = crate::acp::adapter_keys::all_secret_values();
    // Tests must not read the real user's toolbelt or key profiles.
    #[cfg(not(test))]
    {
        values.extend(crate::toolbelt::store::secret_values());
        values.extend(crate::opencode::keys::secret_values());
    }
    values
}
