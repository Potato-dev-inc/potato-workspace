//! A lend sign-in's token file, read fresh each time. The agent renews the token and rewrites the file, so nothing
//! here keeps a token value: `token()` hands it to the caller for one request and forgets it.

use std::path::PathBuf;

use serde_json::Value;

use crate::capacity_proxy::spec::AuthSpec;

/// Why no token can be sent right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigninProblem {
    /// The file is missing, unreadable, or holds no token.
    Missing,
    /// The token's own expiry has passed.
    Expired,
}

/// Where a lend sign-in's token and its expiry are, as the spec says. Holds no secret.
#[derive(Clone)]
pub struct SigninFile {
    path: PathBuf,
    token_pointer: String,
    expires_pointer: Option<String>,
    expires_in_secs: bool,
}

impl std::fmt::Debug for SigninFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SigninFile({})", self.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
    }
}

impl SigninFile {
    /// `home` is the lend sign-in folder; the file name comes from the spec and may not leave that folder.
    pub fn new(home: &str, spec: &AuthSpec) -> Result<Self, String> {
        let file = spec.file.as_deref().ok_or("This agent can't lend a sign-in through this PC.")?;
        if file.is_empty() || file.contains(['/', '\\']) || file.contains("..") {
            return Err("bad sign-in file name in the spec".into());
        }
        Ok(Self {
            path: PathBuf::from(home).join(file),
            token_pointer: spec.json_pointer.clone().unwrap_or_default(),
            expires_pointer: spec.expires_pointer.clone(),
            expires_in_secs: spec.expires_unit.as_deref() == Some("s"),
        })
    }

    fn json(&self) -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(&self.path).ok()?).ok()
    }

    /// Reads only the expiry (epoch ms). `None`: the file can't be read. `Some(None)`: readable, but no expiry in it.
    pub fn expiry(&self) -> Option<Option<u64>> {
        Some(self.expiry_of(&self.json()?))
    }

    fn expiry_of(&self, json: &Value) -> Option<u64> {
        let value = json.pointer(self.expires_pointer.as_deref()?)?;
        let n = value.as_u64().or_else(|| value.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))?;
        Some(if self.expires_in_secs { n.saturating_mul(1000) } else { n })
    }

    /// The token for ONE request: read now, refused when missing or already expired at `now_ms`.
    pub fn token(&self, now_ms: u64) -> Result<String, SigninProblem> {
        let json = self.json().ok_or(SigninProblem::Missing)?;
        let token = json
            .pointer(&self.token_pointer)
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .ok_or(SigninProblem::Missing)?
            .to_string();
        if self.expiry_of(&json).is_some_and(|at| at <= now_ms) {
            return Err(SigninProblem::Expired);
        }
        Ok(token)
    }
}
