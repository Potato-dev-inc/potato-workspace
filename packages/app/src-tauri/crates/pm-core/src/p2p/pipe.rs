//! The PC link over one byte pipe (`potato-host link --stdio` through `ssh -T`), for a box with no outbound network. A [`Link`] whose
//! streams are multiplexed onto one reader and one writer. SSH already proved both ends, so there is no key exchange here: the caller
//! checks who the peer is (the host looks the claimed node up in its trust list) and rights are still read per request.
//!
//! Frames: `kind u8 | stream u32 | len u32 | bytes`. `OPEN` starts a stream (odd ids: the side that dialled; even: the other), `DATA`
//! carries bytes, `FIN` ends the sender's half, `CLOSE` ends the whole link (`stream` holds the close code). Frames are at most
//! [`MAX_FRAME`]; a longer one or an unknown kind closes the link. No datagrams, and the path always counts as relayed (the strict case).
//! shortcut: writes are queued without a window, so a slow reader makes the writer's queue grow; fine for chat and file calls, add a
//! credit window if a bulk stream ever rides it.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex};

use super::endpoint::{BiStream, Link, NodeId, P2pError, PathKind};

pub const MAX_FRAME: usize = 64 * 1024;
const OPEN: u8 = 1;
const DATA: u8 = 2;
const FIN: u8 = 3;
const CLOSE: u8 = 4;

struct Frame {
    kind: u8,
    stream: u32,
    data: Vec<u8>,
}

type Inbox = mpsc::UnboundedSender<Vec<u8>>;

struct Shared {
    out: mpsc::UnboundedSender<Frame>,
    streams: Mutex<HashMap<u32, Inbox>>,
    next: AtomicU32,
    closed: watch::Sender<Option<u32>>,
}

impl Shared {
    fn end(&self, code: u32) {
        self.closed.send_if_modified(|v| {
            if v.is_none() {
                *v = Some(code);
                true
            } else {
                false
            }
        });
        self.streams.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    fn is_closed(&self) -> bool {
        self.closed.borrow().is_some()
    }

    fn new_stream(self: &Arc<Self>, id: u32) -> BiStream {
        let (tx, rx) = mpsc::unbounded_channel();
        self.streams.lock().unwrap_or_else(|p| p.into_inner()).insert(id, tx);
        BiStream { send: Box::new(PipeWriter { id, shared: self.clone(), done: false }), recv: Box::new(PipeReader { rx, left: Vec::new(), at: 0 }) }
    }
}

struct PipeWriter {
    id: u32,
    shared: Arc<Shared>,
    done: bool,
}

impl PipeWriter {
    fn fin(&mut self) {
        if !std::mem::replace(&mut self.done, true) {
            let _ = self.shared.out.send(Frame { kind: FIN, stream: self.id, data: Vec::new() });
        }
    }
}

impl AsyncWrite for PipeWriter {
    fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        if self.done || self.shared.is_closed() {
            return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
        }
        let n = buf.len().min(MAX_FRAME);
        let sent = self.shared.out.send(Frame { kind: DATA, stream: self.id, data: buf[..n].to_vec() });
        Poll::Ready(sent.map(|_| n).map_err(|_| std::io::ErrorKind::BrokenPipe.into()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.fin();
        Poll::Ready(Ok(()))
    }
}

impl Drop for PipeWriter {
    fn drop(&mut self) {
        self.fin();
    }
}

struct PipeReader {
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    left: Vec<u8>,
    at: usize,
}

impl AsyncRead for PipeReader {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.at >= self.left.len() {
            match self.rx.poll_recv(cx) {
                Poll::Ready(Some(chunk)) => {
                    self.left = chunk;
                    self.at = 0;
                }
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
        let n = (self.left.len() - self.at).min(buf.remaining());
        let at = self.at;
        buf.put_slice(&self.left[at..at + n]);
        self.at += n;
        Poll::Ready(Ok(()))
    }
}

pub struct PipeLink {
    peer: NodeId,
    alpn: Vec<u8>,
    shared: Arc<Shared>,
    incoming: AsyncMutex<mpsc::UnboundedReceiver<BiStream>>,
}

impl PipeLink {
    /// Start the link on `reader` / `writer`. `dialler` is the side that opens streams first (ids 1, 3, ...); the other side's are 2, 4, ...
    /// `peer` is who the other end is (already checked by the caller); `alpn` the protocol this pipe carries.
    pub fn start<R, W>(mut reader: R, mut writer: W, peer: NodeId, alpn: &[u8], dialler: bool) -> Arc<PipeLink>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (out, mut out_rx) = mpsc::unbounded_channel::<Frame>();
        let (closed, _) = watch::channel(None);
        let shared = Arc::new(Shared { out, streams: Mutex::default(), next: AtomicU32::new(if dialler { 1 } else { 2 }), closed });
        let (in_tx, in_rx) = mpsc::unbounded_channel::<BiStream>();

        // The writer owns the pipe's write half: frames go out in the order they were queued, and a CLOSE is the last one. When the link
        // ends any other way (the far side dropped the pipe) it stops once the queue is empty, and shuts the write half so the far
        // end sees the end too.
        let w = shared.clone();
        tokio::spawn(async move {
            let mut closing = w.closed.subscribe();
            loop {
                let frame = tokio::select! {
                    biased;
                    f = out_rx.recv() => f,
                    _ = closing.wait_for(|v| v.is_some()) => None,
                };
                let Some(frame) = frame else { break };
                let mut head = [0u8; 9];
                head[0] = frame.kind;
                head[1..5].copy_from_slice(&frame.stream.to_be_bytes());
                head[5..9].copy_from_slice(&(frame.data.len() as u32).to_be_bytes());
                if writer.write_all(&head).await.is_err() || writer.write_all(&frame.data).await.is_err() || writer.flush().await.is_err() {
                    w.end(0);
                    break;
                }
                if frame.kind == CLOSE {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });

        let r = shared.clone();
        tokio::spawn(async move {
            let mut closing = r.closed.subscribe();
            loop {
                let mut head = [0u8; 9];
                let got = tokio::select! {
                    g = reader.read_exact(&mut head) => g.is_ok(),
                    _ = closing.wait_for(|v| v.is_some()) => false,
                };
                if !got {
                    r.end(0);
                    break;
                }
                let kind = head[0];
                let stream = u32::from_be_bytes([head[1], head[2], head[3], head[4]]);
                let len = u32::from_be_bytes([head[5], head[6], head[7], head[8]]) as usize;
                if len > MAX_FRAME {
                    r.end(1);
                    break;
                }
                let mut data = vec![0u8; len];
                if len > 0 && reader.read_exact(&mut data).await.is_err() {
                    r.end(0);
                    break;
                }
                match kind {
                    OPEN => {
                        // A stream id of our own parity would collide with the ones we hand out.
                        if stream % 2 == r.next.load(Ordering::Relaxed) % 2 {
                            r.end(1);
                            break;
                        }
                        let s = r.new_stream(stream);
                        if in_tx.send(s).is_err() {
                            r.end(0);
                            break;
                        }
                    }
                    DATA => {
                        let tx = r.streams.lock().unwrap_or_else(|p| p.into_inner()).get(&stream).cloned();
                        if let Some(tx) = tx {
                            let _ = tx.send(data);
                        }
                    }
                    FIN => {
                        r.streams.lock().unwrap_or_else(|p| p.into_inner()).remove(&stream);
                    }
                    CLOSE => {
                        r.end(stream);
                        break;
                    }
                    _ => {
                        r.end(1);
                        break;
                    }
                }
            }
        });

        Arc::new(PipeLink { peer, alpn: alpn.to_vec(), shared, incoming: AsyncMutex::new(in_rx) })
    }

    async fn wait_closed(&self) -> u32 {
        let mut rx = self.shared.closed.subscribe();
        let code = match rx.wait_for(|v| v.is_some()).await {
            Ok(v) => v.unwrap_or(0),
            Err(_) => 0,
        };
        code
    }
}

#[async_trait]
impl Link for PipeLink {
    fn peer(&self) -> NodeId {
        self.peer
    }
    fn alpn(&self) -> Vec<u8> {
        self.alpn.clone()
    }
    fn path(&self) -> PathKind {
        PathKind::Relayed
    }
    async fn wait_path_change(&self, _from: PathKind) -> Option<PathKind> {
        self.wait_closed().await;
        None
    }
    async fn open_bi(&self) -> Result<BiStream, P2pError> {
        if self.shared.is_closed() {
            return Err(P2pError::Closed);
        }
        let id = self.shared.next.fetch_add(2, Ordering::Relaxed);
        let stream = self.shared.new_stream(id);
        self.shared.out.send(Frame { kind: OPEN, stream: id, data: Vec::new() }).map_err(|_| P2pError::Closed)?;
        Ok(stream)
    }
    async fn accept_bi(&self) -> Result<BiStream, P2pError> {
        let mut closing = self.shared.closed.subscribe();
        let mut incoming = self.incoming.lock().await;
        tokio::select! {
            s = incoming.recv() => s.ok_or(P2pError::Closed),
            _ = closing.wait_for(|v| v.is_some()) => Err(P2pError::Closed),
        }
    }
    async fn send_datagram(&self, _: Vec<u8>) -> Result<(), P2pError> {
        Err(P2pError::Net("no datagrams over a pipe".into()))
    }
    async fn recv_datagram(&self) -> Result<Vec<u8>, P2pError> {
        self.wait_closed().await;
        Err(P2pError::Closed)
    }
    fn close(&self, code: u32, _reason: &str) {
        let _ = self.shared.out.send(Frame { kind: CLOSE, stream: code, data: Vec::new() });
        self.shared.end(code);
    }
    async fn closed(&self) -> u32 {
        self.wait_closed().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::duplex;

    fn pair() -> (Arc<PipeLink>, Arc<PipeLink>) {
        let (a_to_b, b_from_a) = duplex(1 << 20);
        let (b_to_a, a_from_b) = duplex(1 << 20);
        let a = PipeLink::start(a_from_b, a_to_b, NodeId([2; 32]), b"pm/agents/1", true);
        let b = PipeLink::start(b_from_a, b_to_a, NodeId([1; 32]), b"pm/agents/1", false);
        (a, b)
    }

    #[tokio::test]
    async fn streams_carry_bytes_both_ways_and_a_large_body_arrives_whole() {
        let (a, b) = pair();
        let server = tokio::spawn(async move {
            let mut s = b.accept_bi().await.unwrap();
            let mut got = Vec::new();
            s.recv.read_to_end(&mut got).await.unwrap();
            s.send.write_all(format!("{} bytes", got.len()).as_bytes()).await.unwrap();
            s.send.shutdown().await.unwrap();
            b
        });
        let mut s = a.open_bi().await.unwrap();
        s.send.write_all(&vec![7u8; 300_000]).await.unwrap();
        s.send.shutdown().await.unwrap();
        let mut answer = String::new();
        s.recv.read_to_string(&mut answer).await.unwrap();
        assert_eq!(answer, "300000 bytes");
        let _b = server.await.unwrap();
    }

    #[tokio::test]
    async fn two_streams_at_once_stay_apart_and_each_side_can_open() {
        let (a, b) = pair();
        let mut one = a.open_bi().await.unwrap();
        let mut two = a.open_bi().await.unwrap();
        one.send.write_all(b"one").await.unwrap();
        two.send.write_all(b"two").await.unwrap();
        one.send.shutdown().await.unwrap();
        two.send.shutdown().await.unwrap();
        for want in ["one", "two"] {
            let mut s = b.accept_bi().await.unwrap();
            let mut t = String::new();
            s.recv.read_to_string(&mut t).await.unwrap();
            assert_eq!(t, want);
        }
        let mut back = b.open_bi().await.unwrap();
        back.send.write_all(b"hi").await.unwrap();
        back.send.shutdown().await.unwrap();
        let mut s = a.accept_bi().await.unwrap();
        let mut t = String::new();
        s.recv.read_to_string(&mut t).await.unwrap();
        assert_eq!(t, "hi");
    }

    #[tokio::test]
    async fn close_reaches_the_other_side_with_its_code_and_ends_waiting() {
        let (a, b) = pair();
        a.close(7, "bye");
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), b.closed()).await.unwrap(), 7);
        assert!(b.accept_bi().await.is_err());
        assert!(a.open_bi().await.is_err());
    }

    #[tokio::test]
    async fn an_unknown_frame_or_a_huge_one_closes_the_link() {
        for bad in [[99u8, 0, 0, 0, 1, 0, 0, 0, 0], [DATA, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff]] {
            let (mut feed, from) = duplex(1024);
            let (to, _sink) = duplex(1024);
            let link = PipeLink::start(from, to, NodeId([3; 32]), b"x", false);
            feed.write_all(&bad).await.unwrap();
            assert_eq!(tokio::time::timeout(Duration::from_secs(2), link.closed()).await.unwrap(), 1);
        }
    }

    #[tokio::test]
    async fn when_the_far_side_drops_the_pipe_our_write_half_ends_too() {
        let (feed, from) = duplex(1024);
        let (to, mut sink) = duplex(1024);
        let _link = PipeLink::start(from, to, NodeId([3; 32]), b"x", false);
        drop(feed);
        let mut rest = Vec::new();
        let done = tokio::time::timeout(Duration::from_secs(2), sink.read_to_end(&mut rest)).await;
        assert!(done.is_ok(), "the writer task ended and shut its half (it used to wait for ever)");
    }

    #[tokio::test]
    async fn the_pipe_ending_closes_the_link() {
        let (feed, from) = duplex(1024);
        let (to, _sink) = duplex(1024);
        let link = PipeLink::start(from, to, NodeId([3; 32]), b"x", false);
        drop(feed);
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), link.closed()).await.unwrap(), 0);
    }
}
