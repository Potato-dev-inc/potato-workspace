//! Framing over one bi-stream: one HTTP request per stream.
//!
//! Request: head (u32 BE length + JSON), then body (u64 BE length + bytes).
//! Response: head, then chunks (u32 BE length + bytes). Length 0 is a clean end, `0xFFFF_FFFF` is a cut by the
//! lender, and an EOF before the end marker counts as a cut too.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The most a head (request or response) may take.
pub const MAX_HEAD_BYTES: usize = 64 * 1024;
/// The most one response chunk may carry.
pub const MAX_CHUNK_BYTES: usize = 1024 * 1024;
/// The chunk length that means "cut by the lender".
pub const CUT_MARKER: u32 = 0xFFFF_FFFF;

pub const LEND_ENDED: &str = r#"{"error":{"type":"lend_ended","message":"This lend ended"}}"#;
pub const LEND_LIMIT: &str = r#"{"error":{"type":"lend_limit","message":"This lend reached its limit"}}"#;
pub const PATH_NOT_ALLOWED: &str = r#"{"error":{"type":"path_not_allowed","message":"Not allowed through this lend"}}"#;
pub const TOO_LARGE: &str = r#"{"error":{"type":"request_too_large","message":"The request is too large to lend"}}"#;
pub const UPSTREAM_ERROR: &str = r#"{"error":{"type":"upstream_error","message":"The provider could not be reached"}}"#;
pub const SIGNIN_EXPIRED: &str =
    r#"{"error":{"type":"lend_signin_expired","message":"The lender's sign-in expired. Ask them to sign in again."}}"#;
pub const UNAVAILABLE: &str = r#"{"error":{"type":"lend_unavailable","message":"The lending PC can't be reached"}}"#;

/// The 502 body for a link that can't be opened, with the plain reason (the agent shows this line).
pub fn unavailable_body(message: &str) -> String {
    serde_json::json!({ "error": { "type": "lend_unavailable", "message": message } }).to_string()
}

/// A reply header the lender adds on its own refusals, so the borrower's PC can tell why without reading the body.
pub const LEND_HEADER: &str = "x-pm-lend";
/// The `x-pm-lend` value for an expired lend sign-in.
pub const SIGNIN_EXPIRED_VALUE: &str = "signin_expired";

/// Told to a PC's service: `true` when the lend sign-in has a problem, `false` when it works again.
pub type SigninNote = std::sync::Arc<dyn Fn(bool) + Send + Sync>;

/// Told to the borrowing PC's service after each good reply that went through the shim: (input tokens, output tokens).
pub type UsageNote = std::sync::Arc<dyn Fn(u64, u64) + Send + Sync>;

/// The request, as the borrower's shim sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestHead {
    pub method: String,
    /// The path plus an optional `?query`.
    pub path: String,
    pub headers: Vec<(String, String)>,
}

/// The reply head, as the lender sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

/// One piece of a reply body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseChunk {
    Data(Vec<u8>),
    End,
    Cut,
}

/// What can go wrong reading or writing a frame.
#[derive(Debug)]
pub enum FrameError {
    Io(std::io::Error),
    /// A head or body bigger than allowed (nothing past its length was read).
    TooLarge,
    /// Bytes that are not a valid frame.
    Bad(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "stream error: {e}"),
            Self::TooLarge => write!(f, "frame too large"),
            Self::Bad(m) => write!(f, "bad frame: {m}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<std::io::Error> for FrameError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

async fn write_head<W, T>(w: &mut W, head: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin + ?Sized,
    T: Serialize,
{
    let json = serde_json::to_vec(head).map_err(|e| FrameError::Bad(e.to_string()))?;
    if json.len() > MAX_HEAD_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut buf = Vec::with_capacity(4 + json.len());
    buf.extend_from_slice(&(json.len() as u32).to_be_bytes());
    buf.extend_from_slice(&json);
    w.write_all(&buf).await?;
    Ok(())
}

async fn read_head<R, T>(r: &mut R) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin + ?Sized,
    T: for<'de> Deserialize<'de>,
{
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_HEAD_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(|e| FrameError::Bad(e.to_string()))
}

pub async fn write_request_head<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, head: &RequestHead) -> Result<(), FrameError> {
    write_head(w, head).await
}

pub async fn read_request_head<R: AsyncRead + Unpin + ?Sized>(r: &mut R) -> Result<RequestHead, FrameError> {
    read_head(r).await
}

pub async fn write_response_head<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, head: &ResponseHead) -> Result<(), FrameError> {
    write_head(w, head).await
}

pub async fn read_response_head<R: AsyncRead + Unpin + ?Sized>(r: &mut R) -> Result<ResponseHead, FrameError> {
    read_head(r).await
}

/// Writes the request body: u64 BE length, then the bytes.
pub async fn write_request_body<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, body: &[u8]) -> Result<(), FrameError> {
    w.write_all(&(body.len() as u64).to_be_bytes()).await?;
    w.write_all(body).await?;
    Ok(())
}

/// Reads the request body. A declared length over `max` is refused before any of it is read.
pub async fn read_request_body<R: AsyncRead + Unpin + ?Sized>(r: &mut R, max: usize) -> Result<Vec<u8>, FrameError> {
    let mut len = [0u8; 8];
    r.read_exact(&mut len).await?;
    let len = u64::from_be_bytes(len);
    if len > max as u64 {
        return Err(FrameError::TooLarge);
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Writes data as one or more chunks (never over the chunk limit). Empty data writes nothing.
pub async fn write_data<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, data: &[u8]) -> Result<(), FrameError> {
    for part in data.chunks(MAX_CHUNK_BYTES) {
        let mut buf = Vec::with_capacity(4 + part.len());
        buf.extend_from_slice(&(part.len() as u32).to_be_bytes());
        buf.extend_from_slice(part);
        w.write_all(&buf).await?;
    }
    Ok(())
}

/// The clean end marker.
pub async fn write_end<W: AsyncWrite + Unpin + ?Sized>(w: &mut W) -> Result<(), FrameError> {
    w.write_all(&0u32.to_be_bytes()).await?;
    Ok(())
}

/// The "cut by the lender" marker.
pub async fn write_cut<W: AsyncWrite + Unpin + ?Sized>(w: &mut W) -> Result<(), FrameError> {
    w.write_all(&CUT_MARKER.to_be_bytes()).await?;
    Ok(())
}

/// Reads the next chunk. A stream that stops before the end marker is a cut.
pub async fn read_chunk<R: AsyncRead + Unpin + ?Sized>(r: &mut R) -> Result<ResponseChunk, FrameError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(ResponseChunk::Cut),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len);
    if len == 0 {
        return Ok(ResponseChunk::End);
    }
    if len == CUT_MARKER {
        return Ok(ResponseChunk::Cut);
    }
    if len as usize > MAX_CHUNK_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut buf = vec![0u8; len as usize];
    match r.read_exact(&mut buf).await {
        Ok(_) => Ok(ResponseChunk::Data(buf)),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(ResponseChunk::Cut),
        Err(e) => Err(e.into()),
    }
}

/// A whole small JSON reply: head with `content-type: application/json`, one data chunk, then the end marker.
pub async fn write_json_response<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, status: u16, body_json: &str) -> Result<(), FrameError> {
    write_json_response_with(w, status, body_json, &[]).await
}

/// Like `write_json_response`, with extra reply headers.
pub async fn write_json_response_with<W: AsyncWrite + Unpin + ?Sized>(
    w: &mut W,
    status: u16,
    body_json: &str,
    extra: &[(&str, &str)],
) -> Result<(), FrameError> {
    let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
    headers.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let head = ResponseHead { status, headers };
    write_response_head(w, &head).await?;
    write_data(w, body_json.as_bytes()).await?;
    write_end(w).await?;
    w.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    fn head() -> RequestHead {
        RequestHead { method: "POST".into(), path: "/v1/messages?beta=true".into(), headers: vec![("a".into(), "b".into())] }
    }

    #[tokio::test]
    async fn a_request_round_trips() {
        let (mut a, mut b) = duplex(4096);
        write_request_head(&mut a, &head()).await.unwrap();
        write_request_body(&mut a, b"hello").await.unwrap();
        assert_eq!(read_request_head(&mut b).await.unwrap(), head());
        assert_eq!(read_request_body(&mut b, 100).await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn an_oversized_head_is_refused_both_ways() {
        let (mut a, mut b) = duplex(4096);
        let mut big = head();
        big.headers.push(("x".into(), "y".repeat(MAX_HEAD_BYTES)));
        assert!(matches!(write_request_head(&mut a, &big).await, Err(FrameError::TooLarge)));
        a.write_all(&((MAX_HEAD_BYTES as u32) + 1).to_be_bytes()).await.unwrap();
        assert!(matches!(read_request_head(&mut b).await, Err(FrameError::TooLarge)));
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_without_reading_it() {
        let (mut a, mut b) = duplex(64);
        a.write_all(&1_000_000_000u64.to_be_bytes()).await.unwrap();
        assert!(matches!(read_request_body(&mut b, 1000).await, Err(FrameError::TooLarge)));
        // Only the length was consumed: the next byte written is still the next byte read.
        a.write_all(b"z").await.unwrap();
        let mut one = [0u8; 1];
        b.read_exact(&mut one).await.unwrap();
        assert_eq!(&one, b"z");
    }

    #[tokio::test]
    async fn chunks_end_and_cut() {
        let (mut a, mut b) = duplex(8192);
        write_data(&mut a, b"abc").await.unwrap();
        write_end(&mut a).await.unwrap();
        write_data(&mut a, b"x").await.unwrap();
        write_cut(&mut a).await.unwrap();
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Data(b"abc".to_vec()));
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::End);
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Data(b"x".to_vec()));
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Cut);
    }

    #[tokio::test]
    async fn eof_before_the_end_marker_is_a_cut() {
        let (mut a, mut b) = duplex(8192);
        write_data(&mut a, b"abc").await.unwrap();
        // Half a chunk: the length says 10, only 2 bytes follow.
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"hi").await.unwrap();
        drop(a);
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Data(b"abc".to_vec()));
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Cut);
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Cut);
    }

    #[tokio::test]
    async fn big_data_is_split_and_a_too_big_chunk_is_refused() {
        let (mut a, mut b) = duplex(MAX_CHUNK_BYTES * 3);
        write_data(&mut a, &vec![7u8; MAX_CHUNK_BYTES + 5]).await.unwrap();
        match read_chunk(&mut b).await.unwrap() {
            ResponseChunk::Data(d) => assert_eq!(d.len(), MAX_CHUNK_BYTES),
            other => panic!("{other:?}"),
        }
        match read_chunk(&mut b).await.unwrap() {
            ResponseChunk::Data(d) => assert_eq!(d.len(), 5),
            other => panic!("{other:?}"),
        }
        a.write_all(&((MAX_CHUNK_BYTES as u32) + 1).to_be_bytes()).await.unwrap();
        assert!(matches!(read_chunk(&mut b).await, Err(FrameError::TooLarge)));
    }

    #[tokio::test]
    async fn a_json_response_has_head_data_and_end() {
        let (mut a, mut b) = duplex(8192);
        write_json_response(&mut a, 403, LEND_ENDED).await.unwrap();
        let h = read_response_head(&mut b).await.unwrap();
        assert_eq!(h.status, 403);
        assert!(h.headers.iter().any(|(k, v)| k == "content-type" && v == "application/json"));
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::Data(LEND_ENDED.as_bytes().to_vec()));
        assert_eq!(read_chunk(&mut b).await.unwrap(), ResponseChunk::End);
    }
}
