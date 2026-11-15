//! Files between my devices (capability `files`, protocol `pm/files/1`): the SERVING side, and the rules both sides share.
//!
//! One stream is one request, like `wire.rs`: a header (4-byte length + JSON, `FHead`), then the answer's header
//! (`FReply`) and, for some operations, a body that is streamed, never loaded whole.
//!
//! - `roots`: which folders this PC shares with that device. Names only, never a path on this disk.
//! - `list`, `stat`: look at a folder or a file.
//! - `peek`: the first bytes of a file (a preview). Never logged as a copy.
//! - `read`: a file from `offset` on (a dropped link is resumed by asking again from where it stopped).
//! - `sum`: the SHA-256 of a whole file, so the other side can check what it got.
//! - `archive`: many files or a folder packed into one stream (`PMAR1`, gzip), built to a temp file first.
//! - `write`: a file is received into a part file next to its place and renamed when whole and checked. The answer to the
//!   header says how much of it is already here (`have`), so a dropped link is resumed too.
//! - `put_archive`: an archive is received the same way and unpacked into a NEW folder.
//!
//! **The far side decides, here.** Every path is a root name plus a relative path, and is checked on THIS side after
//! links are resolved: no `..`, no absolute path or other drive, no device names (`CON`, `NUL`...), nothing outside the
//! shared folders, nothing in the deny-list (sign-ins, keys, credential files, this app's own data). Nothing is ever
//! overwritten unless the asker said `replace`, and nothing is ever written inside a `.git` folder.
//! A log line (kind only, never a path or a file name) is kept for each copy and each received file (`activity.rs`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};

use super::activity::{ActivityLog, Dir, Kind};
use super::route::PrefsStore;
use super::serve::Live;
use super::wire;
use crate::p2p::capability::CapabilityHandler;
use crate::p2p::endpoint::{BiStream, Link, NodeId, CLOSE_NOT_ALLOWED};

/// The protocol version both sides must speak. A newer one is a new `pm/files/<n>` name.
pub const VERSION: u32 = 1;
/// The size of the one buffer a transfer uses. Nothing here ever holds a whole file.
pub const CHUNK: usize = 64 * 1024;
/// The most entries one `list` answers.
pub const LIST_MAX: usize = 5000;
/// The most paths one `archive` may name (the header is small).
pub const PATHS_MAX: usize = 200;
/// The most entries one archive holds.
pub const ARCHIVE_ENTRIES_MAX: usize = 100_000;
/// The most bytes a `peek` returns.
pub const PEEK_MAX: u64 = 4 * 1024 * 1024;
/// The longest answer body (JSON) either side reads.
pub const JSON_MAX: usize = 8 * 1024 * 1024;

const HEAD_WAIT: Duration = Duration::from_secs(15);

// ------------------------------------------------------------------------------------------------- the wire

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FHead {
    pub v: u32,
    pub op: String,
    /// A shared folder's name (from `roots`).
    #[serde(default)]
    pub root: String,
    /// A path inside it, with `/`. Empty: the folder itself.
    #[serde(default)]
    pub path: String,
    /// `archive`: several paths.
    #[serde(default)]
    pub paths: Vec<String>,
    /// `read`: where to start. `peek`: unused.
    #[serde(default)]
    pub offset: u64,
    /// `read` / `peek`: how many bytes at most (0: to the end).
    #[serde(default)]
    pub len: u64,
    /// `write` / `put_archive`: the whole size.
    #[serde(default)]
    pub size: u64,
    /// `write` / `put_archive`: the SHA-256 (hex) of the whole thing.
    #[serde(default)]
    pub sum: String,
    /// `write`: the person said yes to replacing a file that is there.
    #[serde(default)]
    pub replace: bool,
    /// `archive`: one folder named: pack what is in it, not the folder itself. `put_archive`: the new folder's name.
    #[serde(default)]
    pub strip: bool,
    #[serde(default)]
    pub name: String,
}

impl FHead {
    pub fn new(op: &str) -> Self {
        Self { v: VERSION, op: op.to_string(), ..Default::default() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FReply {
    pub status: u16,
    #[serde(default)]
    pub code: String,
    /// Plain words for the person (ours, never a path).
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub body_len: u64,
    /// `read`: the whole file's size. `archive`: the archive's size.
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime: u64,
    /// `write`: how many bytes are already here.
    #[serde(default)]
    pub have: u64,
    #[serde(default)]
    pub sum: String,
    /// `put_archive`: the name of the folder it was unpacked into.
    #[serde(default)]
    pub name: String,
}

// ------------------------------------------------------------------------------------------------- refusals

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refuse {
    /// The path itself is wrong: `..`, an absolute path, another drive, a device name.
    BadPath,
    /// A path that is not shared: outside the folders, a link out, or on the deny-list.
    NotShared,
    NoRoot,
    NotFound,
    /// There is a file there already and nobody said yes.
    Exists,
    NotAFile,
    NotADir,
    TooMany,
    BadSum,
    BadRange,
    Io(String),
}

impl Refuse {
    pub fn status(&self) -> u16 {
        match self {
            Refuse::BadPath | Refuse::NotAFile | Refuse::NotADir => 400,
            Refuse::NotShared => 403,
            Refuse::NoRoot | Refuse::NotFound => 404,
            Refuse::Exists => 409,
            Refuse::BadRange => 416,
            Refuse::TooMany => 413,
            Refuse::BadSum => 422,
            Refuse::Io(_) => 500,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Refuse::BadPath => "BAD_PATH",
            Refuse::NotShared => "NOT_SHARED",
            Refuse::NoRoot => "NO_ROOT",
            Refuse::NotFound => "NOT_FOUND",
            Refuse::Exists => "EXISTS",
            Refuse::NotAFile => "NOT_A_FILE",
            Refuse::NotADir => "NOT_A_FOLDER",
            Refuse::TooMany => "TOO_MANY",
            Refuse::BadSum => "BAD_SUM",
            Refuse::BadRange => "BAD_RANGE",
            Refuse::Io(_) => "IO",
        }
    }

    /// Plain words. Never a path, never the text of an OS error.
    pub fn words(&self) -> &'static str {
        match self {
            Refuse::BadPath => "That path is not allowed.",
            Refuse::NotShared => "That is not shared.",
            Refuse::NoRoot => "That folder is not shared on this device.",
            Refuse::NotFound => "That is not there any more.",
            Refuse::Exists => "There is a file with that name already.",
            Refuse::NotAFile => "That is not a file.",
            Refuse::NotADir => "That is not a folder.",
            Refuse::TooMany => "That is too many files for one go.",
            Refuse::BadSum => "The file did not arrive whole. Try again.",
            Refuse::BadRange => "That part of the file is not there.",
            Refuse::Io(_) => "The device could not do that.",
        }
    }

    /// An attempt to get at something that is not shared (logged as "refused").
    fn is_escape(&self) -> bool {
        matches!(self, Refuse::BadPath | Refuse::NotShared)
    }
}

impl From<std::io::Error> for Refuse {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Refuse::NotFound,
            _ => Refuse::Io(e.kind().to_string()),
        }
    }
}

// ------------------------------------------------------------------------------------------------- path rules

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
    "lpt8", "lpt9",
];

fn part_ok(part: &str) -> bool {
    if part == ".." || part.len() > 255 {
        return false;
    }
    if part.chars().any(|c| c.is_control() || "\\:*?\"<>|".contains(c)) {
        return false;
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("").trim_end().to_ascii_lowercase();
    !RESERVED.contains(&stem.as_str())
}

/// The parts of a relative path written with `/`. An absolute path, `..`, a drive, a stream name (`:`), a backslash or a
/// device name is refused, whatever the OS under it is (the same words on every system).
pub fn rel_parts(rel: &str) -> Result<Vec<&str>, Refuse> {
    if rel.len() > 1024 || rel.starts_with('/') {
        return Err(Refuse::BadPath);
    }
    let mut out = Vec::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if !part_ok(part) {
            return Err(Refuse::BadPath);
        }
        out.push(part);
    }
    Ok(out)
}

/// Names that hold sign-ins, keys or secrets. They are never listed, read or written, wherever they are.
pub fn name_denied(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const EXACT: [&str; 26] = [
        ".claude", ".codex", ".gemini", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".env",
        "credentials", "credentials.json", ".credentials.json", "auth.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts", "secrets.json",
        "keychain", "login.keychain-db",
    ];
    if EXACT.contains(&n.as_str()) {
        return true;
    }
    if n.starts_with("credentials.") || n.starts_with("id_rsa") || n.starts_with("id_ed25519") || n.starts_with("id_ecdsa") {
        return true;
    }
    if n.starts_with(".env.") {
        return !(n.ends_with(".example") || n.ends_with(".sample") || n.ends_with(".template"));
    }
    const EXT: [&str; 10] = [".pem", ".key", ".pfx", ".p12", ".ppk", ".kdbx", ".keystore", ".jks", ".gpg", ".kdb"];
    EXT.iter().any(|e| n.ends_with(e))
}

/// Places that are never shared, by full path: the sign-in folders in the home folder, and what the caller adds (this
/// app's own data).
pub struct Deny {
    paths: Vec<PathBuf>,
}

impl Deny {
    pub fn new(extra: &[PathBuf]) -> Arc<Self> {
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Some(home) = crate::project_path::home_dir() {
            for n in [".claude", ".codex", ".gemini", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"] {
                paths.push(home.join(n));
            }
            paths.push(home.join(".config").join("gcloud"));
        }
        paths.extend(extra.iter().cloned());
        let paths = paths.into_iter().map(|p| std::fs::canonicalize(&p).unwrap_or(p)).collect();
        Arc::new(Self { paths })
    }

    pub fn path_denied(&self, p: &Path) -> bool {
        self.paths.iter().any(|d| p.starts_with(d))
    }
}

#[derive(Debug, Clone)]
pub struct Root {
    pub name: String,
    pub path: PathBuf,
}

/// The shared folders of one request, and every check a path goes through.
pub struct Sandbox {
    roots: Vec<Root>,
    deny: Arc<Deny>,
}

impl Sandbox {
    /// Roots that are not folders any more, or that are on the deny-list, are left out.
    pub fn new(roots: Vec<Root>, deny: Arc<Deny>) -> Self {
        let roots = roots
            .into_iter()
            .filter_map(|r| {
                let path = std::fs::canonicalize(&r.path).ok()?;
                (path.is_dir() && !deny.path_denied(&path)).then_some(Root { name: r.name, path })
            })
            .collect();
        Self { roots, deny }
    }

    pub fn names(&self) -> Vec<String> {
        self.roots.iter().map(|r| r.name.clone()).collect()
    }

    pub fn root(&self, name: &str) -> Result<&Root, Refuse> {
        self.roots.iter().find(|r| r.name == name).ok_or(Refuse::NoRoot)
    }

    /// A resolved path must be inside its root (links are followed first), hold no denied name and, to write, no `.git`.
    fn inside(&self, root: &Root, canon: &Path, write: bool) -> Result<(), Refuse> {
        if !canon.starts_with(&root.path) {
            return Err(Refuse::NotShared);
        }
        let rel = canon.strip_prefix(&root.path).map_err(|_| Refuse::NotShared)?;
        for c in rel.components() {
            let name = c.as_os_str().to_string_lossy();
            if name_denied(&name) || (write && name.eq_ignore_ascii_case(".git")) {
                return Err(Refuse::NotShared);
            }
        }
        if self.deny.path_denied(canon) {
            return Err(Refuse::NotShared);
        }
        Ok(())
    }

    /// A path that exists, resolved: links are followed and the result is checked.
    pub fn existing(&self, root: &str, rel: &str, write: bool) -> Result<PathBuf, Refuse> {
        let root = self.root(root)?;
        let parts = rel_parts(rel)?;
        let mut p = root.path.clone();
        for part in &parts {
            p.push(part);
        }
        let canon = std::fs::canonicalize(&p).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Refuse::NotFound,
            _ => Refuse::BadPath,
        })?;
        self.inside(root, &canon, write)?;
        Ok(canon)
    }

    /// Where a new file would go: its folder must exist and be shared; the name is checked. May already exist.
    pub fn new_file(&self, root: &str, rel: &str) -> Result<PathBuf, Refuse> {
        let root_ref = self.root(root)?;
        let parts = rel_parts(rel)?;
        let (last, dirs) = parts.split_last().ok_or(Refuse::BadPath)?;
        if name_denied(last) || last.eq_ignore_ascii_case(".git") {
            return Err(Refuse::NotShared);
        }
        let parent = self.existing(root, &dirs.join("/"), true)?;
        if !parent.is_dir() {
            return Err(Refuse::NotADir);
        }
        let target = parent.join(last);
        if std::fs::symlink_metadata(&target).is_ok() {
            let canon = std::fs::canonicalize(&target).map_err(|_| Refuse::BadPath)?;
            self.inside(root_ref, &canon, true)?;
            return Ok(canon);
        }
        Ok(target)
    }

    /// A shared folder to put things in.
    pub fn dir_for_write(&self, root: &str, rel: &str) -> Result<PathBuf, Refuse> {
        let dir = self.existing(root, rel, true)?;
        if dir.is_dir() {
            Ok(dir)
        } else {
            Err(Refuse::NotADir)
        }
    }
}

// ------------------------------------------------------------------------------------------------- streaming helpers

/// Copies exactly `n` bytes with ONE buffer of `CHUNK` bytes. `each` sees every piece (for a checksum or a progress count)
/// and may stop the copy with an error. A reader that ends early is an error. Returns the bytes copied.
pub async fn copy_exact<R, W>(r: &mut R, w: &mut W, mut n: u64, each: &mut (dyn FnMut(&[u8]) -> std::io::Result<()> + Send)) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    while n > 0 {
        let want = n.min(CHUNK as u64) as usize;
        let got = r.read(&mut buf[..want]).await?;
        if got == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the stream ended early"));
        }
        each(&buf[..got])?;
        w.write_all(&buf[..got]).await?;
        n -= got as u64;
        done += got as u64;
    }
    Ok(done)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The SHA-256 of a file, read piece by piece.
pub async fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

pub fn sum_ok(sum: &str) -> bool {
    sum.len() == 64 && sum.chars().all(|c| c.is_ascii_hexdigit())
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// `name`, then `name (2)`, `name (3)`...: a name that is free in `dir` (the extension stays at the end).
pub fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if std::fs::symlink_metadata(&p).is_err() {
            return p;
        }
    }
    dir.join(format!("{stem} ({}){ext}", uuid::Uuid::new_v4().simple()))
}

// ------------------------------------------------------------------------------------------------- archive (`PMAR1`)

const MAGIC: &[u8] = b"PMAR1\n";

pub struct ArchiveWriter<W: Write> {
    enc: GzEncoder<W>,
    count: usize,
}

impl<W: Write> ArchiveWriter<W> {
    pub fn new(w: W) -> std::io::Result<Self> {
        let mut enc = GzEncoder::new(w, Compression::fast());
        enc.write_all(MAGIC)?;
        Ok(Self { enc, count: 0 })
    }

    fn head(&mut self, kind: u8, name: &str) -> std::io::Result<()> {
        if self.count >= ARCHIVE_ENTRIES_MAX {
            return Err(std::io::Error::other("too many"));
        }
        self.count += 1;
        let bytes = name.as_bytes();
        if bytes.len() > u16::MAX as usize {
            return Err(std::io::Error::other("name too long"));
        }
        self.enc.write_all(&[kind])?;
        self.enc.write_all(&(bytes.len() as u16).to_be_bytes())?;
        self.enc.write_all(bytes)
    }

    pub fn dir(&mut self, name: &str) -> std::io::Result<()> {
        self.head(b'D', name)
    }

    /// A file of exactly `size` bytes read from `r` (a file that changed size while packing is an error).
    pub fn file(&mut self, name: &str, size: u64, r: &mut dyn Read) -> std::io::Result<()> {
        self.head(b'F', name)?;
        self.enc.write_all(&size.to_be_bytes())?;
        let copied = std::io::copy(&mut r.take(size), &mut self.enc)?;
        if copied != size {
            return Err(std::io::Error::other("the file changed while it was being packed"));
        }
        Ok(())
    }

    pub fn finish(mut self) -> std::io::Result<W> {
        self.enc.write_all(&[b'E'])?;
        self.enc.finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub dir: bool,
    pub name: String,
    pub size: u64,
}

pub struct ArchiveReader<R: Read> {
    dec: GzDecoder<R>,
}

impl<R: Read> ArchiveReader<R> {
    pub fn new(r: R) -> Result<Self, Refuse> {
        let mut dec = GzDecoder::new(r);
        let mut magic = [0u8; 6];
        dec.read_exact(&mut magic).map_err(|_| Refuse::BadSum)?;
        if magic != MAGIC {
            return Err(Refuse::BadSum);
        }
        Ok(Self { dec })
    }

    /// The next entry, or `None` at the end. A file's bytes must be read (`copy_to`) or skipped before the next call.
    pub fn next(&mut self) -> Result<Option<ArchiveEntry>, Refuse> {
        let mut kind = [0u8; 1];
        self.dec.read_exact(&mut kind).map_err(|_| Refuse::BadSum)?;
        if kind[0] == b'E' {
            return Ok(None);
        }
        if kind[0] != b'D' && kind[0] != b'F' {
            return Err(Refuse::BadSum);
        }
        let mut len = [0u8; 2];
        self.dec.read_exact(&mut len).map_err(|_| Refuse::BadSum)?;
        let mut name = vec![0u8; u16::from_be_bytes(len) as usize];
        self.dec.read_exact(&mut name).map_err(|_| Refuse::BadSum)?;
        let name = String::from_utf8(name).map_err(|_| Refuse::BadPath)?;
        let size = if kind[0] == b'F' {
            let mut s = [0u8; 8];
            self.dec.read_exact(&mut s).map_err(|_| Refuse::BadSum)?;
            u64::from_be_bytes(s)
        } else {
            0
        };
        Ok(Some(ArchiveEntry { dir: kind[0] == b'D', name, size }))
    }

    pub fn copy_to(&mut self, size: u64, w: &mut dyn Write) -> Result<(), Refuse> {
        let copied = std::io::copy(&mut (&mut self.dec).take(size), w).map_err(|e| Refuse::Io(e.kind().to_string()))?;
        if copied != size {
            return Err(Refuse::BadSum);
        }
        Ok(())
    }

    pub fn skip(&mut self, size: u64) -> Result<(), Refuse> {
        self.copy_to(size, &mut std::io::sink())
    }
}

pub fn walk_local<W: Write>(w: &mut ArchiveWriter<W>, root: &Root, dir: &Path, arch_name: &str) -> Result<(), Refuse> {
    w.dir(arch_name).map_err(|e| archive_error(&e))?;
    let mut children: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    children.sort_by_key(|e| e.file_name());
    for child in children {
        let name = child.file_name().to_string_lossy().into_owned();
        if name_denied(&name) || !part_ok(&name) {
            continue;
        }
        let Ok(ft) = child.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = child.path();
        let inner = format!("{arch_name}/{name}");
        if ft.is_dir() {
            // A folder that resolves out of the root (a junction) is not followed.
            match std::fs::canonicalize(&path) {
                Ok(c) if c.starts_with(&root.path) => walk_local(w, root, &path, &inner)?,
                _ => continue,
            }
        } else if ft.is_file() {
            let meta = child.metadata()?;
            let mut f = std::fs::File::open(&path)?;
            w.file(&inner, meta.len(), &mut f).map_err(|e| archive_error(&e))?;
        }
    }
    Ok(())
}

fn archive_error(e: &std::io::Error) -> Refuse {
    if e.to_string() == "too many" {
        Refuse::TooMany
    } else {
        Refuse::Io(e.kind().to_string())
    }
}

/// Packs the named paths of a shared folder into `out`. Returns the archive's size. Links are never followed and
/// denied names are left out. `strip`: one folder named, its contents are packed without the folder itself.
pub fn build_archive(sandbox: &Sandbox, root: &str, paths: &[String], strip: bool, out: &Path) -> Result<u64, Refuse> {
    if paths.is_empty() || paths.len() > PATHS_MAX {
        return Err(Refuse::TooMany);
    }
    let root_ref = sandbox.root(root)?;
    let file = std::fs::File::create(out)?;
    let mut w = ArchiveWriter::new(std::io::BufWriter::new(file)).map_err(|e| archive_error(&e))?;
    for rel in paths {
        let canon = sandbox.existing(root, rel, false)?;
        let parts = rel_parts(rel)?;
        let top = parts.last().map(|s| s.to_string()).unwrap_or_else(|| root_ref.name.clone());
        if canon.is_dir() {
            if strip && paths.len() == 1 {
                let mut children: Vec<_> = std::fs::read_dir(&canon)?.filter_map(|e| e.ok()).collect();
                children.sort_by_key(|e| e.file_name());
                for child in children {
                    let name = child.file_name().to_string_lossy().into_owned();
                    let Ok(ft) = child.file_type() else { continue };
                    if name_denied(&name) || !part_ok(&name) || ft.is_symlink() {
                        continue;
                    }
                    if ft.is_dir() {
                        match std::fs::canonicalize(child.path()) {
                            Ok(c) if c.starts_with(&root_ref.path) => walk_local(&mut w, root_ref, &child.path(), &name)?,
                            _ => continue,
                        }
                    } else if ft.is_file() {
                        let mut f = std::fs::File::open(child.path())?;
                        w.file(&name, child.metadata()?.len(), &mut f).map_err(|e| archive_error(&e))?;
                    }
                }
            } else {
                walk_local(&mut w, root_ref, &canon, &top)?;
            }
        } else if canon.is_file() {
            let meta = std::fs::metadata(&canon)?;
            let mut f = std::fs::File::open(&canon)?;
            w.file(&top, meta.len(), &mut f).map_err(|e| archive_error(&e))?;
        }
    }
    let mut inner = w.finish().map_err(|e| archive_error(&e))?;
    inner.flush()?;
    drop(inner);
    Ok(std::fs::metadata(out)?.len())
}

/// Unpacks an archive into `dest` (an existing folder that is new, made for this). Never overwrites, never writes
/// outside `dest`, never follows a link. A name that is not plain (`..`, a drive, a device name, a denied name) refuses
/// the whole archive before anything is written. `forbid_git`: nothing may be written inside a `.git` folder.
/// Returns how many files were written.
pub fn unpack(archive: &Path, dest: &Path, forbid_git: bool) -> Result<usize, Refuse> {
    let dest = std::fs::canonicalize(dest)?;
    let check = |name: &str| -> Result<Vec<String>, Refuse> {
        let parts = rel_parts(name)?;
        if parts.is_empty() {
            return Err(Refuse::BadPath);
        }
        for p in &parts {
            if name_denied(p) || (forbid_git && p.eq_ignore_ascii_case(".git")) {
                return Err(Refuse::NotShared);
            }
        }
        Ok(parts.into_iter().map(str::to_string).collect())
    };
    // Pass one: every name, before anything is written.
    {
        let mut r = ArchiveReader::new(std::io::BufReader::new(std::fs::File::open(archive)?))?;
        let mut count = 0usize;
        while let Some(e) = r.next()? {
            check(&e.name)?;
            count += 1;
            if count > ARCHIVE_ENTRIES_MAX {
                return Err(Refuse::TooMany);
            }
            if !e.dir {
                r.skip(e.size)?;
            }
        }
    }
    let mut r = ArchiveReader::new(std::io::BufReader::new(std::fs::File::open(archive)?))?;
    let mut written = 0usize;
    while let Some(e) = r.next()? {
        let parts = check(&e.name)?;
        let mut target = dest.clone();
        for p in &parts {
            target.push(p);
        }
        if e.dir {
            std::fs::create_dir_all(&target)?;
            if !std::fs::canonicalize(&target)?.starts_with(&dest) {
                return Err(Refuse::NotShared);
            }
            continue;
        }
        let parent = target.parent().ok_or(Refuse::BadPath)?;
        std::fs::create_dir_all(parent)?;
        if !std::fs::canonicalize(parent)?.starts_with(&dest) {
            return Err(Refuse::NotShared);
        }
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => Refuse::Exists,
            _ => Refuse::Io(e.kind().to_string()),
        })?;
        r.copy_to(e.size, &mut f)?;
        written += 1;
    }
    Ok(written)
}

// ------------------------------------------------------------------------------------------------- which folders

/// Which folders this PC shares with each device: the project folders by default, plus the folders the person chose for
/// that device. A device sees only what is here; it can never add to it.
pub struct Folders {
    store: Arc<dyn PrefsStore>,
    projects: Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>,
    chosen: Mutex<std::collections::BTreeMap<String, Vec<String>>>,
}

impl Folders {
    pub fn new(store: Arc<dyn PrefsStore>, projects: Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>) -> Arc<Self> {
        let chosen = store
            .load()
            .and_then(|t| serde_json::from_str::<std::collections::BTreeMap<String, Vec<String>>>(&t).ok())
            .unwrap_or_default();
        Arc::new(Self { store, projects, chosen: Mutex::new(chosen) })
    }

    pub fn chosen(&self, node: &str) -> Vec<String> {
        self.chosen.lock().unwrap_or_else(|p| p.into_inner()).get(node).cloned().unwrap_or_default()
    }

    /// The person's own folders for one device (replaces the list). Each must be a folder.
    pub fn set_chosen(&self, node: &str, folders: &[String]) -> Result<(), String> {
        let mut clean: Vec<String> = Vec::new();
        for f in folders.iter().take(40) {
            let p = PathBuf::from(f.trim());
            if f.trim().is_empty() || !p.is_absolute() || !p.is_dir() {
                return Err("That is not a folder on this PC.".into());
            }
            let s = p.to_string_lossy().into_owned();
            if !clean.contains(&s) {
                clean.push(s);
            }
        }
        let text = {
            let mut map = self.chosen.lock().unwrap_or_else(|p| p.into_inner());
            if clean.is_empty() {
                map.remove(node);
            } else {
                map.insert(node.to_string(), clean);
            }
            serde_json::to_string(&*map).unwrap_or_default()
        };
        self.store.save(&text)
    }

    pub fn forget(&self, node: &str) {
        let _ = self.set_chosen(node, &[]);
    }

    /// The shared folders for one device now, each with a name that is its own (`app`, `app (2)`).
    pub fn roots(&self, node: &str) -> Vec<Root> {
        let mut paths: Vec<PathBuf> = (self.projects)();
        paths.extend(self.chosen(node).into_iter().map(PathBuf::from));
        let mut out: Vec<Root> = Vec::new();
        for p in paths {
            let Ok(canon) = std::fs::canonicalize(&p) else { continue };
            if !canon.is_dir() || out.iter().any(|r| r.path == canon) {
                continue;
            }
            let base = p.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Folder".into());
            let mut name = base.clone();
            let mut n = 2;
            while out.iter().any(|r| r.name == name) {
                name = format!("{base} ({n})");
                n += 1;
            }
            out.push(Root { name, path: canon });
        }
        out
    }
}

// ------------------------------------------------------------------------------------------------- serving

/// What the serving side needs. All of it is read at the moment it is needed.
#[derive(Clone)]
pub struct FilesEnv {
    pub folders: Arc<Folders>,
    pub deny: Arc<Deny>,
    pub activity: Arc<ActivityLog>,
    pub name_of: Arc<dyn Fn(&NodeId) -> String + Send + Sync>,
    pub still_allowed: Arc<dyn Fn(&NodeId) -> bool + Send + Sync>,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

pub struct FilesHandler {
    pub env: FilesEnv,
    pub live: Arc<Live>,
}

#[async_trait]
impl CapabilityHandler for FilesHandler {
    async fn serve(&self, peer: NodeId, link: Arc<dyn Link>) {
        self.live.add(peer, link.clone());
        loop {
            let Ok(stream) = link.accept_bi().await else { break };
            if !(self.env.still_allowed)(&peer) {
                link.close(CLOSE_NOT_ALLOWED, "refused");
                break;
            }
            let task = Serving { env: self.env.clone(), peer, node: peer.to_hex(), #[cfg(test)] link: link.clone() };
            tokio::spawn(task.run(stream));
        }
        self.live.forget(&peer, &link);
    }
}

/// Test hook: after this many bytes of a `read`, the link drops (once). 0: off.
#[cfg(test)]
pub static DROP_AFTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Serving {
    env: FilesEnv,
    peer: NodeId,
    node: String,
    #[cfg(test)]
    link: Arc<dyn Link>,
}

/// A temp file that goes when it is dropped.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Serving {
    fn log(&self, kind: Kind) {
        self.env.activity.record((self.env.now)(), &self.node, &(self.env.name_of)(&self.peer), Dir::In, kind);
    }

    fn sandbox(&self) -> Sandbox {
        Sandbox::new(self.env.folders.roots(&self.node), self.env.deny.clone())
    }

    async fn say(stream: &mut BiStream, head: &FReply, body: &[u8]) {
        let _ = wire::write_frame(&mut stream.send, head, body).await;
    }

    async fn refuse(&self, stream: &mut BiStream, why: Refuse) {
        if why.is_escape() {
            self.log(Kind::Refused);
        }
        let head = FReply { status: why.status(), code: why.code().into(), error: why.words().into(), ..Default::default() };
        Self::say(stream, &head, &[]).await;
        let _ = stream.send.shutdown().await;
    }

    async fn json(stream: &mut BiStream, value: Value) {
        let body = serde_json::to_vec(&value).unwrap_or_default();
        let head = FReply { status: 200, body_len: body.len() as u64, ..Default::default() };
        Self::say(stream, &head, &body).await;
        let _ = stream.send.shutdown().await;
    }

    async fn run(self, mut stream: BiStream) {
        let head = tokio::time::timeout(HEAD_WAIT, wire::read_head::<_, FHead>(&mut stream.recv)).await;
        let Ok(Ok(head)) = head else { return };
        if head.v != VERSION {
            let h = FReply { status: 426, code: "VERSION_TOO_OLD".into(), error: "Update Potato Workspace on both computers.".into(), ..Default::default() };
            Self::say(&mut stream, &h, &[]).await;
            let _ = stream.send.shutdown().await;
            return;
        }
        let result = match head.op.as_str() {
            "roots" => {
                let names = self.sandbox().names();
                Self::json(&mut stream, json!({ "roots": names })).await;
                Ok(())
            }
            "list" => self.list(&mut stream, &head).await,
            "stat" => self.stat(&mut stream, &head).await,
            "peek" => self.peek(&mut stream, &head).await,
            "read" => self.read(&mut stream, &head).await,
            "sum" => self.sum(&mut stream, &head).await,
            "archive" => self.archive(&mut stream, &head).await,
            "write" => self.write(&mut stream, &head).await,
            "put_archive" => self.put_archive(&mut stream, &head).await,
            _ => {
                let h = FReply { status: 400, code: "UNKNOWN_OP".into(), error: "That device does not know that request.".into(), ..Default::default() };
                Self::say(&mut stream, &h, &[]).await;
                let _ = stream.send.shutdown().await;
                Ok(())
            }
        };
        if let Err(why) = result {
            self.refuse(&mut stream, why).await;
        }
    }

    fn entry_json(name: &str, meta: &std::fs::Metadata) -> Value {
        json!({ "name": name, "kind": if meta.is_dir() { "dir" } else { "file" }, "size": if meta.is_dir() { 0 } else { meta.len() }, "mtime": mtime_of(meta) })
    }

    async fn list(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        let sb = self.sandbox();
        let dir = sb.existing(&head.root, &head.path, false)?;
        if !dir.is_dir() {
            return Err(Refuse::NotADir);
        }
        let root = sb.root(&head.root)?.clone();
        let entries = tokio::task::spawn_blocking(move || -> Result<(Vec<Value>, bool), Refuse> {
            let mut rows: Vec<(bool, String, Value)> = Vec::new();
            let mut truncated = false;
            for entry in std::fs::read_dir(&dir)? {
                let Ok(entry) = entry else { continue };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name_denied(&name) {
                    continue;
                }
                // A link is shown only when what it points to is inside the folder too.
                let Ok(canon) = std::fs::canonicalize(entry.path()) else { continue };
                if !canon.starts_with(&root.path) {
                    continue;
                }
                let Ok(meta) = std::fs::metadata(&canon) else { continue };
                if rows.len() >= LIST_MAX {
                    truncated = true;
                    break;
                }
                rows.push((!meta.is_dir(), name.to_lowercase(), Self::entry_json(&name, &meta)));
            }
            rows.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
            Ok((rows.into_iter().map(|r| r.2).collect(), truncated))
        })
        .await
        .map_err(|_| Refuse::Io("task".into()))??;
        Self::json(stream, json!({ "entries": entries.0, "truncated": entries.1 })).await;
        Ok(())
    }

    async fn stat(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        let sb = self.sandbox();
        let path = sb.existing(&head.root, &head.path, false)?;
        let meta = std::fs::metadata(&path)?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Self::json(stream, Self::entry_json(&name, &meta)).await;
        Ok(())
    }

    async fn peek(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        let sb = self.sandbox();
        let path = sb.existing(&head.root, &head.path, false)?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(Refuse::NotAFile);
        }
        let want = if head.len == 0 { PEEK_MAX } else { head.len.min(PEEK_MAX) }.min(meta.len());
        let mut f = tokio::fs::File::open(&path).await?;
        let mut buf = vec![0u8; want as usize];
        f.read_exact(&mut buf).await?;
        let h = FReply { status: 200, body_len: want, size: meta.len(), mtime: mtime_of(&meta), ..Default::default() };
        Self::say(stream, &h, &buf).await;
        let _ = stream.send.shutdown().await;
        Ok(())
    }

    async fn read(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        let sb = self.sandbox();
        let path = sb.existing(&head.root, &head.path, false)?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(Refuse::NotAFile);
        }
        let total = meta.len();
        if head.offset > total {
            return Err(Refuse::BadRange);
        }
        let left = total - head.offset;
        let n = if head.len == 0 { left } else { head.len.min(left) };
        let mut f = tokio::fs::File::open(&path).await?;
        f.seek(std::io::SeekFrom::Start(head.offset)).await?;
        let h = FReply { status: 200, body_len: n, size: total, mtime: mtime_of(&meta), ..Default::default() };
        Self::say(stream, &h, &[]).await;
        self.stream_body(stream, &mut f, n).await;
        if head.offset + n == total {
            self.log(Kind::Copied);
        }
        Ok(())
    }

    /// Streams `n` bytes from `f`. In a test the link may be dropped part of the way (`DROP_AFTER`).
    async fn stream_body(&self, stream: &mut BiStream, f: &mut tokio::fs::File, n: u64) {
        #[cfg(test)]
        {
            let cut = DROP_AFTER.swap(0, std::sync::atomic::Ordering::SeqCst);
            if cut > 0 && cut < n {
                let _ = copy_exact(f, &mut stream.send, cut, &mut |_| Ok(())).await;
                let _ = stream.send.flush().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                self.link.close(0, "gone");
                return;
            }
        }
        if copy_exact(f, &mut stream.send, n, &mut |_| Ok(())).await.is_ok() {
            let _ = stream.send.shutdown().await;
        }
    }

    async fn sum(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        let sb = self.sandbox();
        let path = sb.existing(&head.root, &head.path, false)?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(Refuse::NotAFile);
        }
        let sum = sha256_file(&path).await?;
        let h = FReply { status: 200, sum, size: meta.len(), ..Default::default() };
        Self::say(stream, &h, &[]).await;
        let _ = stream.send.shutdown().await;
        Ok(())
    }

    async fn archive(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        let sb = self.sandbox();
        let out = std::env::temp_dir().join(format!("pm-files-{}.pmar", uuid::Uuid::new_v4().simple()));
        let _guard = TempFile(out.clone());
        let (root, paths, strip, out2) = (head.root.clone(), head.paths.clone(), head.strip, out.clone());
        let size = tokio::task::spawn_blocking(move || build_archive(&sb, &root, &paths, strip, &out2)).await.map_err(|_| Refuse::Io("task".into()))??;
        let mut f = tokio::fs::File::open(&out).await?;
        let h = FReply { status: 200, body_len: size, size, ..Default::default() };
        Self::say(stream, &h, &[]).await;
        if copy_exact(&mut f, &mut stream.send, size, &mut |_| Ok(())).await.is_ok() {
            let _ = stream.send.shutdown().await;
            self.log(Kind::Copied);
        }
        Ok(())
    }

    /// Receives `size` bytes into `part` (resuming what is there), checks them against `sum`. Returns once the part file
    /// is whole and right.
    async fn receive(&self, stream: &mut BiStream, part: &Path, size: u64, sum: &str) -> Result<(), Refuse> {
        let have = match std::fs::metadata(part) {
            Ok(m) if m.is_file() && m.len() <= size => m.len(),
            Ok(_) => {
                let _ = std::fs::remove_file(part);
                0
            }
            Err(_) => 0,
        };
        let go = FReply { status: 200, have, ..Default::default() };
        Self::say(stream, &go, &[]).await;
        if have < size {
            let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(part).await?;
            // A link that drops leaves the part file; the next try starts from its length.
            if copy_exact(&mut stream.recv, &mut f, size - have, &mut |_| Ok(())).await.is_err() {
                let _ = f.flush().await;
                return Err(Refuse::Io("link".into()));
            }
            f.flush().await?;
        }
        if sha256_file(part).await? != sum.to_ascii_lowercase() {
            let _ = std::fs::remove_file(part);
            return Err(Refuse::BadSum);
        }
        Ok(())
    }

    async fn write(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        if !sum_ok(&head.sum) {
            return Err(Refuse::BadPath);
        }
        let sb = self.sandbox();
        let target = sb.new_file(&head.root, &head.path)?;
        match std::fs::symlink_metadata(&target) {
            Ok(m) if !m.is_file() => return Err(Refuse::NotAFile),
            Ok(_) if !head.replace => return Err(Refuse::Exists),
            _ => {}
        }
        let parent = target.parent().ok_or(Refuse::BadPath)?;
        let part = parent.join(format!(".pm-{}.part", &head.sum[..16].to_ascii_lowercase()));
        self.receive(stream, &part, head.size, &head.sum).await?;
        // Checked again: a file may have appeared while this one was arriving.
        if !head.replace && std::fs::symlink_metadata(&target).is_ok() {
            return Err(Refuse::Exists);
        }
        std::fs::rename(&part, &target)?;
        self.log(Kind::Sent);
        let h = FReply { status: 200, sum: head.sum.clone(), size: head.size, ..Default::default() };
        Self::say(stream, &h, &[]).await;
        let _ = stream.send.shutdown().await;
        Ok(())
    }

    async fn put_archive(&self, stream: &mut BiStream, head: &FHead) -> Result<(), Refuse> {
        if !sum_ok(&head.sum) {
            return Err(Refuse::BadPath);
        }
        let sb = self.sandbox();
        let dir = sb.dir_for_write(&head.root, &head.path)?;
        let label = rel_parts(&head.name)?;
        if label.len() != 1 || name_denied(label[0]) || label[0].eq_ignore_ascii_case(".git") {
            return Err(Refuse::BadPath);
        }
        let part = dir.join(format!(".pm-{}.part", &head.sum[..16].to_ascii_lowercase()));
        self.receive(stream, &part, head.size, &head.sum).await?;
        let _cleanup = TempFile(part.clone());
        let new_dir = unique_in(&dir, label[0]);
        std::fs::create_dir(&new_dir)?;
        let (part2, dest2) = (part.clone(), new_dir.clone());
        let unpacked = tokio::task::spawn_blocking(move || unpack(&part2, &dest2, true)).await.map_err(|_| Refuse::Io("task".into()))?;
        if let Err(why) = unpacked {
            // Nothing half-unpacked is left behind.
            let _ = std::fs::remove_dir_all(&new_dir);
            return Err(why);
        }
        self.log(Kind::Sent);
        let name = new_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let h = FReply { status: 200, name, ..Default::default() };
        Self::say(stream, &h, &[]).await;
        let _ = stream.send.shutdown().await;
        Ok(())
    }
}
