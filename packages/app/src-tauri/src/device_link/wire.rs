//! What two Workspaces say to each other on the `agents/remote` link (`pm/agents/1`).
//!
//! One stream is one request. The asker writes a small header, then the body; the answerer writes a small header, then
//! the body, and the stream ends. A header is a 4-byte length and a JSON object (never more than `HEAD_MAX`).
//!
//! - `op: "hello"`: "who are you" (answered with the name, the version and where to reach this computer).
//! - `op: "req"`: one bridge request: `method`, `target` (path and query) and `body_len` bytes of JSON.
//! - `op: "screen"`: like `events`, for one terminal pane: the answerer writes the pane's screen text (the answer of
//!   `GET /panes/<id>/snapshot`) the moment it changes, and an empty frame now and then so a vanished asker is noticed.
//! - `op: "web"`: "give me your web address and a token for it" (answered only when the person turned that on).
//! - `op: "events"`: the stream stays open. The answerer writes a header and a body of event text each time there is
//!   some (`cursor` moves on), and `status: 410` when the asker no longer has a right to them.
//!
//! The answer's `status` is an HTTP status. Nothing here knows what a route does, and no login of any kind travels on
//! it: the answerer's own routes decide, with the asker's rights.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The protocol version both sides must speak. A newer one is a new `pm/agents/<n>` name.
pub const VERSION: u32 = 1;
/// The longest header either side accepts.
pub const HEAD_MAX: usize = 16 * 1024;
/// The longest request body (the HTTP bridge's own limit).
pub const BODY_MAX: usize = 8 * 1024 * 1024;
/// The longest answer body this side reads.
pub const REPLY_MAX: usize = 32 * 1024 * 1024;
/// The longest `target` (path and query).
pub const TARGET_MAX: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Head {
    pub v: u32,
    pub op: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub body_len: u64,
    /// For `events`: where to continue (`None`: from now).
    #[serde(default)]
    pub cursor: Option<u64>,
}

impl Head {
    pub fn hello() -> Self {
        Self { v: VERSION, op: "hello".into(), method: String::new(), target: String::new(), body_len: 0, cursor: None }
    }

    pub fn request(method: &str, target: &str, body_len: usize) -> Self {
        Self { v: VERSION, op: "req".into(), method: method.into(), target: target.into(), body_len: body_len as u64, cursor: None }
    }

    pub fn screen(target: &str) -> Self {
        Self { v: VERSION, op: "screen".into(), method: "GET".into(), target: target.into(), body_len: 0, cursor: None }
    }

    pub fn web() -> Self {
        Self { v: VERSION, op: "web".into(), method: String::new(), target: String::new(), body_len: 0, cursor: None }
    }

    pub fn events(cursor: Option<u64>) -> Self {
        Self { v: VERSION, op: "events".into(), method: String::new(), target: String::new(), body_len: 0, cursor }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplyHead {
    pub status: u16,
    #[serde(default)]
    pub body_len: u64,
    #[serde(default)]
    pub cursor: Option<u64>,
}

pub async fn write_frame<W: AsyncWrite + Unpin + ?Sized, H: Serialize>(w: &mut W, head: &H, body: &[u8]) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(head).map_err(std::io::Error::other)?;
    if bytes.len() > HEAD_MAX {
        return Err(std::io::Error::other("header too long"));
    }
    w.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.write_all(body).await?;
    w.flush().await
}

pub async fn read_head<R: AsyncRead + Unpin + ?Sized, H: for<'de> Deserialize<'de>>(r: &mut R) -> std::io::Result<H> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > HEAD_MAX {
        return Err(std::io::Error::other("bad header length"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(std::io::Error::other)
}

pub async fn read_body<R: AsyncRead + Unpin + ?Sized>(r: &mut R, len: u64, max: usize) -> std::io::Result<Vec<u8>> {
    if len > max as u64 {
        return Err(std::io::Error::other("body too long"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

/// A request line a device may send: an absolute path and query, short, no spaces or control characters, no
/// scheme or host (it is never used as a URL, but nothing odd gets as far as the route table either).
pub fn target_ok(target: &str) -> bool {
    target.starts_with('/')
        && !target.starts_with("//")
        && target.len() <= TARGET_MAX
        && target.chars().all(|c| !c.is_control() && c != ' ' && c != '\\')
        && !target.contains("..")
}

/// The one route a screen stream reads: `/panes/<id>/snapshot`.
pub fn screen_target_ok(target: &str) -> bool {
    let segs: Vec<&str> = target.trim_start_matches('/').split('/').collect();
    target_ok(target) && !target.contains('?') && segs.len() == 3 && segs[0] == "panes" && !segs[1].is_empty() && segs[2] == "snapshot"
}

pub fn method_ok(method: &str) -> bool {
    matches!(method, "GET" | "POST" | "PATCH" | "DELETE")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_is_a_plain_absolute_path() {
        assert!(target_ok("/panes"));
        assert!(target_ok("/panes/p1/chat?since=3"));
        assert!(!target_ok("panes"));
        assert!(!target_ok("//evil.example/panes"));
        assert!(!target_ok("/panes/../settings"));
        assert!(!target_ok("/panes/a b"));
        assert!(!target_ok("/panes/\u{0}"));
        assert!(!target_ok(&format!("/{}", "a".repeat(TARGET_MAX))));
    }

    #[test]
    fn a_screen_stream_reads_one_snapshot_route_and_nothing_else() {
        assert!(screen_target_ok("/panes/p1/snapshot"));
        assert!(!screen_target_ok("/panes/p1/input"));
        assert!(!screen_target_ok("/panes/p1/snapshot?x=1"));
        assert!(!screen_target_ok("/panes//snapshot"));
        assert!(!screen_target_ok("/settings"));
    }

    #[test]
    fn only_the_bridge_methods_are_requests() {
        for m in ["GET", "POST", "PATCH", "DELETE"] {
            assert!(method_ok(m));
        }
        for m in ["PUT", "OPTIONS", "CONNECT", "get", ""] {
            assert!(!method_ok(m));
        }
    }

    #[tokio::test]
    async fn a_frame_round_trips_and_an_oversized_header_is_refused() {
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        write_frame(&mut a, &Head::request("POST", "/panes", 3), b"{}\n").await.unwrap();
        let head: Head = read_head(&mut b).await.unwrap();
        assert_eq!(head, Head::request("POST", "/panes", 3));
        assert_eq!(read_body(&mut b, head.body_len, BODY_MAX).await.unwrap(), b"{}\n");
        // A header that claims to be huge is refused before anything is allocated.
        use tokio::io::AsyncWriteExt;
        a.write_all(&((HEAD_MAX as u32 + 1).to_be_bytes())).await.unwrap();
        assert!(read_head::<_, Head>(&mut b).await.is_err());
        assert!(read_body(&mut b, BODY_MAX as u64 + 1, BODY_MAX).await.is_err());
    }
}
