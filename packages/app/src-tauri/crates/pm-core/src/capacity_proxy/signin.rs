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

/// Where a lend sign-in stands, for the sign-in step (words for the person, not for the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigninState {
    /// A token that can really be lent is there.
    SignedIn,
    /// No file, no token in it.
    SignedOut,
    /// A token is there but its own expiry has passed.
    Expired,
}

impl SigninState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SignedIn => "signed_in",
            Self::SignedOut => "signed_out",
            Self::Expired => "expired",
        }
    }
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

    /// Whether a token that can be lent is there at `now_ms`. Reads the file and forgets the token at once.
    pub fn state(&self, now_ms: u64) -> SigninState {
        match self.token(now_ms) {
            Ok(_) => SigninState::SignedIn,
            Err(SigninProblem::Missing) => SigninState::SignedOut,
            Err(SigninProblem::Expired) => SigninState::Expired,
        }
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

/// Who is signed in, read from the spec's identity file inside the lend sign-in folder `home` (for the lender's own
/// screen only; it is never sent). None when the spec has no identity, the file or value is missing, or the value is not
/// plain short text.
pub fn identity(home: &str, spec: &AuthSpec) -> Option<String> {
    let id = spec.identity.as_ref()?;
    if id.file.is_empty() || id.file.contains(['/', '\\']) || id.file.contains("..") {
        return None;
    }
    let json: Value = serde_json::from_str(&std::fs::read_to_string(PathBuf::from(home).join(&id.file)).ok()?).ok()?;
    let who = json.pointer(&id.json_pointer)?.as_str()?.trim();
    (!who.is_empty() && who.chars().count() <= 120 && !who.chars().any(char::is_control)).then(|| who.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capacity_proxy::spec::{AuthSpec, IdentitySpec};

    fn spec() -> AuthSpec {
        AuthSpec {
            header: "authorization".into(),
            file: Some(".credentials.json".into()),
            json_pointer: Some("/oauth/token".into()),
            expires_pointer: Some("/oauth/expires".into()),
            expires_unit: Some("ms".into()),
            identity: Some(IdentitySpec { file: ".claude.json".into(), json_pointer: "/account/email".into() }),
            ..Default::default()
        }
    }

    fn folder(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("pm-signin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn state_is_signed_out_for_no_file_expired_for_a_past_expiry_and_signed_in_otherwise() {
        let home = folder("state");
        let file = SigninFile::new(&home, &spec()).unwrap();
        assert_eq!(file.state(1_000), SigninState::SignedOut);
        std::fs::write(PathBuf::from(&home).join(".credentials.json"), r#"{"oauth":{"token":"t","expires":5000}}"#).unwrap();
        assert_eq!(file.state(1_000), SigninState::SignedIn);
        assert_eq!(file.state(6_000), SigninState::Expired);
        std::fs::write(PathBuf::from(&home).join(".credentials.json"), r#"{"oauth":{"token":""}}"#).unwrap();
        assert_eq!(file.state(1_000), SigninState::SignedOut, "an empty token is not a sign-in");
        assert_eq!(SigninState::SignedIn.as_str(), "signed_in");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn identity_is_read_from_the_pointer_and_is_none_when_missing_or_not_plain_text() {
        let home = folder("identity");
        assert_eq!(identity(&home, &spec()), None, "no file yet");
        let path = PathBuf::from(&home).join(".claude.json");
        std::fs::write(&path, r#"{"account":{"email":" ren@example.com "}}"#).unwrap();
        assert_eq!(identity(&home, &spec()).as_deref(), Some("ren@example.com"));
        std::fs::write(&path, r#"{"account":{}}"#).unwrap();
        assert_eq!(identity(&home, &spec()), None, "pointer missing");
        std::fs::write(&path, r#"{"account":{"email":"a
b"}}"#).unwrap();
        assert_eq!(identity(&home, &spec()), None, "control characters");
        std::fs::write(&path, r#"{"account":{"email":7}}"#).unwrap();
        assert_eq!(identity(&home, &spec()), None, "not text");
        let none = AuthSpec { identity: None, ..spec() };
        assert_eq!(identity(&home, &none), None, "a spec with no identity table");
        let _ = std::fs::remove_dir_all(&home);
    }
}
