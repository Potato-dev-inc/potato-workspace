//! Merging the lend node key into the device node key (plan `DEVICES-RUNTIMES-1115.md` 2.7, phase 6).
//!
//! Old lend pairings are bound to the lend node id (the lender's id sits in every borrower's grant hint, and the handshake
//! MAC covers both ids). So a merge never changes an id that a live grant uses:
//!
//! - no lend key: nothing to merge;
//! - no device key yet: the device identity ADOPTS the lend key (same node id, old pairings keep working);
//! - same key: done;
//! - different keys and no live grant: the lend key is retired, the device identity stays;
//! - different keys and a live grant: the lend key stays ([`Outcome::KeptLegacy`]) and the merge is tried again later.
//!
//! This is the pure step. It is only worth running when the lend endpoint and the device endpoint are ONE endpoint (two
//! endpoints with one key would fight over the relay), so the app does not call it while they are two. Only kinds are
//! ever reported, never key bytes.

#![allow(dead_code)] // not called from the app yet: it runs when the lend key moves to the device link; tested below

use crate::keys::KeyStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    NothingToMerge,
    Adopted,
    Same,
    Retired,
    KeptLegacy,
}

/// The kind as a word for the log.
impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::NothingToMerge => "nothing_to_merge",
            Outcome::Adopted => "adopted",
            Outcome::Same => "same",
            Outcome::Retired => "retired",
            Outcome::KeptLegacy => "kept_legacy",
        }
    }
}

pub fn merge_lend_key(lend: &KeyStore, device: &KeyStore, live_grants: bool) -> Result<Outcome, String> {
    let Some(old) = lend.peek_p2p_node()? else {
        return Ok(Outcome::NothingToMerge);
    };
    match device.peek_p2p_node()? {
        None => {
            if device.adopt_p2p_node(&old)? {
                Ok(Outcome::Adopted)
            } else {
                Err("the credential store did not keep the key".into())
            }
        }
        Some(now) if now == old => Ok(Outcome::Same),
        Some(_) if live_grants => Ok(Outcome::KeptLegacy),
        Some(_) => {
            lend.forget_p2p_node()?;
            Ok(Outcome::Retired)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{MemoryBackend, SecretBackend};
    use std::sync::Arc;

    fn stores() -> (KeyStore, KeyStore) {
        let backend: Arc<dyn SecretBackend> = Arc::new(MemoryBackend::new());
        (KeyStore::with_backend(backend.clone(), "p/lend"), KeyStore::with_backend(backend, "p/devices"))
    }

    #[test]
    fn nothing_to_merge_without_a_lend_key_and_nothing_is_made() {
        let (lend, device) = stores();
        assert_eq!(merge_lend_key(&lend, &device, false).unwrap(), Outcome::NothingToMerge);
        assert!(lend.peek_p2p_node().unwrap().is_none() && device.peek_p2p_node().unwrap().is_none());
    }

    #[test]
    fn the_device_adopts_the_lend_key_so_old_pairings_keep_their_node_id() {
        let (lend, device) = stores();
        let id = lend.p2p_node().unwrap().to_bytes();
        assert_eq!(merge_lend_key(&lend, &device, true).unwrap(), Outcome::Adopted);
        assert_eq!(device.p2p_node().unwrap().to_bytes(), id);
        assert_eq!(lend.p2p_node().unwrap().to_bytes(), id, "the lend key is untouched");
        assert_eq!(merge_lend_key(&lend, &device, true).unwrap(), Outcome::Same);
    }

    #[test]
    fn different_keys_with_a_live_grant_keep_the_lend_key() {
        let (lend, device) = stores();
        let old = lend.p2p_node().unwrap().to_bytes();
        let dev = device.p2p_node().unwrap().to_bytes();
        assert_ne!(old, dev);
        assert_eq!(merge_lend_key(&lend, &device, true).unwrap(), Outcome::KeptLegacy);
        assert_eq!(lend.p2p_node().unwrap().to_bytes(), old, "a live lend keeps its node id");
        assert_eq!(device.p2p_node().unwrap().to_bytes(), dev, "device pairings keep theirs");
    }

    #[test]
    fn different_keys_without_a_live_grant_retire_the_lend_key_and_keep_the_device_key() {
        let (lend, device) = stores();
        lend.p2p_node().unwrap();
        let dev = device.p2p_node().unwrap().to_bytes();
        assert_eq!(merge_lend_key(&lend, &device, false).unwrap(), Outcome::Retired);
        assert!(lend.peek_p2p_node().unwrap().is_none());
        assert_eq!(device.p2p_node().unwrap().to_bytes(), dev);
    }

    #[test]
    fn the_outcome_words_hold_no_key_bytes() {
        for o in [Outcome::NothingToMerge, Outcome::Adopted, Outcome::Same, Outcome::Retired, Outcome::KeptLegacy] {
            assert!(o.as_str().chars().all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }
}
