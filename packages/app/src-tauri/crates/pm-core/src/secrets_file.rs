//! Linux only: the private-file secret store (founder decision D3).
//!
//! The `keyring` crate's `linux-native` feature is the kernel keyutils keyring. It is wiped when the machine
//! (or WSL) restarts, so the account session and device keys vanished. There is no Secret Service client in our
//! feature set, so the persistent store here IS a private file: `~/.local/share/potato-workspace-keys/secrets.json`,
//! file mode 0600, folder mode 0700, written atomically. Honest limit: the values are NOT encrypted. The protection
//! is the same as `~/.ssh` keys: only this user (and root) can read the file.
//!
//! Reads check the file first, then the old keyutils entry; a keyutils hit is copied into the file (migration).
//! Values are never logged. A file that is damaged, owned by someone else, or readable by group/world is refused
//! with a plain error, never silently trusted and never overwritten.

use crate::secrets::SecretBackend;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

const DIR_NAME: &str = "potato-workspace-keys";
const FILE_NAME: &str = "secrets.json";

/// The line Connect shows when this store is in use.
pub const LABEL: &str = "a private file in your home folder";

pub struct FileBackend {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl FileBackend {
    pub fn at(dir: PathBuf) -> Self {
        Self { dir, lock: Mutex::new(()) }
    }

    /// `~/.local/share/potato-workspace-keys` (or under `$XDG_DATA_HOME`).
    pub fn default_dir() -> PathBuf {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| crate::app_paths::home_dir().map(|h| h.join(".local/share")))
            .unwrap_or_else(|| PathBuf::from("/nonexistent"));
        base.join(DIR_NAME)
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    /// The folder is ours to create and to tighten: make it 0700.
    fn ensure_dir(&self) -> Result<(), String> {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir).map_err(|e| format!("Could not make the private key folder: {e}"))?;
        let m = fs::metadata(&self.dir).map_err(|e| e.to_string())?;
        if m.uid() != my_uid()? {
            return Err("The private key folder belongs to another user, so it was not used.".into());
        }
        if m.mode() & 0o077 != 0 {
            fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700)).map_err(|e| format!("Could not lock down the private key folder: {e}"))?;
        }
        Ok(())
    }

    fn read_all(&self) -> Result<BTreeMap<String, String>, String> {
        let path = self.file();
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(format!("Could not read the private key file: {e}")),
        };
        if meta.uid() != my_uid()? || meta.mode() & 0o077 != 0 {
            return Err("The private key file can be read by other people, so it was not trusted. Run chmod 600 on it, or delete it and sign in again.".into());
        }
        let text = fs::read_to_string(&path).map_err(|e| format!("Could not read the private key file: {e}"))?;
        serde_json::from_str(&text).map_err(|_| "The private key file is damaged, so it was not used. Delete it and sign in again.".to_string())
    }

    fn write_all(&self, all: &BTreeMap<String, String>) -> Result<(), String> {
        self.ensure_dir()?;
        let tmp = self.dir.join(format!("{FILE_NAME}.tmp"));
        let body = serde_json::to_vec(all).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&tmp);
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(|e| format!("Could not write the private key file: {e}"))?;
        f.write_all(&body).and_then(|_| f.sync_all()).map_err(|e| format!("Could not write the private key file: {e}"))?;
        fs::rename(&tmp, self.file()).map_err(|e| format!("Could not write the private key file: {e}"))
    }
}

/// shortcut: the owner of /proc/self is the effective uid; no libc dependency needed.
fn my_uid() -> Result<u32, String> {
    fs::metadata("/proc/self").map(|m| m.uid()).map_err(|e| e.to_string())
}

impl SecretBackend for FileBackend {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let _g = self.lock.lock();
        Ok(self.read_all()?.remove(name))
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let _g = self.lock.lock();
        let mut all = self.read_all()?;
        all.insert(name.to_string(), value.to_string());
        self.write_all(&all)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        let _g = self.lock.lock();
        let mut all = self.read_all()?;
        if all.remove(name).is_some() {
            self.write_all(&all)?;
        }
        Ok(())
    }
    fn label(&self) -> &'static str {
        LABEL
    }
    fn available(&self) -> bool {
        self.ensure_dir().is_ok() && self.read_all().is_ok()
    }
}

/// The Linux store: the private file, with the old kernel-keyring entries still readable (and copied over).
pub struct FallbackBackend<P: SecretBackend> {
    pub primary: P,
    pub file: FileBackend,
}

impl<P: SecretBackend> SecretBackend for FallbackBackend<P> {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        if let Some(v) = self.file.get(name)? {
            return Ok(Some(v));
        }
        // An unreadable kernel keyring just means nothing to migrate.
        let Some(old) = self.primary.get(name).ok().flatten() else { return Ok(None) };
        match self.file.set(name, &old) {
            Ok(()) => tracing::info!(name, "moved a secret from the kernel keyring to the private file"),
            Err(e) => tracing::warn!(error = %e, "could not move a secret to the private file"),
        }
        Ok(Some(old))
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.file.set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        let _ = self.primary.delete(name);
        self.file.delete(name)
    }
    fn label(&self) -> &'static str {
        LABEL
    }
    fn available(&self) -> bool {
        self.file.available()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-secfile-{tag}-{}", uuid::Uuid::new_v4())).join("keys");
        d
    }
    fn mode(p: &std::path::Path) -> u32 {
        fs::metadata(p).unwrap().mode() & 0o777
    }

    #[test]
    fn roundtrip_with_private_modes() {
        let d = dir("rt");
        let b = FileBackend::at(d.clone());
        assert_eq!(b.get("a").unwrap(), None);
        b.set("a", "one").unwrap();
        b.set("b", "two").unwrap();
        assert_eq!(b.get("a").unwrap().as_deref(), Some("one"));
        assert_eq!(mode(&d), 0o700);
        assert_eq!(mode(&d.join(FILE_NAME)), 0o600);
        assert!(!d.join(format!("{FILE_NAME}.tmp")).exists());
        b.delete("a").unwrap();
        assert_eq!(b.get("a").unwrap(), None);
        assert_eq!(b.get("b").unwrap().as_deref(), Some("two"));
        assert!(b.available());
    }

    #[test]
    fn a_new_instance_reads_what_the_last_one_wrote() {
        let d = dir("restart");
        FileBackend::at(d.clone()).set("account/x/session", "v").unwrap();
        assert_eq!(FileBackend::at(d).get("account/x/session").unwrap().as_deref(), Some("v"));
    }

    #[test]
    fn an_old_keyring_entry_is_copied_to_the_file_on_first_read() {
        let d = dir("mig");
        let primary = MemoryBackend::new();
        primary.set("k", "old").unwrap();
        let b = FallbackBackend { primary, file: FileBackend::at(d.clone()) };
        assert_eq!(b.get("k").unwrap().as_deref(), Some("old"));
        // After the "restart wipe" (empty keyring) the file still has it.
        let after = FallbackBackend { primary: MemoryBackend::new(), file: FileBackend::at(d) };
        assert_eq!(after.get("k").unwrap().as_deref(), Some("old"));
        after.delete("k").unwrap();
        assert_eq!(after.get("k").unwrap(), None);
    }

    #[test]
    fn a_broken_keyring_does_not_block_the_file() {
        let b = FallbackBackend { primary: MemoryBackend::unavailable(), file: FileBackend::at(dir("nokr")) };
        b.set("k", "v").unwrap();
        assert_eq!(b.get("k").unwrap().as_deref(), Some("v"));
        assert_eq!(b.get("missing").unwrap(), None);
        assert!(b.available());
    }

    #[test]
    fn a_file_others_can_read_is_refused_not_trusted() {
        let d = dir("perm");
        let b = FileBackend::at(d.clone());
        b.set("k", "secret-value").unwrap();
        fs::set_permissions(d.join(FILE_NAME), fs::Permissions::from_mode(0o644)).unwrap();
        let e = b.get("k").unwrap_err();
        assert!(e.contains("chmod 600") && !e.contains("secret-value"));
        assert!(b.set("k", "x").is_err());
        assert!(!b.available());
    }

    #[test]
    fn a_loose_folder_is_tightened() {
        let d = dir("loose");
        fs::create_dir_all(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        FileBackend::at(d.clone()).set("k", "v").unwrap();
        assert_eq!(mode(&d), 0o700);
    }

    #[test]
    fn a_damaged_file_is_refused_and_left_alone() {
        let d = dir("bad");
        let b = FileBackend::at(d.clone());
        b.set("k", "v").unwrap();
        fs::write(d.join(FILE_NAME), "not json").unwrap();
        assert!(b.get("k").unwrap_err().contains("damaged"));
        assert!(b.set("k", "v").is_err());
        assert_eq!(fs::read_to_string(d.join(FILE_NAME)).unwrap(), "not json");
    }
}
