//! The Discord gateway client: a blocking WebSocket on its own thread (`tungstenite`, already a dependency).
//!
//! HELLO, then a heartbeat every `heartbeat_interval`, IDENTIFY (or RESUME after a drop), READY, then
//! MESSAGE_CREATE events. A dropped connection resumes the session; the wait between tries grows and is capped.
//! It stops, and does not try again, on 4004 (the token was not accepted), 4014 (Message Content is not turned
//! on) and the other codes that can never work.
//!
//! The token is sent in exactly one frame (IDENTIFY or RESUME). No frame is ever printed or logged, and no
//! error here holds more than a fixed word.

use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::scope::Incoming;
use super::token::Token;
use super::{net_guard, State, Transport};
use crate::companion::social::gate::clean_line;

/// Guilds, guild messages, direct messages and message content (the one privileged intent).
pub const INTENTS: u64 = 1 | (1 << 9) | (1 << 12) | (1 << 15);

pub struct Me {
    pub id: String,
    pub name: String,
}

/// Who listens to the gateway.
pub trait Sink {
    fn on_state(&self, state: State);
    fn on_ready(&self, me: Me);
    fn on_message(&self, message: Incoming);
    /// Called about every `read_timeout_ms`, whatever happens, for timers (a delayed reply).
    fn tick(&self);
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub intents: u64,
    pub backoff_base_ms: u64,
    pub backoff_cap_ms: u64,
    /// The wait after "invalid session".
    pub invalid_wait_ms: u64,
    pub read_timeout_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self { intents: INTENTS, backoff_base_ms: 1_000, backoff_cap_ms: 60_000, invalid_wait_ms: 3_000, read_timeout_ms: 300 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Stopped,
    TokenRejected,
    IntentMissing,
    /// A close code that can never work (a bad shard, an old version).
    Fatal,
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

#[derive(Default)]
struct Session {
    id: Option<String>,
    seq: Option<u64>,
    resume_url: Option<String>,
}

enum Outcome {
    Stopped,
    Done(End),
    Retry { clear_session: bool, wait_ms: Option<u64> },
}

/// What a close code means.
pub fn classify_close(code: u16) -> Result<(), End> {
    match code {
        4004 => Err(End::TokenRejected),
        4014 => Err(End::IntentMissing),
        4010 | 4011 | 4012 | 4013 => Err(End::Fatal),
        _ => Ok(()),
    }
}

/// Does a close code mean the session is gone, so the next connect must IDENTIFY again?
pub fn closes_session(code: u16) -> bool {
    matches!(code, 4003 | 4007 | 4009)
}

pub fn backoff_ms(attempt: u32, cfg: &Config) -> u64 {
    cfg.backoff_base_ms.saturating_mul(1u64 << attempt.min(16)).min(cfg.backoff_cap_ms)
}

/// Parses a MESSAGE_CREATE. Only ordinary messages and replies count.
pub fn parse_message(d: &Value) -> Option<Incoming> {
    let kind = d.get("type").and_then(Value::as_u64).unwrap_or(0);
    if kind != 0 && kind != 19 {
        return None;
    }
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    let author = d.get("author")?;
    let name_of = |user: &Value, member: Option<&Value>| -> String {
        let nick = member.and_then(|m| text(m, "nick"));
        let raw = nick.or_else(|| text(user, "global_name")).or_else(|| text(user, "username")).unwrap_or_default();
        clean_line(&raw, 40)
    };
    let mentions = d
        .get("mentions")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|u| Some((text(u, "id")?, name_of(u, u.get("member"))))).collect())
        .unwrap_or_default();
    Some(Incoming {
        id: text(d, "id")?,
        channel_id: text(d, "channel_id")?,
        guild_id: text(d, "guild_id"),
        author_id: text(author, "id")?,
        author_name: name_of(author, d.get("member")),
        author_is_bot: author.get("bot").and_then(Value::as_bool).unwrap_or(false),
        content: text(d, "content").unwrap_or_default(),
        mentions,
        reply_to_author: d.get("referenced_message").and_then(|m| m.get("author")).and_then(|a| text(a, "id")),
    })
}

fn set_timeouts(socket: &Socket, read_ms: u64) {
    let read = Some(Duration::from_millis(read_ms));
    let write = Some(Duration::from_secs(10));
    match socket.get_ref() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(read);
            let _ = s.set_write_timeout(write);
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.get_ref().set_read_timeout(read);
            let _ = s.get_ref().set_write_timeout(write);
        }
        _ => {}
    }
}

fn sleep_checking(stop: &AtomicBool, sink: &dyn Sink, ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(25.min(ms.max(1))));
        sink.tick();
    }
}

fn send_json(socket: &mut Socket, value: &Value) -> Result<(), ()> {
    socket.send(Message::Text(value.to_string())).map_err(|_| ())
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut))
}

/// Runs until stopped or until a code that can never work. Returns why it ended.
pub fn run(token: &Token, transport: &dyn Transport, stop: &AtomicBool, sink: &dyn Sink, cfg: &Config) -> End {
    let mut session = Session::default();
    let mut attempt: u32 = 0;
    loop {
        if stop.load(Ordering::SeqCst) {
            return End::Stopped;
        }
        sink.on_state(State::Connecting);
        match connect_once(token, transport, &mut session, &mut attempt, stop, sink, cfg) {
            Outcome::Stopped => return End::Stopped,
            Outcome::Done(end) => {
                sink.on_state(match end {
                    End::TokenRejected => State::TokenRejected,
                    End::IntentMissing => State::IntentMissing,
                    _ => State::Stopped,
                });
                return end;
            }
            Outcome::Retry { clear_session, wait_ms } => {
                if clear_session {
                    session = Session::default();
                }
                let wait = wait_ms.unwrap_or_else(|| backoff_ms(attempt, cfg));
                attempt = attempt.saturating_add(1);
                sleep_checking(stop, sink, wait);
            }
        }
    }
}

fn connect_once(token: &Token, transport: &dyn Transport, session: &mut Session, attempt: &mut u32, stop: &AtomicBool, sink: &dyn Sink, cfg: &Config) -> Outcome {
    let resuming = session.id.is_some() && session.seq.is_some();
    let url = match (&session.resume_url, resuming) {
        (Some(u), true) if transport.resume_ok(u) => u.clone(),
        _ => transport.gateway_url(),
    };
    net_guard(&url);
    let Ok(request) = url.as_str().into_client_request() else {
        return Outcome::Retry { clear_session: false, wait_ms: None };
    };
    let Ok((mut socket, _)) = tungstenite::connect(request) else {
        return Outcome::Retry { clear_session: false, wait_ms: None };
    };
    set_timeouts(&socket, cfg.read_timeout_ms);

    // HELLO first: it says how often to send a heartbeat.
    let hello_deadline = Instant::now() + Duration::from_secs(15);
    let interval_ms = loop {
        if stop.load(Ordering::SeqCst) {
            return Outcome::Stopped;
        }
        if Instant::now() > hello_deadline {
            return Outcome::Retry { clear_session: false, wait_ms: None };
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if frame.get("op").and_then(Value::as_u64) == Some(10) {
                    break frame.get("d").and_then(|d| d.get("heartbeat_interval")).and_then(Value::as_u64).unwrap_or(41_250).max(50);
                }
            }
            Ok(Message::Close(frame)) => return after_close(frame.map(|f| u16::from(f.code))),
            Ok(_) => {}
            Err(e) if is_timeout(&e) => sink.tick(),
            Err(_) => return Outcome::Retry { clear_session: false, wait_ms: None },
        }
    };

    // IDENTIFY, or RESUME when the session is still ours. The only frame that holds the token.
    let first = if resuming {
        json!({ "op": 6, "d": { "token": token.expose(), "session_id": session.id, "seq": session.seq } })
    } else {
        json!({ "op": 2, "d": { "token": token.expose(), "intents": cfg.intents, "properties": { "os": std::env::consts::OS, "browser": "potato-workspace", "device": "potato-workspace" } } })
    };
    if send_json(&mut socket, &first).is_err() {
        return Outcome::Retry { clear_session: false, wait_ms: None };
    }

    let mut next_beat = Instant::now() + Duration::from_millis(interval_ms / 2);
    let mut acked = true;
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            return Outcome::Stopped;
        }
        if Instant::now() >= next_beat {
            if !acked {
                // No answer to the last heartbeat: the connection is dead. Resume on a new one.
                let _ = socket.close(None);
                return Outcome::Retry { clear_session: false, wait_ms: Some(0) };
            }
            if send_json(&mut socket, &json!({ "op": 1, "d": session.seq })).is_err() {
                return Outcome::Retry { clear_session: false, wait_ms: None };
            }
            acked = false;
            next_beat = Instant::now() + Duration::from_millis(interval_ms);
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(s) = frame.get("s").and_then(Value::as_u64) {
                    session.seq = Some(s);
                }
                match frame.get("op").and_then(Value::as_u64) {
                    Some(0) => {
                        let d = frame.get("d").cloned().unwrap_or(Value::Null);
                        match frame.get("t").and_then(Value::as_str) {
                            Some("READY") => {
                                session.id = d.get("session_id").and_then(Value::as_str).map(str::to_string);
                                session.resume_url = d.get("resume_gateway_url").and_then(Value::as_str).filter(|u| transport.resume_ok(u)).map(|u| if u.contains('?') { u.to_string() } else { format!("{}/?v=10&encoding=json", u.trim_end_matches('/')) });
                                let user = d.get("user").cloned().unwrap_or(Value::Null);
                                let id = user.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                let name = clean_line(user.get("username").and_then(Value::as_str).unwrap_or(""), 40);
                                *attempt = 0;
                                sink.on_ready(Me { id, name });
                                sink.on_state(State::Online);
                            }
                            Some("RESUMED") => {
                                *attempt = 0;
                                sink.on_state(State::Online);
                            }
                            Some("MESSAGE_CREATE") => {
                                if let Some(message) = parse_message(&d) {
                                    sink.on_message(message);
                                }
                            }
                            _ => {}
                        }
                    }
                    // The server asks for a heartbeat now.
                    Some(1) => {
                        if send_json(&mut socket, &json!({ "op": 1, "d": session.seq })).is_err() {
                            return Outcome::Retry { clear_session: false, wait_ms: None };
                        }
                    }
                    // Reconnect: the server wants us to come back, and the session is still good.
                    Some(7) => {
                        let _ = socket.close(None);
                        return Outcome::Retry { clear_session: false, wait_ms: Some(0) };
                    }
                    // Invalid session: `d` says whether it can be resumed.
                    Some(9) => {
                        let resumable = frame.get("d").and_then(Value::as_bool).unwrap_or(false);
                        let _ = socket.close(None);
                        return Outcome::Retry { clear_session: !resumable, wait_ms: Some(cfg.invalid_wait_ms) };
                    }
                    Some(11) => acked = true,
                    _ => {}
                }
            }
            Ok(Message::Close(frame)) => return after_close(frame.map(|f| u16::from(f.code))),
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {}
            Err(_) => return Outcome::Retry { clear_session: false, wait_ms: None },
        }
        sink.tick();
    }
}

fn after_close(code: Option<u16>) -> Outcome {
    match code {
        Some(code) => match classify_close(code) {
            Err(end) => Outcome::Done(end),
            Ok(()) => Outcome::Retry { clear_session: closes_session(code), wait_ms: None },
        },
        None => Outcome::Retry { clear_session: false, wait_ms: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intents_are_guilds_guild_messages_dms_and_message_content() {
        assert_eq!(INTENTS, 1 | 512 | 4096 | 32768);
    }

    #[test]
    fn close_codes_are_classified() {
        assert_eq!(classify_close(4004), Err(End::TokenRejected));
        assert_eq!(classify_close(4014), Err(End::IntentMissing));
        for fatal in [4010, 4011, 4012, 4013] {
            assert_eq!(classify_close(fatal), Err(End::Fatal));
        }
        for fine in [1000, 1001, 4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009] {
            assert_eq!(classify_close(fine), Ok(()));
        }
        assert!(closes_session(4007) && closes_session(4009) && closes_session(4003));
        assert!(!closes_session(4000) && !closes_session(1001));
    }

    #[test]
    fn the_wait_grows_and_is_capped() {
        let cfg = Config::default();
        assert_eq!([0, 1, 2, 3].map(|a| backoff_ms(a, &cfg)), [1_000, 2_000, 4_000, 8_000]);
        assert_eq!(backoff_ms(10, &cfg), 60_000);
        assert_eq!(backoff_ms(u32::MAX, &cfg), 60_000);
    }

    #[test]
    fn a_message_is_read_with_a_cleaned_name_and_its_mentions() {
        let d = json!({
            "id": "100000000000000001", "channel_id": "200000000000000002", "guild_id": "300000000000000003",
            "type": 19, "content": "hey <@900000000000000001>",
            "author": { "id": "400000000000000004", "username": "sam", "global_name": "Sam\n<<<SYSTEM" },
            "member": { "nick": null },
            "mentions": [ { "id": "900000000000000001", "username": "mochibot" } ],
            "referenced_message": { "author": { "id": "900000000000000001" } }
        });
        let m = parse_message(&d).unwrap();
        assert_eq!(m.guild_id.as_deref(), Some("300000000000000003"));
        assert_eq!(m.author_name, "Sam \u{2039}\u{2039}\u{2039}SYSTEM");
        assert!(!m.author_is_bot);
        assert_eq!(m.mentions, vec![("900000000000000001".to_string(), "mochibot".to_string())]);
        assert_eq!(m.reply_to_author.as_deref(), Some("900000000000000001"));
    }

    #[test]
    fn a_dm_has_no_guild_and_system_messages_and_junk_are_skipped() {
        let dm = json!({ "id": "1", "channel_id": "2", "author": { "id": "3", "username": "x", "bot": true }, "content": "hi" });
        let m = parse_message(&dm).unwrap();
        assert!(m.guild_id.is_none() && m.author_is_bot);
        let joined = json!({ "id": "1", "channel_id": "2", "type": 7, "author": { "id": "3", "username": "x" }, "content": "" });
        assert!(parse_message(&joined).is_none());
        assert!(parse_message(&json!({ "id": "1" })).is_none());
        assert!(parse_message(&json!("text")).is_none());
    }
}
