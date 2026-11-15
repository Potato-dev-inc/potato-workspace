//! The Discord bot token: kept only in the OS credential store, never shown again.
//!
//! A bot token is full control of the bot. So:
//! - There is no file fallback. When the store cannot be used, saving refuses.
//! - The token lives in `Token`, which has no `Debug`, no `Display` and no `Serialize`: it cannot be printed,
//!   logged or sent to the window by accident. Only `expose` gives the text back, and only inside this module
//!   tree (the IDENTIFY frame and the `Authorization` header use it).
//! - It is added to the masks in `redact` as soon as it is saved or read, so agent text and logs hide it.
//! - Every error is a fixed sentence. None holds the token.
//! - The name in the store is `discord_bot_token.<companion id>`. It is not a provider secret and not a UI
//!   secret, so no generic secret command can read it.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::redact::known;
use crate::secrets::{self, SecretBackend};

pub const NO_STORE: &str = "This computer has no safe place for the token, so the bot can't be used.";
pub const BAD_FORMAT: &str = "That does not look like a bot token. Copy the whole token from the Discord developer page.";
pub const NOT_KEPT: &str = "The token could not be saved in the credential store.";
pub const NOT_READ: &str = "The token could not be read from the credential store.";

/// `<id part>.<time part>.<secret part>`, each of url-safe characters.
static SHAPE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,45}$").expect("token shape"));

pub fn looks_like_token(raw: &str) -> bool {
    SHAPE.is_match(raw)
}

/// The token. No `Debug`, `Display`, `Serialize` or `PartialEq` on purpose.
#[derive(Clone)]
pub struct Token(String);

impl Token {
    /// The text, for the one place that must send it.
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

/// The credential store name for a companion's bot.
pub fn key_name(companion_id: &str) -> String {
    format!("discord_bot_token.{companion_id}")
}

/// Stores the token. Refuses when the store is unusable, the shape is wrong or the read-back differs.
pub fn save_with(backend: &dyn SecretBackend, companion_id: &str, raw: &str) -> Result<(), String> {
    if !backend.available() {
        return Err(NO_STORE.into());
    }
    let text = raw.trim();
    if !looks_like_token(text) {
        return Err(BAD_FORMAT.into());
    }
    // Mask first, so nothing after this point can show it.
    known::register(text);
    let name = key_name(companion_id);
    if backend.set(&name, text).is_err() {
        return Err(NOT_KEPT.into());
    }
    match backend.get(&name) {
        Ok(Some(back)) if back == text => Ok(()),
        _ => Err(NOT_KEPT.into()),
    }
}

/// The saved token, or `None`. Masked from this point on.
pub fn read_with(backend: &dyn SecretBackend, companion_id: &str) -> Result<Option<Token>, String> {
    let value = backend.get(&key_name(companion_id)).map_err(|_| NOT_READ.to_string())?.filter(|v| !v.is_empty());
    if let Some(v) = &value {
        known::register(v);
    }
    Ok(value.map(Token))
}

pub fn forget_with(backend: &dyn SecretBackend, companion_id: &str) -> Result<(), String> {
    backend.delete(&key_name(companion_id)).map_err(|_| NOT_KEPT.to_string())
}

/// What the window may know: whether one is saved and its last four characters. Never the token.
pub fn mask_with(backend: &dyn SecretBackend, companion_id: &str) -> (bool, Option<String>) {
    match backend.get(&key_name(companion_id)) {
        Ok(value) => {
            let m = secrets::mask(value.as_deref());
            (m.set, m.last4)
        }
        Err(_) => (false, None),
    }
}

#[cfg(test)]
pub const TEST_TOKEN: &str = concat!("MTExMTExMTExMTExMTExMTEx", ".", "GaBcDe", ".", "fakefakefakefakefakefakefakefake1");

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    #[test]
    fn the_shape_check_accepts_a_token_and_nothing_else() {
        assert!(looks_like_token(TEST_TOKEN));
        for bad in ["", "abc", "123456789:TESTtokenTESTtokenTESTtokenTESTtok", "a.b.c", "MTExMTExMTExMTExMTExMTEx.GaBcDe", concat!(" MTExMTExMTExMTExMTExMTEx", ".", "GaBcDe", ".", "fakefakefakefakefakefakefakefake1")] {
            assert!(!looks_like_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn saving_trims_checks_and_reads_back() {
        let store = MemoryBackend::new();
        save_with(&store, "mochi", &format!("  {TEST_TOKEN}\n")).unwrap();
        let back = read_with(&store, "mochi").unwrap().unwrap();
        assert_eq!(back.expose(), TEST_TOKEN);
        assert!(read_with(&store, "other").unwrap().is_none());
        // The name is per companion and not a window secret.
        assert_eq!(key_name("mochi"), "discord_bot_token.mochi");
        assert!(!secrets::is_ui_secret(&key_name("mochi")) && !secrets::is_provider_secret(&key_name("mochi")));
    }

    #[test]
    fn no_store_or_a_bad_shape_refuses_with_a_fixed_sentence() {
        let none = MemoryBackend::unavailable();
        assert_eq!(save_with(&none, "mochi", TEST_TOKEN), Err(NO_STORE.to_string()));
        let store = MemoryBackend::new();
        assert_eq!(save_with(&store, "mochi", "nope"), Err(BAD_FORMAT.to_string()));
        assert!(read_with(&store, "mochi").unwrap().is_none());
    }

    /// Accepts writes and forgets them: the read-back check must catch it.
    struct Forgetful;
    impl SecretBackend for Forgetful {
        fn get(&self, _name: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn set(&self, _name: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _name: &str) -> Result<(), String> {
            Ok(())
        }
        fn label(&self) -> &'static str {
            "forgetful"
        }
        fn available(&self) -> bool {
            true
        }
    }

    #[test]
    fn a_store_that_forgets_is_caught_and_no_error_holds_the_token() {
        let err = save_with(&Forgetful, "mochi", TEST_TOKEN).unwrap_err();
        assert_eq!(err, NOT_KEPT);
        for text in [NO_STORE, BAD_FORMAT, NOT_KEPT, NOT_READ] {
            assert!(!text.contains(TEST_TOKEN));
        }
    }

    #[test]
    fn the_mask_gives_set_and_last_four_only_and_forget_removes_it() {
        let store = MemoryBackend::new();
        assert_eq!(mask_with(&store, "mochi"), (false, None));
        save_with(&store, "mochi", TEST_TOKEN).unwrap();
        let (set, last4) = mask_with(&store, "mochi");
        assert!(set);
        assert_eq!(last4.as_deref(), Some(&TEST_TOKEN[TEST_TOKEN.len() - 4..]));
        forget_with(&store, "mochi").unwrap();
        assert_eq!(mask_with(&store, "mochi"), (false, None));
    }
}
