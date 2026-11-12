//! A Discord webhook link, checked strictly. The link IS the secret: anyone who has it can post to the channel.
//!
//! Only `https://discord.com/api/webhooks/<id>/<token>` is accepted (also `discordapp.com`, and the `canary.` and
//! `ptb.` hosts). No other scheme, host, port, user info, query or fragment. The checked link is stored only in the
//! OS credential store (`secrets.rs`), never in a settings file, and it never appears in a log or an error text.

use std::fmt;

const HOSTS: [&str; 6] = [
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com",
    "canary.discordapp.com",
    "ptb.discordapp.com",
];

/// Why a link was refused. The words say what to paste, and never repeat what was pasted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    Empty,
    NotHttps,
    WrongHost,
    WrongPath,
}

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Empty => "Paste the webhook link first.",
            Self::NotHttps => "That link must start with https://.",
            Self::WrongHost => "That is not a Discord link. It should start with https://discord.com/api/webhooks/.",
            Self::WrongPath => "That is not a Discord webhook link. It should end with /api/webhooks/ and two long codes.",
        })
    }
}

/// A checked webhook link. `Debug` hides it.
#[derive(Clone, PartialEq, Eq)]
pub struct Webhook {
    url: String,
    token: String,
}

impl fmt::Debug for Webhook {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Webhook(hidden)")
    }
}

impl Webhook {
    pub fn parse(raw: &str) -> Result<Self, UrlError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(UrlError::Empty);
        }
        let rest = raw.strip_prefix("https://").ok_or(UrlError::NotHttps)?;
        if rest.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '@' | '?' | '#' | ':' | '%')) {
            return Err(UrlError::WrongPath);
        }
        let (host, path) = rest.split_once('/').ok_or(UrlError::WrongPath)?;
        let host = host.to_ascii_lowercase();
        if !HOSTS.contains(&host.as_str()) {
            return Err(UrlError::WrongHost);
        }
        let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
        let [api, webhooks, id, token] = parts.as_slice() else { return Err(UrlError::WrongPath) };
        let id_ok = (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
        let token_ok = (20..=150).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if *api != "api" || *webhooks != "webhooks" || !id_ok || !token_ok {
            return Err(UrlError::WrongPath);
        }
        Ok(Self { url: format!("https://{host}/api/webhooks/{id}/{token}"), token: (*token).to_string() })
    }

    /// Only the client reads this, to make the one request.
    pub(super) fn as_str(&self) -> &str {
        &self.url
    }

    /// The last four characters of the secret code, for "saved, ends in ...". Never more.
    pub fn tail(&self) -> String {
        let chars: Vec<char> = self.token.chars().collect();
        chars[chars.len().saturating_sub(4)..].iter().collect()
    }

    /// The pieces to mask wherever they might show up (the whole link and the secret code).
    pub fn secret_pieces(&self) -> [&str; 2] {
        [&self.url, &self.token]
    }

    /// Tests only: a link to a fake server on this PC. Production links always go through [`Webhook::parse`].
    #[cfg(test)]
    pub(crate) fn for_test(url: &str, token: &str) -> Self {
        Self { url: url.to_string(), token: token.to_string() }
    }
}
