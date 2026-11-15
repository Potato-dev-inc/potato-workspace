//! Files between my devices: THIS side. Looking in a far device's folders, copying a file or a folder to this PC, and
//! sending one there. The serving side (`files.rs`) decides what is shared; nothing here can reach past it.
//!
//! - A transfer is a row (`running`, `done`, `failed`, `stopped`) the page shows. The row holds the file's name for the
//!   person at this screen; the activity log never does (kinds only).
//! - Everything streams: one 64 KiB buffer, a file is never loaded whole. A dropped link is resumed from where the part
//!   file stopped, a few times, then the row says so in plain words.
//! - Received files land in Downloads (or the folder the person chose). A name that is taken is never overwritten unless the
//!   person said yes (`Replace`); `Keep both` adds ` (2)`. A folder always goes into a new folder.
//! - SSH runtimes would use the system `sftp` here. TODO(devices phase 3): another builder does SSH; nothing is shared.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::activity::{ActivityLog, Dir, Kind};
use super::client::{AskError, Client};
use super::files::{self, copy_exact, sha256_file, unique_in, FHead, FReply, JSON_MAX};
use super::wire;
use crate::p2p::endpoint::{BiStream, Link, NodeId};

/// How many times one transfer starts again after the link drops.
const TRIES: u32 = 6;
/// The longest the far side may take to answer after a whole file was sent (it checks the file first).
const FINISH_WAIT: Duration = Duration::from_secs(900);
/// The most rows kept.
const KEEP: usize = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilesError {
    Ask(AskError),
    /// The far device said no, in its own plain words.
    Refused { status: u16, code: String, words: String },
    Other(String),
}

impl std::fmt::Display for FilesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FilesError::Ask(e) => write!(f, "{e}"),
            FilesError::Refused { words, .. } => write!(f, "{}", plain(words, 160)),
            FilesError::Other(s) => write!(f, "{s}"),
        }
    }
}

impl From<AskError> for FilesError {
    fn from(e: AskError) -> Self {
        FilesError::Ask(e)
    }
}

impl FilesError {
    pub fn code(&self) -> &str {
        match self {
            FilesError::Refused { code, .. } => code,
            _ => "",
        }
    }

    /// The link dropped or the device is away: asking again may work.
    fn retriable(&self) -> bool {
        matches!(self, FilesError::Ask(AskError::Offline)) || matches!(self, FilesError::Other(s) if s == LINK)
    }
}

const LINK: &str = "The link to that device dropped.";

/// Text from another device: control characters out, bounded.
fn plain(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnExists {
    /// Say so and do nothing (the person is asked).
    Ask,
    /// The person said yes: the file is replaced.
    Replace,
    /// The person said keep both: the new one gets ` (2)`.
    Both,
}

impl OnExists {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "ask" => Some(Self::Ask),
            "replace" => Some(Self::Replace),
            "both" => Some(Self::Both),
            _ => None,
        }
    }
}

struct Row {
    id: u64,
    node: String,
    up: bool,
    name: String,
    bytes: u64,
    total: u64,
    state: &'static str,
    error: String,
    saved_as: String,
    cancel: Arc<AtomicBool>,
}

impl Row {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "node": self.node, "dir": if self.up { "up" } else { "down" }, "name": self.name, "bytes": self.bytes, "total": self.total,
            "state": self.state, "error": self.error, "saved_as": self.saved_as,
        })
    }
}

pub struct Files {
    client: Arc<Client>,
    activity: Arc<ActivityLog>,
    name_of: Arc<dyn Fn(&NodeId) -> String + Send + Sync>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    downloads: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    own_name: String,
    rows: Mutex<Vec<Row>>,
    next: AtomicU64,
    changed: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    last_tick: Mutex<Option<Instant>>,
    retry_wait: Mutex<Duration>,
}

impl Files {
    pub fn new(
        client: Arc<Client>,
        activity: Arc<ActivityLog>,
        name_of: Arc<dyn Fn(&NodeId) -> String + Send + Sync>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
        downloads: Arc<dyn Fn() -> PathBuf + Send + Sync>,
        own_name: &str,
    ) -> Arc<Self> {
        Arc::new(Self {
            client,
            activity,
            name_of,
            now,
            downloads,
            own_name: own_name.to_string(),
            rows: Mutex::new(Vec::new()),
            next: AtomicU64::new(1),
            changed: Mutex::new(None),
            last_tick: Mutex::new(None),
            retry_wait: Mutex::new(Duration::from_millis(700)),
        })
    }

    pub fn set_changed(&self, f: Arc<dyn Fn() + Send + Sync>) {
        *self.changed.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    #[cfg(test)]
    pub fn set_retry_wait(&self, d: Duration) {
        *self.retry_wait.lock().unwrap_or_else(|p| p.into_inner()) = d;
    }

    fn notify(&self, force: bool) {
        if !force {
            let mut last = self.last_tick.lock().unwrap_or_else(|p| p.into_inner());
            if last.is_some_and(|t| t.elapsed() < Duration::from_millis(250)) {
                return;
            }
            *last = Some(Instant::now());
        }
        let f = self.changed.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(f) = f {
            f();
        }
    }

    pub fn rows_json(&self) -> Vec<Value> {
        self.rows.lock().unwrap_or_else(|p| p.into_inner()).iter().rev().map(Row::json).collect()
    }

    /// Takes the finished rows off the list.
    pub fn clear_done(&self) {
        self.rows.lock().unwrap_or_else(|p| p.into_inner()).retain(|r| r.state == "running");
        self.notify(true);
    }

    pub fn cancel(&self, id: u64) {
        if let Some(r) = self.rows.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|r| r.id == id) {
            r.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// A device was removed: its transfers stop and its rows go.
    pub fn forget(&self, node: &str) {
        {
            let mut rows = self.rows.lock().unwrap_or_else(|p| p.into_inner());
            for r in rows.iter().filter(|r| r.node == node) {
                r.cancel.store(true, Ordering::SeqCst);
            }
            rows.retain(|r| r.node != node);
        }
        self.notify(true);
    }

    fn add_row(&self, node: &NodeId, up: bool, name: &str, total: u64) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut rows = self.rows.lock().unwrap_or_else(|p| p.into_inner());
            rows.push(Row {
                id,
                node: node.to_hex(),
                up,
                name: plain(name, 120),
                bytes: 0,
                total,
                state: "running",
                error: String::new(),
                saved_as: String::new(),
                cancel: cancel.clone(),
            });
            while rows.len() > KEEP {
                match rows.iter().position(|r| r.state != "running") {
                    Some(i) => {
                        rows.remove(i);
                    }
                    None => break,
                }
            }
        }
        self.notify(true);
        (id, cancel)
    }

    fn progress(&self, id: u64, bytes: u64, total: Option<u64>) {
        {
            let mut rows = self.rows.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(r) = rows.iter_mut().find(|r| r.id == id) {
                r.bytes = bytes;
                if let Some(t) = total {
                    r.total = t;
                }
            }
        }
        self.notify(false);
    }

    fn finish(&self, id: u64, result: Result<String, FilesError>, cancelled: bool) {
        {
            let mut rows = self.rows.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(r) = rows.iter_mut().find(|r| r.id == id) {
                match result {
                    Ok(saved) => {
                        r.state = "done";
                        r.saved_as = plain(&saved, 120);
                        r.bytes = r.total.max(r.bytes);
                    }
                    Err(_) if cancelled => r.state = "stopped",
                    Err(e) => {
                        r.state = "failed";
                        r.error = e.to_string();
                    }
                }
            }
        }
        self.notify(true);
    }

    fn log_out(&self, node: &NodeId, kind: Kind) {
        self.activity.record((self.now)(), &node.to_hex(), &(self.name_of)(node), Dir::Out, kind);
    }

    async fn wait_before_retry(&self, tries: u32) {
        let base = *self.retry_wait.lock().unwrap_or_else(|p| p.into_inner());
        tokio::time::sleep(base * tries.min(5)).await;
    }

    // ----- one exchange -----

    async fn open(&self, node: &NodeId) -> Result<(Arc<dyn Link>, BiStream), FilesError> {
        let mut last = FilesError::Ask(AskError::Offline);
        for _ in 0..2 {
            let link = self.client.files_link(node).await?;
            match link.open_bi().await {
                Ok(stream) => return Ok((link, stream)),
                Err(_) => {
                    let why = self.client.files_failed(node, &link).await;
                    if matches!(why, AskError::FilesOff | AskError::TooOld) {
                        return Err(why.into());
                    }
                    last = why.into();
                }
            }
        }
        Err(last)
    }

    /// Sends a header; reads the answer's header. The stream is returned for what follows. `finish_send`: the asker has
    /// nothing more to send.
    async fn ask(&self, node: &NodeId, head: &FHead, finish_send: bool) -> Result<(Arc<dyn Link>, BiStream, FReply), FilesError> {
        let (link, mut stream) = self.open(node).await?;
        let go = async {
            wire::write_frame(&mut stream.send, head, &[]).await.map_err(|_| ())?;
            if finish_send {
                let _ = stream.send.shutdown().await;
            }
            wire::read_head::<_, FReply>(&mut stream.recv).await.map_err(|_| ())
        };
        match tokio::time::timeout(self.client.answer_timeout(), go).await {
            Ok(Ok(reply)) => Ok((link, stream, reply)),
            Ok(Err(())) | Err(_) => Err(self.client.files_failed(node, &link).await.into()),
        }
    }

    fn refused(reply: &FReply) -> FilesError {
        FilesError::Refused { status: reply.status, code: reply.code.clone(), words: if reply.error.is_empty() { "The device could not do that.".into() } else { reply.error.clone() } }
    }

    async fn json_op(&self, node: &NodeId, head: &FHead) -> Result<Value, FilesError> {
        let (_link, mut stream, reply) = self.ask(node, head, true).await?;
        if reply.status != 200 {
            return Err(Self::refused(&reply));
        }
        let body = wire::read_body(&mut stream.recv, reply.body_len, JSON_MAX).await.map_err(|_| FilesError::Other(LINK.into()))?;
        Ok(serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    // ----- looking -----

    pub async fn roots(&self, node: &NodeId) -> Result<Value, FilesError> {
        self.json_op(node, &FHead::new("roots")).await
    }

    pub async fn list(&self, node: &NodeId, root: &str, path: &str) -> Result<Value, FilesError> {
        let mut head = FHead::new("list");
        head.root = root.into();
        head.path = path.into();
        let mut v = self.json_op(node, &head).await?;
        // Names from another device are text, bounded.
        if let Some(rows) = v["entries"].as_array_mut() {
            for r in rows.iter_mut() {
                r["name"] = json!(plain(r["name"].as_str().unwrap_or(""), 255));
            }
        }
        Ok(v)
    }

    pub async fn stat(&self, node: &NodeId, root: &str, path: &str) -> Result<Value, FilesError> {
        let mut head = FHead::new("stat");
        head.root = root.into();
        head.path = path.into();
        self.json_op(node, &head).await
    }

    /// A preview: text (first part) or an image (small ones). Anything else says what it is and how big.
    pub async fn preview(&self, node: &NodeId, root: &str, path: &str) -> Result<Value, FilesError> {
        use base64::Engine as _;
        let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let image = match ext.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "bmp" => Some("image/bmp"),
            _ => None,
        };
        let mut head = FHead::new("peek");
        head.root = root.into();
        head.path = path.into();
        head.len = if image.is_some() { files::PEEK_MAX } else { 128 * 1024 };
        let (_link, mut stream, reply) = self.ask(node, &head, true).await?;
        if reply.status != 200 {
            return Err(Self::refused(&reply));
        }
        let body = wire::read_body(&mut stream.recv, reply.body_len, files::PEEK_MAX as usize).await.map_err(|_| FilesError::Other(LINK.into()))?;
        let whole = reply.size == body.len() as u64;
        if let Some(mime) = image {
            if !whole {
                return Ok(json!({ "kind": "none", "size": reply.size, "too_big": true }));
            }
            return Ok(json!({ "kind": "image", "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(&body), "size": reply.size }));
        }
        let text = String::from_utf8_lossy(&body);
        if body.contains(&0) || (text.matches('\u{fffd}').count() > body.len() / 20 + 1) {
            return Ok(json!({ "kind": "none", "size": reply.size }));
        }
        let shown: String = text.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t' | '\r')).collect();
        Ok(json!({ "kind": "text", "text": shown, "truncated": !whole, "size": reply.size }))
    }

    // ----- copy to this PC -----

    /// Starts copying `paths` of a far folder to this PC. One file is one file; a folder or several things come as one
    /// archive and are unpacked into a new folder. Returns `{ ok, id }`, or `{ exists, name }` when the name is taken and
    /// the person must say what to do.
    pub async fn copy_here(self: &Arc<Self>, node: NodeId, root: &str, paths: &[String], dest: Option<PathBuf>, on_exists: OnExists) -> Result<Value, FilesError> {
        if paths.is_empty() {
            return Err(FilesError::Other("Pick something to copy first.".into()));
        }
        let dest = dest.unwrap_or_else(|| (self.downloads)());
        std::fs::create_dir_all(&dest).map_err(|_| FilesError::Other("That folder is not there and could not be made.".into()))?;
        let first = self.stat(&node, root, &paths[0]).await?;
        let single_file = paths.len() == 1 && first["kind"] == "file";
        if single_file {
            let name = safe_name(first["name"].as_str().unwrap_or("file"));
            let size = first["size"].as_u64().unwrap_or(0);
            let final_path = match (dest.join(&name).exists(), on_exists) {
                (false, _) | (true, OnExists::Replace) => dest.join(&name),
                (true, OnExists::Both) => unique_in(&dest, &name),
                (true, OnExists::Ask) => return Ok(json!({ "exists": true, "name": name })),
            };
            let (id, cancel) = self.add_row(&node, false, &name, size);
            let (me, root, path) = (self.clone(), root.to_string(), paths[0].clone());
            let replace = final_path == dest.join(&name);
            tokio::spawn(async move {
                let result = me.download_file(id, &cancel, &node, &root, &path, &final_path, replace).await;
                if result.is_ok() {
                    me.log_out(&node, Kind::Copied);
                }
                me.finish(id, result, cancel.load(Ordering::SeqCst));
            });
            return Ok(json!({ "ok": true, "id": id }));
        }
        let (label, strip) = if paths.len() == 1 {
            (safe_name(first["name"].as_str().unwrap_or("Folder")), true)
        } else {
            (safe_name(&format!("Files from {}", (self.name_of)(&node))), false)
        };
        let (id, cancel) = self.add_row(&node, false, &label, 0);
        let (me, root, paths) = (self.clone(), root.to_string(), paths.to_vec());
        tokio::spawn(async move {
            let result = me.download_archive(id, &cancel, &node, &root, &paths, strip, &dest, &label).await;
            if result.is_ok() {
                me.log_out(&node, Kind::Copied);
            }
            me.finish(id, result, cancel.load(Ordering::SeqCst));
        });
        Ok(json!({ "ok": true, "id": id }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_file(&self, id: u64, cancel: &Arc<AtomicBool>, node: &NodeId, root: &str, path: &str, final_path: &Path, replace: bool) -> Result<String, FilesError> {
        let dir = final_path.parent().ok_or_else(|| FilesError::Other("That folder is not there.".into()))?;
        let name = final_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let part = dir.join(format!("{name}.pm-part"));
        let mut tries = 0u32;
        let mut restarted = false;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(FilesError::Other("Stopped.".into()));
            }
            let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let mut head = FHead::new("read");
            head.root = root.into();
            head.path = path.into();
            head.offset = have;
            let attempt = async {
                let (_link, mut stream, reply) = self.ask(node, &head, true).await?;
                if reply.status == 416 {
                    // The file is shorter than what is here: start over.
                    let _ = std::fs::remove_file(&part);
                    return Ok(false);
                }
                if reply.status != 200 {
                    return Err(Self::refused(&reply));
                }
                self.progress(id, have, Some(reply.size));
                let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&part).await.map_err(|_| FilesError::Other("That folder cannot be written to.".into()))?;
                let mut got = have;
                let cancel2 = cancel.clone();
                let result = copy_exact(&mut stream.recv, &mut file, reply.body_len, &mut |chunk| {
                    if cancel2.load(Ordering::SeqCst) {
                        return Err(std::io::Error::other("stopped"));
                    }
                    got += chunk.len() as u64;
                    self.progress(id, got, None);
                    Ok(())
                })
                .await;
                let _ = file.flush().await;
                match result {
                    Ok(_) => Ok(true),
                    Err(e) if cancel.load(Ordering::SeqCst) => Err(FilesError::Other(e.to_string())),
                    Err(_) => Err(FilesError::Other(LINK.into())),
                }
            };
            match attempt.await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(e) if e.retriable() && tries < TRIES => {
                    tries += 1;
                    self.wait_before_retry(tries).await;
                    continue;
                }
                Err(e) => return Err(e),
            }
            // Whole: is it the same file the far device has?
            let local = sha256_file(&part).await.map_err(|_| FilesError::Other("That file could not be read back.".into()))?;
            let mut sum_head = FHead::new("sum");
            sum_head.root = root.into();
            sum_head.path = path.into();
            let (_l, _s, sum_reply) = self.ask(node, &sum_head, true).await?;
            if sum_reply.status != 200 {
                return Err(Self::refused(&sum_reply));
            }
            if sum_reply.sum != local {
                let _ = std::fs::remove_file(&part);
                if !restarted {
                    restarted = true;
                    continue;
                }
                return Err(FilesError::Other("The file changed while it was being copied. Try again.".into()));
            }
            break;
        }
        // Never over a file that appeared meanwhile, unless the person said replace.
        let target = if replace || !final_path.exists() { final_path.to_path_buf() } else { unique_in(dir, &name) };
        std::fs::rename(&part, &target).map_err(|_| FilesError::Other("The file could not be saved there.".into()))?;
        Ok(target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name))
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_archive(&self, id: u64, cancel: &Arc<AtomicBool>, node: &NodeId, root: &str, paths: &[String], strip: bool, dest: &Path, label: &str) -> Result<String, FilesError> {
        let temp = std::env::temp_dir().join(format!("pm-recv-{}.pmar", uuid::Uuid::new_v4().simple()));
        let _guard = TempGuard(temp.clone());
        let mut tries = 0u32;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(FilesError::Other("Stopped.".into()));
            }
            let mut head = FHead::new("archive");
            head.root = root.into();
            head.paths = paths.to_vec();
            head.strip = strip;
            let attempt = async {
                let (_link, mut stream, reply) = self.ask(node, &head, true).await?;
                if reply.status != 200 {
                    return Err(Self::refused(&reply));
                }
                self.progress(id, 0, Some(reply.size));
                let mut file = tokio::fs::File::create(&temp).await.map_err(|_| FilesError::Other("The files could not be saved.".into()))?;
                let mut got = 0u64;
                let cancel2 = cancel.clone();
                let result = copy_exact(&mut stream.recv, &mut file, reply.body_len, &mut |chunk| {
                    if cancel2.load(Ordering::SeqCst) {
                        return Err(std::io::Error::other("stopped"));
                    }
                    got += chunk.len() as u64;
                    self.progress(id, got, None);
                    Ok(())
                })
                .await;
                let _ = file.flush().await;
                result.map(|_| ()).map_err(|_| FilesError::Other(LINK.into()))
            };
            match attempt.await {
                Ok(()) => break,
                Err(e) if e.retriable() && tries < 2 => {
                    tries += 1;
                    self.wait_before_retry(tries).await;
                }
                Err(e) => return Err(e),
            }
        }
        let new_dir = unique_in(dest, label);
        std::fs::create_dir(&new_dir).map_err(|_| FilesError::Other("That folder could not be made.".into()))?;
        let (temp2, dir2) = (temp.clone(), new_dir.clone());
        let done = tokio::task::spawn_blocking(move || files::unpack(&temp2, &dir2, false)).await.map_err(|_| FilesError::Other("The files could not be unpacked.".into()))?;
        match done {
            Ok(_) => Ok(new_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
            Err(why) => {
                // Only the folder made for this is taken away again.
                let _ = std::fs::remove_dir_all(&new_dir);
                Err(FilesError::Other(why.words().into()))
            }
        }
    }

    // ----- send to the far device -----

    /// Starts sending local files or folders into a far folder. Returns `{ ok, id }`, or `{ exists, name }` for one file
    /// whose name is taken there (the person says `replace`, or picks another name by sending again).
    pub async fn send_to(self: &Arc<Self>, node: NodeId, root: &str, dir: &str, local: &[PathBuf], on_exists: OnExists) -> Result<Value, FilesError> {
        if local.is_empty() {
            return Err(FilesError::Other("Pick something to send first.".into()));
        }
        for p in local {
            if !p.is_absolute() || std::fs::symlink_metadata(p).is_err() {
                return Err(FilesError::Other("One of those is not there any more.".into()));
            }
            if files::name_denied(&p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) {
                return Err(FilesError::Other("That is a sign-in or key file. It is never sent.".into()));
            }
        }
        if local.len() == 1 && local[0].is_file() {
            let path = local[0].clone();
            let name = safe_name(&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            let target = join_rel(dir, &name);
            let replace = match on_exists {
                OnExists::Replace => true,
                _ => {
                    if self.stat(&node, root, &target).await.is_ok() {
                        if on_exists == OnExists::Ask {
                            return Ok(json!({ "exists": true, "name": name }));
                        }
                        // Keep both: a name that is free there.
                        return self.send_free_name(node, root, dir, &path, &name).await;
                    }
                    false
                }
            };
            return self.start_upload(node, root, &target, path, replace).await;
        }
        let label = if local.len() == 1 { safe_name(&local[0].file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) } else { safe_name(&format!("Files from {}", self.own_name)) };
        let (id, cancel) = self.add_row(&node, true, &label, 0);
        let (me, root, dir, local) = (self.clone(), root.to_string(), dir.to_string(), local.to_vec());
        tokio::spawn(async move {
            let result = me.upload_archive(id, &cancel, &node, &root, &dir, &local, &label).await;
            if result.is_ok() {
                me.log_out(&node, Kind::Sent);
            }
            me.finish(id, result, cancel.load(Ordering::SeqCst));
        });
        Ok(json!({ "ok": true, "id": id }))
    }

    /// Keep both: tries `name (2)`, `name (3)`... until the far side has no such file.
    async fn send_free_name(self: &Arc<Self>, node: NodeId, root: &str, dir: &str, path: &Path, name: &str) -> Result<Value, FilesError> {
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 => (&name[..i], &name[i..]),
            _ => (name, ""),
        };
        for n in 2..200 {
            let candidate = format!("{stem} ({n}){ext}");
            if self.stat(&node, root, &join_rel(dir, &candidate)).await.is_err() {
                return self.start_upload(node, root, &join_rel(dir, &candidate), path.to_path_buf(), false).await;
            }
        }
        Err(FilesError::Other("That name is taken there too many times.".into()))
    }

    async fn start_upload(self: &Arc<Self>, node: NodeId, root: &str, target: &str, path: PathBuf, replace: bool) -> Result<Value, FilesError> {
        let size = std::fs::metadata(&path).map(|m| m.len()).map_err(|_| FilesError::Other("That file could not be read.".into()))?;
        let name = target.rsplit('/').next().unwrap_or(target).to_string();
        let (id, cancel) = self.add_row(&node, true, &name, size);
        let (me, root, target) = (self.clone(), root.to_string(), target.to_string());
        tokio::spawn(async move {
            let result = me.upload(id, &cancel, &node, "write", &root, &target, "", &path, replace).await;
            if result.is_ok() {
                me.log_out(&node, Kind::Sent);
            }
            me.finish(id, result, cancel.load(Ordering::SeqCst));
        });
        Ok(json!({ "ok": true, "id": id }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn upload_archive(&self, id: u64, cancel: &Arc<AtomicBool>, node: &NodeId, root: &str, dir: &str, local: &[PathBuf], label: &str) -> Result<String, FilesError> {
        let temp = std::env::temp_dir().join(format!("pm-send-{}.pmar", uuid::Uuid::new_v4().simple()));
        let _guard = TempGuard(temp.clone());
        let (local2, temp2) = (local.to_vec(), temp.clone());
        tokio::task::spawn_blocking(move || pack_local(&local2, &temp2))
            .await
            .map_err(|_| FilesError::Other("The files could not be packed.".into()))?
            .map_err(|e| FilesError::Other(e.words().into()))?;
        self.upload(id, cancel, node, "put_archive", root, dir, label, &temp, false).await
    }

    /// Sends one file (or a packed archive) and waits for the far side's yes. Resumes after a dropped link.
    #[allow(clippy::too_many_arguments)]
    async fn upload(&self, id: u64, cancel: &Arc<AtomicBool>, node: &NodeId, op: &str, root: &str, path: &str, name: &str, file: &Path, replace: bool) -> Result<String, FilesError> {
        let size = std::fs::metadata(file).map(|m| m.len()).map_err(|_| FilesError::Other("That file could not be read.".into()))?;
        let sum = sha256_file(file).await.map_err(|_| FilesError::Other("That file could not be read.".into()))?;
        self.progress(id, 0, Some(size));
        let mut tries = 0u32;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(FilesError::Other("Stopped.".into()));
            }
            let mut head = FHead::new(op);
            head.root = root.into();
            head.path = path.into();
            head.name = name.into();
            head.size = size;
            head.sum = sum.clone();
            head.replace = replace;
            let attempt = async {
                let (_link, mut stream, go) = self.ask(node, &head, false).await?;
                if go.status != 200 {
                    return Err(Self::refused(&go));
                }
                let have = go.have.min(size);
                self.progress(id, have, None);
                if have < size {
                    let mut f = tokio::fs::File::open(file).await.map_err(|_| FilesError::Other("That file could not be read.".into()))?;
                    f.seek(std::io::SeekFrom::Start(have)).await.map_err(|_| FilesError::Other("That file could not be read.".into()))?;
                    let mut sent = have;
                    let cancel2 = cancel.clone();
                    copy_exact(&mut f, &mut stream.send, size - have, &mut |chunk| {
                        if cancel2.load(Ordering::SeqCst) {
                            return Err(std::io::Error::other("stopped"));
                        }
                        sent += chunk.len() as u64;
                        self.progress(id, sent, None);
                        Ok(())
                    })
                    .await
                    .map_err(|_| if cancel.load(Ordering::SeqCst) { FilesError::Other("Stopped.".into()) } else { FilesError::Other(LINK.into()) })?;
                }
                let _ = stream.send.shutdown().await;
                let done = tokio::time::timeout(FINISH_WAIT, wire::read_head::<_, FReply>(&mut stream.recv)).await;
                match done {
                    Ok(Ok(r)) if r.status == 200 => Ok(if r.name.is_empty() { path.rsplit('/').next().unwrap_or(path).to_string() } else { r.name }),
                    Ok(Ok(r)) => Err(Self::refused(&r)),
                    _ => Err(FilesError::Other(LINK.into())),
                }
            };
            match attempt.await {
                Ok(saved) => return Ok(saved),
                Err(e) if e.retriable() && tries < TRIES => {
                    tries += 1;
                    self.wait_before_retry(tries).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

struct TempGuard(PathBuf);

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A name for a file on this PC from a far device's: plain, one part, nothing odd.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control() && !"\\/:*?\"<>|".contains(*c)).collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned == ".." || files::rel_parts(&cleaned).map(|p| p.len() != 1).unwrap_or(true) {
        return "file".into();
    }
    cleaned.chars().take(120).collect()
}

fn join_rel(dir: &str, name: &str) -> String {
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Packs local files and folders into `out`: links are never followed and sign-in and key files are left out.
pub fn pack_local(local: &[PathBuf], out: &Path) -> Result<u64, files::Refuse> {
    let file = std::fs::File::create(out)?;
    let mut w = files::ArchiveWriter::new(std::io::BufWriter::new(file)).map_err(|e| files::Refuse::Io(e.kind().to_string()))?;
    // One folder: its contents go in (the far side makes the folder, named after it).
    let expanded: Vec<PathBuf>;
    let local: &[PathBuf] = if local.len() == 1 && local[0].is_dir() && !std::fs::symlink_metadata(&local[0])?.file_type().is_symlink() {
        let mut kids: Vec<PathBuf> = std::fs::read_dir(&local[0])?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        kids.sort();
        expanded = kids;
        &expanded
    } else {
        local
    };
    for p in local {
        let name = safe_name(&p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let meta = std::fs::symlink_metadata(p)?;
        if meta.file_type().is_symlink() || files::name_denied(&name) {
            continue;
        }
        if meta.is_dir() {
            let canon = std::fs::canonicalize(p)?;
            let root = files::Root { name: name.clone(), path: canon };
            files::walk_local(&mut w, &root, p, &name)?;
        } else if meta.is_file() {
            let mut f = std::fs::File::open(p)?;
            w.file(&name, meta.len(), &mut f).map_err(|e| files::Refuse::Io(e.kind().to_string()))?;
        }
    }
    let mut inner = w.finish().map_err(|e| files::Refuse::Io(e.kind().to_string()))?;
    std::io::Write::flush(&mut inner)?;
    drop(inner);
    Ok(std::fs::metadata(out)?.len())
}
