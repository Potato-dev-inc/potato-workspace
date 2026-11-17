//! `potato-workspace://join/<code>?w=<host>` links from the operating system (Team invites).
//!
//! The OS hands the link to the app through `tauri-plugin-deep-link`; a link opened while the app already
//! runs reaches the running copy through the single-instance plugin (its `deep-link` feature). A link is
//! untrusted text from outside: only the `join` path is accepted, the code and host are checked again here
//! (the same rules as `team::invite_web::parse_target`), and every other link is dropped without a trace in
//! the window. What the window gets is the cleaned link in one fixed form.
//!
//! The window may not be open yet (a cold start by link), so the link is also kept until the window asks for
//! it (`take_pending_join_link`). The window turns it into the `pm:join-link` window event that the Join popup
//! already listens for.

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// The Tauri event the window hears when a valid link arrives.
pub const EVENT: &str = "pm-join-link";

const SCHEME_PATH: &str = "potato-workspace://join/";

/// The cleaned link (`potato-workspace://join/<CODE>?w=<host>`) for a link that is exactly an invite, else `None`.
pub fn join_link(url: &str) -> Option<String> {
    let url = url.trim();
    if url.len() > 512 || url.len() < SCHEME_PATH.len() {
        return None;
    }
    // The OS may write the scheme in any case and add a closing slash; nothing else is forgiven.
    let head = url.get(..SCHEME_PATH.len())?;
    if !head.eq_ignore_ascii_case(SCHEME_PATH) {
        return None;
    }
    let rest = &url[SCHEME_PATH.len()..];
    let text = format!("{SCHEME_PATH}{}", rest.trim_end_matches('/'));
    let target = crate::team::invite_web::parse_target(&text).ok()?;
    Some(format!("{SCHEME_PATH}{}?w={}", target.code, target.host))
}

/// The first valid invite among some links (the single-instance plugin passes what the OS gave).
pub fn first_join_link<S: AsRef<str>>(urls: &[S]) -> Option<String> {
    urls.iter().find_map(|u| join_link(u.as_ref()))
}

/// The newest link nobody has taken yet.
#[derive(Default)]
pub struct PendingJoinLink(Mutex<Option<String>>);

impl PendingJoinLink {
    pub fn put(&self, link: String) {
        *self.0.lock() = Some(link);
    }
    pub fn take(&self) -> Option<String> {
        self.0.lock().take()
    }
}

/// Check the links, and for the first valid invite keep it, bring the cockpit forward and tell the window.
/// Returns whether one was accepted.
pub fn deliver<S: AsRef<str>>(app: &AppHandle, urls: &[S]) -> bool {
    // What the OS handed over, as a shape only (never a value), to see why a sign-in link would be refused.
    for u in urls {
        if let Some(shape) = crate::account::link_shape(u.as_ref()) {
            tracing::debug!(%shape, "deep link: sign-in link received");
        }
    }
    // A button of a Windows notification (`desktop_toast`): answered or opened there, never an invite.
    if crate::desktop_toast::handle_links(app, urls) {
        return true;
    }
    // The account sign-in this app started (`potato-workspace://signin?...`): checked against the pending sign-in.
    if crate::account::handle_link(app, urls) {
        return true;
    }
    let Some(link) = first_join_link(urls) else {
        tracing::info!("deep link ignored: not an invite link");
        return false;
    };
    app.state::<PendingJoinLink>().put(link.clone());
    // The popup lives in the cockpit window, so show and focus it even in Individual mode (where it is hidden).
    crate::cockpit::open_cockpit(app, None);
    if let Err(e) = app.emit(EVENT, link) {
        tracing::warn!(error = %e, "deep link: could not tell the window");
    }
    true
}

/// Start listening and pick up the link this copy was started with (call from `setup`).
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
        deliver(&handle, &urls);
    });
    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            let urls: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
            if let Some(link) = first_join_link(&urls) {
                app.state::<PendingJoinLink>().put(link);
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = %e, "deep link: could not read the start link"),
    }
    // Only an installed release copy may claim the scheme: a debug or test copy would steal sign-in callbacks
    // from the person's real app.
    #[cfg(any(windows, target_os = "linux"))]
    {
        let var = |k: &str| std::env::var(k).ok();
        let exe = std::env::current_exe().ok();
        if should_register_scheme(
            cfg!(debug_assertions),
            exe.as_deref(),
            var("POTATO_WORKSPACE_PROFILE").as_deref(),
            var("POTATO_WORKSPACE_NO_URL_HANDLER").as_deref(),
            var("POTATO_WORKSPACE_URL_HANDLER").as_deref(),
        ) {
            if let Err(e) = app.deep_link().register_all() {
                tracing::warn!(error = %e, "deep link: could not register the scheme");
            }
        }
    }
}

fn env_on(v: Option<&str>) -> bool {
    matches!(v.map(str::trim), Some(s) if !s.is_empty() && s != "0" && !s.eq_ignore_ascii_case("false"))
}

/// True when the exe sits inside a cargo `target` folder (a build output, not an install).
fn in_cargo_target(exe: &std::path::Path) -> bool {
    exe.components().any(|c| c.as_os_str().eq_ignore_ascii_case("target"))
}

/// Decide whether this copy writes the `potato-workspace://` handler into the OS.
/// Opt-out wins over everything; a test profile never registers; a debug build registers only when asked.
pub fn should_register_scheme(debug_build: bool, exe: Option<&std::path::Path>, profile: Option<&str>, opt_out: Option<&str>, opt_in: Option<&str>) -> bool {
    if env_on(opt_out) {
        return false;
    }
    if profile.map(str::trim).is_some_and(|p| !p.is_empty()) {
        return false;
    }
    if debug_build {
        return env_on(opt_in);
    }
    !exe.is_some_and(in_cargo_target)
}

/// The window asks for a link that arrived before it was ready (and clears the one it just heard).
#[tauri::command]
pub fn take_pending_join_link(state: tauri::State<'_, PendingJoinLink>) -> Option<String> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "ABCDEFGHJKMNPQRS";

    #[test]
    fn only_an_installed_release_registers_the_scheme() {
        use std::path::Path;
        let installed = Some(Path::new("C:/Program Files/Potato Workspace/puppet_master_app.exe"));
        let built = Some(Path::new("E:/pm-cargo/x/release/target/puppet_master_app.exe"));
        assert!(should_register_scheme(false, installed, None, None, None));
        assert!(!should_register_scheme(false, built, None, None, None));
        assert!(!should_register_scheme(true, installed, None, None, None));
        assert!(!should_register_scheme(false, installed, Some("e2e"), None, None));
        assert!(!should_register_scheme(false, installed, None, Some("1"), None));
        assert!(should_register_scheme(false, installed, None, Some("0"), None));
        assert!(should_register_scheme(true, built, None, None, Some("1")));
        assert!(!should_register_scheme(true, built, Some("e2e"), None, Some("1")));
        assert!(!should_register_scheme(true, built, None, Some("1"), Some("1")));
    }

    #[test]
    fn a_valid_invite_link_is_cleaned_into_one_form() {
        let want = format!("potato-workspace://join/{CODE}?w=team.example.com");
        assert_eq!(join_link(&format!("potato-workspace://join/{CODE}?w=team.example.com")), Some(want.clone()));
        // Scheme case, a closing slash, a lower-case code and a mixed-case host are all normalised.
        assert_eq!(join_link(&format!("POTATO-WORKSPACE://join/{}?w=Team.Example.com/", CODE.to_lowercase())), Some(want));
    }

    #[test]
    fn other_paths_and_schemes_are_ignored() {
        for url in [
            format!("potato-workspace://open/{CODE}?w=team.example.com"),
            format!("potato-workspace://join?w=team.example.com"),
            format!("potato-workspace://settings/join/{CODE}?w=team.example.com"),
            format!("potato-workspace:join/{CODE}?w=team.example.com"),
            format!("https://team.example.com/join/{CODE}"),
            format!("file:///C:/join/{CODE}?w=team.example.com"),
            format!("other-app://join/{CODE}?w=team.example.com"),
        ] {
            assert_eq!(join_link(&url), None, "{url}");
        }
    }

    #[test]
    fn junk_and_overlong_links_are_dropped() {
        assert_eq!(join_link(""), None);
        assert_eq!(join_link("   "), None);
        assert_eq!(join_link("potato-workspace://join/"), None);
        assert_eq!(join_link("potato-workspace://join/\u{0}\u{1}"), None);
        assert_eq!(join_link("\u{feff}potato-workspace://join/x"), None);
        let long = format!("potato-workspace://join/{CODE}?w={}.example.com", "a".repeat(600));
        assert_eq!(join_link(&long), None);
        assert_eq!(join_link(&format!("potato-workspace://join/{}?w=team.example.com", "A".repeat(500))), None);
    }

    #[test]
    fn a_bad_code_is_rejected() {
        for code in ["SHORT", "ABCDEFGHJKMNPQRSX", "0123456789ABCDEF", "ABCDEFGHJKMNPQR!", "ABCDEFGHJKMNPQ%20S"] {
            assert_eq!(join_link(&format!("potato-workspace://join/{code}?w=team.example.com")), None, "{code}");
        }
    }

    #[test]
    fn a_bad_host_is_rejected() {
        for host in [
            "localhost",
            "127.0.0.1",
            "[::1]",
            "10.0.0.5",
            "team.local",
            "team.internal",
            "evil.com:8080",
            "user@evil.com",
            "evil.com/path",
            "nodots",
            "",
            "a b.com",
            "team.example.com%2f..",
        ] {
            assert_eq!(join_link(&format!("potato-workspace://join/{CODE}?w={host}")), None, "{host}");
        }
    }

    #[test]
    fn extra_or_missing_query_parts_are_refused() {
        assert_eq!(join_link(&format!("potato-workspace://join/{CODE}")), None);
        assert_eq!(join_link(&format!("potato-workspace://join/{CODE}?x=1&w=team.example.com")), None);
        assert_eq!(join_link(&format!("potato-workspace://join/{CODE}?w=team.example.com&x=1")), None);
        assert_eq!(join_link(&format!("potato-workspace://join/{CODE}?w=a.example.com&w=b.example.com")), None);
        assert_eq!(join_link(&format!("potato-workspace://join/{CODE}/extra?w=team.example.com")), None);
    }

    #[test]
    fn the_first_valid_link_among_second_launch_arguments_wins() {
        let args = vec![
            "C:\\app.exe".to_string(),
            "potato-workspace://open/x".to_string(),
            format!("potato-workspace://join/{CODE}?w=team.example.com"),
            format!("potato-workspace://join/{CODE}?w=other.example.com"),
        ];
        assert_eq!(first_join_link(&args), Some(format!("potato-workspace://join/{CODE}?w=team.example.com")));
        assert_eq!(first_join_link(&["--background".to_string()]), None);
        assert_eq!(first_join_link::<String>(&[]), None);
    }

    #[test]
    fn a_pending_link_is_taken_once_and_the_newest_wins() {
        let p = PendingJoinLink::default();
        assert_eq!(p.take(), None);
        p.put("a".into());
        p.put("b".into());
        assert_eq!(p.take(), Some("b".into()));
        assert_eq!(p.take(), None);
    }
}
