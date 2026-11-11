//! The per-agent proxy spec, read from data (`tui/<agent>/lend_proxy.toml`, served by
//! `TuiProfile::lend_proxy_toml`). Generic code reads the protocol shape, the upstream and the paths from here and
//! never matches an agent name.

use serde::Deserialize;

/// The most a borrower may send in one request body, whatever a spec says.
pub const MAX_BODY_CAP: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Verified,
    Lab,
    No,
}

impl Support {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Lab => "lab",
            Self::No => "no",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NameValue {
    pub name: String,
    pub value: String,
}

/// How the lender's secret goes on a forwarded request: `<header>: <scheme> <secret>` (no scheme: the secret alone).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct AuthSpec {
    pub header: String,
    #[serde(default)]
    pub scheme: String,
    /// Account sign-ins only: the file in the lend sign-in folder that holds the token, and where in its JSON.
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub json_pointer: Option<String>,
    /// Joined onto the request's own value of the header (comma separated).
    #[serde(default)]
    pub add_headers: Vec<NameValue>,
    /// Account sign-ins only: where the token's expiry is in the same JSON file, and its unit (`ms` or `s` since
    /// the epoch). With these the lender can tell an expired token before it calls the provider.
    #[serde(default)]
    pub expires_pointer: Option<String>,
    #[serde(default)]
    pub expires_unit: Option<String>,
    /// Account sign-ins only: how the agent's own CLI is asked to renew its token while a lend is active.
    #[serde(default)]
    pub refresh: Option<RefreshSpec>,
}

/// Renewing a lend sign-in's token with the agent's own CLI (the app never talks to the provider's sign-in itself).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct RefreshSpec {
    /// Arguments for the agent's CLI, run inside the lend sign-in folder's environment.
    #[serde(default)]
    pub args: Vec<String>,
    /// Refresh when the token expires within this many seconds (or already has).
    #[serde(default = "default_before_secs")]
    pub before_secs: u64,
    /// The CLI is stopped after this long (never more than `MAX_REFRESH_TIMEOUT_SECS`).
    #[serde(default = "default_refresh_timeout")]
    pub timeout_secs: u64,
}

pub const MAX_REFRESH_TIMEOUT_SECS: u64 = 300;

fn default_before_secs() -> u64 {
    900
}

fn default_refresh_timeout() -> u64 {
    120
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthSpecs {
    #[serde(default)]
    pub api_key: Option<AuthSpec>,
    #[serde(default)]
    pub account: Option<AuthSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hookup {
    /// `{base_url}` in a value is replaced with the shim's address.
    #[serde(default)]
    pub set: Vec<NameValue>,
    #[serde(default)]
    pub remove_prefixes: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProxySpec {
    pub agent_id: String,
    pub support: Support,
    /// Protocol shape, for usage metering (`anthropic_messages_sse`).
    pub shape: String,
    /// The one host every request goes to: `https://host` with no path.
    pub upstream: String,
    /// `METHOD /path` pairs, matched exactly (the query string is not part of the match).
    pub paths: Vec<String>,
    #[serde(default = "default_max_body")]
    pub max_body_bytes: usize,
    pub auth: AuthSpecs,
    pub hookup: Hookup,
}

fn default_max_body() -> usize {
    MAX_BODY_CAP
}

impl ProxySpec {
    /// Parses and checks a spec. A bad one is refused, never half used.
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut spec: ProxySpec = toml::from_str(text).map_err(|e| format!("lend proxy spec: {e}"))?;
        spec.max_body_bytes = spec.max_body_bytes.min(MAX_BODY_CAP);
        check_upstream(&spec.upstream)?;
        if spec.paths.is_empty() {
            return Err("lend proxy spec: no paths".into());
        }
        for p in &spec.paths {
            let (method, path) = p.split_once(' ').ok_or_else(|| format!("lend proxy spec: bad path {p:?}"))?;
            if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) || !path.starts_with('/') || path.contains("..") {
                return Err(format!("lend proxy spec: bad path {p:?}"));
            }
        }
        if spec.auth.api_key.is_none() && spec.auth.account.is_none() {
            return Err("lend proxy spec: no auth".into());
        }
        if let Some(account) = spec.auth.account.as_mut() {
            check_expiry(account)?;
        }
        Ok(spec)
    }

    /// Whether `method` + `path` (without the query) is one of the allowed pairs.
    pub fn allows(&self, method: &str, path: &str) -> bool {
        self.paths.iter().any(|p| p.split_once(' ').is_some_and(|(m, q)| m == method && q == path))
    }
}

/// The expiry fields go together, the unit is `ms` or `s`, and a refresh needs an expiry and something to run.
fn check_expiry(auth: &mut AuthSpec) -> Result<(), String> {
    if let Some(unit) = auth.expires_unit.as_deref() {
        if unit != "ms" && unit != "s" {
            return Err(format!("lend proxy spec: expires_unit must be \"ms\" or \"s\", not {unit:?}"));
        }
    }
    if auth.expires_pointer.is_some() != auth.expires_unit.is_some() {
        return Err("lend proxy spec: expires_pointer and expires_unit go together".into());
    }
    if let Some(refresh) = auth.refresh.as_mut() {
        if auth.expires_pointer.is_none() {
            return Err("lend proxy spec: a refresh needs expires_pointer".into());
        }
        if refresh.args.is_empty() {
            return Err("lend proxy spec: a refresh needs args".into());
        }
        refresh.timeout_secs = refresh.timeout_secs.clamp(1, MAX_REFRESH_TIMEOUT_SECS);
    }
    Ok(())
}

/// A production upstream is `https://<host>` with no path, query, user or port tricks.
pub fn check_upstream(url: &str) -> Result<(), String> {
    let rest = url.strip_prefix("https://").ok_or("lend proxy spec: the upstream must be https")?;
    let ok = !rest.is_empty()
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !rest.starts_with('.')
        && !rest.ends_with('.');
    if ok {
        Ok(())
    } else {
        Err("lend proxy spec: the upstream must be a bare https host".into())
    }
}

/// Every spec the registered agent profiles declare (bad ones are left out and logged).
pub fn all() -> Vec<ProxySpec> {
    crate::tui::registry::snapshot()
        .iter()
        .filter_map(|profile| {
            let text = profile.lend_proxy_toml()?;
            match ProxySpec::parse(text) {
                Ok(spec) if spec.agent_id == profile.id() => Some(spec),
                Ok(_) => {
                    tracing::warn!(agent = profile.id(), "lend proxy spec names another agent; ignored");
                    None
                }
                Err(error) => {
                    tracing::warn!(agent = profile.id(), %error, "lend proxy spec refused");
                    None
                }
            }
        })
        .collect()
}

#[cfg(test)]
pub fn for_agent(agent_id: &str) -> Option<ProxySpec> {
    all().into_iter().find(|s| s.agent_id.eq_ignore_ascii_case(agent_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = include_str!("../tui/claude/lend_proxy.toml");

    #[test]
    fn the_claude_spec_parses_and_allows_only_its_pairs() {
        let spec = ProxySpec::parse(CLAUDE).unwrap();
        assert_eq!(spec.shape, "anthropic_messages_sse");
        assert_eq!(spec.upstream, "https://api.anthropic.com");
        assert!(spec.allows("POST", "/v1/messages"));
        assert!(spec.allows("POST", "/v1/messages/count_tokens"));
        assert!(!spec.allows("GET", "/v1/messages"));
        assert!(!spec.allows("POST", "/v1/models"));
        assert!(!spec.allows("POST", "/v1/messages/"));
        assert_eq!(spec.max_body_bytes, MAX_BODY_CAP);
    }

    #[test]
    fn the_claude_spec_has_an_expiry_and_a_refresh() {
        let account = ProxySpec::parse(CLAUDE).unwrap().auth.account.unwrap();
        assert_eq!(account.expires_pointer.as_deref(), Some("/claudeAiOauth/expiresAt"));
        assert_eq!(account.expires_unit.as_deref(), Some("ms"));
        let refresh = account.refresh.unwrap();
        assert_eq!(refresh.before_secs, 240);
        assert_eq!(refresh.timeout_secs, 120);
        assert!(!refresh.args.is_empty());
    }

    #[test]
    fn a_bad_expiry_unit_or_refresh_is_refused_and_the_timeout_is_capped() {
        let bad_unit = CLAUDE.replace("expires_unit = \"ms\"", "expires_unit = \"minutes\"");
        assert!(ProxySpec::parse(&bad_unit).unwrap_err().contains("expires_unit"));
        let no_pointer = CLAUDE.replace("expires_pointer = \"/claudeAiOauth/expiresAt\"", "");
        assert!(ProxySpec::parse(&no_pointer).is_err());
        let no_args = CLAUDE.replace("args = [", "unused = [");
        assert!(ProxySpec::parse(&no_args).is_err());
        let long = CLAUDE.replace("before_secs = 240", "before_secs = 240
timeout_secs = 99999");
        let refresh = ProxySpec::parse(&long).unwrap().auth.account.unwrap().refresh.unwrap();
        assert_eq!(refresh.timeout_secs, MAX_REFRESH_TIMEOUT_SECS);
    }

    #[test]
    fn a_registered_profile_serves_the_spec() {
        assert!(for_agent("claude").is_some());
    }

    #[test]
    fn upstream_must_be_a_bare_https_host() {
        assert!(check_upstream("https://api.anthropic.com").is_ok());
        for bad in ["http://api.anthropic.com", "https://api.anthropic.com/v1", "https://user@x.com", "https://x.com:444", "https://", "ftp://x"] {
            assert!(check_upstream(bad).is_err(), "{bad}");
        }
    }
}
