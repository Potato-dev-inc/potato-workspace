//! The PC link for "Lend through my PC": capability `agents/lend`, protocol name `pm/lend/1` (`crate::p2p`).
//!
//! - The lender lets a node in only while it is the borrower node of one of its live grants (`LendPermissions`);
//!   any other node is closed by the link layer before this code sees it.
//! - The first stream of a link is the handshake: the borrower sends the grant id and
//!   `HMAC(link_secret, "pm/lend/1" | grant id | lender node | borrower node)`. Both node ids are the ones the QUIC
//!   handshake proved, so a stolen grant (secret included) is useless without the borrower's own node key, and a
//!   grant cannot be replayed against another lender.
//! - Every later stream is one model request (`forward::Forwarder::serve_stream`). When the grant ends, the link
//!   is closed with `CLOSE_LEND_ENDED`.
//!
//! The lend endpoint has its own node key (`KeyStore` under `pc-link/<profile>/lend/`), so it never shares an
//! identity with the Spaces endpoint.

use std::sync::{Arc, RwLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::forward::Forwarder;
use super::gate::Gate;
use super::shim::{OpenError, Opener};
use super::wire::NodeHint;
use crate::keys::KeyStore;
use crate::p2p::capability::{self, Capability, CapabilityHandler, MemoryPermissions, Permissions, RelayPolicy, Registry, RoutedPermissions};
use crate::p2p::endpoint::{BiStream, Link, NodeId, P2pError, PeerAddr, TransportFactory};
use crate::p2p::identity::DeviceIdentity;
use crate::p2p::{alpn, P2p};
use crate::secure_core::crypto::{hmac, same_mac};

/// The lender ended the grant (expired, revoked, returned): the borrower answers "This lend ended" from now on.
pub const CLOSE_LEND_ENDED: u32 = 0x4c45;
/// The handshake did not prove the grant.
pub const CLOSE_REFUSED: u32 = 0x4c46;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HELLO: usize = 4096;

/// The handshake MAC (plan 3.4): binds the grant to both node ids.
pub fn handshake_mac(secret: &[u8], grant_id: &str, lender: &NodeId, borrower: &NodeId) -> [u8; 32] {
    let mut msg = Vec::with_capacity(16 + grant_id.len() + 130);
    msg.extend_from_slice(alpn::LEND);
    msg.push(b'\n');
    msg.extend_from_slice(grant_id.as_bytes());
    msg.push(b'\n');
    msg.extend_from_slice(lender.to_hex().as_bytes());
    msg.push(b'\n');
    msg.extend_from_slice(borrower.to_hex().as_bytes());
    hmac(secret, &msg)
}

pub fn node_from_hex(hex: &str) -> Option<NodeId> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(NodeId(out))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Serialize, Deserialize)]
struct Hello {
    v: u32,
    grant_id: String,
    mac: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct HelloReply {
    ok: bool,
    #[serde(default)]
    ended: bool,
}

async fn write_msg<W: AsyncWrite + Unpin + ?Sized, T: Serialize>(w: &mut W, msg: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    w.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await
}

async fn read_msg<R: AsyncRead + Unpin + ?Sized, T: for<'de> Deserialize<'de>>(r: &mut R) -> std::io::Result<T> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_HELLO {
        return Err(std::io::Error::other("handshake too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(std::io::Error::other)
}

/// One live lend as the lender's link sees it.
#[derive(Clone)]
pub struct LenderGrant {
    pub borrower_node: NodeId,
    pub secret: Vec<u8>,
    pub gate: Arc<Gate>,
    pub forwarder: Arc<Forwarder>,
}

/// What the lender's link asks the service. The service keeps every decision; the link only carries bytes.
pub trait LenderBook: Send + Sync {
    /// Whether `peer` is the borrower node of a live grant.
    fn borrower_allowed(&self, peer: &NodeId) -> bool;
    fn lookup(&self, grant_id: &str) -> Option<LenderGrant>;
    /// A link proved this grant: the service closes it when the grant ends.
    fn add_link(&self, grant_id: &str, link: Arc<dyn Link>);
}

type BookSlot = Arc<RwLock<Option<Weak<dyn LenderBook>>>>;

fn book_of(slot: &BookSlot) -> Option<Arc<dyn LenderBook>> {
    slot.read().ok().and_then(|b| b.as_ref().and_then(Weak::upgrade))
}

struct LendPermissions {
    book: BookSlot,
}

impl Permissions for LendPermissions {
    fn allowed(&self, peer: &NodeId, cap: &str) -> bool {
        cap == capability::AGENTS_LEND && book_of(&self.book).is_some_and(|b| b.borrower_allowed(peer))
    }
    /// A peer never sets permissions: only the service's live grants decide.
    fn set(&self, _peer: &NodeId, _cap: &str, _on: bool) {}
}

struct LendHandler {
    book: BookSlot,
    p2p: Arc<RwLock<Option<Weak<P2p>>>>,
}

#[async_trait]
impl CapabilityHandler for LendHandler {
    async fn serve(&self, peer: NodeId, link: Arc<dyn Link>) {
        let Some(book) = book_of(&self.book) else {
            link.close(CLOSE_REFUSED, "refused");
            return;
        };
        let me = self.p2p.read().ok().and_then(|p| p.as_ref().and_then(Weak::upgrade)).and_then(|p| p.node_id());
        let Some(me) = me else {
            link.close(CLOSE_REFUSED, "refused");
            return;
        };
        serve_lender(book, me, peer, link).await;
    }
}

/// The lender's side of one link: handshake, then one forwarded request per stream until the grant ends.
pub async fn serve_lender(book: Arc<dyn LenderBook>, me: NodeId, peer: NodeId, link: Arc<dyn Link>) {
    let hello = tokio::time::timeout(HELLO_TIMEOUT, async {
        let mut s = link.accept_bi().await.map_err(|_| ())?;
        let hello: Hello = read_msg(&mut s.recv).await.map_err(|_| ())?;
        Ok::<_, ()>((s, hello))
    })
    .await;
    let Ok(Ok((mut first, hello))) = hello else {
        link.close(CLOSE_REFUSED, "refused");
        return;
    };
    let grant = book.lookup(&hello.grant_id);
    let proven = grant.as_ref().is_some_and(|g| {
        g.borrower_node == peer && hello.v == 1 && same_mac(to_hex(&handshake_mac(&g.secret, &hello.grant_id, &me, &peer)).as_bytes(), hello.mac.as_bytes())
    });
    let Some(grant) = grant.filter(|_| proven) else {
        let _ = write_msg(&mut first.send, &HelloReply { ok: false, ended: false }).await;
        link.close(CLOSE_REFUSED, "refused");
        return;
    };
    if grant.gate.ended().is_some() {
        let _ = write_msg(&mut first.send, &HelloReply { ok: false, ended: true }).await;
        let _ = first.send.shutdown().await;
        link.close(CLOSE_LEND_ENDED, "lend_ended");
        return;
    }
    if write_msg(&mut first.send, &HelloReply { ok: true, ended: false }).await.is_err() {
        return;
    }
    let _ = first.send.shutdown().await;
    book.add_link(&hello.grant_id, link.clone());
    // The end of the grant closes the link, whatever is open on it.
    let (gate, closer) = (grant.gate.clone(), link.clone());
    tokio::spawn(async move {
        tokio::select! {
            _ = gate.wait_end() => closer.close(CLOSE_LEND_ENDED, "lend_ended"),
            _ = closer.closed() => {}
        }
    });
    while let Ok(stream) = link.accept_bi().await {
        let (gate, fwd) = (grant.gate.clone(), grant.forwarder.clone());
        tokio::spawn(async move {
            let outcome = fwd.serve_stream(&gate, stream).await;
            tracing::debug!(?outcome, "lend: request");
        });
    }
}

/// Why the borrower could not get a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    Ended,
    Refused,
    Unreachable(String),
}

/// The lend endpoint of this app: one `P2p` with only the `agents/lend` capability.
pub struct LendNet {
    p2p: Arc<P2p>,
    keys: KeyStore,
    book: BookSlot,
}

impl LendNet {
    /// Builds it. Starts nothing, reads no key, opens no socket.
    pub fn new(keys: KeyStore, factory: Arc<dyn TransportFactory>) -> Result<Arc<Self>, String> {
        let registry = Arc::new(Registry::new());
        let routed = RoutedPermissions::new(Arc::new(MemoryPermissions::new()));
        let p2p = Arc::new(P2p::new(keys.clone(), factory, registry, routed.clone()));
        let book: BookSlot = Arc::new(RwLock::new(None));
        let p2p_slot = Arc::new(RwLock::new(Some(Arc::downgrade(&p2p))));
        let handler = Arc::new(LendHandler { book: book.clone(), p2p: p2p_slot });
        p2p.registry()
            .register(Capability::new(capability::AGENTS_LEND, alpn::LEND, RelayPolicy::Allowed, handler))
            .map_err(|e| e.to_string())?;
        routed.route(capability::AGENTS_LEND, Arc::new(LendPermissions { book: book.clone() }));
        Ok(Arc::new(Self { p2p, keys, book }))
    }

    /// The app's real one: the iroh network and a node key of its own in the OS credential store.
    pub fn app() -> Result<Arc<Self>, String> {
        Self::new(KeyStore::app_scoped("lend"), Arc::new(crate::p2p::iroh_net::IrohFactory))
    }

    pub fn set_book(&self, book: Weak<dyn LenderBook>) {
        if let Ok(mut b) = self.book.write() {
            *b = Some(book);
        }
    }

    pub fn apply_settings(&self, public: &serde_json::Value) {
        self.p2p.apply_settings(public);
    }

    /// This PC's lend node id, without starting anything (it goes into a request).
    pub fn my_node(&self) -> Result<NodeId, String> {
        DeviceIdentity::load(&self.keys).map(|i| i.id()).map_err(|e| e.to_string())
    }

    /// Starts listening (a lender with a live grant). Returns where it can be reached.
    pub async fn start(&self) -> Result<NodeHint, P2pError> {
        self.p2p.want(capability::AGENTS_LEND).await?;
        let id = self.p2p.node_id().ok_or(P2pError::Closed)?;
        let lan = self.p2p.local_addrs().iter().take(4).map(|a| a.to_string()).collect();
        Ok(NodeHint { id: id.to_hex(), relay: self.p2p.home_relay().unwrap_or_default(), lan })
    }

    /// Nothing needs the endpoint any more.
    pub async fn stop(&self) {
        self.p2p.unwant(capability::AGENTS_LEND).await;
    }

    /// Borrower: dial the lender and prove the grant.
    pub async fn connect(&self, hint: &NodeHint, grant_id: &str, secret: &[u8]) -> Result<Arc<dyn Link>, ConnectError> {
        let lender = node_from_hex(&hint.id).ok_or(ConnectError::Refused)?;
        let mut addr = PeerAddr::new(lender).with_relay(&hint.relay);
        addr.direct = hint.lan.iter().filter_map(|a| a.parse().ok()).collect();
        let link = self.p2p.dial(&addr, capability::AGENTS_LEND).await.map_err(|e| ConnectError::Unreachable(e.to_string()))?;
        let me = self.p2p.node_id().ok_or(ConnectError::Unreachable("no endpoint".into()))?;
        let reply = tokio::time::timeout(HELLO_TIMEOUT, async {
            let mut s = link.open_bi().await.map_err(|e| ConnectError::Unreachable(e.to_string()))?;
            let mac = to_hex(&handshake_mac(secret, grant_id, &lender, &me));
            write_msg(&mut s.send, &Hello { v: 1, grant_id: grant_id.to_string(), mac }).await.map_err(|_| ConnectError::Refused)?;
            read_msg::<_, HelloReply>(&mut s.recv).await.map_err(|_| ConnectError::Refused)
        })
        .await
        .map_err(|_| ConnectError::Unreachable("the lending PC did not answer".into()))??;
        match reply {
            HelloReply { ok: true, .. } => Ok(link),
            HelloReply { ended: true, .. } => Err(ConnectError::Ended),
            _ => Err(ConnectError::Refused),
        }
    }
}

/// What the borrower's opener needs from the service about its grant.
pub trait BorrowerGrant: Send + Sync {
    fn ended(&self) -> bool;
    /// The lender said the lend is over (refused handshake as ended, or closed the link as ended).
    fn lender_ended(&self);
    fn hint(&self) -> NodeHint;
    fn grant_id(&self) -> String;
    fn secret(&self) -> Vec<u8>;
}

/// The shim's opener: one link per grant, dialed on the first request and again after it drops.
pub struct LinkOpener {
    net: Arc<LendNet>,
    grant: Arc<dyn BorrowerGrant>,
    link: tokio::sync::Mutex<Option<Arc<dyn Link>>>,
}

impl LinkOpener {
    pub fn new(net: Arc<LendNet>, grant: Arc<dyn BorrowerGrant>) -> Arc<Self> {
        Arc::new(Self { net, grant, link: tokio::sync::Mutex::new(None) })
    }

    /// Drops the link (the grant ended here).
    pub async fn close(&self) {
        if let Some(link) = self.link.lock().await.take() {
            link.close(CLOSE_LEND_ENDED, "lend_ended");
        }
    }
}

#[async_trait]
impl Opener for LinkOpener {
    async fn open(&self) -> Result<BiStream, OpenError> {
        if self.grant.ended() {
            return Err(OpenError::Ended);
        }
        let mut slot = self.link.lock().await;
        if let Some(link) = slot.as_ref() {
            if let Ok(s) = link.open_bi().await {
                return Ok(s);
            }
            // Closed: was it the lender ending the grant?
            let link = link.clone();
            *slot = None;
            if let Ok(code) = tokio::time::timeout(Duration::from_millis(200), link.closed()).await {
                if code == CLOSE_LEND_ENDED {
                    self.grant.lender_ended();
                    return Err(OpenError::Ended);
                }
            }
        }
        let link = match self.net.connect(&self.grant.hint(), &self.grant.grant_id(), &self.grant.secret()).await {
            Ok(link) => link,
            Err(ConnectError::Ended) => {
                self.grant.lender_ended();
                return Err(OpenError::Ended);
            }
            Err(ConnectError::Refused) => return Err(OpenError::Unavailable("refused".into())),
            Err(ConnectError::Unreachable(why)) => return Err(OpenError::Unavailable(why)),
        };
        let s = link.open_bi().await.map_err(|e| OpenError::Unavailable(e.to_string()))?;
        *slot = Some(link);
        Ok(s)
    }
}
