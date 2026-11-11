//! The borrower's local HTTP server. The agent talks plain HTTP to it on 127.0.0.1; each request is carried over
//! one bi-stream to the lender and the reply is streamed back. One request per connection, no keep-alive.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rand::Rng;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::capacity_proxy::frame::{self, RequestHead, ResponseChunk, SigninNote, UsageNote};
use crate::capacity_proxy::meter;
use crate::p2p::endpoint::BiStream;

const MAX_HEAD: usize = 64 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(60);
const BODY_TIMEOUT: Duration = Duration::from_secs(120);
/// After an early refusal, how long and how much we read and discard so the client sees the reply, not a reset.
const DRAIN_TIME: Duration = Duration::from_secs(2);
const DRAIN_BYTES: u64 = 32 * 1024 * 1024;

const NOT_FOUND: &str = r#"{"error":{"type":"not_found","message":"Not found"}}"#;
const BAD_REQUEST: &str = r#"{"error":{"type":"bad_request","message":"Bad request"}}"#;

/// Request headers the shim does not pass on.
const DROP_HEADERS: &[&str] = &["host", "content-length", "transfer-encoding", "connection", "keep-alive", "expect"];

/// Why a stream to the lender could not be opened.
#[derive(Debug)]
pub enum OpenError {
    /// The lend is over.
    Ended,
    /// The lending PC can't be reached right now. The text is the plain reason the agent shows.
    Unavailable(String),
}

/// Opens one bi-stream to the lender per request.
#[async_trait]
pub trait Opener: Send + Sync {
    async fn open(&self) -> Result<BiStream, OpenError>;
}

struct Inner {
    secret: String,
    opener: Arc<dyn Opener>,
    max_body: usize,
    ended: watch::Sender<bool>,
    /// Told when a reply says the lender's sign-in expired (`true`) or a reply succeeds again (`false`).
    signin: Option<SigninNote>,
    /// Counts what this PC used: the protocol shape (for the meter) and who to tell after each good reply.
    usage: Option<(String, UsageNote)>,
}

/// The local server. Dropping it (or `stop()`) closes the listener.
pub struct Shim {
    inner: Arc<Inner>,
    port: u16,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Shim {
    /// Binds 127.0.0.1 on a free port and starts accepting.
    #[cfg(test)]
    pub async fn start(opener: Arc<dyn Opener>, max_body: usize) -> std::io::Result<Arc<Shim>> {
        Self::start_with(opener, max_body, None, None).await
    }

    /// Like `start`, and `signin` hears about the lender's sign-in problems from the reply heads.
    pub async fn start_with(opener: Arc<dyn Opener>, max_body: usize, signin: Option<SigninNote>, usage: Option<(String, UsageNote)>) -> std::io::Result<Arc<Shim>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let mut rng = rand::thread_rng();
        let secret: String = (0..16).map(|_| format!("{:02x}", rng.gen::<u8>())).collect();
        let (ended, _) = watch::channel(false);
        let inner = Arc::new(Inner { secret, opener, max_body, ended, signin, usage });
        let accept_inner = inner.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else { continue };
                tokio::spawn(handle_connection(accept_inner.clone(), socket));
            }
        });
        Ok(Arc::new(Shim { inner, port, task: Mutex::new(Some(task)) }))
    }

    /// `http://127.0.0.1:<port>/<secret>`: what the agent's base URL is set to.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.inner.secret)
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The lend is over: new requests get 403 and any reply still streaming is aborted.
    pub fn end(&self) {
        self.inner.ended.send_replace(true);
    }

    #[cfg(test)]
    pub fn ended(&self) -> bool {
        *self.inner.ended.borrow()
    }

    /// Stops accepting and ends the shim.
    pub fn stop(&self) {
        self.end();
        let task = self.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            task.abort();
        }
    }
}

impl Drop for Shim {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Compares in time that does not depend on where the first difference is.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn wait_ended(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() || rx.changed().await.is_err() {
            return;
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        529 => "Overloaded",
        _ => "Status",
    }
}

/// A small JSON reply that closes the connection.
async fn reply_json<W: AsyncWrite + Unpin>(w: &mut W, status: u16, body: &str) {
    let text = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        reason(status),
        body.len()
    );
    let _ = w.write_all(text.as_bytes()).await;
    let _ = w.flush().await;
}

/// Reads and discards what the client still sends (bounded), then closes, so an early reply is not lost to a reset.
async fn drain<R: AsyncRead + Unpin>(r: &mut R) {
    let _ = tokio::time::timeout(DRAIN_TIME, async {
        let mut sink = tokio::io::sink();
        let _ = tokio::io::copy(&mut r.take(DRAIN_BYTES), &mut sink).await;
    })
    .await;
}

enum ParseError {
    Bad,
    TooLarge,
    Closed,
}

/// Reads one line (without the line end), spending from `budget`.
async fn read_line<R: AsyncBufReadExt + Unpin>(r: &mut R, budget: &mut usize) -> Result<String, ParseError> {
    let mut raw = Vec::new();
    let n = (&mut *r).take(*budget as u64 + 1).read_until(b'\n', &mut raw).await.map_err(|_| ParseError::Closed)?;
    if n == 0 {
        return Err(ParseError::Closed);
    }
    if n > *budget || raw.last() != Some(&b'\n') {
        return Err(ParseError::Bad);
    }
    *budget -= n;
    raw.pop();
    if raw.last() == Some(&b'\r') {
        raw.pop();
    }
    String::from_utf8(raw).map_err(|_| ParseError::Bad)
}

/// The request line and headers.
async fn read_head<R: AsyncBufReadExt + Unpin>(r: &mut R) -> Result<(String, String, Vec<(String, String)>), ParseError> {
    let mut budget = MAX_HEAD;
    let line = read_line(r, &mut budget).await?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(ParseError::Bad);
    };
    if !version.starts_with("HTTP/1.") || method.is_empty() {
        return Err(ParseError::Bad);
    }
    let mut headers = Vec::new();
    loop {
        let line = read_line(r, &mut budget).await?;
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or(ParseError::Bad)?;
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Ok((method.to_string(), target.to_string(), headers))
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// The body, by Content-Length or chunked encoding, never more than `max`.
async fn read_body<R: AsyncBufReadExt + Unpin>(r: &mut R, headers: &[(String, String)], max: usize) -> Result<Vec<u8>, ParseError> {
    let chunked = header(headers, "transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        let mut body = Vec::new();
        loop {
            let mut budget = 4096;
            let line = read_line(r, &mut budget).await?;
            let size = line.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size, 16).map_err(|_| ParseError::Bad)?;
            if size == 0 {
                // Trailers, up to the blank line.
                let mut budget = MAX_HEAD;
                while !read_line(r, &mut budget).await?.is_empty() {}
                return Ok(body);
            }
            if size > max || body.len() + size > max {
                return Err(ParseError::TooLarge);
            }
            let start = body.len();
            body.resize(start + size, 0);
            r.read_exact(&mut body[start..]).await.map_err(|_| ParseError::Closed)?;
            let mut budget = 2;
            if !read_line(r, &mut budget).await?.is_empty() {
                return Err(ParseError::Bad);
            }
        }
    }
    let len = match header(headers, "content-length") {
        Some(v) => v.trim().parse::<usize>().map_err(|_| ParseError::Bad)?,
        None => 0,
    };
    if len > max {
        return Err(ParseError::TooLarge);
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await.map_err(|_| ParseError::Closed)?;
    Ok(body)
}

/// The reply head says the lender's sign-in expired, or it is a success: tell the service (the body passes on as is).
fn note_signin(inner: &Inner, resp: &frame::ResponseHead) {
    let Some(note) = &inner.signin else { return };
    if header(&resp.headers, frame::LEND_HEADER) == Some(frame::SIGNIN_EXPIRED_VALUE) {
        note(true);
    } else if (200..300).contains(&resp.status) {
        note(false);
    }
}

async fn handle_connection(inner: Arc<Inner>, socket: TcpStream) {
    let (read_half, mut w) = socket.into_split();
    let mut r = BufReader::new(read_half);
    serve(&inner, &mut r, &mut w).await;
    let _ = w.shutdown().await;
    drain(&mut r).await;
}

async fn serve(inner: &Inner, r: &mut BufReader<tokio::net::tcp::OwnedReadHalf>, w: &mut tokio::net::tcp::OwnedWriteHalf) {
    let head = match tokio::time::timeout(HEAD_TIMEOUT, read_head(r)).await {
        Ok(Ok(h)) => h,
        Ok(Err(ParseError::Closed)) | Err(_) => return,
        Ok(Err(_)) => return reply_json(w, 400, BAD_REQUEST).await,
    };
    let (method, target, mut headers) = head;

    // The secret path segment must match; everything else is a plain 404.
    let prefix_len = inner.secret.len() + 2;
    let stripped = match target.get(..prefix_len) {
        Some(p) if p.starts_with('/') && p.ends_with('/') && ct_eq(p[1..prefix_len - 1].as_bytes(), inner.secret.as_bytes()) => {
            format!("/{}", &target[prefix_len..])
        }
        _ => return reply_json(w, 404, NOT_FOUND).await,
    };
    if *inner.ended.borrow() {
        return reply_json(w, 403, frame::LEND_ENDED).await;
    }
    if header(&headers, "expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
        let _ = w.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
    }
    let body = match tokio::time::timeout(BODY_TIMEOUT, read_body(r, &headers, inner.max_body)).await {
        Ok(Ok(b)) => b,
        Ok(Err(ParseError::TooLarge)) => return reply_json(w, 413, frame::TOO_LARGE).await,
        Ok(Err(ParseError::Closed)) | Err(_) => return,
        Ok(Err(ParseError::Bad)) => return reply_json(w, 400, BAD_REQUEST).await,
    };
    headers.retain(|(k, _)| !DROP_HEADERS.contains(&k.to_ascii_lowercase().as_str()));

    let mut stream = match inner.opener.open().await {
        Ok(s) => s,
        Err(OpenError::Ended) => {
            inner.ended.send_replace(true);
            return reply_json(w, 403, frame::LEND_ENDED).await;
        }
        Err(OpenError::Unavailable(why)) => {
            tracing::debug!(%why, "lend stream unavailable");
            return reply_json(w, 502, &frame::unavailable_body(&why)).await;
        }
    };

    let sent = async {
        frame::write_request_head(&mut stream.send, &RequestHead { method, path: stripped, headers }).await?;
        frame::write_request_body(&mut stream.send, &body).await?;
        let _ = stream.send.shutdown().await;
        frame::read_response_head(&mut stream.recv).await
    };
    let mut ended_rx = inner.ended.subscribe();
    let resp = tokio::select! {
        r = sent => r,
        _ = wait_ended(&mut ended_rx) => return,
    };
    let resp = match resp {
        Ok(h) => h,
        Err(e) => {
            tracing::debug!(error = %e, "lend reply head failed");
            return reply_json(w, 502, frame::UNAVAILABLE).await;
        }
    };

    note_signin(inner, &resp);
    // The same reading of the reply the lender does (by shape, from the SSE or JSON usage fields), for this PC's own count.
    let counted = (200..300).contains(&resp.status);
    let content_type = header(&resp.headers, "content-type").unwrap_or_default().to_string();
    let mut meter = match &inner.usage {
        Some((shape, _)) if counted => meter::for_shape(shape, &content_type),
        _ => None,
    };
    let report = |meter: Option<Box<dyn meter::Meter>>| {
        if let (true, Some((_, note))) = (counted, &inner.usage) {
            let (input, output) = meter.map(|mut m| m.finish()).unwrap_or((0, 0));
            note(input, output);
        }
    };
    let mut text = format!("HTTP/1.1 {} {}\r\n", resp.status, reason(resp.status));
    for (k, v) in &resp.headers {
        if k.bytes().any(|b| b == b'\r' || b == b'\n' || b == b':') || v.bytes().any(|b| b == b'\r' || b == b'\n') {
            continue;
        }
        text.push_str(&format!("{k}: {v}\r\n"));
    }
    text.push_str("transfer-encoding: chunked\r\nconnection: close\r\n\r\n");
    if w.write_all(text.as_bytes()).await.is_err() {
        return;
    }
    loop {
        let chunk = tokio::select! {
            c = frame::read_chunk(&mut stream.recv) => c,
            _ = wait_ended(&mut ended_rx) => return,
        };
        match chunk {
            Ok(ResponseChunk::Data(data)) => {
                if let Some(m) = meter.as_mut() {
                    m.feed(&data);
                }
                let mut out = Vec::with_capacity(data.len() + 16);
                out.extend_from_slice(format!("{:x}\r\n", data.len()).as_bytes());
                out.extend_from_slice(&data);
                out.extend_from_slice(b"\r\n");
                if w.write_all(&out).await.is_err() || w.flush().await.is_err() {
                    return;
                }
            }
            Ok(ResponseChunk::End) => {
                let _ = w.write_all(b"0\r\n\r\n").await;
                let _ = w.flush().await;
                report(meter);
                return;
            }
            // Cut or a broken stream: close without the final chunk so the client sees an aborted reply.
            Ok(ResponseChunk::Cut) | Err(_) => return,
        }
    }
}
