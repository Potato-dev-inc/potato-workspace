//! A fake Discord on this computer, for tests: a WebSocket gateway and a small HTTP server, both on
//! `127.0.0.1` with free ports. No real token is used and nothing ever leaves the machine.
//!
//! The gateway sends HELLO, expects heartbeats and IDENTIFY (or RESUME), answers READY (or RESUMED), and sends
//! whatever the test scripts: a message, a close code, a dropped connection. The HTTP side records every post and
//! answers from a list of scripted replies (a 429, say), else with 200.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::Message;

pub const ME_ID: &str = "900000000000000001";
pub const ME_NAME: &str = "MochiBot";

pub enum Script {
    /// A dispatch event: `t` and `d`.
    Dispatch(&'static str, Value),
    /// Close the connection with this code.
    Close(u16),
    /// Drop the connection with no close frame.
    Drop,
}

/// One post the fake HTTP side received.
#[derive(Clone, Debug)]
pub struct Post {
    pub path: String,
    pub auth: Option<String>,
    pub body: Value,
    pub at: Instant,
}

pub struct Shared {
    pub identifies: Mutex<Vec<Value>>,
    pub resumes: Mutex<Vec<Value>>,
    pub heartbeats: AtomicUsize,
    pub connections: AtomicUsize,
    pub posts: Mutex<Vec<Post>>,
    /// Replies for `/channels/...`, in order; 200 when the list is empty.
    pub rest_replies: Mutex<VecDeque<(u16, String)>>,
    /// Replies for `/chat/completions`.
    pub chat_replies: Mutex<VecDeque<(u16, String)>>,
    /// When set, IDENTIFY is answered with this close code instead of READY.
    pub identify_close: Mutex<Option<u16>>,
    pub heartbeat_interval_ms: u64,
    stop: AtomicBool,
    seq: AtomicU64,
    rx: Mutex<Receiver<Script>>,
    gateway_port: u16,
}

pub struct FakeDiscord {
    pub shared: Arc<Shared>,
    pub gateway_port: u16,
    pub rest_port: u16,
    tx: Sender<Script>,
}

impl FakeDiscord {
    pub fn start() -> Self {
        let gateway = TcpListener::bind("127.0.0.1:0").expect("bind gateway");
        let rest = TcpListener::bind("127.0.0.1:0").expect("bind rest");
        let gateway_port = gateway.local_addr().unwrap().port();
        let rest_port = rest.local_addr().unwrap().port();
        let (tx, rx) = channel();
        let shared = Arc::new(Shared {
            identifies: Mutex::new(Vec::new()),
            resumes: Mutex::new(Vec::new()),
            heartbeats: AtomicUsize::new(0),
            connections: AtomicUsize::new(0),
            posts: Mutex::new(Vec::new()),
            rest_replies: Mutex::new(VecDeque::new()),
            chat_replies: Mutex::new(VecDeque::new()),
            identify_close: Mutex::new(None),
            heartbeat_interval_ms: 150,
            stop: AtomicBool::new(false),
            seq: AtomicU64::new(0),
            rx: Mutex::new(rx),
            gateway_port,
        });
        gateway.set_nonblocking(true).unwrap();
        rest.set_nonblocking(true).unwrap();
        let s = shared.clone();
        std::thread::spawn(move || accept_loop(gateway, s, serve_gateway));
        let s = shared.clone();
        std::thread::spawn(move || accept_loop(rest, s, serve_http));
        Self { shared, gateway_port, rest_port, tx }
    }

    pub fn transport(&self) -> super::Local {
        super::Local::new(self.gateway_port, self.rest_port)
    }

    pub fn send(&self, script: Script) {
        let _ = self.tx.send(script);
    }

    /// A MESSAGE_CREATE.
    pub fn message(&self, d: Value) {
        self.send(Script::Dispatch("MESSAGE_CREATE", d));
    }
}

impl Drop for FakeDiscord {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
    }
}

/// A MESSAGE_CREATE body in a server channel.
pub fn guild_message(id: &str, guild: &str, channel: &str, author: &str, content: &str, mention_me: bool) -> Value {
    let mentions: Vec<Value> = if mention_me { vec![json!({ "id": ME_ID, "username": ME_NAME })] } else { Vec::new() };
    json!({
        "id": id, "channel_id": channel, "guild_id": guild, "type": 0, "content": content,
        "author": { "id": author, "username": format!("user{author}") },
        "mentions": mentions,
    })
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>, handle: fn(TcpStream, Arc<Shared>)) {
    while !shared.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let s = shared.clone();
                std::thread::spawn(move || handle(stream, s));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn serve_gateway(stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nonblocking(false);
    let Ok(mut ws) = tungstenite::accept(stream) else { return };
    shared.connections.fetch_add(1, Ordering::SeqCst);
    let session = format!("sess-{}", shared.connections.load(Ordering::SeqCst));
    if ws.send(Message::Text(json!({ "op": 10, "d": { "heartbeat_interval": shared.heartbeat_interval_ms } }).to_string())).is_err() {
        return;
    }
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(20)));
    loop {
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        let script = shared.rx.lock().try_recv().ok();
        if let Some(script) = script {
            match script {
                Script::Dispatch(t, d) => {
                    let seq = shared.seq.fetch_add(1, Ordering::SeqCst) + 1;
                    if ws.send(Message::Text(json!({ "op": 0, "t": t, "s": seq, "d": d }).to_string())).is_err() {
                        return;
                    }
                }
                Script::Close(code) => {
                    close_with(&mut ws, code);
                    return;
                }
                Script::Drop => return,
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                match frame.get("op").and_then(Value::as_u64) {
                    Some(1) => {
                        shared.heartbeats.fetch_add(1, Ordering::SeqCst);
                        let _ = ws.send(Message::Text(json!({ "op": 11 }).to_string()));
                    }
                    Some(2) => {
                        shared.identifies.lock().push(frame["d"].clone());
                        if let Some(code) = *shared.identify_close.lock() {
                            close_with(&mut ws, code);
                            return;
                        }
                        let seq = shared.seq.fetch_add(1, Ordering::SeqCst) + 1;
                        let ready = json!({ "op": 0, "t": "READY", "s": seq, "d": {
                            "v": 10, "user": { "id": ME_ID, "username": ME_NAME },
                            "session_id": session, "resume_gateway_url": format!("ws://127.0.0.1:{}", shared.gateway_port),
                        } });
                        let _ = ws.send(Message::Text(ready.to_string()));
                    }
                    Some(6) => {
                        shared.resumes.lock().push(frame["d"].clone());
                        let seq = shared.seq.fetch_add(1, Ordering::SeqCst) + 1;
                        let _ = ws.send(Message::Text(json!({ "op": 0, "t": "RESUMED", "s": seq, "d": {} }).to_string()));
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
    }
}

fn serve_http(mut stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let request = lines.next().unwrap_or("").to_string();
    let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
    let mut auth = None;
    let mut length = 0usize;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization:") {
            auth = Some(line.split_once(':').map(|(_, v)| v.trim().to_string()).unwrap_or_default());
        }
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    shared.posts.lock().push(Post { path: path.clone(), auth, body: parsed, at: Instant::now() });
    let queue = if path.contains("/chat/completions") { &shared.chat_replies } else { &shared.rest_replies };
    let (status, text) = queue.lock().pop_front().unwrap_or((200, r#"{"id":"1"}"#.to_string()));
    let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// Sends a close frame and waits a moment for the client to answer, so the frame is surely read.
fn close_with(ws: &mut tungstenite::WebSocket<TcpStream>, code: u16) {
    let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() }));
    let _ = ws.flush();
    for _ in 0..25 {
        match ws.read() {
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
            Ok(_) => {}
        }
    }
}
