//! Bring-your-own tunnel or domain: the persisted tunnel setting and the pure logic around it.
//!
//! Why a separate file: the named-tunnel token is a secret. The public settings mirror
//! (`settings_store.rs`) is broadcast over SSE to every paired phone and only whitelists
//! `PATCHABLE_KEYS`, so the tunnel config is owned by Rust, lives in its own file in the app data
//! dir (`potato-workspace.tunnel.json`) and is only ever returned to the UI in a redacted view.
//!
//! Modes:
//! - `quick`  (default): bundled cloudflared quick tunnel; the trycloudflare URL changes per launch.
//! - `named`: `cloudflared tunnel run` with a Cloudflare tunnel token; `hostname` is the stable origin.
//! - `custom`: the user runs their own proxy or domain; Potato Workspace just advertises the URL.
//! - `stable`: the quick tunnel plus the user's own Cloudflare Worker (`relay/stable-link`): the phone is
//!   told the Worker's fixed address, and the app registers every new quick-tunnel URL with the Worker
//!   (see `mobile_tunnel/stable_link.rs`). The shared secret is stored like the named-tunnel token.
//!
//! - `open_tunnel`: a fixed address from OpenTunnel (a third-party relay; Labs, off by default). The file holds
//!   nothing secret: the relay's token lives in the app data folder's own store (`mobile_tunnel/opentunnel.rs`).
//!
//! `POTATO_WORKSPACE_PUBLIC_URL` (env) still wins over everything and skips cloudflared.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const TUNNEL_FILE_NAME: &str = "potato-workspace.tunnel.json";
pub const TUNNEL_TOKEN_ENV: &str = "TUNNEL_TOKEN";

pub fn tunnel_file() -> std::path::PathBuf {
    crate::app_paths::app_data_dir().join(TUNNEL_FILE_NAME)
}

/// The persisted setting. The token never leaves Rust except as the `TUNNEL_TOKEN` env var of the
/// cloudflared child process.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TunnelConfig {
    #[default]
    Quick,
    Named {
        token: String,
        hostname: String,
    },
    Custom {
        url: String,
    },
    Stable {
        worker_url: String,
        secret: String,
    },
    /// A fixed address from OpenTunnel. No secret here: the relay's token is in its own store, never in this file.
    OpenTunnel,
}

// Manual Debug so a stray `{:?}` can never print the token.
impl std::fmt::Debug for TunnelConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Quick => write!(f, "Quick"),
            Self::Named { hostname, .. } => write!(f, "Named {{ hostname: {hostname:?}, token: <redacted> }}"),
            Self::Custom { url } => write!(f, "Custom {{ url: {url:?} }}"),
            Self::Stable { worker_url, .. } => write!(f, "Stable {{ worker_url: {worker_url:?}, secret: <redacted> }}"),
            Self::OpenTunnel => write!(f, "OpenTunnel"),
        }
    }
}

/// What the UI is allowed to see: never the token, only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TunnelConfigView {
    pub mode: &'static str,
    pub hostname: Option<String>,
    pub url: Option<String>,
    pub has_token: bool,
    /// `stable` mode: whether a shared secret is stored (never the secret itself).
    pub has_secret: bool,
}

/// What the UI sends. `token: None` on a `named` save means "keep the stored token".
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TunnelConfigInput {
    Quick,
    Named {
        #[serde(default)]
        token: Option<String>,
        hostname: String,
    },
    Custom {
        url: String,
    },
    Stable {
        worker_url: String,
        /// A secret the person chose (for the Worker's `SETUP_SECRET_SHA256`). Empty or absent: keep or make one.
        #[serde(default)]
        secret: Option<String>,
        #[serde(default)]
        secret_action: SecretAction,
        /// "Make a new secret" only: go ahead even though the Worker could not forget the old one (the person confirmed).
        #[serde(default)]
        confirm_strand: bool,
    },
    /// A fixed address from OpenTunnel. Needs the Labs switch (checked where it is applied).
    OpenTunnel,
    /// "Forget this Worker": switch to the automatic address AND drop the remembered Worker address and secret.
    ForgetWorker,
}

/// What a `stable` save does with the shared secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretAction {
    /// Keep the stored secret (make one the first time).
    #[default]
    Keep,
    /// Throw the stored secret away and make a new one.
    Regenerate,
    /// Keep it, and send it back once so the person can copy it.
    Show,
}

impl TunnelConfig {
    pub fn view(&self) -> TunnelConfigView {
        let base = |mode: &'static str| TunnelConfigView { mode, hostname: None, url: None, has_token: false, has_secret: false };
        match self {
            Self::Quick => base("quick"),
            Self::Named { token, hostname } => TunnelConfigView {
                hostname: Some(hostname.clone()),
                has_token: !token.is_empty(),
                ..base("named")
            },
            Self::Custom { url } => TunnelConfigView { url: Some(url.clone()), ..base("custom") },
            Self::Stable { worker_url, secret } => {
                TunnelConfigView { url: Some(worker_url.clone()), has_secret: !secret.is_empty(), ..base("stable") }
            }
            Self::OpenTunnel => base("open_tunnel"),
        }
    }

    /// The stored shared secret of a `stable` setting.
    pub fn stable_secret(&self) -> Option<&str> {
        match self {
            Self::Stable { secret, .. } if !secret.is_empty() => Some(secret),
            _ => None,
        }
    }
}

/// 32 random bytes as 43 URL-safe characters: the shared secret between the app and the Worker.
pub fn generate_secret() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A secret the person typed: long enough to guess nothing, and safe inside an HTTP header.
fn check_chosen_secret(raw: &str) -> Result<String, String> {
    let secret = raw.trim();
    if secret.len() < 16 {
        return Err("The secret needs at least 16 characters.".into());
    }
    if secret.len() > 200 || !secret.chars().all(|c| c.is_ascii_graphic()) {
        return Err("The secret may only use letters, numbers and symbols (no spaces).".into());
    }
    Ok(secret.to_string())
}

/// Validate UI input into a stored config. `current` supplies the stored token when the UI omits it.
pub fn config_from_input(input: TunnelConfigInput, current: &TunnelConfig) -> Result<TunnelConfig, String> {
    match input {
        TunnelConfigInput::Quick | TunnelConfigInput::ForgetWorker => Ok(TunnelConfig::Quick),
        TunnelConfigInput::Custom { url } => Ok(TunnelConfig::Custom { url: normalize_custom_url(&url)? }),
        TunnelConfigInput::OpenTunnel => Ok(TunnelConfig::OpenTunnel),
        TunnelConfigInput::Stable { worker_url, secret, secret_action, .. } => {
            let worker_url = normalize_custom_url(&worker_url)?;
            let chosen = secret.as_deref().map(str::trim).filter(|s| !s.is_empty());
            // The stored secret belongs to ITS Worker: another address never receives it (it would be sent there as a bearer).
            let stored = match current {
                TunnelConfig::Stable { worker_url: kept, .. } if *kept == worker_url => current.stable_secret(),
                _ => None,
            };
            let secret = match (chosen, secret_action, stored) {
                (Some(own), _, _) => check_chosen_secret(own)?,
                (None, SecretAction::Regenerate, _) | (None, _, None) => generate_secret(),
                (None, _, Some(stored)) => stored.to_string(),
            };
            Ok(TunnelConfig::Stable { worker_url, secret })
        }
        TunnelConfigInput::Named { token, hostname } => {
            let origin = normalize_origin(&hostname, true)?;
            let stored = match current {
                TunnelConfig::Named { token, .. } => token.as_str(),
                _ => "",
            };
            let token = match token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
                Some(t) => t,
                None if !stored.is_empty() => stored.to_string(),
                None => return Err("Paste the tunnel token from Cloudflare.".into()),
            };
            if token.chars().any(char::is_whitespace) {
                return Err("The tunnel token must not contain spaces or line breaks.".into());
            }
            // Store just the host; the origin is derived (always https for a named tunnel).
            let hostname = origin.trim_start_matches("https://").to_string();
            Ok(TunnelConfig::Named { token, hostname })
        }
    }
}

/// Turn what a person typed (`example.com`, `https://example.com/`, `https://x.dev/bridge`) into a
/// clean origin with no path. `force_https`: a named tunnel is always served over https.
pub fn normalize_origin(raw: &str, force_https: bool) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a domain, for example pm.example.com.".into());
    }
    let (scheme, rest) = match trimmed.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("https".to_string(), trimmed),
    };
    if scheme != "https" && scheme != "http" {
        return Err("Use an http:// or https:// address.".into());
    }
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_port.is_empty() || host_port.contains('@') || host_port.chars().any(char::is_whitespace) {
        return Err("That does not look like a domain.".into());
    }
    let host = host_port.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host_port }).unwrap_or(host_port);
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("That does not look like a domain.".into());
    }
    if force_https && !host.contains('.') {
        return Err("Enter the full hostname, for example pm.example.com.".into());
    }
    let scheme = if force_https { "https" } else { scheme.as_str() };
    Ok(format!("{scheme}://{}", host_port.to_ascii_lowercase()))
}

/// A custom address is what phones are told to trust and send their token to, so plain `http://`
/// is only accepted for this machine (localhost / 127.x / ::1). Anything else must be https.
pub fn normalize_custom_url(raw: &str) -> Result<String, String> {
    let origin = normalize_origin(raw, false)?;
    if let Some(rest) = origin.strip_prefix("http://") {
        let host = rest.rsplit_once(':').map_or(rest, |(h, _)| h);
        let loopback = host == "localhost" || host == "127.0.0.1" || host.starts_with("127.") || host == "[::1]";
        if !loopback {
            return Err("Use an https:// address. Plain http would send your phone token in the clear.".into());
        }
    }
    Ok(origin)
}

pub fn load(path: &Path) -> TunnelConfig {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<TunnelConfig>(&text).ok())
        .unwrap_or_default()
}

/// The last Worker address and secret, kept beside the setting while another mode is active, so switching away from
/// "stable" (to automatic, your own address, ...) and back does not lose the secret the Worker already knows.
/// Private file (same as the setting); the secret is never logged. Only "Forget this Worker" or a new secret changes it.
pub fn memory_file(tunnel_file: &Path) -> std::path::PathBuf {
    tunnel_file.with_file_name("potato-workspace.stable-memory.json")
}

/// Remember `config` when it is a stable one (anything else leaves the memory alone).
pub fn remember_stable(memory: &Path, config: &TunnelConfig) {
    if matches!(config, TunnelConfig::Stable { .. }) {
        let _ = save(memory, config);
    }
}

pub fn forget_stable(memory: &Path) {
    let _ = fs::remove_file(memory);
}

/// The settings to build the next one from: while the current mode is not stable, a remembered Worker whose address
/// is the one being saved supplies its secret. Another address never gets the remembered secret.
pub fn basis_with_memory(input: &TunnelConfigInput, current: &TunnelConfig, memory: &Path) -> TunnelConfig {
    let TunnelConfigInput::Stable { worker_url, .. } = input else { return current.clone() };
    let wanted = normalize_custom_url(worker_url);
    // Already on that very Worker: its own secret. On another Worker (or none): look in the memory below.
    if matches!((current, &wanted), (TunnelConfig::Stable { worker_url: kept, .. }, Ok(w)) if kept == w) {
        return current.clone();
    }
    let remembered = load(memory);
    match (&remembered, wanted) {
        (TunnelConfig::Stable { worker_url: kept, .. }, Ok(wanted)) if *kept == wanted => remembered,
        _ => current.clone(),
    }
}

pub fn save(path: &Path, config: &TunnelConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    // Atomic, and private (0600) from creation on Unix; see secure_file.rs.
    crate::secure_file::write_private(path, &text)
}

/// Which tunnel actually runs, after the env override is applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelPlan {
    /// `POTATO_WORKSPACE_PUBLIC_URL` is set: no cloudflared.
    Env { url: String },
    Quick,
    Named { origin: String },
    Custom { url: String },
    /// A quick tunnel registered with the person's own Worker; phones are told `worker_url`.
    Stable { worker_url: String },
    /// A fixed address from OpenTunnel; the address is learned when the client has connected.
    OpenTunnel,
}

impl TunnelPlan {
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Env { .. } => "env",
            Self::Quick => "quick",
            Self::Named { .. } => "named",
            Self::Custom { .. } => "custom",
            Self::Stable { .. } => "stable",
            Self::OpenTunnel => "open_tunnel",
        }
    }

    /// The URL known at plan time (quick learns its URL later from cloudflared's output).
    pub fn known_public_url(&self) -> Option<String> {
        match self {
            Self::Env { url } | Self::Custom { url } => Some(url.clone()),
            Self::Named { origin } => Some(origin.clone()),
            Self::Stable { worker_url } => Some(worker_url.clone()),
            Self::Quick | Self::OpenTunnel => None,
        }
    }

    pub fn runs_cloudflared(&self) -> bool {
        matches!(self, Self::Quick | Self::Named { .. } | Self::Stable { .. })
    }

    /// The app's own OpenTunnel client runs (and the tunnel listener); no cloudflared.
    pub fn runs_opentunnel(&self) -> bool {
        matches!(self, Self::OpenTunnel)
    }
}

/// `open_tunnel_allowed`: the Labs switch. With it off, a saved OpenTunnel setting runs as the automatic address.
pub fn resolve_plan(env_public_url: Option<String>, config: &TunnelConfig, open_tunnel_allowed: bool) -> TunnelPlan {
    if let Some(url) = env_public_url {
        return TunnelPlan::Env { url };
    }
    match config {
        TunnelConfig::OpenTunnel if open_tunnel_allowed => TunnelPlan::OpenTunnel,
        TunnelConfig::OpenTunnel => TunnelPlan::Quick,
        TunnelConfig::Quick => TunnelPlan::Quick,
        TunnelConfig::Named { hostname, .. } => TunnelPlan::Named { origin: format!("https://{hostname}") },
        TunnelConfig::Custom { url } => TunnelPlan::Custom { url: url.clone() },
        TunnelConfig::Stable { worker_url, .. } => TunnelPlan::Stable { worker_url: worker_url.clone() },
    }
}

/// cloudflared arguments. The named token is passed through the `TUNNEL_TOKEN` env var instead of
/// `--token <T>` so it does not show up in the process list.
pub fn cloudflared_args(plan: &TunnelPlan, local_target: &str) -> Vec<String> {
    match plan {
        TunnelPlan::Named { .. } => vec!["tunnel".into(), "--no-autoupdate".into(), "run".into()],
        _ => vec!["tunnel".into(), "--url".into(), local_target.into()],
    }
}

/// Where "Test connection" goes: the public origin's bridge health route, which is public (no
/// bearer needed) so it can be probed before any phone is paired.
pub fn health_url(public_origin: &str) -> String {
    format!("{}/bridge/health", public_origin.trim_end_matches('/'))
}

/// A cloudflared log line, reduced to what the status needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamedLine {
    Connected,
    Failed(String),
    Other,
}

pub fn classify_named_line(line: &str) -> NamedLine {
    if line.contains("Registered tunnel connection") {
        return NamedLine::Connected;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("unauthorized") || lower.contains("invalid tunnel secret") || lower.contains("tunnel token") && lower.contains("err") {
        return NamedLine::Failed("Cloudflare rejected the tunnel token.".into());
    }
    if lower.contains("error parsing tunnel id") || lower.contains("provided tunnel token is not valid") {
        return NamedLine::Failed("The tunnel token is not valid.".into());
    }
    NamedLine::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(token: &str, host: &str) -> TunnelConfig {
        TunnelConfig::Named { token: token.into(), hostname: host.into() }
    }

    #[test]
    fn default_is_quick_and_missing_file_loads_default() {
        assert_eq!(TunnelConfig::default(), TunnelConfig::Quick);
        assert_eq!(load(Path::new("Z:/definitely/not/here.json")), TunnelConfig::Quick);
    }

    #[test]
    fn roundtrip_persists_in_own_file_and_view_never_contains_token() {
        let dir = std::env::temp_dir().join(format!("pm-tunnel-test-{}", std::process::id()));
        let path = dir.join(TUNNEL_FILE_NAME);
        let cfg = named("eyJhIjoiU0VDUkVU", "pm.example.com");
        save(&path, &cfg).unwrap();
        assert_eq!(load(&path), cfg);
        let view = serde_json::to_string(&cfg.view()).unwrap();
        assert!(!view.contains("eyJhIjoiU0VDUkVU"), "view leaked the token: {view}");
        assert!(view.contains("\"has_token\":true"));
        assert!(!format!("{cfg:?}").contains("eyJhIjoiU0VDUkVU"), "Debug leaked the token");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn token_is_not_in_the_public_settings_mirror() {
        // The mirror only copies PATCHABLE_KEYS; a tunnel config pushed at it is dropped.
        let patch = serde_json::json!({"mode": "named", "token": "SECRET", "hostname": "x.example.com"});
        let merged = crate::settings_store::merge_public_settings(&serde_json::json!({}), &patch);
        assert!(!merged.to_string().contains("SECRET"));
    }

    #[test]
    fn normalize_origin_cleans_what_people_type() {
        assert_eq!(normalize_origin("PM.Example.com", true).unwrap(), "https://pm.example.com");
        assert_eq!(normalize_origin("https://pm.example.com/", false).unwrap(), "https://pm.example.com");
        assert_eq!(normalize_origin("https://pm.example.com/bridge/health", false).unwrap(), "https://pm.example.com");
        assert_eq!(normalize_origin("http://192.168.1.5:8080/x", false).unwrap(), "http://192.168.1.5:8080");
        assert_eq!(normalize_origin("http://pm.example.com", true).unwrap(), "https://pm.example.com");
        assert!(normalize_origin("", false).is_err());
        assert!(normalize_origin("ftp://x.com", false).is_err());
        assert!(normalize_origin("https://user@evil.com", false).is_err());
        assert!(normalize_origin("localhost", true).is_err());
        assert!(normalize_origin("bad host.com", false).is_err());
    }

    #[test]
    fn custom_urls_must_be_https_unless_they_are_this_machine() {
        assert_eq!(normalize_custom_url("https://pm.example.com/").unwrap(), "https://pm.example.com");
        assert_eq!(normalize_custom_url("pm.example.com").unwrap(), "https://pm.example.com");
        assert_eq!(normalize_custom_url("http://localhost:3000").unwrap(), "http://localhost:3000");
        assert_eq!(normalize_custom_url("http://127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080");
        for bad in ["http://pm.example.com", "http://192.168.1.5:8080", "http://10.0.0.2"] {
            assert!(normalize_custom_url(bad).is_err(), "{bad}");
        }
        let input = TunnelConfigInput::Custom { url: "http://pm.example.com".into() };
        assert!(config_from_input(input, &TunnelConfig::Quick).is_err());
    }

    #[test]
    fn named_input_keeps_stored_token_when_omitted_and_requires_one_otherwise() {
        let current = named("TOK", "old.example.com");
        let kept = config_from_input(TunnelConfigInput::Named { token: None, hostname: "new.example.com".into() }, &current).unwrap();
        assert_eq!(kept, named("TOK", "new.example.com"));
        let replaced = config_from_input(TunnelConfigInput::Named { token: Some(" NEW ".into()), hostname: "a.example.com".into() }, &current).unwrap();
        assert_eq!(replaced, named("NEW", "a.example.com"));
        assert!(config_from_input(TunnelConfigInput::Named { token: None, hostname: "a.example.com".into() }, &TunnelConfig::Quick).is_err());
        assert!(config_from_input(TunnelConfigInput::Named { token: Some("a b".into()), hostname: "a.example.com".into() }, &TunnelConfig::Quick).is_err());
    }

    #[test]
    fn plan_env_wins_then_config() {
        let cfg = named("T", "pm.example.com");
        assert_eq!(resolve_plan(Some("https://env.dev".into()), &cfg, false), TunnelPlan::Env { url: "https://env.dev".into() });
        assert_eq!(resolve_plan(None, &cfg, false), TunnelPlan::Named { origin: "https://pm.example.com".into() });
        assert_eq!(resolve_plan(None, &TunnelConfig::Quick, false), TunnelPlan::Quick);
        let custom = TunnelConfig::Custom { url: "https://my.dev".into() };
        let plan = resolve_plan(None, &custom, false);
        assert_eq!(plan.known_public_url().as_deref(), Some("https://my.dev"));
        assert!(!plan.runs_cloudflared());
        assert!(TunnelPlan::Quick.runs_cloudflared());
    }

    #[test]
    fn cloudflared_args_never_contain_the_token() {
        let plan = TunnelPlan::Named { origin: "https://pm.example.com".into() };
        let args = cloudflared_args(&plan, "http://127.0.0.1:1420");
        assert_eq!(args, ["tunnel", "--no-autoupdate", "run"]);
        assert_eq!(cloudflared_args(&TunnelPlan::Quick, "http://127.0.0.1:1420"), ["tunnel", "--url", "http://127.0.0.1:1420"]);
    }

    #[test]
    fn health_url_targets_bridge_health() {
        assert_eq!(health_url("https://pm.example.com/"), "https://pm.example.com/bridge/health");
    }

    #[test]
    fn named_line_classification() {
        assert_eq!(classify_named_line("INF Registered tunnel connection connIndex=0"), NamedLine::Connected);
        assert!(matches!(classify_named_line("ERR Unauthorized: invalid tunnel secret"), NamedLine::Failed(_)));
        assert!(matches!(classify_named_line("Provided tunnel token is not valid"), NamedLine::Failed(_)));
        assert_eq!(classify_named_line("INF Starting tunnel"), NamedLine::Other);
    }

    fn stable_input(url: &str, secret: Option<&str>, action: SecretAction) -> TunnelConfigInput {
        TunnelConfigInput::Stable { worker_url: url.into(), secret: secret.map(Into::into), secret_action: action, confirm_strand: false }
    }

    #[test]
    fn stable_round_trips_in_its_own_file_and_the_view_never_contains_the_secret() {
        let dir = std::env::temp_dir().join(format!("pm-tunnel-stable-{}", std::process::id()));
        let path = dir.join(TUNNEL_FILE_NAME);
        let cfg = TunnelConfig::Stable { worker_url: "https://pm.me.workers.dev".into(), secret: "S3CRET-VALUE-0123456789".into() };
        save(&path, &cfg).unwrap();
        assert_eq!(load(&path), cfg);
        let view = serde_json::to_string(&cfg.view()).unwrap();
        assert!(!view.contains("S3CRET-VALUE"), "view leaked the secret: {view}");
        assert!(view.contains("\"has_secret\":true") && view.contains("\"mode\":\"stable\"") && view.contains("https://pm.me.workers.dev"));
        assert!(!format!("{cfg:?}").contains("S3CRET-VALUE"), "Debug leaked the secret");
        // not in the public settings mirror either
        let patch = serde_json::json!({"mode": "stable", "worker_url": "https://x.dev", "secret": "S3CRET-VALUE"});
        let merged = crate::settings_store::merge_public_settings(&serde_json::json!({}), &patch);
        assert!(!merged.to_string().contains("S3CRET-VALUE"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stable_makes_a_32_byte_secret_once_and_keeps_it_until_asked() {
        let first = config_from_input(stable_input("https://pm.me.workers.dev/", None, SecretAction::Keep), &TunnelConfig::Quick).unwrap();
        let TunnelConfig::Stable { worker_url, secret } = &first else { panic!("{first:?}") };
        assert_eq!(worker_url, "https://pm.me.workers.dev");
        assert_eq!(secret.len(), 43, "32 random bytes as URL-safe base64");
        assert!(secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        let kept = config_from_input(stable_input("pm.me.workers.dev", None, SecretAction::Keep), &first).unwrap();
        assert_eq!(kept.stable_secret(), first.stable_secret());
        let shown = config_from_input(stable_input("pm.me.workers.dev", None, SecretAction::Show), &first).unwrap();
        assert_eq!(shown.stable_secret(), first.stable_secret());
        let fresh = config_from_input(stable_input("pm.me.workers.dev", None, SecretAction::Regenerate), &first).unwrap();
        assert_ne!(fresh.stable_secret(), first.stable_secret());
        assert_ne!(generate_secret(), generate_secret());
    }

    /// A new Worker address never receives the secret of the old one (it would go there as a bearer, unchecked).
    #[test]
    fn changing_the_worker_address_makes_a_new_secret_and_the_same_address_keeps_it() {
        let a = TunnelConfig::Stable { worker_url: "https://a.me.workers.dev".into(), secret: "a-secret-0123456789".into() };
        let to_b = config_from_input(stable_input("https://b.me.workers.dev", None, SecretAction::Keep), &a).unwrap();
        assert!(matches!(&to_b, TunnelConfig::Stable { worker_url, .. } if worker_url == "https://b.me.workers.dev"));
        assert!(to_b.stable_secret().is_some());
        assert_ne!(to_b.stable_secret(), a.stable_secret(), "the old secret must not follow the address");
        let show = config_from_input(stable_input("https://b.me.workers.dev", None, SecretAction::Show), &a).unwrap();
        assert_ne!(show.stable_secret(), a.stable_secret());
        // A secret the person typed is theirs to send anywhere.
        let typed = config_from_input(stable_input("https://b.me.workers.dev", Some("typed-secret-0123456789"), SecretAction::Keep), &a).unwrap();
        assert_eq!(typed.stable_secret(), Some("typed-secret-0123456789"));
        // The same address (spelled differently) keeps its secret.
        let same = config_from_input(stable_input("a.me.workers.dev/", None, SecretAction::Keep), &a).unwrap();
        assert_eq!(same.stable_secret(), a.stable_secret());
    }

    #[test]
    fn going_back_to_the_remembered_worker_from_another_stable_one_brings_its_secret_back() {
        let dir = std::env::temp_dir().join(format!("pm-tc-back-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mem = memory_file(&dir.join(TUNNEL_FILE_NAME));
        let a = TunnelConfig::Stable { worker_url: "https://a.me.workers.dev".into(), secret: "a-secret-0123456789".into() };
        let b = TunnelConfig::Stable { worker_url: "https://b.me.workers.dev".into(), secret: "b-secret-0123456789".into() };
        remember_stable(&mem, &a);
        // Currently on B, memory still holds A: asking for A gives A's secret; asking for C gives a new one.
        let to_a = stable_input("https://a.me.workers.dev", None, SecretAction::Keep);
        let basis = basis_with_memory(&to_a, &b, &mem);
        assert_eq!(config_from_input(to_a, &basis).unwrap().stable_secret(), a.stable_secret());
        let to_c = stable_input("https://c.me.workers.dev", None, SecretAction::Keep);
        let basis = basis_with_memory(&to_c, &b, &mem);
        let c = config_from_input(to_c, &basis).unwrap();
        assert!(c.stable_secret() != a.stable_secret() && c.stable_secret() != b.stable_secret());
        // Already on A: A itself.
        let again = stable_input("https://a.me.workers.dev", None, SecretAction::Keep);
        assert_eq!(basis_with_memory(&again, &a, &mem), a);
        let _ = fs::remove_dir_all(dir);
    }

    /// Running the guided setup again saves the same (or a re-printed) Worker address with "keep": the saved secret
    /// the Worker already knows must survive, so a re-run never strands the link.
    #[test]
    fn running_setup_again_keeps_the_secret_the_worker_already_has() {
        let first = config_from_input(stable_input("https://pm.me.workers.dev/", None, SecretAction::Keep), &TunnelConfig::Quick).unwrap();
        for again in ["https://pm.me.workers.dev", "pm.me.workers.dev/", "https://pm.me.workers.dev/"] {
            let next = config_from_input(stable_input(again, None, SecretAction::Keep), &first).unwrap();
            assert_eq!(next.stable_secret(), first.stable_secret(), "{again}");
        }
    }

    #[test]
    fn switching_away_from_stable_and_back_keeps_the_worker_secret_until_forgotten() {
        let dir = std::env::temp_dir().join(format!("pm-tc-mem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("potato-workspace.tunnel.json");
        let mem = memory_file(&file);
        let stable = config_from_input(stable_input("https://pm.me.workers.dev", None, SecretAction::Keep), &TunnelConfig::Quick).unwrap();
        save(&file, &stable).unwrap();
        remember_stable(&mem, &stable);
        // stable -> custom: the setting file no longer has the Worker, the memory does.
        let custom = config_from_input(TunnelConfigInput::Custom { url: "https://pm.example.com".into() }, &stable).unwrap();
        save(&file, &custom).unwrap();
        remember_stable(&mem, &custom);
        assert_eq!(load(&file), custom);
        // custom -> stable (same Worker): the same secret comes back.
        let input = stable_input("pm.me.workers.dev/", None, SecretAction::Keep);
        let basis = basis_with_memory(&input, &custom, &mem);
        let back = config_from_input(input, &basis).unwrap();
        assert_eq!(back.stable_secret(), stable.stable_secret());
        // Another Worker never gets that secret.
        let other = stable_input("https://other.me.workers.dev", None, SecretAction::Keep);
        let other_cfg = config_from_input(other.clone(), &basis_with_memory(&other, &custom, &mem)).unwrap();
        assert_ne!(other_cfg.stable_secret(), stable.stable_secret());
        // Start fresh (a new secret) replaces it; "Forget this Worker" clears it.
        let fresh = stable_input("https://pm.me.workers.dev", None, SecretAction::Regenerate);
        let fresh_cfg = config_from_input(fresh.clone(), &basis_with_memory(&fresh, &custom, &mem)).unwrap();
        assert_ne!(fresh_cfg.stable_secret(), stable.stable_secret());
        remember_stable(&mem, &fresh_cfg);
        assert_eq!(load(&mem), fresh_cfg);
        forget_stable(&mem);
        let again = stable_input("https://pm.me.workers.dev", None, SecretAction::Keep);
        assert_eq!(basis_with_memory(&again, &custom, &mem), custom);
        assert!(matches!(config_from_input(TunnelConfigInput::ForgetWorker, &stable).unwrap(), TunnelConfig::Quick));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stable_accepts_a_chosen_secret_and_refuses_weak_or_unsafe_ones() {
        let cfg = config_from_input(stable_input("https://w.dev", Some("  my-own-secret-123456  "), SecretAction::Keep), &TunnelConfig::Quick).unwrap();
        assert_eq!(cfg.stable_secret(), Some("my-own-secret-123456"));
        for bad in ["short", "has a space in it 1234", "line\nbreak-1234567890"] {
            assert!(config_from_input(stable_input("https://w.dev", Some(bad), SecretAction::Keep), &TunnelConfig::Quick).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn stable_worker_address_must_be_https_unless_it_is_this_machine() {
        assert!(config_from_input(stable_input("http://pm.me.workers.dev", None, SecretAction::Keep), &TunnelConfig::Quick).is_err());
        assert!(config_from_input(stable_input("", None, SecretAction::Keep), &TunnelConfig::Quick).is_err());
        assert!(config_from_input(stable_input("http://127.0.0.1:8787", None, SecretAction::Keep), &TunnelConfig::Quick).is_ok());
    }

    #[test]
    fn open_tunnel_round_trips_with_nothing_secret_in_the_file_or_the_debug_text() {
        let dir = std::env::temp_dir().join(format!("pm-tunnel-open-{}", std::process::id()));
        let path = dir.join(TUNNEL_FILE_NAME);
        save(&path, &TunnelConfig::OpenTunnel).unwrap();
        assert_eq!(load(&path), TunnelConfig::OpenTunnel);
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), serde_json::json!({"mode": "open_tunnel"}));
        assert_eq!(format!("{:?}", TunnelConfig::OpenTunnel), "OpenTunnel");
        let view = serde_json::to_string(&TunnelConfig::OpenTunnel.view()).unwrap();
        assert!(view.contains("\"mode\":\"open_tunnel\"") && view.contains("\"has_token\":false"), "{view}");
        let input: TunnelConfigInput = serde_json::from_str(r#"{"mode":"open_tunnel"}"#).unwrap();
        assert_eq!(config_from_input(input, &TunnelConfig::Quick).unwrap(), TunnelConfig::OpenTunnel);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn open_tunnel_plan_needs_the_labs_switch_and_runs_no_cloudflared() {
        let on = resolve_plan(None, &TunnelConfig::OpenTunnel, true);
        assert_eq!(on, TunnelPlan::OpenTunnel);
        assert_eq!(on.mode(), "open_tunnel");
        assert!(on.runs_opentunnel() && !on.runs_cloudflared());
        assert_eq!(on.known_public_url(), None);
        // switch off: the saved setting runs as the automatic address
        assert_eq!(resolve_plan(None, &TunnelConfig::OpenTunnel, false), TunnelPlan::Quick);
        // the env override still wins
        assert!(matches!(resolve_plan(Some("https://env.dev".into()), &TunnelConfig::OpenTunnel, true), TunnelPlan::Env { .. }));
    }

    #[test]
    fn stable_input_parses_from_what_the_ui_sends() {
        let input: TunnelConfigInput = serde_json::from_str(r#"{"mode":"stable","worker_url":"https://w.dev"}"#).unwrap();
        assert!(matches!(input, TunnelConfigInput::Stable { secret: None, secret_action: SecretAction::Keep, .. }));
        let input: TunnelConfigInput = serde_json::from_str(r#"{"mode":"stable","worker_url":"https://w.dev","secret_action":"regenerate"}"#).unwrap();
        assert!(matches!(input, TunnelConfigInput::Stable { secret_action: SecretAction::Regenerate, .. }));
    }

    #[test]
    fn stable_plan_advertises_the_worker_runs_cloudflared_like_quick_and_env_still_wins() {
        let cfg = TunnelConfig::Stable { worker_url: "https://pm.me.workers.dev".into(), secret: "x".repeat(20) };
        let plan = resolve_plan(None, &cfg, false);
        assert_eq!(plan, TunnelPlan::Stable { worker_url: "https://pm.me.workers.dev".into() });
        assert_eq!(plan.mode(), "stable");
        assert_eq!(plan.known_public_url().as_deref(), Some("https://pm.me.workers.dev"));
        assert!(plan.runs_cloudflared());
        assert_eq!(cloudflared_args(&plan, "http://127.0.0.1:1420"), ["tunnel", "--url", "http://127.0.0.1:1420"]);
        assert!(matches!(resolve_plan(Some("https://env.dev".into()), &cfg, false), TunnelPlan::Env { .. }));
    }
}
